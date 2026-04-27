import SwiftUI

// MARK: - Router Environment Keys

private struct RouterControllerKey: EnvironmentKey {
    static let defaultValue: RouterController? = nil
}

private struct RouteMatchedKey: EnvironmentKey {
    static let defaultValue: Binding<Bool>? = nil
}

extension EnvironmentValues {
    var routerController: RouterController? {
        get { self[RouterControllerKey.self] }
        set { self[RouterControllerKey.self] = newValue }
    }

    var routeMatched: Binding<Bool>? {
        get { self[RouteMatchedKey.self] }
        set { self[RouteMatchedKey.self] = newValue }
    }
}

// MARK: - Router Component

/// Router container that controls which Route child is visible based on the current path.
public struct RouterComponent: ComponentHandler {
    public let typeName = "router"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let initialPath = context.element.getStringProp("currentPath.0")
            ?? context.element.getStringProp("currentPath")
            ?? context.element.getStringProp("path.0")
            ?? context.element.getStringProp("path")
            ?? "/"

        return AnyView(
            RouterViewWrapper(
                initialPath: initialPath,
                externalPath: context.element.getStringProp("currentPath.0") ?? context.element.getStringProp("currentPath"),
                modifier: modifier,
                children: children
            )
        )
    }
}

private struct RouterViewWrapper: View {
    let initialPath: String
    let externalPath: String?
    let modifier: HypenModifier
    let children: () -> AnyView

    @StateObject private var router: RouterController
    @State private var hasMatch: Bool = false

    init(
        initialPath: String,
        externalPath: String?,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) {
        self.initialPath = initialPath
        self.externalPath = externalPath
        self.modifier = modifier
        self.children = children
        self._router = StateObject(wrappedValue: RouterController(initialPath: initialPath))
    }

    var body: some View {
        // Router is a transparent container — the matched Route's content
        // is the real layout. We MUST pass the full available height down,
        // otherwise an inner Column with `flex-1`/weighted children
        // (e.g. `Column { Home().tw("flex-1"); BottomNav() }`) only sees the
        // content's ideal height, and `FlexColumnLayout` ends up giving the
        // weighted child the whole bounds — pushing the non-flex sibling
        // (BottomNav) past the bottom edge.
        VStack(spacing: 0) {
            children()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .environment(\.routerController, router)
        .environment(\.routeMatched, $hasMatch)
        .hypenModifier(modifier)
        .onChangeCompat(of: externalPath) { newPath in
            router.sync(newPath)
        }
        .onAppear {
            hasMatch = false
        }
    }
}

// MARK: - Route Component

/// Route container that renders its children only when the current path matches.
public struct RouteComponent: ComponentHandler {
    public let typeName = "route"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let path = context.element.getStringProp("path.0")
            ?? context.element.getStringProp("path")
            ?? context.element.getStringProp("0")
            ?? "/"

        return AnyView(
            RouteViewWrapper(
                path: path,
                modifier: modifier,
                children: children
            )
        )
    }
}

private struct RouteViewWrapper: View {
    let path: String
    let modifier: HypenModifier
    let children: () -> AnyView

    @Environment(\.routerController) private var router
    @Environment(\.routeMatched) private var matchedBinding

    var body: some View {
        if let router = router {
            let match = router.matchPath(pattern: path)
            if match != nil {
                VStack(spacing: 0) {
                    children()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .hypenModifier(modifier)
                .onAppear {
                    matchedBinding?.wrappedValue = true
                    if let match = match {
                        router.setMatch(match)
                    }
                }
            }
        } else {
            // No router context - render children as-is
            VStack {
                children()
            }
            .hypenModifier(modifier)
        }
    }
}

// MARK: - Link Component (Router-aware)

/// Simple Link component that navigates via the router when clicked.
public struct LinkComponent: ComponentHandler {
    public let typeName = "link"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let targetPath = context.element.getStringProp("to.0")
            ?? context.element.getStringProp("to")
            ?? context.element.getStringProp("href.0")
            ?? context.element.getStringProp("href")
            ?? context.element.getStringProp("0")
            ?? "/"

        let replace = context.element.getBoolProp("replace.0")
            ?? context.element.getBoolProp("replace")
            ?? false

        // Check if there's an explicit click handler
        let hasExplicitClick = context.element.props.keys.contains { key in
            key.hasPrefix("onClick") || key.hasPrefix("onPress") || key.hasPrefix("onLongClick")
        }

        // External URL check
        let isExternal = targetPath.hasPrefix("http://") || targetPath.hasPrefix("https://")

        return AnyView(
            LinkViewWrapper(
                targetPath: targetPath,
                replace: replace,
                hasExplicitClick: hasExplicitClick,
                isExternal: isExternal,
                modifier: modifier,
                children: children
            )
        )
    }
}

private struct LinkViewWrapper: View {
    let targetPath: String
    let replace: Bool
    let hasExplicitClick: Bool
    let isExternal: Bool
    let modifier: HypenModifier
    let children: () -> AnyView

    @Environment(\.routerController) private var router

    var body: some View {
        if isExternal {
            // External link - open in browser
            Link(destination: URL(string: targetPath) ?? URL(string: "about:blank")!) {
                children()
            }
            .hypenModifier(modifier)
        } else if let router = router, !hasExplicitClick {
            // Internal router navigation
            Button {
                if replace {
                    router.replace(targetPath)
                } else {
                    router.push(targetPath)
                }
            } label: {
                children()
            }
            .buttonStyle(.plain)
            .hypenModifier(modifier)
        } else {
            // No router or has explicit click handler
            children()
                .hypenModifier(modifier)
        }
    }
}

// MARK: - View Extension for Router Access

extension View {
    /// Provide a router controller to the view hierarchy
    public func routerController(_ controller: RouterController) -> some View {
        environment(\.routerController, controller)
    }
}
