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
        //
        // The default "Module" name is used when the definition has no
        // explicit name (e.g. AppBuilder constructed without `.name(...)`).
        // The engine just needs *some* name for the primary slot — the
        // value isn't surfaced to action handlers.
        let moduleName = definition.name ?? "Module"
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
            let updateScope = self.isNested ? (self.definition.name ?? "Module") : ""
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
        // Sync handlers
        for (actionName, handler) in definition.actionHandlers {
            let name = actionName
            let h = handler
            engine.onAction(name) { [weak self] _, payload in
                guard let self = self else { return }
                let destroyed = self.lock.withLock { self.isDestroyed }
                if destroyed { return }
                let action = Action(name: name, payload: payload)
                let ctx = ActionHandlerContext(
                    action: action,
                    state: self.state,
                    context: self.globalContext,
                    router: self.contextRouter
                )
                self.callAction(name) { h(ctx) }
            }
        }
        // Async handlers — fire-and-forget into a Task
        for (actionName, handler) in definition.asyncActionHandlers {
            let name = actionName
            let h = handler
            engine.onAction(name) { [weak self] _, payload in
                guard let self = self else { return }
                let action = Action(name: name, payload: payload)
                let ctx = ActionHandlerContext(
                    action: action,
                    state: self.state,
                    context: self.globalContext,
                    router: self.contextRouter
                )
                Task { [weak self] in
                    guard let self = self else { return }
                    let destroyed = self.lock.withLock { self.isDestroyed }
                    if destroyed { return }
                    await h(ctx)
                }
            }
        }
        // Two-way binding: writes a single state path. The mutation flows
        // through the same onChange → engine.updateState path as any
        // user-handler-driven mutation.
        engine.onAction("__hypen_bind") { [weak self] _, payload in
            guard let self = self,
                  let payloadDict = payload as? [String: Any],
                  let path = payloadDict["path"] as? String,
                  payloadDict.keys.contains("value") else { return }
            let value = payloadDict["value"] as Any
            self.state.set(path, value)
        }
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
        if let p = payload,
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
                router: contextRouter
            )
            await asyncHandler(ctx)
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
            onReconnect(session) { [weak self] restoredState in
                didRestore = true
                self?.state.replace(restoredState)
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
        lock.unlock()

        if let handler = definition.onActivated {
            callLifecycle("activated") { handler(state) }
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
        lock.unlock()

        if let handler = definition.onDeactivated {
            callLifecycle("deactivated") { handler(state) }
        }
    }

    /// Whether the module is currently the active route target.
    public var active: Bool {
        lock.withLock { isActive }
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
        lock.unlock()

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
