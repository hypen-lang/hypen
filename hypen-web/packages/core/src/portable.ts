/**
 * Portable helper DI seam for `@hypen-space/core`.
 *
 * `@hypen-space/core` is WASM-free: it ships to contexts (tree-shakers,
 * browser remote-client bundles) that must not pull in the 2 MB engine
 * binary. But every Hypen runtime — Node via `@hypen-space/server`,
 * browser SPA via `@hypen-space/web-engine`, tests via the bun preload
 * — composes core with a host that HAS loaded the engine. Those
 * packages call [`setPortableImpl`] at their init time, plugging the
 * canonical Rust-engine impls (`hypen-engine-rs/src/portable/`) into
 * core.
 *
 * There is no TypeScript fallback. A core instance whose portable
 * helpers are called before `setPortableImpl` has run throws a clear
 * error pointing at the fix. Reasons:
 *
 * * Any fallback is a second implementation to maintain, exactly the
 *   drift tax this whole refactor eliminated for the other four SDKs.
 * * Core's own consumers of the portable helpers (`HypenRouter.matchPath`,
 *   `createObservableState`'s `notifyChange`) are never reached in
 *   remote-client-only browser bundles — those bundles drive UI purely
 *   from server-pushed patches.
 * * Callers who DO reach the helpers (server, web-engine, tests) always
 *   have an engine available.
 */

import type { StateChange, StatePath } from "./state";

export interface PortableImpl {
  diffState(oldState: any, newState: any, basePath?: string): StateChange;
  matchPath(
    pattern: string,
    path: string,
  ): { params: Record<string, string> } | null;
  pathGet(value: any, path: string): unknown;
  pathHas(value: any, path: string): boolean;
  pathSet(value: any, path: string, newValue: any): any;
  pathDelete(value: any, path: string): { value: any; removed: boolean };
  encodeUriComponent(input: string): string;
  decodeUriComponent(input: string): string;
  parseQuery(fullPath: string): { path: string; query: Record<string, string> };
  buildUrl(path: string, query: Record<string, string>): string;
}

function notInstalled(name: string): never {
  throw new Error(
    `[@hypen-space/core] Portable helper "${name}" called before the engine was installed. ` +
      `Import @hypen-space/server, @hypen-space/web-engine, or call setPortableImpl() before use.`,
  );
}

let current: PortableImpl = {
  diffState: () => notInstalled("diffState"),
  matchPath: () => notInstalled("matchPath"),
  pathGet: () => notInstalled("pathGet"),
  pathHas: () => notInstalled("pathHas"),
  pathSet: () => notInstalled("pathSet"),
  pathDelete: () => notInstalled("pathDelete"),
  encodeUriComponent: () => notInstalled("encodeUriComponent"),
  decodeUriComponent: () => notInstalled("decodeUriComponent"),
  parseQuery: () => notInstalled("parseQuery"),
  buildUrl: () => notInstalled("buildUrl"),
};

/**
 * Install the engine-backed [`PortableImpl`]. Called once by
 * `@hypen-space/server` at import time (synchronous wasm-node load) or
 * by `@hypen-space/web-engine` inside `Engine.init()` once the browser
 * wasm module resolves.
 *
 * Passing `null` resets to the "not installed" throwing default — used
 * by test teardown when you want to verify the no-engine error path.
 */
export function setPortableImpl(impl: PortableImpl | null): void {
  if (impl === null) {
    current = {
      diffState: () => notInstalled("diffState"),
      matchPath: () => notInstalled("matchPath"),
      pathGet: () => notInstalled("pathGet"),
      pathHas: () => notInstalled("pathHas"),
      pathSet: () => notInstalled("pathSet"),
      pathDelete: () => notInstalled("pathDelete"),
      encodeUriComponent: () => notInstalled("encodeUriComponent"),
      decodeUriComponent: () => notInstalled("decodeUriComponent"),
      parseQuery: () => notInstalled("parseQuery"),
      buildUrl: () => notInstalled("buildUrl"),
    };
    return;
  }
  current = impl;
}

/**
 * Live portable API. Every call dispatches to whatever
 * [`setPortableImpl`] most recently installed.
 */
export const portable: PortableImpl = {
  diffState: (o, n, b) => current.diffState(o, n, b),
  matchPath: (p, path) => current.matchPath(p, path),
  pathGet: (v, p) => current.pathGet(v, p),
  pathHas: (v, p) => current.pathHas(v, p),
  pathSet: (v, p, nv) => current.pathSet(v, p, nv),
  pathDelete: (v, p) => current.pathDelete(v, p),
  encodeUriComponent: (s) => current.encodeUriComponent(s),
  decodeUriComponent: (s) => current.decodeUriComponent(s),
  parseQuery: (f) => current.parseQuery(f),
  buildUrl: (p, q) => current.buildUrl(p, q),
};

// `StatePath` is still part of this module's public surface via
// re-export; keeping it reachable from `@hypen-space/core/portable`
// simplifies bindings in server / web-engine adapters.
export type { StatePath } from "./state";
