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

    /// Set several key paths at once, notifying listeners ONCE with every
    /// path. This is the batching primitive the `__hypen_pin` handler uses
    /// so `path.xKey` / `path.yKey` reach the engine in a single
    /// `updateState` (one patch flush, one frame on the renderer) instead
    /// of two. Paths are applied in dictionary iteration order; they are
    /// distinct keys so the order does not affect the result.
    public func update(_ values: [String: Any]) {
        guard !values.isEmpty else { return }
        lock.lock()
        var newData = data
        var paths: [String] = []
        var newValues: [String: Any] = [:]
        for (path, value) in values {
            setNestedValue(&newData, path: path, value: value)
            paths.append(path)
            newValues[path] = value
        }
        data = newData
        let callbacks = changeCallbacks

        let change = StateChange(paths: paths, newValues: newValues)
        lock.unlock()

        for callback in callbacks {
            callback(change)
        }
    }

    /// Move element `from` of the array at `fromPath` so it becomes index
    /// `to` of the array at `toPath` (the two paths may be equal). This is
    /// the `__hypen_reorder` primitive (hypen-web/docs/dnd.md)
    /// and delegates to the engine's canonical `portable_path_move`, so the
    /// semantics — `to` is the FINAL index clamped to `[0, len]` after
    /// removal, `from == to` on one array is a no-op that still succeeds,
    /// a destination re-addressed when it lives under a later sibling of
    /// the source array, a destination inside the moved element refused —
    /// match every other SDK byte for byte.
    ///
    /// Returns `false` and leaves the state untouched (no notification)
    /// unless both paths resolve to arrays and `from` is in range. On
    /// success a change is notified for both paths (collapsed to the
    /// common ancestor when one path contains the other) carrying the
    /// updated arrays, so the engine re-renders the affected `ForEach`es
    /// and persistence sees the write.
    @discardableResult
    public func move(fromPath: String, from: Int, toPath: String, to: Int) -> Bool {
        lock.lock()
        var newData = data
        guard moveNestedValue(&newData, fromPath: fromPath, from: from, toPath: toPath, to: to) else {
            lock.unlock()
            return false
        }
        data = newData
        let callbacks = changeCallbacks

        let paths = Self.changedPathsForMove(fromPath: fromPath, toPath: toPath)
        var newValues: [String: Any] = [:]
        for path in paths {
            if let value = getNestedValue(newData, path: path) {
                newValues[path] = value
            }
        }
        let change = StateChange(paths: paths, newValues: newValues)
        lock.unlock()

        for callback in callbacks {
            callback(change)
        }
        return true
    }

    /// The paths a successful move dirties: both arrays, collapsed to the
    /// shorter one when it is an ancestor of the other (a destination
    /// under `entries.2.children` is re-addressed by the removal, so the
    /// only stable path to report is `entries` itself).
    static func changedPathsForMove(fromPath: String, toPath: String) -> [String] {
        if fromPath == toPath { return [fromPath] }
        if isAncestorPath(fromPath, of: toPath) { return [fromPath] }
        if isAncestorPath(toPath, of: fromPath) { return [toPath] }
        return [fromPath, toPath]
    }

    private static func isAncestorPath(_ ancestor: String, of path: String) -> Bool {
        return ancestor.isEmpty || path.hasPrefix(ancestor + ".")
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

    /// Move `from` of the array at `fromPath` to index `to` of the array at
    /// `toPath`, replacing `dict` with the engine's result. Delegates to the
    /// canonical `portable_path_move` (see `move(fromPath:from:toPath:to:)`
    /// for the semantics), which returns `{"json": <updated>, "moved": bool}`.
    /// Returns the engine's `moved` flag; `dict` is untouched when it is
    /// `false` (including negative or out-of-`UInt32` indices, which the
    /// FFI cannot express).
    private func moveNestedValue(
        _ dict: inout [String: Any], fromPath: String, from: Int, toPath: String, to: Int
    ) -> Bool {
        guard let fromIndex = UInt32(exactly: from), let toIndex = UInt32(exactly: to) else {
            return false
        }
        guard let stateData = try? JSONSerialization.data(withJSONObject: dict, options: []),
              let stateJson = String(data: stateData, encoding: .utf8) else {
            return false
        }
        guard let resultJson = try? portablePathMove(
            valueJson: stateJson, fromPath: fromPath, from: fromIndex, toPath: toPath, to: toIndex
        ),
              let resultData = resultJson.data(using: .utf8),
              let result = try? JSONSerialization.jsonObject(
                with: resultData, options: []
              ) as? [String: Any],
              let moved = result["moved"] as? Bool, moved,
              let updated = result["json"] as? [String: Any] else {
            return false
        }
        dict = updated
        return true
    }
}
