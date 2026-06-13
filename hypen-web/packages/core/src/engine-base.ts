/**
 * Abstract base class for Hypen WASM engine wrappers.
 *
 * The Hypen engine is distributed as a wasm-bindgen module — two builds:
 *
 *   - `wasm-node`  (bundler target) — used by `@hypen-space/server` on Node/Bun
 *   - `wasm-browser` (web target)   — used by `@hypen-space/web-engine` in browsers
 *
 * Both builds expose an identical `WasmEngine` class; the only genuine
 * platform differences are:
 *
 *   1. How the WASM module is *instantiated*. Node can synchronously `new
 *      WasmEngine()` (the bundler target auto-initializes); the browser
 *      target needs an async dynamic import of the JS glue code and an
 *      explicit `wasm_init(url)` call before any `new WasmEngine()`.
 *
 *   2. How host state is *unwrapped* before it crosses the WASM boundary.
 *      Node can use `structuredClone` (with a `__getSnapshot` fast path for
 *      Hypen's proxy-backed state); the browser path does a
 *      `JSON.parse(JSON.stringify())` round-trip plus a Map-to-Object
 *      conversion for the native Map values that the wasm-bindgen browser
 *      target returns in action payloads.
 *
 * Everything else — method wrappers, error classification, callback wiring,
 * revision plumbing — is identical between the two. That shared surface
 * lives here.
 *
 * Subclasses implement two abstract hooks:
 *
 *   - `init(options?): Promise<void>` — platform-specific WASM setup. Must
 *     assign `this.wasmEngine` and set `this.initialized = true` on success.
 *
 *   - `unwrapForWasm<T>(value: T): T` — platform-specific proxy-to-plain
 *     conversion. Called before any value crosses into WASM.
 */

import { frameworkLoggers } from "./logger.js";
import { classifyEngineError } from "./result.js";
import type {
  Patch,
  Action,
  RenderCallback,
  ActionHandler,
  ComponentResolver,
} from "./types.js";

const log = frameworkLoggers.engine;

/**
 * Recursively convert wasm-bindgen `Map` values into plain objects.
 *
 * The web-target WASM returns action payloads (and nested values) as `Map`
 * instances; user handlers expect plain objects. Only plain objects
 * (`constructor === Object`), arrays, and Maps are descended into — class
 * instances, `Date`, etc. are passed through untouched.
 */
function mapToPlainObject(value: any): any {
  if (value instanceof Map) {
    const obj: Record<string, any> = {};
    for (const [key, val] of value.entries()) {
      obj[key] = mapToPlainObject(val);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(mapToPlainObject);
  }
  if (value && typeof value === "object" && value.constructor === Object) {
    const obj: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      obj[key] = mapToPlainObject(val);
    }
    return obj;
  }
  return value;
}

/**
 * Shared base wrapping a wasm-bindgen `WasmEngine`. `any` here is load-
 * bearing: the concrete type is `WasmEngine` from either the `wasm-node`
 * or `wasm-browser` build, and those are separate generated `.d.ts`
 * files that core cannot (and should not) depend on. Subclasses keep
 * their own typed reference if they want stricter checking locally.
 */
export abstract class BaseEngine {
  protected wasmEngine: any = null;
  protected initialized = false;

  /**
   * Component names the resolver was asked for and returned `null` on — i.e.
   * names that are neither a registered primitive (the engine checks those
   * first and never consults the resolver for them) nor resolvable to a
   * template. Each such name produces an opaque `Create` patch the renderer
   * drops. Tracked so a miss is warned about once and can be asserted on in
   * tests. See `getUnresolvedComponents`.
   */
  private unresolvedComponents = new Set<string>();

  /**
   * Initialize the WASM module. Platform-specific.
   *
   * Must assign `this.wasmEngine` and set `this.initialized = true`.
   * Idempotent: must early-return if already initialized.
   */
  abstract init(options?: unknown): Promise<void>;

  /**
   * Convert a host value (possibly a Proxy, possibly containing Maps,
   * possibly wrapped in Hypen's observable state) into a plain-object
   * form safe to pass across the WASM boundary.
   *
   * Called on every `updateState` / `updateStateSparse` / `renderInto`
   * / `setContext` / `registerModule` entry point.
   */
  protected abstract unwrapForWasm<T>(value: T): T;

  /**
   * Guard that throws if the engine hasn't been initialized.
   * Returns the underlying WASM engine for chained access.
   */
  protected ensureInitialized(): any {
    if (!this.wasmEngine) {
      throw new Error("Engine not initialized. Call init() first.");
    }
    return this.wasmEngine;
  }

  /**
   * Set the render callback that receives patches.
   */
  setRenderCallback(callback: RenderCallback): void {
    const engine = this.ensureInitialized();
    engine.setRenderCallback((patches: Patch[]) => {
      callback(patches);
    });
  }

  /**
   * Set the component resolver for dynamic component composition.
   *
   * The resolver is wrapped to detect "resolver misses": the engine only
   * consults the resolver for element types that are NOT registered
   * primitives, so a `null` return means the name resolves to nothing and
   * the engine will emit an opaque `Create` the renderer silently drops
   * (e.g. an anonymous component that never got registered). The first miss
   * for each unique name is logged with actionable guidance; every miss is
   * recorded for `getUnresolvedComponents()` / test assertions.
   */
  setComponentResolver(resolver: ComponentResolver): void {
    const engine = this.ensureInitialized();
    engine.setComponentResolver(
      (componentName: string, contextPath: string | null) => {
        const resolved = resolver(componentName, contextPath);
        if (resolved == null) {
          if (!this.unresolvedComponents.has(componentName)) {
            this.unresolvedComponents.add(componentName);
            log.warn(
              `Component "${componentName}" did not resolve: it is not a ` +
                `registered primitive and the component resolver returned null. ` +
                `The engine will emit an opaque Create for it and the renderer ` +
                `will drop it. Did you forget to register/.module(...) the ` +
                `component, or is its name misspelled in the template?`,
            );
          }
        }
        return resolved;
      },
    );
  }

  /**
   * Names the component resolver has been asked for and failed to resolve
   * this session (see `setComponentResolver`). Useful as a CI / smoke-test
   * assertion — an empty array means every referenced component resolved to
   * a primitive or a template.
   */
  getUnresolvedComponents(): string[] {
    return [...this.unresolvedComponents];
  }

  /**
   * Parse and render Hypen DSL source code.
   * @throws {ParseError} if the source fails to parse
   * @throws {RenderError} if rendering fails
   */
  renderSource(source: string): void {
    const engine = this.ensureInitialized();
    try {
      engine.renderSource(source);
    } catch (err) {
      throw classifyEngineError(err);
    }
  }

  /**
   * Render a lazy component (for lazy route loading).
   */
  renderLazyComponent(source: string): void {
    const engine = this.ensureInitialized();
    engine.renderLazyComponent(source);
  }

  /**
   * Render a component into a specific parent node (subtree rendering).
   * @throws {ParseError} if the source fails to parse
   * @throws {RenderError} if the parent node is not found or rendering fails
   */
  renderInto(
    source: string,
    parentNodeId: string,
    state: Record<string, any>,
  ): void {
    const engine = this.ensureInitialized();
    try {
      engine.renderInto(source, parentNodeId, this.unwrapForWasm(state));
    } catch (err) {
      throw classifyEngineError(err);
    }
  }

  /**
   * Apply a sparse state update.
   *
   * @param scope  Lowercase module name to target a named module registered
   *               via `registerModule`. Pass `null` (or empty string) to
   *               target the primary module set via `setModule`.
   * @param paths  Changed state paths (relative to the targeted module).
   * @param values Map of `path -> new value`.
   * @throws {StateError} if the state patch is invalid
   */
  updateStateSparse(
    scope: string | null,
    paths: string[],
    values: Record<string, any>,
  ): void {
    const engine = this.ensureInitialized();

    if (paths.length === 0) {
      return;
    }

    try {
      engine.updateStateSparse(scope ?? "", paths, this.unwrapForWasm(values));
    } catch (err) {
      throw classifyEngineError(err);
    }
    log.debug("State changed (sparse):", { scope, paths });
  }

  /**
   * Apply a full-state patch. See [updateStateSparse] for `scope` semantics.
   * Prefer the sparse form when only a few paths changed.
   */
  updateState(scope: string | null, statePatch: Record<string, any>): void {
    const engine = this.ensureInitialized();
    engine.updateState(scope ?? "", this.unwrapForWasm(statePatch));
  }

  /**
   * Dispatch an action.
   * @throws {HypenError} if the action dispatch fails
   */
  dispatchAction(name: string, payload?: any): void {
    const engine = this.ensureInitialized();
    try {
      engine.dispatchAction(name, payload ?? null);
    } catch (err) {
      throw classifyEngineError(err);
    }
  }

  /**
   * Register an action handler. Errors thrown synchronously or via rejected
   * promises are caught and logged at the framework level; caller-side error
   * recovery should happen inside `handler`.
   *
   * Action payloads may contain platform-specific native values (e.g. Maps
   * in the browser target). Subclasses can override `normalizeAction` to
   * pre-process the action before calling the user handler.
   */
  onAction(actionName: string, handler: ActionHandler): void {
    const engine = this.ensureInitialized();
    engine.onAction(actionName, (action: Action) => {
      const normalized = this.normalizeAction(action);
      Promise.resolve(handler(normalized)).catch((err) => {
        log.error("Action handler error:", err);
      });
    });
  }

  /**
   * Platform hook: normalize an incoming action before the user handler
   * sees it.
   *
   * The default converts any `Map` instances in the payload into plain
   * objects (deeply). This is the landmine the wasm-bindgen **web** target
   * sets: it returns structured action payloads as JS `Map`s, so a handler
   * reading `payload.to` gets `undefined` and `@router.push, to: "/x"`
   * silently no-ops. Every consumer of the web-target WASM — the browser
   * engine, a Cloudflare `CFEngine`, any future runtime — inherits the fix
   * here instead of rediscovering it.
   *
   * The wasm-bindgen **bundler** (node) target already returns plain
   * objects, so for it this is a harmless deep walk. Subclasses on that
   * target may override with an identity to skip the walk (see
   * `@hypen-space/server`).
   */
  protected normalizeAction(action: Action): Action {
    if (!action.payload) return action;
    return { ...action, payload: mapToPlainObject(action.payload) };
  }

  /**
   * Parse a Hypen DSL source and return every `Router { Route ... }`
   * block found in it. The SDK uses this to auto-wire a ManagedRouter
   * against the template without the user having to repeat the route
   * table in code.
   *
   * `moduleScope` is the enclosing `module X { ... }` scope (lowercased)
   * — `null` for the document root. `elementNames` is BFS-ordered so
   * the SDK can pick the first name that matches a registered
   * `HypenApp` module (wrappers like Column / Row come before the
   * real route component).
   */
  discoverRouters(source: string): Array<{
    moduleScope: string | null;
    routes: Array<{ path: string; elementNames: string[] }>;
  }> {
    const engine = this.ensureInitialized();
    const raw = (engine as any).discoverRouters?.(source);
    if (!raw) return [];
    // wasm-bindgen returns Maps; normalize to plain objects for
    // ergonomic downstream consumption. The nested structures were
    // encoded with serde_wasm_bindgen so plain objects is the right
    // post-decode shape for most consumers.
    const mapToObj = (v: unknown): any => {
      if (v instanceof Map) {
        const obj: Record<string, unknown> = {};
        for (const [k, val] of v.entries()) obj[String(k)] = mapToObj(val);
        return obj;
      }
      if (Array.isArray(v)) return v.map(mapToObj);
      if (v && typeof v === "object") {
        const obj: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v)) obj[k] = mapToObj(val);
        return obj;
      }
      return v;
    };
    const normalized = mapToObj(raw) as Array<{
      module_scope: string | null;
      moduleScope?: string | null;
      routes: Array<{
        path: string;
        element_names?: string[];
        elementNames?: string[];
      }>;
    }>;
    return normalized.map((r) => ({
      moduleScope: r.moduleScope ?? r.module_scope ?? null,
      routes: r.routes.map((route) => ({
        path: route.path,
        elementNames: route.elementNames ?? route.element_names ?? [],
      })),
    }));
  }

  /**
   * Initialize the primary module.
   */
  setModule(
    name: string,
    actions: string[],
    stateKeys: string[],
    initialState: Record<string, any>,
  ): void {
    const engine = this.ensureInitialized();
    engine.setModule(name, actions, stateKeys, initialState);
  }

  /**
   * Register a named module for multi-module apps.
   *
   * Unlike setModule which sets the primary module, this registers an
   * additional module whose state is scoped to `module <name> { ... }`
   * blocks in the DSL.
   */
  registerModule(
    name: string,
    actions: string[],
    stateKeys: string[],
    initialState: Record<string, any>,
  ): void {
    const engine = this.ensureInitialized();
    engine.registerModule(
      name,
      actions,
      stateKeys,
      this.unwrapForWasm(initialState),
    );
  }

  /**
   * Get the current revision number.
   *
   * Note: the underlying WASM builder returns `bigint` in some targets
   * and `number` in others; this normalizes to `number` for consumer
   * ergonomics (revision counts don't exceed 2^53).
   */
  getRevision(): number {
    const engine = this.ensureInitialized();
    return Number(engine.getRevision());
  }

  /**
   * Clear resolved components and caches, preserving primitives and resolver.
   * Call before renderSource() during hot-reload so components are re-resolved
   * from fresh source files.
   */
  clearResolvedComponents(): void {
    const engine = this.ensureInitialized();
    engine.clearResolvedComponents();
  }

  /**
   * Clear the engine tree.
   */
  clearTree(): void {
    const engine = this.ensureInitialized();
    engine.clearTree();
  }

  /**
   * Full reset: clears tree, module, component registry, dependencies,
   * and revision. Render callback and component resolver are preserved.
   */
  reset(): void {
    const engine = this.ensureInitialized();
    engine.reset();
  }

  /**
   * Debug method to inspect parsed components.
   */
  debugParseComponent(source: string): string {
    const engine = this.ensureInitialized();
    return engine.debugParseComponent(source);
  }

  // ── Data Source Context ────────────────────────────────────────

  /**
   * Set (or replace) a named data source context.
   *
   * Registers the provider in the dependency graph, stores the data,
   * and re-renders every node bound to `$name.*`.
   *
   * @param name - Provider name (e.g., "spacetime", "firebase")
   * @param data - Full state object for this provider
   */
  setContext(name: string, data: Record<string, unknown>): void {
    const engine = this.ensureInitialized();
    try {
      engine.setContext(name, this.unwrapForWasm(data));
    } catch (err) {
      throw classifyEngineError(err);
    }
    log.debug(`Data source "${name}" context set`);
  }

  /**
   * Remove a data source context entirely.
   * Drops the provider's state and re-renders bound nodes (they resolve to null).
   */
  removeContext(name: string): void {
    const engine = this.ensureInitialized();
    engine.removeContext(name);
  }

  // ── Resource System ─────────────────────────────────────────────────

  /**
   * Register resources (name → raw SVG string) with the engine.
   *
   * Each SVG is parsed by the WASM engine. When the engine encounters
   * `Icon(@resources.heart)` in the DSL, it resolves the name from registered
   * resources and injects SVG path data into the Create patch props.
   *
   * @param map - Flat map of resource name to raw SVG string
   */
  registerResources(map: Record<string, string>): void {
    const engine = this.ensureInitialized();
    engine.registerResources(map);
    log.debug(`Resources registered (${Object.keys(map).length} entries)`);
  }
}
