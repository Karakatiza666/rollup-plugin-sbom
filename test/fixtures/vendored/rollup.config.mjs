import pluginSbom from "rollup-plugin-sbom";
import pluginResolve from "@rollup/plugin-node-resolve";

/**
 * @type {import("rollup").RollupOptions}
 */
export default {
    input: "src/index.js",
    logLevel: "debug",
    output: {
        file: "dist/index.js",
        format: "iife",
    },
    plugins: [
        pluginResolve({
            browser: true,
        }),
        pluginSbom({
            detectVendoredPackages: true,
            includeWellKnown: false,
        }),
    ],
};
