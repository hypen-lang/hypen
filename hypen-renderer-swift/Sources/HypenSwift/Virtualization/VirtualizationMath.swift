import Foundation

// List virtualization — the renderer side of the `__virt.window` contract
// (hypen-web/docs/virtualization.md). A port of
// `@hypen-space/core/virtualization` (packages/core/src/virtualization.ts);
// keep `VirtualizationMathTests` aligned with
// hypen-web/tests/virtualization-math.test.ts.
//
// Pure Foundation code — no SwiftUI — so it builds and tests on Linux.
//
// Sizes are in points along the list's scroll axis. Items are counted in
// ITEMS, not children: a multi-node template renders several children per
// item (`childrenPerItem`).

/// The decoded `__virt.window` value: the list element's children are
/// exactly the items `[start, end)` of `total`.
public struct VirtWindow: Equatable, Sendable {
    /// Reserved prop the engine sets on a windowed list's element.
    public static let propName = "__virt.window"

    public var total: Int
    public var start: Int
    public var end: Int
    public var estimatedSize: Double?

    public init(total: Int, start: Int, end: Int, estimatedSize: Double? = nil) {
        self.total = total
        self.start = start
        self.end = end
        self.estimatedSize = estimatedSize
    }

    /// Items materialized as children.
    public var count: Int { end - start }
}

/// An item range `[start, end)`.
public struct ItemRange: Equatable, Sendable {
    public var start: Int
    public var end: Int

    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }
}

public enum Virtualization {
    /// Size used for unmeasured items when nothing better is known.
    public static let defaultItemSize: Double = 48

    /// Minimum overscan, in items, on each side of the visible range.
    public static let minOverscanItems = 5

    /// Decode a `__virt.window` prop value; `nil` for anything malformed.
    public static func parseVirtWindow(_ value: Any?) -> VirtWindow? {
        guard let dict = value as? [String: Any],
              let total = count(dict["total"]),
              let start = count(dict["start"]),
              let end = count(dict["end"]) else {
            return nil
        }
        guard start <= end, end <= total else { return nil }
        var window = VirtWindow(total: total, start: start, end: end)
        if let size = number(dict["estimatedSize"]), size > 0, size.isFinite {
            window.estimatedSize = size
        }
        return window
    }

    /// Size to assume per item: the average measured size of the
    /// materialized items, else the template's estimate, else
    /// ``defaultItemSize``.
    ///
    /// - Parameters:
    ///   - measuredTotal: summed extent of the materialized items (0 if unknown)
    ///   - measuredCount: how many items that sum covers
    public static func itemSize(_ window: VirtWindow, measuredTotal: Double, measuredCount: Int) -> Double {
        if measuredCount > 0 && measuredTotal > 0 { return measuredTotal / Double(measuredCount) }
        return window.estimatedSize ?? defaultItemSize
    }

    /// Padding standing in for the items before and after the window. For a
    /// grid with `columns > 1`, items lay out in rows of `columns` and `size`
    /// is a row's extent.
    public static func windowPadding(
        _ window: VirtWindow,
        size: Double,
        columns: Int = 1
    ) -> (leading: Double, trailing: Double) {
        let cols = max(1, columns)
        let rowsBefore = ceilDiv(window.start, cols)
        let rowsTotal = ceilDiv(window.total, cols)
        let rowsAfter = max(0, rowsTotal - rowsBefore - windowRows(window, columns: cols))
        return (Double(rowsBefore) * size, Double(rowsAfter) * size)
    }

    /// Rows the materialized items occupy: `end - start` for a list; for a
    /// grid with `columns > 1`, every row any of them touches. Divide the
    /// measured extent of the children by this to get the row size for
    /// ``itemSize(_:measuredTotal:measuredCount:)``.
    public static func windowRows(_ window: VirtWindow, columns: Int = 1) -> Int {
        let cols = max(1, columns)
        return ceilDiv(window.end, cols) - window.start / cols
    }

    /// Children per item (§1): a multi-node template renders several
    /// children for each item. Never less than 1, so
    /// `start + childIndex / n` is always the item a child belongs to.
    public static func childrenPerItem(_ window: VirtWindow, childCount: Int) -> Int {
        let items = window.count
        guard items > 0, childCount > 0 else { return 1 }
        return max(1, Int((Double(childCount) / Double(items)).rounded()))
    }

    /// Items the user can see.
    ///
    /// - Parameters:
    ///   - scrolledPast: how far the scroll container has scrolled past the
    ///     list's leading edge (0 when it hasn't reached the list)
    ///   - viewportExtent: the scroll container's visible extent
    public static func visibleRange(
        total: Int,
        size: Double,
        scrolledPast: Double,
        viewportExtent: Double,
        columns: Int = 1
    ) -> ItemRange {
        let cols = max(1, columns)
        let s = size > 0 ? size : defaultItemSize
        let past = max(0, scrolledPast)
        let firstRow = (past / s).rounded(.down)
        let lastRow = ((past + max(0, viewportExtent)) / s).rounded(.up)
        return ItemRange(
            start: clamp(firstRow * Double(cols), 0, total),
            end: clamp(lastRow * Double(cols), 0, total)
        )
    }

    /// The range to ask the engine for: the visible range widened on both
    /// sides by one viewport's worth of items, at least ``minOverscanItems``.
    public static func wantedRange(_ visible: ItemRange, total: Int) -> ItemRange {
        let overscan = max(minOverscanItems, visible.end - visible.start)
        return ItemRange(
            start: min(total, max(0, visible.start - overscan)),
            end: min(total, max(0, visible.end + overscan))
        )
    }

    /// Whether to report `wanted` given the current window and the last
    /// report. Report when the visible range is not covered by the window, or
    /// the window is more than three times what is wanted (shrink after a
    /// fling) — never the same range twice in a row.
    public static func shouldReport(
        _ window: VirtWindow,
        visible: ItemRange,
        wanted: ItemRange,
        lastReported: ItemRange?
    ) -> Bool {
        if let last = lastReported, last == wanted { return false }
        let covered = visible.start >= window.start && visible.end <= window.end
        let wantedSize = max(1, wanted.end - wanted.start)
        let oversized = window.end - window.start > 3 * wantedSize
        return !covered || oversized
    }

    /// Whether a newly received `__virt.window` differs in value from the
    /// previous one (`nil` = none yet). §3 step 4: when it does, forget
    /// `lastReported` — the engine may have moved the window on its own
    /// (e.g. `total` changed) to exactly the range last reported, and the
    /// renderer must be able to ask for it again. An identical re-send is not
    /// a change.
    public static func windowChanged(_ previous: VirtWindow?, _ next: VirtWindow) -> Bool {
        previous != next
    }

    /// §3 steps 2–4 in one call: the visible range, widened by overscan, if
    /// it should be reported now — else nil. The caller sends it and keeps it
    /// as `lastReported` for the next call. While the list starts below the
    /// top of the viewport (`scrolledPast < 0`) only the part of the viewport
    /// over the list counts as visible.
    public static func viewportReport(
        _ window: VirtWindow,
        geometry: ViewportGeometry,
        lastReported: ItemRange?
    ) -> ItemRange? {
        let extent = geometry.viewportExtent + min(0, geometry.scrolledPast)
        let visible = visibleRange(
            total: window.total,
            size: geometry.size,
            scrolledPast: geometry.scrolledPast,
            viewportExtent: extent,
            columns: geometry.columns
        )
        let wanted = wantedRange(visible, total: window.total)
        return shouldReport(window, visible: visible, wanted: wanted, lastReported: lastReported) ? wanted : nil
    }

    /// The remote `viewport` message (§4) a client sends for a windowed
    /// list; bounds clamped to `[0, UInt32.max]`.
    public static func viewportMessage(listId: String, start: Int, end: Int) -> [String: Any] {
        let cap = Int(UInt32.max)
        return [
            "type": "viewport",
            "listId": listId,
            "start": min(cap, max(0, start)),
            "end": min(cap, max(0, end)),
        ]
    }

    // MARK: - Scroll anchoring (§2)

    /// The `UnitPoint` coordinate (along the scroll axis) that
    /// `ScrollViewProxy.scrollTo(_:anchor:)` needs to put a row's leading
    /// edge `rowOffset` points from the viewport's leading edge. `scrollTo`
    /// aligns the point `u` of the row with the point `u` of the viewport, so
    /// `rowOffset = u × (viewportExtent − rowExtent)`. Nil when the row is as
    /// long as the viewport (any `u` gives the same position) or the inputs
    /// are not finite.
    public static func anchorUnitPoint(rowOffset: Double, rowExtent: Double, viewportExtent: Double) -> Double? {
        let free = viewportExtent - rowExtent
        guard rowOffset.isFinite, free.isFinite, abs(free) >= 0.5 else { return nil }
        return rowOffset / free
    }

    // MARK: - Accessibility (§2)

    /// What a materialized row says about its place in the whole list, the
    /// SwiftUI stand-in for `aria-posinset` / `aria-setsize` and Android's
    /// `CollectionItemInfo` (SwiftUI has no set-position API for arbitrary
    /// views): "Row 41 of 10000", or "Item 41 of 10000" in a grid.
    public static func accessibilityPosition(index: Int, total: Int, columns: Int = 1) -> String {
        let noun = columns > 1 ? "Item" : "Row"
        return "\(noun) \(max(0, index) + 1) of \(max(0, total))"
    }

    /// The list container's size, for its accessibility value:
    /// "10000 rows", "1 row", "30 items".
    public static func accessibilitySummary(total: Int, columns: Int = 1) -> String {
        let n = max(0, total)
        let noun = columns > 1 ? (n == 1 ? "item" : "items") : (n == 1 ? "row" : "rows")
        return "\(n) \(noun)"
    }

    // MARK: - Native lazy containers (§5)

    /// One of a windowed list's `total` slots.
    public enum Slot: Equatable, Sendable {
        /// Item `index` is materialized: render these child ids, in order.
        case item(index: Int, childIds: [String])
        /// Item `index` is outside the window: render a placeholder of the
        /// estimated item size.
        case placeholder(index: Int)

        public var index: Int {
            switch self {
            case let .item(index, _), let .placeholder(index): return index
            }
        }

        /// Stable identity for a lazy container's `ForEach`: the item index
        /// for placeholders, the first child's node id for materialized rows.
        public var id: String {
            switch self {
            case let .placeholder(index): return "p:\(index)"
            case let .item(index, childIds): return childIds.first.map { "n:\($0)" } ?? "p:\(index)"
            }
        }
    }

    /// Map the list element's children onto `total` slots. Slot `i` is
    /// `.item` when `start ≤ i < end` and its children exist, else
    /// `.placeholder`. Children are grouped per item (``childrenPerItem(_:childCount:)``);
    /// a short child list (a batch still settling) leaves the uncovered items
    /// as placeholders rather than throwing.
    public static func slots(_ window: VirtWindow, childIds: [String]) -> Slots {
        Slots(window: window, childIds: childIds)
    }

    /// The `total` slots of a windowed list, resolved on demand: O(1) to
    /// build, so a 10,000-item list never allocates 10,000 slot values per
    /// render (Android's `VirtSlots` is the same shape).
    public struct Slots: RandomAccessCollection, Sendable {
        public let window: VirtWindow
        public let childIds: [String]
        public let childrenPerItem: Int

        public init(window: VirtWindow, childIds: [String]) {
            self.window = window
            self.childIds = childIds
            self.childrenPerItem = Virtualization.childrenPerItem(window, childCount: childIds.count)
        }

        public var startIndex: Int { 0 }
        public var endIndex: Int { window.total }

        public subscript(index: Int) -> Slot {
            if index >= window.start && index < window.end {
                let lo = (index - window.start) * childrenPerItem
                if lo < childIds.count {
                    let hi = Swift.min(childIds.count, lo + childrenPerItem)
                    return .item(index: index, childIds: Array(childIds[lo..<hi]))
                }
            }
            return .placeholder(index: index)
        }
    }

    // MARK: - Helpers

    /// A non-negative integer (JSON number with no fraction), else nil.
    /// Booleans are rejected even though Foundation bridges them to NSNumber.
    static func count(_ value: Any?) -> Int? {
        guard let value, !(value is String) else { return nil }
        if let number = value as? NSNumber {
            if isBoolean(number) { return nil }
            let d = number.doubleValue
            guard d.isFinite, d >= 0, d.rounded(.towardZero) == d, d <= Double(Int.max / 2) else { return nil }
            return Int(d)
        }
        if let int = value as? Int { return int >= 0 ? int : nil }
        if let d = value as? Double, d.isFinite, d >= 0, d.rounded(.towardZero) == d { return Int(d) }
        return nil
    }

    static func number(_ value: Any?) -> Double? {
        guard let value, !(value is String) else { return nil }
        if let number = value as? NSNumber {
            if isBoolean(number) { return nil }
            return number.doubleValue
        }
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        return nil
    }

    /// `true`/`false` decoded by JSONSerialization are NSNumbers whose
    /// encoding is `c` (Darwin `__NSCFBoolean`, swift-corelibs) or `B`.
    /// A Swift `Bool` literal bridges the same way.
    static func isBoolean(_ number: NSNumber) -> Bool {
        let encoding = String(cString: number.objCType)
        return encoding == "c" || encoding == "B"
    }

    static func ceilDiv(_ a: Int, _ b: Int) -> Int { (a + b - 1) / b }

    static func clamp(_ n: Double, _ lo: Int, _ hi: Int) -> Int {
        Int(min(Double(hi), max(Double(lo), n)))
    }
}

/// Where a list sits in its scroll container, for
/// ``Virtualization/viewportReport(_:geometry:lastReported:)``.
public struct ViewportGeometry: Equatable, Sendable {
    /// Extent of one item (one row of items for a grid).
    public var size: Double
    /// How far the scroll container has scrolled past the list's leading
    /// edge; negative while the list starts below the top of the viewport.
    public var scrolledPast: Double
    /// The scroll container's visible extent.
    public var viewportExtent: Double
    public var columns: Int

    public init(size: Double, scrolledPast: Double, viewportExtent: Double, columns: Int = 1) {
        self.size = size
        self.scrolledPast = scrolledPast
        self.viewportExtent = viewportExtent
        self.columns = columns
    }
}

/// One slot's extent along the scroll axis in the scroll container's
/// viewport coordinates (0 = the viewport's leading edge), for
/// ``VirtViewportTracker/slotFrame(id:index:min:max:)``.
public struct VirtSlotFrame: Equatable, Sendable {
    public var index: Int
    public var min: Double
    public var max: Double

    public init(index: Int, min: Double, max: Double) {
        self.index = index
        self.min = min
        self.max = max
    }
}

/// Scroll the slot `slotId` so its leading edge is back where it was before
/// a layout change above it (§2 scroll anchoring): pass `unitPoint` as the
/// scroll-axis coordinate of `ScrollViewProxy.scrollTo(_:anchor:)`.
public struct VirtAnchorCorrection: Equatable, Sendable {
    public var slotId: String
    public var unitPoint: Double

    public init(slotId: String, unitPoint: Double) {
        self.slotId = slotId
        self.unitPoint = unitPoint
    }
}

/// Visibility bookkeeping for one windowed native lazy container (§5),
/// turned into the range to report by ``evaluate(_:spacing:columns:)`` under
/// the §3 overscan and reporting rules. Pure — the SwiftUI view owns one and
/// calls the engine with what `evaluate` returns.
///
/// Three sources of the visible range, best first:
/// - **Slot frames** (``slotFrame(id:index:min:max:)`` with
///   ``listFrame(leading:viewportExtent:)``, from a `GeometryReader` per slot
///   in the scroll container's named coordinate space): the slots that
///   actually intersect the viewport. Exact, on every OS, also under an
///   ancestor Hypen scroller.
/// - **Scroll geometry** (``scrolled(offset:extent:)`` — or the list's
///   leading edge from ``listFrame(leading:viewportExtent:)`` — and
///   `onScrollGeometryChange` on iOS 18 / macOS 15): the visible extent
///   mapped through the item size, the reference `visibleRange` math. Used
///   when no slot is on screen (the list is scrolled out of view).
/// - **Slot appearance** (``slotAppeared(_:)`` / ``slotDisappeared(_:)``,
///   SwiftUI `onAppear` / `onDisappear`): when no geometry is known (an
///   ancestor scroller that is not Hypen's). Lazy stacks prefetch beyond the
///   screen, so this range runs a few slots wide.
///
/// It also remembers the first visible slot's position in the list's
/// content, so a layout change above it (a window move, a new placeholder
/// size) can be undone by ``anchorCorrection()`` (§2 scroll anchoring).
public final class VirtViewportTracker: @unchecked Sendable {
    /// Appearance count per slot index. A count, not a set: when a slot's
    /// identity changes (placeholder → row) SwiftUI may deliver the new
    /// view's `onAppear` before the old one's `onDisappear`.
    private var appeared: [Int: Int] = [:]
    private var measured: [Int: Double] = [:]
    /// The scroll container's visible extent along the axis, in content
    /// coordinates (`offset` = how far it has scrolled past the first slot).
    private var scroll: (offset: Double, extent: Double)?
    /// Live slots' frames in viewport coordinates, keyed by slot id.
    private var frames: [String: VirtSlotFrame] = [:]
    /// The list's leading edge and the viewport's extent, in the same
    /// viewport coordinates as `frames`.
    private var list: (leading: Double, extent: Double)?
    /// The first visible slot at the last ``anchorCorrection()``, and its
    /// leading edge relative to the list's leading edge.
    private var anchor: (id: String, index: Int, offsetInList: Double)?
    public private(set) var lastReported: ItemRange?
    /// The last `__virt.window` seen by ``observe(_:)``.
    public private(set) var lastWindow: VirtWindow?
    /// Set while an evaluation is queued for the next main-actor turn, so a
    /// burst of appear/disappear callbacks during one scroll frame is
    /// evaluated once (§3: at most once per frame).
    public var evaluationScheduled = false

    public init() {}

    /// Note the list's current `__virt.window`. A change in value forgets
    /// `lastReported` (§3 step 4, ``Virtualization/windowChanged(_:_:)``);
    /// an identical re-send keeps it. Returns whether it changed.
    @discardableResult
    public func observe(_ window: VirtWindow) -> Bool {
        guard Virtualization.windowChanged(lastWindow, window) else { return false }
        lastWindow = window
        lastReported = nil
        return true
    }

    public func slotAppeared(_ index: Int) {
        appeared[index, default: 0] += 1
    }

    public func slotDisappeared(_ index: Int) {
        guard let n = appeared[index] else { return }
        if n <= 1 { appeared.removeValue(forKey: index) } else { appeared[index] = n - 1 }
    }

    /// Record the scroll container's visible extent (content coordinates
    /// along the scroll axis). A non-positive extent (not laid out yet) is
    /// ignored, leaving the appearance-based range in charge.
    public func scrolled(offset: Double, extent: Double) {
        guard extent > 0, extent.isFinite, offset.isFinite else { return }
        scroll = (offset, extent)
    }

    /// Record where the list's leading edge is in its scroll container's
    /// viewport (negative once scrolled past it) and the viewport's extent.
    /// Also the scroll geometry: `scrolledPast = -leading`.
    public func listFrame(leading: Double, viewportExtent: Double) {
        guard viewportExtent > 0, viewportExtent.isFinite, leading.isFinite else { return }
        list = (leading, viewportExtent)
        scrolled(offset: -leading, extent: viewportExtent)
    }

    /// Record a live slot's frame (viewport coordinates along the axis).
    public func slotFrame(id: String, index: Int, min: Double, max: Double) {
        guard min.isFinite, max.isFinite, max >= min else { return }
        frames[id] = VirtSlotFrame(index: index, min: min, max: max)
    }

    /// Forget a slot's frame (it left the lazy container).
    public func slotFrameRemoved(id: String) {
        frames.removeValue(forKey: id)
    }

    /// Record a materialized item's extent along the scroll axis.
    public func recordSize(_ index: Int, extent: Double) {
        guard extent > 0, extent.isFinite else { return }
        measured[index] = extent
    }

    /// The items on screen, clamped to `total`; nil when nothing is. From the
    /// slot frames that intersect the viewport when any do; else from the
    /// scroll geometry (rows are `itemSize + spacing` apart); else from the
    /// appeared slots `[min, max + 1)`.
    public func visibleRange(_ window: VirtWindow, spacing: Double = 0, columns: Int = 1) -> ItemRange? {
        if let list {
            let onScreen = frames.values.filter {
                $0.index >= 0 && $0.index < window.total && $0.max > 0 && $0.min < list.extent
            }.map(\.index)
            if let lo = onScreen.min(), let hi = onScreen.max() {
                return ItemRange(start: lo, end: hi + 1)
            }
        }
        if let g = geometry(window, spacing: spacing, columns: columns) {
            return Virtualization.visibleRange(
                total: window.total,
                size: g.size,
                scrolledPast: g.scrolledPast,
                viewportExtent: g.viewportExtent + min(0, g.scrolledPast),
                columns: columns
            )
        }
        let indices = appeared.keys.filter { $0 >= 0 && $0 < window.total }
        guard let lo = indices.min(), let hi = indices.max() else { return nil }
        return ItemRange(start: lo, end: hi + 1)
    }

    /// The per-item size for placeholders: the average measured extent of
    /// the window's items, else the estimate, else the default. Measurements
    /// of items that left the window are dropped.
    public func itemSize(_ window: VirtWindow) -> Double {
        measured = measured.filter { $0.key >= window.start && $0.key < window.end }
        let sum = measured.values.reduce(0, +)
        return Virtualization.itemSize(window, measuredTotal: sum, measuredCount: measured.count)
    }

    /// The range to report now, or nil. Observes `window` first (a changed
    /// window forgets the last report), and records the report so the same
    /// range is never sent twice in a row for one window.
    public func evaluate(_ window: VirtWindow, spacing: Double = 0, columns: Int = 1) -> ItemRange? {
        observe(window)
        guard let visible = visibleRange(window, spacing: spacing, columns: columns) else { return nil }
        let wanted = Virtualization.wantedRange(visible, total: window.total)
        guard Virtualization.shouldReport(window, visible: visible, wanted: wanted, lastReported: lastReported) else {
            return nil
        }
        lastReported = wanted
        return wanted
    }

    /// §2 scroll anchoring, for a scroll view that keeps its content offset
    /// when content above the viewport changes size (SwiftUI before
    /// `scrollPosition(id:)`). Compares the slot that was first visible at
    /// the previous call — found again by id, else by item index (a
    /// placeholder that became a row) — with where it sits in the list now.
    /// If it moved within the list (rows above it changed size), returns the
    /// `scrollTo` that puts it back at its expected on-screen position; a
    /// plain scroll moves the list and the slot together and corrects
    /// nothing. Then remembers the current first visible slot.
    public func anchorCorrection() -> VirtAnchorCorrection? {
        guard let list else { anchor = nil; return nil }
        let first = frames
            .filter { $0.value.max > 0 && $0.value.min < list.extent }
            .min { ($0.value.index, $0.key) < ($1.value.index, $1.key) }
        defer {
            anchor = first.map { (id: $0.key, index: $0.value.index, offsetInList: $0.value.min - list.leading) }
        }
        guard let previous = anchor else { return nil }
        let match: (id: String, frame: VirtSlotFrame)?
        if let frame = frames[previous.id] {
            match = (previous.id, frame)
        } else {
            match = frames
                .filter { $0.value.index == previous.index }
                .min { $0.key < $1.key }
                .map { (id: $0.key, frame: $0.value) }
        }
        guard let match else { return nil }
        let shift = (match.frame.min - list.leading) - previous.offsetInList
        guard abs(shift) >= 0.5 else { return nil }
        guard let unit = Virtualization.anchorUnitPoint(
            rowOffset: match.frame.min - shift,
            rowExtent: match.frame.max - match.frame.min,
            viewportExtent: list.extent
        ) else { return nil }
        return VirtAnchorCorrection(slotId: match.id, unitPoint: unit)
    }

    private func geometry(_ window: VirtWindow, spacing: Double, columns: Int) -> ViewportGeometry? {
        guard let scroll else { return nil }
        return ViewportGeometry(
            size: itemSize(window) + max(0, spacing),
            scrolledPast: scroll.offset,
            viewportExtent: scroll.extent,
            columns: columns
        )
    }
}
