import Foundation

/// Orchestrates module mount/unmount on route changes.
///
/// When the router navigates to a route:
/// 1. Deactivates and unmounts the previous module (either persisting
///    it for later reuse or destroying it).
/// 2. Mounts the new module (creating it fresh or restoring from the
///    persistence cache) and activates it.
///
/// ## Persistence (default: on for module-backed routes)
///
/// By default, any route whose `component` resolves to a registered
/// module definition (or provides one inline via `route.module`) has
/// its module instance **persisted** across navigations. This preserves
/// module state so navigating away and back doesn't re-trigger the
/// initial "loading" state that usually lives in `onCreated`. Opt out
/// by setting `persist: false` on `ModuleOptions`.
///
/// ## Lifecycle on navigation
///
/// * First visit:        `construct → onCreated → onActivated`
/// * Navigate away:      `onDeactivated` (then persist OR `onDestroyed`)
/// * Revisit (cached):   `onActivated` (onCreated does not re-run)
///
/// ```swift
/// let router = HypenRouter()
/// let ctx = HypenGlobalContext(router: router)
/// let app = HypenApp()
///
/// let managed = ManagedRouter(router: router, registry: app, globalContext: ctx)
/// managed.addRoute(RouteDefinition(path: "/", component: "HomePage"))
/// managed.addRoute(RouteDefinition(path: "/counter", component: "Counter"))
/// managed.start()
///
/// router.push("/counter") // auto-mounts Counter, unmounts HomePage
/// ```
public final class ManagedRouter: @unchecked Sendable {
    private let lock = NSLock()
    private let router: HypenRouter
    private let registry: HypenApp
    private let globalContext: HypenGlobalContext
    /// Optional shared engine. When set, mounted modules reuse this
    /// engine (so their action handlers are routable from the same
    /// `dispatchAction` call site the RemoteSession uses) and `start()`
    /// installs the reserved `router.*` action namespace on it. Leave
    /// nil to keep the standalone behaviour where each mounted module
    /// spins up its own `NativeEngine`.
    private let sharedEngine: NativeEngine?
    /// Sink for patches produced by mounted route modules. Each
    /// nested ModuleInstance generates its own state-change patches
    /// (via `engine.updateState(scope:)`) and surfaces them through
    /// `onPatches`. The session owns the WebSocket write path and
    /// registers its patch-forwarding closure here at construction so
    /// every mounted route's patches flow back to the client. Without
    /// this, HomePage's `onCreated`-loaded feed silently disappears:
    /// patches are generated but have nowhere to go because the
    /// nested ModuleInstance's `patchCallbacks` array is empty by
    /// default. Matches Kotlin's shared-engine render callback.
    private let patchSink: (@Sendable ([[String: Any]]) -> Void)?
    private var routes: [RouteDefinition] = []
    private var activeModule: ModuleInstance?
    private var activeRoute: RouteDefinition?
    private var unsubscribe: (() -> Void)?
    private var persistedModules: [String: ModuleInstance] = [:]
    /// The connection's device plane (RFC 001), bound to every route module
    /// this router mounts so their activations own device work.
    private var devicePlane: DevicePlane?
    private let log = HypenLoggers.router

    public init(
        router: HypenRouter,
        registry: HypenApp,
        globalContext: HypenGlobalContext,
        engine: NativeEngine? = nil,
        onPatches: (@Sendable ([[String: Any]]) -> Void)? = nil
    ) {
        self.router = router
        self.registry = registry
        self.globalContext = globalContext
        self.sharedEngine = engine
        self.patchSink = onPatches
    }

    /// Add a route definition.
    @discardableResult
    public func addRoute(_ route: RouteDefinition) -> ManagedRouter {
        lock.lock()
        defer { lock.unlock() }
        routes.append(route)
        return self
    }

    /// Start listening for route changes and mount the initial route.
    ///
    /// Also installs the reserved `@router.*` engine action handlers
    /// (push / replace / back / forward) on the shared engine when one
    /// was supplied at construction time — matches the TS and Go SDKs
    /// so DSL authors can write `.onClick(@router.push, to: "/x")`
    /// without per-example wiring.
    public func start() {
        lock.lock()
        if unsubscribe != nil {
            lock.unlock()
            return
        }
        unsubscribe = router.onNavigate { [weak self] _, to in
            self?.handleRouteChange(to)
        }
        let initialPath = router.getCurrentPath()
        lock.unlock()

        installRouterActions()

        // Mount initial route
        handleRouteChange(initialPath)
    }

    /// Register handlers for the reserved `router.*` action namespace
    /// on the shared engine. No-op when no shared engine is set.
    private func installRouterActions() {
        guard let engine = sharedEngine else { return }
        let router = self.router
        // DispatchQueue.global().async defers each router mutation off
        // the engine's action-dispatch call stack so we don't re-enter
        // the WASM state proxy (same reason the TS SDK queues a
        // microtask and the Go SDK uses `go func`).
        let defer_ = { (work: @escaping @Sendable () -> Void) in
            DispatchQueue.global().async(execute: work)
        }
        let readTo: (Any?) -> String? = { payload in
            guard let dict = payload as? [String: Any],
                  let to = dict["to"] as? String,
                  !to.isEmpty else { return nil }
            return to
        }
        engine.onAction("router.push") { _, payload in
            if let to = readTo(payload) { defer_ { router.push(to) } }
        }
        engine.onAction("router.replace") { _, payload in
            if let to = readTo(payload) { defer_ { router.replace(to) } }
        }
        engine.onAction("router.back") { _, _ in defer_ { router.back() } }
        // `router.forward` — HypenRouter has no forward() on the server
        // side (history only exists on the client), so the handler is a
        // no-op here. Registering it still prevents the engine from
        // complaining that the reserved action name is unhandled.
        engine.onAction("router.forward") { _, _ in }
    }

    /// Stop listening and unmount all modules.
    public func stop() {
        lock.lock()
        let unsub = unsubscribe
        unsubscribe = nil
        lock.unlock()

        unsub?()
        unmountActive()

        // Destroy all persisted modules outside the lock. Instances in
        // this map are inactive (they were deactivated when persisted),
        // so `destroy()` just fires `onDestroyed`.
        lock.lock()
        let persisted = persistedModules
        persistedModules.removeAll()
        lock.unlock()

        for (moduleId, instance) in persisted {
            instance.destroy()
            globalContext.unregisterModule(moduleId)
            // Full stop: these are gone for good, so drop them from the
            // engine too. See `executeUnmount` for why this call belongs on
            // the destroy path and nowhere else.
            instance.engine.unregisterModule(instance.engineScope)
        }
    }

    /// Bind (or unbind, with nil) the connection's device plane: the active
    /// and persisted route modules are attached now, every module mounted
    /// later before it activates.
    public func attachDevice(_ plane: DevicePlane?) {
        lock.lock()
        devicePlane = plane
        lock.unlock()
        for instance in liveInstances() { instance.attachDevice(plane) }
    }

    /// The active route module plus every persisted (cached) one.
    public func liveInstances() -> [ModuleInstance] {
        lock.lock()
        defer { lock.unlock() }
        var out: [ModuleInstance] = []
        if let active = activeModule { out.append(active) }
        out.append(contentsOf: persistedModules.values)
        return out
    }

    /// Get the currently active module instance.
    public func getActiveModule() -> ModuleInstance? {
        lock.lock()
        defer { lock.unlock() }
        return activeModule
    }

    /// Get the currently active route.
    public func getActiveRoute() -> RouteDefinition? {
        lock.lock()
        defer { lock.unlock() }
        return activeRoute
    }

    // MARK: - Private

    private func handleRouteChange(_ path: String) {
        // Compute decisions under lock
        lock.lock()
        let matched = matchRoute(path)

        guard let matched = matched else {
            // Unmount active without holding lock during lifecycle
            let unmountInfo = getUnmountInfo()
            activeModule = nil
            activeRoute = nil
            lock.unlock()
            executeUnmount(unmountInfo)
            return
        }

        // Same route, skip
        if let current = activeRoute, current.path == matched.path {
            lock.unlock()
            return
        }

        // Gather unmount info and mount info under lock
        let unmountInfo = getUnmountInfo()
        activeModule = nil
        activeRoute = nil

        // Prepare mount info
        var def = matched.module
        if def == nil {
            def = registry.get(matched.component)
        }
        let mountDef = def
        let moduleId = (def?.name ?? matched.component).lowercased()
        // Remove from cache while active so a concurrent navigation
        // can't double-mount the same instance.
        let persisted = persistedModules.removeValue(forKey: moduleId)
        lock.unlock()

        // Execute unmount lifecycle (deactivate + destroy/persist)
        // outside the lock.
        executeUnmount(unmountInfo)

        // Mount
        if let persisted = persisted {
            lock.lock()
            activeModule = persisted
            activeRoute = matched
            lock.unlock()
            // Fire onActivated on the restored instance.
            persisted.activate()
            return
        }

        guard let def = mountDef else {
            lock.lock()
            activeRoute = matched
            lock.unlock()
            return
        }

        let instance: ModuleInstance
        if let sharedEngine = sharedEngine {
            // asNested keeps the primary slot (App) intact — the default
            // path calls engine.setModule and clobbers the initial tree's
            // bindings. initialPatchCallback must be wired *before* init
            // fires onCreated, otherwise first-load patches (e.g.
            // HomePage's feed) are dropped because the nested instance's
            // patchCallbacks are still empty.
            instance = ModuleInstance(
                definition: def,
                engine: sharedEngine,
                globalContext: globalContext,
                router: router,
                asNested: true,
                initialPatchCallback: patchSink
            )
        } else {
            guard let fresh = try? ModuleInstance(definition: def) else {
                log.error("Failed to mount module '%@': native engine init failed", moduleId)
                lock.lock()
                activeRoute = matched
                lock.unlock()
                return
            }
            instance = fresh
        }
        globalContext.registerModule(moduleId, instance: instance)

        lock.lock()
        activeModule = instance
        activeRoute = matched
        let plane = devicePlane
        lock.unlock()
        // Bound before activation, so the first activation is registered
        // with the connection's broker.
        instance.attachDevice(plane)

        // Fire onActivated after construction (onCreated has already run
        // in the instance's init block).
        instance.activate()

        log.debug("Mounted module: %@", moduleId)
    }

    private func matchRoute(_ path: String) -> RouteDefinition? {
        for route in routes {
            if router.matchPath(pattern: route.path, path: path) != nil {
                return route
            }
        }
        return nil
    }

    /// Info needed to unmount, gathered under lock.
    private struct UnmountInfo {
        let module: ModuleInstance
        let moduleId: String
        let persist: Bool
    }

    /// Gather unmount info while lock is held. Does NOT release the lock.
    private func getUnmountInfo() -> UnmountInfo? {
        guard let module = activeModule, let route = activeRoute else { return nil }

        var def = route.module
        if def == nil {
            def = registry.get(route.component)
        }

        var moduleId = route.component.lowercased()
        if let name = def?.name, !name.isEmpty {
            moduleId = name.lowercased()
        }

        // Persistence default: any route backed by a module definition
        // persists unless the definition explicitly opts out via
        // `persist: false`. Routes with no module definition have
        // nothing to persist.
        //
        //   definition present & persist != false  →  cache the instance
        //   definition present & persist == false  →  destroy the instance
        //   definition missing                     →  nothing to persist
        let persist: Bool
        if let d = def {
            persist = d.persist != false
        } else {
            persist = false
        }
        return UnmountInfo(module: module, moduleId: moduleId, persist: persist)
    }

    /// Execute unmount lifecycle outside lock.
    private func executeUnmount(_ info: UnmountInfo?) {
        guard let info = info else { return }

        // Always deactivate first — regardless of whether we persist
        // or destroy — so onDeactivated → (onDestroyed) ordering holds.
        info.module.deactivate()

        if info.persist {
            lock.lock()
            persistedModules[info.moduleId] = info.module
            lock.unlock()
            // Deliberately still registered in the engine (and in
            // GlobalContext). An off-screen module keeps its state and actions
            // so siblings can read it and so returning to the route doesn't
            // replay `onCreated`. Unregistering here would take both away and
            // break the persist cache — which is why
            // `NativeEngine.unregisterModule` is a destroy-path call only.
        } else {
            info.module.destroy()
            globalContext.unregisterModule(info.moduleId)
            // Destroyed, not persisted — so its actions must stop being
            // externally dispatchable too. Unregister by the instance's own
            // engine scope rather than `moduleId`: the two agree for every
            // named module, but a route carrying an unnamed inline definition
            // registers under the engine's "Module" fallback.
            info.module.engine.unregisterModule(info.module.engineScope)
            log.debug("Unmounted module: %@", info.moduleId)
        }
    }

    private func unmountActive() {
        lock.lock()
        let info = getUnmountInfo()
        activeModule = nil
        activeRoute = nil
        lock.unlock()
        executeUnmount(info)
    }
}

// MARK: - Logger extension

extension HypenLoggers {
    public static let router = HypenLogger("HypenRouter")
}
