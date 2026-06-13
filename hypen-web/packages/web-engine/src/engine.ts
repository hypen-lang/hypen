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
 *   - `unwrapForWasm` using `JSON.parse(JSON.stringify())` (structuredClone
 *     doesn't handle Hypen's proxy-backed state uniformly across browsers).
 *
 * The web-target `Map`-payload conversion (`normalizeAction`) now lives in
 * `BaseEngine` as the default, so this subclass inherits it — every
 * web-target consumer gets the fix without re-declaring it.
 */

import { BaseEngine } from "@hypen-space/core/engine-base";
import { frameworkLoggers } from "@hypen-space/core/logger";
import { installPortableFromWasm } from "./install-portable.js";

// Re-export types so consumers of "./engine.js" still work
export type {
  Patch,
  Action,
  RenderCallback,
  ActionHandler,
  ResolvedComponent,
  ComponentResolver,
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
   * Unwrap host state for WASM.
   *
   * Browser path uses `JSON.parse(JSON.stringify())` — `structuredClone`
   * is available in modern browsers, but Hypen's proxy-backed state has
   * historically been more consistent with the JSON round-trip here.
   */
  protected unwrapForWasm<T>(value: T): T {
    if (value === null || typeof value !== "object") {
      return value;
    }
    return JSON.parse(JSON.stringify(value));
  }
}
