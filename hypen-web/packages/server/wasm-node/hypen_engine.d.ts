/* tslint:disable */
/* eslint-disable */

/**
 * The server-side device broker for one device-enabled connection.
 *
 * ```js
 * const broker = new WasmDeviceBroker({ ack }, now());
 * const core = broker.start(now());            // {id} | {error}
 * broker.ownerActivated("m1", 1, now());
 * const r = broker.open({ capability: "gallery.pick", params, moduleInstanceId: "m1", activationId: 1 }, now());
 * socket.onmessage = (m) => typeof m.data === "string"
 *   ? broker.onText(m.data, now()) : broker.onFrame(new Uint8Array(m.data), now());
 * for (const o of broker.poll()) { ...sendText / sendFrame / event / data / settled / closeConnection... }
 * const next = broker.tick(now());             // schedule the next tick (or undefined)
 * ```
 *
 * Freeing the object (`free()`, or the `FinalizationRegistry` reclaiming
 * an unreachable one) closes the broker with `connectionLost` if the host
 * did not, so its retained bytes always return to a shared
 * `WasmRetainedBytesPool` (see `device_binding::OwnedBroker`).
 */
export class WasmDeviceBroker {
    free(): void;
    [Symbol.dispose](): void;
    admitsBackground(module_instance_id: string): boolean;
    /**
     * Server-initiated cancel (sends `cancel`, settles `cancelled`).
     */
    cancel(id: number, now_ms: number): void;
    /**
     * Close the device plane locally with a wire error code
     * (`"connectionLost"`); throws on an unknown code.
     */
    close(code: string): void;
    /**
     * The consumer finished the next `chunks` data chunks of stream `id`.
     */
    consumedData(id: number, chunks: number, now_ms: number): void;
    /**
     * The consumer finished `n` JSON events of stream `id`.
     */
    consumedEvents(id: number, n: number, now_ms: number): void;
    hasBackgroundWork(module_instance_id: string): boolean;
    /**
     * A snapshot of the broker state (see `device_binding::info_json`).
     */
    info(): any;
    isLive(id: number): boolean;
    /**
     * A broker from the configuration (JSON string or object; only `ack`
     * is required). Throws on a malformed configuration.
     */
    constructor(config: any, now_ms: number);
    /**
     * The next deadline without running anything, or `undefined`.
     */
    nextDeadline(): number | undefined;
    /**
     * Feed one client → server binary frame; true when accepted.
     */
    onFrame(frame: Uint8Array, now_ms: number): boolean;
    /**
     * Feed one client → server device text message; true when it was for
     * a live request.
     */
    onText(text: string, now_ms: number): boolean;
    /**
     * Open a request (spec: JSON string or object); `download` carries
     * `file.save` bytes. Returns `{id}` or `{error: {code, detail?}}`;
     * throws on a malformed spec.
     */
    open(spec: any, now_ms: number, download?: Uint8Array | null): any;
    outstandingCredit(id: number): number | undefined;
    outstandingEventCredit(id: number): number | undefined;
    /**
     * Record a module activation; false for a stale one.
     */
    ownerActivated(module_instance_id: string, activation_id: number, now_ms: number): boolean;
    /**
     * The activation ended: activation-owned work is cancelled.
     */
    ownerDeactivated(module_instance_id: string, activation_id: number, now_ms: number): void;
    /**
     * The module instance was destroyed: all of its work is cancelled.
     */
    ownerDestroyed(module_instance_id: string, now_ms: number): void;
    ownerIsActive(module_instance_id: string, activation_id: number): boolean;
    /**
     * Drain every output (and at most one bulk turn) as plain objects.
     */
    poll(): Array<any>;
    /**
     * Release a held result's retained-bytes charge (idempotent).
     */
    releaseResult(id: number): void;
    /**
     * Planned reopen of `core.capabilities`; the new id or `undefined`.
     */
    reopenCoreCapabilities(now_ms: number): number | undefined;
    /**
     * Count a connection-level violation the host detected itself.
     */
    reportViolation(reason: string, now_ms: number): void;
    /**
     * The revision this broker enforces for `capability@version` (registry
     * revision or its configured override, `maxItemBytes` capped by the
     * broker's), as `{version, mode, data, consent, overflow, lifetimes,
     * maxItemBytes, maxItems, maxInitialCredit, maxOutstandingCredit,
     * maxTimeoutMs}`; `null` when it is not a registry revision.
     */
    revision(capability: string, version: number): any;
    selectedVersion(capability: string): number | undefined;
    /**
     * Report the transport's buffered (accepted, unwritten) bytes.
     */
    setTransportBuffered(bytes: number): void;
    /**
     * Open the connection-owned `core.capabilities` stream:
     * `{id}` or `{error: {code, detail?}}`.
     */
    start(now_ms: number): any;
    supports(capability: string): boolean;
    /**
     * Run due timers; the next deadline (absolute ms) or `undefined`.
     */
    tick(now_ms: number): number | undefined;
    /**
     * As the constructor, sharing `pool`'s aggregate budget.
     */
    static withPool(config: any, pool: WasmRetainedBytesPool, now_ms: number): WasmDeviceBroker;
    readonly coreStreamId: number | undefined;
    readonly isClosed: boolean;
    readonly liveCount: number;
    readonly retainedBytes: number;
}

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
     * Dispatch on behalf of an external caller.
     *
     * Authorises against exactly what `listActions` advertises, then routes
     * through the same handler path a UI dispatch would take. Throws when
     * the name is not externally dispatchable, when a built-in is used in an
     * app that does not declare it, or when `set_input` names an undeclared
     * field.
     */
    dispatchExternal(name: string, payload: any): void;
    /**
     * The built-in external action names, as
     * `{ navigate, back, setInput, bindAction }`.
     *
     * Exported so SDKs bind to these rather than hardcoding the literals.
     * They were hardcoded in four SDKs at once, which is why renaming
     * `navigate` to `hypen.navigate` (to stop it colliding with `Link`'s own
     * declared action) broke all four silently instead of at the call site.
     */
    externalBuiltinNames(): any;
    /**
     * Get the current revision number.
     */
    getRevision(): bigint;
    /**
     * Read module state, whole or at a path.
     *
     * Pass `null`/`undefined` for `module` to read the primary module, or a
     * registered module's name (case-insensitive). Returns `null` when the
     * module is unknown or the path is absent.
     */
    getStateAt(module?: string | null, path?: string | null): any;
    /**
     * List every action an external caller may dispatch, as
     * `[{ name, module, builtin }]`.
     *
     * Module-declared actions plus `navigate` / `back` / `set_input`, the
     * last three only when the app declares the backing `Router` or
     * `.bind()`. Framework internals never appear.
     */
    listActions(): any;
    /**
     * List `.bind()`-declared writable inputs as
     * `[{ path, prop, elementType, moduleScope }]`, backing `set_input`'s
     * argument schema. `prop` is `checked` / `on` for boolean controls.
     */
    listBindings(): any;
    /**
     * List the app's declared routes as `[{ path, params, moduleScope }]`,
     * backing `navigate`'s argument schema.
     */
    listRoutes(): any;
    /**
     * The full MCP handshake for this app: `{ protocolVersion, instructions,
     * tools, resources, resourceTemplates, degraded }`.
     *
     * Copy the fields straight into `initialize.instructions`, `tools/list`
     * and `resources/list`. Composed in the engine so five SDKs transport
     * bytes and hand-write no prose — re-deriving or re-describing any of it
     * host-side is what the shape exists to prevent.
     */
    mcpManifest(): any;
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
     * Resolve session-local node identity before trusted server fan-out.
     */
    resolveUIAction(name: string, payload: any): any;
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
     * Drop a module and every action it declared.
     *
     * **Call on destroy only**, never on unmount: under the default
     * `persist: true` an off-screen module stays registered on purpose, so
     * siblings can still read its state. The SDK's three destroy sites —
     * full stop, `persist: false` unmount, LRU eviction — are the correct
     * call sites.
     */
    unregisterModule(name: string): void;
    /**
     * Apply a state patch and re-render affected nodes.
     *
     * `scope` selects the target module:
     * - empty string / null / undefined → primary module set via [`set_module`](Self::set_module)
     * - any other string → named module registered via [`register_module`] (lowercased)
     *
     * `animation` is the optional batch-animation context (Option D cheap
     * subset): a spec object (`{curve: "spring", ...}`) or a bare curve
     * string (`"spring"`). Omitted / `undefined` / `null` → unstamped
     * update, byte-identical to the pre-animation wire format. When the
     * update changes state and the render cycle emits patches, the batch is
     * prefixed with a `{"type": "batchAnimation", "spec": {...}}` prelude.
     */
    updateState(scope: string | null | undefined, state_patch: any, animation?: any | null): void;
    /**
     * Apply a sparse state update using explicit path-value pairs.
     * See [`update_state`] for `scope` and `animation` semantics.
     */
    updateStateSparse(scope: string | null | undefined, paths_js: any, values_js: any, animation?: any | null): void;
    /**
     * Validate that the engine is in a consistent state.
     */
    validate(): any;
}

/**
 * An aggregate retained-bytes budget shared by several brokers (every
 * connection of one process, or of one Durable Object). Pass it to
 * `WasmDeviceBroker.withPool`.
 */
export class WasmRetainedBytesPool {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bytes currently reserved across every broker using this pool.
     */
    inUse(): number;
    constructor(limit: number);
    /**
     * The pool's byte limit.
     */
    readonly limit: number;
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
 * Protocol and broker constants.
 */
export function deviceConstants(): any;

/**
 * The `file.save@1` announcement params for `bytes`.
 */
export function deviceFileSaveParams(name: string, content_type: string, bytes: Uint8Array): any;

/**
 * The whole server-side handshake for `hello.device` (strict validation —
 * pass the RAW member text when you have it, so duplicate keys and number
 * spellings are judged as sent — then selection): `{ack}` with the
 * `sessionAck.device` object, or `{ack: null, reason}` when the device
 * plane is disabled (reason for the server log). `serverCapabilities`
 * (`[{name, versions}]` or its JSON; `undefined`/`null` = every capability
 * the broker consumes) replaces the default advertisement; a malformed one
 * throws.
 */
export function deviceHandshake(hello: any, binary_route: boolean, server_capabilities: any): any;

/**
 * Whether `text` is device text over the size limit (decided without
 * parsing it): report it with `reportViolation` instead of parsing.
 */
export function deviceIsOversizeText(text: string): boolean;

/**
 * `hello.device` (JSON string or object) → the `sessionAck.device` object
 * of a broker-backed server, or `null` (device disabled).
 */
export function deviceNegotiate(hello: any, binary_route: boolean): any;

/**
 * `select_device_ack` with explicit server lists (`serverProtocolVersions`:
 * a number array or its JSON; `serverCapabilities`: `[{name, versions}]` or
 * its JSON); the ack object or `null`. Throws on malformed server lists.
 */
export function deviceSelectAck(hello: any, server_protocol_versions: any, server_capabilities: any, server_binary: boolean): any;

/**
 * What a broker-backed server advertises: `[{name, versions}]`.
 */
export function deviceServerAdvertisement(): any;

/**
 * Whether a broker-backed server has a consuming API for a capability
 * revision (an object or JSON string with `mode` and `data`, such as a
 * `WasmDeviceBroker.revision()` answer): unary, or a stream whose data
 * plane flows client to server. Throws when `mode`/`data` is missing or
 * unknown.
 */
export function deviceServerConsumes(revision: any): boolean;

/**
 * Lowercase hex SHA-256.
 */
export function deviceSha256Hex(bytes: Uint8Array): string;

/**
 * Strictly decode `sessionAck.device` (same result shape).
 */
export function deviceValidateAck(ack: any): any;

/**
 * Strictly decode `hello.device`: `{ok: true, value}` or `{ok: false, error}`.
 */
export function deviceValidateHello(hello: any): any;

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
 * Move element `from` of the array at `from_path` to index `to` of the
 * array at `to_path` (the `__hypen_reorder` primitive); returns JSON
 * `{"json": <updated>, "moved": bool}`. See [`crate::portable::path_move`].
 */
export function pathMove(value_json: string, from_path: string, from: number, to_path: string, to: number): string;

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
