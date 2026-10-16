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

    /// Localization keys of the list accessibility strings (the package's
    /// `Resources/<lang>.lproj/Localizable.strings`). Every format uses only
    /// object specifiers — `%@`, or positional `%1$@` / `%2$@` so a language
    /// may name the total first — and receives numbers already formatted for
    /// the locale (``formatCount(_:locale:)``).
    public enum A11yKey {
        /// "Row %1$@ of %2$@": position, total.
        public static let rowPosition = "hypen.a11y.list.rowPosition"
        /// "Item %1$@ of %2$@" (a grid): position, total.
        public static let itemPosition = "hypen.a11y.list.itemPosition"
        /// "%@ row" / "%@ rows": the list's total.
        public static let rowsOne = "hypen.a11y.list.rows.one"
        public static let rowsOther = "hypen.a11y.list.rows.other"
        /// "%@ item" / "%@ items": a grid's total.
        public static let itemsOne = "hypen.a11y.list.items.one"
        public static let itemsOther = "hypen.a11y.list.items.other"

        public static let all = [rowPosition, itemPosition, rowsOne, rowsOther, itemsOne, itemsOther]

        /// The English text, used when a lookup has no (valid) translation.
        public static func english(_ key: String) -> String {
            switch key {
            case rowPosition: return "Row %1$@ of %2$@"
            case itemPosition: return "Item %1$@ of %2$@"
            case rowsOne: return "%@ row"
            case rowsOther: return "%@ rows"
            case itemsOne: return "%@ item"
            case itemsOther: return "%@ items"
            default: return key
            }
        }

        /// Arguments the key's format receives.
        public static func argumentCount(_ key: String) -> Int {
            key == rowPosition || key == itemPosition ? 2 : 1
        }
    }

    /// What a materialized row says about its place in the whole list, the
    /// SwiftUI stand-in for `aria-posinset` / `aria-setsize` and Android's
    /// `CollectionItemInfo` (SwiftUI has no set-position API for arbitrary
    /// views): "Row 41 of 10,000", or "Item 41 of 10,000" in a grid.
    ///
    /// - Parameters:
    ///   - locale: formats the numbers (grouping, digits)
    ///   - localize: the translated format for an ``A11yKey`` (nil = none);
    ///     a missing or malformed translation falls back to English
    public static func accessibilityPosition(
        index: Int,
        total: Int,
        columns: Int = 1,
        locale: Locale = .current,
        localize: (String) -> String? = { _ in nil }
    ) -> String {
        let key = columns > 1 ? A11yKey.itemPosition : A11yKey.rowPosition
        return localizedFormat(key, localize: localize, arguments: [
            formatCount(max(0, index) + 1, locale: locale),
            formatCount(total, locale: locale),
        ])
    }

    /// The list container's size, for its accessibility value:
    /// "10,000 rows", "1 row", "30 items". Plural choice is one (exactly 1)
    /// vs other; a host needing a language's full plural rules overrides
    /// ``HypenAccessibility/listSummary``.
    public static func accessibilitySummary(
        total: Int,
        columns: Int = 1,
        locale: Locale = .current,
        localize: (String) -> String? = { _ in nil }
    ) -> String {
        let n = max(0, total)
        let key = columns > 1
            ? (n == 1 ? A11yKey.itemsOne : A11yKey.itemsOther)
            : (n == 1 ? A11yKey.rowsOne : A11yKey.rowsOther)
        return localizedFormat(key, localize: localize, arguments: [formatCount(n, locale: locale)])
    }

    /// A non-negative count with the locale's digits and grouping
    /// ("10,000", "10.000").
    public static func formatCount(_ n: Int, locale: Locale) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        let value = max(0, n)
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    /// The number of distinct object arguments `format` consumes, or nil
    /// when it contains anything but `%@`, `%n$@` and `%%` (or mixes
    /// positional and sequential specifiers). Translations are checked with
    /// this before use, so a bad one can never crash formatting.
    public static func objectArgumentCount(_ format: String) -> Int? {
        guard let tokens = formatTokens(format) else { return nil }
        var positional = Set<Int>()
        var sequential = 0
        for case let .argument(position) in tokens {
            if let position { positional.insert(position) } else { sequential += 1 }
        }
        if !positional.isEmpty && sequential > 0 { return nil }
        if positional.isEmpty { return sequential }
        // Positions must be exactly 1...n.
        return positional == Set(1...positional.count) ? positional.count : nil
    }

    /// `localize(key)` filled with `arguments`, or the English format when
    /// the translation is missing or takes different arguments.
    static func localizedFormat(_ key: String, localize: (String) -> String?, arguments: [String]) -> String {
        if let format = localize(key), objectArgumentCount(format) == arguments.count {
            return substitute(format, arguments)
        }
        return substitute(A11yKey.english(key), arguments)
    }

    private enum FormatToken {
        case text(String)
        case argument(Int?)
    }

    private static func formatTokens(_ format: String) -> [FormatToken]? {
        var tokens: [FormatToken] = []
        var text = ""
        var chars = Array(format)[...]
        while let c = chars.popFirst() {
            guard c == "%" else { text.append(c); continue }
            if chars.first == "%" { chars.removeFirst(); text.append("%"); continue }
            var digits = ""
            while let d = chars.first, d.isASCII, d.isNumber { digits.append(d); chars.removeFirst() }
            var position: Int?
            if !digits.isEmpty {
                guard chars.first == "$", let n = Int(digits), n > 0 else { return nil }
                chars.removeFirst()
                position = n
            }
            guard chars.first == "@" else { return nil }
            chars.removeFirst()
            if !text.isEmpty { tokens.append(.text(text)); text = "" }
            tokens.append(.argument(position))
        }
        if !text.isEmpty { tokens.append(.text(text)) }
        return tokens
    }

    /// Fill a format validated by ``objectArgumentCount(_:)``. Done by hand
    /// rather than `String(format:)` so it behaves identically on every
    /// platform and never reads a missing vararg.
    private static func substitute(_ format: String, _ arguments: [String]) -> String {
        guard let tokens = formatTokens(format) else { return format }
        var next = 0
        var out = ""
        for token in tokens {
            switch token {
            case let .text(t): out += t
            case let .argument(position):
                let i = position.map { $0 - 1 } ?? next
                next += 1
                if i >= 0 && i < arguments.count { out += arguments[i] }
            }
        }
        return out
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

        /// The slot's identity in a lazy container's `ForEach` and for
        /// `scrollPosition(id:)`: its whole-list item index
        /// (``Virtualization/slotId(_:)``). Unique among the `total` slots and
        /// unchanged when the engine materializes the item, which is exactly
        /// when scroll anchoring needs the anchored slot to keep its id. An
        /// insert or removal above shifts which item an index holds;
        /// ``VirtViewportTracker/anchorCorrection(_:mode:)`` follows the
        /// anchored item's node to its new index.
        public var id: String { Virtualization.slotId(index) }

        /// The slot's id among several lists sharing one scroll view
        /// (``Virtualization/slotId(_:scope:)``).
        public func id(scope: String) -> String { Virtualization.slotId(index, scope: scope) }

        /// Identity of what the slot shows, for keying its content inside the
        /// stably identified slot (so per-row view state follows the node, not
        /// the index): the first child's node id for a materialized row, the
        /// item index for a placeholder.
        public var contentId: String {
            if let nodeId { return "n:\(nodeId)" }
            return "p:\(index)"
        }

        /// The first child's node id of a materialized row; nil for a
        /// placeholder.
        public var nodeId: String? {
            if case let .item(_, childIds) = self { return childIds.first }
            return nil
        }
    }

    /// The slot id of whole-list item `index` (``Slot/id``). With a `scope`
    /// (the list's element id) it is unique within an OUTER scroll view that
    /// holds several lists, so the outer `ScrollViewProxy.scrollTo` finds
    /// exactly this list's slot: `"<scope>/i:<index>"`.
    public static func slotId(_ index: Int, scope: String = "") -> String {
        scope.isEmpty ? "i:\(index)" : "\(scope)/i:\(index)"
    }

    /// Map the list element's children onto `total` slots. Slot `i` is
    /// `.item` when `start ≤ i < end` and its children exist, else
    /// `.placeholder`. Children are grouped per item (``childrenPerItem(_:childCount:)``);
    /// a short child list (a batch still settling) leaves the uncovered items
    /// as placeholders rather than throwing.
    ///
    /// `scope` (the list's element id) prefixes the slot ids
    /// (``Slots/slotId(_:)``, ``Slots/identified``).
    public static func slots(_ window: VirtWindow, childIds: [String], scope: String = "") -> Slots {
        Slots(window: window, childIds: childIds, scope: scope)
    }

    /// The `total` slots of a windowed list, resolved on demand: O(1) to
    /// build, so a 10,000-item list never allocates 10,000 slot values per
    /// render (Android's `VirtSlots` is the same shape).
    public struct Slots: RandomAccessCollection, Sendable {
        public let window: VirtWindow
        public let childIds: [String]
        public let childrenPerItem: Int
        /// Prefix of the slot ids (the list's element id; "" = none).
        public let scope: String

        public init(window: VirtWindow, childIds: [String], scope: String = "") {
            self.window = window
            self.childIds = childIds
            self.childrenPerItem = Virtualization.childrenPerItem(window, childCount: childIds.count)
            self.scope = scope
        }

        /// The scoped id of slot `index`: what the lazy container's `ForEach`
        /// identifies it by, and what `scrollTo` / `scrollPosition(id:)` name.
        public func slotId(_ index: Int) -> String { Virtualization.slotId(index, scope: scope) }

        /// The slots paired with their scoped ids, for `ForEach(…, id: \.id)`.
        public var identified: IdentifiedSlots { IdentifiedSlots(slots: self) }

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

        /// The whole-list index of the item whose first child is `nodeId`,
        /// or nil when no materialized item starts with it. O(window).
        public func itemIndex(ofNode nodeId: String) -> Int? {
            guard let k = childIds.firstIndex(of: nodeId), k % childrenPerItem == 0 else { return nil }
            let index = window.start + k / childrenPerItem
            return index < window.end ? index : nil
        }
    }

    /// A slot with its scoped id.
    public struct IdentifiedSlot: Equatable, Sendable {
        public let id: String
        public let slot: Slot
    }

    /// ``Slots`` paired with their scoped ids, resolved on demand.
    public struct IdentifiedSlots: RandomAccessCollection, Sendable {
        public let slots: Slots
        public var startIndex: Int { slots.startIndex }
        public var endIndex: Int { slots.endIndex }
        public subscript(index: Int) -> IdentifiedSlot {
            IdentifiedSlot(id: slots.slotId(index), slot: slots[index])
        }
    }

    // MARK: - Visible range from slot frames (§3 step 2)

    /// The items whose slot frames intersect the viewport `(viewportMin,
    /// viewportMax)` (open: a frame only touching an edge is not visible),
    /// clamped to `[0, total)`; nil when none do. Frames and viewport share
    /// one coordinate space along the scroll axis: the Hypen scroller's named
    /// space, or `.global` against the screen.
    public static func visibleSlotRange<Frames: Sequence>(
        _ frames: Frames,
        viewportMin: Double,
        viewportMax: Double,
        total: Int
    ) -> ItemRange? where Frames.Element == VirtSlotFrame {
        guard viewportMax > viewportMin else { return nil }
        var lo = Int.max
        var hi = Int.min
        for frame in frames where frame.index >= 0 && frame.index < total
            && frame.max > viewportMin && frame.min < viewportMax {
            lo = Swift.min(lo, frame.index)
            hi = Swift.max(hi, frame.index)
        }
        return lo <= hi ? ItemRange(start: lo, end: hi + 1) : nil
    }

    // MARK: - Scroll anchoring: which row (§2)

    /// The slot to anchor on: the first visible MATERIALIZED row (one with a
    /// node, so an insert or removal above can be followed by identity),
    /// else the first visible placeholder; nil when nothing is visible.
    /// "Visible" = the frame intersects `(0, viewportExtent)`.
    public static func anchorCandidate<Frames: Sequence>(
        _ frames: Frames,
        slots: Slots,
        viewportExtent: Double
    ) -> VirtSlotFrame? where Frames.Element == VirtSlotFrame {
        guard viewportExtent > 0 else { return nil }
        var firstRow: VirtSlotFrame?
        var firstAny: VirtSlotFrame?
        for frame in frames where frame.max > 0 && frame.min < viewportExtent {
            if firstAny.map({ frame.index < $0.index }) ?? true { firstAny = frame }
            let materialized = frame.index >= 0 && frame.index < slots.endIndex && slots[frame.index].nodeId != nil
            if materialized, firstRow.map({ frame.index < $0.index }) ?? true { firstRow = frame }
        }
        return firstRow ?? firstAny
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

/// Who keeps the scroll position when content above the viewport changes,
/// for ``VirtViewportTracker/anchorCorrection(_:mode:)``.
public enum VirtAnchorMode: Equatable, Sendable {
    /// The scroll view keeps its content offset (SwiftUI before
    /// `scrollPosition(id:)`): every shift of the first visible item within
    /// the list needs correcting.
    case contentOffset
    /// `scrollPosition(id:)` keeps the anchored slot (an item index) in place
    /// (iOS 17 / macOS 14): only a change of which index holds the anchored
    /// item (an insert or removal above it) needs correcting.
    case slotPosition
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
/// Sources of the visible range, best first:
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
/// - **Scroll visibility** (``slotVisibility(id:index:visible:)``, SwiftUI
///   `onScrollVisibilityChange` on iOS 18 / macOS 15): the slots the
///   enclosing scroll view — any scroll view, a host app's own included —
///   reports visible. Used when no Hypen scroller is known.
/// - **Global frames** (``slotGlobalFrame(id:index:min:max:)`` with
///   ``globalViewport(min:max:)``, before iOS 18): each slot's `.global`
///   frame intersected with the screen. Exact when the host's scroll view
///   spans the screen along the axis, a little wide when it is shorter.
/// - **Slot appearance** (``slotAppeared(_:)`` / ``slotDisappeared(_:)``,
///   SwiftUI `onAppear` / `onDisappear`): when nothing above is known. Lazy
///   stacks prefetch beyond the screen, so this range runs a few slots wide.
///
/// It also remembers the anchor — the first visible materialized row, else
/// the first visible slot (``Virtualization/anchorCandidate(_:slots:viewportExtent:)``)
/// — and its position in the list's content, so a layout change above it (a window move, a new placeholder
/// size, an insert above) can be undone by ``anchorCorrection(_:mode:)``
/// (§2 scroll anchoring).
public final class VirtViewportTracker: @unchecked Sendable {
    /// Appearance count per slot index. A count, not a set: should SwiftUI
    /// recreate a slot it may deliver the new view's `onAppear` before the
    /// old one's `onDisappear`.
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
    /// Slots the enclosing scroll view reports visible (id → index).
    private var scrollVisible: [String: Int] = [:]
    /// Live slots' `.global` frames, keyed by slot id.
    private var globalFrames: [String: VirtSlotFrame] = [:]
    /// The screen's extent along the axis in `.global` coordinates.
    private var globalClip: (min: Double, max: Double)?
    /// The anchor at the last ``anchorCorrection(_:mode:)``: its
    /// item index, the node it showed (nil for a placeholder), and its
    /// leading edge relative to the list's leading edge.
    private var anchor: (index: Int, nodeId: String?, offsetInList: Double)?
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

    /// Forget everything about a slot's position (it left the lazy
    /// container): its frames and its scroll visibility.
    public func slotFrameRemoved(id: String) {
        frames.removeValue(forKey: id)
        globalFrames.removeValue(forKey: id)
        scrollVisible.removeValue(forKey: id)
    }

    /// Record whether the enclosing scroll view shows a slot (iOS 18
    /// `onScrollVisibilityChange`).
    public func slotVisibility(id: String, index: Int, visible: Bool) {
        if visible { scrollVisible[id] = index } else { scrollVisible.removeValue(forKey: id) }
    }

    /// Record a live slot's `.global` frame along the axis.
    public func slotGlobalFrame(id: String, index: Int, min: Double, max: Double) {
        guard min.isFinite, max.isFinite, max >= min else { return }
        globalFrames[id] = VirtSlotFrame(index: index, min: min, max: max)
    }

    /// Record the screen's extent along the axis in `.global` coordinates,
    /// the clip for ``slotGlobalFrame(id:index:min:max:)``. An empty or
    /// non-finite extent is ignored.
    public func globalViewport(min: Double, max: Double) {
        guard min.isFinite, max.isFinite, max > min else { return }
        globalClip = (min, max)
    }

    /// Record a materialized item's extent along the scroll axis.
    public func recordSize(_ index: Int, extent: Double) {
        guard extent > 0, extent.isFinite else { return }
        measured[index] = extent
    }

    /// The items on screen, clamped to `total`; nil when nothing is. From the
    /// slot frames that intersect the Hypen scroller's viewport when any do;
    /// else from its scroll geometry (rows are `itemSize + spacing` apart);
    /// else from the slots the enclosing scroll view reports visible; else
    /// from the slots' global frames on screen; else from the appeared slots
    /// `[min, max + 1)`.
    public func visibleRange(_ window: VirtWindow, spacing: Double = 0, columns: Int = 1) -> ItemRange? {
        if let list, let range = Virtualization.visibleSlotRange(
            frames.values, viewportMin: 0, viewportMax: list.extent, total: window.total
        ) {
            return range
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
        let reported = scrollVisible.values.filter { $0 >= 0 && $0 < window.total }
        if let lo = reported.min(), let hi = reported.max() {
            return ItemRange(start: lo, end: hi + 1)
        }
        if let clip = globalClip, let range = Virtualization.visibleSlotRange(
            globalFrames.values, viewportMin: clip.min, viewportMax: clip.max, total: window.total
        ) {
            return range
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

    /// §2 scroll anchoring. Compares the anchor of the previous call with
    /// where it sits now and returns the `scrollTo` that puts it back, or nil;
    /// then remembers the current anchor: the first visible materialized row,
    /// else the first visible slot
    /// (``Virtualization/anchorCandidate(_:slots:viewportExtent:)``), so an
    /// insert or removal above is followed by the row's node even while a
    /// placeholder is the first thing on screen.
    ///
    /// The item is found again by the node it showed (`slots`: an insert or
    /// removal above moved it to another index), else by its index (a
    /// placeholder, or a placeholder that became a row: slot ids are item
    /// indices, so the slot keeps its id). Where it belongs depends on `mode`:
    /// - ``VirtAnchorMode/contentOffset``: at the same offset within the
    ///   list as before (a plain scroll moves the list and the item together
    ///   and corrects nothing), so any layout change above it is undone.
    /// - ``VirtAnchorMode/slotPosition``: `scrollPosition(id:)` already kept
    ///   the anchored index in place, so only a moved item is corrected, back
    ///   to where its old index is now.
    public func anchorCorrection(_ slots: Virtualization.Slots, mode: VirtAnchorMode) -> VirtAnchorCorrection? {
        guard let list else { anchor = nil; return nil }
        let first = Virtualization.anchorCandidate(frames.values, slots: slots, viewportExtent: list.extent)
        defer {
            anchor = first.map {
                (
                    index: $0.index,
                    nodeId: $0.index < slots.endIndex ? slots[$0.index].nodeId : nil,
                    offsetInList: $0.min - list.leading
                )
            }
        }
        guard let previous = anchor else { return nil }
        let index = previous.nodeId.flatMap { slots.itemIndex(ofNode: $0) } ?? previous.index
        guard let frame = liveFrame(at: index, slots) else { return nil }
        let target: Double
        switch mode {
        case .contentOffset:
            target = list.leading + previous.offsetInList
        case .slotPosition:
            guard index != previous.index, let held = liveFrame(at: previous.index, slots) else { return nil }
            target = held.min
        }
        guard abs(frame.min - target) >= 0.5 else { return nil }
        guard let unit = Virtualization.anchorUnitPoint(
            rowOffset: target,
            rowExtent: frame.max - frame.min,
            viewportExtent: list.extent
        ) else { return nil }
        return VirtAnchorCorrection(slotId: slots.slotId(index), unitPoint: unit)
    }

    /// The live frame of item `index`'s slot.
    private func liveFrame(at index: Int, _ slots: Virtualization.Slots) -> VirtSlotFrame? {
        frames[slots.slotId(index)] ?? frames.values.first { $0.index == index }
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
