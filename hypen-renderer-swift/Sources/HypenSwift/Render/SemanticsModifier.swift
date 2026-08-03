import SwiftUI

/// Engine semantics → SwiftUI accessibility translation.
///
/// Maps the platform-neutral `HypenSemantics` block onto SwiftUI's
/// accessibility modifiers, mirroring what the DOM renderer does with ARIA:
///
/// | Semantics field    | SwiftUI                                          |
/// |--------------------|--------------------------------------------------|
/// | `hidden`           | `.accessibilityHidden(true)` (nothing else applies) |
/// | `name` (explicit)  | `.accessibilityLabel` — an author `.label(...)` overrides visible content |
/// | `name` (img role)  | `.accessibilityLabel` — image alt has no visible text to derive from |
/// | `description`      | `.accessibilityHint`                             |
/// | `role`             | traits: button/link/heading/img/search/dialog→isModal |
/// | `level`            | `.accessibilityHeading(.h1…h6)`                  |
/// | `selected`         | `.isSelected` trait                              |
/// | `checked`/`expanded`/`pressed`/`current` | `.accessibilityValue` (state description) |
///
/// Derived (non-explicit) names on text-bearing controls are deliberately
/// NOT applied — VoiceOver already reads the visible `Text` content, exactly
/// as the browser does on DOM. The id-reference relationships
/// (`controls`/`describedby`/`labelledby`/`owns`/`activeDescendant`) have no
/// faithful SwiftUI target (string-hint APIs only) and are dropped by
/// design; see the "Platform support" section of
/// `hypen-docs/content/docs/guide/accessibility.mdx`.
extension View {
    @ViewBuilder
    public func applyHypenSemantics(_ semantics: HypenSemantics?) -> some View {
        if let semantics = semantics {
            if semantics.hidden == true {
                // Decorative: removed from the accessibility tree entirely.
                self.accessibilityHidden(true)
            } else {
                self
                    .modifier(SemanticsLabelModifier(semantics: semantics))
                    .modifier(SemanticsTraitsModifier(semantics: semantics))
                    .modifier(SemanticsValueModifier(semantics: semantics))
            }
        } else {
            self
        }
    }
}

/// Accessible name + supplementary description.
struct SemanticsLabelModifier: ViewModifier {
    let semantics: HypenSemantics

    /// An explicit author `.label(...)` always overrides; an image's name
    /// (alt text) is applied too, since there is no visible text VoiceOver
    /// could derive it from. Derived names on text-bearing controls are left
    /// to the visible content.
    var effectiveLabel: String? {
        guard let name = semantics.name else { return nil }
        if semantics.nameExplicit == true { return name }
        if semantics.role == "img" { return name }
        return nil
    }

    func body(content: Content) -> some View {
        content
            .modifier(OptionalLabelModifier(label: effectiveLabel))
            .modifier(OptionalHintModifier(hint: semantics.description))
    }
}

private struct OptionalLabelModifier: ViewModifier {
    let label: String?
    func body(content: Content) -> some View {
        if let label = label {
            content.accessibilityLabel(label)
        } else {
            content
        }
    }
}

private struct OptionalHintModifier: ViewModifier {
    let hint: String?
    func body(content: Content) -> some View {
        if let hint = hint {
            content.accessibilityHint(hint)
        } else {
            content
        }
    }
}

/// Role → traits, plus heading level.
struct SemanticsTraitsModifier: ViewModifier {
    let semantics: HypenSemantics

    private var traits: AccessibilityTraits? {
        var collected: AccessibilityTraits? = nil
        func add(_ trait: AccessibilityTraits) {
            if let existing = collected {
                collected = existing.union(trait)
            } else {
                collected = trait
            }
        }
        switch semantics.role {
        case "button", "tab", "option":
            // Tab/option have no dedicated SwiftUI trait; button conveys
            // "activatable" — the closest faithful signal.
            add(.isButton)
        case "link":
            add(.isLink)
        case "heading":
            add(.isHeader)
        case "img":
            add(.isImage)
        case "search":
            add(.isSearchField)
        case "dialog":
            add(.isModal)
        default:
            break
        }
        if semantics.selected == true {
            add(.isSelected)
        }
        return collected
    }

    private var headingLevel: AccessibilityHeadingLevel? {
        guard semantics.role == "heading" else { return nil }
        switch semantics.level {
        case 1: return .h1
        case 2: return .h2
        case 3: return .h3
        case 4: return .h4
        case 5: return .h5
        case 6: return .h6
        default: return semantics.level == nil ? .unspecified : nil
        }
    }

    func body(content: Content) -> some View {
        content
            .modifier(OptionalTraitsModifier(traits: traits))
            .modifier(OptionalHeadingModifier(level: headingLevel))
    }
}

private struct OptionalTraitsModifier: ViewModifier {
    let traits: AccessibilityTraits?
    func body(content: Content) -> some View {
        if let traits = traits {
            content.accessibilityAddTraits(traits)
        } else {
            content
        }
    }
}

private struct OptionalHeadingModifier: ViewModifier {
    let level: AccessibilityHeadingLevel?
    func body(content: Content) -> some View {
        if let level = level {
            content.accessibilityHeading(level)
        } else {
            content
        }
    }
}

/// Self-state → accessibility value (VoiceOver's state description slot).
struct SemanticsValueModifier: ViewModifier {
    let semantics: HypenSemantics

    /// First applicable state wins: checked (toggles) > expanded
    /// (disclosures) > pressed (toggle buttons) > current (nav position).
    var stateDescription: String? {
        if let checked = semantics.checked {
            return checked ? "checked" : "unchecked"
        }
        if let expanded = semantics.expanded {
            return expanded ? "expanded" : "collapsed"
        }
        if let pressed = semantics.pressed {
            return pressed ? "pressed" : "not pressed"
        }
        if let current = semantics.current {
            return "current \(current)"
        }
        return nil
    }

    func body(content: Content) -> some View {
        if let value = stateDescription {
            content.accessibilityValue(value)
        } else {
            content
        }
    }
}
