import Foundation

private let log = HypenLoggers.patch

/// Types of patches that can be applied to the render tree
public enum PatchType: String, Codable, Sendable {
    case create = "Create"
    case setProp = "SetProp"
    case removeProp = "RemoveProp"
    case setText = "SetText"
    case insert = "Insert"
    case move = "Move"
    case remove = "Remove"
    case attachEvent = "AttachEvent"
    case detachEvent = "DetachEvent"
    /// Unlink a subtree from its parent without destroying it.
    /// Renderer must keep the native element alive for a later `attach`.
    /// Used by the engine's Router subtree cache to preserve off-screen
    /// routes between navigations.
    case detach = "Detach"
    /// Reattach a previously-detached subtree to a parent. The `id`
    /// must reference an element still in the renderer's node map.
    case attach = "Attach"
    /// Replace a node's accessibility semantics after a reactive change
    /// (templated accessible name, bound self-state, bound checked, reactive
    /// activedescendant). Carries the node's complete re-resolved block in
    /// `semantics`; the renderer re-applies it with the same translation it
    /// runs at create. A nil block clears the node's semantics.
    case setSemantics = "SetSemantics"
    /// Transaction-animation prelude. Mutates no element: it stamps the
    /// patch batch it heads with an animation spec (carried in `spec`).
    /// Emitted by the engine at batch index 0 ONLY, and honored only
    /// there — a prelude anywhere else is not a stamp.
    /// See `hypen-web/docs/animation.md` ("batchAnimation — the
    /// transaction prelude").
    case batchAnimation = "BatchAnimation"
}

/// Represents a single patch operation on the render tree
public struct Patch: @unchecked Sendable {
    public let type: PatchType
    public let id: String?
    public let elementType: String?
    public let props: [String: Any]?
    public let name: String?
    public let value: Any?
    public let text: String?
    public let parentId: String?
    public let beforeId: String?
    public let eventName: String?
    /// Engine-derived accessibility semantics block (camelCase JSON object).
    /// Present on `create` for nodes with derivable a11y and on every
    /// `setSemantics`; nil otherwise.
    public let semantics: [String: Any]?
    /// Deferred-remove flag on `remove`: this id roots a subtree whose
    /// node carried an exit animation. The engine-side id is already dead
    /// (there is no ack round-trip) — the renderer owns the corpse.
    /// `false` for every non-animated removal, keeping the wire identical
    /// to the pre-animation protocol.
    /// See `hypen-web/docs/animation.md` (".enter / .exit").
    public let transition: Bool
    /// Animation spec carried by a `batchAnimation` prelude (the raw
    /// `{duration, curve, delay, ...}` object). nil on every other type.
    public let spec: [String: Any]?

    public init(
        type: PatchType,
        id: String? = nil,
        elementType: String? = nil,
        props: [String: Any]? = nil,
        name: String? = nil,
        value: Any? = nil,
        text: String? = nil,
        parentId: String? = nil,
        beforeId: String? = nil,
        eventName: String? = nil,
        semantics: [String: Any]? = nil,
        transition: Bool = false,
        spec: [String: Any]? = nil
    ) {
        self.type = type
        self.id = id
        self.elementType = elementType
        self.props = props
        self.name = name
        self.value = value
        self.text = text
        self.parentId = parentId
        self.beforeId = beforeId
        self.eventName = eventName
        self.semantics = semantics
        self.transition = transition
        self.spec = spec
    }
}

// MARK: - Patch Parsing

extension Patch {
    /// Parse a patch from a dictionary (JSON decoded)
    public static func from(dictionary: [String: Any]) -> Patch? {
        guard let typeString = dictionary["type"] as? String else { return nil }

        let type: PatchType
        // Handle both lowercase (from server) and capitalized formats
        switch typeString.lowercased() {
        case "create": type = .create
        case "setprop": type = .setProp
        case "removeprop": type = .removeProp
        case "settext": type = .setText
        case "insert": type = .insert
        case "move": type = .move
        case "remove": type = .remove
        case "attachevent": type = .attachEvent
        case "detachevent": type = .detachEvent
        case "detach": type = .detach
        case "attach": type = .attach
        case "setsemantics": type = .setSemantics
        case "batchanimation": type = .batchAnimation
        default:
            log.warn("Unknown patch type: %@", typeString)
            return nil
        }

        return Patch(
            type: type,
            id: dictionary["id"] as? String,
            elementType: dictionary["elementType"] as? String,
            props: dictionary["props"] as? [String: Any],
            name: dictionary["name"] as? String,
            value: dictionary["value"],
            text: dictionary["text"] as? String,
            parentId: dictionary["parentId"] as? String,
            beforeId: dictionary["beforeId"] as? String,
            eventName: dictionary["eventName"] as? String,
            semantics: dictionary["semantics"] as? [String: Any],
            // Both keys are omitted on the wire when absent (the engine
            // skips a false `transition`, and only `batchAnimation`
            // carries a `spec`), so absence must read as the neutral
            // value rather than as a parse failure.
            transition: dictionary["transition"] as? Bool ?? false,
            spec: dictionary["spec"] as? [String: Any]
        )
    }

    /// Parse an array of patches from a JSON array
    public static func fromArray(_ array: [[String: Any]]) -> [Patch] {
        array.compactMap { Patch.from(dictionary: $0) }
    }
}

extension Patch: CustomDebugStringConvertible {
    public var debugDescription: String {
        switch type {
        case .create:
            return "CREATE(\(id ?? "?"), \(elementType ?? "?"))"
        case .setProp:
            return "SET_PROP(\(id ?? "?"), \(name ?? "?") = \(value ?? "nil"))"
        case .removeProp:
            return "REMOVE_PROP(\(id ?? "?"), \(name ?? "?"))"
        case .setText:
            return "SET_TEXT(\(id ?? "?"), \"\(text ?? "")\")"
        case .insert:
            return "INSERT(\(id ?? "?") -> \(parentId ?? "?"), before: \(beforeId ?? "nil"))"
        case .move:
            return "MOVE(\(id ?? "?") -> \(parentId ?? "?"), before: \(beforeId ?? "nil"))"
        case .remove:
            return "REMOVE(\(id ?? "?")\(transition ? ", transition" : ""))"
        case .attachEvent:
            return "ATTACH_EVENT(\(id ?? "?"), \(eventName ?? "?"))"
        case .detachEvent:
            return "DETACH_EVENT(\(id ?? "?"), \(eventName ?? "?"))"
        case .detach:
            return "DETACH(\(id ?? "?"))"
        case .attach:
            return "ATTACH(\(id ?? "?") -> \(parentId ?? "?"), before: \(beforeId ?? "nil"))"
        case .setSemantics:
            return "SET_SEMANTICS(\(id ?? "?"), \(semantics == nil ? "clear" : "block"))"
        case .batchAnimation:
            return "BATCH_ANIMATION(\(spec == nil ? "no spec" : "spec"))"
        }
    }
}
