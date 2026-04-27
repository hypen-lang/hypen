import Foundation

// MARK: - EventKey

/// Type-safe event identifier.
///
/// ```swift
/// let userCreated = EventKey<String>("user:created")
/// let counterChanged = EventKey<Int>("counter:changed")
/// ```
public struct EventKey<T>: Hashable, Sendable {
    public let name: String

    public init(_ name: String) {
        self.name = name
    }

    public static func == (lhs: EventKey, rhs: EventKey) -> Bool {
        lhs.name == rhs.name
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(name)
    }
}

// MARK: - TypedEventEmitter

/// Type-safe event emitter.
///
/// Events are identified by `EventKey` instances which carry the payload type.
///
/// ```swift
/// let emitter = TypedEventEmitter()
/// let unsub = emitter.on(HypenEvents.moduleCreated) { event in
///     print("Module created: \(event.moduleId)")
/// }
/// emitter.emit(HypenEvents.moduleCreated, payload: .init(moduleId: "counter"))
/// unsub() // unsubscribe
/// ```
public final class TypedEventEmitter: @unchecked Sendable {
    private let lock = NSLock()
    private var listeners: [String: [(id: UUID, handler: (Any) -> Void)]] = [:]
    private let log = HypenLoggers.events

    public init() {}

    /// Subscribe to an event. Returns an unsubscribe closure.
    @discardableResult
    public func on<T>(_ key: EventKey<T>, handler: @escaping (T) -> Void) -> () -> Void {
        let id = UUID()
        let wrapper: (Any) -> Void = { payload in
            if let typed = payload as? T {
                handler(typed)
            }
        }

        lock.lock()
        if listeners[key.name] == nil {
            listeners[key.name] = []
        }
        listeners[key.name]?.append((id: id, handler: wrapper))
        lock.unlock()

        return { [weak self] in
            self?.lock.lock()
            self?.listeners[key.name]?.removeAll { $0.id == id }
            self?.lock.unlock()
        }
    }

    /// Subscribe for a single emission only.
    @discardableResult
    public func once<T>(_ key: EventKey<T>, handler: @escaping (T) -> Void) -> () -> Void {
        var unsub: (() -> Void)?
        unsub = on(key) { payload in
            unsub?()
            handler(payload)
        }
        return { unsub?() }
    }

    /// Emit an event with a payload.
    public func emit<T>(_ key: EventKey<T>, payload: T) {
        lock.lock()
        let handlers = listeners[key.name]?.map { $0.handler } ?? []
        lock.unlock()

        for handler in handlers {
            handler(payload)
        }
    }

    /// Remove all listeners for a specific event.
    public func removeAllListeners<T>(_ key: EventKey<T>) {
        lock.lock()
        defer { lock.unlock() }
        listeners.removeValue(forKey: key.name)
    }

    /// Remove all listeners for all events.
    public func clearAll() {
        lock.lock()
        defer { lock.unlock() }
        listeners.removeAll()
    }

    /// Get the number of listeners for an event.
    public func listenerCount<T>(_ key: EventKey<T>) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return listeners[key.name]?.count ?? 0
    }

    /// Get all event names that have listeners.
    public func eventNames() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(listeners.keys)
    }
}

// MARK: - Framework Events

/// Pre-defined framework events matching the Kotlin/Go SDKs.
public enum HypenEvents {
    public struct ModuleCreated: Sendable {
        public let moduleId: String
        public init(moduleId: String) { self.moduleId = moduleId }
    }

    public struct ModuleDestroyed: Sendable {
        public let moduleId: String
        public init(moduleId: String) { self.moduleId = moduleId }
    }

    public struct RouteChanged: Sendable {
        public let from: String?
        public let to: String
        public init(from: String?, to: String) { self.from = from; self.to = to }
    }

    public struct StateUpdated: Sendable {
        public let moduleId: String
        public let paths: [String]
        public init(moduleId: String, paths: [String]) { self.moduleId = moduleId; self.paths = paths }
    }

    public struct ActionDispatched: @unchecked Sendable {
        public let moduleId: String
        public let actionName: String
        public let payload: Any?
        public init(moduleId: String, actionName: String, payload: Any? = nil) {
            self.moduleId = moduleId; self.actionName = actionName; self.payload = payload
        }
    }

    public struct FrameworkError: Sendable {
        public let message: String
        public let error: Error?
        public let context: String?
        public init(message: String, error: Error? = nil, context: String? = nil) {
            self.message = message; self.error = error; self.context = context
        }
    }

    public static let moduleCreated = EventKey<ModuleCreated>("module:created")
    public static let moduleDestroyed = EventKey<ModuleDestroyed>("module:destroyed")
    public static let routeChanged = EventKey<RouteChanged>("route:changed")
    public static let stateUpdated = EventKey<StateUpdated>("state:updated")
    public static let actionDispatched = EventKey<ActionDispatched>("action:dispatched")
    public static let error = EventKey<FrameworkError>("error")
}

// MARK: - Logger extension

extension HypenLoggers {
    public static let events = HypenLogger("HypenEvents")
}
