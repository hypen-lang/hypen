import Foundation

/// Engine-derived accessibility semantics for one element.
///
/// Mirrors the wire shape of the Rust `Semantics` block (camelCase JSON,
/// carried on `create` for nodes with derivable accessibility and on every
/// `setSemantics` reactive re-emit). Every field is optional; an absent
/// field means "nothing derivable".
///
/// The id-reference relationship fields (`controls`/`describedby`/
/// `labelledby`/`owns`/`activeDescendant`) are parsed for completeness but
/// have **no faithful SwiftUI target** (string-hint APIs only, see
/// the guide's "Platform support" section) — the view translation
/// deliberately drops them.
public struct HypenSemantics: Equatable, Sendable {
    public let role: String?
    public let level: Int?
    public let busy: Bool?
    public let name: String?
    public let nameExplicit: Bool?
    public let hidden: Bool?
    public let description: String?
    public let expanded: Bool?
    public let pressed: Bool?
    public let selected: Bool?
    public let current: String?
    public let checked: Bool?
    public let id: String?
    public let controls: String?
    public let describedby: String?
    public let labelledby: String?
    public let activeDescendant: String?
    public let owns: String?

    /// Parse from the JSON-decoded dictionary on a patch. Returns nil for a
    /// missing block (a node with no derivable semantics, or a clearing
    /// `setSemantics`).
    public static func from(dictionary: [String: Any]?) -> HypenSemantics? {
        guard let dict = dictionary else { return nil }
        func bool(_ key: String) -> Bool? { dict[key] as? Bool }
        func str(_ key: String) -> String? { dict[key] as? String }
        func int(_ key: String) -> Int? {
            if let i = dict[key] as? Int { return i }
            if let d = dict[key] as? Double { return Int(d) }
            return nil
        }
        return HypenSemantics(
            role: str("role"),
            level: int("level"),
            busy: bool("busy"),
            name: str("name"),
            nameExplicit: bool("nameExplicit"),
            hidden: bool("hidden"),
            description: str("description"),
            expanded: bool("expanded"),
            pressed: bool("pressed"),
            selected: bool("selected"),
            current: str("current"),
            checked: bool("checked"),
            id: str("id"),
            controls: str("controls"),
            describedby: str("describedby"),
            labelledby: str("labelledby"),
            activeDescendant: str("activeDescendant"),
            owns: str("owns")
        )
    }
}
