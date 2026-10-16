import SwiftUI

/// A windowed list rendered in a native lazy container
/// (hypen-web/docs/virtualization.md §5).
///
/// The container declares `total` slots. Slot `i` renders the materialized
/// child(ren) for item `i` when `start ≤ i < end`, else a placeholder sized
/// to the current item-size estimate (§2).
///
/// Visible range: each slot's frame in the nearest Hypen scroll container's
/// named coordinate space (the owned `ScrollView`, or an ancestor's — see
/// ``View/hypenVirtScrollContainer(_:)``), plus `onScrollGeometryChange` on
/// iOS 18 / macOS 15; with no known container (a host app's own
/// `ScrollView`), each slot's `onAppear` / `onDisappear` (a few slots wide:
/// lazy stacks prefetch). Once per main-actor turn a ``VirtViewportTracker``
/// applies the §3 overscan and reporting rules and the wanted range goes to
/// the engine through ``HypenRenderer/reportListViewport(listId:start:end:)``.
///
/// Scroll anchoring (§2), owned `ScrollView` only: `scrollPosition(id:anchor:)`
/// (iOS 17 / macOS 14) keeps the first visible slot in place; before that
/// the tracker measures how far that slot moved within the list and
/// `ScrollViewProxy.scrollTo` puts it back.
///
/// Accessibility (§2): every row's hint is its whole-list position ("Row 41
/// of 10000"); the container's value is the total ("10000 rows").
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
    /// The owned `ScrollView`'s proxy and anchored slot id. A reference, not
    /// `@State` values: SwiftUI writes the scroll position on every row
    /// boundary and nothing here needs to re-render for it.
    @State private var scrollBox = VirtScrollBox()

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
        let box = scrollBox
        Group {
            if scrolls {
                ScrollViewReader { proxy in
                    ScrollView(axis == .vertical ? .vertical : .horizontal, showsIndicators: true) {
                        VirtScrollViewportReader { viewport in
                            container(slots: slots, size: size, viewport: viewport)
                        }
                    }
                    .modifier(VirtScrollGeometryReader(axis: axis) { offset, extent in
                        tracker.scrolled(offset: offset, extent: extent)
                        scheduleEvaluation()
                    })
                    .modifier(VirtScrollPositionAnchor(
                        id: Binding(get: { box.anchorId }, set: { box.anchorId = $0 }),
                        anchor: isVertical ? .top : .leading
                    ))
                    .hypenVirtScrollContainer(isVertical ? .vertical : .horizontal)
                    .onAppear { box.proxy = proxy }
                }
            } else {
                VirtScrollViewportReader { viewport in
                    container(slots: slots, size: size, viewport: viewport)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityValue(Text(verbatim: Virtualization.accessibilitySummary(total: window.total, columns: columns)))
        .onAppear { scheduleEvaluation() }
        .onChange(of: window) { newWindow in
            tracker.observe(newWindow)
            scheduleEvaluation()
        }
    }

    /// Lays out along the vertical axis (a grid always does).
    private var isVertical: Bool { axis == .vertical || columns > 1 }

    @ViewBuilder
    private func container(slots: Virtualization.Slots, size: CGFloat, viewport scrollViewport: VirtScrollViewport?) -> some View {
        // A scroll container on the other axis does not scroll this list.
        let viewport: VirtScrollViewport? = scrollViewport?.vertical == isVertical ? scrollViewport : nil
        let tracker = self.tracker
        Group {
            if columns > 1 {
                let gridColumns = Array(repeating: GridItem(.flexible(), spacing: spacing), count: columns)
                LazyVGrid(columns: gridColumns, spacing: spacing) {
                    slotViews(slots, size: size, viewport: viewport)
                }
                .modifier(VirtScrollTargetLayout())
            } else if axis == .vertical {
                LazyVStack(alignment: horizontalAlignment, spacing: spacing) {
                    slotViews(slots, size: size, viewport: viewport)
                }
                .modifier(VirtScrollTargetLayout())
                .frame(maxWidth: .infinity, alignment: Alignment(horizontal: horizontalAlignment, vertical: .top))
            } else {
                LazyHStack(alignment: verticalAlignment, spacing: spacing) {
                    slotViews(slots, size: size, viewport: viewport)
                }
                .modifier(VirtScrollTargetLayout())
            }
        }
        .background(frameReader(viewport) { span in
            tracker.listFrame(leading: span.min, viewportExtent: span.extent)
            scheduleEvaluation()
        })
    }

    private func slotViews(_ slots: Virtualization.Slots, size: CGFloat, viewport: VirtScrollViewport?) -> some View {
        let tracker = self.tracker
        return ForEach(slots, id: \.id) { slot in
            slotView(slot, size: size)
                .background(frameReader(viewport) { span in
                    tracker.slotFrame(id: slot.id, index: slot.index, min: span.min, max: span.max)
                    scheduleEvaluation()
                })
                .onAppear {
                    tracker.slotAppeared(slot.index)
                    scheduleEvaluation()
                }
                .onDisappear {
                    tracker.slotDisappeared(slot.index)
                    tracker.slotFrameRemoved(id: slot.id)
                    scheduleEvaluation()
                }
        }
    }

    /// Reports the view's extent along the scroll axis in the scroll
    /// container's named coordinate space (viewport coordinates), on appear
    /// and whenever it moves. Nothing without a known container.
    @ViewBuilder
    private func frameReader(
        _ viewport: VirtScrollViewport?,
        report: @escaping @MainActor (VirtSpan) -> Void
    ) -> some View {
        if let viewport {
            GeometryReader { proxy in
                let frame = proxy.frame(in: .named(viewport.space))
                let span = viewport.vertical
                    ? VirtSpan(min: Double(frame.minY), max: Double(frame.maxY), extent: viewport.extent)
                    : VirtSpan(min: Double(frame.minX), max: Double(frame.maxX), extent: viewport.extent)
                Color.clear
                    .onAppear { report(span) }
                    .onChange(of: span) { newSpan in report(newSpan) }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
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
                .accessibilityHint(Text(verbatim: Virtualization.accessibilityPosition(
                    index: index, total: window.total, columns: columns
                )))
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
        let box = self.scrollBox
        let correctsAnchor = scrolls && !Self.scrollPositionAnchors
        let vertical = isVertical
        Task { @MainActor in
            tracker.evaluationScheduled = false
            guard let window = renderer.getElement(listId)?.virtWindow else { return }
            if let wanted = tracker.evaluate(window, spacing: spacing, columns: columns) {
                renderer.reportListViewport(listId: listId, start: wanted.start, end: wanted.end)
            }
            // §2 anchoring before `scrollPosition(id:)`: the scroll view kept
            // its offset while content above the first visible slot changed
            // size; scroll that slot back to where it was.
            if correctsAnchor, let correction = tracker.anchorCorrection() {
                let u = CGFloat(correction.unitPoint)
                box.proxy?.scrollTo(
                    correction.slotId,
                    anchor: vertical ? UnitPoint(x: 0, y: u) : UnitPoint(x: u, y: 0)
                )
            }
        }
    }

    /// Whether SwiftUI anchors the owned `ScrollView` itself
    /// (`scrollPosition(id:anchor:)`, ``VirtScrollPositionAnchor``).
    private static var scrollPositionAnchors: Bool {
        if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) { return true }
        return false
    }
}

/// The owned `ScrollView`'s proxy (for anchoring before iOS 17) and the slot
/// id `scrollPosition(id:)` anchors (iOS 17+). Main-actor use only.
final class VirtScrollBox: @unchecked Sendable {
    var proxy: ScrollViewProxy?
    var anchorId: String?
}

/// A view's extent along the scroll axis in its scroll container's viewport
/// coordinates, with the viewport's extent.
struct VirtSpan: Equatable, Sendable {
    var min: Double
    var max: Double
    var extent: Double
}

/// The nearest Hypen scroll container around a view (§3 step 1): its named
/// coordinate space, axis and viewport extent along that axis.
struct VirtScrollViewport: Equatable, Sendable {
    let space: String
    let vertical: Bool
    let extent: Double
}

private struct VirtScrollViewportKey: EnvironmentKey {
    static let defaultValue: VirtScrollViewport? = nil
}

extension EnvironmentValues {
    /// Set by ``View/hypenVirtScrollContainer(_:)`` on Hypen's scroll views.
    var hypenVirtScrollViewport: VirtScrollViewport? {
        get { self[VirtScrollViewportKey.self] }
        set { self[VirtScrollViewportKey.self] = newValue }
    }
}

extension View {
    /// Make this `ScrollView` a scroll container windowed lists inside it can
    /// measure against: a unique named coordinate space plus its viewport
    /// extent in the environment (hypen-web/docs/virtualization.md §3 step 1).
    func hypenVirtScrollContainer(_ axis: Axis) -> some View {
        modifier(VirtScrollContainerModifier(axis: axis))
    }
}

private struct VirtScrollContainerModifier: ViewModifier {
    let axis: Axis
    @State private var space = "hypen.virt.scroll.\(UUID().uuidString)"
    @State private var extent: Double = 0

    init(axis: Axis) {
        self.axis = axis
    }

    func body(content: Content) -> some View {
        let vertical = axis == .vertical
        content
            .environment(
                \.hypenVirtScrollViewport,
                extent > 0 ? VirtScrollViewport(space: space, vertical: vertical, extent: extent) : nil
            )
            .coordinateSpace(name: space)
            .background(
                GeometryReader { proxy in
                    let size = Double(vertical ? proxy.size.height : proxy.size.width)
                    Color.clear
                        .onAppear { extent = size }
                        .onChange(of: size) { newSize in extent = newSize }
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            )
    }
}

/// Reads ``EnvironmentValues/hypenVirtScrollViewport`` where it is placed
/// (inside the owned `ScrollView`, so the owned container wins).
private struct VirtScrollViewportReader<Content: View>: View {
    @Environment(\.hypenVirtScrollViewport) private var viewport
    let content: @MainActor (VirtScrollViewport?) -> Content

    init(@ViewBuilder content: @escaping @MainActor (VirtScrollViewport?) -> Content) {
        self.content = content
    }

    var body: some View { content(viewport) }
}

/// `scrollTargetLayout()` (iOS 17 / macOS 14) on the lazy container, so its
/// slots are the targets `scrollPosition(id:)` identifies; a no-op before.
private struct VirtScrollTargetLayout: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) {
            content.scrollTargetLayout()
        } else {
            content
        }
    }
}

/// `scrollPosition(id:anchor:)` (iOS 17 / macOS 14): the scroll view tracks
/// the first visible slot by id and keeps it at `anchor` while content
/// around it changes (§2 scroll anchoring); a no-op before.
private struct VirtScrollPositionAnchor: ViewModifier {
    let id: Binding<String?>
    let anchor: UnitPoint

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 17.0, macOS 14.0, tvOS 17.0, watchOS 10.0, *) {
            content.scrollPosition(id: id, anchor: anchor)
        } else {
            content
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
