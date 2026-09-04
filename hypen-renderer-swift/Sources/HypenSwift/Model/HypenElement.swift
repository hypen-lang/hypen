import Foundation
import Combine
import SwiftUI

/// Represents a single element in the Hypen render tree.
///
/// Each element is its own `ObservableObject`: a patch that mutates one
/// element invalidates only the SwiftUI view rendering that element, not
/// the whole tree. Structural patches notify through the parent's
/// `children` array.
///
/// Thread safety is guaranteed by MainActor isolation: `HypenRenderer` is `@MainActor`
/// and all view code that accesses elements runs on MainActor. The `@unchecked Sendable`
/// conformance is safe under this guarantee.
public final class HypenElement: ObservableObject, @unchecked Sendable {
    public let id: String
    public let elementType: String
    public var props: [String: Any] {
        willSet { objectWillChange.send() }
        didSet {
            cachedApplicatorResult = nil
            cachedAnimSpecs = nil
        }
    }
    public var children: [String] {
        willSet { objectWillChange.send() }
    }
    public var parentId: String?
    public var textContent: String? {
        willSet { objectWillChange.send() }
    }
    /// Engine-derived accessibility semantics: set at `create`, replaced
    /// wholesale by `setSemantics` reactive re-emits (nil clears). Translated
    /// to SwiftUI accessibility modifiers in `applyHypenSemantics`.
    public var semantics: HypenSemantics? {
        willSet { objectWillChange.send() }
    }

    // MARK: - Animation state (owned by `HypenAnimator`)

    /// Displacement from the element's base pose, driven by an enter or an
    /// exit playback. `nil` = base pose. The view layer applies it as
    /// opacity/offset/scale; the animator flips it and lets the implicit
    /// `.animation(animPoseAnimation, value: animPose)` glide it.
    public var animPose: HypenAnimPose? {
        willSet { objectWillChange.send() }
    }

    /// The animation the next `animPose` change should ride.
    public var animPoseAnimation: Animation? {
        willSet { objectWillChange.send() }
    }

    /// The animation whitelisted prop changes on this node should glide on,
    /// resolved per batch through the precedence chain (structural >
    /// transaction > node `.transition` > snap). `nil` snaps.
    public var animTransitionAnimation: Animation? {
        willSet { objectWillChange.send() }
    }

    /// This node sits inside a subtree playing its exit: engine-side dead,
    /// so it is excluded from hit-testing, event dispatch, focus and
    /// accessibility for the rest of its life. Invalidates the memoized
    /// applicator result because the event closures it holds must be
    /// rebuilt against the suppressed dispatcher.
    public var isAnimationExcluded: Bool = false {
        willSet { objectWillChange.send() }
        didSet {
            if oldValue != isAnimationExcluded { cachedApplicatorResult = nil }
        }
    }

    /// A finite `.animate` preset has run to completion on this node. A
    /// cached Router `Attach` resumes loops but must never replay a finite
    /// preset, so the view gate consults this instead of restarting on
    /// every `onAppear`.
    public var animateFiniteExhausted: Bool = false

    /// Bumped whenever the `.animate` channel changes, so the view-local
    /// playback restarts (a changed spec restarts; a removed channel stops).
    public var animateGeneration: Int = 0 {
        willSet { objectWillChange.send() }
    }

    private var cachedAnimSpecs: NodeAnimSpecs?

    /// The node's parsed `__anim.*` channels, memoized until `props`
    /// change. Parsing is defensive: a malformed channel degrades to `nil`
    /// (snap) and never poisons its siblings.
    public var animSpecs: NodeAnimSpecs {
        if let cached = cachedAnimSpecs { return cached }
        let parsed = HypenAnim.parseSpecs(props)
        cachedAnimSpecs = parsed
        return parsed
    }

    /// Applicator pipeline output memoized by `ApplicatorRegistry`.
    /// Cleared whenever `props` change; the registry identity is kept
    /// alongside so a subtree rendered with a custom registry never
    /// reuses a result built by a different one.
    var cachedApplicatorResult: ApplicatorResult?
    var cachedApplicatorRegistryID: ObjectIdentifier?

    /// Viewport the cached result was resolved against. `vw`/`vh` depend on
    /// it, and nothing mutates the element when the window resizes, so it is
    /// part of the cache key rather than an invalidation trigger.
    var cachedApplicatorViewport: CGSize = .zero

    /// Re-emit this element's change publisher without mutating it.
    /// Used by `HypenRenderer` when a change to a descendant (e.g. a
    /// control-flow wrapper's children, or a child prop the parent's
    /// layout reads) must re-render this element's view.
    func notifyChanged() {
        objectWillChange.send()
    }

    public init(
        id: String,
        elementType: String,
        props: [String: Any] = [:],
        children: [String] = [],
        parentId: String? = nil,
        textContent: String? = nil
    ) {
        self.id = id
        self.elementType = elementType
        self.props = props
        self.children = children
        self.parentId = parentId
        self.textContent = textContent
    }

    // MARK: - Property accessors

    public func getProp<T>(_ name: String) -> T? {
        return props[name] as? T
    }

    public func getStringProp(_ name: String) -> String? {
        if let value = props[name] {
            if let str = value as? String {
                return str
            }
            return String(describing: value)
        }
        return nil
    }

    public func getIntProp(_ name: String) -> Int? {
        if let value = props[name] {
            if let intVal = value as? Int {
                return intVal
            }
            if let doubleVal = value as? Double {
                return Int(doubleVal)
            }
            if let strVal = value as? String, let intVal = Int(strVal) {
                return intVal
            }
        }
        return nil
    }

    public func getDoubleProp(_ name: String) -> Double? {
        if let value = props[name] {
            if let doubleVal = value as? Double {
                return doubleVal
            }
            if let intVal = value as? Int {
                return Double(intVal)
            }
            if let strVal = value as? String, let doubleVal = Double(strVal) {
                return doubleVal
            }
        }
        return nil
    }

    public func getBoolProp(_ name: String) -> Bool? {
        if let value = props[name] {
            if let boolVal = value as? Bool {
                return boolVal
            }
            if let strVal = value as? String {
                return strVal.lowercased() == "true" || strVal == "1"
            }
            if let intVal = value as? Int {
                return intVal != 0
            }
        }
        return nil
    }

    /// Scrollability and (optionally) direction parsed from a single prop.
    ///
    /// The `.scrollable(...)` applicator accepts multiple value shapes to
    /// match the DOM and Compose renderers:
    ///   - `.scrollable(true)` / `.scrollable(false)` — bool
    ///   - `.scrollable("horizontal")` — string direction
    ///   - `.scrollable("vertical")` — string direction
    ///   - `.scrollable("both")` / `.scrollable("auto")` / `.scrollable("scroll")` — both axes
    ///   - `.scrollable("false")` / `.scrollable("none")` / `.scrollable("hidden")` — off
    ///
    /// Returns `(enabled, direction?)`. When `direction` is nil, the caller
    /// should use the component's natural axis (horizontal for Row, vertical
    /// for Column/Grid).
    public enum ScrollAxis {
        case horizontal, vertical, both
    }

    public func getScrollable(_ name: String = "scrollable.0") -> (enabled: Bool, axis: ScrollAxis?) {
        guard let value = props[name] else { return (false, nil) }

        if let boolVal = value as? Bool {
            return (boolVal, nil)
        }
        if let intVal = value as? Int {
            return (intVal != 0, nil)
        }
        if let strVal = value as? String {
            switch strVal.lowercased() {
            case "true", "1", "auto", "scroll", "both":
                return (true, strVal.lowercased() == "both" ? .both : nil)
            case "horizontal":
                return (true, .horizontal)
            case "vertical":
                return (true, .vertical)
            case "false", "0", "none", "hidden", "":
                return (false, nil)
            default:
                return (false, nil)
            }
        }
        return (false, nil)
    }

    public func getCGFloatProp(_ name: String) -> CGFloat? {
        if let double = getDoubleProp(name) {
            return CGFloat(double)
        }
        return nil
    }

    /// List-of-strings prop (e.g. `playlist: ["url1", "url2"]`).
    ///
    /// Pass the base name: the plain key is tried first, then the engine's
    /// positional `"<name>.0"` form. Accepts `[String]` and `[Any]` values
    /// (JSON deserialization yields `[Any]`); non-string entries are
    /// stringified, `NSNull` entries are dropped. Returns nil when the prop
    /// is absent or not a list.
    public func getStringListProp(_ name: String) -> [String]? {
        guard let value = props[name] ?? props["\(name).0"] else { return nil }
        if let list = value as? [String] {
            return list
        }
        if let list = value as? [Any] {
            return list.compactMap { entry -> String? in
                if entry is NSNull { return nil }
                if let str = entry as? String { return str }
                return String(describing: entry)
            }
        }
        return nil
    }

    /// String-to-string map prop (e.g. `headers: {"Authorization": "Bearer x"}`).
    ///
    /// Same key fallback as `getStringListProp` (plain, then `"<name>.0"`).
    /// Accepts `[String: String]` and `[String: Any]` values; non-string
    /// entries are stringified, `NSNull` entries are dropped. Returns nil
    /// when the prop is absent or not a map.
    public func getStringMapProp(_ name: String) -> [String: String]? {
        guard let value = props[name] ?? props["\(name).0"] else { return nil }
        if let map = value as? [String: String] {
            return map
        }
        if let map = value as? [String: Any] {
            var result: [String: String] = [:]
            for (key, entry) in map {
                if entry is NSNull { continue }
                if let str = entry as? String {
                    result[key] = str
                } else {
                    result[key] = String(describing: entry)
                }
            }
            return result
        }
        return nil
    }

    // MARK: - Mutators

    public func setProp(_ name: String, value: Any?) {
        if let value = value {
            props[name] = value
        } else {
            props.removeValue(forKey: name)
        }
    }

    public func addChild(_ childId: String, beforeId: String? = nil) {
        if let beforeId = beforeId, let index = children.firstIndex(of: beforeId) {
            children.insert(childId, at: index)
        } else {
            children.append(childId)
        }
    }

    public func removeChild(_ childId: String) {
        if let index = children.firstIndex(of: childId) {
            children.remove(at: index)
        }
    }
}

extension HypenElement: CustomDebugStringConvertible {
    public var debugDescription: String {
        "HypenElement(id: \(id), type: \(elementType), children: \(children.count))"
    }
}
