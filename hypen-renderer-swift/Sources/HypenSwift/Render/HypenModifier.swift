import SwiftUI

/// A mutable modifier accumulator for Hypen styling
/// Collects style information that will be applied to SwiftUI views
public struct HypenModifier {
    // MARK: - Sizing

    public var width: CGFloat?
    public var height: CGFloat?
    public var minWidth: CGFloat?
    public var maxWidth: CGFloat?
    public var minHeight: CGFloat?
    public var maxHeight: CGFloat?
    public var fillMaxWidth: Bool = false
    public var fillMaxHeight: Bool = false
    public var fillMaxWidthFraction: CGFloat = 1.0
    public var fillMaxHeightFraction: CGFloat = 1.0
    public var aspectRatio: CGFloat?

    // MARK: - Spacing

    public var paddingTop: CGFloat = 0
    public var paddingBottom: CGFloat = 0
    public var paddingLeading: CGFloat = 0
    public var paddingTrailing: CGFloat = 0

    public var marginTop: CGFloat = 0
    public var marginBottom: CGFloat = 0
    public var marginLeading: CGFloat = 0
    public var marginTrailing: CGFloat = 0

    // MARK: - Gap (for layout containers)

    public var gap: CGFloat?
    public var rowGap: CGFloat?
    public var columnGap: CGFloat?

    // MARK: - Colors

    public var backgroundColor: Color?
    public var foregroundColor: Color?

    // MARK: - Gradients

    public var backgroundGradient: AnyShapeStyle?

    /// Parsed CSS `background` / `background-image` layers.
    ///
    /// Kept separate from `backgroundGradient` because a CSS value can stack
    /// an image UNDER a gradient (the home-screen wallpaper is exactly that:
    /// a darkening gradient over a photo), which a single shape style can't
    /// express.
    public var cssBackground: CssBackground.Layers?

    // MARK: - Background Image (for component-level handling)

    public var backgroundImageUrl: String?
    public var backgroundSize: String?
    public var backgroundPosition: String?

    // MARK: - Border

    public var borderWidth: CGFloat = 0
    public var borderColor: Color?
    public var cornerRadius: CGFloat = 0
    public var borderStyle: String = "solid"
    /// Per-side overrides (`borderTopWidth` … — Tailwind `border-t`/`border-b`).
    /// `nil` means "use `borderWidth`". Any set side switches the border to
    /// the directional renderer: straight stripes per edge, like CSS.
    public var borderTopWidth: CGFloat?
    public var borderRightWidth: CGFloat?
    public var borderBottomWidth: CGFloat?
    public var borderLeftWidth: CGFloat?

    // MARK: - Visual Effects

    public var opacity: Double = 1.0
    public var isVisible: Bool = true
    public var shadowColor: Color?
    public var shadowRadius: CGFloat = 0
    public var shadowX: CGFloat = 0
    public var shadowY: CGFloat = 0
    public var blurRadius: CGFloat = 0
    public var clipToBounds: Bool = false

    // MARK: - Transforms

    public var rotation: Double = 0
    public var scaleX: CGFloat = 1.0
    public var scaleY: CGFloat = 1.0
    public var offsetX: CGFloat = 0
    public var offsetY: CGFloat = 0
    public var translateX: CGFloat = 0
    public var translateY: CGFloat = 0

    // MARK: - Layout

    public var alignment: Alignment?
    public var weight: CGFloat?
    public var flexGrow: CGFloat?
    public var flexShrink: CGFloat?  // nil = default (can shrink), 0 = don't shrink
    public var zIndex: Double = 0

    // MARK: - Events

    public var onTap: (() -> Void)?
    public var onLongPress: (() -> Void)?
    public var onFocus: (() -> Void)?
    public var onBlur: (() -> Void)?

    // MARK: - Text Styling

    public var fontSize: CGFloat?
    public var fontWeight: Font.Weight?
    public var fontFamily: String?  // Font family name (system keyword or Google Font name)
    public var fontStyle: HypenModifier.FontStyle = .normal
    public var textAlignment: TextAlignment?
    public var lineHeight: CGFloat?  // Raw line height value
    public var kerning: CGFloat?

    /// Calculate actual line spacing from lineHeight and fontSize
    /// lineSpacing = lineHeight - fontSize (CSS line-height behavior)
    public var effectiveLineSpacing: CGFloat {
        guard let lineHeight = lineHeight else { return 0 }
        let baseFontSize = fontSize ?? 17  // Default iOS system font size
        // Unitless DSL values follow CSS and multiply the font size; larger
        // values remain supported as explicit point line heights.
        let resolvedLineHeight = lineHeight <= 4 ? lineHeight * baseFontSize : lineHeight
        return max(0, resolvedLineHeight - baseFontSize)
    }
    public var strikethrough: Bool = false
    public var underline: Bool = false
    public var textTransform: TextTransform?
    public var maxLines: Int?
    public var textOverflow: TextOverflowMode = .clip

    public enum FontStyle {
        case normal
        case italic
    }

    public enum TextTransform {
        case uppercase
        case lowercase
        case capitalize
    }

    public enum TextOverflowMode {
        case clip
        case ellipsis
        case visible
    }

    /// Tracks which properties were explicitly set by applicators (for variant merging)
    public var explicitlySetProperties: Set<String> = []

    public init() {}

    /// Merge an override modifier into this base modifier.
    /// Uses explicitlySetProperties for value-type fields so overrides can reset to zero.
    /// Optional fields use nil-check (nil genuinely means "not set").
    public static func mergeOverride(base: HypenModifier, override: HypenModifier) -> HypenModifier {
        var result = base

        // Size overrides (Optional - nil means not set)
        if let w = override.width { result.width = w }
        if let h = override.height { result.height = h }
        if let mw = override.minWidth { result.minWidth = mw }
        if let mxw = override.maxWidth { result.maxWidth = mxw }
        if let mh = override.minHeight { result.minHeight = mh }
        if let mxh = override.maxHeight { result.maxHeight = mxh }

        // Spacing overrides
        if override.explicitlySetProperties.contains("paddingTop") { result.paddingTop = override.paddingTop }
        if override.explicitlySetProperties.contains("paddingBottom") { result.paddingBottom = override.paddingBottom }
        if override.explicitlySetProperties.contains("paddingLeading") { result.paddingLeading = override.paddingLeading }
        if override.explicitlySetProperties.contains("paddingTrailing") { result.paddingTrailing = override.paddingTrailing }
        if override.explicitlySetProperties.contains("marginTop") { result.marginTop = override.marginTop }
        if override.explicitlySetProperties.contains("marginBottom") { result.marginBottom = override.marginBottom }
        if override.explicitlySetProperties.contains("marginLeading") { result.marginLeading = override.marginLeading }
        if override.explicitlySetProperties.contains("marginTrailing") { result.marginTrailing = override.marginTrailing }

        // Gap overrides (Optional)
        if let g = override.gap { result.gap = g }
        if let rg = override.rowGap { result.rowGap = rg }
        if let cg = override.columnGap { result.columnGap = cg }

        // Color overrides (Optional)
        if let bg = override.backgroundColor { result.backgroundColor = bg }
        if let fg = override.foregroundColor { result.foregroundColor = fg }

        // Gradient override (Optional)
        if let grad = override.backgroundGradient { result.backgroundGradient = grad }
        if let css = override.cssBackground { result.cssBackground = css }

        // Border overrides
        if override.explicitlySetProperties.contains("borderWidth") { result.borderWidth = override.borderWidth }
        if let bc = override.borderColor { result.borderColor = bc }
        if let v = override.borderTopWidth { result.borderTopWidth = v }
        if let v = override.borderRightWidth { result.borderRightWidth = v }
        if let v = override.borderBottomWidth { result.borderBottomWidth = v }
        if let v = override.borderLeftWidth { result.borderLeftWidth = v }
        if override.explicitlySetProperties.contains("cornerRadius") { result.cornerRadius = override.cornerRadius }
        if override.explicitlySetProperties.contains("borderStyle") { result.borderStyle = override.borderStyle }

        // Text overrides (Optional)
        if let fs = override.fontSize { result.fontSize = fs }
        if let fw = override.fontWeight { result.fontWeight = fw }
        if let ta = override.textAlignment { result.textAlignment = ta }

        // Visual effect overrides
        if override.explicitlySetProperties.contains("opacity") { result.opacity = override.opacity }

        // Shadow overrides
        if let sc = override.shadowColor { result.shadowColor = sc }
        if override.explicitlySetProperties.contains("shadowRadius") { result.shadowRadius = override.shadowRadius }
        if override.explicitlySetProperties.contains("shadowX") { result.shadowX = override.shadowX }
        if override.explicitlySetProperties.contains("shadowY") { result.shadowY = override.shadowY }

        // Transform overrides
        if override.explicitlySetProperties.contains("scaleX") { result.scaleX = override.scaleX }
        if override.explicitlySetProperties.contains("scaleY") { result.scaleY = override.scaleY }
        if override.explicitlySetProperties.contains("rotation") { result.rotation = override.rotation }
        if override.explicitlySetProperties.contains("translateX") { result.translateX = override.translateX }
        if override.explicitlySetProperties.contains("translateY") { result.translateY = override.translateY }

        return result
    }

    // MARK: - Convenience Methods

    public mutating func setPadding(all value: CGFloat) {
        paddingTop = value
        paddingBottom = value
        paddingLeading = value
        paddingTrailing = value
        explicitlySetProperties.formUnion(["paddingTop", "paddingBottom", "paddingLeading", "paddingTrailing"])
    }

    public mutating func setPadding(horizontal: CGFloat? = nil, vertical: CGFloat? = nil) {
        if let h = horizontal {
            paddingLeading = h
            paddingTrailing = h
            explicitlySetProperties.formUnion(["paddingLeading", "paddingTrailing"])
        }
        if let v = vertical {
            paddingTop = v
            paddingBottom = v
            explicitlySetProperties.formUnion(["paddingTop", "paddingBottom"])
        }
    }

    public mutating func setMargin(all value: CGFloat) {
        marginTop = value
        marginBottom = value
        marginLeading = value
        marginTrailing = value
        explicitlySetProperties.formUnion(["marginTop", "marginBottom", "marginLeading", "marginTrailing"])
    }

    public mutating func setScale(_ value: CGFloat) {
        scaleX = value
        scaleY = value
        explicitlySetProperties.formUnion(["scaleX", "scaleY"])
    }

    public var hasPadding: Bool {
        paddingTop != 0 || paddingBottom != 0 || paddingLeading != 0 || paddingTrailing != 0
    }

    public var hasMargin: Bool {
        marginTop != 0 || marginBottom != 0 || marginLeading != 0 || marginTrailing != 0
    }

    public var hasBorder: Bool {
        borderWidth > 0 && borderColor != nil
    }

    public var hasShadow: Bool {
        shadowRadius > 0 || shadowColor != nil
    }

    public var hasTransform: Bool {
        rotation != 0 || scaleX != 1.0 || scaleY != 1.0 || offsetX != 0 || offsetY != 0 || translateX != 0 || translateY != 0
    }

    public var hasGradientBackground: Bool {
        backgroundGradient != nil || !(cssBackground?.gradients.isEmpty ?? true)
    }
}

// MARK: - View Extension

extension View {
    /// Apply a HypenModifier to a view
    @ViewBuilder
    public func hypenModifier(_ modifier: HypenModifier) -> some View {
        self
            // Note: Weight expansion is now applied in HypenElementView, checking parent environment
            // Visibility
            .opacity(modifier.isVisible ? modifier.opacity : 0)
            // Padding belongs inside Hypen's declared dimensions. SwiftUI's
            // modifier order is significant: applying a frame first turns
            // padding into extra outer size (content-box sizing).
            .padding(.top, modifier.paddingTop)
            .padding(.bottom, modifier.paddingBottom)
            .padding(.leading, modifier.paddingLeading)
            .padding(.trailing, modifier.paddingTrailing)
            // The border ring sits OUTSIDE the padding and inside the border
            // box, exactly like CSS / Compose: `p-0.5` + `border-2` leaves a
            // visible 2pt gap between content and ring. Reserving the ring
            // here (instead of stroking the edge as a zero-size overlay) is
            // what keeps a bordered avatar identical across web/Android/iOS.
            .padding(.top, modifier.layoutBorderInsets.top)
            .padding(.bottom, modifier.layoutBorderInsets.bottom)
            .padding(.leading, modifier.layoutBorderInsets.leading)
            .padding(.trailing, modifier.layoutBorderInsets.trailing)
            // Establish the decorated border box after padding + border.
            .applyBorderBoxSizing(modifier)
            // Fill expansion is also a declared outer size, so percentage/full
            // widths include padding instead of growing beyond the requested box.
            .applyFillExpansion(modifier)
            // Preserve the prior sizing contract: aspect ratio resolves from
            // the declared/fill width, but before background and border paint.
            // A single explicit axis is resolved directly by the border-box
            // constraints because SwiftUI cannot infer the missing dimension
            // from an already-fixed child under an unspecified outer proposal.
            .aspectRatioIfPresent(
                modifier.resolvesAspectRatioInBorderBox ? nil : modifier.aspectRatio
            )
            // Background (gradient or solid color)
            .backgroundStyle(modifier)
            .cornerRadius(modifier.cornerRadius)
            // Clip to bounds
            .clipped(modifier.clipToBounds)
            // Border with style support
            .borderOverlay(modifier)
            // Shadow
            .shadow(
                color: modifier.shadowColor ?? .clear,
                radius: modifier.shadowRadius,
                x: modifier.shadowX,
                y: modifier.shadowY
            )
            // Blur
            .blur(radius: modifier.blurRadius)
            // Transforms
            .rotationEffect(.degrees(modifier.rotation))
            .scaleEffect(x: modifier.scaleX, y: modifier.scaleY)
            // Offset
            .offset(
                x: modifier.offsetX + modifier.translateX,
                y: modifier.offsetY + modifier.translateY
            )
            // Margin (as outer padding)
            .padding(.top, modifier.marginTop)
            .padding(.bottom, modifier.marginBottom)
            .padding(.leading, modifier.marginLeading)
            .padding(.trailing, modifier.marginTrailing)
            // Z-index
            .zIndex(modifier.zIndex)
            // Foreground color - only apply if explicitly set to allow inheritance
            .applyForegroundColor(modifier.foregroundColor)
    }
}

// MARK: - Helper Extensions

/// Normalized constraints for the decorated Hypen box (content + padding + border).
///
/// SwiftUI applies modifiers from the inside out. Keeping this resolution separate
/// makes the CSS-style `min > max` rule (minimum wins) and explicit-size clamping
/// deterministic before the frames are installed.
struct BorderBoxConstraints: Equatable {
    let width: CGFloat?
    let height: CGFloat?
    let minWidth: CGFloat?
    let maxWidth: CGFloat?
    let minHeight: CGFloat?
    let maxHeight: CGFloat?

    init(modifier: HypenModifier) {
        var horizontal = Self.resolve(
            explicit: modifier.width,
            minimum: modifier.minWidth,
            maximum: modifier.maxWidth
        )
        var vertical = Self.resolve(
            explicit: modifier.height,
            minimum: modifier.minHeight,
            maximum: modifier.maxHeight
        )

        if modifier.resolvesAspectRatioInBorderBox,
           let aspectRatio = modifier.aspectRatio,
           aspectRatio > 0 {
            if let explicitWidth = horizontal.explicit, modifier.height == nil {
                vertical = Self.resolve(
                    explicit: explicitWidth / aspectRatio,
                    minimum: modifier.minHeight,
                    maximum: modifier.maxHeight
                )
            } else if let explicitHeight = vertical.explicit, modifier.width == nil {
                horizontal = Self.resolve(
                    explicit: explicitHeight * aspectRatio,
                    minimum: modifier.minWidth,
                    maximum: modifier.maxWidth
                )
            }
        }

        width = horizontal.explicit
        minWidth = horizontal.minimum
        maxWidth = horizontal.maximum
        height = vertical.explicit
        minHeight = vertical.minimum
        maxHeight = vertical.maximum
    }

    private static func resolve(
        explicit: CGFloat?,
        minimum: CGFloat?,
        maximum: CGFloat?
    ) -> (explicit: CGFloat?, minimum: CGFloat?, maximum: CGFloat?) {
        // CSS sizing gives min-size precedence when min and max conflict.
        let normalizedMaximum = maximum.map { max($0, minimum ?? $0) }

        guard let explicit else {
            return (nil, minimum, normalizedMaximum)
        }

        var resolved = explicit
        if let normalizedMaximum { resolved = min(resolved, normalizedMaximum) }
        if let minimum { resolved = max(resolved, minimum) }
        return (resolved, nil, nil)
    }
}

private struct BorderBoxSizingModifier: ViewModifier {
    @Environment(\.parentControlsHorizontalSizing) private var parentControlsHorizontalSizing
    let modifier: HypenModifier

    @ViewBuilder
    func body(content: Content) -> some View {
        let constraints = BorderBoxConstraints(modifier: modifier)
        if parentControlsHorizontalSizing,
           constraints.width != nil,
           let flexShrink = modifier.flexShrink,
           flexShrink > 0 {
            // Inside a managed Row, an explicit width is the flex basis, not
            // an unbreakable SwiftUI frame only when the author explicitly
            // opted into shrinking. The allocator carries that basis in
            // RowItemSizing and proposes the resolved slot here. Ordinary
            // fixed-size siblings (avatars, artwork and list indices) must
            // retain their exact frame even when another sibling is flexible;
            // treating nil as CSS's implicit shrink made those boxes paint the
            // entire allocated row slot. flexShrink(0) also stays exact below.
            content
                .frame(
                    minWidth: modifier.minWidth,
                    maxWidth: .infinity,
                    minHeight: constraints.minHeight,
                    maxHeight: constraints.maxHeight,
                    alignment: modifier.alignment ?? .topLeading
                )
                .frame(
                    height: constraints.height,
                    alignment: modifier.alignment ?? .topLeading
                )
        } else {
            content
                .frame(
                    minWidth: constraints.minWidth,
                    maxWidth: constraints.maxWidth,
                    minHeight: constraints.minHeight,
                    // fillMaxHeight remains handled by `applyWeightExpansion`,
                    // where the renderer has the parent height available.
                    maxHeight: constraints.maxHeight,
                    alignment: modifier.alignment ?? .topLeading
                )
                .frame(
                    width: constraints.width,
                    height: constraints.height,
                    alignment: modifier.alignment ?? .topLeading
                )
        }
    }
}

extension View {
    func applyBorderBoxSizing(_ modifier: HypenModifier) -> some View {
        self.modifier(BorderBoxSizingModifier(modifier: modifier))
    }
}

extension HypenModifier {
    /// The immediate space available to children inside this element's padding.
    /// Hypen dimensions use border-box sizing, so percentages must resolve from
    /// this content box rather than from the declared outer dimension.
    var explicitContentWidth: CGFloat? {
        width.map { max(0, $0 - paddingLeading - paddingTrailing - layoutBorderInsets.leading - layoutBorderInsets.trailing) }
    }

    var explicitContentHeight: CGFloat? {
        height.map { max(0, $0 - paddingTop - paddingBottom - layoutBorderInsets.top - layoutBorderInsets.bottom) }
    }

    /// Whether a border is drawn at all (a width without a colour, or
    /// `borderStyle: none`, draws nothing and takes no layout space).
    var drawsBorder: Bool {
        borderColor != nil && borderStyle != "none"
    }

    /// Whether any side overrides the uniform width — the border is then
    /// rendered as per-edge stripes instead of one stroked shape.
    var hasDirectionalBorder: Bool {
        borderTopWidth != nil || borderRightWidth != nil || borderBottomWidth != nil || borderLeftWidth != nil
    }

    /// Effective drawn width per physical edge (0 when nothing is drawn).
    var effectiveBorderWidths: (top: CGFloat, right: CGFloat, bottom: CGFloat, left: CGFloat) {
        guard drawsBorder else { return (0, 0, 0, 0) }
        return (
            max(0, borderTopWidth ?? borderWidth),
            max(0, borderRightWidth ?? borderWidth),
            max(0, borderBottomWidth ?? borderWidth),
            max(0, borderLeftWidth ?? borderWidth)
        )
    }

    /// Border width that participates in layout (uniform case): a drawn
    /// border consumes a ring of space inside the border box (outside the
    /// padding), matching CSS border-box and Compose `Modifier.border` +
    /// padding order.
    var layoutBorderWidth: CGFloat {
        (borderWidth > 0 && drawsBorder) ? borderWidth : 0
    }

    /// Per-edge layout space taken by the border. Leading/trailing map to
    /// left/right — Hypen borders are physical, like CSS `border-left`.
    var layoutBorderInsets: EdgeInsets {
        let w = effectiveBorderWidths
        return EdgeInsets(top: w.top, leading: w.left, bottom: w.bottom, trailing: w.right)
    }

    /// Content proposal that yields an exact filled border box after this
    /// element's own padding and border ring are applied.
    func contentHeight(forFilledBorderBox borderBoxHeight: CGFloat) -> CGFloat {
        max(0, borderBoxHeight - paddingTop - paddingBottom - layoutBorderInsets.top - layoutBorderInsets.bottom)
    }

    /// Whether one explicit axis can deterministically resolve the other axis
    /// before visual styling. A fill on the missing axis remains authoritative
    /// and continues through SwiftUI's existing aspect-ratio path.
    var resolvesAspectRatioInBorderBox: Bool {
        guard let aspectRatio, aspectRatio > 0 else { return false }
        if width != nil, height == nil { return !fillMaxHeight }
        if height != nil, width == nil { return !fillMaxWidth }
        return false
    }
}

/// The horizontal size that must be established before padding, background,
/// and border are applied.
///
/// Percentage widths cannot use the same `.frame(maxWidth: .infinity)` path
/// as a boolean `fillMaxWidth`: doing so paints the element at 100% and a later
/// fractional frame only changes its outer layout box.
enum HorizontalFillExpansion: Equatable {
    case none
    case full
    case exact(CGFloat)
    case relative(fraction: CGFloat, minWidth: CGFloat?, maxWidth: CGFloat?)
}

extension HypenModifier {
    /// Resolve the pre-visual horizontal expansion for this modifier.
    ///
    /// An explicit width already establishes the visual boundary. A max-width,
    /// however, caps the requested fill rather than disabling it. When the
    /// parent exposes an exact width, percentages become exact frames;
    /// otherwise SwiftUI resolves both the fraction and cap against the nearest
    /// container.
    func horizontalFillExpansion(
        parentWidth: CGFloat?,
        parentAllowsHorizontalExpansion: Bool
    ) -> HorizontalFillExpansion {
        guard width == nil else { return .none }

        func constrained(_ requestedWidth: CGFloat) -> CGFloat {
            var result = requestedWidth
            if let maxWidth { result = min(result, maxWidth) }
            if let minWidth { result = max(result, minWidth) }
            return result
        }

        if fillMaxWidth {
            let fraction = min(max(fillMaxWidthFraction, 0), 1)
            guard fraction > 0 else { return .none }
            if fraction < 1 {
                if let parentWidth {
                    return .exact(constrained(parentWidth * fraction))
                }
                return .relative(fraction: fraction, minWidth: minWidth, maxWidth: maxWidth)
            }
            if maxWidth != nil {
                if let parentWidth {
                    return .exact(constrained(parentWidth))
                }
                return .relative(fraction: 1, minWidth: minWidth, maxWidth: maxWidth)
            }
            return .full
        }

        let hasWeight = (weight ?? 0) > 0
        if hasWeight && parentAllowsHorizontalExpansion {
            if maxWidth != nil {
                if let parentWidth {
                    return .exact(constrained(parentWidth))
                }
                return .relative(fraction: 1, minWidth: minWidth, maxWidth: maxWidth)
            }
            return .full
        }

        return .none
    }

    /// Fractional fill is fully resolved before visual modifiers. Re-wrapping
    /// it after background/border application recreates the 100%-paint bug.
    var hasFractionalFillWidth: Bool {
        fillMaxWidth && fillMaxWidthFraction > 0 && fillMaxWidthFraction < 1
    }
}

extension View {
    /// Apply horizontal fill expansion before visual styles (background, border) so they
    /// fill the expanded width. An explicit width opts out; maxWidth is folded into the
    /// resolved fill so the painted width is capped instead of merely hugging content.
    /// Note: Vertical fill is NOT applied here — in a VStack, frame(maxHeight: .infinity)
    /// causes one child to consume all space, pushing siblings off screen. Vertical expansion
    /// remains solely in applyWeightExpansion where it's gated by parentAllowsVerticalExpansion.
    @ViewBuilder
    func applyFillExpansion(_ modifier: HypenModifier) -> some View {
        self.modifier(FillExpansionModifier(modifier: modifier))
    }
}

/// Expands the view to fill available horizontal space *before* visual styles
/// (background, border) so they cover the expanded area. Triggered by
/// `fillMaxWidth`, or by `weight > 0` (flex-1) when the parent is a horizontal
/// container — matches CSS `flex: 1` semantics where the child grows along
/// the main axis. Without this inline expansion, the outer
/// `applyWeightExpansion` wrap would grow the layout box but leave the
/// background painted at content width, so e.g. tab-row pills hug their text.
private struct FillExpansionModifier: ViewModifier {
    @Environment(\.parentAllowsHorizontalExpansion) private var parentAllowsHorizontalExpansion
    @Environment(\.parentAllowsVerticalExpansion) private var parentAllowsVerticalExpansion
    @Environment(\.parentExplicitWidth) private var parentExplicitWidth
    @Environment(\.parentControlsHorizontalSizing) private var parentControlsHorizontalSizing
    @Environment(\.parentStretchesHorizontalSizing) private var parentStretchesHorizontalSizing
    @Environment(\.parentTrackAlignment) private var parentTrackAlignment
    let modifier: HypenModifier

    @ViewBuilder
    func body(content: Content) -> some View {
        let prefilled = content.frame(
            maxHeight: parentAllowsVerticalExpansion
                && modifier.fillMaxHeight
                && modifier.fillMaxHeightFraction >= 1
                && modifier.maxHeight == nil
                ? .infinity
                : nil,
            alignment: modifier.alignment ?? .topLeading
        )
        if parentStretchesHorizontalSizing &&
            modifier.width == nil && modifier.maxWidth == nil && !modifier.hasFractionalFillWidth {
            if #available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *) {
                HorizontalTrackStretchLayout(
                    alignment: parentTrackAlignment ?? modifier.alignment ?? .topLeading
                ) {
                    prefilled
                }
            } else {
                prefilled.frame(
                    maxWidth: .infinity,
                    alignment: parentTrackAlignment ?? modifier.alignment ?? .topLeading
                )
            }
        } else if parentControlsHorizontalSizing && (
            modifier.fillMaxWidth
                || (modifier.weight ?? 0) > 0
                || (modifier.flexGrow ?? 0) > 0
        ) {
            prefilled.frame(
                maxWidth: .infinity,
                alignment: modifier.alignment ?? .topLeading
            )
        } else {
            switch modifier.horizontalFillExpansion(
                parentWidth: parentExplicitWidth,
                parentAllowsHorizontalExpansion: parentAllowsHorizontalExpansion
            ) {
            case .none:
                prefilled
            case .full:
                prefilled.frame(
                    maxWidth: .infinity,
                    alignment: modifier.alignment ?? .topLeading
                )
            case .exact(let width):
                prefilled.frame(
                    width: width,
                    alignment: modifier.alignment ?? .topLeading
                )
            case .relative(let fraction, let minWidth, let maxWidth):
                if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) {
                    prefilled.containerRelativeFrame(.horizontal) { length, _ in
                        let requestedWidth = length * fraction
                        return max(
                            min(requestedWidth, maxWidth ?? requestedWidth),
                            minWidth ?? requestedWidth
                        )
                    }
                } else {
                    // Older SwiftUI has no immediate-container percentage API.
                    // Fixed-width parents use `.exact` above; for an unconstrained
                    // root, the viewport is the closest deterministic equivalent.
                    prefilled.frame(
                        width: max(
                            min(
                                getScreenWidth() * fraction,
                                maxWidth ?? getScreenWidth() * fraction
                            ),
                            minWidth ?? getScreenWidth() * fraction
                        ),
                        alignment: modifier.alignment ?? .topLeading
                    )
                }
            }
        }
    }
}

/// Accepts a Grid/List track's finite width without turning the child itself
/// into a full-width flexible frame. SwiftUI's flexible frame reports the
/// track width but can measure its child intrinsically at leading on iOS;
/// explicit placement keeps authored center/trailing alignment deterministic.
@available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *)
struct HorizontalTrackStretchLayout: Layout {
    let alignment: Alignment

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        guard let subview = subviews.first else {
            return CGSize(width: proposal.width ?? 0, height: 0)
        }
        let childSize = subview.sizeThatFits(
            ProposedViewSize(width: proposal.width, height: nil)
        )
        return CGSize(width: proposal.width ?? childSize.width, height: childSize.height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        guard let subview = subviews.first else { return }
        let childSize = subview.sizeThatFits(
            ProposedViewSize(width: bounds.width, height: nil)
        )
        let x: CGFloat
        switch alignment.horizontal {
        case .center: x = bounds.midX - childSize.width / 2
        case .trailing: x = bounds.maxX - childSize.width
        default: x = bounds.minX
        }
        let y: CGFloat
        switch alignment.vertical {
        case .center: y = bounds.midY - childSize.height / 2
        case .bottom: y = bounds.maxY - childSize.height
        default: y = bounds.minY
        }
        subview.place(
            at: CGPoint(x: x, y: y),
            anchor: .topLeading,
            proposal: ProposedViewSize(width: childSize.width, height: childSize.height)
        )
    }
}

extension View {
    @ViewBuilder
    func aspectRatioIfPresent(_ ratio: CGFloat?) -> some View {
        if let ratio = ratio {
            self.aspectRatio(ratio, contentMode: .fit)
        } else {
            self
        }
    }

    /// Apply fractional fill for percentage-based sizing
    /// Note: containerRelativeFrame calculates relative to the nearest scrollable container or root,
    /// not the immediate parent. This means percentage heights may not work as expected when the
    /// parent has a fixed height. For accurate percentage sizing relative to immediate parent,
    /// use explicit pixel values or viewport units (vh/vw).
    @ViewBuilder
    func fillFraction(widthFraction: CGFloat?, heightFraction: CGFloat?) -> some View {
        if widthFraction != nil || heightFraction != nil {
            if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) {
                // Use containerRelativeFrame for iOS 17+
                self.applyContainerRelativeFrame(widthFraction: widthFraction, heightFraction: heightFraction)
            } else {
                // Fallback for older iOS: percentage sizing not fully supported
                // Just apply a fixed frame based on screen dimensions as approximation
                self.frame(
                    width: widthFraction.map { $0 * getScreenWidth() },
                    height: heightFraction.map { $0 * getScreenHeight() }
                )
            }
        } else {
            self
        }
    }

    /// Apply container relative frame for iOS 17+
    @available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *)
    @ViewBuilder
    func applyContainerRelativeFrame(widthFraction: CGFloat?, heightFraction: CGFloat?) -> some View {
        switch (widthFraction, heightFraction) {
        case let (w?, h?):
            self
                .containerRelativeFrame(.horizontal) { length, _ in length * w }
                .containerRelativeFrame(.vertical) { length, _ in length * h }
        case let (w?, nil):
            self
                .containerRelativeFrame(.horizontal) { length, _ in length * w }
        case let (nil, h?):
            self
                .containerRelativeFrame(.vertical) { length, _ in length * h }
        case (nil, nil):
            self
        }
    }

    @ViewBuilder
    func backgroundStyle(_ modifier: HypenModifier) -> some View {
        if let layers = modifier.cssBackground {
            // `backgroundColor` is passed as the bottom layer, not dropped:
            // an element can declare the `background-color` longhand AND a
            // `background-image`, and CSS composites the colour underneath.
            // Selecting the CSS layers alone let transparent gradient stops
            // and image pixels expose the parent instead of that colour.
            self.background(
                CssBackgroundView(
                    layers: layers,
                    baseColor: modifier.backgroundColor,
                    cornerRadius: modifier.cornerRadius
                )
            )
        } else if let gradient = modifier.backgroundGradient {
            self.background(
                RoundedRectangle(cornerRadius: modifier.cornerRadius)
                    .fill(gradient)
            )
        } else if let color = modifier.backgroundColor {
            self.background(color)
        } else {
            self  // No background needed
        }
    }

    @ViewBuilder
    func clipped(_ shouldClip: Bool) -> some View {
        if shouldClip {
            self.clipped()
        } else {
            self
        }
    }

    /// Apply foreground color only if explicitly set, allowing inheritance from parent views
    @ViewBuilder
    func applyForegroundColor(_ color: Color?) -> some View {
        if let color = color {
            self.foregroundStyle(color)
        } else {
            self
        }
    }

    /// Apply weight to make view expand in parent layout
    /// Weight makes the view take remaining space (like flex: 1 in CSS or weight in Android)
    /// In Row context: expands horizontally
    /// In Column context: expands vertically
    @ViewBuilder
    func applyWeight(_ weight: CGFloat?) -> some View {
        if let weight = weight, weight > 0 {
            // Weight > 0 means expand to take remaining space
            // Use maxWidth: .infinity to expand horizontally (most common use case in Row)
            // Alignment is topLeading to match web/Android behavior
            self.frame(maxWidth: .infinity, alignment: .topLeading)
        } else {
            self
        }
    }

    @ViewBuilder
    func borderOverlay(_ modifier: HypenModifier) -> some View {
        if modifier.hasDirectionalBorder, let borderColor = modifier.borderColor, modifier.borderStyle != "none" {
            // Per-side widths (`border-t`, `border-b`, …): straight stripes
            // along each edge inside the bounds, ignoring the corner radius —
            // the CSS rendering of a single-side border.
            let w = modifier.effectiveBorderWidths
            self.overlay(
                Canvas { ctx, size in
                    if w.top > 0 { ctx.fill(Path(CGRect(x: 0, y: 0, width: size.width, height: w.top)), with: .color(borderColor)) }
                    if w.bottom > 0 { ctx.fill(Path(CGRect(x: 0, y: size.height - w.bottom, width: size.width, height: w.bottom)), with: .color(borderColor)) }
                    if w.left > 0 { ctx.fill(Path(CGRect(x: 0, y: 0, width: w.left, height: size.height)), with: .color(borderColor)) }
                    if w.right > 0 { ctx.fill(Path(CGRect(x: size.width - w.right, y: 0, width: w.right, height: size.height)), with: .color(borderColor)) }
                }
                .allowsHitTesting(false)
            )
        } else if modifier.borderWidth > 0, let borderColor = modifier.borderColor, modifier.borderStyle != "none" {
            switch borderRenderingStyle(modifier.borderStyle, width: modifier.borderWidth) {
            case .dashed(let dash):
                self.overlay(
                    RoundedRectangle(cornerRadius: modifier.cornerRadius)
                        .inset(by: modifier.borderWidth / 2)
                        .stroke(style: StrokeStyle(
                            lineWidth: modifier.borderWidth,
                            dash: dash
                        ))
                        .foregroundColor(borderColor)
                )
            case .dotted(let dash):
                self.overlay(
                    RoundedRectangle(cornerRadius: modifier.cornerRadius)
                        .inset(by: modifier.borderWidth / 2)
                        .stroke(style: StrokeStyle(
                            lineWidth: modifier.borderWidth,
                            lineCap: .round,
                            dash: dash
                        ))
                        .foregroundColor(borderColor)
                )
            case .double:
                // Double border: outer and inner stroke
                self.overlay(
                    ZStack {
                        RoundedRectangle(cornerRadius: modifier.cornerRadius)
                            .inset(by: modifier.borderWidth / 6)
                            .stroke(borderColor, lineWidth: modifier.borderWidth / 3)
                        RoundedRectangle(cornerRadius: modifier.cornerRadius)
                            .inset(by: modifier.borderWidth * 5 / 6)
                            .stroke(borderColor, lineWidth: modifier.borderWidth / 3)
                    }
                )
            case .solid:
                // Inset by half the line width so the full stroke lies inside
                // the bounds — the ring of space `hypenModifier` reserved for it.
                self.overlay(
                    RoundedRectangle(cornerRadius: modifier.cornerRadius)
                        .inset(by: modifier.borderWidth / 2)
                        .stroke(borderColor, lineWidth: modifier.borderWidth)
                )
            }
        } else {
            self
        }
    }
}

/// The effective paint recipe for a supported border style.
///
/// Keeping the dash arrays in this small value type makes the visual contract
/// testable without snapshotting host-dependent SwiftUI antialiasing.
enum BorderRenderingStyle: Equatable {
    case solid
    case dashed([CGFloat])
    case dotted([CGFloat])
    case double
}

func borderRenderingStyle(_ style: String, width: CGFloat) -> BorderRenderingStyle {
    switch canonicalBorderStyle(style) {
    case "dashed":
        return .dashed([width * 3, width * 2])
    case "dotted":
        return .dotted([0, width * 2])
    case "double":
        return .double
    default:
        return .solid
    }
}

// MARK: - Custom Dashed Border Shape

/// A shape that draws a dashed rounded rectangle
struct DashedRoundedRectangle: Shape {
    let cornerRadius: CGFloat
    let dashLength: CGFloat
    let gapLength: CGFloat

    func path(in rect: CGRect) -> Path {
        RoundedRectangle(cornerRadius: cornerRadius).path(in: rect)
    }
}

/// A shape that draws a dotted rounded rectangle
struct DottedRoundedRectangle: Shape {
    let cornerRadius: CGFloat
    let dotSpacing: CGFloat

    func path(in rect: CGRect) -> Path {
        RoundedRectangle(cornerRadius: cornerRadius).path(in: rect)
    }
}
