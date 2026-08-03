/* tslint:disable */
/* eslint-disable */

/**
 * The main Hypen engine interface for JavaScript/WASM runtimes.
 *
 * `WasmEngine` manages the full lifecycle of a Hypen UI: parsing DSL source,
 * maintaining the virtual tree, tracking reactive dependencies, and emitting
 * minimal patches when state changes. It runs in a single-threaded WASM
 * environment (browsers, Node.js, Bun, Deno).
 *
 * # Quick Start
 *
 * ```js
 * import { WasmEngine } from "@hypen-space/core";
 *
 * const engine = new WasmEngine();
 *
 * // 1. Register primitives so the engine doesn't try to resolve them as components
 * engine.registerPrimitive("Text");
 * engine.registerPrimitive("Column");
 *
 * // 2. Receive patches via callback
 * engine.setRenderCallback((patches) => {
 *     for (const patch of patches) {
 *         applyPatch(patch); // Create, SetProp, Insert, Remove, etc.
 *     }
 * });
 *
 * // 3. Optionally set up a module for stateful UI
 * engine.setModule("Counter", ["increment"], ["count"], { count: 0 });
 *
 * // 4. Render DSL source — patches are emitted via the callback
 * engine.renderSource('Column { Text("Count: @{state.count}") }');
 *
 * // 5. Update state — only affected nodes are re-rendered
 * engine.updateState({ count: 1 });
 * ```
 *
 * # Patch Protocol
 *
 * All UI mutations are expressed as [`Patch`] values emitted through the render
 * callback. Patches use camelCase field names for direct JavaScript consumption.
 * See [`Patch`] for the full variant list and field documentation.
 *
 * # Component Resolution
 *
 * Custom components (anything not registered as a primitive) are resolved lazily
 * via the component resolver callback set with [`set_component_resolver`]. The
 * resolver receives `(componentName, contextPath)` and should return
 * `{ source: string, path: string }` or `null`.
 *
 * # Revision Tracking
 *
 * Every render cycle (initial render or state update that produces patches)
 * increments the revision counter. Use [`get_revision`] to detect stale state
 * in async workflows.
 */
export class WasmEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Kebab-case ids of every accessibility rule this engine build's
     * conformance pass checks (from `ir::conformance::ALL_RULES`, so the
     * list cannot drift from the `A11yRule` enum). Hosts compare it against
     * the rule set they were built to expect: a prebuilt WASM that predates
     * a rule still exposes `checkAccessibility` and looks current while
     * silently never firing the newer rule.
     */
    a11yRules(): string[];
    /**
     * Run the dev-mode accessibility conformance pass over a DSL source and
     * return any findings as
     * `[{ rule, elementType, message, span?, line?, col?, suppressed? }]`.
     * Hosts wire this into a dev console / editor diagnostics; an empty
     * array means nothing actionable was found. Flags only un-derivable
     * gaps (icon-only controls, missing alt, unleveled headings, nested
     * interactives). `suppressed: true` marks findings matched by an inline
     * `// hypen-a11y-ignore` directive (resolved by `locate_diagnostics`) —
     * hosts count and report them but must not fail on or squiggle them.
     *
     * `span` is the offending element name token's byte range in `source`;
     * `line`/`col` are its resolved position (1-based; `col` counts Unicode
     * codepoints — the human/CLI convention). Resolution happens here, at
     * the binding, so every host shares one byte→column rule. LSP-style
     * consumers needing 0-based UTF-16 positions should resolve `span`
     * themselves.
     */
    checkAccessibility(source: string): any;
    /**
     * Clear resolved components and caches, preserving primitives and resolver.
     */
    clearResolvedComponents(): void;
    /**
     * Remove all nodes from the instance tree without emitting Remove patches.
     */
    clearTree(): void;
    /**
     * Return a JSON snapshot of the active module's current state.
     */
    currentState(): any;
    /**
     * Parse a component and return a human-readable debug string.
     */
    debugParseComponent(source: string): string;
    /**
     * Parse a DSL source and return every `Router { Route ... }` block
     * it contains, for SDKs that want to auto-wire a ManagedRouter
     * against the template without making the user repeat the route
     * table. Returns `[{ moduleScope, routes: [{ path, elementNames }] }]`
     * — `elementNames` is BFS-ordered so the SDK can pick the first
     * name that matches a registered module.
     */
    discoverRouters(source: string): any;
    /**
     * Dispatch a named action, invoking the registered handler (if any).
     */
    dispatchAction(name: string, payload: any): void;
    /**
     * Get the current revision number.
     */
    getRevision(): bigint;
    /**
     * Create a new engine instance with an empty tree and no module.
     *
     * After construction, you typically:
     * 1. Register primitives with [`register_primitive`]
     * 2. Set a render callback with [`set_render_callback`]
     * 3. Optionally set a component resolver with [`set_component_resolver`]
     * 4. Optionally initialize a module with [`set_module`]
     * 5. Render source with [`render_source`]
     */
    constructor();
    /**
     * Register a JavaScript function as the handler for a named action.
     */
    onAction(action_name: string, handler: Function): void;
    /**
     * Register a handler for data source actions.
     */
    onDataSourceAction(handler: Function): void;
    /**
     * Register all standard Hypen primitives (Text, Column, Row, Button, etc.)
     */
    registerDefaultPrimitives(): void;
    /**
     * Register a named module for multi-module apps.
     */
    registerModule(name: string, actions: string[], state_keys: string[], initial_state: any): void;
    /**
     * Register a primitive element (like Text, Button, etc.) to skip component resolution
     */
    registerPrimitive(name: string): void;
    /**
     * Register resources from a JavaScript object (name -> SVG string map).
     */
    registerResources(resources_js: any): void;
    /**
     * Remove a data source context entirely.
     */
    removeContext(name: string): void;
    /**
     * Render a component into a specific parent node (subtree rendering)
     */
    renderInto(source: string, parent_node_id_str: string, state_js: any): void;
    /**
     * Render a component source on-demand (for lazy-loaded routes).
     */
    renderLazyComponent(source: string): void;
    /**
     * Parse and render Hypen DSL source code, emitting patches via the render callback.
     *
     * Supports full document syntax including `import` statements. Imports are
     * resolved synchronously through the component resolver callback (if set).
     *
     * This performs a **full reconciliation** -- the existing tree is diffed against
     * the new IR and minimal patches are emitted. Calling this multiple times with
     * different source replaces the previous UI.
     *
     * # Errors
     *
     * Returns a `JsValue` string error if the source fails to parse.
     */
    renderSource(source: string): void;
    /**
     * Fully reset the engine to its initial empty state.
     */
    reset(): void;
    /**
     * Set the component resolver callback
     */
    setComponentResolver(resolver: Function): void;
    /**
     * Set (or replace) a named data source context.
     */
    setContext(name: string, data_js: any): void;
    /**
     * Initialize (or replace) the active module with the given configuration.
     */
    setModule(name: string, actions: string[], state_keys: string[], initial_state: any): void;
    /**
     * Set the callback that receives UI patches after each render cycle.
     */
    setRenderCallback(callback: Function): void;
    /**
     * Return the total number of nodes currently in the instance tree.
     */
    treeSize(): number;
    /**
     * Apply a state patch and re-render affected nodes.
     *
     * `scope` selects the target module:
     * - empty string / null / undefined → primary module set via [`set_module`](Self::set_module)
     * - any other string → named module registered via [`register_module`] (lowercased)
     */
    updateState(scope: string | null | undefined, state_patch: any): void;
    /**
     * Apply a sparse state update using explicit path-value pairs.
     * See [`update_state`] for `scope` semantics.
     */
    updateStateSparse(scope: string | null | undefined, paths_js: any, values_js: any): void;
    /**
     * Validate that the engine is in a consistent state.
     */
    validate(): any;
}

/**
 * Build a URL from path + JSON object of query params.
 */
export function buildUrl(path: string, query_json: string): string;

/**
 * Decode a percent-encoded string (`+` → space).
 */
export function decodeUriComponent(input: string): string;

/**
 * JSON-in, JSON-out: returns `[{"path": "...", "value": <any>}, ...]`.
 *
 * See [`crate::portable::diff_paths`] for semantics.
 */
export function diffPaths(old_json: string, new_json: string): string;

/**
 * Percent-encode a string for URL query components.
 */
export function encodeUriComponent(input: string): string;

export function main(): void;

/**
 * Match a URL pattern against a path. Returns JSON
 * `{"matched": bool, "params": {"id": "42"}}`.
 *
 * See [`crate::portable::match_path`] for semantics.
 */
export function matchPath(pattern: string, path: string): string;

/**
 * Split `/path?k=v` into `{"path": "...", "query": {...}}`.
 */
export function parseQuery(full_path: string): string;

/**
 * Parse Hypen DSL source and return the AST as a pretty-printed JSON string.
 */
export function parseToJson(source: string): string;

/**
 * Serialize a patches array to a pretty-printed JSON string.
 */
export function patchesToJson(patches: any): string;

/**
 * Delete whatever lives at `path`; returns JSON
 * `{"json": <updated>, "removed": bool}`.
 */
export function pathDelete(value_json: string, path: string): string;

/**
 * Read the JSON value at a dotted path. Returns `"null"` if the
 * path doesn't resolve.
 */
export function pathGet(value_json: string, path: string): string;

/**
 * Test whether `path` resolves inside `value_json`. Returns a JSON
 * boolean (`"true"` / `"false"`).
 */
export function pathHas(value_json: string, path: string): string;

/**
 * Set `new_value_json` at `path` inside `value_json`; returns the
 * updated JSON string.
 */
export function pathSet(value_json: string, path: string, new_value_json: string): string;

/**
 * Advance the session state machine by one event.
 *
 * `state_json` and `event_json` must deserialise to
 * [`crate::portable::SessionState`] / [`crate::portable::SessionEvent`].
 * Returns the serialised [`crate::portable::SessionEffect`].
 */
export function sessionStep(state_json: string, event_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmengine_free: (a: number, b: number) => void;
    readonly buildUrl: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly decodeUriComponent: (a: number, b: number) => [number, number];
    readonly diffPaths: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encodeUriComponent: (a: number, b: number) => [number, number];
    readonly main: () => void;
    readonly matchPath: (a: number, b: number, c: number, d: number) => [number, number];
    readonly parseQuery: (a: number, b: number) => [number, number];
    readonly parseToJson: (a: number, b: number) => [number, number, number, number];
    readonly patchesToJson: (a: any) => [number, number, number, number];
    readonly pathDelete: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly pathGet: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly pathHas: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly pathSet: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly sessionStep: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasmengine_a11yRules: (a: number) => [number, number];
    readonly wasmengine_checkAccessibility: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmengine_clearResolvedComponents: (a: number) => void;
    readonly wasmengine_clearTree: (a: number) => void;
    readonly wasmengine_currentState: (a: number) => any;
    readonly wasmengine_debugParseComponent: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmengine_discoverRouters: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmengine_dispatchAction: (a: number, b: number, c: number, d: any) => [number, number];
    readonly wasmengine_getRevision: (a: number) => bigint;
    readonly wasmengine_new: () => number;
    readonly wasmengine_onAction: (a: number, b: number, c: number, d: any) => void;
    readonly wasmengine_onDataSourceAction: (a: number, b: any) => void;
    readonly wasmengine_registerDefaultPrimitives: (a: number) => void;
    readonly wasmengine_registerModule: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: any) => [number, number];
    readonly wasmengine_registerPrimitive: (a: number, b: number, c: number) => void;
    readonly wasmengine_registerResources: (a: number, b: any) => [number, number];
    readonly wasmengine_removeContext: (a: number, b: number, c: number) => void;
    readonly wasmengine_renderInto: (a: number, b: number, c: number, d: number, e: number, f: any) => [number, number];
    readonly wasmengine_renderLazyComponent: (a: number, b: number, c: number) => [number, number];
    readonly wasmengine_reset: (a: number) => void;
    readonly wasmengine_setComponentResolver: (a: number, b: any) => void;
    readonly wasmengine_setContext: (a: number, b: number, c: number, d: any) => [number, number];
    readonly wasmengine_setModule: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: any) => [number, number];
    readonly wasmengine_setRenderCallback: (a: number, b: any) => void;
    readonly wasmengine_treeSize: (a: number) => number;
    readonly wasmengine_updateState: (a: number, b: number, c: number, d: any) => [number, number];
    readonly wasmengine_updateStateSparse: (a: number, b: number, c: number, d: any, e: any) => [number, number];
    readonly wasmengine_validate: (a: number) => any;
    readonly wasmengine_renderSource: (a: number, b: number, c: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
