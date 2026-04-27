import SwiftUI

/// A container view that wraps content in a `NavigationStack` and dispatches
/// a back action to the server when the user navigates back.
///
/// This is an internal implementation detail used by `HypenView` when the
/// `.hypenBackNavigation()` modifier is applied.
@available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *)
@MainActor
struct BackNavigationContainer<Content: View>: View {
    @StateObject private var handler: BackNavigationHandler
    private let content: () -> Content

    init(
        options: BackNavigationOptions,
        renderer: HypenRenderer,
        actionDispatcher: ActionDispatcher,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self._handler = StateObject(wrappedValue: BackNavigationHandler(
            options: options,
            renderer: renderer,
            actionDispatcher: actionDispatcher
        ))
        self.content = content
    }

    var body: some View {
        NavigationStack(path: $handler.path) {
            content()
                .navigationDestination(for: String.self) { _ in
                    // Each pushed entry re-renders the same Hypen content.
                    // The server controls what is actually displayed via patches;
                    // we just need a destination so NavigationStack builds a
                    // back-navigable stack.
                    content()
                }
        }
        // Prevent nested HypenViews from adding another NavigationStack.
        .environment(\.backNavigationOptions, nil)
    }
}
