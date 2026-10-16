import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

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
/// iOS 18 / macOS 15. With no Hypen container (a host app's own
/// `ScrollView`): each slot's `onScrollVisibilityChange` on iOS 18 /
/// macOS 15, before that each slot's `.global` frame against the screen;
/// `onAppear` / `onDisappear` (a few slots wide: lazy stacks prefetch) only
/// when neither says anything. Once per main-actor turn a
/// ``VirtViewportTracker`` applies the §3 overscan and reporting rules and
/// the wanted range goes to the engine through
/// ``HypenRenderer/reportListViewport(listId:start:end:)``.
///
/// Scroll anchoring (§2): in the owned `ScrollView`,
/// `scrollPosition(id:anchor:)` (iOS 17 / macOS 14) keeps the first visible
/// slot in place; before that the tracker measures how far the anchor moved
/// within the list and `ScrollViewProxy.scrollTo` puts it back. Nested in a
/// Hypen scroller, the same correction goes through that scroller's proxy
/// (published by ``View/hypenVirtScrollContainer(_:)``; slot ids carry the
/// list id, so they are unique in the outer scroll view). The anchor is the
/// first visible materialized row, so when an insert or removal above moves
/// it to another index the tracker follows its node and `scrollTo` puts it
/// back (``VirtViewportTracker/anchorCorrection(_:mode:)``). Under a host
/// app's own `ScrollView` there is no proxy to reach: no correction.
///
/// Accessibility (§2): every row's hint is its whole-list position ("Row 41
/// of 10,000"); the container's value is the total ("10,000 rows"); both
/// localized and host-overridable (``HypenAccessibility``).
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
    /// The nearest Hypen scroll container outside this view. Used to anchor
    /// a list without its own `ScrollView` through the ancestor's proxy.
    @Environment(\.hypenVirtScrollViewport) private var ancestorViewport

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
        let slots = Virtualization.slots(window, childIds: childIds, scope: listId)
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
        .accessibilityValue(Text(verbatim: HypenAccessibility.listSummary(window.total, columns > 1)))
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
        let vertical = isVertical
        // Slot ids carry the list id (`<listId>/i:<index>`): unique even in
        // an outer scroll view holding several lists, for its proxy's
        // `scrollTo` and the owned `scrollPosition(id:)` alike.
        return ForEach(slots.identified, id: \.id) { entry in
            let slot = entry.slot
            let slotId = entry.id
            slotView(slot, size: size)
                .background(frameReader(viewport) { span in
                    tracker.slotFrame(id: slotId, index: slot.index, min: span.min, max: span.max)
                    scheduleEvaluation()
                })
                // No Hypen scroller on this axis (a host app's ScrollView,
                // or none): ask the enclosing scroll view / the screen.
                .modifier(VirtHostVisibilityReader(
                    enabled: viewport == nil,
                    vertical: vertical,
                    visibility: { visible in
                        tracker.slotVisibility(id: slotId, index: slot.index, visible: visible)
                        scheduleEvaluation()
                    },
                    globalFrame: { span in
                        if let screen = VirtScreen.extent(vertical: vertical) {
                            tracker.globalViewport(min: 0, max: screen)
                        }
                        tracker.slotGlobalFrame(id: slotId, index: slot.index, min: span.min, max: span.max)
                        scheduleEvaluation()
                    }
                ))
                .onAppear {
                    tracker.slotAppeared(slot.index)
                    scheduleEvaluation()
                }
                .onDisappear {
                    tracker.slotDisappeared(slot.index)
                    tracker.slotFrameRemoved(id: slotId)
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
            let position = HypenAccessibility.listPosition(index, window.total, columns > 1)
            // The row's own hint (its root element's semantics description)
            // first, then the position. Elements inside the row that set
            // their own hint compose the same way through the environment
            // (`SemanticsModifier`), so whichever modifier SwiftUI keeps, it
            // says both.
            let ownHint = ids.count == 1 ? ids.first.flatMap { renderer.getElement($0)?.semantics?.description } : nil
            keyed {
                itemView(ids)
                    .environment(\.hypenListPositionHint, position)
                    .accessibilityHint(Text(verbatim: Virtualization.composeAccessibilityHint(
                        own: ownHint, position: position
                    ) ?? position))
                    .background(
                        GeometryReader { geometry in
                            Color.clear.onAppear {
                                let extent = axis == .vertical || columns > 1
                                    ? geometry.size.height : geometry.size.width
                                tracker.recordSize(index, extent: Double(extent))
                            }
                        }
                    )
                    .id(slot.contentId)
            }
        }
    }

    /// A one-child stack around a row keyed by its node (`.id(contentId)`):
    /// the slot itself is identified by item index (stable for
    /// `scrollPosition(id:)` when a placeholder materializes), the row's view
    /// state follows the node when an insert above shifts indices. The stack
    /// keeps that inner `.id` off the slot, where it could stand in for the
    /// `ForEach` id as the scroll target's identity.
    @ViewBuilder
    private func keyed<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        if isVertical {
            VStack(alignment: horizontalAlignment, spacing: 0, content: content)
        } else {
            HStack(alignment: verticalAlignment, spacing: 0, content: content)
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
        let vertical = isVertical
        // Who scrolls this list: its own ScrollView (anchored by
        // `scrollPosition(id:)` from iOS 17), else the nearest Hypen scroller
        // on the same axis (keeps its content offset), else a host app's
        // ScrollView we cannot reach (no correction).
        let outer: VirtScrollHandle? = scrolls ? nil
            : ancestorViewport.flatMap { $0.vertical == vertical ? $0.handle : nil }
        let correctsAnchor = scrolls || outer != nil
        let anchorMode: VirtAnchorMode = scrolls && Self.scrollPositionAnchors ? .slotPosition : .contentOffset
        Task { @MainActor in
            tracker.evaluationScheduled = false
            guard let element = renderer.getElement(listId), let window = element.virtWindow else { return }
            if let wanted = tracker.evaluate(window, spacing: spacing, columns: columns) {
                renderer.reportListViewport(listId: listId, start: wanted.start, end: wanted.end)
            }
            // §2 anchoring the scroll view did not do itself: before
            // `scrollPosition(id:)` it kept its offset while content above the
            // first visible item changed; with it, it kept the anchored slot
            // (an item index) while an insert or removal above moved the item
            // to another index. Scroll the item back to where it was.
            if correctsAnchor, let correction = tracker.anchorCorrection(
                Virtualization.slots(window, childIds: element.virtChildIds(renderer: renderer), scope: listId),
                mode: anchorMode
            ) {
                let u = CGFloat(correction.unitPoint)
                // `scrollTo` reaches any identified descendant of the
                // reader's scroll view, so the outer proxy finds this
                // list's slot; the unit point was computed against the
                // outer viewport (the frames are in its coordinate space).
                (outer?.proxy ?? (scrolls ? box.proxy : nil))?.scrollTo(
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

/// The owned `ScrollView`'s proxy (for ``VirtViewportTracker/anchorCorrection(_:mode:)``)
/// and the slot id `scrollPosition(id:)` anchors (iOS 17+). Main-actor use only.
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
/// coordinate space, axis, viewport extent along that axis, and its
/// `ScrollViewProxy` (for §2 anchoring of a list nested in it).
struct VirtScrollViewport: Equatable, Sendable {
    let space: String
    let vertical: Bool
    let extent: Double
    let handle: VirtScrollHandle

    static func == (lhs: VirtScrollViewport, rhs: VirtScrollViewport) -> Bool {
        lhs.space == rhs.space && lhs.vertical == rhs.vertical && lhs.extent == rhs.extent
            && lhs.handle === rhs.handle
    }
}

/// A Hypen scroll container's `ScrollViewProxy`, published by
/// ``View/hypenVirtScrollContainer(_:)``. A reference so the proxy can be
/// set once the reader exists without re-rendering the subtree. Main-actor
/// use only.
final class VirtScrollHandle: @unchecked Sendable {
    var proxy: ScrollViewProxy?
}

private struct VirtScrollViewportKey: EnvironmentKey {
    static let defaultValue: VirtScrollViewport? = nil
}

private struct HypenListPositionHintKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    /// A windowed list row's position hint ("Row 41 of 10,000"), set on the
    /// row so an element in it with its own hint appends the position
    /// instead of replacing it (``Virtualization/composeAccessibilityHint(own:position:)``).
    var hypenListPositionHint: String? {
        get { self[HypenListPositionHintKey.self] }
        set { self[HypenListPositionHintKey.self] = newValue }
    }

    /// Set by ``View/hypenVirtScrollContainer(_:)`` on Hypen's scroll views.
    var hypenVirtScrollViewport: VirtScrollViewport? {
        get { self[VirtScrollViewportKey.self] }
        set { self[VirtScrollViewportKey.self] = newValue }
    }
}

extension View {
    /// Make this `ScrollView` a scroll container windowed lists inside it can
    /// measure against: a unique named coordinate space plus its viewport
    /// extent in the environment (hypen-web/docs/virtualization.md §3 step 1),
    /// and a `ScrollViewReader` around it whose proxy a nested list uses to
    /// keep its first visible row in place (§2).
    func hypenVirtScrollContainer(_ axis: Axis) -> some View {
        modifier(VirtScrollContainerModifier(axis: axis))
    }
}

private struct VirtScrollContainerModifier: ViewModifier {
    let axis: Axis
    @State private var space = "hypen.virt.scroll.\(UUID().uuidString)"
    @State private var extent: Double = 0
    @State private var handle = VirtScrollHandle()

    init(axis: Axis) {
        self.axis = axis
    }

    func body(content: Content) -> some View {
        let vertical = axis == .vertical
        let handle = self.handle
        ScrollViewReader { proxy in
            content
                .environment(
                    \.hypenVirtScrollViewport,
                    extent > 0
                        ? VirtScrollViewport(space: space, vertical: vertical, extent: extent, handle: handle)
                        : nil
                )
                .coordinateSpace(name: space)
                .background(
                    GeometryReader { geometry in
                        let size = Double(vertical ? geometry.size.height : geometry.size.width)
                        Color.clear
                            .onAppear { extent = size }
                            .onChange(of: size) { newSize in extent = newSize }
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                )
                .onAppear { handle.proxy = proxy }
        }
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

/// A slot's visibility where no Hypen scroller is known (a host app's own
/// `ScrollView`, or none), for the tracker: iOS 18 / macOS 15 / tvOS 18 /
/// watchOS 11 — `onScrollVisibilityChange` (the enclosing scroll view, any
/// scroll view, says whether the slot shows); before — the slot's `.global`
/// frame (the tracker intersects it with the screen). A no-op when
/// `enabled` is false.
private struct VirtHostVisibilityReader: ViewModifier {
    let enabled: Bool
    let vertical: Bool
    let visibility: @MainActor (Bool) -> Void
    let globalFrame: @MainActor (VirtSpan) -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            if #available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, *) {
                // Any visible fraction counts: the range is about what is on
                // screen at all, not mostly on screen.
                content.onScrollVisibilityChange(threshold: 0.001) { visible in
                    visibility(visible)
                }
            } else {
                content.background(
                    GeometryReader { geometry in
                        let frame = geometry.frame(in: .global)
                        let span = vertical
                            ? VirtSpan(min: Double(frame.minY), max: Double(frame.maxY), extent: 0)
                            : VirtSpan(min: Double(frame.minX), max: Double(frame.maxX), extent: 0)
                        Color.clear
                            .onAppear { globalFrame(span) }
                            .onChange(of: span) { newSpan in globalFrame(newSpan) }
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                )
            }
        } else {
            content
        }
    }
}

/// The screen's extent along an axis in SwiftUI's `.global` space (window
/// coordinates; a window never exceeds its screen, so this bounds what can
/// be visible). Nil where there is no screen API (watchOS, visionOS).
@MainActor
enum VirtScreen {
    static func extent(vertical: Bool) -> Double? {
        #if canImport(UIKit) && !os(watchOS) && !os(visionOS)
        let bounds = UIScreen.main.bounds
        return Double(vertical ? bounds.height : bounds.width)
        #elseif canImport(AppKit)
        guard let frame = NSScreen.main?.frame else { return nil }
        return Double(vertical ? frame.height : frame.width)
        #else
        return nil
        #endif
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
