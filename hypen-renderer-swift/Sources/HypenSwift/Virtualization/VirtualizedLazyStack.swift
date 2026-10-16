import SwiftUI

/// A windowed list rendered in a native lazy container
/// (hypen-web/docs/virtualization.md §5).
///
/// The container declares `total` slots. Slot `i` renders the materialized
/// child(ren) for item `i` when `start ≤ i < end`, else a placeholder sized
/// to the current item-size estimate (§2). The visible range comes from the
/// owned `ScrollView`'s geometry (`onScrollGeometryChange`, iOS 18 /
/// macOS 15) when there is one, else from each slot's `onAppear` /
/// `onDisappear` (a few slots wide: lazy stacks prefetch). Once per
/// main-actor turn a ``VirtViewportTracker`` applies the §3 overscan and
/// reporting rules and the wanted range goes to the engine through
/// ``HypenRenderer/reportListViewport(listId:start:end:)``.
///
/// The slot mapping, size estimate and reporting decisions are pure
/// (`VirtualizationMath.swift`, unit-tested); this view only wires them to
/// SwiftUI.
@MainActor
struct VirtualizedLazyStack: View {
    let listId: String
    let window: VirtWindow
    let childIds: [String]
    let renderer: HypenRenderer
    let actionDispatcher: ActionDispatcher
    /// Scroll / stacking axis.
    let axis: Axis
    /// Items per row (`> 1` lays out a `LazyVGrid`).
    let columns: Int
    let spacing: CGFloat
    let horizontalAlignment: HorizontalAlignment
    let verticalAlignment: VerticalAlignment
    /// Wrap the lazy container in its own `ScrollView`. `false` when an
    /// ancestor scrolls: a lazy stack is still lazy against its nearest
    /// enclosing scroll view.
    let scrolls: Bool
    /// Per-child environment (expansion permissions etc.), as the
    /// component's non-windowed branch applies.
    let decorateChild: @MainActor (HypenElementView, HypenElement?) -> AnyView

    @State private var tracker = VirtViewportTracker()

    /// Component handlers (`typeName`) that render `__virt.window` through
    /// this view. Any other windowed element renders as a `Column`
    /// (`HypenElementContentView.componentHandler(for:)`).
    static let windowAwareTypes: Set<String> = ["list", "grid", "column", "row"]

    // Explicit: the private `@State` would make the memberwise init private.
    init(
        listId: String,
        window: VirtWindow,
        childIds: [String],
        renderer: HypenRenderer,
        actionDispatcher: ActionDispatcher,
        axis: Axis,
        columns: Int = 1,
        spacing: CGFloat = 0,
        horizontalAlignment: HorizontalAlignment = .leading,
        verticalAlignment: VerticalAlignment = .center,
        scrolls: Bool = true,
        decorateChild: @escaping @MainActor (HypenElementView, HypenElement?) -> AnyView = { view, _ in AnyView(view) }
    ) {
        self.listId = listId
        self.window = window
        self.childIds = childIds
        self.renderer = renderer
        self.actionDispatcher = actionDispatcher
        self.axis = axis
        self.columns = columns
        self.spacing = spacing
        self.horizontalAlignment = horizontalAlignment
        self.verticalAlignment = verticalAlignment
        self.scrolls = scrolls
        self.decorateChild = decorateChild
    }

    var body: some View {
        let slots = Virtualization.slots(window, childIds: childIds)
        let size = CGFloat(tracker.itemSize(window))
        Group {
            if scrolls {
                ScrollView(axis == .vertical ? .vertical : .horizontal, showsIndicators: true) {
                    container(slots: slots, size: size)
                }
                .modifier(VirtScrollGeometryReader(axis: axis) { offset, extent in
                    tracker.scrolled(offset: offset, extent: extent)
                    scheduleEvaluation()
                })
            } else {
                container(slots: slots, size: size)
            }
        }
        .onAppear { scheduleEvaluation() }
        .onChange(of: window) { _ in scheduleEvaluation() }
    }

    @ViewBuilder
    private func container(slots: Virtualization.Slots, size: CGFloat) -> some View {
        if columns > 1 {
            let gridColumns = Array(repeating: GridItem(.flexible(), spacing: spacing), count: columns)
            LazyVGrid(columns: gridColumns, spacing: spacing) {
                slotViews(slots, size: size)
            }
        } else if axis == .vertical {
            LazyVStack(alignment: horizontalAlignment, spacing: spacing) {
                slotViews(slots, size: size)
            }
            .frame(maxWidth: .infinity, alignment: Alignment(horizontal: horizontalAlignment, vertical: .top))
        } else {
            LazyHStack(alignment: verticalAlignment, spacing: spacing) {
                slotViews(slots, size: size)
            }
        }
    }

    private func slotViews(_ slots: Virtualization.Slots, size: CGFloat) -> some View {
        ForEach(slots, id: \.id) { slot in
            slotView(slot, size: size)
                .onAppear {
                    tracker.slotAppeared(slot.index)
                    scheduleEvaluation()
                }
                .onDisappear {
                    tracker.slotDisappeared(slot.index)
                    scheduleEvaluation()
                }
        }
    }

    @ViewBuilder
    private func slotView(_ slot: Virtualization.Slot, size: CGFloat) -> some View {
        switch slot {
        case .placeholder:
            placeholder(size: size)
                .accessibilityHidden(true)
        case let .item(index, ids):
            itemView(ids)
                .background(
                    GeometryReader { geometry in
                        Color.clear.onAppear {
                            let extent = axis == .vertical || columns > 1
                                ? geometry.size.height : geometry.size.width
                            tracker.recordSize(index, extent: Double(extent))
                        }
                    }
                )
        }
    }

    @ViewBuilder
    private func itemView(_ ids: [String]) -> some View {
        if ids.count == 1, let id = ids.first {
            child(id)
        } else if axis == .vertical || columns > 1 {
            VStack(alignment: horizontalAlignment, spacing: spacing) {
                ForEach(ids, id: \.self) { child($0) }
            }
        } else {
            HStack(alignment: verticalAlignment, spacing: spacing) {
                ForEach(ids, id: \.self) { child($0) }
            }
        }
    }

    private func child(_ id: String) -> AnyView {
        decorateChild(
            HypenElementView(elementId: id, renderer: renderer, actionDispatcher: actionDispatcher),
            renderer.getElement(id)
        )
    }

    @ViewBuilder
    private func placeholder(size: CGFloat) -> some View {
        if axis == .vertical || columns > 1 {
            Color.clear.frame(maxWidth: .infinity).frame(height: size)
        } else {
            Color.clear.frame(width: size)
        }
    }

    /// Evaluate on the next main-actor turn, once per burst of callbacks,
    /// against the list's window at that moment (a batch may have moved it).
    private func scheduleEvaluation() {
        let tracker = self.tracker
        guard !tracker.evaluationScheduled else { return }
        tracker.evaluationScheduled = true
        let renderer = self.renderer
        let listId = self.listId
        let spacing = Double(self.spacing)
        let columns = self.columns
        Task { @MainActor in
            tracker.evaluationScheduled = false
            guard let window = renderer.getElement(listId)?.virtWindow else { return }
            if let wanted = tracker.evaluate(window, spacing: spacing, columns: columns) {
                renderer.reportListViewport(listId: listId, start: wanted.start, end: wanted.end)
            }
        }
    }
}

/// Feeds the owned `ScrollView`'s visible extent (content coordinates along
/// [axis]) to the tracker where SwiftUI exposes it (iOS 18 / macOS 15 /
/// tvOS 18 / watchOS 11); a no-op before that, leaving the per-slot
/// `onAppear` / `onDisappear` range in charge.
private struct VirtScrollGeometryReader: ViewModifier {
    let axis: Axis
    let onChange: @MainActor (_ offset: Double, _ extent: Double) -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        let vertical = axis == .vertical
        if #available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, *) {
            content.onScrollGeometryChange(for: VirtScrollExtent.self) { geometry in
                let rect = geometry.visibleRect
                return vertical
                    ? VirtScrollExtent(offset: Double(rect.minY), extent: Double(rect.height))
                    : VirtScrollExtent(offset: Double(rect.minX), extent: Double(rect.width))
            } action: { _, visible in
                onChange(visible.offset, visible.extent)
            }
        } else {
            content
        }
    }
}

private struct VirtScrollExtent: Equatable, Sendable {
    var offset: Double
    var extent: Double
}

extension HypenElement {
    /// The windowed list's children, flattened through control-flow
    /// wrappers like the non-windowed branches (a no-op for engine output,
    /// whose rows are direct children of the list element).
    @MainActor
    func virtChildIds(renderer: HypenRenderer) -> [String] {
        ControlFlowUtils.flattenControlFlowChildren(renderer.getChildren(of: id), renderer: renderer).map(\.id)
    }
}
