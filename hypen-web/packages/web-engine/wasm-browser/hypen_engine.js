/* @ts-self-types="./hypen_engine.d.ts" */

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
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmEngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmengine_free(ptr, 0);
    }
    /**
     * Kebab-case ids of every accessibility rule this engine build's
     * conformance pass checks (from `ir::conformance::ALL_RULES`, so the
     * list cannot drift from the `A11yRule` enum). Hosts compare it against
     * the rule set they were built to expect: a prebuilt WASM that predates
     * a rule still exposes `checkAccessibility` and looks current while
     * silently never firing the newer rule.
     * @returns {string[]}
     */
    a11yRules() {
        const ret = wasm.wasmengine_a11yRules(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
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
     * @param {string} source
     * @returns {any}
     */
    checkAccessibility(source) {
        const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_checkAccessibility(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Clear resolved components and caches, preserving primitives and resolver.
     */
    clearResolvedComponents() {
        wasm.wasmengine_clearResolvedComponents(this.__wbg_ptr);
    }
    /**
     * Remove all nodes from the instance tree without emitting Remove patches.
     */
    clearTree() {
        wasm.wasmengine_clearTree(this.__wbg_ptr);
    }
    /**
     * Return a JSON snapshot of the active module's current state.
     * @returns {any}
     */
    currentState() {
        const ret = wasm.wasmengine_currentState(this.__wbg_ptr);
        return ret;
    }
    /**
     * Parse a component and return a human-readable debug string.
     * @param {string} source
     * @returns {string}
     */
    debugParseComponent(source) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmengine_debugParseComponent(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Parse a DSL source and return every `Router { Route ... }` block
     * it contains, for SDKs that want to auto-wire a ManagedRouter
     * against the template without making the user repeat the route
     * table. Returns `[{ moduleScope, routes: [{ path, elementNames }] }]`
     * — `elementNames` is BFS-ordered so the SDK can pick the first
     * name that matches a registered module.
     * @param {string} source
     * @returns {any}
     */
    discoverRouters(source) {
        const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_discoverRouters(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Dispatch a named action, invoking the registered handler (if any).
     * @param {string} name
     * @param {any} payload
     */
    dispatchAction(name, payload) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_dispatchAction(this.__wbg_ptr, ptr0, len0, payload);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Get the current revision number.
     * @returns {bigint}
     */
    getRevision() {
        const ret = wasm.wasmengine_getRevision(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
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
    constructor() {
        const ret = wasm.wasmengine_new();
        this.__wbg_ptr = ret >>> 0;
        WasmEngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Register a JavaScript function as the handler for a named action.
     * @param {string} action_name
     * @param {Function} handler
     */
    onAction(action_name, handler) {
        const ptr0 = passStringToWasm0(action_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmengine_onAction(this.__wbg_ptr, ptr0, len0, handler);
    }
    /**
     * Register a handler for data source actions.
     * @param {Function} handler
     */
    onDataSourceAction(handler) {
        wasm.wasmengine_onDataSourceAction(this.__wbg_ptr, handler);
    }
    /**
     * Register all standard Hypen primitives (Text, Column, Row, Button, etc.)
     */
    registerDefaultPrimitives() {
        wasm.wasmengine_registerDefaultPrimitives(this.__wbg_ptr);
    }
    /**
     * Register a named module for multi-module apps.
     * @param {string} name
     * @param {string[]} actions
     * @param {string[]} state_keys
     * @param {any} initial_state
     */
    registerModule(name, actions, state_keys, initial_state) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayJsValueToWasm0(actions, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayJsValueToWasm0(state_keys, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_registerModule(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, initial_state);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Register a primitive element (like Text, Button, etc.) to skip component resolution
     * @param {string} name
     */
    registerPrimitive(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmengine_registerPrimitive(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Register resources from a JavaScript object (name -> SVG string map).
     * @param {any} resources_js
     */
    registerResources(resources_js) {
        const ret = wasm.wasmengine_registerResources(this.__wbg_ptr, resources_js);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Remove a data source context entirely.
     * @param {string} name
     */
    removeContext(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmengine_removeContext(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Render a component into a specific parent node (subtree rendering)
     * @param {string} source
     * @param {string} parent_node_id_str
     * @param {any} state_js
     */
    renderInto(source, parent_node_id_str, state_js) {
        const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(parent_node_id_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_renderInto(this.__wbg_ptr, ptr0, len0, ptr1, len1, state_js);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Render a component source on-demand (for lazy-loaded routes).
     * @param {string} source
     */
    renderLazyComponent(source) {
        const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_renderLazyComponent(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
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
     * @param {string} source
     */
    renderSource(source) {
        const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_renderSource(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Fully reset the engine to its initial empty state.
     */
    reset() {
        wasm.wasmengine_reset(this.__wbg_ptr);
    }
    /**
     * Set the component resolver callback
     * @param {Function} resolver
     */
    setComponentResolver(resolver) {
        wasm.wasmengine_setComponentResolver(this.__wbg_ptr, resolver);
    }
    /**
     * Set (or replace) a named data source context.
     * @param {string} name
     * @param {any} data_js
     */
    setContext(name, data_js) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_setContext(this.__wbg_ptr, ptr0, len0, data_js);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Initialize (or replace) the active module with the given configuration.
     * @param {string} name
     * @param {string[]} actions
     * @param {string[]} state_keys
     * @param {any} initial_state
     */
    setModule(name, actions, state_keys, initial_state) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayJsValueToWasm0(actions, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayJsValueToWasm0(state_keys, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_setModule(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, initial_state);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Set the callback that receives UI patches after each render cycle.
     * @param {Function} callback
     */
    setRenderCallback(callback) {
        wasm.wasmengine_setRenderCallback(this.__wbg_ptr, callback);
    }
    /**
     * Return the total number of nodes currently in the instance tree.
     * @returns {number}
     */
    treeSize() {
        const ret = wasm.wasmengine_treeSize(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Apply a state patch and re-render affected nodes.
     *
     * `scope` selects the target module:
     * - empty string / null / undefined → primary module set via [`set_module`](Self::set_module)
     * - any other string → named module registered via [`register_module`] (lowercased)
     * @param {string | null | undefined} scope
     * @param {any} state_patch
     */
    updateState(scope, state_patch) {
        var ptr0 = isLikeNone(scope) ? 0 : passStringToWasm0(scope, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_updateState(this.__wbg_ptr, ptr0, len0, state_patch);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Apply a sparse state update using explicit path-value pairs.
     * See [`update_state`] for `scope` semantics.
     * @param {string | null | undefined} scope
     * @param {any} paths_js
     * @param {any} values_js
     */
    updateStateSparse(scope, paths_js, values_js) {
        var ptr0 = isLikeNone(scope) ? 0 : passStringToWasm0(scope, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_updateStateSparse(this.__wbg_ptr, ptr0, len0, paths_js, values_js);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Validate that the engine is in a consistent state.
     * @returns {any}
     */
    validate() {
        const ret = wasm.wasmengine_validate(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) WasmEngine.prototype[Symbol.dispose] = WasmEngine.prototype.free;

/**
 * Build a URL from path + JSON object of query params.
 * @param {string} path
 * @param {string} query_json
 * @returns {string}
 */
export function buildUrl(path, query_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(query_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.buildUrl(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Decode a percent-encoded string (`+` → space).
 * @param {string} input
 * @returns {string}
 */
export function decodeUriComponent(input) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.decodeUriComponent(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * JSON-in, JSON-out: returns `[{"path": "...", "value": <any>}, ...]`.
 *
 * See [`crate::portable::diff_paths`] for semantics.
 * @param {string} old_json
 * @param {string} new_json
 * @returns {string}
 */
export function diffPaths(old_json, new_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(old_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(new_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.diffPaths(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Percent-encode a string for URL query components.
 * @param {string} input
 * @returns {string}
 */
export function encodeUriComponent(input) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(input, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.encodeUriComponent(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

export function main() {
    wasm.main();
}

/**
 * Match a URL pattern against a path. Returns JSON
 * `{"matched": bool, "params": {"id": "42"}}`.
 *
 * See [`crate::portable::match_path`] for semantics.
 * @param {string} pattern
 * @param {string} path
 * @returns {string}
 */
export function matchPath(pattern, path) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(pattern, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.matchPath(ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Split `/path?k=v` into `{"path": "...", "query": {...}}`.
 * @param {string} full_path
 * @returns {string}
 */
export function parseQuery(full_path) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(full_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.parseQuery(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Parse Hypen DSL source and return the AST as a pretty-printed JSON string.
 * @param {string} source
 * @returns {string}
 */
export function parseToJson(source) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.parseToJson(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Serialize a patches array to a pretty-printed JSON string.
 * @param {any} patches
 * @returns {string}
 */
export function patchesToJson(patches) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.patchesToJson(patches);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Delete whatever lives at `path`; returns JSON
 * `{"json": <updated>, "removed": bool}`.
 * @param {string} value_json
 * @param {string} path
 * @returns {string}
 */
export function pathDelete(value_json, path) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.pathDelete(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Read the JSON value at a dotted path. Returns `"null"` if the
 * path doesn't resolve.
 * @param {string} value_json
 * @param {string} path
 * @returns {string}
 */
export function pathGet(value_json, path) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.pathGet(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Test whether `path` resolves inside `value_json`. Returns a JSON
 * boolean (`"true"` / `"false"`).
 * @param {string} value_json
 * @param {string} path
 * @returns {string}
 */
export function pathHas(value_json, path) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.pathHas(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Set `new_value_json` at `path` inside `value_json`; returns the
 * updated JSON string.
 * @param {string} value_json
 * @param {string} path
 * @param {string} new_value_json
 * @returns {string}
 */
export function pathSet(value_json, path, new_value_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(new_value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.pathSet(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Advance the session state machine by one event.
 *
 * `state_json` and `event_json` must deserialise to
 * [`crate::portable::SessionState`] / [`crate::portable::SessionEvent`].
 * Returns the serialised [`crate::portable::SessionEffect`].
 * @param {string} state_json
 * @param {string} event_json
 * @returns {string}
 */
export function sessionStep(state_json, event_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(state_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(event_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sessionStep(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_ecbf49c1b9d07c30: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_bigint_get_as_i64_a4925bc53b16f3d6: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_4a348b369b009243: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_43c7ccb034739216: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_035107858ad0083e: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_15e2d080220c7748: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_18bea6e84080c016: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_c5f5bb76436a9ab1: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_8d3fac158b36498d: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_4d5f2c5b2acf65b0: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_4a711ea9d2e1ef93: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_65f99081d9ee8f4d: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_1a2067dfb025b5ec: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_eed4462ef92e1bed: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_d09f733449cbf7a2: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_df03e93053e0f4bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_2989817bf2a245b5: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_call_85e5437fa1ab109d: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_df7a43aecab856a8: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_debug_5cd215874b9b39cc: function(arg0) {
            console.debug(arg0);
        },
        __wbg_done_0ad70482cae88a68: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_entries_d58050057c0390ac: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_error_51679600615c775d: function(arg0) {
            console.error(arg0);
        },
        __wbg_get_6f5cf69c8f3f094a: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_c40e2c3262995a8e: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_d0e1306db90b68d9: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_unchecked_3de5bfaaea65f86b: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_info_3039b9f214340fcd: function(arg0) {
            console.info(arg0);
        },
        __wbg_instanceof_ArrayBuffer_d8e4e51f1cf7287a: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Map_53b6790994271123: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Map;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_6e48d83da6091cc8: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_2efa5973cef6ec32: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_6709fb28be12d738: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_iterator_e77d2b7575cca5a7: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_00dd7227fd4626ad: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_5e07cf181b2745fb: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_log_91f1dd1dfd5a4ae8: function(arg0) {
            console.log(arg0);
        },
        __wbg_new_62f131e968c83d75: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_66075f8c2ea6575e: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_74eb411a4d7bd3f1: function() {
            const ret = new Map();
            return ret;
        },
        __wbg_new_a0479da6258a0d71: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_next_5428439dfc1d0362: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_next_d314789a105729f3: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_now_81a04fc60f4b9917: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_prototypesetcall_d1a7133bc8d83aa9: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_set_3ba5af57f57f831c: function(arg0, arg1, arg2) {
            const ret = arg0.set(arg1, arg2);
            return ret;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_7bf9e2df46e7632c: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_set_8326741805409e83: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_value_414b42ce7b3eca22: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_warn_52ab87a85aca283f: function(arg0) {
            console.warn(arg0);
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./hypen_engine_bg.js": import0,
    };
}

const WasmEngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmengine_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('hypen_engine_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
