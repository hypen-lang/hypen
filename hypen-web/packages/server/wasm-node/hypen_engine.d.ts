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
