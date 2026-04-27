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
import * as wasm from "../wasm-node/hypen_engine.js";

// `StatePath` is just a string in core; we mirror the engine's
// { path, value }[] output into the { paths[], newValues{} } shape
// that `@hypen-space/core/state` expects.
function diffState(oldState: any, newState: any, _basePath?: string) {
  // JSON.stringify throws on BigInt / circular refs. The engine sees
  // state as JSON only, so values it can't represent are opaque to
  // reactivity anyway — fall back to an empty StateChange in that
  // case, matching what a JSON-only reactive graph could ever see.
  let oldJson: string;
  let newJson: string;
  try {
    oldJson = JSON.stringify(oldState ?? null);
    newJson = JSON.stringify(newState ?? null);
  } catch {
    return { paths: [], newValues: {} };
  }
  const raw = wasm.diffPaths(oldJson, newJson);
  const entries: Array<{ path: string; value: any }> = JSON.parse(raw);
  const paths: string[] = [];
  const newValues: Record<string, any> = {};
  for (const e of entries) {
    paths.push(e.path);
    newValues[e.path] = e.value;
  }
  return { paths, newValues };
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
