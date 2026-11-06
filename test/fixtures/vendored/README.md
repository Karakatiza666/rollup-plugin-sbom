# Vendored Fixture

This test project verifies `detectVendoredPackages`. In this project, a bundled package ships a minified copy of its dependencies instead of importing them.

### Development

The postinstall script copies the modules from `fake-tree` to `node_modules`. After you change the modules, sync them with `pnpm postinstall`.

`fake-tree/host/index.js` is the minified bundle of `lib` and `sublib`. After you change `lib` or `sublib`, regenerate `fake-tree/host/index.js`:

```sh
pnpm postinstall
echo 'export * from "lib";' > node_modules/vendored-entry.js
pnpm exec rolldown node_modules/vendored-entry.js --minify --format esm --file fake-tree/host/index.js
rm node_modules/vendored-entry.js
pnpm postinstall
pnpm build
```

### Package Tree

| Package           | Declares                                | Content                                       |
| ----------------- | --------------------------------------- | --------------------------------------------- |
| App               | -                                       | Imports `host`                                |
| `host@1.0.0`      | `lib: ^1.0.0`, `unrelated: 1.0.0`       | A minified copy of `lib` and `sublib`         |
| `lib@1.2.0`       | `sublib: 1.0.0`                         | Source, imports `sublib`                      |
| `sublib@1.0.1`    | -                                       | Source                                        |
| `unrelated@1.0.0` | -                                       | Source, not part of the bundle                |

The installed `sublib` is `1.0.1`, but `lib` declares the exact version `1.0.0`. An override causes the same difference. An override does not change vendored code, so the SBOM must report the declared `1.0.0`.

### Expected SBOM result

- `host` is a top-level component with `lib@1.2.0` as nested component (the installed version, because `host` declares `lib` as a range)
- `lib` has `sublib@1.0.0` as nested component (the declared exact version)
- `unrelated` is not part of the SBOM
