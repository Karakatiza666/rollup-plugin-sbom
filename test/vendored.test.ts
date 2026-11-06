/**
 * Important: Please take a look at the test fixture documentation before altering tests in ./fixtures/vendored/README.md
 */

import { describe, expect, test } from "vitest";
import { createOutputTestHelpers } from "./test-helpers";

const helpers = createOutputTestHelpers("vendored");

describe("Vendored packages", () => {
    test("it should nest the packages whose code another package ships as components of that package", async () => {
        const { components } = await helpers.getCompiledFileJSONContent("cyclonedx/bom.json");

        const host = components?.find(({ name }) => name === "host");
        expect(host?.components).toEqual([
            expect.objectContaining({
                name: "lib",
                version: "1.2.0",
                purl: "pkg:npm/lib@1.2.0",
                "bom-ref": "pkg:npm/host@1.0.0|vendored:pkg:npm/lib@1.2.0",
                properties: expect.arrayContaining([
                    { name: "rollup-plugin-sbom:vendored:detection", value: "code-fingerprint" },
                    { name: "rollup-plugin-sbom:vendored:declared-version", value: "^1.0.0" },
                ]),
            }),
        ]);
    });

    test("it should report the declared exact version, not the installed version that replaced it", async () => {
        const { components } = await helpers.getCompiledFileJSONContent("cyclonedx/bom.json");

        const lib = components?.find(({ name }) => name === "host")?.components?.[0];
        expect(lib?.components).toEqual([
            expect.objectContaining({
                name: "sublib",
                version: "1.0.0",
                properties: expect.arrayContaining([
                    { name: "rollup-plugin-sbom:vendored:declared-version", value: "1.0.0" },
                    { name: "rollup-plugin-sbom:vendored:fingerprinted-version", value: "1.0.1" },
                ]),
            }),
        ]);
    });

    test("it should not report installed dependencies whose code is not in the bundle", async () => {
        const bom = await helpers.getCompiledFileRawContent("cyclonedx/bom.json");

        expect(bom).not.toContain("unrelated");
        expect(JSON.parse(bom).components).toHaveLength(1);
    });

    test("it should generate a valid SBOM with nested components", async () => {
        const bom = await helpers.getCompiledFileRawContent("cyclonedx/bom.json");

        expect(helpers.isBomValidAccordingToSchema("v1.7", bom)).toBeTruthy();
    });
});
