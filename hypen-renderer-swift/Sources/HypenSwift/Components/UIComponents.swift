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

        return AnyView(
            ProgressView()
                .progressViewStyle(.circular)
                .scaleEffect(scaleForSize(size))
                .tint(color)
                .hypenModifier(modifier)
        )
    }

    private func scaleForSize(_ size: String) -> CGFloat {
        switch size.lowercased() {
        case "small": return 0.7
        case "large": return 1.5
        default: return 1.0
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
        let progress = context.element.getDoubleProp("progress.0")
            ?? context.element.getDoubleProp("value.0")
            ?? 0

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

        var badgeModifier = modifier
        if badgeModifier.backgroundColor == nil {
            badgeModifier.backgroundColor = .accentColor
        }
        if badgeModifier.cornerRadius == 0 {
            badgeModifier.cornerRadius = 10
        }
        if badgeModifier.paddingTop == 0 && badgeModifier.paddingLeading == 0 {
            badgeModifier.setPadding(horizontal: 8, vertical: 4)
        }
        if badgeModifier.foregroundColor == nil {
            badgeModifier.foregroundColor = .white
        }

        return AnyView(
            Group {
                if text.isEmpty {
                    children()
                } else {
                    Text(text)
                        .font(.caption)
                        .fontWeight(.medium)
                }
            }
            .hypenModifier(badgeModifier)
        )
    }
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
        let backgroundColor = ColorParser.parse(context.element.props["backgroundColor.0"]) ?? Color.gray.opacity(0.3)

        // Don't override modifier width/height - just use for the avatar frame
        // This avoids double-frame issues

        return AnyView(
            ZStack {
                Circle()
                    .fill(backgroundColor)

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
            // Apply modifier but exclude width/height/cornerRadius since we handle them
            .opacity(modifier.isVisible ? modifier.opacity : 0)
            .shadow(
                color: modifier.shadowColor ?? .clear,
                radius: modifier.shadowRadius,
                x: modifier.shadowX,
                y: modifier.shadowY
            )
            .padding(.top, modifier.marginTop)
            .padding(.bottom, modifier.marginBottom)
            .padding(.leading, modifier.marginLeading)
            .padding(.trailing, modifier.marginTrailing)
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
