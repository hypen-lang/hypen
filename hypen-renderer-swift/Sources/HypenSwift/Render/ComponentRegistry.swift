import SwiftUI

/// Context passed to component handlers during rendering
public struct ComponentContext: @unchecked Sendable {
    public let element: HypenElement
    public let renderer: HypenRenderer
    public let actionDispatcher: ActionDispatcher

    public init(element: HypenElement, renderer: HypenRenderer, actionDispatcher: ActionDispatcher) {
        self.element = element
        self.renderer = renderer
        self.actionDispatcher = actionDispatcher
    }
}

/// Protocol for component handlers that render Hypen elements to SwiftUI views
@MainActor
public protocol ComponentHandler: Sendable {
    /// The element type name this handler supports (e.g., "text", "column", "button")
    var typeName: String { get }

    /// Render the element to a SwiftUI view
    @ViewBuilder
    func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView
}

/// Registry for component handlers
@MainActor
public final class ComponentRegistry: @unchecked Sendable {
    private var handlers: [String: any ComponentHandler] = [:]

    public init() {}

    /// Register a component handler
    public func register(_ handler: any ComponentHandler) {
        handlers[handler.typeName.lowercased()] = handler
    }

    /// Register multiple handlers at once
    public func register(_ handlers: [any ComponentHandler]) {
        for handler in handlers {
            register(handler)
        }
    }

    /// Get a handler for a given element type
    public func getHandler(for typeName: String) -> (any ComponentHandler)? {
        // Keys are stored lowercased; try the name as-is first so
        // already-lowercase lookups skip the `lowercased()` allocation.
        handlers[typeName] ?? handlers[typeName.lowercased()]
    }

    /// Check if a handler exists for a given element type
    public func hasHandler(for typeName: String) -> Bool {
        getHandler(for: typeName) != nil
    }

    /// Get all registered type names
    public func getRegisteredTypes() -> Set<String> {
        Set(handlers.keys)
    }
}

// MARK: - Default Registry

extension ComponentRegistry {
    /// Create a registry with all default components registered
    public static func withDefaults() -> ComponentRegistry {
        let registry = ComponentRegistry()

        // Root component
        registry.register(AppComponent())

        // Layout components
        registry.register(ColumnComponent())
        registry.register(RowComponent())
        registry.register(BoxComponent())
        registry.register(ContainerComponent())
        registry.register(CenterComponent())
        registry.register(SpacerComponent())
        registry.register(StackComponent())
        registry.register(ListComponent())
        registry.register(GridComponent())
        registry.register(SafeAreaComponent())

        // Content components
        registry.register(TextComponent())
        registry.register(HeadingComponent())
        registry.register(ParagraphComponent())
        registry.register(ImageComponent())
        registry.register(DividerComponent())

        // Accessibility components
        // Without a handler this falls through to the container fallback in
        // HypenElementView, which renders screen-reader-only content visibly.
        registry.register(VisuallyHiddenComponent())

        // Interactive components
        registry.register(ButtonComponent())
        registry.register(LinkComponent())

        // Form components
        registry.register(InputComponent())
        registry.register(TextAreaComponent())
        registry.register(CheckboxComponent())
        registry.register(SwitchComponent())
        registry.register(SliderComponent())
        registry.register(SelectComponent())

        // UI components
        registry.register(CardComponent())
        registry.register(SpinnerComponent())
        registry.register(ProgressBarComponent())
        registry.register(BadgeComponent())
        registry.register(AvatarComponent())

        // Router components
        registry.register(RouterComponent())
        registry.register(RouteComponent())

        // Media components
        registry.register(AudioComponent())
        registry.register(VideoComponent())
        // Video v2 chrome: a timeline for the `controls` slot (inert
        // outside a Video).
        registry.register(ScrubberComponent())

        // Icon component (renders server-resolved SVG path data)
        registry.register(IconComponent())

        // Remote embedding
        registry.register(HypenAppComponent())

        return registry
    }
}
