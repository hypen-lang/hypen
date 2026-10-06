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
 *      Node uses `structuredClone` (with a `__getSnapshot` fast path for
 *      Hypen's proxy-backed state); the browser path uses the
 *      copy-on-write [`normalizeForWasm`] walk defined below, plus a
 *      Map-to-Object conversion for the native Map values that the
 *      wasm-bindgen browser target returns in action payloads.
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
import { unwrapProxy } from "./state.js";
import type {
  Patch,
  Action,
  AgentAction,
  AgentRoute,
  BoundInput,
  RenderCallback,
  ActionHandler,
  ComponentResolver,
} from "./types.js";
import { ACTION_ANIMATE_KEY } from "./types.js";

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
 * Copy-on-write JSON normalization for values crossing into WASM.
 *
 * The wasm-bindgen entry points deserialize every `JsValue` argument
 * synchronously (`serde_wasm_bindgen::from_value`) and retain no JS
 * reference afterwards, so a defensive deep clone buys nothing. What the
 * boundary does require is:
 *
 *   - no Hypen state proxies (their `get` traps allocate nested proxies
 *     mid-serialization), and
 *   - JSON-shaped data, matching the "engine sees state as JSON"
 *     contract the old `JSON.parse(JSON.stringify())` round-trip
 *     enforced: `toJSON` honoured (Date → ISO string), `undefined` /
 *     functions dropped from objects and nulled in arrays, non-finite
 *     numbers → null, and non-plain objects (Map, Set, class instances)
 *     reduced to their own enumerable properties.
 *
 * Subtrees already in normal form are returned by reference, so the hot
 * sparse-update path — values just parsed out of the engine's own diff
 * output — costs one read-only traversal and zero allocation instead of
 * a full serialize/parse of the changed values on every mutation flush.
 *
 * Throws `TypeError` on circular structures and BigInt, as
 * `JSON.stringify` does.
 */
export function normalizeForWasm(value: unknown): unknown {
  return normalize(value, null, 0);
}

/**
 * Depth at which cycle tracking starts. A circular structure recurses
 * without bound, so it is guaranteed to cross this depth and get caught;
 * tracking only from here on keeps the common shallow path free of
 * WeakSet bookkeeping (state trees deeper than this are pathological).
 */
const CYCLE_CHECK_DEPTH = 64;

function normalize(
  value: any,
  ancestors: WeakSet<object> | null,
  depth: number,
): any {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "object":
      break;
    default:
      // undefined / function / symbol: not representable in JSON. The
      // containing object drops the key; the containing array stores null.
      return undefined;
  }
  if (value === null) return null;

  const raw = unwrapProxy(value);
  if (typeof raw.toJSON === "function") {
    return normalize(raw.toJSON(), ancestors, depth);
  }
  if (depth < CYCLE_CHECK_DEPTH) {
    return Array.isArray(raw)
      ? normalizeArray(raw, ancestors, depth)
      : normalizeObject(raw, ancestors, depth);
  }
  if (ancestors === null) ancestors = new WeakSet();
  else if (ancestors.has(raw)) {
    throw new TypeError("Converting circular structure to JSON");
  }
  ancestors.add(raw);
  try {
    return Array.isArray(raw)
      ? normalizeArray(raw, ancestors, depth)
      : normalizeObject(raw, ancestors, depth);
  } finally {
    ancestors.delete(raw);
  }
}

function normalizeArray(
  raw: any[],
  ancestors: WeakSet<object> | null,
  depth: number,
): any[] {
  let out: any[] | null = null;
  for (let i = 0; i < raw.length; i++) {
    const child = raw[i];
    let normalized = normalize(child, ancestors, depth + 1);
    if (normalized === undefined) normalized = null;
    if (out !== null) {
      out.push(normalized);
    } else if (normalized !== child) {
      out = raw.slice(0, i);
      out.push(normalized);
    }
  }
  return out ?? raw;
}

function normalizeObject(
  raw: any,
  ancestors: WeakSet<object> | null,
  depth: number,
): Record<string, any> {
  const keys = Object.keys(raw);

  // A non-plain object (Map, Set, RegExp, class instance) reduces to its
  // own enumerable properties — its JSON form — and must always be copied
  // into a plain object: handed over as-is, serde would see the exotic
  // type itself (e.g. a Map's entries) where JSON semantics say only the
  // own properties exist.
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    const out: Record<string, any> = {};
    for (const key of keys) {
      const normalized = normalize(raw[key], ancestors, depth + 1);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }

  let out: Record<string, any> | null = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const child = raw[key];
    const normalized = normalize(child, ancestors, depth + 1);
    if (out !== null) {
      if (normalized !== undefined) out[key] = normalized;
    } else if (normalized !== child || normalized === undefined) {
      out = {};
      for (let j = 0; j < i; j++) out[keys[j]!] = raw[keys[j]!];
      if (normalized !== undefined) out[key] = normalized;
    }
  }
  return out ?? raw;
}

/**
 * Accept either wire spelling of the agent structs multi-word fields.
 *
 * The engine now emits camelCase, so on a current artifact this is a
 * no-op. It stays because the structs shipped briefly without
 * `#[serde(rename_all = "camelCase")]`, and a host pinned to such an
 * artifact would otherwise read `undefined` from a scoped binding with no
 * error at all — the same tolerance `discoverRouters` keeps, for the same
 * reason.
 */
function camelizeAgentKeys<T>(value: unknown): T {
  const row = mapToPlainObject(value) as Record<string, unknown>;
  if (!row || typeof row !== "object") return row as T;
  const { module_scope, element_type, ...rest } = row;
  const out: Record<string, unknown> = { ...rest };
  if (module_scope !== undefined && out.moduleScope === undefined) {
    out.moduleScope = module_scope;
  }
  if (element_type !== undefined && out.elementType === undefined) {
    out.elementType = element_type;
  }
  return out as T;
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
   *
   * The WASM engine hands the batch over as a single JSON string (one
   * boundary crossing + native `JSON.parse`, instead of a per-field
   * `TextDecoder` pass while materializing thousands of JS objects).
   * Parse it here so every consumer keeps receiving a `Patch[]`. An
   * array payload (older engine artifacts) passes through unchanged.
   */
  setRenderCallback(callback: RenderCallback): void {
    const engine = this.ensureInitialized();
    engine.setRenderCallback((patches: Patch[] | string) => {
      callback(typeof patches === "string" ? JSON.parse(patches) : patches);
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
   * @param animation Optional transaction-scoped animation context (Option D
   *               cheap subset): a spec object (`{ curve, duration?, ... }`)
   *               or a bare curve token string — the engine normalizes
   *               either. When the update dirties nodes, the resulting patch
   *               batch is stamped with a leading `batchAnimation` patch
   *               carrying the normalized spec. Omitted/null = unstamped.
   * @throws {StateError} if the state patch is invalid
   */
  updateStateSparse(
    scope: string | null,
    paths: string[],
    values: Record<string, any>,
    animation?: unknown,
  ): void {
    const engine = this.ensureInitialized();

    if (paths.length === 0) {
      return;
    }

    try {
      engine.updateStateSparse(
        scope ?? "",
        paths,
        this.unwrapForWasm(values),
        animation == null ? null : this.unwrapForWasm(animation),
      );
    } catch (err) {
      throw classifyEngineError(err);
    }
    log.debug("State changed (sparse):", { scope, paths });
  }

  /**
   * Apply a full-state patch. See [updateStateSparse] for `scope` and
   * `animation` semantics. Prefer the sparse form when only a few paths
   * changed.
   */
  updateState(
    scope: string | null,
    statePatch: Record<string, any>,
    animation?: unknown,
  ): void {
    if (scope !== null && typeof scope !== "string") {
      // Legacy single-arg callers pass the state object as `scope`; letting it
      // through corrupts WASM memory instead of failing (out-of-bounds in
      // passStringToWasm0, hard tab crash in Chromium).
      throw new TypeError(
        "updateState(scope, statePatch): scope must be a string or null. " +
          "The single-argument updateState(state) form was removed — pass null as the first argument.",
      );
    }
    const engine = this.ensureInitialized();
    engine.updateState(
      scope ?? "",
      this.unwrapForWasm(statePatch),
      animation == null ? null : this.unwrapForWasm(animation),
    );
  }

  /**
   * Dispatch an action.
   * @throws {HypenError} if the action dispatch fails
   */
  /** Resolve live UI identity once before broadcasting to another engine. */
  resolveUIAction(name: string, payload?: unknown): { name: string; payload?: unknown } {
    const engine = this.ensureInitialized();
    if (typeof engine.resolveUIAction !== "function") throw new Error("Scoped UI actions require a rebuilt Hypen engine");
    return mapToPlainObject(engine.resolveUIAction(name, payload ?? null));
  }

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
      const normalized = this.extractAnimate(this.normalizeAction(action));
      Promise.resolve(handler(normalized)).catch((err) => {
        log.error("Action handler error:", err);
      });
    });
  }

  /**
   * Lift a transaction-animation stamp out of the payload (Option D cheap
   * subset). Renderers carry the event applicator's `animate:` argument
   * across the WASM dispatch boundary under the reserved
   * {@link ACTION_ANIMATE_KEY} payload key (the only channel through
   * `dispatchAction(name, payload)`); here it becomes the distinct
   * `Action.animate` field and is REMOVED from the payload, so module
   * handlers never observe the reserved key. Runs after `normalizeAction`,
   * so the payload is already a plain object on every target.
   */
  private extractAnimate(action: Action): Action {
    const payload = action.payload;
    if (
      !payload ||
      typeof payload !== "object" ||
      !(ACTION_ANIMATE_KEY in payload)
    ) {
      return action;
    }
    const { [ACTION_ANIMATE_KEY]: animate, ...rest } = payload as Record<
      string,
      unknown
    >;
    return { ...action, payload: rest, animate };
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

  // ── External capability surface ──────────────────────────────────────
  //
  // For callers that are NOT the rendered UI: MCP servers, REST APIs,
  // CLIs, agents. `dispatchAction` reaches every registered handler —
  // including `__hypen_bind`, which writes an arbitrary state path — so
  // external callers get these guarded entry points instead. The guard is
  // the engine's (`hypen-engine-rs/src/agent.rs`), shared by every SDK
  // through `agent_core`; these wrappers only marshal, never decide.
  //
  // Each read tolerates a WASM artifact predating the binding by reporting
  // an empty surface — the fail-closed direction, and the same tolerance
  // `discoverRouters` / `checkAccessibility` already have. `dispatchExternal`
  // throws instead of falling back to `dispatchAction`: falling back would
  // route an unauthorized name straight past the guard.

  /**
   * Every action an external caller may dispatch right now, as
   * `[{ name, module, builtin }]`.
   *
   * Module-declared actions plus the `hypen.navigate` / `hypen.back` /
   * `hypen.set_input` built-ins, the last three only when the app declares
   * the backing `Router` or `.bind()`. Framework internals never appear.
   */
  listActions(): AgentAction[] {
    const engine = this.ensureInitialized();
    const raw = engine.listActions?.();
    if (!raw) return [];
    return (raw as unknown[]).map((a) => camelizeAgentKeys<AgentAction>(a));
  }

  /**
   * The MCP handshake for this app, composed by the engine.
   *
   * Returned as the engine hands it over — `McpManifest`'s serde encoding,
   * already camelCase with `_meta` verbatim — because every transport is
   * meant to forward it byte-for-byte rather than paraphrase it. `null`
   * when the WASM artifact predates the manifest, so a host can degrade
   * loudly instead of publishing an empty tool list.
   */
  mcpManifest(): unknown | null {
    const engine = this.ensureInitialized();
    return engine.mcpManifest?.() ?? null;
  }

  /**
   * The app's declared routes, in declaration order — the argument schema
   * behind `hypen.navigate`.
   *
   * Read from the declared route table rather than the rendered route, so
   * every route lists even though only one can be on screen.
   */
  listRoutes(): AgentRoute[] {
    const engine = this.ensureInitialized();
    const raw = engine.listRoutes?.();
    if (!raw) return [];
    return (raw as unknown[]).map((r) => camelizeAgentKeys<AgentRoute>(r));
  }

  /**
   * Every `.bind()`-declared writable input — the argument schema behind
   * `hypen.set_input`. `prop` is `checked` / `on` for boolean controls.
   */
  listBindings(): BoundInput[] {
    const engine = this.ensureInitialized();
    const raw = engine.listBindings?.();
    if (!raw) return [];
    return (raw as unknown[]).map((b) => camelizeAgentKeys<BoundInput>(b));
  }

  /**
   * Dispatch on behalf of a caller that is not the rendered UI.
   *
   * Authorises against exactly what `listActions` advertises, then routes
   * through the same handler path a UI dispatch would take.
   *
   * @throws {HypenError} when the name is not externally dispatchable,
   * when a built-in is used in an app that does not declare the backing
   * `Router` / `.bind()`, or when `hypen.set_input` names an undeclared
   * field.
   */
  dispatchExternal(name: string, payload?: unknown): void {
    const engine = this.ensureInitialized();
    if (typeof engine.dispatchExternal !== "function") {
      throw new Error(
        "dispatchExternal is not available in this WASM build. Rebuild the " +
          "engine (`bun run build:wasm`) — falling back to dispatchAction " +
          "would bypass the external capability guard.",
      );
    }
    try {
      engine.dispatchExternal(
        name,
        payload == null ? null : this.unwrapForWasm(payload),
      );
    } catch (err) {
      throw classifyEngineError(err);
    }
  }

  /**
   * Read module state, whole or at a path.
   *
   * @param module Lowercase name of a module registered via
   *               `registerModule` (matched case-insensitively), or `null`
   *               for the primary module set via `setModule`.
   * @param path   Dotted state path, or `null` for the whole state object.
   *
   * Returns `undefined` when the module is unknown or the path is absent —
   * the engine deliberately does not distinguish the two, so a caller
   * cannot probe for state it is not being shown.
   */
  getStateAt(module: string | null, path: string | null): unknown {
    const engine = this.ensureInitialized();
    const state = engine.getStateAt?.(module ?? undefined, path ?? undefined);
    return state == null ? undefined : mapToPlainObject(state);
  }

  /**
   * Drop a module and every action it declared, so a destroyed module's
   * actions stop being externally reachable.
   *
   * **Call on destroy only, never on unmount.** Under `ManagedRouter`'s
   * default `persist: true` an off-screen module stays registered on
   * purpose, so siblings can still read its state; unregistering it there
   * would break the persist cache and cross-module reads. The three
   * correct call sites are `ManagedRouter`'s destroy paths — full `stop()`,
   * `persist: false` unmount, and LRU eviction.
   */
  unregisterModule(name: string): void {
    const engine = this.ensureInitialized();
    if (typeof engine.unregisterModule !== "function") {
      // Fails open: the destroyed module's actions stay externally
      // dispatchable until the WASM artifact is rebuilt. Loud, because
      // that is a capability leak rather than a missing convenience.
      log.warn(
        `unregisterModule("${name}") is not available in this WASM build — ` +
          `the module's actions remain externally dispatchable. ` +
          `Rebuild the engine with \`bun run build:wasm\`.`,
      );
      return;
    }
    engine.unregisterModule(name);
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
