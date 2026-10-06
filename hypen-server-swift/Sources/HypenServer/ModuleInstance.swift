import Foundation

/// Manages a running module with state and action handlers.
///
/// Wraps a [`NativeEngine`] for action dispatch and state synchronization.
/// Action handlers run inside the engine's `dispatchAction` flow so the
/// engine's action-scope latch is set during the handler — matching the
/// pattern in the Go, TypeScript, Kotlin, and Rust SDKs. State mutations
/// during handlers flow back through the engine via the per-instance
/// `state.onChange` wiring set up in `init`.
///
/// Supports sync and async action dispatch, error handling with the
/// module's `onError` handler, and session lifecycle (disconnect/reconnect/expire).
public final class ModuleInstance: @unchecked Sendable {
    private let lock = NSLock()
    private let definition: ModuleDefinition
    public let state: ObservableState
    public let engine: NativeEngine
    /// Session-scoped context surfaced to this module's action handlers
    /// via `ActionHandlerContext.context`. Set by [`ManagedRouter`] when
    /// a route mounts so routed modules can read sibling state via
    /// `ctx.context?.getModule("app")`. Nil when the host constructs a
    /// standalone `ModuleInstance` without a managing router, matching
    /// Swift's pre-existing opt-in behaviour.
    internal let globalContext: GlobalContext?
    /// Session-scoped router. Surfaced to action handlers for
    /// programmatic nav / route-param reads. Paired with
    /// [`globalContext`]; both land in the same
    /// `ActionHandlerContext`.
    internal let contextRouter: HypenRouter?
    private var isDestroyed = false
    /// True when the module is currently the active route target
    /// (i.e. `onActivated` has fired more recently than `onDeactivated`).
    /// Used to make `activate()` / `deactivate()` idempotent so the
    /// ManagedRouter can call them safely regardless of current state.
    private var isActive = false
    private var stateChangeCallbacks: [() -> Void] = []
    /// Callbacks invoked with the patches produced by `engine.updateState(...)`
    /// after each state mutation. Hosts (e.g. RemoteServer) register one of
    /// these to ship patches to a WebSocket client.
    private var patchCallbacks: [([[String: Any]]) -> Void] = []
    private let log = HypenLoggers.module

    // MARK: Device ownership (RFC 001 §2.7)

    private static let deviceIds = DeviceInstanceCounter()
    /// Stable per-instance owner id the connection's device broker keys
    /// activation authority, sweeps and background pins by.
    public let deviceInstanceId: String
    /// Strictly increasing activation counter; with `deviceInstanceId` it
    /// forms the owner authority of activation-owned device work.
    private var activationId: UInt32 = 0
    /// The connection's device plane, when one was negotiated.
    private var devicePlane: DevicePlane?

    /// Create a module instance backed by an existing native engine.
    ///
    /// All action dispatch routes through `engine.dispatchAction(...)` and
    /// state mutations stream through `engine.updateState(scope: "", state:)`.
    /// When `true`, this instance is a **nested** module living in the
    /// engine's named-modules map — NOT the primary slot. Set by
    /// [`ManagedRouter`] for route-target modules so mounting a new
    /// route doesn't clobber the primary (App) that owns the rendered
    /// tree's NodeId bindings. Scope-routes state changes via
    /// `engine.updateState(scope: definition.name, ...)` instead of the
    /// primary's empty-string scope.
    private let isNested: Bool

    /// Scope name this instance registered under in the engine.
    ///
    /// The engine just needs *some* name for a module slot, so a definition
    /// with no explicit name (e.g. an `AppBuilder` built without `.name(...)`)
    /// falls back to "Module"; the value isn't surfaced to action handlers.
    /// The engine lowercases it internally; we keep the declared spelling.
    ///
    /// Read back by the destroy path (see `ManagedRouter.executeUnmount`) so
    /// it unregisters exactly the scope `init` registered, instead of
    /// re-deriving the name from a route and risking drift.
    internal var engineScope: String {
        guard let name = definition.name, !name.isEmpty else { return "Module" }
        return name
    }

    public init(
        definition: ModuleDefinition,
        engine: NativeEngine,
        globalContext: GlobalContext? = nil,
        router: HypenRouter? = nil,
        asNested: Bool = false,
        initialPatchCallback: (@Sendable ([[String: Any]]) -> Void)? = nil
    ) {
        self.definition = definition
        self.engine = engine
        self.globalContext = globalContext
        self.contextRouter = router
        self.isNested = asNested
        self.state = ObservableState(definition.initialState)
        self.deviceInstanceId = "\(definition.name ?? "Module")#\(Self.deviceIds.next())"
        // Register the patch callback BEFORE the onCreated hook fires
        // — onCreated's state mutations flow through state.onChange →
        // engine.updateState → patchCallbacks synchronously. Registering
        // after init would mean those first-load patches are generated
        // and silently dropped (the ones that populate HomePage's feed).
        if let cb = initialPatchCallback {
            self.patchCallbacks.append(cb)
        }

        // Tell the engine about the primary module slot — this calls
        // `engine.registerAction(...)` for each action name behind the
        // scenes, so subsequent `engine.dispatchAction(...)` calls actually
        // queue and fire. Hosts that pre-configure the engine (like
        // RemoteServer) can pass an engine that's already had setModule
        // called; setModule is idempotent on the FFI side.
        let moduleName = self.engineScope
        let allActions = Array(Set(
            Array(definition.actionHandlers.keys) +
            Array(definition.asyncActionHandlers.keys) +
            definition.actions
        ))
        if asNested {
            // Append into the engine's named-modules map without
            // touching the primary slot. Required for ManagedRouter-
            // mounted routes so mounting HomePage, etc. doesn't
            // overwrite App. Matches Kotlin's NestedModuleInstance
            // and Go's AsNested() contract.
            engine.registerModule(
                name: moduleName,
                initialState: definition.initialState,
                actions: allActions
            )
        } else {
            engine.setModule(
                name: moduleName,
                actions: allActions,
                stateKeys: Array(definition.initialState.keys),
                initialState: definition.initialState
            )
        }

        // Wire state changes: route through the engine, then fire SDK
        // callbacks and patch callbacks. Action handlers (registered below)
        // mutate `state` directly; this `onChange` callback pushes the
        // snapshot through `engine.updateState(...)` so the engine sees
        // every state change without any callsite needing to call
        // updateState manually. The patches returned by the engine flow
        // out via patchCallbacks (registered via `onPatches`).
        self.state.onChange { [weak self] _ in
            guard let self = self else { return }
            let snapshot = self.state.snapshot()
            // Nested instances push state changes to their named scope
            // so the engine updates the right namespaced slot; primary
            // uses the empty-string scope. Without this, a nested
            // module's onCreated-loaded state (e.g. HomePage.posts)
            // would be written to the empty scope and never reach the
            // named-modules slot the Router IR subtree reads from.
            let updateScope = self.isNested ? self.engineScope : ""
            let patches = (try? self.engine.updateState(scope: updateScope, state: snapshot)) ?? []
            self.lock.lock()
            let stateCallbacks = self.stateChangeCallbacks
            let patchCbs = self.patchCallbacks
            self.lock.unlock()
            if !patches.isEmpty {
                for cb in patchCbs { cb(patches) }
            }
            for cb in stateCallbacks { cb() }
        }

        // Register definition action handlers with the engine. The engine
        // fires these inside `processPendingActions()` (called from
        // `dispatchAction` after `engine.dispatchAction(...)`). Handlers
        // mutate `self.state`, which triggers the onChange wiring above
        // to push patches through the engine.
        self.registerActionHandlersWithEngine()

        // Call onCreated
        if let handler = definition.onCreated {
            callLifecycle("created") { handler(state) }
        }
    }

    /// Convenience: create a module instance with a fresh default engine.
    ///
    /// Throws if the native engine fails to initialize. Most callers that
    /// don't need to share an engine should use this initializer.
    public convenience init(definition: ModuleDefinition) throws {
        try self.init(definition: definition, engine: NativeEngine())
    }

    /// Register every sync, async, and `__hypen_bind` handler with the
    /// engine via `engine.onAction(...)`. The engine will fire these from
    /// inside `processPendingActions()` when `dispatchAction` is called.
    private func registerActionHandlersWithEngine() {
        let actionPrefix = "__hypen_scoped:\(isNested ? engineScope.lowercased() : ""):"
        // Sync handlers
        for (actionName, handler) in definition.actionHandlers {
            let name = actionName
            let h = handler
            engine.onAction(actionPrefix + name) { [weak self] _, payload in
                guard let self = self else { return }
                let destroyed = self.lock.withLock { self.isDestroyed }
                if destroyed { return }
                let action = Action(name: name, payload: payload)
                let ctx = ActionHandlerContext(
                    action: action,
                    state: self.state,
                    context: self.globalContext,
                    router: self.contextRouter,
                    device: self.deviceContext()
                )
                self.callAction(name) { h(ctx) }
            }
        }
        // Async handlers — fire-and-forget into a Task
        for (actionName, handler) in definition.asyncActionHandlers {
            let name = actionName
            let h = handler
            engine.onAction(actionPrefix + name) { [weak self] _, payload in
                guard let self = self else { return }
                let action = Action(name: name, payload: payload)
                // Owner and provenance are fixed HERE, synchronously in the
                // dispatch (RFC 001 §4/§7), before the handler task starts.
                let ctx = ActionHandlerContext(
                    action: action,
                    state: self.state,
                    context: self.globalContext,
                    router: self.contextRouter,
                    device: self.deviceContext()
                )
                Task { [weak self] in
                    guard let self = self else { return }
                    let destroyed = self.lock.withLock { self.isDestroyed }
                    if destroyed { return }
                    // Handler scope (RFC 001 §2.4): unary device requests
                    // still pending when the handler returns are cancelled.
                    ctx.device.beginHandlerScope()
                    await h(ctx)
                    ctx.device.endHandlerScope()
                }
            }
        }
        // Two-way binding: writes a single state path. The mutation flows
        // through the same onChange → engine.updateState path as any
        // user-handler-driven mutation.
        engine.onAction(actionPrefix + "__hypen_bind") { [weak self] _, payload in
            guard let self = self,
                  let payloadDict = payload as? [String: Any],
                  let path = payloadDict["path"] as? String,
                  payloadDict.keys.contains("value") else { return }
            let value = payloadDict["value"] as Any
            self.state.set(path, value)
        }
        // Drag-and-drop outcome actions (hypen-web/docs/dnd.md). Both
        // go through `self.state` — never the engine directly — so the
        // onChange → engine.updateState wiring, persistence and the typed
        // builder's re-encoding all see the write. Malformed payloads warn
        // and degrade to a no-op; author input never throws.
        //
        engine.onAction(actionPrefix + HypenDnd.reorderAction) { [weak self] _, payload in
            guard let self = self else { return }
            let destroyed = self.lock.withLock { self.isDestroyed }
            if destroyed { return }
            self.handleReorder(payload)
        }
        engine.onAction(actionPrefix + HypenDnd.pinAction) { [weak self] _, payload in
            guard let self = self else { return }
            let destroyed = self.lock.withLock { self.isDestroyed }
            if destroyed { return }
            self.handlePin(payload)
        }
    }

    // MARK: - Drag & Drop Reserved Actions

    /// `__hypen_reorder {fromPath, from, toPath, to}` — `path` is accepted
    /// as shorthand for `fromPath == toPath`. `to` is the moved item's FINAL
    /// index; semantics are `portable::path_move` via
    /// `ObservableState.move(fromPath:from:toPath:to:)`.
    private func handleReorder(_ payload: Any?) {
        guard let dict = payload as? [String: Any] else {
            log.warn("\(HypenDnd.reorderAction): missing payload")
            return
        }
        let fromPathField = Self.stringField(dict, "fromPath") ?? Self.stringField(dict, "path")
        let toPathField = Self.stringField(dict, "toPath") ?? fromPathField
        guard let fromPath = fromPathField,
              let toPath = toPathField,
              let from = Self.intField(dict, "from"),
              let to = Self.intField(dict, "to") else {
            log.warn("\(HypenDnd.reorderAction): malformed payload \(dict)")
            return
        }
        if !state.move(fromPath: fromPath, from: from, toPath: toPath, to: to) {
            log.warn(
                "\(HypenDnd.reorderAction): no-op — \"\(fromPath)\"[\(from)] → \"\(toPath)\"[\(to)] "
                    + "does not resolve to arrays / in-range index"
            )
        }
    }

    /// `__hypen_pin {path, x, y, xKey?, yKey?}` — two path sets
    /// (`path.xKey`, `path.yKey`) issued as ONE `ObservableState.update(_:)`
    /// so they reach the engine in a single batch. Missing intermediates
    /// auto-vivify (`portable_path_set`), so the first pin of a
    /// reserved-mode key creates `__dnd.<group>.<key>`.
    private func handlePin(_ payload: Any?) {
        guard let dict = payload as? [String: Any] else {
            log.warn("\(HypenDnd.pinAction): missing payload")
            return
        }
        guard let path = Self.stringField(dict, "path"), !path.isEmpty,
              let x = Self.finiteNumberField(dict, "x"),
              let y = Self.finiteNumberField(dict, "y") else {
            log.warn("\(HypenDnd.pinAction): malformed payload \(dict)")
            return
        }
        let xKey = Self.nonEmptyStringField(dict, "xKey") ?? "x"
        let yKey = Self.nonEmptyStringField(dict, "yKey") ?? "y"
        // Built imperatively rather than as a literal: a literal with two
        // equal keys (xKey == yKey) would trap at runtime.
        var writes: [String: Any] = [:]
        writes["\(path).\(xKey)"] = x
        writes["\(path).\(yKey)"] = y
        state.update(writes)
    }

    private static func stringField(_ dict: [String: Any], _ key: String) -> String? {
        return dict[key] as? String
    }

    private static func nonEmptyStringField(_ dict: [String: Any], _ key: String) -> String? {
        guard let value = dict[key] as? String, !value.isEmpty else { return nil }
        return value
    }

    /// A JSON number field. Rejects strings and booleans (JSONSerialization
    /// surfaces `true`/`false` as `NSNumber` too, so the encoded type is what
    /// tells them apart from `0`/`1`).
    ///
    /// Portable: no CoreFoundation symbols (plan §6.11 — `CFGetTypeID` /
    /// `CFBooleanGetTypeID` do not resolve behind `import Foundation` on
    /// Linux). A boolean `NSNumber` reports `objCType` `"c"` on Darwin
    /// (`__NSCFBoolean`) and on swift-corelibs-foundation; `"B"` is the C99
    /// `_Bool` encoding, accepted for completeness. JSONSerialization never
    /// produces an `Int8` (`"c"`) number, so this cannot reject a real integer.
    private static func numberField(_ dict: [String: Any], _ key: String) -> NSNumber? {
        guard let raw = dict[key], !(raw is String), let number = raw as? NSNumber else {
            return nil
        }
        if isBooleanNumber(number) { return nil }
        return number
    }

    /// Whether `number` encodes a JSON boolean rather than a numeric value.
    static func isBooleanNumber(_ number: NSNumber) -> Bool {
        let encoding = String(cString: number.objCType)
        return encoding == "c" || encoding == "B"
    }

    /// Integral JSON number (`3`, `3.0`); anything else → nil.
    private static func intField(_ dict: [String: Any], _ key: String) -> Int? {
        guard let number = numberField(dict, key) else { return nil }
        let value = number.doubleValue
        guard value.isFinite else { return nil }
        return Int(exactly: value)
    }

    /// Finite JSON number, returned as the original `NSNumber` so an
    /// integral coordinate round-trips as an integer like author state.
    private static func finiteNumberField(_ dict: [String: Any], _ key: String) -> NSNumber? {
        guard let number = numberField(dict, key), number.doubleValue.isFinite else { return nil }
        return number
    }

    // MARK: - Action Dispatch

    /// Dispatch an action to this module's handlers (sync).
    ///
    /// Routes through `engine.dispatchAction(...)` + `processPendingActions()`,
    /// which fires the handler closures registered in `init`. State mutations
    /// during the handler stream back through the `state.onChange` wiring
    /// set up in `init`.
    public func dispatchAction(_ name: String, payload: Any? = nil) {
        lock.lock()
        if isDestroyed {
            lock.unlock()
            return
        }
        lock.unlock()

        var payloadJson: String? = nil
        // `isValidJSONObject` first: on Darwin `data(withJSONObject:)` raises
        // an Objective-C exception (not a Swift error) for a non-collection
        // top level or a NaN/infinite number, which `try?` cannot catch.
        if let p = payload,
           JSONSerialization.isValidJSONObject(p),
           let data = try? JSONSerialization.data(withJSONObject: p),
           let str = String(data: data, encoding: .utf8) {
            payloadJson = str
        }

        do {
            try engine.dispatchAction(name, payloadJson: payloadJson)
            engine.processPendingActions()
        } catch {
            log.debug("Engine dispatchAction failed for '%@': %@", name, "\(error)")
        }
    }

    /// Dispatch an action asynchronously.
    ///
    /// Sync handlers route through the engine like in `dispatchAction(_:payload:)`.
    /// Async handlers are awaited inline so the caller can `await` the full
    /// completion of the action.
    public func dispatchActionAsync(_ name: String, payload: Any? = nil) async {
        let destroyed = lock.withLock { isDestroyed }
        if destroyed { return }

        // If there's an async handler, run it inline so the caller's `await`
        // sees its completion. Sync handlers go through the engine as in the
        // sync entrypoint above (the engine-side closure registered in
        // `init` does the actual invocation).
        if let asyncHandler = definition.asyncActionHandlers[name] {
            let action = Action(name: name, payload: payload)
            let ctx = ActionHandlerContext(
                action: action,
                state: state,
                context: globalContext,
                router: contextRouter,
                device: deviceContext()
            )
            ctx.device.beginHandlerScope()
            await asyncHandler(ctx)
            ctx.device.endHandlerScope()
            return
        }

        // Sync (or unknown) — defer to the sync entrypoint, which routes
        // through engine.dispatchAction.
        dispatchAction(name, payload: payload)
    }

    // MARK: - State

    /// Get a snapshot of the current state.
    public func getState() -> [String: Any] {
        return state.snapshot()
    }

    /// Replace the state entirely.
    public func replaceState(_ newState: [String: Any]) {
        state.replace(newState)
    }

    /// Register a callback for state changes.
    public func onStateChange(_ callback: @escaping () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        stateChangeCallbacks.append(callback)
    }

    /// Register a callback to receive patches produced by the engine after
    /// each state mutation. Hosts that need to ship patches over a wire
    /// (e.g. RemoteServer's WebSocket) install this callback.
    public func onPatches(_ callback: @escaping ([[String: Any]]) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        patchCallbacks.append(callback)
    }

    // MARK: - Session Lifecycle

    /// Called when the client disconnects.
    public func handleDisconnect(session: SessionInfo) {
        definition.onDisconnect?(state, session)
    }

    /// Called when a client reconnects to a suspended session.
    public func handleReconnect(session: SessionInfo, savedState: [String: Any]) {
        if let onReconnect = definition.onReconnect {
            var didRestore = false
            let preserveReserved = definition.preservesReservedKeysOnRestore
            onReconnect(session) { [weak self] restoredState in
                didRestore = true
                guard let self = self else { return }
                var next = restoredState
                if preserveReserved {
                    // A typed (`Codable`) restore cannot mention runtime-owned
                    // keys such as `__dnd`; keep the live ones it omits so a
                    // reconnect does not wipe reserved-mode pinboard positions
                    // (plan §3 — same exemption as `encodeState`).
                    for (key, value) in self.state.snapshot()
                    where HypenDnd.isReservedKey(key) && next[key] == nil {
                        next[key] = value
                    }
                }
                self.state.replace(next)
            }
            // If the reconnect handler didn't explicitly restore, use the saved state
            if !didRestore {
                state.replace(savedState)
            }
        } else {
            // No reconnect handler — restore saved state by default
            state.replace(savedState)
        }
    }

    /// Called when a suspended session expires.
    public func handleExpire(session: SessionInfo) {
        definition.onExpire?(session)
    }

    // MARK: - Activation

    /// Mark the module as the active route target and fire `onActivated`.
    ///
    /// Idempotent: calling `activate()` on an already-active module is
    /// a no-op. Called by ManagedRouter on every route mount — both
    /// fresh constructions and re-mounts from the persistence cache.
    public func activate() {
        lock.lock()
        if isDestroyed || isActive {
            lock.unlock()
            return
        }
        isActive = true
        // Activation authority becomes available BEFORE onActivated runs
        // (RFC 001 §2.7): a fresh activation id owns this activation's
        // device work, registered with the connection's broker (which only
        // admits requests for a module instance's live activation).
        activationId &+= 1
        let plane = devicePlane
        let activation = activationId
        lock.unlock()
        plane?.ownerActivated(deviceInstanceId, activationId: activation)

        if let handler = definition.onActivated {
            callLifecycle("activated") { handler(state) }
        }
        if let asyncHandler = definition.onActivatedAsync {
            let device = deviceContext()
            let state = self.state
            Task {
                device.beginHandlerScope()
                await asyncHandler(state, device)
                device.endHandlerScope()
            }
        }
    }

    /// Mark the module as no longer the active route target and fire
    /// `onDeactivated`.
    ///
    /// Idempotent: calling `deactivate()` on an inactive module is a
    /// no-op. Called by ManagedRouter before persisting a module for
    /// later reuse OR before destroying it.
    public func deactivate() {
        lock.lock()
        if isDestroyed || !isActive {
            lock.unlock()
            return
        }
        isActive = false
        let plane = devicePlane
        let activation = activationId
        lock.unlock()
        // Authority is revoked BEFORE onDeactivated runs (RFC 001 §2.7):
        // every device request owned by this exact activation is cancelled.
        plane?.ownerDeactivated(deviceInstanceId, activationId: activation)

        if let handler = definition.onDeactivated {
            callLifecycle("deactivated") { handler(state) }
        }
    }

    /// Whether the module is currently the active route target.
    public var active: Bool {
        lock.withLock { isActive }
    }

    // MARK: - Device (RFC 001)

    /// Bind this instance to a connection's device plane (or unbind with
    /// nil). The broker is the connection's; the instance only contributes
    /// ownership: a currently active instance registers its live activation
    /// right away.
    public func attachDevice(_ plane: DevicePlane?) {
        lock.lock()
        if isDestroyed { lock.unlock(); return }
        devicePlane = plane
        let register = plane != nil && isActive
        let activation = activationId
        lock.unlock()
        if register { plane?.ownerActivated(deviceInstanceId, activationId: activation) }
    }

    /// Build the device surface for code running right now on behalf of this
    /// module (handlers get it as `ctx.device`). Owner and provenance are
    /// fixed at this moment: outside an activation (onCreated before the
    /// first activation, deactivation/destroy handlers) every call returns
    /// `unavailable` ("owner-inactive") instead of waiting; a context whose
    /// activation has since ended cannot start new device work; a context
    /// built inside `DeviceProvenance.$current.withValue(.replay)` refuses
    /// every call (replay firewall, RFC 001 §1.7).
    public func deviceContext() -> DeviceContext {
        let provenance = DeviceProvenance.current
        lock.lock()
        let plane = devicePlane
        let active = isActive && !isDestroyed
        let activation = activationId
        lock.unlock()
        let owner = DeviceOwnerAuthority(moduleInstanceId: deviceInstanceId, activationId: activation)
        guard let plane else {
            return DeviceContext(plane: nil, owner: owner, provenance: provenance, blockedDetail: "device-disabled")
        }
        if !active {
            return DeviceContext(plane: plane, owner: owner, provenance: provenance, blockedDetail: "owner-inactive")
        }
        return DeviceContext(plane: plane, owner: owner, provenance: provenance, ownerLive: { [weak self] in
            guard let self else { return false }
            return self.lock.withLock { !self.isDestroyed && self.isActive && self.activationId == activation }
        })
    }

    /// Run `body` as a replayed / broadcast-derived dispatch: every handler
    /// context built inside (and in tasks it spawns) carries replay
    /// provenance, so its `ctx.device` refuses to open requests (RFC 001
    /// §1.7) — even after `await`.
    public func runReplayed<R>(_ body: () throws -> R) rethrows -> R {
        try DeviceProvenance.$current.withValue(.replay) { try body() }
    }

    /// True while this instance owns live `background`-lifetime device work
    /// (RFC 001 §2.7): the work survives deactivation and ends only when the
    /// instance is destroyed. The pin cap (how many module instances one
    /// connection may pin this way) is enforced by the Rust broker when the
    /// work is opened — a background request from one module too many is
    /// refused `throttled` (`DeviceServerOptions.maxBackgroundOwners`). The
    /// Swift `ManagedRouter` never evicts persisted modules (its cache is
    /// unbounded), so nothing here is consulted for eviction; a host with
    /// its own module cache can use it to avoid destroying pinned work.
    public var hasLiveBackgroundDeviceWork: Bool {
        lock.lock()
        let plane = isDestroyed ? nil : devicePlane
        lock.unlock()
        return plane?.hasBackgroundWork(deviceInstanceId) ?? false
    }

    // MARK: - Destroy

    /// Destroy this module instance.
    public func destroy() {
        // If this module is still marked as active (destroy() called
        // without a preceding deactivate()), fire onDeactivated first
        // so the lifecycle order is always:
        // ...onActivated → onDeactivated → onDestroyed
        let stillActive = lock.withLock { !isDestroyed && isActive }
        if stillActive {
            deactivate()
        }

        lock.lock()
        if isDestroyed {
            lock.unlock()
            return
        }
        isDestroyed = true
        let plane = devicePlane
        devicePlane = nil
        lock.unlock()
        // All of this instance's device work (activation and background
        // lifetimes) ends with it.
        plane?.ownerDestroyed(deviceInstanceId)

        if let handler = definition.onDestroyed {
            callLifecycle("destroyed") { handler(state) }
        }
    }

    /// The module definition.
    public var moduleDefinition: ModuleDefinition {
        definition
    }

    // MARK: - Error Handling

    private func handleError(_ error: Error, actionName: String? = nil, lifecycle: String? = nil) -> Bool {
        let ctx = ErrorContext(
            error: error,
            state: state,
            actionName: actionName,
            lifecycle: lifecycle
        )

        if let errorHandler = definition.onError {
            if let result = errorHandler(ctx) {
                if result.handled { return false }
                if result.rethrow_ { return true }
            }
        }

        if let action = actionName {
            log.error("Action '%@' error: %@", action, "\(error)")
        } else if let phase = lifecycle {
            log.error("Lifecycle '%@' error: %@", phase, "\(error)")
        }

        return false
    }

    private func callAction(_ name: String, _ block: () throws -> Void) {
        do {
            try block()
        } catch {
            let shouldRethrow = handleError(error, actionName: name)
            if shouldRethrow {
                log.error("Action '%@' error (rethrown): %@", name, "\(error)")
            }
        }
    }

    private func callLifecycle(_ phase: String, _ block: () throws -> Void) {
        do {
            try block()
        } catch {
            let shouldRethrow = handleError(error, lifecycle: phase)
            if shouldRethrow {
                log.error("Lifecycle '%@' error (rethrown): %@", phase, "\(error)")
            }
        }
    }
}

/// Process-wide counter behind `ModuleInstance.deviceInstanceId`.
private final class DeviceInstanceCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n: UInt64 = 0
    func next() -> UInt64 { lock.lock(); defer { lock.unlock() }; n += 1; return n }
}
