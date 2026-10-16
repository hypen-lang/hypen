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
        let rowsInWindow = ceilDiv(window.end, cols) - window.start / cols
        let rowsAfter = max(0, rowsTotal - rowsBefore - rowsInWindow)
        return (Double(rowsBefore) * size, Double(rowsAfter) * size)
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

    /// Children per item for a multi-node template:
    /// `childCount / (end - start)`, at least 1 when any item is in the window.
    public static func childrenPerItem(_ window: VirtWindow, childCount: Int) -> Int {
        let items = window.count
        guard items > 0 else { return 0 }
        return max(1, childCount / items)
    }

    /// Map the list element's children onto `total` slots. Slot `i` is
    /// `.item` when `start ≤ i < end` and its children exist, else
    /// `.placeholder`. Children are grouped per item; a short or ragged
    /// child list (a batch still settling) leaves the uncovered items as
    /// placeholders rather than misattributing children.
    public static func slots(_ window: VirtWindow, childIds: [String]) -> [Slot] {
        let per = childrenPerItem(window, childCount: childIds.count)
        var result: [Slot] = []
        result.reserveCapacity(window.total)
        for index in 0..<window.total {
            if index >= window.start && index < window.end && per > 0 {
                let lo = (index - window.start) * per
                let hi = lo + per
                if hi <= childIds.count {
                    result.append(.item(index: index, childIds: Array(childIds[lo..<hi])))
                    continue
                }
            }
            result.append(.placeholder(index: index))
        }
        return result
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

/// Visibility bookkeeping for one windowed native lazy container (§5):
/// slots report `appeared` / `disappeared` (SwiftUI `onAppear` /
/// `onDisappear`), materialized rows report their measured extent, and
/// ``evaluate(_:)`` turns that into the range to report, applying the §3
/// overscan and reporting rules. Pure — the SwiftUI view owns one and calls
/// the engine with what `evaluate` returns.
public final class VirtViewportTracker: @unchecked Sendable {
    /// Appearance count per slot index. A count, not a set: when a slot's
    /// identity changes (placeholder → row) SwiftUI may deliver the new
    /// view's `onAppear` before the old one's `onDisappear`.
    private var appeared: [Int: Int] = [:]
    private var measured: [Int: Double] = [:]
    public private(set) var lastReported: ItemRange?
    /// Set while an evaluation is queued for the next main-actor turn, so a
    /// burst of appear/disappear callbacks during one scroll frame is
    /// evaluated once (§3: at most once per frame).
    public var evaluationScheduled = false

    public init() {}

    public func slotAppeared(_ index: Int) {
        appeared[index, default: 0] += 1
    }

    public func slotDisappeared(_ index: Int) {
        guard let n = appeared[index] else { return }
        if n <= 1 { appeared.removeValue(forKey: index) } else { appeared[index] = n - 1 }
    }

    /// Record a materialized item's extent along the scroll axis.
    public func recordSize(_ index: Int, extent: Double) {
        guard extent > 0, extent.isFinite else { return }
        measured[index] = extent
    }

    /// The visible slots `[min, max + 1)`, clamped to `total`; nil when
    /// nothing is on screen.
    public func visibleRange(total: Int) -> ItemRange? {
        let indices = appeared.keys.filter { $0 >= 0 && $0 < total }
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

    /// The range to report now, or nil. Records the report so the same
    /// range is never sent twice in a row.
    public func evaluate(_ window: VirtWindow) -> ItemRange? {
        guard let visible = visibleRange(total: window.total) else { return nil }
        let wanted = Virtualization.wantedRange(visible, total: window.total)
        guard Virtualization.shouldReport(window, visible: visible, wanted: wanted, lastReported: lastReported) else {
            return nil
        }
        lastReported = wanted
        return wanted
    }
}
