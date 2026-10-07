import Foundation

/// Drag-and-drop names shared with the renderers and the other SDKs
/// (`hypen-web/docs/dnd.md`).
///
/// Renderers resolve a drop into one of two reserved actions which every
/// [`ModuleInstance`] auto-registers next to `__hypen_bind`:
///
/// - [`reorderAction`] `{fromPath, from, toPath, to}` (or `{path, from, to}`
///   as shorthand for `fromPath == toPath`) — applied through
///   [`ObservableState.move(fromPath:from:toPath:to:)`], i.e. the engine's
///   `portable_path_move`.
/// - [`pinAction`] `{path, x, y, xKey?, yKey?}` — two path sets
///   (`path.xKey`, `path.yKey`) in ONE [`ObservableState.update(_:)`] batch.
///
/// Reserved-mode pinboards keep their positions under
/// `state["__dnd"][group][key] = {x, y}`. That subtree is ordinary module
/// state (it persists and re-streams like any other key) and the typed
/// builder's `encodeState` never clears top-level `__`-prefixed keys, so a
/// `Codable` state struct that declares no `x`/`y` cannot wipe it.
public enum HypenDnd {
    /// `__hypen_reorder` — move an item between/within bound arrays.
    public static let reorderAction = "__hypen_reorder"

    /// `__hypen_pin` — write a pinboard position.
    public static let pinAction = "__hypen_pin"

    /// Top-level state key holding reserved-mode pinboard positions.
    public static let reservedStateKey = "__dnd"

    /// Top-level keys with this prefix are runtime-owned and survive typed round-trips.
    public static let reservedKeyPrefix = "__"

    /// Item base path for a reserved-mode pin: `__dnd.<group>.<key>`.
    public static func reservedPinPath(group: String, key: String) -> String {
        return "\(reservedStateKey).\(group).\(key)"
    }

    /// Item base path for a user-field-mode pin: `<bindPath>.<index>`.
    public static func userPinPath(bindPath: String, index: Int) -> String {
        return "\(bindPath).\(index)"
    }

    /// Whether `key` is a runtime-owned top-level state key (`__dnd`, …).
    public static func isReservedKey(_ key: String) -> Bool {
        return key.hasPrefix(reservedKeyPrefix)
    }
}
