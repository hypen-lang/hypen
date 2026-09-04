import SwiftUI

/// A SwiftUI view that renders a single Hypen element and its children.
///
/// This is a thin, equatable wrapper: it holds no observed state, so a
/// parent re-render skips unchanged children. The actual rendering (and
/// the per-element observation that drives invalidation) lives in
/// `HypenElementContentView`, which observes only its own `HypenElement`.
@MainActor
public struct HypenElementView: View {
    let elementId: String
    let renderer: HypenRenderer
    let actionDispatcher: ActionDispatcher

    public init(
        elementId: String,
        renderer: HypenRenderer,
        actionDispatcher: ActionDispatcher
    ) {
        self.elementId = elementId
        self.renderer = renderer
        self.actionDispatcher = actionDispatcher
    }

    public var body: some View {
        if let element = renderer.getElement(elementId) {
            HypenElementContentView(
                element: element,
                renderer: renderer,
                actionDispatcher: actionDispatcher
            )
        }
    }
}

extension HypenElementView: Equatable {
    // The dispatcher is fixed per HypenView and flows down uniformly, so
    // element id plus renderer identity fully determine this wrapper.
    nonisolated public static func == (lhs: HypenElementView, rhs: HypenElementView) -> Bool {
        lhs.elementId == rhs.elementId && lhs.renderer === rhs.renderer
    }
}

/// Renders one element, observing it directly: a patch that mutates this
/// element re-evaluates only this view's body, not the whole tree.
@MainActor
struct HypenElementContentView: View {
    @ObservedObject var element: HypenElement
    let renderer: HypenRenderer
    let actionDispatcher: ActionDispatcher

    @Environment(\.componentRegistry) private var componentRegistry
    @Environment(\.applicatorRegistry) private var applicatorRegistry
    @Environment(\.screenWidth) private var screenWidth
    @Environment(\.viewportHeight) private var viewportHeight
    @Environment(\.stretchCrossAxis) private var stretchCrossAxis
    @Environment(\.parentAllowsHorizontalExpansion) private var parentAllowsHorizontalExpansion
    @Environment(\.parentAllowsVerticalExpansion) private var parentAllowsVerticalExpansion
    @Environment(\.parentExplicitHeight) private var parentExplicitHeight
    @Environment(\.parentExplicitWidth) private var parentExplicitWidth
    @Environment(\.proportionalWidth) private var proportionalWidth

    var body: some View {
        renderElement(element)
    }

    @ViewBuilder
    private func renderElement(_ element: HypenElement) -> some View {
        // Check visibility
        let isVisible = element.getBoolProp("visible.0") ?? element.getBoolProp("visible") ?? true
        if !isVisible {
            EmptyView()
        } else {
            // Engine-derived accessibility semantics wrap the whole rendered
            // element (label/traits/state → VoiceOver). Re-applied on every
            // re-render, so a `setSemantics` reactive re-emit lands here too.
            //
            // The `__anim.*` layer wraps that in turn: the `.animate`
            // preset playback sits inside so it decorates the rendered
            // element, and the pose/glide/exclusion state sits outside so
            // an exiting subtree's accessibility exclusion outranks the
            // element's own semantics block.
            renderVisibleElement(element)
                .applyHypenSemantics(element.semantics)
                .hypenAnimatePreset(element, animator: renderer.animator)
                .hypenAnimationState(element)
        }
    }

    @ViewBuilder
    private func renderVisibleElement(_ element: HypenElement) -> some View {
        // Event-dispatch plane of the exiting-subtree exclusion: the
        // engine-side ids under an exit are already dead, so every action
        // this element could raise is a ghost. Swapping the dispatcher at
        // context construction is the single chokepoint — component
        // handlers and applicators both capture it from here.
        let dispatcher: ActionDispatcher = element.isAnimationExcluded
            ? HypenSuppressedActionDispatcher.shared
            : actionDispatcher

        let context = ComponentContext(
            element: element,
            renderer: renderer,
            actionDispatcher: dispatcher
        )

        let applicatorContext = ApplicatorContext(
            element: element,
            actionDispatcher: dispatcher,
            viewportSize: CGSize(width: screenWidth, height: viewportHeight)
        )

        // Build modifier and variants from applicators
        let applicatorResult = applicatorRegistry.applyAllWithVariants(
            element: element,
            context: applicatorContext
        )

        let hasResponsiveVariants = !applicatorResult.variants.responsive.isEmpty
        let hasStateVariants = !applicatorResult.variants.states.isEmpty
        let hasCombinedVariants = !applicatorResult.variants.combined.isEmpty
        // `disabled` interaction state (mirrors Android's derivation): an explicit
        // `disabled` prop, or `enabled: false`. Fed to VariantAwareView so
        // `:disabled` / `@bp:disabled` variants apply on iOS too.
        let isDisabled =
            (element.getBoolProp("disabled.0") ?? element.getBoolProp("disabled") ?? false)
            || !(element.getBoolProp("enabled.0") ?? element.getBoolProp("enabled") ?? true)

        // Get component handler or use fallback
        if let handler = componentRegistry.getHandler(for: element.elementType) {
            if hasResponsiveVariants || hasStateVariants || hasCombinedVariants {
                // Use variant-aware rendering
                VariantAwareView(
                    baseModifier: applicatorResult.baseModifier,
                    variants: applicatorResult.variants,
                    isDisabled: isDisabled,
                    content: {
                        handler.render(
                            context: context,
                            modifier: applicatorResult.baseModifier,
                            children: { AnyView(renderChildren(element)) }
                        )
                    }
                )
                .applyTapGestures(modifier: applicatorResult.baseModifier)
                // Renderer-local video intents (`.videoIntent("fullscreen")`).
                // Recognized simultaneously with the element's own action tap
                // above, so a node can carry both; a no-op everywhere else.
                // See Components/VideoIntents.swift.
                .videoIntentTap(VideoIntent.from(element))
                .applyStretchCrossAxis(stretchCrossAxis)
                .applyWeightExpansion(modifier: applicatorResult.baseModifier, allowsHorizontal: parentAllowsHorizontalExpansion, allowsVertical: parentAllowsVerticalExpansion, parentHeight: parentExplicitHeight, parentWidth: parentExplicitWidth, proportionalWidth: proportionalWidth)
            } else {
                // Standard rendering without variants
                handler.render(
                    context: context,
                    modifier: applicatorResult.baseModifier,
                    children: { AnyView(renderChildren(element)) }
                )
                .applyTapGestures(modifier: applicatorResult.baseModifier)
                // Renderer-local video intents (`.videoIntent("fullscreen")`).
                // Recognized simultaneously with the element's own action tap
                // above, so a node can carry both; a no-op everywhere else.
                // See Components/VideoIntents.swift.
                .videoIntentTap(VideoIntent.from(element))
                .applyStretchCrossAxis(stretchCrossAxis)
                .applyWeightExpansion(modifier: applicatorResult.baseModifier, allowsHorizontal: parentAllowsHorizontalExpansion, allowsVertical: parentAllowsVerticalExpansion, parentHeight: parentExplicitHeight, parentWidth: parentExplicitWidth, proportionalWidth: proportionalWidth)
            }
        } else {
            // Fallback: render as a container with top-leading alignment (like Web/Android)
            if hasResponsiveVariants || hasStateVariants || hasCombinedVariants {
                VariantAwareView(
                    baseModifier: applicatorResult.baseModifier,
                    variants: applicatorResult.variants,
                    isDisabled: isDisabled,
                    content: {
                        ZStack(alignment: .topLeading) {
                            renderChildren(element)
                        }
                    }
                )
                .applyTapGestures(modifier: applicatorResult.baseModifier)
                // Renderer-local video intents (`.videoIntent("fullscreen")`).
                // Recognized simultaneously with the element's own action tap
                // above, so a node can carry both; a no-op everywhere else.
                // See Components/VideoIntents.swift.
                .videoIntentTap(VideoIntent.from(element))
                .applyStretchCrossAxis(stretchCrossAxis)
                .applyWeightExpansion(modifier: applicatorResult.baseModifier, allowsHorizontal: parentAllowsHorizontalExpansion, allowsVertical: parentAllowsVerticalExpansion, parentHeight: parentExplicitHeight, parentWidth: parentExplicitWidth, proportionalWidth: proportionalWidth)
            } else {
                ZStack(alignment: .topLeading) {
                    renderChildren(element)
                }
                .hypenModifier(applicatorResult.baseModifier)
                .applyTapGestures(modifier: applicatorResult.baseModifier)
                // Renderer-local video intents (`.videoIntent("fullscreen")`).
                // Recognized simultaneously with the element's own action tap
                // above, so a node can carry both; a no-op everywhere else.
                // See Components/VideoIntents.swift.
                .videoIntentTap(VideoIntent.from(element))
                .applyStretchCrossAxis(stretchCrossAxis)
                .applyWeightExpansion(modifier: applicatorResult.baseModifier, allowsHorizontal: parentAllowsHorizontalExpansion, allowsVertical: parentAllowsVerticalExpansion, parentHeight: parentExplicitHeight, parentWidth: parentExplicitWidth, proportionalWidth: proportionalWidth)
            }
        }
    }

    private func buildModifier(element: HypenElement, context: ApplicatorContext) -> HypenModifier {
        var modifier = HypenModifier()
        applicatorRegistry.applyAll(to: &modifier, element: element, context: context)
        return modifier
    }

    @ViewBuilder
    private func renderChildren(_ element: HypenElement) -> some View {
        ForEach(element.children, id: \.self) { childId in
            HypenElementView(
                elementId: childId,
                renderer: renderer,
                actionDispatcher: actionDispatcher
            )
        }
    }
}

// MARK: - Variant Aware View

/// A view that applies responsive and state-based modifiers
struct VariantAwareView<Content: View>: View {
    let baseModifier: HypenModifier
    let variants: VariantModifiers
    var isDisabled: Bool = false
    let content: () -> Content

    @State private var isPressed = false
    @State private var isHovered = false
    @FocusState private var isFocused: Bool
    @Environment(\.screenWidth) private var screenWidth

    var body: some View {
        let effectiveModifier = computeEffectiveModifier(screenWidth: screenWidth)

        content()
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

    private func computeEffectiveModifier(screenWidth: CGFloat) -> HypenModifier {
        // Compute responsive modifier
        var effectiveModifier = variants.modifierForWidth(screenWidth, base: baseModifier)

        // Apply combined `@bp:state` overrides for `state` whose breakpoint is
        // active at the current width, smallest→largest so a higher breakpoint
        // wins the within-band tiebreak (matches the engine precedence). Layered
        // right after the plain state override so a combined `@md:hover` beats a
        // plain `:hover`, while a higher state band still wins overall.
        func applyCombined(_ state: StateVariant, into mod: HypenModifier) -> HypenModifier {
            guard variants.hasCombined else { return mod }
            var out = mod
            for bp in Breakpoint.allCases.sorted() where screenWidth >= bp.minWidth {
                if let m = variants.combined[CombinedVariantKey(breakpoint: bp, state: state)] {
                    out = HypenModifier.mergeOverride(base: out, override: m)
                }
            }
            return out
        }

        // State-based overrides, lowest→highest precedence: disabled < hover < focus < active.
        if isDisabled {
            if let disabledMod = variants.states[.disabled] {
                effectiveModifier = HypenModifier.mergeOverride(base: effectiveModifier, override: disabledMod)
            }
            effectiveModifier = applyCombined(.disabled, into: effectiveModifier)
        }

        #if os(macOS) || targetEnvironment(macCatalyst)
        if isHovered {
            if let hoverMod = variants.states[.hover] {
                effectiveModifier = HypenModifier.mergeOverride(base: effectiveModifier, override: hoverMod)
            }
            effectiveModifier = applyCombined(.hover, into: effectiveModifier)
        }
        #endif

        if isFocused {
            // focus, focus-visible, and focus-within share the focus band (the
            // native renderer has no keyboard-vs-pointer / descendant-focus
            // distinction, matching how the engine ranks all three at the focus
            // slot). Apply each plain state then its combined overrides.
            for st in [StateVariant.focus, .focusVisible, .focusWithin] {
                if let mod = variants.states[st] {
                    effectiveModifier = HypenModifier.mergeOverride(base: effectiveModifier, override: mod)
                }
                effectiveModifier = applyCombined(st, into: effectiveModifier)
            }
        }

        if isPressed {
            if let activeMod = variants.states[.active] {
                effectiveModifier = HypenModifier.mergeOverride(base: effectiveModifier, override: activeMod)
            }
            effectiveModifier = applyCombined(.active, into: effectiveModifier)
        }

        return effectiveModifier
    }
}

// MARK: - Tap Gesture Extension

extension View {
    @MainActor
    @ViewBuilder
    func applyTapGestures(modifier: HypenModifier) -> some View {
        if let onTap = modifier.onTap {
            if let onLongPress = modifier.onLongPress {
                self
                    .onTapGesture {
                        onTap()
                    }
                    .onLongPressGesture {
                        onLongPress()
                    }
            } else {
                self
                    .onTapGesture {
                        onTap()
                    }
            }
        } else if let onLongPress = modifier.onLongPress {
            self
                .onLongPressGesture {
                    onLongPress()
                }
        } else {
            self
        }
    }
}

// MARK: - Stretch Cross Axis Extension

extension View {
    /// Apply stretch behavior based on parent's stretchCrossAxis environment.
    /// This makes children fill the cross-axis when verticalAlignment/horizontalAlignment: stretch is set.
    @ViewBuilder
    func applyStretchCrossAxis(_ stretch: StretchCrossAxis) -> some View {
        switch stretch {
        case .none:
            self
        case .vertical:
            // In a Row with verticalAlignment: stretch, children should fill height
            self.frame(maxHeight: .infinity)
        case .horizontal:
            // In a Column with horizontalAlignment: stretch, children should fill width
            self.frame(maxWidth: .infinity)
        }
    }

    /// Apply weight and fillMaxWidth/fillMaxHeight expansion only when parent allows it.
    /// This ensures children with weight/fillMaxWidth only expand if parent Column has width.
    /// Percentage widths and heights are calculated from parent's explicit dimensions.
    /// Proportional widths from flex distribution override other width calculations.
    @ViewBuilder
    func applyWeightExpansion(modifier: HypenModifier, allowsHorizontal: Bool, allowsVertical: Bool, parentHeight: CGFloat? = nil, parentWidth: CGFloat? = nil, proportionalWidth: CGFloat? = nil) -> some View {
        // Proportional width from Row's flex distribution takes precedence
        // This handles flex(1), flex(2), etc. proportional distribution
        let effectiveWidth: CGFloat? = proportionalWidth ?? {
            // Calculate percentage width when parent has explicit width
            guard modifier.fillMaxWidth, let parentWidth = parentWidth else { return nil }
            return parentWidth * modifier.fillMaxWidthFraction
        }()

        // Calculate percentage height when parent has explicit height
        let calculatedHeight: CGFloat? = {
            guard modifier.fillMaxHeight, let parentHeight = parentHeight else { return nil }
            return parentHeight * modifier.fillMaxHeightFraction
        }()

        // Should expand horizontally with .infinity (only when no exact calculated width and no proportional width)
        //
        // A declared `maxWidth` opts the element out: in CSS `max-width` beats
        // `width`, so `width:100%; max-width:250px` means "fill, but never
        // past 250". Expanding to `.infinity` out here would wrap the
        // already-capped frame in a full-width one and leave the content
        // aligned inside it — which is what made the home-screen launcher's
        // icon grid sit flush left instead of centred under its parent's
        // `items-center`. `FillExpansionModifier` (HypenModifier.swift) has
        // always applied this rule; this expansion simply didn't honour it.
        let shouldExpandHorizontal = effectiveWidth == nil && allowsHorizontal && modifier.maxWidth == nil && (
            (modifier.weight != nil && modifier.weight! > 0) ||
            (modifier.flexGrow != nil && modifier.flexGrow! > 0) ||
            modifier.fillMaxWidth
        )

        // Check if we should expand to fill available height (same max-bound rule).
        let shouldExpandVertical = modifier.fillMaxHeight && modifier.fillMaxHeightFraction >= 1.0
            && parentHeight == nil && modifier.maxHeight == nil

        // Check if flexShrink(0) - element should not shrink below its size
        let preventShrink = modifier.flexShrink == 0

        // If there's an explicit width and flexShrink(0), we need to maintain that width
        // by setting minWidth (flex-shrink: 0 + width: 200px means "don't shrink below 200px")
        let explicitWidthWithNoShrink = preventShrink && modifier.width != nil

        // Apply width and height sizing
        if let width = effectiveWidth {
            // Exact width (from proportional flex or percentage)
            if let height = calculatedHeight {
                self.applyProportionalWidth(width, preventShrink: preventShrink)
                    .applyPercentageHeight(height, backgroundColor: modifier.backgroundColor, cornerRadius: modifier.cornerRadius)
            } else if shouldExpandVertical {
                self.applyProportionalWidth(width, preventShrink: preventShrink)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
            } else {
                self.applyProportionalWidth(width, preventShrink: preventShrink)
            }
        } else if shouldExpandHorizontal {
            if modifier.fillMaxWidth && modifier.fillMaxWidthFraction < 1.0 {
                // Fractional fillMaxWidth without explicit parent width
                if let height = calculatedHeight {
                    self.applyFillMaxWidthFraction(modifier.fillMaxWidthFraction, parentWidth: parentWidth)
                        .applyPercentageHeight(height, backgroundColor: modifier.backgroundColor, cornerRadius: modifier.cornerRadius)
                } else if shouldExpandVertical {
                    self.applyFillMaxWidthFraction(modifier.fillMaxWidthFraction, parentWidth: parentWidth)
                        .frame(maxHeight: .infinity, alignment: .topLeading)
                } else {
                    self.applyFillMaxWidthFraction(modifier.fillMaxWidthFraction, parentWidth: parentWidth)
                }
            } else {
                // Full width or weight expansion
                if let height = calculatedHeight {
                    self.frame(maxWidth: .infinity, alignment: .topLeading)
                        .applyPercentageHeight(height, backgroundColor: modifier.backgroundColor, cornerRadius: modifier.cornerRadius)
                } else if shouldExpandVertical {
                    self.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                } else {
                    self.frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
        } else {
            // No horizontal expansion
            // Apply flexShrink(0) if set - prevent element from shrinking
            // If there's an explicit width with flexShrink(0), set minWidth to maintain it
            if explicitWidthWithNoShrink, let explicitWidth = modifier.width {
                if let height = calculatedHeight {
                    self.frame(minWidth: explicitWidth)
                        .applyPercentageHeight(height, backgroundColor: modifier.backgroundColor, cornerRadius: modifier.cornerRadius)
                } else if shouldExpandVertical {
                    self.frame(minWidth: explicitWidth, maxHeight: .infinity, alignment: .topLeading)
                } else {
                    self.frame(minWidth: explicitWidth)
                }
            } else if preventShrink {
                // No explicit width but flexShrink(0) - use fixedSize to prevent shrinking
                let baseView = AnyView(self.fixedSize(horizontal: true, vertical: false))
                if let height = calculatedHeight {
                    baseView.applyPercentageHeight(height, backgroundColor: modifier.backgroundColor, cornerRadius: modifier.cornerRadius)
                } else if shouldExpandVertical {
                    baseView.frame(maxHeight: .infinity, alignment: .topLeading)
                } else {
                    baseView
                }
            } else {
                // Normal case - no shrink prevention
                if let height = calculatedHeight {
                    self.applyPercentageHeight(height, backgroundColor: modifier.backgroundColor, cornerRadius: modifier.cornerRadius)
                } else if shouldExpandVertical {
                    self.frame(maxHeight: .infinity, alignment: .topLeading)
                } else {
                    self
                }
            }
        }
    }

    /// Apply proportional width from flex distribution
    @ViewBuilder
    func applyProportionalWidth(_ width: CGFloat, preventShrink: Bool) -> some View {
        if preventShrink {
            self.frame(minWidth: width, idealWidth: width, maxWidth: width)
        } else {
            self.frame(width: width)
        }
    }

    /// Apply percentage width with proper background handling
    /// Background needs to be re-applied after frame to fill the new size
    @ViewBuilder
    func applyPercentageWidth(_ width: CGFloat, backgroundColor: Color?, cornerRadius: CGFloat) -> some View {
        // Use min/max to force the exact width
        self.frame(minWidth: width, maxWidth: width)
            // Re-apply background so it fills the new frame size
            .background(
                Group {
                    if let bg = backgroundColor {
                        RoundedRectangle(cornerRadius: cornerRadius)
                            .fill(bg)
                    }
                }
            )
    }

    /// Apply percentage height with proper background handling
    /// Background needs to be re-applied after frame to fill the new size
    @ViewBuilder
    func applyPercentageHeight(_ height: CGFloat, backgroundColor: Color?, cornerRadius: CGFloat) -> some View {
        // Use min/max to force the exact height
        self.frame(minHeight: height, maxHeight: height)
            // Re-apply background so it fills the new frame size
            .background(
                Group {
                    if let bg = backgroundColor {
                        RoundedRectangle(cornerRadius: cornerRadius)
                            .fill(bg)
                    }
                }
            )
    }

    /// Apply fillMaxWidth with a fraction (e.g., 0.5 for 50% of parent width)
    @ViewBuilder
    func applyFillMaxWidthFraction(_ fraction: CGFloat, parentWidth: CGFloat? = nil) -> some View {
        if let parentWidth = parentWidth {
            // Use explicit parent width if available
            self.frame(width: parentWidth * fraction)
        } else if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) {
            self.containerRelativeFrame(.horizontal) { length, _ in length * fraction }
        } else {
            // Fallback for older iOS
            GeometryReader { geometry in
                self.frame(width: fraction * geometry.size.width)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }
}

// MARK: - onChange Compatibility

extension View {
    /// A compatibility wrapper for `onChange(of:)` that uses the correct API
    /// depending on the OS version. On iOS 17+ / macOS 14+, uses the new
    /// two-parameter closure; on older versions, uses the deprecated single-parameter form.
    @ViewBuilder
    func onChangeCompat<V: Equatable>(of value: V, perform action: @escaping (V) -> Void) -> some View {
        if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) {
            self.onChange(of: value) { _, newValue in
                action(newValue)
            }
        } else {
            self.onChange(of: value) { newValue in
                action(newValue)
            }
        }
    }
}

// MARK: - Environment Keys

private struct ComponentRegistryKey: @preconcurrency EnvironmentKey {
    @MainActor static let defaultValue: ComponentRegistry = ComponentRegistry.withDefaults()
}

private struct ApplicatorRegistryKey: @preconcurrency EnvironmentKey {
    @MainActor static let defaultValue: ApplicatorRegistry = ApplicatorRegistry.withDefaults()
}

/// Environment key to indicate children should stretch to fill cross-axis.
/// When set to .vertical, children should fillMaxHeight (in a Row).
/// When set to .horizontal, children should fillMaxWidth (in a Column).
public enum StretchCrossAxis: Sendable {
    case none
    case vertical   // Children should stretch vertically (used in Row with verticalAlignment: stretch)
    case horizontal // Children should stretch horizontally (used in Column with horizontalAlignment: stretch)
}

private struct StretchCrossAxisKey: EnvironmentKey {
    static let defaultValue: StretchCrossAxis = .none
}

/// Environment key to indicate parent allows horizontal expansion.
/// When true, children with weight/fillMaxWidth can expand horizontally.
/// This is set by Column when it has fillMaxWidth(true).
private struct ParentAllowsHorizontalExpansionKey: EnvironmentKey {
    static let defaultValue: Bool = false
}

/// Environment key to indicate parent allows vertical expansion.
/// When true, children with weight/fillMaxHeight can expand vertically.
/// This is set by Row when it has fillMaxHeight(true).
private struct ParentAllowsVerticalExpansionKey: EnvironmentKey {
    static let defaultValue: Bool = false
}

/// Environment key for parent's explicit height (for percentage height calculations).
/// When set, children with percentage heights can calculate their height as a percentage of this value.
private struct ParentExplicitHeightKey: EnvironmentKey {
    static let defaultValue: CGFloat? = nil
}

/// Environment key for parent's explicit width (for percentage width calculations).
/// When set, children with percentage widths can calculate their width as a percentage of this value.
private struct ParentExplicitWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat? = nil
}

/// Environment key for proportional width calculated from flex/weight in Row.
/// When set, the child should use this exact width instead of expanding to infinity.
private struct ProportionalWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat? = nil
}

/// Environment key for screen/window width, set at the HypenView level.
/// Used by VariantAwareView for responsive breakpoints without GeometryReader.
private struct ScreenWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

/// Height of the area the Hypen root was actually given.
///
/// Zero means "not measured yet"; callers fall back to the physical screen.
private struct ViewportHeightKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    @MainActor
    var componentRegistry: ComponentRegistry {
        get { self[ComponentRegistryKey.self] }
        set { self[ComponentRegistryKey.self] = newValue }
    }

    @MainActor
    var applicatorRegistry: ApplicatorRegistry {
        get { self[ApplicatorRegistryKey.self] }
        set { self[ApplicatorRegistryKey.self] = newValue }
    }

    var stretchCrossAxis: StretchCrossAxis {
        get { self[StretchCrossAxisKey.self] }
        set { self[StretchCrossAxisKey.self] = newValue }
    }

    /// Whether parent Column allows children to expand horizontally
    var parentAllowsHorizontalExpansion: Bool {
        get { self[ParentAllowsHorizontalExpansionKey.self] }
        set { self[ParentAllowsHorizontalExpansionKey.self] = newValue }
    }

    /// Whether parent Row allows children to expand vertically
    var parentAllowsVerticalExpansion: Bool {
        get { self[ParentAllowsVerticalExpansionKey.self] }
        set { self[ParentAllowsVerticalExpansionKey.self] = newValue }
    }

    /// Parent's explicit height for percentage height calculations
    var parentExplicitHeight: CGFloat? {
        get { self[ParentExplicitHeightKey.self] }
        set { self[ParentExplicitHeightKey.self] = newValue }
    }

    /// Parent's explicit width for percentage width calculations
    var parentExplicitWidth: CGFloat? {
        get { self[ParentExplicitWidthKey.self] }
        set { self[ParentExplicitWidthKey.self] = newValue }
    }

    /// Proportional width calculated from flex/weight in parent Row
    var proportionalWidth: CGFloat? {
        get { self[ProportionalWidthKey.self] }
        set { self[ProportionalWidthKey.self] = newValue }
    }

    /// Screen/window width for responsive breakpoints
    var screenWidth: CGFloat {
        get { self[ScreenWidthKey.self] }
        set { self[ScreenWidthKey.self] = newValue }
    }

    /// Height of the area the Hypen root was given, for `vh` units.
    var viewportHeight: CGFloat {
        get { self[ViewportHeightKey.self] }
        set { self[ViewportHeightKey.self] = newValue }
    }
}

// MARK: - View Modifiers

extension View {
    /// Set a custom component registry
    @MainActor
    public func componentRegistry(_ registry: ComponentRegistry) -> some View {
        environment(\.componentRegistry, registry)
    }

    /// Set a custom applicator registry
    @MainActor
    public func applicatorRegistry(_ registry: ApplicatorRegistry) -> some View {
        environment(\.applicatorRegistry, registry)
    }
}
