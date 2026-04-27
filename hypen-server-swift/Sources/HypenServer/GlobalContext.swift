import Foundation

/// Protocol for cross-module communication.
///
/// Provides access to registered modules, events, and the router
/// from within action handlers and lifecycle hooks.
public protocol GlobalContext: AnyObject, Sendable {
    /// Get a module reference by ID.
    func getModule(_ id: String) -> ModuleReference?
    /// Check if a module exists.
    func hasModule(_ id: String) -> Bool
    /// Get all registered module IDs.
    func getModuleIds() -> [String]
    /// Get global state aggregated from all modules.
    func getGlobalState() -> [String: Any]
    /// Emit an event to all listeners.
    func emit(_ event: String, payload: Any?)
    /// Subscribe to an event. Returns unsubscribe closure.
    func on(_ event: String, handler: @escaping (Any?) -> Void) -> () -> Void
    /// Get the router.
    func getRouter() -> HypenRouter?
}

/// Reference to a module, used for cross-module communication.
public struct ModuleReference: @unchecked Sendable {
    public let id: String
    public let name: String?
    private let _getState: () -> [String: Any]
    private let _dispatchAction: (String, Any?) -> Void

    public init(
        id: String,
        name: String?,
        getState: @escaping () -> [String: Any],
        dispatchAction: @escaping (String, Any?) -> Void
    ) {
        self.id = id
        self.name = name
        self._getState = getState
        self._dispatchAction = dispatchAction
    }

    /// Get the module's current state snapshot.
    public func getState() -> [String: Any] {
        _getState()
    }

    /// Dispatch an action to this module.
    public func dispatchAction(_ name: String, payload: Any? = nil) {
        _dispatchAction(name, payload)
    }
}

/// Default implementation of GlobalContext.
///
/// ```swift
/// let ctx = HypenGlobalContext()
/// ctx.registerModule("counter", instance: counterInstance)
///
/// // From an action handler:
/// if let other = context?.getModule("profile") {
///     other.dispatchAction("refresh")
/// }
/// ```
public final class HypenGlobalContext: GlobalContext, @unchecked Sendable {
    private let lock = NSLock()
    private var modules: [String: ModuleInstance] = [:]
    private let events = TypedEventEmitter()
    private var stringListeners: [String: [(id: UUID, handler: (Any?) -> Void)]] = [:]
    private var _router: HypenRouter?

    public var router: HypenRouter? {
        get { lock.lock(); defer { lock.unlock() }; return _router }
        set { lock.lock(); defer { lock.unlock() }; _router = newValue }
    }

    public init(router: HypenRouter? = nil) {
        self._router = router
    }

    /// Register a module instance.
    public func registerModule(_ id: String, instance: ModuleInstance) {
        lock.lock()
        defer { lock.unlock() }
        modules[id] = instance
    }

    /// Unregister a module instance.
    public func unregisterModule(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        modules.removeValue(forKey: id)
    }

    // MARK: - GlobalContext Protocol

    public func getModule(_ id: String) -> ModuleReference? {
        lock.lock()
        guard let instance = modules[id] else {
            lock.unlock()
            return nil
        }
        lock.unlock()

        return ModuleReference(
            id: id,
            name: instance.moduleDefinition.name,
            getState: { instance.getState() },
            dispatchAction: { name, payload in instance.dispatchAction(name, payload: payload) }
        )
    }

    public func hasModule(_ id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return modules[id] != nil
    }

    public func getModuleIds() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(modules.keys)
    }

    public func getGlobalState() -> [String: Any] {
        lock.lock()
        let modulesCopy = modules
        lock.unlock()

        var state: [String: Any] = [:]
        for (id, instance) in modulesCopy {
            state[id] = instance.getState()
        }
        return state
    }

    public func emit(_ event: String, payload: Any?) {
        lock.lock()
        let handlers = stringListeners[event]?.map { $0.handler } ?? []
        lock.unlock()

        for handler in handlers {
            handler(payload)
        }
    }

    public func on(_ event: String, handler: @escaping (Any?) -> Void) -> () -> Void {
        let id = UUID()
        lock.lock()
        if stringListeners[event] == nil {
            stringListeners[event] = []
        }
        stringListeners[event]?.append((id: id, handler: handler))
        lock.unlock()

        return { [weak self] in
            self?.lock.lock()
            self?.stringListeners[event]?.removeAll { $0.id == id }
            self?.lock.unlock()
        }
    }

    public func getRouter() -> HypenRouter? {
        lock.lock()
        defer { lock.unlock() }
        return _router
    }

    /// Access the typed event emitter for framework events.
    public func typedEvents() -> TypedEventEmitter {
        return events
    }
}
