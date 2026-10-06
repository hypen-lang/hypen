import Foundation
import SwiftUI

private let log = HypenLoggers.renderer

/// The `__dnd.*` prop channel: vocabulary and defensive parsing.
///
/// Source of truth for the wire is `hypen-engine-rs/src/ir/dnd.rs`
/// (`DND_*_PROP`, `ACTIVATIONS`, `AXES`, `PIN_BOUNDS`, `PIN_UNITS`,
/// `RUNTIME_STATE_LABELS`, `EVENT_APPLICATORS`, `DEFAULT_BAND`), mirrored
/// by `@hypen-space/core/dnd` (`parseDndSource/Zone/Sort/Pin`,
/// `parseDndEnabled`, `parseDndString`). The contract every consumer is
/// written against is `hypen-web/docs/dnd.md`
///
/// Parsing mirrors `HypenAnim`: every channel validates independently and
/// degrades to `nil` (= "this node has no such role") rather than
/// throwing, so a malformed `__dnd.zone` can never poison a sibling
/// `__dnd.source` — warn-and-degrade, never a hard error on author input.
public enum HypenDnd {

    // MARK: - Wire prop names (§2)

    public static let propPrefix = "__dnd."
    public static let sourceProp = "__dnd.source"
    public static let sourcePayloadProp = "__dnd.sourcePayload"
    public static let sourceEnabledProp = "__dnd.sourceEnabled"
    public static let keyProp = "__dnd.key"
    public static let zoneProp = "__dnd.zone"
    public static let zoneIdProp = "__dnd.zoneId"
    public static let zoneEnabledProp = "__dnd.zoneEnabled"
    public static let sortProp = "__dnd.sort"
    public static let pinProp = "__dnd.pin"
    public static let pinGroupProp = "__dnd.pinGroup"

    /// Header-less `.states` poses (§2.1): `{"<label>": {"<loweredKey>": value}}`.
    /// Mirrors `anim::ANIM_STATE_POSES_PROP`.
    public static let statePosesProp = "__anim.statePoses"

    /// The sortable / pinboard write target — the node's ordinary `bind`
    /// prop (the dotted state path).
    public static let bindProp = "bind"

    // MARK: - Reserved outcome actions (§4.1)

    public static let reorderAction = "__hypen_reorder"
    public static let pinAction = "__hypen_pin"
    /// Root key of the reserved pin-position subtree in module state (§3).
    public static let reservedStateKey = "__dnd"

    // MARK: - Runtime state labels (§2.1)

    /// On the dragged source while lifted.
    public static let labelLifted = "lifted"
    /// On a zone while a compatible drag hovers it.
    public static let labelOver = "over"

    // MARK: - Event applicators (§2.2 / §4.2)

    public static let eventNames: [String] = [
        "onDragStart", "onDragOver", "onDrop", "onSort", "onPin", "onDragEnd",
    ]
    /// Reserved named argument on `.onDragOver(@a, dwell:)` — read by the
    /// renderer and stripped from the dispatched payload.
    public static let dwellArgument = "dwell"
    /// Default hover dwell before `.onDragOver` fires, in milliseconds.
    public static let defaultDwellMs: Double = 500

    // MARK: - Pinned runtime constants (§6)

    /// Pointer travel (points) below which a gesture is a tap, not a drag.
    public static let slopPoints: CGFloat = 6
    /// Long-press activation delay (`activation: press`, and `auto` on
    /// touch outside an axis-constrained sortable).
    public static let pressSeconds: TimeInterval = 0.3
    /// Post-drop hold window before local transforms are released when no
    /// engine re-render (`Move` / translate `SetProp`) lands (§6.3).
    public static let cleanupTimeoutSeconds: TimeInterval = 0.5
    /// Sibling gap-opening transition (DOM parity: `transform 150ms ease-out`).
    public static let shiftSeconds: TimeInterval = 0.15
    /// Default `band` for `.dropZone` — the middle 50% along the sort axis
    /// means "into".
    public static let defaultBand: Double = 0.5
    /// `zIndex` the lifted item is raised to for the duration of the drag.
    public static let raisedZIndex: Double = 1_000_000
    /// Prefix of the named coordinate space each host view declares
    /// (`HypenDndCoordinator.coordinateSpaceName` appends the coordinator's
    /// identity so nested hosts never alias); frames and pointer locations
    /// are both resolved in it.
    public static let coordinateSpaceName = "hypen.dnd"

    /// Base prop names a live drag owns on the dragged node: engine
    /// `SetProp`s to these are deferred until release (§6.6).
    public static let translateBaseNames: Set<String> = ["translateX", "translateY"]
}

// MARK: - Vocabulary

public enum DndActivation: String, Sendable, CaseIterable {
    case auto
    case slop
    case press
    case immediate
}

public enum DndAxis: String, Sendable, CaseIterable {
    case x
    case y
}

public enum DndBounds: String, Sendable, CaseIterable {
    case clamp
    case free
}

public enum DndUnits: String, Sendable, CaseIterable {
    case px
    case fraction
}

// MARK: - Channel specs

/// `__dnd.source` — `.draggable`.
public struct DndSourceSpec: Equatable, Sendable {
    public let group: String?
    /// This subtree is the only lift surface.
    public let handle: Bool
    public let activation: DndActivation

    public init(group: String?, handle: Bool, activation: DndActivation) {
        self.group = group
        self.handle = handle
        self.activation = activation
    }
}

/// `__dnd.zone` — `.dropZone`.
public struct DndZoneSpec: Equatable, Sendable {
    public let group: String?
    /// Fraction (0..1) of a sortable item along the sort axis that resolves
    /// to "into".
    public let band: Double
    /// `files: true` — the zone also reacts while files dragged in from
    /// outside the app hover it ("Files from the OS" in `dnd.md`). Absent ⇒
    /// `false`: an in-app-only zone, exactly as before.
    public let files: Bool
    /// `accept:` — an `<input accept>` filter (`"image/*"`, `".pdf"`,
    /// comma-separated). `nil` (or blank) = any file. Only meaningful with
    /// `files: true`.
    public let accept: String?

    public init(group: String?, band: Double, files: Bool = false, accept: String? = nil) {
        self.group = group
        self.band = band
        self.files = files
        self.accept = accept
    }
}

/// `__dnd.sort` — `.sortable`.
public struct DndSortSpec: Equatable, Sendable {
    public let group: String?
    public let axis: DndAxis

    public init(group: String?, axis: DndAxis) {
        self.group = group
        self.axis = axis
    }
}

/// `__dnd.pin` — `.pinboard`.
public struct DndPinSpec: Equatable, Sendable {
    public let group: String?
    public let xKey: String
    public let yKey: String
    public let grid: Double?
    public let bounds: DndBounds
    public let units: DndUnits

    public init(
        group: String?,
        xKey: String = "x",
        yKey: String = "y",
        grid: Double? = nil,
        bounds: DndBounds = .clamp,
        units: DndUnits = .px
    ) {
        self.group = group
        self.xKey = xKey
        self.yKey = yKey
        self.grid = grid
        self.bounds = bounds
        self.units = units
    }
}

/// A node's whole `__dnd.*` surface (plus the header-less `.states`
/// poses), parsed from its props. Not `Equatable`: the payload is an
/// arbitrary JSON value.
public struct NodeDndSpecs {
    public var source: DndSourceSpec?
    /// `__dnd.sourcePayload` is present on the node (its value may be JSON
    /// null — `NSNull` — and still counts as "given").
    public var hasPayload: Bool
    public var payload: Any?
    public var sourceEnabled: Bool
    /// `__dnd.key` — the `ForEach` item key; `nil` outside a `ForEach`
    /// (renderers fall back to the node id).
    public var key: String?
    public var zone: DndZoneSpec?
    public var zoneId: String?
    public var zoneEnabled: Bool
    public var sort: DndSortSpec?
    public var pin: DndPinSpec?
    public var pinGroup: String?
    /// `__anim.statePoses` — `label → { loweredPropKey: value }`.
    public var poses: [String: [String: Any]]?

    /// Computed, not stored: the struct holds an `Any?` payload and so is
    /// not `Sendable`, which Swift 6 rejects for a stored static.
    public static var empty: NodeDndSpecs {
        NodeDndSpecs(
            source: nil, hasPayload: false, payload: nil, sourceEnabled: true,
            key: nil, zone: nil, zoneId: nil, zoneEnabled: true,
            sort: nil, pin: nil, pinGroup: nil, poses: nil
        )
    }

    /// True when the node plays any DnD role at all.
    public var hasRole: Bool {
        source != nil || zone != nil || sort != nil || pin != nil
    }

    /// True when the node is a container the runtime owns children of.
    public var isContainer: Bool {
        sort != nil || pin != nil
    }

    /// True when the node carries nothing the runtime cares about — the
    /// cheap gate the view layer uses to skip DnD work entirely.
    public var isEmpty: Bool {
        !hasRole && poses == nil
    }
}

// MARK: - Defensive parsing

extension HypenDnd {

    /// A non-empty string, else `nil` (`parseGroup`).
    static func group(_ value: Any?) -> String? {
        guard let raw = value as? String, !raw.isEmpty else { return nil }
        return raw
    }

    /// A finite number. Bools bridge to `NSNumber` on Apple platforms, so
    /// they are rejected explicitly — by CF type, not `is Bool`, because a
    /// JSON `0` / `1` also answers `is Bool` and `band: 1` is a legal value.
    static func finiteNumber(_ value: Any?) -> Double? {
        guard let value = value, !(value is NSNull) else { return nil }
        guard let number = value as? NSNumber else { return nil }
        if CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID() { return nil }
        let doubleValue = number.doubleValue
        return doubleValue.isFinite ? doubleValue : nil
    }

    static func clamp01(_ value: Double) -> Double {
        min(max(value, 0), 1)
    }

    /// The raw `onDragOver.dwell` argument → milliseconds. Accepts a number
    /// or a numeric string (a Remote UI host passing raw JSON through); a
    /// negative, non-finite or non-numeric value warns and yields `nil` so
    /// the caller falls back to `defaultDwellMs` — the warn-and-degrade rule
    /// every other renderer applies (DOM `applicators/events.ts`, Canvas,
    /// desktop `dwell_for`, Android `DndSpecs.kt`). Called once per zone
    /// entry and once per dispatch, never per frame, so the warning is
    /// emitted per read rather than deduplicated.
    static func parseDwellMs(_ raw: Any?) -> Double? {
        let number: Double?
        if let str = raw as? String {
            number = Double(str.trimmingCharacters(in: .whitespacesAndNewlines))
        } else {
            number = finiteNumber(raw)
        }
        guard let ms = number, ms.isFinite, ms >= 0 else {
            log.warn("dnd: onDragOver dwell must be a non-negative number, got: \(String(describing: raw ?? NSNull())); using the default")
            return nil
        }
        return ms
    }

    /// `__dnd.source` → spec, or `nil` when the channel is not an object.
    /// Missing or invalid fields degrade to the §2 defaults (the engine
    /// always fills them, so a hole here is version drift, not author error).
    public static func parseSource(_ value: Any?) -> DndSourceSpec? {
        guard let obj = HypenAnim.channelObject(value) else { return nil }
        let activation = (obj["activation"] as? String).flatMap(DndActivation.init(rawValue:)) ?? .auto
        return DndSourceSpec(
            group: group(obj["group"]),
            handle: (obj["handle"] as? Bool) == true,
            activation: activation
        )
    }

    /// `__dnd.zone` → spec, or `nil`. `band` outside `[0,1]` clamps; a
    /// non-number degrades to `defaultBand`. `files` is on only for an
    /// explicit `true` (a raw-JSON `"true"` is tolerated); `accept` is kept
    /// only alongside `files` and only as a non-blank string.
    public static func parseZone(_ value: Any?) -> DndZoneSpec? {
        guard let obj = HypenAnim.channelObject(value) else { return nil }
        let band = finiteNumber(obj["band"]).map(clamp01) ?? defaultBand
        let files: Bool
        if let flag = obj["files"] as? NSNumber, CFGetTypeID(flag as CFTypeRef) == CFBooleanGetTypeID() {
            files = flag.boolValue
        } else {
            files = (obj["files"] as? String) == "true"
        }
        var accept: String?
        if files, let raw = obj["accept"] as? String,
           !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            accept = raw
        }
        return DndZoneSpec(group: group(obj["group"]), band: band, files: files, accept: accept)
    }

    /// `__dnd.sort` → spec, or `nil`. `axis` defaults to `y`.
    public static func parseSort(_ value: Any?) -> DndSortSpec? {
        guard let obj = HypenAnim.channelObject(value) else { return nil }
        let axis = (obj["axis"] as? String).flatMap(DndAxis.init(rawValue:)) ?? .y
        return DndSortSpec(group: group(obj["group"]), axis: axis)
    }

    /// `__dnd.pin` → spec, or `nil`. Defaults: `xKey "x"`, `yKey "y"`,
    /// `grid nil` (also for a non-positive or non-finite grid), `bounds
    /// clamp`, `units px`.
    public static func parsePin(_ value: Any?) -> DndPinSpec? {
        guard let obj = HypenAnim.channelObject(value) else { return nil }
        func key(_ raw: Any?, _ fallback: String) -> String {
            guard let str = raw as? String, !str.isEmpty else { return fallback }
            return str
        }
        let grid = finiteNumber(obj["grid"]).flatMap { $0 > 0 ? $0 : nil }
        return DndPinSpec(
            group: group(obj["group"]),
            xKey: key(obj["xKey"], "x"),
            yKey: key(obj["yKey"], "y"),
            grid: grid,
            bounds: (obj["bounds"] as? String).flatMap(DndBounds.init(rawValue:)) ?? .clamp,
            units: (obj["units"] as? String).flatMap(DndUnits.init(rawValue:)) ?? .px
        )
    }

    /// A bindable enabled flag (`__dnd.sourceEnabled` / `__dnd.zoneEnabled`).
    /// Absent (or JSON null) ⇒ `true`; only an explicit `false` (or the
    /// string `"false"`, for raw-JSON hosts) disables.
    public static func parseEnabled(_ value: Any?) -> Bool {
        guard let value = value, !(value is NSNull) else { return true }
        if let flag = value as? Bool { return flag }
        if let str = value as? String { return str != "false" }
        return true
    }

    /// `__dnd.key` / `__dnd.zoneId` / `__dnd.pinGroup` — a non-empty
    /// string, else `nil` so callers apply their documented fallback (node
    /// id / resolved `id` prop). Numbers are tolerated (a `ForEach` keyed
    /// by a numeric id) and stringified the way JavaScript would.
    public static func parseString(_ value: Any?) -> String? {
        if let str = value as? String { return str.isEmpty ? nil : str }
        guard let number = finiteNumber(value) else { return nil }
        if number == number.rounded(), abs(number) < 1e15 {
            return String(Int(number))
        }
        return String(number)
    }

    /// `__anim.statePoses` → `label → pose`, dropping non-object entries.
    /// `nil` when the channel is absent or not an object.
    public static func parseStatePoses(_ value: Any?) -> [String: [String: Any]]? {
        guard let obj = HypenAnim.channelObject(value) else { return nil }
        var out: [String: [String: Any]] = [:]
        for (label, pose) in obj {
            guard let poseObj = pose as? [String: Any] else { continue }
            out[label] = poseObj
        }
        return out
    }

    /// Parse a node's whole DnD surface. Never throws; each channel
    /// degrades independently.
    public static func parseSpecs(_ props: [String: Any]) -> NodeDndSpecs {
        NodeDndSpecs(
            source: parseSource(props[sourceProp]),
            hasPayload: props[sourcePayloadProp] != nil,
            payload: props[sourcePayloadProp],
            sourceEnabled: parseEnabled(props[sourceEnabledProp]),
            key: parseString(props[keyProp]),
            zone: parseZone(props[zoneProp]),
            zoneId: parseString(props[zoneIdProp]),
            zoneEnabled: parseEnabled(props[zoneEnabledProp]),
            sort: parseSort(props[sortProp]),
            pin: parsePin(props[pinProp]),
            pinGroup: parseString(props[pinGroupProp]),
            poses: parseStatePoses(props[statePosesProp])
        )
    }

    /// The base applicator name of a lowered prop key (`translateX.0` →
    /// `translateX`, `padding@md.0` → `padding@md`).
    static func baseName(_ key: String) -> String {
        guard let dot = key.firstIndex(of: ".") else { return key }
        return String(key[..<dot])
    }

    /// A pose key qualified by a breakpoint or a state variant
    /// (`padding@md.0`, `backgroundColor:hover.0`) — skipped by the pose
    /// overlay with a one-time warning (DOM / desktop parity).
    static func isVariantQualified(_ key: String) -> Bool {
        let base = baseName(key)
        return base.contains("@") || base.contains(":")
    }
}

// MARK: - Event bindings (§2.2)

/// One `.onX(@action, …named)` applicator as lowered onto a node:
/// `onX.0` carries the action ref, every other `onX.<name>` a named arg.
public struct DndEventBinding {
    public let actionName: String
    /// Extra named arguments (with the reserved `dwell` stripped). They merge
    /// UNDER the §4.2 payload — the payload fields always win.
    public let customPayload: [String: Any]
    /// `dwell:` on `.onDragOver`, in milliseconds; `nil` = default.
    public let dwellMs: Double?

    /// Read the `name` binding off a node's props. The generic lowering
    /// produces `onSort.0` etc.; a bare `onSort` (a host passing raw JSON
    /// through) is tolerated. `nil` when the node carries no such binding.
    /// `dwell` is reserved on `.onDragOver` only (DOM / Android parity): a
    /// number or numeric string is honoured, anything else warns and falls
    /// back to the default; on every other event it is an ordinary named
    /// argument that merges under the payload.
    public static func from(props: [String: Any], name: String) -> DndEventBinding? {
        let raw = props["\(name).0"] ?? props[name]
        guard let action = ActionValue.from(raw) else { return nil }
        var custom = action.payload
        let prefix = "\(name)."
        for (key, value) in props where key.hasPrefix(prefix) {
            let suffix = String(key.dropFirst(prefix.count))
            if suffix == "0" { continue }
            custom[suffix] = value
        }
        var dwell: Double?
        if name == "onDragOver", let rawDwell = custom.removeValue(forKey: HypenDnd.dwellArgument) {
            dwell = HypenDnd.parseDwellMs(rawDwell)
        }
        return DndEventBinding(actionName: action.actionName, customPayload: custom, dwellMs: dwell)
    }

    /// The dispatched dictionary: custom args first, then the §4.2 payload
    /// written LAST so no author arg can shadow `item`/`from`/`to`.
    public func dispatchPayload(_ payload: DndEventPayload) -> [String: Any] {
        var out = customPayload
        for (key, value) in payload.dictionary() {
            out[key] = value
        }
        return out
    }
}

// MARK: - Event payload (§4.2)

/// One end of a drag: which zone, and the slot within it (`nil` = "into").
public struct DndLocation: Equatable, Sendable {
    public let zone: String
    public let index: Int?

    public init(zone: String, index: Int?) {
        self.zone = zone
        self.index = index
    }

    /// `{zone, index}` with a JSON `null` for "into".
    public func dictionary() -> [String: Any] {
        ["zone": zone, "index": index.map { $0 as Any } ?? NSNull()]
    }
}

/// The single payload shape every `.on*` event receives (§4.2), byte-for-byte:
///
/// ```
/// { item, payload?, from: {zone, index}, to: {zone, index}, x?, y?, dropped? }
/// ```
public struct DndEventPayload {
    /// `__dnd.key` of the dragged node (or node id fallback).
    public var item: String
    /// Whether `payload` is emitted at all (the source carried
    /// `__dnd.sourcePayload`, even if it resolved to null).
    public var hasPayload: Bool
    public var payload: Any?
    public var from: DndLocation
    public var to: DndLocation
    /// `onPin` only — container content-box units (after grid / units).
    public var x: Double?
    public var y: Double?
    /// `onDragEnd` only.
    public var dropped: Bool?

    public init(
        item: String,
        hasPayload: Bool = false,
        payload: Any? = nil,
        from: DndLocation,
        to: DndLocation,
        x: Double? = nil,
        y: Double? = nil,
        dropped: Bool? = nil
    ) {
        self.item = item
        self.hasPayload = hasPayload
        self.payload = payload
        self.from = from
        self.to = to
        self.x = x
        self.y = y
        self.dropped = dropped
    }

    public func dictionary() -> [String: Any] {
        var out: [String: Any] = ["item": item]
        if hasPayload {
            out["payload"] = payload ?? NSNull()
        }
        out["from"] = from.dictionary()
        out["to"] = to.dictionary()
        if let x = x { out["x"] = x }
        if let y = y { out["y"] = y }
        if let dropped = dropped { out["dropped"] = dropped }
        return out
    }

    /// The same payload with `x`/`y` stamped (the `.onPin` form).
    public func pinned(x: Double, y: Double) -> DndEventPayload {
        var copy = self
        copy.x = x
        copy.y = y
        return copy
    }

    /// The same payload with `dropped` stamped (the `.onDragEnd` form).
    public func ended(dropped: Bool) -> DndEventPayload {
        var copy = self
        copy.dropped = dropped
        return copy
    }
}
