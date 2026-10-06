/**
 * Node.js / Bundler target wrapper around the WASM engine.
 *
 * Thin subclass of `BaseEngine` from `@hypen-space/core/engine-base`.
 * All method wrappers live in the base; this file only provides:
 *
 *   - Static import of the `wasm-node` build's `WasmEngine`
 *   - Synchronous `init()` (the bundler target auto-initializes the WASM
 *     module at import time, so construction alone is enough)
 *   - `unwrapForWasm` using `structuredClone` with a `__getSnapshot`
 *     fast path for Hypen's proxy-backed state
 */

// WASM module types
import { WasmEngine } from "../wasm-node/hypen_engine.js";
import { BaseEngine } from "@hypen-space/core/engine-base";
import type { Action } from "@hypen-space/core/types";
import type { A11yDiagnostic } from "@hypen-space/core";

// Side-effect import: installs the engine-backed PortableImpl into
// `@hypen-space/core` as soon as the server package is loaded. After
// this line, `createObservableState`, `HypenRouter.matchPath`, and
// friends all route through the Rust engine's canonical helpers.
import "./install-portable.js";

// Re-export types so existing consumers of "./engine.js" still work
export type {
  Patch,
  Action,
  RenderCallback,
  ActionHandler,
  ResolvedComponent,
  ComponentResolver,
  // External capability surface — `listActions` / `listRoutes` /
  // `listBindings` / `dispatchExternal` / `getStateAt` /
  // `unregisterModule` are inherited from `BaseEngine`, so a Node host
  // reaches the guarded surface through this `Engine` with no extra wiring.
  AgentAction,
  AgentRoute,
  BoundInput,
} from "@hypen-space/core/types";

/**
 * Engine wraps the WASM engine (Node/bundler target) and provides a
 * TypeScript-friendly API.
 */
export class Engine extends BaseEngine {
  /**
   * Initialize the WASM module.
   *
   * For the bundler target, the wasm-bindgen module auto-initializes at
   * import time — the only thing left to do is construct the `WasmEngine`
   * and register default primitives. `options` is accepted for base-class
   * signature compatibility but ignored.
   */
  async init(_options?: unknown): Promise<void> {
    if (this.initialized) return;

    this.wasmEngine = new WasmEngine();
    this.wasmEngine.registerDefaultPrimitives();
    this.initialized = true;
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
   * Unwrap proxy objects to plain values for WASM serialization.
   *
   * Uses `structuredClone` when available (Node 17+, Bun), falls back to
   * `JSON.parse(JSON.stringify())` for proxy objects or older environments.
   * Hypen's observable state exposes a `__getSnapshot` method which is the
   * fastest path — take it first.
   */
  protected unwrapForWasm<T>(value: T): T {
    // Fast path: primitives don't need cloning
    if (value === null || typeof value !== "object") {
      return value;
    }

    // Check if the object has a snapshot method (our proxy convention)
    if (typeof (value as any).__getSnapshot === "function") {
      return (value as any).__getSnapshot() as T;
    }

    // Try structuredClone first (fastest for plain objects)
    try {
      return structuredClone(value);
    } catch {
      // Fallback for proxy objects or unsupported types
      return JSON.parse(JSON.stringify(value));
    }
  }

  /**
   * The bundler (node) target already returns plain-object action payloads,
   * so we skip `BaseEngine`'s default `Map`-to-object walk (that walk only
   * matters for the web target). Identity keeps node dispatch allocation-free.
   */
  protected override normalizeAction(action: Action): Action {
    return action;
  }
}
