import SwiftUI
import Combine

private let log = HypenLoggers.view

/// Configuration for back-navigation integration with a remote Hypen server.
///
/// When enabled, the client watches for changes in a server state key (e.g. "currentView")
/// and pushes entries onto a SwiftUI `NavigationPath`. When the user swipes back or
/// taps the back button, a configurable action is dispatched to the server so it can
/// pop its own view stack and send new patches.
public struct BackNavigationOptions: Sendable {
    /// Action name dispatched to the server on back navigation.
    public let backAction: String

    /// State key whose changes drive the navigation stack.
    /// Each time this key's value changes in a `stateUpdate`, a new entry
    /// is pushed onto the navigation path.
    public let viewStateKey: String

    public init(
        backAction: String = "navigateBack",
        viewStateKey: String = "currentView"
    ) {
        self.backAction = backAction
        self.viewStateKey = viewStateKey
    }

    /// Default options: action = "navigateBack", key = "currentView".
    public static let `default` = BackNavigationOptions()
}

/// Observable object that bridges server-side view state to a SwiftUI `NavigationPath`.
///
/// - Monitors `HypenRenderer.serverState` for changes to the configured state key.
/// - Pushes path entries when the server view changes.
/// - Dispatches the back action when the navigation path shrinks (user went back).
@available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *)
@MainActor
final class BackNavigationHandler: ObservableObject {
    @Published var path = NavigationPath()

    private let options: BackNavigationOptions
    private let actionDispatcher: ActionDispatcher
    private var cancellables = Set<AnyCancellable>()

    /// The last observed value of the view-state key, used to detect changes.
    private var lastViewValue: String?
    /// Tracks the previous path count to detect back navigation.
    private var previousPathCount: Int = 0
    /// When true, the next path change is caused by our own programmatic update
    /// (responding to a server state change) and should not dispatch back.
    private var suppressBackDispatch = false

    init(
        options: BackNavigationOptions,
        renderer: HypenRenderer,
        actionDispatcher: ActionDispatcher
    ) {
        self.options = options
        self.actionDispatcher = actionDispatcher

        // Observe server state for view-key changes.
        renderer.$serverState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                self?.handleStateUpdate(state)
            }
            .store(in: &cancellables)

        // Observe our own path changes to detect back navigation.
        $path
            .receive(on: DispatchQueue.main)
            .sink { [weak self] newPath in
                self?.handlePathCountChange(newPath.count)
            }
            .store(in: &cancellables)
    }

    // MARK: - State Tracking

    private func handleStateUpdate(_ state: [String: Any]) {
        let viewValue = resolveStateKey(state, options.viewStateKey)
        guard let viewValue = viewValue, viewValue != lastViewValue else { return }

        let isInitial = lastViewValue == nil
        lastViewValue = viewValue

        // Don't push on the very first state update (initial load).
        guard !isInitial else { return }

        log.debug("View state changed to '%@', pushing navigation entry", viewValue)
        suppressBackDispatch = true
        path.append(viewValue)
        // Reset after the current run-loop tick so SwiftUI has processed the change.
        DispatchQueue.main.async { [weak self] in
            self?.suppressBackDispatch = false
        }
    }

    private func handlePathCountChange(_ newCount: Int) {
        let oldCount = previousPathCount
        previousPathCount = newCount

        guard newCount < oldCount, !suppressBackDispatch else { return }

        log.debug("Back navigation detected (path %d -> %d), dispatching '%@'",
                  oldCount, newCount, options.backAction)
        actionDispatcher.dispatch(action: options.backAction, payload: nil)
    }

    // MARK: - Helpers

    /// Resolve a dot-separated key path from a dictionary (e.g. "ui.currentView").
    private func resolveStateKey(_ state: [String: Any], _ key: String) -> String? {
        let parts = key.split(separator: ".")
        var current: Any = state

        for part in parts {
            guard let dict = current as? [String: Any],
                  let next = dict[String(part)] else {
                return nil
            }
            current = next
        }

        if let str = current as? String {
            return str
        }
        // Coerce numbers/bools to a string so view changes are always trackable.
        if let num = current as? NSNumber {
            return num.stringValue
        }
        return nil
    }
}
