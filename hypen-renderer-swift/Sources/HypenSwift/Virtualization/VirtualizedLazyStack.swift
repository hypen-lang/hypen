import SwiftUI

/// A windowed list rendered in a native lazy container
/// (hypen-web/docs/virtualization.md §5).
///
/// The container declares `total` slots. Slot `i` renders the materialized
/// child(ren) for item `i` when `start ≤ i < end`, else a placeholder sized
/// to the current item-size estimate (§2). Each slot reports its own
/// visibility (`onAppear` / `onDisappear`) to a ``VirtViewportTracker``; once
/// per main-actor turn the tracker applies the §3 overscan and reporting
/// rules and the wanted range goes to the engine through
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
            } else {
                container(slots: slots, size: size)
            }
        }
        .onAppear { scheduleEvaluation() }
        .onChange(of: window) { _ in scheduleEvaluation() }
    }

    @ViewBuilder
    private func container(slots: [Virtualization.Slot], size: CGFloat) -> some View {
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

    private func slotViews(_ slots: [Virtualization.Slot], size: CGFloat) -> some View {
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
        Task { @MainActor in
            tracker.evaluationScheduled = false
            guard let window = renderer.getElement(listId)?.virtWindow else { return }
            if let wanted = tracker.evaluate(window) {
                renderer.reportListViewport(listId: listId, start: wanted.start, end: wanted.end)
            }
        }
    }
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
