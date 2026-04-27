import Foundation
import HypenEngine

/// Reactive state container with path-based change tracking.
///
/// Mirrors the ObservableState from Go and Kotlin SDKs.
/// Tracks changes by string paths (e.g., "user.name", "items.0.title").
///
/// Paths are reported verbatim (relative to this state container). Owners
/// that need a module scope forward that scope to the engine separately.
public final class ObservableState: @unchecked Sendable {
    private let lock = NSLock()
    private var data: [String: Any]
    private var changeCallbacks: [(StateChange) -> Void] = []

    /// State change information.
    /// Sendable conformance via @unchecked — we ensure thread safety via lock.
    public struct StateChange: @unchecked Sendable {
        public let paths: [String]
        public let newValues: [String: Any]
    }

    public init(_ initialState: [String: Any]) {
        self.data = initialState
    }

    /// Get a value by key path.
    public func get(_ key: String) -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return getNestedValue(data, path: key)
    }

    /// Set a value by key path.
    public func set(_ key: String, _ value: Any) {
        lock.lock()
        var newData = data
        setNestedValue(&newData, path: key, value: value)
        data = newData
        let callbacks = changeCallbacks

        let change = StateChange(
            paths: [key],
            newValues: [key: value]
        )
        lock.unlock()

        for callback in callbacks {
            callback(change)
        }
    }

    /// Get a snapshot of the full state.
    public func snapshot() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return data
    }

    /// Replace the entire state, notifying all changed paths.
    public func replace(_ newState: [String: Any]) {
        lock.lock()
        let oldState = data
        data = newState
        let callbacks = changeCallbacks

        // Compute changed paths
        var paths: [String] = []
        var newValues: [String: Any] = [:]
        for (key, value) in newState {
            paths.append(key)
            newValues[key] = value
        }
        // Include removed keys
        for key in oldState.keys where newState[key] == nil {
            paths.append(key)
        }

        let change = StateChange(paths: paths, newValues: newValues)
        lock.unlock()

        for callback in callbacks {
            callback(change)
        }
    }

    /// Register a callback to be notified of state changes.
    public func onChange(_ callback: @escaping (StateChange) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        changeCallbacks.append(callback)
    }

    // MARK: - Nested Access Helpers
    //
    // Both helpers delegate to the engine's canonical
    // `portable_path_get` / `portable_path_set` via UniFFI. The local
    // [String: Any] ↔ JSON conversion happens through
    // JSONSerialization so we don't have to care about the exact
    // shape of what's stored in the dictionary.

    private func getNestedValue(_ dict: [String: Any], path: String) -> Any? {
        guard let stateData = try? JSONSerialization.data(withJSONObject: dict, options: []),
              let stateJson = String(data: stateData, encoding: .utf8) else {
            return nil
        }
        guard let resultJson = try? portablePathGet(valueJson: stateJson, path: path),
              let resultData = resultJson.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(
                with: resultData, options: [.fragmentsAllowed]
              ) else {
            return nil
        }
        return parsed is NSNull ? nil : parsed
    }

    private func setNestedValue(_ dict: inout [String: Any], path: String, value: Any) {
        guard !path.isEmpty else { return }
        guard let stateData = try? JSONSerialization.data(withJSONObject: dict, options: []),
              let stateJson = String(data: stateData, encoding: .utf8) else {
            return
        }
        let encodableValue: Any = (value as? NSNull) ?? value
        guard let valueData = try? JSONSerialization.data(
            withJSONObject: encodableValue,
            options: [.fragmentsAllowed]
        ),
              let valueJson = String(data: valueData, encoding: .utf8) else {
            return
        }
        guard let resultJson = try? portablePathSet(
            valueJson: stateJson, path: path, newValueJson: valueJson
        ),
              let resultData = resultJson.data(using: .utf8),
              let updated = try? JSONSerialization.jsonObject(
                with: resultData, options: []
              ) as? [String: Any] else {
            return
        }
        dict = updated
    }
}
