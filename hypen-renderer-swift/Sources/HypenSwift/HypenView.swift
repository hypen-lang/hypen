import SwiftUI
import Combine

private let log = HypenLoggers.view

/// The main entry point for rendering Hypen UI from a remote server
public struct HypenView: View {
    private let url: String
    private let config: RemoteEngineConfig
    private let loadingContent: AnyView
    private let errorContent: (String) -> AnyView
    private let componentRegistry: ComponentRegistry
    private let applicatorRegistry: ApplicatorRegistry

    @StateObject private var viewModel: HypenViewModel

    /// Create a new HypenView connected to a remote server
    /// - Parameters:
    ///   - url: WebSocket URL of the Hypen server
    ///   - config: Configuration for the remote connection
    ///   - componentRegistry: Custom component registry (defaults to standard components)
    ///   - applicatorRegistry: Custom applicator registry (defaults to standard applicators)
    ///   - loadingContent: View to show while connecting
    ///   - errorContent: View to show on error
    public init(
        url: String,
        config: RemoteEngineConfig = .default,
        componentRegistry: ComponentRegistry = .withDefaults(),
        applicatorRegistry: ApplicatorRegistry = .withDefaults(),
        @ViewBuilder loadingContent: () -> some View = { DefaultLoadingView() },
        errorContent: @escaping (String) -> some View = { DefaultErrorView(message: $0) }
    ) {
        self.url = url
        self.config = config
        self.componentRegistry = componentRegistry
        self.applicatorRegistry = applicatorRegistry
        self.loadingContent = AnyView(loadingContent())
        self.errorContent = { AnyView(errorContent($0)) }
        self._viewModel = StateObject(wrappedValue: HypenViewModel(url: url, config: config))
    }

    @Environment(\.backNavigationOptions) private var backNavigationOptions

    public var body: some View {
        GeometryReader { geometry in
            content
                .environment(\.componentRegistry, componentRegistry)
                .environment(\.applicatorRegistry, applicatorRegistry)
                .environment(\.screenWidth, geometry.size.width)
                // `vw`/`vh` resolve against the space the Hypen root was
                // actually given, NOT `UIScreen.main.bounds`. A host that
                // insets us (the Gallery's URL chrome takes 112pt) would
                // otherwise make `min-h-screen` taller than the area it can
                // occupy, pushing bottom-anchored content off the screen —
                // which is exactly what hid the home-screen launcher's dock.
                // Matches the web, where 100vh is the viewport hosting the
                // app, not the display.
                .environment(\.viewportHeight, geometry.size.height)
                // Real safe area of the space the Hypen root was given, read
                // from the same GeometryReader as `vw`/`vh` and consumed by
                // `SafeArea` elements. When the host already respects the
                // safe area (the default), SwiftUI has consumed it before we
                // are measured and reports zero here — which is the right
                // answer: there is nothing left for `SafeArea` to inset. A
                // host that opts into the full screen with `.ignoresSafeArea()`
                // gets the real values. The root itself deliberately does NOT
                // ignore the safe area; that stays the embedder's choice.
                .environment(\.hypenPlatformSafeAreaInsets, HypenSafeArea.PlatformInsets(geometry.safeAreaInsets))
                .onAppear {
                    viewModel.connect()
                }
                .onDisappear {
                    viewModel.disconnect()
                }
                .id(url)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.connectionState {
        case .connected:
            if let rootId = viewModel.renderer.rootId {
                if let navOptions = backNavigationOptions {
                    if #available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *) {
                        BackNavigationContainer(
                            options: navOptions,
                            renderer: viewModel.renderer,
                            actionDispatcher: viewModel.actionDispatcher
                        ) {
                            connectedContent(rootId: rootId)
                        }
                    } else {
                        // Fallback for older OS: render without NavigationStack integration
                        connectedContent(rootId: rootId)
                    }
                } else {
                    connectedContent(rootId: rootId)
                }
            } else {
                loadingContent
            }

        case .connecting, .reconnecting:
            loadingContent

        case .error(let message):
            errorContent(message)

        case .disconnected:
            loadingContent
        }
    }

    @ViewBuilder
    private func connectedContent(rootId: String) -> some View {
        // Use ZStack with explicit alignment to ensure content starts at top-left
        // This is more reliable than frame alignment in NavigationStack contexts
        ZStack(alignment: .topLeading) {
            HypenElementView(
                elementId: rootId,
                renderer: viewModel.renderer,
                actionDispatcher: viewModel.actionDispatcher
            )
            // Root element has no parent restricting it, so allow expansion
            .environment(\.parentAllowsHorizontalExpansion, true)
            .environment(\.parentAllowsVerticalExpansion, true)
            // Rebuild the whole element view tree when the renderer is
            // reset (initialTree replay on reconnect): element views
            // observe individual HypenElement instances and the equatable
            // HypenElementView wrapper skips body re-evaluation for
            // unchanged ids, so without an identity change they would keep
            // observing orphaned pre-reset instances.
            .id(viewModel.renderer.resetEpoch)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - View Model

@MainActor
final class HypenViewModel: ObservableObject {
    @Published var connectionState: ConnectionState = .disconnected

    let renderer = HypenRenderer()
    private var engine: RemoteEngine?
    private var cancellables = Set<AnyCancellable>()

    private(set) var actionDispatcher: ActionDispatcher = MockActionDispatcher()

    init(url: String, config: RemoteEngineConfig) {
        log.debug("Creating HypenViewModel for URL: %@", url)
        do {
            engine = try RemoteEngine(urlString: url, config: config)
            log.debug("RemoteEngine created successfully")
            setupBindings()
        } catch {
            log.error("Failed to create RemoteEngine: %@", error.localizedDescription)
            connectionState = .error(message: error.localizedDescription)
        }
    }

    private func setupBindings() {
        guard let engine = engine else { return }
        self.actionDispatcher = RemoteActionDispatcher(engine: engine)
        // `.onAnimationComplete` dispatches ride the same channel as every
        // other event applicator.
        renderer.animator.actionDispatcher = self.actionDispatcher

        // Element views observe their own HypenElement, so per-patch
        // invalidation never goes through this view model. The HypenView
        // root only needs to re-render when the root element changes
        // (first mount, route swap at the root, clear).
        renderer.$rootId
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                log.debug("Root element changed, triggering view update")
                self?.objectWillChange.send()
            }
            .store(in: &cancellables)

        // A renderer reset (initialTree replay) must also re-render the
        // root even if the root id ends up unchanged: the element view
        // tree is keyed by resetEpoch so it rebuilds against the fresh
        // HypenElement instances.
        renderer.$resetEpoch
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
            .store(in: &cancellables)

        // Tree resets: the server re-sends the full tree (initialTree)
        // on reconnect/session-restore under the SAME element ids. Drop
        // the stale tree first so the subsequent patch batch rebuilds
        // from scratch instead of orphaning observed elements.
        engine.treeResets
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                log.debug("Initial tree (re)received, clearing renderer")
                self?.renderer.clear()
            }
            .store(in: &cancellables)

        // Connection state
        engine.connectionState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                log.debug("Connection state changed: %@", String(describing: state))
                self?.connectionState = state
            }
            .store(in: &cancellables)

        // Patches
        engine.patches
            .receive(on: DispatchQueue.main)
            .sink { [weak self] patches in
                log.debug("Received \(patches.count) patches from engine")
                self?.renderer.applyPatches(patches)
                log.debug("After applying patches, rootId: \(self?.renderer.rootId ?? "nil")")
            }
            .store(in: &cancellables)

        // State updates
        engine.state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                log.debug("State update received with \(state.count) keys")
                self?.renderer.updateState(state)
            }
            .store(in: &cancellables)

        // Errors
        engine.errors
            .receive(on: DispatchQueue.main)
            .sink { error in
                log.error("Error: %@", error.localizedDescription)
            }
            .store(in: &cancellables)
    }

    func connect() {
        log.debug("HypenViewModel.connect() called")
        engine?.connect()
    }

    func disconnect() {
        log.debug("HypenViewModel.disconnect() called")
        engine?.disconnect()
    }
}

// MARK: - Default Views

public struct DefaultLoadingView: View {
    public init() {}

    public var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .progressViewStyle(.circular)
            Text("Connecting...")
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

public struct DefaultErrorView: View {
    let message: String

    public init(message: String) {
        self.message = message
    }

    public var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.largeTitle)
                .foregroundColor(.red)
            Text("Connection Error")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
