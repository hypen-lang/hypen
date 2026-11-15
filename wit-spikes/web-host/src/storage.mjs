// Thin re-export shim: the storage backends (localStorage auto-detect with
// in-memory fallback, LocalBucket/CloudBucket for hypen:storage/{local,
// cloud}) now live in the standalone @hypen-space/module-host package —
// hypen-web/packages/module-host.
//
// Imported via a RELATIVE path into that package's built dist so plain
// `node` can run the spike without workspace linking. Backend selection
// (localStorage vs memory) still happens at first import of the package
// module, so shim a `globalThis.localStorage` BEFORE importing this file to
// get the browser-persistent path (see scripts/test-localstore.mjs). If the
// import fails, build the package first:
//
//   cd ../../hypen-web && bun install && bun run build:module-host

let mod;
try {
  mod = await import('../../../hypen-web/packages/module-host/dist/storage.js');
} catch (cause) {
  throw new Error(
    '@hypen-space/module-host is not built (the wit-spike re-exports its dist). ' +
      'Run: cd hypen-web && bun install && bun run build:module-host',
    { cause },
  );
}

export const { LocalBucket, CloudBucket, dumpStores, BrowserLocalStore, MemoryLocalStore, LS_PREFIX } = mod;
