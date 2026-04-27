import SwiftUI

// MARK: - Breakpoint Definitions

/// Tailwind-compatible breakpoint widths
public enum Breakpoint: String, CaseIterable, Comparable {
    case sm = "sm"
    case md = "md"
    case lg = "lg"
    case xl = "xl"
    case xxl = "2xl"

    public var minWidth: CGFloat {
        switch self {
        case .sm: return 640
        case .md: return 768
        case .lg: return 1024
        case .xl: return 1280
        case .xxl: return 1536
        }
    }

    public static func < (lhs: Breakpoint, rhs: Breakpoint) -> Bool {
        lhs.minWidth < rhs.minWidth
    }

    public static func from(_ string: String) -> Breakpoint? {
        switch string.lowercased() {
        case "sm": return .sm
        case "md": return .md
        case "lg": return .lg
        case "xl": return .xl
        case "2xl": return .xxl
        default: return nil
        }
    }
}

// MARK: - State Variant Types

/// CSS-like pseudo-state variants
public enum StateVariant: String, CaseIterable {
    case hover = "hover"
    case focus = "focus"
    case active = "active"
    case disabled = "disabled"
    case focusVisible = "focus-visible"
    case focusWithin = "focus-within"

    public static func from(_ string: String) -> StateVariant? {
        switch string.lowercased() {
        case "hover": return .hover
        case "focus": return .focus
        case "active": return .active
        case "disabled": return .disabled
        case "focus-visible": return .focusVisible
        case "focus-within": return .focusWithin
        default: return nil
        }
    }
}

// MARK: - Variant Parsing

/// Result of parsing a property name for variant suffixes
public struct VariantInfo {
    public let baseName: String
    public let breakpoint: Breakpoint?
    public let state: StateVariant?

    public var isResponsive: Bool { breakpoint != nil }
    public var isStateful: Bool { state != nil }
    public var isVariant: Bool { isResponsive || isStateful }
}

/// Parse a property name to extract variant information
/// Examples:
///   "padding" -> VariantInfo(baseName: "padding", breakpoint: nil, state: nil)
///   "padding@md" -> VariantInfo(baseName: "padding", breakpoint: .md, state: nil)
///   "background-color:hover" -> VariantInfo(baseName: "background-color", breakpoint: nil, state: .hover)
public func parseVariantName(_ name: String) -> VariantInfo {
    // Check for responsive variant (@)
    if let atIndex = name.firstIndex(of: "@") {
        let baseName = String(name[..<atIndex])
        let breakpointStr = String(name[name.index(after: atIndex)...])
        let breakpoint = Breakpoint.from(breakpointStr)
        return VariantInfo(baseName: baseName, breakpoint: breakpoint, state: nil)
    }

    // Check for state variant (:)
    if let colonIndex = name.firstIndex(of: ":") {
        let baseName = String(name[..<colonIndex])
        let stateStr = String(name[name.index(after: colonIndex)...])
        let state = StateVariant.from(stateStr)
        return VariantInfo(baseName: baseName, breakpoint: nil, state: state)
    }

    return VariantInfo(baseName: name, breakpoint: nil, state: nil)
}

// MARK: - Responsive Modifier Storage

/// Stores variant-based modifier overrides
public struct VariantModifiers {
    /// Responsive overrides keyed by breakpoint
    public var responsive: [Breakpoint: HypenModifier] = [:]

    /// State-based overrides keyed by state variant
    public var states: [StateVariant: HypenModifier] = [:]

    public init() {}

    /// Get the appropriate modifier for a given screen width
    public func modifierForWidth(_ width: CGFloat, base: HypenModifier) -> HypenModifier {
        var result = base

        // Apply responsive overrides from smallest to largest
        for breakpoint in Breakpoint.allCases.sorted() {
            if width >= breakpoint.minWidth, let override = responsive[breakpoint] {
                result = mergeModifiers(base: result, override: override)
            }
        }

        return result
    }

    /// Merge an override modifier into a base modifier
    private func mergeModifiers(base: HypenModifier, override: HypenModifier) -> HypenModifier {
        HypenModifier.mergeOverride(base: base, override: override)
    }
}

// MARK: - Responsive View Modifier

/// A view modifier that applies responsive styles based on screen width
public struct ResponsiveModifier: ViewModifier {
    let baseModifier: HypenModifier
    let variants: VariantModifiers

    public init(base: HypenModifier, variants: VariantModifiers) {
        self.baseModifier = base
        self.variants = variants
    }

    public func body(content: Content) -> some View {
        GeometryReader { geometry in
            let screenWidth = geometry.size.width
            let effectiveModifier = variants.modifierForWidth(screenWidth, base: baseModifier)

            content.hypenModifier(effectiveModifier)
        }
    }
}

// MARK: - State-Aware View Modifier

/// A view modifier that tracks interaction states and applies state-based styles
public struct StateAwareModifier: ViewModifier {
    let baseModifier: HypenModifier
    let variants: VariantModifiers
    let isDisabled: Bool

    @State private var isPressed = false
    @State private var isHovered = false
    @FocusState private var isFocused: Bool

    public init(base: HypenModifier, variants: VariantModifiers, isDisabled: Bool = false) {
        self.baseModifier = base
        self.variants = variants
        self.isDisabled = isDisabled
    }

    public func body(content: Content) -> some View {
        let effectiveModifier = computeEffectiveModifier()

        content
            .hypenModifier(effectiveModifier)
            .focused($isFocused)
            #if os(macOS) || targetEnvironment(macCatalyst)
            .onHover { hovering in
                isHovered = hovering
            }
            #endif
            .onLongPressGesture(minimumDuration: .infinity, pressing: { pressing in
                isPressed = pressing
            }, perform: {})
    }

    private func computeEffectiveModifier() -> HypenModifier {
        var result = baseModifier

        // Apply state overrides in order of precedence
        // disabled < hover < focus < active
        if isDisabled, let disabledMod = variants.states[.disabled] {
            result = mergeModifiers(base: result, override: disabledMod)
        }

        #if os(macOS) || targetEnvironment(macCatalyst)
        if isHovered, let hoverMod = variants.states[.hover] {
            result = mergeModifiers(base: result, override: hoverMod)
        }
        #endif

        if isFocused, let focusMod = variants.states[.focus] {
            result = mergeModifiers(base: result, override: focusMod)
        }

        if isPressed, let activeMod = variants.states[.active] {
            result = mergeModifiers(base: result, override: activeMod)
        }

        return result
    }

    private func mergeModifiers(base: HypenModifier, override: HypenModifier) -> HypenModifier {
        HypenModifier.mergeOverride(base: base, override: override)
    }
}

// MARK: - View Extensions

extension View {
    /// Apply responsive variant modifiers
    @ViewBuilder
    public func responsiveModifier(base: HypenModifier, variants: VariantModifiers) -> some View {
        if variants.responsive.isEmpty {
            self.hypenModifier(base)
        } else {
            self.modifier(ResponsiveModifier(base: base, variants: variants))
        }
    }

    /// Apply state-aware variant modifiers
    @ViewBuilder
    public func stateAwareModifier(base: HypenModifier, variants: VariantModifiers, isDisabled: Bool = false) -> some View {
        if variants.states.isEmpty {
            self.hypenModifier(base)
        } else {
            self.modifier(StateAwareModifier(base: base, variants: variants, isDisabled: isDisabled))
        }
    }
}
