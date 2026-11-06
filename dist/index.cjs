// \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
let node_path = require("node:path");
node_path = __toESM(node_path, 1);
let spdx_expression_parse = require("spdx-expression-parse");
spdx_expression_parse = __toESM(spdx_expression_parse, 1);
let _cyclonedx_cyclonedx_library = require("@cyclonedx/cyclonedx-library");
_cyclonedx_cyclonedx_library = __toESM(_cyclonedx_cyclonedx_library, 1);
let node_module = require("node:module");
let node_fs_promises = require("node:fs/promises");
node_fs_promises = __toESM(node_fs_promises, 1);
let normalize_package_data = require("normalize-package-data");
normalize_package_data = __toESM(normalize_package_data, 1);
let packageurl_js = require("packageurl-js");
let _cyclonedx_cyclonedx_library_Contrib_FromNodePackageJson = require("@cyclonedx/cyclonedx-library/Contrib/FromNodePackageJson");
// src/helpers.ts
/**
* Plugin identifier for {@link rollupPluginSbom}
*/
const PLUGIN_ID = "rollup-plugin-sbom";
/**
* Returns the folder path from a module id
* @param moduleId The module id
* @returns The path to the imported module
*/
function getModulePathFromModuleId(moduleId) {
	return (0, node_path.dirname)(moduleId);
}
/**
* Generate a package ID from a package object
* @param pkg The package object
* @returns A package ID
*/
function generatePackageId(pkg) {
	return `${pkg.name}@${pkg.version}`;
}
/**
* CycloneDX requires the use of their models and repositories, but we want to provide
* easy usage for the developers so we need to convert our simple interface to the corresponding models
* @param {OrganizationalEntityOption} option The option to convert
* @returns A CycloneDX {@link CDX.Models.OrganizationEntity}
*/
function convertOrganizationalEntityOptionToModel(option) {
	return new _cyclonedx_cyclonedx_library.Models.OrganizationalEntity({
		name: option.name,
		url: new Set(option.url),
		contact: new _cyclonedx_cyclonedx_library.Models.OrganizationalContactRepository(option.contact.map((contact) => new _cyclonedx_cyclonedx_library.Models.OrganizationalContact(contact)))
	});
}
// src/analyzer.ts
/**
* Filter out virtual modules and non-node_modules
* @param value The module ID to filter
* @returns True if the module ID is a valid external module, false otherwise
* @see https://rollupjs.org/plugin-development/#conventions
*/
function filterExternalModuleId(value) {
	if (value.startsWith("\0") || value.startsWith("virtual:")) return false;
	if (value.includes("node_modules")) return true;
	return false;
}
/**
* Type guard to filter out unresolved (null) external modules
* @param value The resolved external module or null
* @returns True if the value is an external module, false otherwise
*/
function isExternalModuleInfo(value) {
	return value !== null;
}
async function resolveExternalModule(context, moduleId, parentModuleId, transitiveResolveLimit, isTransitive = false) {
	if (transitiveResolveLimit === 0) return null;
	const moduleInfo = context.getModuleInfo(moduleId);
	const dependsOnModuleIds = [...moduleInfo?.importedIds ?? [], ...moduleInfo?.dynamicallyImportedIds ?? []].filter(filterExternalModuleId);
	return {
		moduleId,
		parentModuleId,
		moduleInfo,
		modulePath: getModulePathFromModuleId(moduleId),
		isTransitive,
		dependsOn: await Promise.all(dependsOnModuleIds.map((id) => resolveExternalModule(context, id, moduleId, transitiveResolveLimit - 1, true))).then((allModuleIdsOrNull) => allModuleIdsOrNull.filter(isExternalModuleInfo))
	};
}
async function getAllExternalModules(context, bundle, transitiveResolveLimit = 2) {
	const allModules = /* @__PURE__ */ new Set();
	for (const [id, module] of Object.entries(bundle)) {
		if (module.type === "asset") {
			context.debug({
				message: `Skipping asset "${id}"`,
				meta: {
					moduleId: id,
					module
				}
			});
			continue;
		}
		const importedUniqueModuleIds = /* @__PURE__ */ new Set([
			...module.moduleIds,
			...module.imports,
			...module.dynamicImports
		]);
		context.debug({
			message: `Analyzing generated chunk "${id}" (${importedUniqueModuleIds.size} imported ids)`,
			meta: {
				moduleId: id,
				module
			}
		});
		const externalModulesWithinBundle = await Promise.all([...importedUniqueModuleIds].filter(filterExternalModuleId).map((moduleId) => resolveExternalModule(context, moduleId, id, transitiveResolveLimit))).then((allModules) => allModules.filter(isExternalModuleInfo));
		context.debug({
			message: `Found ${externalModulesWithinBundle.length} external entries within "${id}"`,
			meta: {
				moduleId: id,
				modules: externalModulesWithinBundle
			}
		});
		externalModulesWithinBundle.forEach(allModules.add, allModules);
	}
	context.debug({
		message: `Aggregated ${allModules.size} unique external entries across all chunks`,
		meta: { allModules }
	});
	return allModules;
}
// src/package-reader.ts
/**
* Read a normalized package.json as object from a directory or file path
* @param {string} dirOrFilePath The directory or package path to use
* @returns A normalized package.json object
*/
async function readPackage(dirOrFilePath) {
	const packagePath = dirOrFilePath.endsWith(`${node_path.default.sep}package.json`) ? node_path.default.resolve(dirOrFilePath) : node_path.default.resolve(dirOrFilePath, "package.json");
	return parsePackage(await node_fs_promises.default.readFile(packagePath, "utf8"));
}
/**
* Parses a JSON string of package.json format into a normalized package object via {@link normalizePackageData}
* @param {string} packageFile The package.json file content
* @returns A normalized package.json object
*/
function parsePackage(packageFile) {
	if (typeof packageFile !== "string") throw new TypeError(`packageFile should be a string (received ${typeof packageFile}).`);
	const pkg = JSON.parse(packageFile);
	(0, normalize_package_data.default)(pkg, void 0, false);
	return pkg;
}
// src/package-finder.ts
/**
* Searches up the directory tree to find a valid package.json.
* The search is stopped if a '.git' directory is found, marking the project root.
* @param {PluginContext} context The rollup plugin context
* @param {string} startDir The directory to start searching from.
* @returns {Promise<PackageFinderResult | null>} The package path and normalized package.json, or null.
*/
async function findValidPackageJson(context, startDir) {
	let currentDir = startDir;
	while (node_path.default.dirname(currentDir) !== currentDir) {
		const pkgPath = node_path.default.join(currentDir, "package.json");
		try {
			if (!(await node_fs_promises.default.stat(pkgPath)).isFile()) {
				currentDir = node_path.default.dirname(currentDir);
				continue;
			}
			const pkg = await readPackage(pkgPath);
			if (pkg.name && pkg.version) return {
				path: node_path.default.dirname(pkgPath),
				package: pkg
			};
		} catch {}
		try {
			if ((await node_fs_promises.default.stat(node_path.default.join(currentDir, ".git"))).isDirectory()) {
				context.warn(`Package finder did not find any result and reached the git directory while resolving ${startDir}`);
				break;
			}
		} catch {}
		currentDir = node_path.default.dirname(currentDir);
	}
	return null;
}
// src/license-evidence.ts
function* getLicenseEvidence(context, packageDir, licenseEvidenceGatherer) {
	try {
		const files = licenseEvidenceGatherer.getFileAttachments(packageDir, (error) => {
			context.debug(`Collecting license attachments in ${packageDir} failed: ${error instanceof Error ? error.message : String(error)}`);
		}) || [];
		for (const { file, text } of files) yield new _cyclonedx_cyclonedx_library.Models.NamedLicense(`file: ${file}`, { text });
	} catch (error) {
		context.warn(`Collecting license evidence in ${packageDir} failed: ${error instanceof Error ? error.message : error}`);
	}
}
// src/dependency-info-registry.ts
/**
* Creates a new dependency info registry
*/
function createDependencyInfoRegistry() {
	return /* @__PURE__ */ new Map();
}
/**
* Find the corresponding package.json based on a module path
* @param {PluginContext} context The rollup plugin context
* @param {DependencyInfoRegistry} registry The package registry where the package should be stored
* @param {ModulePathString} modulePath The module path
* @param {CDX.Utils.LicenseUtility.LicenseEvidenceGatherer} licenseEvidenceGatherer License evidence gatherer; will collect license evidence if set
* @returns A normalized dependency info object or null (if not found / virtual module)
*/
async function aggregateDependencyInfoByModulePath(context, registry, modulePath, licenseEvidenceGatherer) {
	if (registry.has(modulePath)) return registry.get(modulePath) ?? null;
	if (!filterExternalModuleId(modulePath)) return null;
	const dependencyPackage = await findValidPackageJson(context, modulePath);
	if (!dependencyPackage) return null;
	const licenseEvidenceList = licenseEvidenceGatherer ? Array.from(getLicenseEvidence(context, dependencyPackage.path, licenseEvidenceGatherer)) : [];
	const info = {
		path: dependencyPackage.path,
		pkg: dependencyPackage.package,
		licenseEvidence: licenseEvidenceList
	};
	registry.set(modulePath, info);
	return info;
}
/**
* Find the closest package.json based on a module identifier, uses {@link aggregateDependencyInfoByModulePath} internally.
* @param {PluginContext} context The rollup plugin context
* @param {DependencyInfoRegistry} registry The package registry where the package should be stored
* @param {ModuleIdString} moduleId The module id base
* @param {CDX.Contrib.License.Utils.LicenseEvidenceGatherer} licenseEvidenceGatherer License evidence gatherer; will collect license evidence if set
* @returns A normalized dependency info object or null (if not found / virtual module)
*/
async function aggregateDependencyInfoByModuleId(context, registry, moduleId, licenseEvidenceGatherer) {
	return aggregateDependencyInfoByModulePath(context, registry, getModulePathFromModuleId(moduleId), licenseEvidenceGatherer);
}
// src/tools.ts
/**
* A list of package names which will be looked up within the project
* and push them to the tools list within the SBOM, along with the component
* type they are registered as (bundlers are applications, the plugin is a library).
*/
const knownTools = [
	["rollup-plugin-sbom", _cyclonedx_cyclonedx_library.Enums.ComponentType.Library],
	["vite", _cyclonedx_cyclonedx_library.Enums.ComponentType.Application],
	["rollup", _cyclonedx_cyclonedx_library.Enums.ComponentType.Application],
	["rolldown", _cyclonedx_cyclonedx_library.Enums.ComponentType.Application]
];
/**
* Automatically register common tools related to the build process on a BOM model.
*
* Tools are registered as components, the serializer emits them as `metadata.tools.components`
* for CycloneDX 1.5+ and falls back to the legacy tools list for older spec versions.
*
* @since 1.0.0
* @param {PluginContext} context The rollup plugin context
* @param {CDX.Models.Bom} bom The root BOM to attach tools to
* @param {CDX.Contrib.FromNodePackageJson.Builders.ComponentBuilder} builder The CDX component builder instance
* @param {CDX.Contrib.License.Utils.LicenseEvidenceGatherer} [licenseEvidenceGatherer] Optional: enable license evidence gathering
*/
async function autoRegisterTools(context, bom, builder, licenseEvidenceGatherer) {
	const toolPackageRegistry = createDependencyInfoRegistry();
	const projectRequire = (0, node_module.createRequire)((0, node_path.join)(process.cwd(), "package.json"));
	async function registerTool(packageName, componentType) {
		try {
			const toolModulePath = projectRequire.resolve(packageName);
			const dependencyInfo = await aggregateDependencyInfoByModulePath(context, toolPackageRegistry, toolModulePath, licenseEvidenceGatherer);
			if (dependencyInfo && dependencyInfo.pkg) {
				const tool = builder.makeComponent(dependencyInfo.pkg, componentType);
				if (tool) {
					context.info({
						message: `Registering tool "${tool?.name}" in SBOM`,
						meta: { dependencyInfo }
					});
					bom.metadata.tools.components.add(tool);
				}
			}
		} catch (error) {
			context.warn(`Error during auto-registration of tool "${packageName}": ${error}`);
		}
	}
	for (const [pkgName, componentType] of knownTools) {
		context.debug(`Trying to autoregister tool "${pkgName}"`);
		await registerTool(pkgName, componentType);
	}
}
// src/options.ts
const DEFAULT_OPTIONS = {
	specVersion: _cyclonedx_cyclonedx_library.Spec.Version.v1dot7,
	rootComponentType: _cyclonedx_cyclonedx_library.Enums.ComponentType.Application,
	outDir: "cyclonedx",
	outFilename: "bom",
	outFormats: ["json"],
	saveTimestamp: true,
	autodetect: true,
	generateSerial: false,
	sortLists: true,
	includeWellKnown: true,
	supplier: void 0,
	properties: void 0,
	collectLicenseEvidence: false,
	detectVendoredPackages: false,
	beforeCollect: void 0,
	afterCollect: void 0
};
// src/purl.ts
/**
* Compose PURLs from a normalized package.json declaration.
* @param {NormalizedPackageJson} packageJson The normalized package data
* @see https://github.com/CycloneDX/cyclonedx-webpack-plugin/blob/master/src/factories.ts
* @see https://github.com/CycloneDX/cyclonedx-javascript-library/releases/tag/v10.0.0
*/
function composePackageUrlFromPackageJson(packageJson) {
	let name = packageJson.name;
	let namespace = void 0;
	if (name.startsWith("@")) {
		const nameParts = name.split("/");
		namespace = nameParts.shift();
		name = nameParts.join("/");
	}
	const qualifiers = {};
	const { tarball } = packageJson.dist ?? {};
	if (typeof tarball === "string" && tarball.length > 5) {
		if (!_cyclonedx_cyclonedx_library_Contrib_FromNodePackageJson.Utils.defaultRegistryMatcher.test(tarball)) qualifiers[packageurl_js.PurlQualifierNames.DownloadUrl] = tarball;
	} else if (typeof packageJson.repository === "object") try {
		const url = new URL(packageJson.repository.url);
		const subdir = packageJson.repository.directory;
		if (typeof subdir === "string") url.hash = subdir;
		qualifiers[packageurl_js.PurlQualifierNames.VcsUrl] = url.toString();
	} catch {}
	try {
		return new packageurl_js.PackageURL("npm", namespace, name, packageJson.version, qualifiers, void 0);
	} catch {
		return;
	}
}
// src/fingerprint.ts
/**
* Number of consecutive AST tokens that one fingerprint covers
*/
const KGRAM_SIZE = 15;
/**
* Winnowing window size: each run of this many consecutive k-grams keeps at least one fingerprint
* @see https://theory.stanford.edu/~aiken/publications/papers/sigmod03.pdf
*/
const WINNOW_WINDOW_SIZE = 8;
const POSITION_KEYS = /* @__PURE__ */ new Set([
	"type",
	"start",
	"end",
	"range",
	"loc"
]);
/**
* Nodes that minifiers add, remove or swap for each other. They emit no token, only their children do.
*/
const TRANSPARENT_NODE_TYPES = /* @__PURE__ */ new Set([
	"BlockStatement",
	"ChainExpression",
	"EmptyStatement",
	"ExpressionStatement",
	"ParenthesizedExpression",
	"SequenceExpression"
]);
function isAstNode(value) {
	return typeof value === "object" && value !== null && typeof value.type === "string";
}
/**
* Whether a child node is a name that minifiers keep, such as `b` in `a.b` and in `{ b: 1 }`
*/
function isKeptName(parent, key) {
	if (parent.computed === true) return false;
	return key === "property" && parent.type === "MemberExpression" || key === "key" && (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition");
}
/**
* The token for a literal, or for a minified form of a literal (`!0`, `!1`, `void 0`, a template without expressions)
*/
function getLiteralToken(node) {
	if (node.type === "Literal") {
		const regex = node.regex;
		if (regex) return `L/${regex.pattern}/${regex.flags}`;
		return `L${typeof node.value}:${String(node.bigint ?? node.value)}`;
	}
	if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
		const [quasi] = node.quasis;
		return `Lstring:${(quasi?.value)?.cooked ?? ""}`;
	}
	if (node.type === "TemplateElement") return `Lstring:${node.value.cooked ?? ""}`;
	if (node.type !== "UnaryExpression" || !isAstNode(node.argument) || node.argument.type !== "Literal") return;
	if (node.operator === "!" && (node.argument.value === 0 || node.argument.value === 1)) return `Lboolean:${node.argument.value === 0}`;
	if (node.operator === "void" && node.argument.value === 0) return "I";
}
/**
* Converts an ESTree AST to a token stream that minification does not change much:
* local names become a placeholder, while property names, literals and operators stay.
*/
function tokenizeAst(program) {
	const tokens = [];
	const stack = [{
		node: program,
		isKeptName: false
	}];
	while (stack.length > 0) {
		const { node, isKeptName: keepName } = stack.pop();
		if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
			tokens.push(keepName || node.type === "PrivateIdentifier" ? `.${String(node.name)}` : "I");
			continue;
		}
		const literalToken = getLiteralToken(node);
		if (literalToken !== void 0) {
			tokens.push(literalToken);
			continue;
		}
		if (!TRANSPARENT_NODE_TYPES.has(node.type)) tokens.push(typeof node.operator === "string" ? `${node.type}${node.operator}` : node.type);
		const children = [];
		for (const [key, value] of Object.entries(node)) {
			if (POSITION_KEYS.has(key)) continue;
			for (const child of Array.isArray(value) ? value : [value]) if (isAstNode(child)) children.push({
				node: child,
				isKeptName: isKeptName(node, key)
			});
		}
		for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
	}
	return tokens;
}
function hashToken(token) {
	let hash = 2166136261;
	for (let i = 0; i < token.length; i++) hash = Math.imul(hash ^ token.charCodeAt(i), 16777619);
	return hash >>> 0;
}
/**
* Hashes every k-gram of the token stream to a 53-bit integer
*/
function hashKgrams(tokens) {
	const tokenHashes = tokens.map(hashToken);
	const kgramHashes = [];
	for (let start = 0; start + KGRAM_SIZE <= tokenHashes.length; start++) {
		let high = 2166136261;
		let low = 2538058380;
		for (let i = start; i < start + KGRAM_SIZE; i++) {
			high = Math.imul(high ^ tokenHashes[i], 16777619);
			low = Math.imul(low ^ tokenHashes[i], 1540483477);
		}
		kgramHashes.push((high >>> 0) * 2 ** 21 + (low >>> 0 & 2097151));
	}
	return kgramHashes;
}
/**
* Selects the smallest hash of each window, which keeps every shared run of tokens
* longer than the window detectable while storing only a fraction of the hashes
*/
function winnow(kgramHashes) {
	const fingerprints = /* @__PURE__ */ new Set();
	for (let start = 0; start + WINNOW_WINDOW_SIZE <= kgramHashes.length; start++) {
		let min = kgramHashes[start];
		for (let i = start + 1; i < start + WINNOW_WINDOW_SIZE; i++) min = Math.min(min, kgramHashes[i]);
		fingerprints.add(min);
	}
	return fingerprints;
}
/**
* Parses JavaScript code with the bundler's parser and hashes its k-grams.
* Returns an empty list for code that does not parse, such as JSON or Flow sources.
*/
function hashCodeKgrams(context, code) {
	try {
		return hashKgrams(tokenizeAst(context.parse(code, { allowReturnOutsideFunction: true })));
	} catch {
		return [];
	}
}
// src/vendored-packages.ts
/**
* Files larger than this are skipped, since fingerprinting them takes long and they are rarely code
*/
const MAX_FILE_SIZE_BYTES = 20971520;
const JS_FILE_PATTERN = /\.(c|m)?js$/;
const EXACT_VERSION_PATTERN = /^=?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/;
/**
* Finds the installed package `name` the way Node.js resolves it from `fromDir`
*/
async function resolveInstalledPackage(fromDir, name) {
	for (let dir = fromDir;; dir = node_path.default.dirname(dir)) {
		const packageDir = node_path.default.join(dir, "node_modules", name);
		try {
			const pkg = await readPackage(packageDir);
			if (pkg.name && pkg.version) return {
				path: await node_fs_promises.default.realpath(packageDir),
				pkg
			};
		} catch {}
		if (node_path.default.dirname(dir) === dir) return null;
	}
}
async function listJsFiles(dir) {
	const entries = await node_fs_promises.default.readdir(dir, { withFileTypes: true }).catch(() => []);
	return (await Promise.all(entries.map(async (entry) => {
		const entryPath = node_path.default.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : listJsFiles(entryPath);
		return entry.isFile() && JS_FILE_PATTERN.test(entry.name) ? [entryPath] : [];
	}))).flat();
}
async function readCode(filePath) {
	try {
		return (await node_fs_promises.default.stat(filePath)).size > MAX_FILE_SIZE_BYTES ? null : await node_fs_promises.default.readFile(filePath, "utf8");
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
function createVendoredPackageDetector(context, minMatchedFingerprints) {
	const fingerprintsByPackageDir = /* @__PURE__ */ new Map();
	const computePackageFingerprints = async (packageDir) => {
		const fingerprints = /* @__PURE__ */ new Set();
		for (const file of await listJsFiles(packageDir)) {
			const code = await readCode(file);
			if (code !== null) winnow(hashCodeKgrams(context, code)).forEach(fingerprints.add, fingerprints);
		}
		return fingerprints;
	};
	const getPackageFingerprints = (packageDir) => {
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
	const findVendoredDependencies = async (hostKgrams, importedPackageDirs, pkg, packageDir, ancestorDirs) => {
		const vendored = [];
		const declaredDependencies = {
			...pkg.dependencies,
			...pkg.optionalDependencies
		};
		for (const [name, declaredVersion] of Object.entries(declaredDependencies)) {
			const dependency = await resolveInstalledPackage(packageDir, name);
			if (!dependency || ancestorDirs.includes(dependency.path) || importedPackageDirs.has(dependency.path)) continue;
			const fingerprints = await getPackageFingerprints(dependency.path);
			let matchedFingerprints = 0;
			for (const fingerprint of fingerprints) if (hostKgrams.has(fingerprint)) matchedFingerprints++;
			context.debug(`Vendored code check: ${matchedFingerprints}/${fingerprints.size} fingerprints of ${name} in ${pkg.name}`);
			if (matchedFingerprints < minMatchedFingerprints) continue;
			vendored.push({
				pkg: dependency.pkg,
				path: dependency.path,
				declaredVersion,
				version: EXACT_VERSION_PATTERN.exec(declaredVersion)?.[1] ?? dependency.pkg.version,
				matchedFingerprints,
				totalFingerprints: fingerprints.size,
				vendored: await findVendoredDependencies(hostKgrams, importedPackageDirs, dependency.pkg, dependency.path, [...ancestorDirs, dependency.path])
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
async detect(pkg, packageDir, moduleIds, importedPackageDirs) {
		const hostKgrams = /* @__PURE__ */ new Set();
		for (const moduleId of moduleIds) {
			const code = await readCode(moduleId.split("?")[0]);
			if (code !== null) hashCodeKgrams(context, code).forEach(hostKgrams.add, hostKgrams);
		}
		return findVendoredDependencies(hostKgrams, importedPackageDirs, pkg, packageDir, [packageDir]);
	} };
}
// src/index.ts
/**
* Plugin to generate CycloneDX SBOMs for your application or library
* Compatible with Rollup and Vite.
*/
function rollupPluginSbom(userOptions) {
	const options = {
		...DEFAULT_OPTIONS,
		...userOptions
	};
	let bom;
	let dependencyInfoRegistry;
	let registeredModules;
	let rootComponent;
	let rootPackageJson;
	const cdxExternalReferenceFactory = new _cyclonedx_cyclonedx_library.Contrib.FromNodePackageJson.Factories.ExternalReferenceFactory();
	const cdxLicenseFactory = new _cyclonedx_cyclonedx_library.Contrib.License.Factories.LicenseFactory(spdx_expression_parse.default);
	const cdxLicenseEvidenceGatherer = new _cyclonedx_cyclonedx_library.Contrib.License.Utils.LicenseEvidenceGatherer();
	const cdxComponentBuilder = new _cyclonedx_cyclonedx_library.Contrib.FromNodePackageJson.Builders.ComponentBuilder(cdxExternalReferenceFactory, cdxLicenseFactory);
	const jsonSerializer = new _cyclonedx_cyclonedx_library.Serialize.JsonSerializer(new _cyclonedx_cyclonedx_library.Serialize.JSON.Normalize.Factory(_cyclonedx_cyclonedx_library.Spec.SpecVersionDict[options.specVersion]));
	const xmlSerializer = new _cyclonedx_cyclonedx_library.Serialize.XmlSerializer(new _cyclonedx_cyclonedx_library.Serialize.XML.Normalize.Factory(_cyclonedx_cyclonedx_library.Spec.SpecVersionDict[options.specVersion]));
	function processExternalModuleForBom(context, mod) {
		const dependencyInfo = dependencyInfoRegistry.get(mod.modulePath);
		if (!dependencyInfo) (mod.isTransitive ? context.debug : context.warn)({
			message: `Missing dependency info for module ${mod.modulePath} in registry, this should not happen (ID: ${mod.moduleId})`,
			meta: mod
		});
		const { pkg, licenseEvidence } = dependencyInfo || {};
		if (!pkg || !pkg.name || !pkg.version) {
			(mod.isTransitive ? context.debug : context.warn)({
				message: `Missing package data for module ${mod.modulePath} in registry, this should not happen (ID: ${mod.moduleId})`,
				meta: mod
			});
			return;
		}
		const packageId = generatePackageId(pkg);
		const doesComponentExist = registeredModules.has(packageId);
		const component = registeredModules.get(packageId) ?? cdxComponentBuilder.makeComponent(pkg);
		if (!component) {
			context.warn(`Failed to create component for ${pkg.name}@${pkg.version}`);
			return;
		}
		if (!doesComponentExist) {
			context.debug({
				message: `Registering package ${pkg?.name}@${pkg?.version}`,
				meta: mod
			});
			const componentPurl = composePackageUrlFromPackageJson(pkg);
			if (componentPurl) {
				component.purl = componentPurl.toString();
				component.bomRef.value = componentPurl.toString();
			} else context.warn(`Failed to compose package URL for ${pkg.name}@${pkg.version}`);
			component.licenses.forEach((l) => {
				l.acknowledgement = _cyclonedx_cyclonedx_library.Enums.LicenseAcknowledgement.Declared;
			});
			if (options.collectLicenseEvidence && Array.isArray(licenseEvidence) && licenseEvidence.length > 0) {
				component.evidence = new _cyclonedx_cyclonedx_library.Models.ComponentEvidence({ licenses: new _cyclonedx_cyclonedx_library.Models.LicenseRepository(licenseEvidence) });
				context.debug({
					message: `Attaching ${component.evidence.licenses.size} license evidence to ${pkg?.name}@${pkg?.version}`,
					meta: component.evidence
				});
			}
			registeredModules.set(packageId, component);
			bom.components.add(component);
			if (rootPackageJson?.dependencies && pkg.name in rootPackageJson.dependencies) rootComponent?.dependencies.add(component.bomRef);
		}
		mod.dependsOn.forEach((externalDependencyModuleInfo) => {
			const dependencyComponent = processExternalModuleForBom(context, externalDependencyModuleInfo);
			if (dependencyComponent) component.dependencies.add(dependencyComponent.bomRef);
			else context.debug(`Skipped adding dependency for ${externalDependencyModuleInfo.modulePath}: component unavailable`);
		});
		return component;
	}
	/**
	* Adds a vendored package as a nested component of the package that contains its code
	*/
	function addVendoredComponent(context, parent, vendored) {
		const vendoredPkg = {
			...vendored.pkg,
			version: vendored.version
		};
		const purl = composePackageUrlFromPackageJson(vendoredPkg)?.toString();
		if ([...parent.components].some((sibling) => sibling.purl?.toString() === purl)) return;
		const component = cdxComponentBuilder.makeComponent(vendoredPkg);
		if (!component) {
			context.warn(`Failed to create component for ${vendoredPkg.name}@${vendoredPkg.version}`);
			return;
		}
		if (purl) {
			component.purl = purl;
			component.bomRef.value = `${parent.bomRef.value}|vendored:${purl}`;
		}
		component.licenses.forEach((l) => {
			l.acknowledgement = _cyclonedx_cyclonedx_library.Enums.LicenseAcknowledgement.Declared;
		});
		component.properties.add(new _cyclonedx_cyclonedx_library.Models.Property(`${PLUGIN_ID}:vendored:detection`, "code-fingerprint"));
		component.properties.add(new _cyclonedx_cyclonedx_library.Models.Property(`${PLUGIN_ID}:vendored:matched-fingerprints`, `${vendored.matchedFingerprints}/${vendored.totalFingerprints}`));
		component.properties.add(new _cyclonedx_cyclonedx_library.Models.Property(`${PLUGIN_ID}:vendored:declared-version`, vendored.declaredVersion));
		component.properties.add(new _cyclonedx_cyclonedx_library.Models.Property(`${PLUGIN_ID}:vendored:fingerprinted-version`, vendored.pkg.version));
		parent.components.add(component);
		context.info(`Detected vendored ${vendoredPkg.name}@${vendoredPkg.version} in ${parent.name}@${parent.version} (${vendored.matchedFingerprints}/${vendored.totalFingerprints} fingerprints)`);
		vendored.vendored.forEach((child) => addVendoredComponent(context, component, child));
	}
	/**
	* Adds the dependencies whose code bundled packages copied into their own files
	*/
	async function addVendoredComponents(context, tree) {
		const detector = createVendoredPackageDetector(context, typeof options.detectVendoredPackages === "object" && options.detectVendoredPackages.minMatchedFingerprints || 20);
		const bundledModulesByPackageDir = /* @__PURE__ */ new Map();
		for (const mod of tree) {
			const info = dependencyInfoRegistry.get(mod.modulePath);
			if (!info) continue;
			const entry = bundledModulesByPackageDir.get(info.path) ?? {
				pkg: info.pkg,
				moduleIds: [],
				importedPackageDirs: /* @__PURE__ */ new Set()
			};
			entry.moduleIds.push(mod.moduleId);
			for (const imported of mod.dependsOn) {
				const importedInfo = dependencyInfoRegistry.get(imported.modulePath);
				if (importedInfo) entry.importedPackageDirs.add(importedInfo.path);
			}
			bundledModulesByPackageDir.set(info.path, entry);
		}
		for (const [packageDir, { pkg, moduleIds, importedPackageDirs }] of bundledModulesByPackageDir) {
			const host = registeredModules.get(generatePackageId(pkg));
			if (!host) continue;
			for (const vendored of await detector.detect(pkg, packageDir, moduleIds, importedPackageDirs)) addVendoredComponent(context, host, vendored);
		}
	}
	return {
		name: PLUGIN_ID,
		async buildStart() {
			bom = new _cyclonedx_cyclonedx_library.Models.Bom({ metadata: new _cyclonedx_cyclonedx_library.Models.Metadata({
				supplier: options.supplier && convertOrganizationalEntityOptionToModel(options.supplier),
				properties: options.properties && new _cyclonedx_cyclonedx_library.Models.PropertyRepository(options.properties.map(({ name, value }) => new _cyclonedx_cyclonedx_library.Models.Property(name, value)))
			}) });
			dependencyInfoRegistry = createDependencyInfoRegistry();
			registeredModules = /* @__PURE__ */ new Map();
			rootComponent = void 0;
			rootPackageJson = void 0;
			if (options.autodetect) try {
				this.debug(`Autodetection enabled, trying to resolve root component`);
				const rootPkg = await readPackage(process.cwd());
				if (rootPkg) {
					this.info(`Detected root ${rootPkg.name} v${rootPkg.version}`);
					rootPackageJson = rootPkg;
					rootComponent = cdxComponentBuilder.makeComponent(rootPkg, options.rootComponentType);
					if (!rootComponent) this.error({ message: `could not construct root component` });
					rootComponent.version = rootPkg.version;
					const rootComponentPurl = composePackageUrlFromPackageJson(rootPkg);
					if (rootComponentPurl) {
						rootComponent.purl = rootComponentPurl.toString();
						rootComponent.bomRef.value = rootComponentPurl.toString();
					} else this.warn(`Failed to compose package URL for ${rootPkg.name}@${rootPkg.version}`);
					bom.metadata.component = rootComponent;
				}
			} catch (err) {
				this.error({
					message: `autodetection failed: ${err instanceof Error ? err.message : err}`,
					meta: { error: err }
				});
			}
			bom.metadata.lifecycles.add(_cyclonedx_cyclonedx_library.Enums.LifecyclePhase.Build);
			if (options.saveTimestamp) {
				this.info(`Saving timestamp to SBOM`);
				bom.metadata.timestamp = /* @__PURE__ */ new Date();
			}
			if (options.generateSerial) {
				this.info(`Generating random serial number for SBOM`);
				bom.serialNumber = _cyclonedx_cyclonedx_library.Contrib.Bom.Utils.randomSerialNumber();
			}
			await autoRegisterTools(this, bom, cdxComponentBuilder, options.collectLicenseEvidence ? cdxLicenseEvidenceGatherer : void 0);
			if (options.beforeCollect) {
				this.debug("Applying custom transform \"beforeCollect\"");
				options.beforeCollect(bom);
			}
		},
		/**
		* We use this hook to load normalized package.json data and module specific info for each imported module.
		* As this hook runs in parallel before finishing the bundle, we can ensure that
		* all required package.json files are loaded before we start the BOM generation.
		*/
		async moduleParsed(moduleInfo) {
			await aggregateDependencyInfoByModuleId(this, dependencyInfoRegistry, moduleInfo.id, options.collectLicenseEvidence ? cdxLicenseEvidenceGatherer : void 0);
		},
		/**
		* Build the SBOM and emit files
		*/
		async generateBundle(_outputOptions, bundle) {
			const tree = await getAllExternalModules(this, bundle);
			for (const mod of tree) if (!dependencyInfoRegistry.has(mod.modulePath)) await aggregateDependencyInfoByModulePath(this, dependencyInfoRegistry, mod.modulePath, options.collectLicenseEvidence ? cdxLicenseEvidenceGatherer : void 0);
			for (const mod of tree) processExternalModuleForBom(this, mod);
			const serializeOptions = {
				sortLists: options.sortLists,
				space: "	"
			};
			const formatMap = {
				json: jsonSerializer,
				xml: xmlSerializer
			};
			if (options.detectVendoredPackages) await addVendoredComponents(this, tree);
			if (options.afterCollect) {
				this.debug("Applying custom transform \"afterCollect\"");
				options.afterCollect(bom);
			}
			options.outFormats.forEach((format) => {
				if (!formatMap[format]) throw new Error(`Unsupported format: ${format}`);
				const sbomFilePath = (0, node_path.join)(options.outDir, `${options.outFilename}.${format}`);
				this.debug(`Emitting SBOM asset to ${sbomFilePath}`);
				this.emitFile({
					type: "asset",
					fileName: sbomFilePath,
					needsCodeReference: false,
					source: formatMap[format].serialize(bom, serializeOptions)
				});
			});
			if (options.includeWellKnown) {
				this.debug(`Emitting well-known file to .well-known/sbom`);
				this.emitFile({
					type: "asset",
					fileName: ".well-known/sbom",
					needsCodeReference: false,
					source: jsonSerializer.serialize(bom, serializeOptions)
				});
			}
		}
	};
}
module.exports = rollupPluginSbom;

//# sourceMappingURL=index.cjs.map