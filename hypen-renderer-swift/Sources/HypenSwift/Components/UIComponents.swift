import SwiftUI

// MARK: - Card Component

public struct CardComponent: ComponentHandler {
    public let typeName = "card"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let elevation = context.element.getCGFloatProp("elevation.0") ?? 2
        let cornerRadius = modifier.cornerRadius > 0 ? modifier.cornerRadius : 8

        var cardModifier = modifier
        if cardModifier.shadowRadius == 0 {
            cardModifier.shadowRadius = elevation
            cardModifier.shadowColor = Color.black.opacity(0.2)
            cardModifier.shadowY = elevation / 2
        }
        if cardModifier.cornerRadius == 0 {
            cardModifier.cornerRadius = cornerRadius
        }
        if cardModifier.backgroundColor == nil {
            #if os(iOS) || os(tvOS)
            cardModifier.backgroundColor = Color(uiColor: .systemBackground)
            #elseif os(macOS)
            cardModifier.backgroundColor = Color(nsColor: .windowBackgroundColor)
            #else
            cardModifier.backgroundColor = .white
            #endif
        }
        // Default padding of 16 to match Android/Web
        if !cardModifier.hasPadding {
            cardModifier.setPadding(all: 16)
        }

        return AnyView(
            VStack(alignment: .leading, spacing: 0) {
                children()
            }
            .hypenModifier(cardModifier)
        )
    }
}

// MARK: - Spinner Component

public struct SpinnerComponent: ComponentHandler {
    public let typeName = "spinner"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let size = context.element.getStringProp("size.0") ?? "medium"
        let color = ColorParser.parse(context.element.props["color.0"])
            ?? Color(red: 59 / 255, green: 130 / 255, blue: 246 / 255)
        let animated = context.element.getBoolProp("animated")
            ?? context.element.getBoolProp("animated.0")
            ?? true
        let diameter = modifier.width
            ?? modifier.height
            ?? diameterForSize(size)

        return AnyView(
            Group {
                if animated {
                    ProgressView()
                } else {
                    ProgressView(value: 0.75)
                }
            }
                .progressViewStyle(.circular)
                // SwiftUI's circular ProgressView keeps the same glyph size
                // when only its frame changes. Scale the glyph as well so
                // authored 20/40/60 sizes match the other renderers.
                .scaleEffect(diameter / 20)
                .frame(width: diameter, height: diameter)
                .tint(color)
                .hypenModifier(modifier)
        )
    }

    private func diameterForSize(_ size: String) -> CGFloat {
        switch size.lowercased() {
        case "small": return 20
        case "large": return 60
        default: return 40
        }
    }
}

// MARK: - ProgressBar Component

public struct ProgressBarComponent: ComponentHandler {
    public let typeName = "progressbar"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let rawProgress = context.element.getDoubleProp("progress")
            ?? context.element.getDoubleProp("progress.0")
            ?? context.element.getDoubleProp("value")
            ?? context.element.getDoubleProp("value.0")
            ?? 0
        let progress = rawProgress > 1 ? rawProgress / 100 : rawProgress

        let color = ColorParser.parse(context.element.props["color.0"])
        let backgroundColor = ColorParser.parse(context.element.props["trackColor.0"])

        return AnyView(
            ProgressView(value: min(max(progress, 0), 1))
                .progressViewStyle(.linear)
                .tint(color)
                .background(backgroundColor ?? Color.gray.opacity(0.2))
                .hypenModifier(modifier)
        )
    }
}

// MARK: - Badge Component

public struct BadgeComponent: ComponentHandler {
    public let typeName = "badge"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let text = context.element.textContent
            ?? context.element.getStringProp("text")
            ?? context.element.getStringProp("0")
            ?? ""

        let resolution = resolveBadgeModifier(modifier)
        let badgeModifier = resolution.modifier
        let fontSize = badgeModifier.fontSize ?? BadgeDefaults.fontSize
        let fontWeight = badgeModifier.fontWeight ?? BadgeDefaults.fontWeight

        return AnyView(
            Group {
                if text.isEmpty {
                    children()
                } else {
                    Text(text)
                }
            }
            // Parent font values are inherited by renderer-owned Text children,
            // while a child with explicit typography can still override them.
            .font(.system(size: fontSize, weight: fontWeight))
            .hypenModifier(badgeModifier)
        )
    }
}

enum BadgeDefaults {
    static let backgroundColor = Color(red: 224 / 255, green: 224 / 255, blue: 224 / 255)
    static let foregroundColor = Color(red: 51 / 255, green: 51 / 255, blue: 51 / 255)
    static let cornerRadius: CGFloat = 4
    static let horizontalPadding: CGFloat = 8
    static let verticalPadding: CGFloat = 4
    static let fontSize: CGFloat = 12
    static let fontWeight: Font.Weight = .semibold
}

struct BadgeModifierResolution {
    let modifier: HypenModifier
    let defaultedBackground: Bool
    let defaultedForeground: Bool
    let defaultedCornerRadius: Bool
    let defaultedPadding: Bool
}

/// Resolves component defaults without turning zero-valued custom applicators
/// back into defaults. Padding is one shorthand contract: declaring any edge
/// replaces the implicit 4x8 padding rather than stacking with it. A fully
/// fixed badge owns its 2D box and therefore receives no implicit padding.
func resolveBadgeModifier(_ source: HypenModifier) -> BadgeModifierResolution {
    var result = source

    let defaultedBackground = result.backgroundColor == nil
        && result.backgroundGradient == nil
        && result.cssBackground == nil
    if defaultedBackground {
        result.backgroundColor = BadgeDefaults.backgroundColor
    }

    let defaultedForeground = result.foregroundColor == nil
    if defaultedForeground {
        result.foregroundColor = BadgeDefaults.foregroundColor
    }

    let hasExplicitCornerRadius = result.explicitlySetProperties.contains("cornerRadius")
    let defaultedCornerRadius = !hasExplicitCornerRadius
    if defaultedCornerRadius {
        result.cornerRadius = BadgeDefaults.cornerRadius
    }

    let paddingProperties: Set<String> = [
        "paddingTop", "paddingBottom", "paddingLeading", "paddingTrailing"
    ]
    let hasExplicitPadding = !result.explicitlySetProperties.isDisjoint(with: paddingProperties)
    let hasFixedBox = result.width != nil && result.height != nil
    let defaultedPadding = !hasExplicitPadding && !hasFixedBox
    if defaultedPadding {
        result.setPadding(
            horizontal: BadgeDefaults.horizontalPadding,
            vertical: BadgeDefaults.verticalPadding
        )
    }

    return BadgeModifierResolution(
        modifier: result,
        defaultedBackground: defaultedBackground,
        defaultedForeground: defaultedForeground,
        defaultedCornerRadius: defaultedCornerRadius,
        defaultedPadding: defaultedPadding
    )
}

// MARK: - Avatar Component

public struct AvatarComponent: ComponentHandler {
    public let typeName = "avatar"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let src = context.element.getStringProp("src.0")
            ?? context.element.getStringProp("src")

        let initials = context.element.getStringProp("initials.0")
            ?? context.element.getStringProp("initials")

        let name = context.element.getStringProp("name.0")
            ?? context.element.getStringProp("name")

        // Default size 40 to match Web (Android uses 48)
        let size = context.element.getCGFloatProp("size.0") ?? modifier.width ?? 40
        let componentBackgroundColor = ColorParser.parse(context.element.props["backgroundColor.0"])
        let avatarModifier = avatarDecorationModifier(
            modifier,
            size: size,
            componentBackgroundColor: componentBackgroundColor
        )

        return AnyView(
            ZStack {
                if let src = src {
                    if src.hasPrefix("http://") || src.hasPrefix("https://") {
                        AsyncImage(url: URL(string: src)) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                            default:
                                initialsView(initials: initials, name: name, size: size)
                            }
                        }
                    } else {
                        Image(src)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    }
                } else {
                    initialsView(initials: initials, name: name, size: size)
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            .hypenModifier(avatarModifier)
        )
    }

    @ViewBuilder
    private func initialsView(initials: String?, name: String?, size: CGFloat) -> some View {
        let displayInitials = initials ?? generateInitials(from: name)
        Text(displayInitials)
            .font(.system(size: size * 0.4))
            .fontWeight(.medium)
            .foregroundColor(.primary)
    }

    private func generateInitials(from name: String?) -> String {
        guard let name = name else { return "?" }
        let components = name.split(separator: " ")
        if components.count >= 2 {
            return String(components[0].prefix(1)) + String(components[1].prefix(1))
        } else if let first = components.first {
            return String(first.prefix(2))
        }
        return "?"
    }
}

/// An Avatar owns its square content frame and circular image clip. Applying the
/// original modifier directly would install width/height and padding a second
/// time, changing the component's measured size. Strip only those layout fields
/// and send the remaining decoration through the shared background/border paint
/// path used by every other component.
func avatarDecorationModifier(
    _ source: HypenModifier,
    size: CGFloat,
    componentBackgroundColor: Color? = nil
) -> HypenModifier {
    var result = source

    result.width = nil
    result.height = nil
    result.minWidth = nil
    result.maxWidth = nil
    result.minHeight = nil
    result.maxHeight = nil
    result.fillMaxWidth = false
    result.fillMaxHeight = false
    result.fillMaxWidthFraction = 1
    result.fillMaxHeightFraction = 1
    result.aspectRatio = nil

    result.paddingTop = 0
    result.paddingBottom = 0
    result.paddingLeading = 0
    result.paddingTrailing = 0

    result.alignment = nil
    result.weight = nil
    result.flexGrow = nil
    result.flexShrink = nil

    if result.backgroundColor == nil && result.backgroundGradient == nil && result.cssBackground == nil {
        result.backgroundColor = componentBackgroundColor ?? Color.gray.opacity(0.3)
    }

    // Avatar images remain circular even without an explicit corner-radius.
    // Give their background and border the same default geometry. An explicit
    // zero is still honored for callers that intentionally request a square
    // decoration around the circular image.
    if result.cornerRadius == 0 && !result.explicitlySetProperties.contains("cornerRadius") {
        result.cornerRadius = size / 2
    }

    return result
}

/// Testable geometry/paint contract for Avatar decoration. Borders are overlays,
/// so they never participate in the Avatar's declared square measurement.
struct AvatarRenderRecipe: Equatable {
    let contentSize: CGFloat
    let imageClipRadius: CGFloat
    let decorationCornerRadius: CGFloat
    let borderWidth: CGFloat
    let borderPaint: BorderRenderingStyle?

    var paintsCircularSeparator: Bool {
        borderPaint != nil
            && borderWidth > 0
            && decorationCornerRadius >= contentSize / 2
    }
}

func avatarRenderRecipe(modifier: HypenModifier, size: CGFloat) -> AvatarRenderRecipe {
    let paint: BorderRenderingStyle?
    if modifier.borderWidth > 0,
       modifier.borderColor != nil,
       canonicalBorderStyle(modifier.borderStyle) != "none" {
        paint = borderRenderingStyle(modifier.borderStyle, width: modifier.borderWidth)
    } else {
        paint = nil
    }

    return AvatarRenderRecipe(
        contentSize: size,
        imageClipRadius: size / 2,
        decorationCornerRadius: modifier.cornerRadius,
        borderWidth: modifier.borderWidth,
        borderPaint: paint
    )
}
