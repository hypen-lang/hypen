/**
 * Install the engine-backed [`PortableImpl`] into `@hypen-space/core`
 * for the browser build.
 *
 * Unlike the server build (which loads WASM synchronously at import
 * time), the browser loads via dynamic `import()`, so the install
 * runs inside `Engine.init()` after the module is ready.
 */

import { setPortableImpl, type PortableImpl } from "@hypen-space/core/portable";
import {
  diffStateJs,
  diffOracleEnabled,
  checkDiffOracle,
} from "@hypen-space/core/diff";

export function installPortableFromWasm(wasm: any): void {
  // Skip the install if the wasm module doesn't actually expose the
  // portable exports. This happens in tests that mock the wasm-browser
  // module with a stub; in that case we want `@hypen-space/core` to
  // keep throwing its "not installed" error.
  if (typeof wasm?.diffPaths !== "function") {
    return;
  }

  const impl: PortableImpl = {
    // `diffState` is the one portable helper NOT routed through WASM:
    // it runs on every mutation flush, and stringifying the whole
    // state twice per flush was Θ(|state| bytes) per mutation. The TS
    // port is pinned to `diff.rs` by the cross-SDK fixtures and the
    // differential fuzz suite; set globalThis.__HYPEN_DIFF_ORACLE__ =
    // true to cross-check every diff against WASM at runtime.
    diffState(oldState, newState, basePath) {
      const change = diffStateJs(oldState, newState, basePath);
      if (diffOracleEnabled()) {
        checkDiffOracle(change, oldState, newState, wasm.diffPaths);
      }
      return change;
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
