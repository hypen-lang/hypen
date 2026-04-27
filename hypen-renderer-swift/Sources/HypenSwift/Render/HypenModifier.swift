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

    // MARK: - Background Image (for component-level handling)

    public var backgroundImageUrl: String?
    public var backgroundSize: String?
    public var backgroundPosition: String?

    // MARK: - Border

    public var borderWidth: CGFloat = 0
    public var borderColor: Color?
    public var cornerRadius: CGFloat = 0
    public var borderStyle: String = "solid"

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
        return max(0, lineHeight - baseFontSize)
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

        // Border overrides
        if override.explicitlySetProperties.contains("borderWidth") { result.borderWidth = override.borderWidth }
        if let bc = override.borderColor { result.borderColor = bc }
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
        backgroundGradient != nil
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
            // Sizing with fraction support for percentage-based sizing
            // Note: fillMaxWidth is NOT applied here - it's conditionally applied
            // in HypenElementView based on parentAllowsHorizontalExpansion
            // This ensures children only expand when parent explicitly has width/height
            // Default alignment is topLeading to match web (flex-start) and Android (topStart)
            .frame(
                minWidth: modifier.minWidth,
                idealWidth: modifier.width,
                maxWidth: modifier.maxWidth,
                minHeight: modifier.minHeight,
                idealHeight: modifier.height,
                // NOTE: fillMaxHeight is NOT applied here - it's handled in HypenElementView.applyWeightExpansion
                // which has access to parentExplicitHeight for proper percentage calculations
                maxHeight: modifier.maxHeight,
                alignment: modifier.alignment ?? .topLeading
            )
            .frame(width: modifier.width, height: modifier.height)
            // Fill expansion BEFORE visual styles (padding, background, border)
            // so they fill the expanded area, not just the content area.
            // Only when there are no explicit constraints (maxWidth/width) that already
            // define the visual boundary (e.g., max-w-sm sets maxWidth which correctly
            // constrains background/border via the frame above).
            .applyFillExpansion(modifier)
            // Aspect ratio
            .aspectRatioIfPresent(modifier.aspectRatio)
            // Padding
            .padding(.top, modifier.paddingTop)
            .padding(.bottom, modifier.paddingBottom)
            .padding(.leading, modifier.paddingLeading)
            .padding(.trailing, modifier.paddingTrailing)
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

extension View {
    /// Apply horizontal fill expansion before visual styles (background, border) so they
    /// fill the expanded width. Only applies when fillMaxWidth is set WITHOUT explicit
    /// constraints (maxWidth/width), since constraints already define the visual boundary.
    /// Note: Vertical fill is NOT applied here — in a VStack, frame(maxHeight: .infinity)
    /// causes one child to consume all space, pushing siblings off screen. Vertical expansion
    /// remains solely in applyWeightExpansion where it's gated by parentAllowsVerticalExpansion.
    @ViewBuilder
    func applyFillExpansion(_ modifier: HypenModifier) -> some View {
        if modifier.fillMaxWidth && modifier.maxWidth == nil && modifier.width == nil {
            self.frame(
                maxWidth: .infinity,
                alignment: modifier.alignment ?? .topLeading
            )
        } else {
            self
        }
    }

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
        if let gradient = modifier.backgroundGradient {
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
        if modifier.borderWidth > 0, let borderColor = modifier.borderColor, modifier.borderStyle != "none" {
            switch modifier.borderStyle {
            case "dashed":
                self.overlay(
                    RoundedRectangle(cornerRadius: modifier.cornerRadius)
                        .stroke(style: StrokeStyle(
                            lineWidth: modifier.borderWidth,
                            dash: [modifier.borderWidth * 3, modifier.borderWidth * 2]
                        ))
                        .foregroundColor(borderColor)
                )
            case "dotted":
                self.overlay(
                    RoundedRectangle(cornerRadius: modifier.cornerRadius)
                        .stroke(style: StrokeStyle(
                            lineWidth: modifier.borderWidth,
                            lineCap: .round,
                            dash: [0, modifier.borderWidth * 2]
                        ))
                        .foregroundColor(borderColor)
                )
            case "double":
                // Double border: outer and inner stroke
                self.overlay(
                    ZStack {
                        RoundedRectangle(cornerRadius: modifier.cornerRadius)
                            .stroke(borderColor, lineWidth: modifier.borderWidth / 3)
                        RoundedRectangle(cornerRadius: max(0, modifier.cornerRadius - modifier.borderWidth * 2 / 3))
                            .stroke(borderColor, lineWidth: modifier.borderWidth / 3)
                            .padding(modifier.borderWidth * 2 / 3)
                    }
                )
            default: // "solid" and others
                self.overlay(
                    RoundedRectangle(cornerRadius: modifier.cornerRadius)
                        .stroke(borderColor, lineWidth: modifier.borderWidth)
                )
            }
        } else {
            self
        }
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
