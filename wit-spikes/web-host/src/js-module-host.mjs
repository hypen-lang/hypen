// Thin re-export shim: the JsModuleHost (register/prepare/instantiate/
// actions/init/dispatch/lifecycle, per-call ACL context, runtime jco
// transpile pipeline, wasi:http egress gate) now lives in the standalone
// @hypen-space/module-host package — hypen-web/packages/module-host.
//
// Imported via a RELATIVE path into that package's built dist so plain
// `node` can run the spike without workspace linking. If the import fails,
// build the package first:
//
//   cd ../../hypen-web && bun install && bun run build:module-host

let mod;
try {
  mod = await import('../../../hypen-web/packages/module-host/dist/js-module-host.js');
} catch (cause) {
  throw new Error(
    '@hypen-space/module-host is not built (the wit-spike re-exports its dist). ' +
      'Run: cd hypen-web && bun install && bun run build:module-host',
    { cause },
  );
}

export const { JsModuleHost, engineStateImport, buildImportMap } = mod;
