import Foundation

/// Protocol for dispatching actions to the Hypen engine
public protocol ActionDispatcher: Sendable {
    /// Dispatch an action with an optional payload
    func dispatch(action: String, payload: [String: Any]?)
}

/// Default implementation that dispatches to a RemoteEngine
public final class RemoteActionDispatcher: ActionDispatcher, @unchecked Sendable {
    private weak var _engine: RemoteEngine?

    @MainActor
    public init(engine: RemoteEngine) {
        self._engine = engine
    }

    public func dispatch(action: String, payload: [String: Any]?) {
        // Serialize payload to data, then deserialize on main thread
        // This creates a copy that can be safely sent across isolation boundaries
        let payloadData: Data?
        if let payload = payload {
            payloadData = try? JSONSerialization.data(withJSONObject: payload)
        } else {
            payloadData = nil
        }

        DispatchQueue.main.async { [weak self] in
            let deserializedPayload: [String: Any]?
            if let data = payloadData {
                deserializedPayload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            } else {
                deserializedPayload = nil
            }
            self?._engine?.dispatchAction(action, payload: deserializedPayload)
        }
    }
}

/// Mock dispatcher for testing
public final class MockActionDispatcher: ActionDispatcher, @unchecked Sendable {
    public struct DispatchedAction: @unchecked Sendable {
        public let action: String
        public let payload: [String: Any]?
    }

    private let lock = NSLock()
    private var _dispatchedActions: [DispatchedAction] = []

    public var dispatchedActions: [DispatchedAction] {
        lock.lock()
        defer { lock.unlock() }
        return _dispatchedActions
    }

    public init() {}

    public func dispatch(action: String, payload: [String: Any]?) {
        lock.lock()
        defer { lock.unlock() }
        _dispatchedActions.append(DispatchedAction(action: action, payload: payload))
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        _dispatchedActions.removeAll()
    }
}

/// Associates component actions with a live engine node. The engine resolves
/// the module; no caller-provided module name is used as routing authority.
public struct NodeActionDispatcher: ActionDispatcher {
    public let base: ActionDispatcher
    public let node: String

    public init(base: ActionDispatcher, node: String) { self.base = base; self.node = node }

    public func dispatch(action: String, payload: [String: Any]?) {
        if action == "__hypen_dispatch" { base.dispatch(action: action, payload: payload); return }
        base.dispatch(action: "__hypen_dispatch", payload: [
            "node": node, "action": action, "payload": payload ?? [:],
        ])
    }
}
