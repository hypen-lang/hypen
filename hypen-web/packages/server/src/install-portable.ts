/**
 * Install the engine-backed [`PortableImpl`] into `@hypen-space/core`.
 *
 * Imported for its side-effect at the top of `engine.ts`. Because the
 * wasm-node build initialises its WASM module synchronously at import
 * time, calling `setPortableImpl` here is safe even before any engine
 * instance is constructed — every subsequent core operation
 * (`createObservableState`, `HypenRouter.matchPath`, …) will go
 * through the canonical Rust implementation.
 *
 * The mirror file lives at
 * `packages/web-engine/src/install-portable.ts` for the browser build.
 */

import { setPortableImpl, type PortableImpl } from "@hypen-space/core/portable";
import {
  diffStateJs,
  diffOracleEnabled,
  checkDiffOracle,
} from "@hypen-space/core/diff";
import * as wasm from "../wasm-node/hypen_engine.js";

// `diffState` is the one portable helper NOT routed through WASM: it
// runs on every mutation flush, and the stringify→parse round trip of
// the entire state made it Θ(|state| bytes) per mutation (70–90 µs/KB
// measured). `diffStateJs` is the TS port of the same canonical
// algorithm, pinned to `diff.rs` by the cross-SDK fixtures and the
// differential fuzz suite; set HYPEN_DIFF_ORACLE=1 to cross-check
// every diff against the WASM implementation at runtime.
function diffState(oldState: any, newState: any, basePath?: string) {
  const change = diffStateJs(oldState, newState, basePath);
  if (diffOracleEnabled()) {
    checkDiffOracle(change, oldState, newState, wasm.diffPaths);
  }
  return change;
}

function matchPath(pattern: string, path: string) {
  const raw = wasm.matchPath(pattern, path);
  const parsed = JSON.parse(raw) as {
    matched: boolean;
    params: Record<string, string>;
  };
  return parsed.matched ? { params: parsed.params } : null;
}

function pathGet(value: any, path: string): unknown {
  const raw = wasm.pathGet(JSON.stringify(value ?? null), path);
  return JSON.parse(raw);
}

function pathHas(value: any, path: string): boolean {
  return wasm.pathHas(JSON.stringify(value ?? null), path) === "true";
}

function pathSet(value: any, path: string, newValue: any): any {
  const raw = wasm.pathSet(
    JSON.stringify(value ?? null),
    path,
    JSON.stringify(newValue ?? null),
  );
  return JSON.parse(raw);
}

function pathDelete(value: any, path: string) {
  const raw = wasm.pathDelete(JSON.stringify(value ?? null), path);
  const parsed = JSON.parse(raw) as { json: any; removed: boolean };
  return { value: parsed.json, removed: parsed.removed };
}

function parseQuery(full: string) {
  return JSON.parse(wasm.parseQuery(full)) as {
    path: string;
    query: Record<string, string>;
  };
}

function buildUrl(path: string, query: Record<string, string>): string {
  return wasm.buildUrl(path, JSON.stringify(query ?? {}));
}

const impl: PortableImpl = {
  diffState,
  matchPath,
  pathGet,
  pathHas,
  pathSet,
  pathDelete,
  encodeUriComponent: (s) => wasm.encodeUriComponent(s),
  decodeUriComponent: (s) => wasm.decodeUriComponent(s),
  parseQuery,
  buildUrl,
};

setPortableImpl(impl);
