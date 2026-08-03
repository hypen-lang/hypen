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
///
/// // With custom loading / error UI via slot children:
/// HypenApp("ws://localhost:3000") {
///     Column { Spinner() Text("Connecting...") }.slot("loading")
///     Column { Text("Couldn't reach the app") }.slot("error")
/// }
/// ```
///
/// Slot children are host-app subtrees (rendered by the *host* renderer,
/// with full access to host state and actions); the component shows the
/// `loading` slot while connecting and the `error` slot on connection
/// failure, falling back to the built-in spinner / error views when a
/// slot isn't provided.
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
                HypenAppSlotView(
                    slot: HypenAppSlots.error,
                    hostElementId: context.element.id,
                    renderer: context.renderer,
                    actionDispatcher: context.actionDispatcher
                ) {
                    Text("HypenApp: URL required")
                        .foregroundColor(.red)
                }
                .hypenModifier(modifier)
            )
        }

        return AnyView(
            EmbeddedHypenView(
                url: url,
                hostElementId: context.element.id,
                hostRenderer: context.renderer,
                hostActionDispatcher: context.actionDispatcher
            )
            .hypenModifier(modifier)
        )
    }
}

// MARK: - Slots

enum HypenAppSlots {
    static let loading = "loading"
    static let error = "error"
}

/// Renders the host-provided children tagged `.slot(name)`, or `fallback`
/// when the host didn't pass any. Looks the children up through the *host*
/// renderer at body time so slot subtrees that appear/disappear reactively
/// (e.g. under a `When`) are picked up.
private struct HypenAppSlotView<Fallback: View>: View {
    let slot: String
    let hostElementId: String
    let renderer: HypenRenderer
    let actionDispatcher: ActionDispatcher
    @ViewBuilder let fallback: () -> Fallback

    var body: some View {
        let slotIds = slotChildIds()
        if slotIds.isEmpty {
            fallback()
        } else {
            ForEach(slotIds, id: \.self) { id in
                HypenElementView(
                    elementId: id,
                    renderer: renderer,
                    actionDispatcher: actionDispatcher
                )
            }
        }
    }

    private func slotChildIds() -> [String] {
        guard let host = renderer.getElement(hostElementId) else { return [] }
        return host.children.filter { childId in
            renderer.getElement(childId)?.getStringProp("slot.0") == slot
        }
    }
}

// MARK: - Embedded HypenView

/// A lightweight SwiftUI view that manages a nested RemoteEngine + HypenRenderer
/// for rendering a remote Hypen app inline within the component tree.
private struct EmbeddedHypenView: View {
    let url: String
    let hostElementId: String
    let hostRenderer: HypenRenderer
    let hostActionDispatcher: ActionDispatcher

    @StateObject private var viewModel: EmbeddedHypenViewModel

    init(
        url: String,
        hostElementId: String,
        hostRenderer: HypenRenderer,
        hostActionDispatcher: ActionDispatcher
    ) {
        self.url = url
        self.hostElementId = hostElementId
        self.hostRenderer = hostRenderer
        self.hostActionDispatcher = hostActionDispatcher
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
                loadingView
            }

        case .connecting, .reconnecting, .disconnected:
            loadingView

        case .error(let message):
            HypenAppSlotView(
                slot: HypenAppSlots.error,
                hostElementId: hostElementId,
                renderer: hostRenderer,
                actionDispatcher: hostActionDispatcher
            ) {
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.red)
                    Text(message)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        }
    }

    private var loadingView: some View {
        HypenAppSlotView(
            slot: HypenAppSlots.loading,
            hostElementId: hostElementId,
            renderer: hostRenderer,
            actionDispatcher: hostActionDispatcher
        ) {
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
