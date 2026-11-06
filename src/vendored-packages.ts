import fs from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "rollup";

import { hashCodeKgrams, winnow } from "./fingerprint";
import { readPackage, type NormalizedPackageJson } from "./package-reader";
import type { ModuleIdString } from "./types/aliases";

/**
 * Files larger than this are skipped, since fingerprinting them takes long and they are rarely code
 */
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Default for `detectVendoredPackages.minMatchedFingerprints`. In a SvelteKit app with about 100 packages,
 * unrelated packages shared at most 13 fingerprints, while vendored copies shared 84 or more.
 */
export const DEFAULT_MIN_MATCHED_FINGERPRINTS = 20;

const JS_FILE_PATTERN = /\.(c|m)?js$/;

const EXACT_VERSION_PATTERN = /^=?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/;

/**
 * A package whose code was found inside the bundled files of another package
 */
export interface VendoredPackage {
    /**
     * The package.json of the installed copy, which provided the fingerprints
     */
    pkg: NormalizedPackageJson;
    path: string;
    /**
     * The version specifier in the host's package.json, such as `^1.2.0`
     */
    declaredVersion: string;
    /**
     * The best estimate of the vendored version: the declared version if it is exact, else the installed one.
     * The two differ when an override replaced the installed copy, which does not change the vendored code.
     */
    version: string;
    /**
     * Number of the package's fingerprints found in the host's bundled files
     */
    matchedFingerprints: number;
    /**
     * Number of fingerprints of all JavaScript files of the package
     */
    totalFingerprints: number;
    /**
     * Packages vendored by this package, found in the same host files
     */
    vendored: VendoredPackage[];
}

/**
 * Finds the installed package `name` the way Node.js resolves it from `fromDir`
 */
async function resolveInstalledPackage(
    fromDir: string,
    name: string,
): Promise<{ path: string; pkg: NormalizedPackageJson } | null> {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
        const packageDir = path.join(dir, "node_modules", name);
        try {
            const pkg = await readPackage(packageDir);
            if (pkg.name && pkg.version) {
                return { path: await fs.realpath(packageDir), pkg };
            }
        } catch {
            // not installed at this level, continue lookup
        }
        if (path.dirname(dir) === dir) {
            return null;
        }
    }
}

async function listJsFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
        entries.map(async (entry) => {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : listJsFiles(entryPath);
            }
            return entry.isFile() && JS_FILE_PATTERN.test(entry.name) ? [entryPath] : [];
        }),
    );
    return files.flat();
}

async function readCode(filePath: string): Promise<string | null> {
    try {
        const stat = await fs.stat(filePath);
        return stat.size > MAX_FILE_SIZE_BYTES ? null : await fs.readFile(filePath, "utf8");
    } catch {
        return null;
    }
}

/**
 * Creates a detector for code that packages copy from their dependencies into their own files.
 * Keeps the fingerprints of each dependency for the whole build.
 * @param context The rollup plugin context, which provides the parser
 * @param minMatchedFingerprints How many fingerprints of a dependency must occur in the host's files
 */
export function createVendoredPackageDetector(context: PluginContext, minMatchedFingerprints: number) {
    const fingerprintsByPackageDir = new Map<string, Promise<Set<number>>>();

    const computePackageFingerprints = async (packageDir: string) => {
        const fingerprints = new Set<number>();
        for (const file of await listJsFiles(packageDir)) {
            const code = await readCode(file);
            if (code !== null) {
                winnow(hashCodeKgrams(context, code)).forEach(fingerprints.add, fingerprints);
            }
        }
        return fingerprints;
    };

    const getPackageFingerprints = (packageDir: string) => {
        let fingerprints = fingerprintsByPackageDir.get(packageDir);
        if (!fingerprints) {
            fingerprints = computePackageFingerprints(packageDir);
            fingerprintsByPackageDir.set(packageDir, fingerprints);
        }
        return fingerprints;
    };

    /**
     * Looks for the dependencies of `pkg` in the host code, then for their dependencies, and so on
     */
    const findVendoredDependencies = async (
        hostKgrams: Set<number>,
        importedPackageDirs: Set<string>,
        pkg: NormalizedPackageJson,
        packageDir: string,
        ancestorDirs: string[],
    ): Promise<VendoredPackage[]> => {
        const vendored: VendoredPackage[] = [];
        const declaredDependencies: Record<string, string> = { ...pkg.dependencies, ...pkg.optionalDependencies };
        for (const [name, declaredVersion] of Object.entries(declaredDependencies)) {
            const dependency = await resolveInstalledPackage(packageDir, name);
            // An imported package is in the bundle as its own modules; matches with it are shared code patterns
            if (!dependency || ancestorDirs.includes(dependency.path) || importedPackageDirs.has(dependency.path)) {
                continue;
            }
            const fingerprints = await getPackageFingerprints(dependency.path);
            let matchedFingerprints = 0;
            for (const fingerprint of fingerprints) {
                if (hostKgrams.has(fingerprint)) {
                    matchedFingerprints++;
                }
            }
            context.debug(
                `Vendored code check: ${matchedFingerprints}/${fingerprints.size} fingerprints of ${name} in ${pkg.name}`,
            );
            if (matchedFingerprints < minMatchedFingerprints) {
                continue;
            }
            vendored.push({
                pkg: dependency.pkg,
                path: dependency.path,
                declaredVersion,
                version: EXACT_VERSION_PATTERN.exec(declaredVersion)?.[1] ?? dependency.pkg.version,
                matchedFingerprints,
                totalFingerprints: fingerprints.size,
                vendored: await findVendoredDependencies(
                    hostKgrams,
                    importedPackageDirs,
                    dependency.pkg,
                    dependency.path,
                    [...ancestorDirs, dependency.path],
                ),
            });
        }
        return vendored;
    };

    return {
        /**
         * Finds the dependencies of a package whose code occurs in the package's bundled files
         * @param pkg The package that contains the bundled files
         * @param packageDir The directory of the package
         * @param moduleIds The bundled modules of the package
         * @param importedPackageDirs The directories of the packages that the bundled modules import
         */
        async detect(
            pkg: NormalizedPackageJson,
            packageDir: string,
            moduleIds: ModuleIdString[],
            importedPackageDirs: Set<string>,
        ): Promise<VendoredPackage[]> {
            const hostKgrams = new Set<number>();
            for (const moduleId of moduleIds) {
                // Module ids can carry a query, e.g. "?commonjs-es-import"
                const code = await readCode(moduleId.split("?")[0]!);
                if (code !== null) {
                    hashCodeKgrams(context, code).forEach(hostKgrams.add, hostKgrams);
                }
            }
            return findVendoredDependencies(hostKgrams, importedPackageDirs, pkg, packageDir, [packageDir]);
        },
    };
}
