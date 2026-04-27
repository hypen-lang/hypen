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
        eventName: String? = nil
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
            eventName: dictionary["eventName"] as? String
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
            return "REMOVE(\(id ?? "?"))"
        case .attachEvent:
            return "ATTACH_EVENT(\(id ?? "?"), \(eventName ?? "?"))"
        case .detachEvent:
            return "DETACH_EVENT(\(id ?? "?"), \(eventName ?? "?"))"
        case .detach:
            return "DETACH(\(id ?? "?"))"
        case .attach:
            return "ATTACH(\(id ?? "?") -> \(parentId ?? "?"), before: \(beforeId ?? "nil"))"
        }
    }
}
