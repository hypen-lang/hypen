import SwiftUI

/// A view modifier that wraps Hypen content in a `NavigationStack` and
/// dispatches a configurable action to the server when the user navigates back
/// (swipe-back gesture, back button, etc.).
///
/// Usage:
/// ```swift
/// HypenView(url: "ws://localhost:3000")
///     .hypenBackNavigation()
///
/// // With custom options:
/// HypenView(url: "ws://localhost:3000")
///     .hypenBackNavigation(backAction: "goBack", viewStateKey: "screen")
/// ```
@available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *)
struct HypenBackNavigationModifier: ViewModifier {
    let options: BackNavigationOptions

    func body(content: Content) -> some View {
        content
            .environment(\.backNavigationOptions, options)
    }
}

// MARK: - Environment Key

private struct BackNavigationOptionsKey: EnvironmentKey {
    static let defaultValue: BackNavigationOptions? = nil
}

extension EnvironmentValues {
    var backNavigationOptions: BackNavigationOptions? {
        get { self[BackNavigationOptionsKey.self] }
        set { self[BackNavigationOptionsKey.self] = newValue }
    }
}

// MARK: - View Extension

@available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *)
extension View {
    /// Enable back-navigation integration for a remote Hypen server.
    ///
    /// When the server's view state changes (tracked via `viewStateKey`),
    /// a navigation entry is pushed. When the user navigates back (swipe,
    /// back button), the `backAction` is dispatched to the server.
    ///
    /// This modifier is opt-in; without it, `HypenView` behaves as before.
    ///
    /// - Parameters:
    ///   - backAction: Action name sent to the server (default: `"navigateBack"`).
    ///   - viewStateKey: Server state key that drives navigation (default: `"currentView"`).
    public func hypenBackNavigation(
        backAction: String = "navigateBack",
        viewStateKey: String = "currentView"
    ) -> some View {
        modifier(HypenBackNavigationModifier(
            options: BackNavigationOptions(
                backAction: backAction,
                viewStateKey: viewStateKey
            )
        ))
    }

    /// Enable back-navigation integration with explicit options.
    public func hypenBackNavigation(_ options: BackNavigationOptions) -> some View {
        modifier(HypenBackNavigationModifier(options: options))
    }
}
