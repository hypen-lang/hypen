/**
 * Install the engine-backed [`PortableImpl`] into `@hypen-space/core`
 * for the browser build.
 *
 * Unlike the server build (which loads WASM synchronously at import
 * time), the browser loads via dynamic `import()`, so the install
 * runs inside `Engine.init()` after the module is ready.
 */

import { setPortableImpl, type PortableImpl } from "@hypen-space/core/portable";

export function installPortableFromWasm(wasm: any): void {
  // Skip the install if the wasm module doesn't actually expose the
  // portable exports. This happens in tests that mock the wasm-browser
  // module with a stub; in that case we want `@hypen-space/core` to
  // keep using its TS fallback.
  if (typeof wasm?.diffPaths !== "function") {
    return;
  }

  const impl: PortableImpl = {
    diffState(oldState, newState, _basePath) {
      // JSON.stringify can throw on BigInt / circular refs; the engine
      // reasons over JSON only, so such values are opaque to reactivity.
      let oldJson: string;
      let newJson: string;
      try {
        oldJson = JSON.stringify(oldState ?? null);
        newJson = JSON.stringify(newState ?? null);
      } catch {
        return { paths: [], newValues: {} };
      }
      const raw: string = wasm.diffPaths(oldJson, newJson);
      const entries: Array<{ path: string; value: any }> = JSON.parse(raw);
      const paths: string[] = [];
      const newValues: Record<string, any> = {};
      for (const e of entries) {
        paths.push(e.path);
        newValues[e.path] = e.value;
      }
      return { paths, newValues };
    },
    matchPath(pattern, path) {
      const parsed = JSON.parse(wasm.matchPath(pattern, path));
      return parsed.matched ? { params: parsed.params } : null;
    },
    pathGet: (v, p) =>
      JSON.parse(wasm.pathGet(JSON.stringify(v ?? null), p)),
    pathHas: (v, p) =>
      wasm.pathHas(JSON.stringify(v ?? null), p) === "true",
    pathSet: (v, p, nv) =>
      JSON.parse(
        wasm.pathSet(
          JSON.stringify(v ?? null),
          p,
          JSON.stringify(nv ?? null),
        ),
      ),
    pathDelete(v, p) {
      const parsed = JSON.parse(
        wasm.pathDelete(JSON.stringify(v ?? null), p),
      );
      return { value: parsed.json, removed: parsed.removed };
    },
    encodeUriComponent: (s) => wasm.encodeUriComponent(s),
    decodeUriComponent: (s) => wasm.decodeUriComponent(s),
    parseQuery: (f) => JSON.parse(wasm.parseQuery(f)),
    buildUrl: (p, q) => wasm.buildUrl(p, JSON.stringify(q ?? {})),
  };
  setPortableImpl(impl);
}
