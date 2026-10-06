/**
 * CFEngine — a `BaseEngine` for Cloudflare Workers (workerd).
 *
 * `@hypen-space/cf` stays WASM-free (typecheckable/testable without a `.wasm`
 * or the wrangler-only `CompiledWasm` import), so the WASM is injected: the
 * consumer's worker imports the web-target glue + compiled module and passes
 * them to `createCFEngine`. The web target is required because workerd hands
 * you a `WebAssembly.Module`, not live exports — only `initSync({ module })`
 * accepts that. See `docs/implementing-an-engine.md`.
 */

import { BaseEngine } from "@hypen-space/core/engine-base";
import { setPortableImpl, type PortableImpl } from "@hypen-space/core/portable";
import {
  diffStateJs,
  diffOracleEnabled,
  checkDiffOracle,
} from "@hypen-space/core/diff";

/**
 * The web-target wasm-bindgen exports CFEngine + the portable installer use,
 * typed structurally so the cf package never imports the generated `.d.ts`.
 */
export interface CFWasmExports {
  WasmEngine: new () => any;
  initSync?: (init: { module: WebAssembly.Module }) => unknown;
  diffPaths(oldJson: string, newJson: string): string;
  matchPath(pattern: string, path: string): string;
  pathGet(valueJson: string, path: string): string;
  pathHas(valueJson: string, path: string): string;
  pathSet(valueJson: string, path: string, newValueJson: string): string;
  pathDelete(valueJson: string, path: string): string;
  encodeUriComponent(input: string): string;
  decodeUriComponent(input: string): string;
  parseQuery(fullPath: string): string;
  buildUrl(path: string, queryJson: string): string;
}

/** Build a `PortableImpl` backed by the web-target WASM's free functions. */
export function makeCFPortableImpl(wasm: CFWasmExports): PortableImpl {
  return {
    // `diffState` is the one portable helper NOT routed through WASM —
    // it runs per mutation flush and the whole-state stringify round
    // trip was Θ(|state|) each time. `diffStateJs` is the TS port of
    // the canonical algorithm (pinned by the cross-SDK fixtures and
    // the differential fuzz suite); __HYPEN_DIFF_ORACLE__ cross-checks
    // it against the WASM implementation at runtime.
    diffState(oldState: any, newState: any, basePath?: string) {
      const change = diffStateJs(oldState, newState, basePath);
      if (diffOracleEnabled()) {
        checkDiffOracle(change, oldState, newState, wasm.diffPaths);
      }
      return change;
    },
    matchPath(pattern: string, path: string) {
      const parsed = JSON.parse(wasm.matchPath(pattern, path)) as {
        matched: boolean;
        params: Record<string, string>;
      };
      return parsed.matched ? { params: parsed.params } : null;
    },
    pathGet: (v, p) => JSON.parse(wasm.pathGet(JSON.stringify(v ?? null), p)),
    pathHas: (v, p) => wasm.pathHas(JSON.stringify(v ?? null), p) === "true",
    pathSet: (v, p, nv) =>
      JSON.parse(wasm.pathSet(JSON.stringify(v ?? null), p, JSON.stringify(nv ?? null))),
    pathDelete: (v, p) => {
      const parsed = JSON.parse(wasm.pathDelete(JSON.stringify(v ?? null), p)) as {
        json: any;
        removed: boolean;
      };
      return { value: parsed.json, removed: parsed.removed };
    },
    encodeUriComponent: (s) => wasm.encodeUriComponent(s),
    decodeUriComponent: (s) => wasm.decodeUriComponent(s),
    parseQuery: (full) =>
      JSON.parse(wasm.parseQuery(full)) as { path: string; query: Record<string, string> },
    buildUrl: (path, query) => wasm.buildUrl(path, JSON.stringify(query ?? {})),
  };
}

/**
 * Instantiate the web-target WASM (idempotent) and install its portable helpers
 * into `@hypen-space/core`. Call at module-load time, before any
 * `app.defineState(...)` runs — that triggers `createObservableState`, which
 * needs `diffState` installed.
 */
export function installCFPortable(wasm: CFWasmExports, wasmModule?: WebAssembly.Module): void {
  ensureInit(wasm, wasmModule);
}

const initialized = new WeakSet<CFWasmExports>();
function ensureInit(wasm: CFWasmExports, wasmModule?: WebAssembly.Module): void {
  if (initialized.has(wasm)) return;
  if (wasmModule && typeof wasm.initSync === "function") {
    wasm.initSync({ module: wasmModule });
  }
  setPortableImpl(makeCFPortableImpl(wasm));
  initialized.add(wasm);
}

/**
 * Create a `CFEngine` class bound to the injected WASM exports. Installs
 * portable eagerly (before any module-graph code runs).
 *
 * @param wasm        web-target exports (`import * as wasm from "hypen-engine"`)
 * @param wasmModule  the compiled module, for `initSync`
 */
export function createCFEngine(
  wasm: CFWasmExports,
  wasmModule?: WebAssembly.Module,
): new () => BaseEngine {
  // Install eagerly so portable is ready before any module graph code runs.
  ensureInit(wasm, wasmModule);

  return class CFEngine extends BaseEngine {
    constructor() {
      super();
      ensureInit(wasm, wasmModule);
      this.wasmEngine = new wasm.WasmEngine();
      this.wasmEngine.registerDefaultPrimitives();
      this.initialized = true;
    }

    async init(_options?: unknown): Promise<void> {
      // No-op — the constructor already instantiated the engine. Kept to
      // satisfy the abstract base contract.
    }

    // normalizeAction (the web-target Map→object payload walk) is inherited
    // from BaseEngine's default — the web target needs it and the base now
    // provides it, so no override here.

    // Unwrap proxy/Map state for the WASM boundary; proxy snapshot first.
    protected unwrapForWasm<T>(value: T): T {
      if (value === null || typeof value !== "object") return value;
      const snapshot = (value as { __getSnapshot?: () => T }).__getSnapshot;
      if (typeof snapshot === "function") return snapshot.call(value);
      try {
        return structuredClone(value);
      } catch {
        return JSON.parse(JSON.stringify(value));
      }
    }
  };
}
