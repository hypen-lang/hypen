/**
 * Browser-compatible wrapper around the WASM engine.
 *
 * Thin subclass of `BaseEngine` from `@hypen-space/core/engine-base`.
 * All method wrappers live in the base; this file only provides:
 *
 *   - Async `init(options)` that dynamically imports the `wasm-browser`
 *     JS glue code from a CDN (or caller-provided URL) and then calls
 *     the wasm-bindgen `__wbg_init(wasmUrl)` entry point.
 *
 *   - `unwrapForWasm` using core's copy-on-write `normalizeForWasm` walk,
 *     which strips Hypen's state proxies and JSON-normalizes exotic values
 *     without cloning data that is already plain.
 *
 * The web-target `Map`-payload conversion (`normalizeAction`) now lives in
 * `BaseEngine` as the default, so this subclass inherits it — every
 * web-target consumer gets the fix without re-declaring it.
 */

import { BaseEngine, normalizeForWasm } from "@hypen-space/core/engine-base";
import { frameworkLoggers } from "@hypen-space/core/logger";
import type { A11yDiagnostic } from "@hypen-space/core";
import { installPortableFromWasm } from "./install-portable.js";

// Re-export types so consumers of "./engine.js" still work
export type {
  Patch,
  Action,
  RenderCallback,
  ActionHandler,
  ResolvedComponent,
  ComponentResolver,
  // External capability surface — `listActions` / `listRoutes` /
  // `listBindings` / `dispatchExternal` / `getStateAt` /
  // `unregisterModule` are inherited from `BaseEngine`, so a browser host
  // reaches the guarded surface through this `Engine` with no extra wiring.
  AgentAction,
  AgentRoute,
  BoundInput,
} from "@hypen-space/core/types";

const log = frameworkLoggers.engine;

// Dynamic import path — configured by init()
let wasmInit: ((path?: string) => Promise<void>) | null = null;
let WasmEngineClass: any = null;

export interface EngineInitOptions {
  /**
   * URL to the WASM binary file.
   * Default: loads from unpkg CDN
   * For production, consider serving from your own domain for better performance.
   */
  wasmUrl?: string;

  /**
   * URL to the WASM JS glue code.
   * Default: loads from unpkg CDN
   * For self-hosting, point to your own copy of hypen_engine.js
   */
  jsUrl?: string;
}

/**
 * Engine wraps the WASM engine (browser target) and provides a
 * TypeScript-friendly API with explicit WASM initialization.
 */
export class Engine extends BaseEngine {
  /**
   * Initialize the WASM module by dynamically importing the JS glue
   * code and fetching the WASM binary, both from `options.jsUrl` /
   * `options.wasmUrl` (default: unpkg CDN).
   */
  async init(options: EngineInitOptions = {}): Promise<void> {
    if (this.initialized) return;

    // Default to CDN for zero-config experience
    const cdnBase =
      "https://unpkg.com/@hypen-space/web-engine@latest/wasm-browser";
    const jsUrl = options.jsUrl ?? `${cdnBase}/hypen_engine.js`;
    const wasmUrl = options.wasmUrl ?? `${cdnBase}/hypen_engine_bg.wasm`;

    // Dynamically import the WASM JS glue code from CDN (or custom URL).
    // Using dynamic import with a variable URL to avoid bundler resolution.
    try {
      const wasmModule: any = await import(/* @vite-ignore */ jsUrl);
      wasmInit = wasmModule.default;
      WasmEngineClass = wasmModule.WasmEngine;

      // Initialize WASM with explicit path
      await wasmInit!(wasmUrl);

      this.wasmEngine = new WasmEngineClass();
      this.wasmEngine.registerDefaultPrimitives();

      // Hand the engine's portable helpers to `@hypen-space/core` so
      // every subsequent `createObservableState` / `HypenRouter.matchPath`
      // call goes through the canonical Rust implementations rather
      // than core's TS fallback.
      installPortableFromWasm(wasmModule);

      this.initialized = true;
    } catch (error) {
      log.error("Failed to initialize WASM engine:", error);
      throw error;
    }
  }

  /**
   * Run the engine's dev-mode accessibility conformance pass over a DSL
   * source and return the findings as `A11yDiagnostic[]`.
   *
   * The underlying WASM binding only exists after a WASM rebuild
   * (`bun run build:wasm`); until then this returns `[]` so hosts can wire
   * the call without breaking typecheck or runtime. Cast through `any`
   * because the generated `WasmEngine` types lag the Rust binding.
   */
  checkAccessibility(source: string): A11yDiagnostic[] {
    if (typeof (this.wasmEngine as any)?.checkAccessibility !== "function") {
      return [];
    }
    return (this.wasmEngine as any).checkAccessibility(source) as A11yDiagnostic[];
  }

  /**
   * Unwrap host state for WASM.
   *
   * The wasm-bindgen entry points deserialize each argument synchronously
   * (`serde_wasm_bindgen::from_value`) and retain nothing afterwards, so
   * no defensive copy is needed — only proxy-stripping and JSON
   * normalization, which `normalizeForWasm` applies copy-on-write. The
   * hot sparse-update path (values just parsed out of the engine's own
   * diff output) is already plain and crosses by reference, instead of
   * round-tripping through `JSON.parse(JSON.stringify())` on every
   * mutation flush.
   */
  protected unwrapForWasm<T>(value: T): T {
    if (value === null || typeof value !== "object") {
      return value;
    }
    return normalizeForWasm(value) as T;
  }
}
