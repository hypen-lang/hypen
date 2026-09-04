import SwiftUI

// MARK: - Text Component

public struct TextComponent: ComponentHandler {
    public let typeName = "text"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Get text content from various sources
        var text = context.element.textContent
            ?? context.element.getStringProp("text")
            ?? context.element.getStringProp("0")
            ?? ""

        // Apply text transform
        if let transform = modifier.textTransform {
            switch transform {
            case .uppercase:
                text = text.uppercased()
            case .lowercase:
                text = text.lowercased()
            case .capitalize:
                text = text.capitalized
            }
        }

        // Build text view with styling
        var textView = Text(text)

        // Font with family, size, and weight. A completely unstyled Text must
        // keep the inherited SwiftUI font so component containers such as a
        // raw Badge can supply their typography contract. With no ancestor
        // font this is still SwiftUI's 17pt body default.
        let explicitFontSize = modifier.fontSize ?? context.element.getCGFloatProp("fontSize.0")
        let explicitWeight = modifier.fontWeight ?? parseFontWeight(context.element.getStringProp("fontWeight.0"))
        let fontFamily = modifier.fontFamily ?? context.element.getStringProp("fontFamily.0")

        if let family = fontFamily {
            let fontSize = explicitFontSize ?? 17
            let weight = explicitWeight ?? .regular
            // Use GoogleFontsLoader for custom fonts
            let font = GoogleFontsLoader.shared.font(name: family, size: fontSize, weight: weight)
            textView = textView.font(font)
        } else if explicitFontSize != nil || explicitWeight != nil {
            let fontSize = explicitFontSize ?? 17
            let weight = explicitWeight ?? .regular
            // Use system font
            textView = textView.font(.system(size: fontSize, weight: weight))
        }

        // Decorations
        if modifier.strikethrough || context.element.getBoolProp("strikethrough.0") == true {
            textView = textView.strikethrough()
        }
        if modifier.underline || context.element.getBoolProp("underline.0") == true {
            textView = textView.underline()
        }

        // Kerning
        if let kerning = modifier.kerning ?? context.element.getCGFloatProp("letterSpacing.0") {
            textView = textView.kerning(kerning)
        }

        // Max lines - check modifier first, then element props
        let maxLines = modifier.maxLines ?? context.element.getIntProp("maxLines.0")

        // Text alignment
        let alignment = modifier.textAlignment ?? parseTextAlignment(context.element.getStringProp("textAlign.0"))

        // Truncation mode based on textOverflow
        let truncationMode: Text.TruncationMode = {
            switch modifier.textOverflow {
            case .ellipsis: return .tail
            case .clip, .visible: return .tail  // SwiftUI clips by default with lineLimit
            }
        }()

        // Text should wrap within its container without expanding horizontally
        // Use fixedSize to allow vertical expansion (wrapping) without horizontal expansion
        // Match Android: automatically fill width when textAlign is center or trailing
        // so the alignment has visible effect
        let shouldFillWidth = modifier.fillMaxWidth || (alignment != .leading)

        return AnyView(
            Group {
                if shouldFillWidth {
                    // Fill width for centering/trailing alignment to work
                    textView
                        .frame(maxWidth: .infinity, alignment: alignmentToFrameAlignment(alignment))
                        .lineLimit(maxLines)
                        .truncationMode(truncationMode)
                        .multilineTextAlignment(alignment)
                        .lineSpacing(modifier.effectiveLineSpacing)
                } else {
                    // Default: wrap text without expanding parent
                    textView
                        .fixedSize(horizontal: false, vertical: true)
                        .lineLimit(maxLines)
                        .truncationMode(truncationMode)
                        .multilineTextAlignment(alignment)
                        .lineSpacing(modifier.effectiveLineSpacing)
                }
            }
            .hypenModifier(modifier)
        )
    }

    private func alignmentToFrameAlignment(_ textAlignment: TextAlignment) -> Alignment {
        switch textAlignment {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func parseFontWeight(_ value: String?) -> Font.Weight? {
        switch value?.lowercased() {
        case "thin", "100": return .thin
        case "ultralight", "extralight", "200": return .ultraLight
        case "light", "300": return .light
        case "regular", "normal", "400": return .regular
        case "medium", "500": return .medium
        case "semibold", "600": return .semibold
        case "bold", "700": return .bold
        case "heavy", "extrabold", "800": return .heavy
        case "black", "900": return .black
        default: return nil
        }
    }

    private func parseTextAlignment(_ value: String?) -> TextAlignment {
        switch value?.lowercased() {
        case "left", "start": return .leading
        case "right", "end": return .trailing
        case "center": return .center
        default: return .leading
        }
    }
}

// MARK: - Heading Component

public struct HeadingComponent: ComponentHandler {
    public let typeName = "heading"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Support level from: named arg "level", positional arg "1", or applicator "level.0"
        let level = context.element.getIntProp("level")
            ?? context.element.getIntProp("1")
            ?? context.element.getIntProp("level.0")
            ?? 1
        let font: Font

        switch level {
        case 1: font = .largeTitle
        case 2: font = .title
        case 3: font = .title2
        case 4: font = .title3
        case 5: font = .headline
        default: font = .subheadline
        }

        // Check if we have direct text content or should render children
        let text = context.element.textContent
            ?? context.element.getStringProp("text")
            ?? context.element.getStringProp("text.0")
            ?? context.element.getStringProp("0")

        let hasChildren = !context.renderer.getChildren(of: context.element.id).isEmpty

        if let text = text, !text.isEmpty {
            // Render text content directly
            return AnyView(
                Text(text)
                    .font(font)
                    .fontWeight(.bold)
                    .hypenModifier(modifier)
            )
        } else if hasChildren {
            // Render children with font environment applied
            return AnyView(
                VStack(alignment: .leading, spacing: 0) {
                    children()
                }
                .font(font.bold())
                .hypenModifier(modifier)
            )
        } else {
            // Empty heading
            return AnyView(
                Text("")
                    .font(font)
                    .fontWeight(.bold)
                    .hypenModifier(modifier)
            )
        }
    }
}

// MARK: - Paragraph Component

public struct ParagraphComponent: ComponentHandler {
    public let typeName = "paragraph"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Check if we have direct text content or should render children
        let text = context.element.textContent
            ?? context.element.getStringProp("text")
            ?? context.element.getStringProp("text.0")
            ?? context.element.getStringProp("0")

        let hasChildren = !context.renderer.getChildren(of: context.element.id).isEmpty

        if let text = text, !text.isEmpty {
            // Render text content directly
            return AnyView(
                Text(text)
                    .font(.body)
                    .lineSpacing(modifier.lineHeight != nil ? modifier.effectiveLineSpacing : 4)
                    .hypenModifier(modifier)
            )
        } else if hasChildren {
            // Render children with paragraph styling
            return AnyView(
                VStack(alignment: .leading, spacing: 0) {
                    children()
                }
                .font(.body)
                .lineSpacing(modifier.lineHeight != nil ? modifier.effectiveLineSpacing : 4)
                .hypenModifier(modifier)
            )
        } else {
            // Empty paragraph
            return AnyView(
                Text("")
                    .font(.body)
                    .hypenModifier(modifier)
            )
        }
    }
}

// MARK: - Image Component

public struct ImageComponent: ComponentHandler {
    public let typeName = "image"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let src = context.element.getStringProp("src.0")
            ?? context.element.getStringProp("src")
            ?? context.element.getStringProp("0")

        let alt = context.element.getStringProp("alt.0")
            ?? context.element.getStringProp("alt")
            ?? "Image"

        // Support both objectFit (Android/Web) and contentMode (iOS legacy)
        let contentModeStr = context.element.getStringProp("objectFit.0")
            ?? context.element.getStringProp("contentMode.0")
        let contentMode = parseContentMode(contentModeStr)

        // Only make image resizable if explicit size constraints are provided
        // Without constraints, use intrinsic size to match web/Android behavior
        let hasExplicitSize = modifier.width != nil
            || modifier.height != nil
            || modifier.fillMaxWidth
            || modifier.fillMaxHeight
            || modifier.minWidth != nil
            || modifier.maxWidth != nil
            || modifier.minHeight != nil
            || modifier.maxHeight != nil
            || modifier.aspectRatio != nil

        return AnyView(
            GridAwareImageContent(
                src: src,
                alt: alt,
                contentMode: contentMode,
                hasExplicitSize: hasExplicitSize,
                modifier: modifier
            )
        )
    }

    private func parseContentMode(_ value: String?) -> ContentMode {
        switch value?.lowercased() {
        // Support both web/android naming (cover/contain) and iOS naming (fill/fit)
        case "fill", "cover", "crop": return .fill
        case "fit", "contain": return .fit
        default: return .fit
        }
    }
}

private struct GridAwareImageContent: View {
    @Environment(\.parentStretchesBareGridImage) private var parentStretchesBareGridImage

    let src: String?
    let alt: String
    let contentMode: ContentMode
    let hasExplicitSize: Bool
    let modifier: HypenModifier

    private var shouldResize: Bool {
        hasExplicitSize || parentStretchesBareGridImage
    }

    var body: some View {
        Group {
                if let src = src {
                    if src.hasPrefix("http://") || src.hasPrefix("https://") {
                        // Route HTTP(S) images through HypenImageCache —
                        // it survives across `treeVersion` bumps, so an
                        // image that's been loaded once never re-fetches
                        // and never re-decodes on subsequent re-renders.
                        // `AsyncImage` re-entered `.empty` on every patch
                        // batch, producing the constant-reload symptom.
                        HypenCachedImage(
                            url: URL(string: src),
                            placeholder: { AnyView(ProgressView()) },
                            failure: {
                                AnyView(
                                    Image(systemName: "photo")
                                        .foregroundColor(.gray)
                                )
                            },
                            transform: { image in
                                if shouldResize {
                                    return AnyView(
                                        image
                                            .resizable()
                                            .aspectRatio(contentMode: contentMode)
                                    )
                                } else {
                                    return AnyView(image)
                                }
                            }
                        )
                    } else if let systemName = src.hasPrefix("system:") ? String(src.dropFirst(7)) : nil {
                        if shouldResize {
                            Image(systemName: systemName)
                                .resizable()
                                .aspectRatio(contentMode: contentMode)
                        } else {
                            Image(systemName: systemName)
                        }
                    } else {
                        if shouldResize {
                            Image(src)
                                .resizable()
                                .aspectRatio(contentMode: contentMode)
                        } else {
                            Image(src)
                        }
                    }
                } else {
                    Image(systemName: "photo")
                        .foregroundColor(.gray)
                }
        }
        .accessibilityLabel(alt)
        .hypenModifier(modifier)
    }
}

// MARK: - Divider Component

public struct DividerComponent: ComponentHandler {
    public let typeName = "divider"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let style = resolveDividerStyle(element: context.element, modifier: modifier)

        return AnyView(
            Rectangle()
                .fill(style.color)
                .frame(height: style.thickness)
                .hypenModifier(modifier)
        )
    }
}

enum DividerColorSource: Equatable {
    case foreground
    case background
    case prop
    case canonicalDefault
}

struct DividerStyleResolution {
    let color: Color
    let thickness: CGFloat
    let colorSource: DividerColorSource
}

func resolveDividerStyle(element: HypenElement, modifier: HypenModifier) -> DividerStyleResolution {
    let propColor = ColorParser.parse(element.props["color.0"])
        ?? ColorParser.parse(element.props["color"])
        ?? ColorParser.parse(element.props["backgroundColor.0"])
        ?? ColorParser.parse(element.props["backgroundColor"])

    let color: Color
    let colorSource: DividerColorSource
    if let foreground = modifier.foregroundColor {
        color = foreground
        colorSource = .foreground
    } else if let background = modifier.backgroundColor {
        color = background
        colorSource = .background
    } else if let propColor {
        color = propColor
        colorSource = .prop
    } else {
        color = Color(red: 224 / 255, green: 224 / 255, blue: 224 / 255)
        colorSource = .canonicalDefault
    }

    let thickness = modifier.height
        ?? element.getCGFloatProp("height.0")
        ?? element.getCGFloatProp("height")
        ?? element.getCGFloatProp("thickness.0")
        ?? element.getCGFloatProp("thickness")
        ?? 1

    return DividerStyleResolution(
        color: color,
        thickness: max(0, thickness),
        colorSource: colorSource
    )
}
