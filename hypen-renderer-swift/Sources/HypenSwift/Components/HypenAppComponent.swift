import SwiftUI
import Combine

private let log = HypenLoggers.view

/// Component handler for embedding a remote Hypen app within a Hypen component tree.
///
/// Usage in Hypen DSL:
/// ```hypen
/// HypenApp("ws://localhost:3000")
///
/// // Or with named prop:
/// HypenApp(url: "ws://localhost:3000")
/// ```
public struct HypenAppComponent: ComponentHandler {
    public let typeName = "hypenapp"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let url = context.element.getStringProp("0")
            ?? context.element.getStringProp("url.0")
            ?? context.element.getStringProp("url")

        guard let url = url else {
            return AnyView(
                Text("HypenApp: URL required")
                    .foregroundColor(.red)
                    .hypenModifier(modifier)
            )
        }

        return AnyView(
            EmbeddedHypenView(url: url)
                .hypenModifier(modifier)
        )
    }
}

// MARK: - Embedded HypenView

/// A lightweight SwiftUI view that manages a nested RemoteEngine + HypenRenderer
/// for rendering a remote Hypen app inline within the component tree.
private struct EmbeddedHypenView: View {
    let url: String

    @StateObject private var viewModel: EmbeddedHypenViewModel

    init(url: String) {
        self.url = url
        self._viewModel = StateObject(wrappedValue: EmbeddedHypenViewModel(url: url))
    }

    var body: some View {
        content
            .onAppear {
                viewModel.connect()
            }
            .onDisappear {
                viewModel.disconnect()
            }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.connectionState {
        case .connected:
            if let rootId = viewModel.renderer.rootId {
                HypenElementView(
                    elementId: rootId,
                    renderer: viewModel.renderer,
                    actionDispatcher: viewModel.actionDispatcher
                )
                // Rebuild the element view tree when the renderer is reset
                // (initialTree replay on reconnect) — see HypenView.
                .id(viewModel.renderer.resetEpoch)
            } else {
                ProgressView()
                    .progressViewStyle(.circular)
            }

        case .connecting, .reconnecting:
            ProgressView()
                .progressViewStyle(.circular)

        case .error(let message):
            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(.red)
                Text(message)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

        case .disconnected:
            ProgressView()
                .progressViewStyle(.circular)
        }
    }
}

// MARK: - View Model

@MainActor
private final class EmbeddedHypenViewModel: ObservableObject {
    @Published var connectionState: ConnectionState = .disconnected

    let renderer = HypenRenderer()
    private var engine: RemoteEngine?
    private var cancellables = Set<AnyCancellable>()

    private(set) lazy var actionDispatcher: ActionDispatcher = {
        guard let engine = engine else {
            return MockActionDispatcher()
        }
        return RemoteActionDispatcher(engine: engine)
    }()

    init(url: String) {
        log.debug("Creating EmbeddedHypenViewModel for URL: %@", url)
        do {
            engine = try RemoteEngine(urlString: url)
            setupBindings()
        } catch {
            log.error("Failed to create RemoteEngine: %@", error.localizedDescription)
            connectionState = .error(message: error.localizedDescription)
        }
    }

    private func setupBindings() {
        guard let engine = engine else { return }

        // Element views observe their own HypenElement; the embedded root
        // only needs to re-render when the root element changes.
        renderer.$rootId
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
            .store(in: &cancellables)

        // Re-render the embedded root on renderer resets so the element
        // view tree (keyed by resetEpoch) rebuilds against the fresh
        // HypenElement instances — see HypenViewModel.
        renderer.$resetEpoch
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
            .store(in: &cancellables)

        // Drop the stale tree before an initialTree replay's patches
        // rebuild it under the same ids (reconnect/session-restore).
        engine.treeResets
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.renderer.clear()
            }
            .store(in: &cancellables)

        engine.connectionState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                self?.connectionState = state
            }
            .store(in: &cancellables)

        engine.patches
            .receive(on: DispatchQueue.main)
            .sink { [weak self] patches in
                self?.renderer.applyPatches(patches)
            }
            .store(in: &cancellables)

        engine.state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                self?.renderer.updateState(state)
            }
            .store(in: &cancellables)

        engine.errors
            .receive(on: DispatchQueue.main)
            .sink { error in
                log.error("EmbeddedHypenApp error: %@", error.localizedDescription)
            }
            .store(in: &cancellables)
    }

    func connect() {
        engine?.connect()
    }

    func disconnect() {
        engine?.disconnect()
    }
}
