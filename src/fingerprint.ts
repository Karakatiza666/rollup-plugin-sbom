import type { PluginContext } from "rollup";

/**
 * Number of consecutive AST tokens that one fingerprint covers
 */
const KGRAM_SIZE = 15;

/**
 * Winnowing window size: each run of this many consecutive k-grams keeps at least one fingerprint
 * @see https://theory.stanford.edu/~aiken/publications/papers/sigmod03.pdf
 */
const WINNOW_WINDOW_SIZE = 8;

const POSITION_KEYS = new Set(["type", "start", "end", "range", "loc"]);

/**
 * Nodes that minifiers add, remove or swap for each other. They emit no token, only their children do.
 */
const TRANSPARENT_NODE_TYPES = new Set([
    "BlockStatement",
    "ChainExpression",
    "EmptyStatement",
    "ExpressionStatement",
    "ParenthesizedExpression",
    "SequenceExpression",
]);

type AstNode = { type: string; [key: string]: unknown };

function isAstNode(value: unknown): value is AstNode {
    return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

/**
 * Whether a child node is a name that minifiers keep, such as `b` in `a.b` and in `{ b: 1 }`
 */
function isKeptName(parent: AstNode, key: string): boolean {
    if (parent.computed === true) {
        return false;
    }
    return (
        (key === "property" && parent.type === "MemberExpression") ||
        (key === "key" &&
            (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition"))
    );
}

/**
 * The token for a literal, or for a minified form of a literal (`!0`, `!1`, `void 0`, a template without expressions)
 */
function getLiteralToken(node: AstNode): string | undefined {
    if (node.type === "Literal") {
        const regex = node.regex as { pattern: string; flags: string } | undefined;
        if (regex) {
            return `L/${regex.pattern}/${regex.flags}`;
        }
        return `L${typeof node.value}:${String(node.bigint ?? node.value)}`;
    }
    // Minifiers such as oxc turn "text" into `text`
    if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
        const [quasi] = node.quasis as AstNode[];
        return `Lstring:${(quasi?.value as { cooked?: string } | undefined)?.cooked ?? ""}`;
    }
    if (node.type === "TemplateElement") {
        return `Lstring:${(node.value as { cooked?: string }).cooked ?? ""}`;
    }
    if (node.type !== "UnaryExpression" || !isAstNode(node.argument) || node.argument.type !== "Literal") {
        return undefined;
    }
    if (node.operator === "!" && (node.argument.value === 0 || node.argument.value === 1)) {
        return `Lboolean:${node.argument.value === 0}`;
    }
    if (node.operator === "void" && node.argument.value === 0) {
        return "I";
    }
    return undefined;
}

/**
 * Converts an ESTree AST to a token stream that minification does not change much:
 * local names become a placeholder, while property names, literals and operators stay.
 */
export function tokenizeAst(program: AstNode): string[] {
    const tokens: string[] = [];
    // An explicit stack, since minified code can nest deeper than the call stack allows
    const stack: Array<{ node: AstNode; isKeptName: boolean }> = [{ node: program, isKeptName: false }];

    while (stack.length > 0) {
        const { node, isKeptName: keepName } = stack.pop()!;

        if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
            tokens.push(keepName || node.type === "PrivateIdentifier" ? `.${String(node.name)}` : "I");
            continue;
        }
        const literalToken = getLiteralToken(node);
        if (literalToken !== undefined) {
            tokens.push(literalToken);
            continue;
        }
        if (!TRANSPARENT_NODE_TYPES.has(node.type)) {
            tokens.push(typeof node.operator === "string" ? `${node.type}${node.operator}` : node.type);
        }

        const children: Array<{ node: AstNode; isKeptName: boolean }> = [];
        for (const [key, value] of Object.entries(node)) {
            if (POSITION_KEYS.has(key)) {
                continue;
            }
            for (const child of Array.isArray(value) ? value : [value]) {
                if (isAstNode(child)) {
                    children.push({ node: child, isKeptName: isKeptName(node, key) });
                }
            }
        }
        // Reversed, so that the stack visits the children in source order
        for (let i = children.length - 1; i >= 0; i--) {
            stack.push(children[i]!);
        }
    }

    return tokens;
}

function hashToken(token: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < token.length; i++) {
        hash = Math.imul(hash ^ token.charCodeAt(i), 0x01000193);
    }
    return hash >>> 0;
}

/**
 * Hashes every k-gram of the token stream to a 53-bit integer
 */
export function hashKgrams(tokens: string[]): number[] {
    const tokenHashes = tokens.map(hashToken);
    const kgramHashes: number[] = [];
    for (let start = 0; start + KGRAM_SIZE <= tokenHashes.length; start++) {
        let high = 0x811c9dc5;
        let low = 0x9747b28c;
        for (let i = start; i < start + KGRAM_SIZE; i++) {
            high = Math.imul(high ^ tokenHashes[i]!, 0x01000193);
            low = Math.imul(low ^ tokenHashes[i]!, 0x5bd1e995);
        }
        kgramHashes.push((high >>> 0) * 2 ** 21 + ((low >>> 0) & 0x1fffff));
    }
    return kgramHashes;
}

/**
 * Selects the smallest hash of each window, which keeps every shared run of tokens
 * longer than the window detectable while storing only a fraction of the hashes
 */
export function winnow(kgramHashes: number[]): Set<number> {
    const fingerprints = new Set<number>();
    for (let start = 0; start + WINNOW_WINDOW_SIZE <= kgramHashes.length; start++) {
        let min = kgramHashes[start]!;
        for (let i = start + 1; i < start + WINNOW_WINDOW_SIZE; i++) {
            min = Math.min(min, kgramHashes[i]!);
        }
        fingerprints.add(min);
    }
    return fingerprints;
}

/**
 * Parses JavaScript code with the bundler's parser and hashes its k-grams.
 * Returns an empty list for code that does not parse, such as JSON or Flow sources.
 */
export function hashCodeKgrams(context: PluginContext, code: string): number[] {
    try {
        const program = context.parse(code, { allowReturnOutsideFunction: true }) as unknown as AstNode;
        return hashKgrams(tokenizeAst(program));
    } catch {
        return [];
    }
}
