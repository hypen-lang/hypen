import SwiftUI

// MARK: - Insets Model

/// One of the four edges a `SafeArea` element can inset.
///
/// Raw values match the strings the `edges` prop carries on every renderer
/// (`"top"`, `"right"`, `"bottom"`, `"left"`), so parsing is a raw-value lookup.
public enum HypenSafeAreaEdge: String, CaseIterable, Hashable, Sendable {
    case top
    case right
    case bottom
    case left
}

/// Embedder-supplied safe-area override, published through the
/// `\.hypenSafeAreaInsets` environment value.
///
/// Every field is optional and merges **per edge** over the platform's real
/// safe area: `HypenSafeAreaInsets(bottom: 0)` zeroes only the bottom inset
/// and leaves top/left/right at their measured values. `nil` (the default)
/// means "use the real safe area for every edge".
///
/// Values are in points, and `left`/`right` are *physical* edges — the
/// renderer maps them onto SwiftUI's leading/trailing according to the
/// layout direction.
public struct HypenSafeAreaInsets: Equatable, Sendable {
    public var top: CGFloat?
    public var right: CGFloat?
    public var bottom: CGFloat?
    public var left: CGFloat?

    public init(
        top: CGFloat? = nil,
        right: CGFloat? = nil,
        bottom: CGFloat? = nil,
        left: CGFloat? = nil
    ) {
        self.top = top
        self.right = right
        self.bottom = bottom
        self.left = left
    }
}

// MARK: - Safe-area Logic

/// Pure, view-independent safe-area logic: prop parsing, the per-edge merge of
/// an embedder override over the platform insets, and the final edge filter.
///
/// Kept free of SwiftUI state so it is directly unit-testable.
public enum HypenSafeArea {
    /// The hosting view's measured safe area, in SwiftUI's writing-direction
    /// terms (leading/trailing rather than left/right).
    ///
    /// A plain value type rather than `EdgeInsets` so it can be stored in an
    /// `EnvironmentKey` default without depending on SwiftUI's own `Sendable`
    /// conformances.
    public struct PlatformInsets: Equatable, Sendable {
        public var top: CGFloat
        public var leading: CGFloat
        public var bottom: CGFloat
        public var trailing: CGFloat

        public init(top: CGFloat = 0, leading: CGFloat = 0, bottom: CGFloat = 0, trailing: CGFloat = 0) {
            self.top = top
            self.leading = leading
            self.bottom = bottom
            self.trailing = trailing
        }

        public init(_ insets: EdgeInsets) {
            self.init(
                top: insets.top,
                leading: insets.leading,
                bottom: insets.bottom,
                trailing: insets.trailing
            )
        }

        public static let zero = PlatformInsets()
    }

    /// The effective inset for every physical edge, after the embedder
    /// override has been merged over the platform insets.
    public struct ResolvedInsets: Equatable, Sendable {
        public var top: CGFloat
        public var right: CGFloat
        public var bottom: CGFloat
        public var left: CGFloat

        public init(top: CGFloat = 0, right: CGFloat = 0, bottom: CGFloat = 0, left: CGFloat = 0) {
            self.top = top
            self.right = right
            self.bottom = bottom
            self.left = left
        }

        public static let zero = ResolvedInsets()
    }

    /// Every edge — the default when no `edges` prop is supplied.
    public static let allEdges: Set<HypenSafeAreaEdge> = Set(HypenSafeAreaEdge.allCases)

    /// Parse the `edges` prop into the set of edges to inset.
    ///
    /// An absent or empty prop selects all four edges. Entries are trimmed and
    /// matched case-insensitively; unrecognised entries are ignored, so an
    /// explicit list naming only unknown edges insets nothing (an explicit
    /// selection is never silently widened back to "all").
    public static func parseEdges(_ raw: [String]?) -> Set<HypenSafeAreaEdge> {
        guard let raw = raw, !raw.isEmpty else { return allEdges }
        return Set(raw.compactMap { entry in
            HypenSafeAreaEdge(rawValue: entry.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        })
    }

    /// Merge an embedder override over the platform insets, per edge.
    ///
    /// A `nil` field falls back to the measured platform inset for that edge;
    /// a provided field wins even when it is `0`.
    public static func resolveInsets(
        platform: PlatformInsets,
        override: HypenSafeAreaInsets?,
        layoutDirection: LayoutDirection = .leftToRight
    ) -> ResolvedInsets {
        let isRTL = layoutDirection == .rightToLeft
        let platformLeft = isRTL ? platform.trailing : platform.leading
        let platformRight = isRTL ? platform.leading : platform.trailing

        return ResolvedInsets(
            top: override?.top ?? platform.top,
            right: override?.right ?? platformRight,
            bottom: override?.bottom ?? platform.bottom,
            left: override?.left ?? platformLeft
        )
    }

    /// The padding a `SafeArea` element applies: the resolved inset on each
    /// selected edge, zero everywhere else, expressed in SwiftUI's
    /// leading/trailing terms.
    public static func padding(
        edges: Set<HypenSafeAreaEdge>,
        insets: ResolvedInsets,
        layoutDirection: LayoutDirection = .leftToRight
    ) -> EdgeInsets {
        let left = edges.contains(.left) ? insets.left : 0
        let right = edges.contains(.right) ? insets.right : 0
        let isRTL = layoutDirection == .rightToLeft

        return EdgeInsets(
            top: edges.contains(.top) ? insets.top : 0,
            leading: isRTL ? right : left,
            bottom: edges.contains(.bottom) ? insets.bottom : 0,
            trailing: isRTL ? left : right
        )
    }
}

// MARK: - Environment

private struct HypenSafeAreaInsetsKey: EnvironmentKey {
    static let defaultValue: HypenSafeAreaInsets? = nil
}

private struct HypenPlatformSafeAreaInsetsKey: EnvironmentKey {
    static let defaultValue: HypenSafeArea.PlatformInsets = .zero
}

extension EnvironmentValues {
    /// Embedder override for the safe-area insets `SafeArea` elements apply.
    ///
    /// `nil` (the default) uses the hosting view's real safe area. Set it on
    /// `HypenView` — or any ancestor — to override individual edges:
    ///
    /// ```swift
    /// HypenView(url: "ws://localhost:3000")
    ///     .environment(\.hypenSafeAreaInsets, HypenSafeAreaInsets(bottom: 0))
    /// ```
    public var hypenSafeAreaInsets: HypenSafeAreaInsets? {
        get { self[HypenSafeAreaInsetsKey.self] }
        set { self[HypenSafeAreaInsetsKey.self] = newValue }
    }

    /// The hosting view's measured safe area, published once at the Hypen root
    /// from `HypenView`'s `GeometryReader`. Defaults to zero, which is also the
    /// correct answer when the host already consumed the safe area itself.
    var hypenPlatformSafeAreaInsets: HypenSafeArea.PlatformInsets {
        get { self[HypenPlatformSafeAreaInsetsKey.self] }
        set { self[HypenPlatformSafeAreaInsetsKey.self] = newValue }
    }
}

extension View {
    /// Override the safe-area insets `SafeArea` elements apply, per edge.
    ///
    /// Omitted (or `nil`) edges keep the platform's real safe-area inset.
    ///
    /// ```swift
    /// HypenView(url: "ws://localhost:3000")
    ///     .hypenSafeAreaInsets(bottom: 0)
    /// ```
    public func hypenSafeAreaInsets(
        top: CGFloat? = nil,
        right: CGFloat? = nil,
        bottom: CGFloat? = nil,
        left: CGFloat? = nil
    ) -> some View {
        environment(
            \.hypenSafeAreaInsets,
            HypenSafeAreaInsets(top: top, right: right, bottom: bottom, left: left)
        )
    }

    /// Override the safe-area insets `SafeArea` elements apply.
    ///
    /// Pass `nil` to fall back to the platform's real safe area on every edge.
    public func hypenSafeAreaInsets(_ insets: HypenSafeAreaInsets?) -> some View {
        environment(\.hypenSafeAreaInsets, insets)
    }
}

// MARK: - SafeArea Component

/// Full-size vertical container that pads its content by the effective
/// safe-area inset on each selected edge.
///
/// ```hypen
/// SafeArea { Column { ... } }
/// SafeArea(edges: ["top", "bottom"]) { ... }
/// ```
///
/// Layout matches `App`: fills the available width and height unless the
/// element carries explicit dimensions, and stacks children vertically.
public struct SafeAreaComponent: ComponentHandler {
    public let typeName = "safearea"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        var mod = modifier
        if mod.width == nil { mod.fillMaxWidth = true }
        if mod.height == nil { mod.fillMaxHeight = true }

        let edges = HypenSafeArea.parseEdges(context.element.getStringListProp("edges"))

        // The insets live in the environment, which a ComponentHandler cannot
        // read directly — hand off to a View that can (same pattern as Stack).
        return AnyView(
            SafeAreaContentView(edges: edges, modifier: mod, children: children)
        )
    }
}

/// Helper view for SafeArea that reads the insets from the environment.
private struct SafeAreaContentView: View {
    let edges: Set<HypenSafeAreaEdge>
    let modifier: HypenModifier
    let children: () -> AnyView

    @Environment(\.hypenSafeAreaInsets) private var overrideInsets
    @Environment(\.hypenPlatformSafeAreaInsets) private var platformInsets
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        let resolved = HypenSafeArea.resolveInsets(
            platform: platformInsets,
            override: overrideInsets,
            layoutDirection: layoutDirection
        )
        let safeAreaPadding = HypenSafeArea.padding(
            edges: edges,
            insets: resolved,
            layoutDirection: layoutDirection
        )

        // Safe-area padding is applied to the content *before* `hypenModifier`,
        // so it sits inside the element's own background and border: the
        // background still bleeds under the insets while the content is pushed
        // clear of them. A user `.padding(...)` applicator is applied by
        // `hypenModifier` on top of this one, so the two combine additively.
        VStack(alignment: .leading, spacing: 0) {
            children()
                .environment(\.parentAllowsHorizontalExpansion, true)
                .environment(\.parentAllowsVerticalExpansion, true)
        }
        .padding(safeAreaPadding)
        .hypenModifier(modifier)
    }
}
