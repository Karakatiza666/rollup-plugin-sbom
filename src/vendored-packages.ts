import fs from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "rollup";

import { hashCodeKgrams, winnow } from "./fingerprint";
import { readPackage, type NormalizedPackageJson } from "./package-reader";
import type { ModuleIdString } from "./types/aliases";

/**
 * The detector skips files larger than this size, because fingerprinting them is slow and they rarely contain code
 */
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Default for `detectVendoredPackages.minMatchedFingerprints`. In a measured SvelteKit application with about
 * 100 packages, unrelated packages shared at most 13 fingerprints. Vendored copies shared 84 or more.
 */
export const DEFAULT_MIN_MATCHED_FINGERPRINTS = 20;

const JS_FILE_PATTERN = /\.(c|m)?js$/;

/**
 * Matches an exact version such as `1.2.3`, `=1.2.3` or `v1.2.3-beta.1`, and captures it without the prefix
 */
const EXACT_VERSION_PATTERN = /^=?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/;

/**
 * A dependency whose code the detector found in the bundled files of a host package.
 * The host package is the bundled package that contains the copy.
 */
export interface VendoredPackage {
    /**
     * The package.json of the installed copy, which provided the fingerprints
     */
    pkg: NormalizedPackageJson;
    /**
     * The real path of the installed copy
     */
    path: string;
    /**
     * The version range that the parent package declares for this dependency, such as `^1.2.0`
     */
    declaredVersion: string;
    /**
     * The version to report. This is the declared version if it is exact, and the installed version otherwise.
     * The two versions differ if an override replaced the installed copy. An override does not change vendored code.
     */
    version: string;
    /**
     * Number of fingerprints of the installed copy that occur in the bundled files of the host package
     */
    matchedFingerprints: number;
    /**
     * Number of fingerprints of all JavaScript files of the installed copy
     */
    totalFingerprints: number;
    /**
     * Dependencies of this package whose code also occurs in the bundled files of the host package
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

/**
 * Lists the JavaScript files of a package. Skips `node_modules`, because it contains other packages.
 */
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
 * The detector caches the fingerprints of each installed package.
 * @param context The rollup plugin context, which provides the parser
 * @param minMatchedFingerprints How many fingerprints of a dependency must occur in the bundled files of the host package
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
     * Finds the dependencies of `pkg` whose fingerprints occur in `hostKgrams`.
     * Then does the same for the dependencies of each match, recursively.
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
            // Skip ancestors to stop dependency cycles. Skip imported packages, because their code is in the bundle
            // as their own modules, and a match with them comes from common code patterns.
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
            // Keep all k-gram hashes of the host, not only the winnowed ones, so that each fingerprint of a
            // dependency matches wherever its k-gram occurs
            const hostKgrams = new Set<number>();
            for (const moduleId of moduleIds) {
                // Module ids can end with a query, e.g. "?commonjs-es-import"
                const code = await readCode(moduleId.split("?")[0]!);
                if (code !== null) {
                    hashCodeKgrams(context, code).forEach(hostKgrams.add, hostKgrams);
                }
            }
            return findVendoredDependencies(hostKgrams, importedPackageDirs, pkg, packageDir, [packageDir]);
        },
    };
}
