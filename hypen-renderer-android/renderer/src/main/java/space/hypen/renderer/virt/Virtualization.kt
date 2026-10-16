package space.hypen.renderer.virt

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * List virtualization: the renderer side of the `__virt.window` contract
 * (hypen-web/docs/virtualization.md). A plain-Kotlin port of
 * `@hypen-space/core/virtualization` (hypen-web/packages/core/src/
 * virtualization.ts); `VirtualizationMathTest` mirrors
 * hypen-web/tests/virtualization-math.test.ts and must stay aligned with it.
 *
 * Sizes are in the renderer's unit along the scroll axis (dp on Compose, or
 * px when both sides of a computation are px). Items are counted in ITEMS,
 * not children: a multi-node template renders several children per item.
 */

/** Reserved prop the engine sets on a windowed list's element. */
const val VIRT_WINDOW_PROP = "__virt.window"

/** Size used for unmeasured items when nothing better is known. */
const val DEFAULT_ITEM_SIZE = 48.0

/** Minimum overscan, in items, on each side of the visible range. */
const val MIN_OVERSCAN_ITEMS = 5

/**
 * Longest padded list (dp) the padded path lays out: 2^18 px (Compose's
 * single-axis `Constraints` limit) at density 4, with headroom.
 */
const val MAX_PADDED_EXTENT_DP = 60_000.0

/** The decoded `__virt.window` value: children are items `[start, end)`. */
data class VirtWindow(
    val total: Int,
    val start: Int,
    val end: Int,
    val estimatedSize: Double? = null,
) {
    /** Items materialized as children. */
    val count: Int get() = end - start
}

/** An item range `[start, end)`. */
data class ItemRange(val start: Int, val end: Int)

/**
 * One slot a lazy container laid out, along its scroll axis (px): what
 * Compose's `LazyListItemInfo` / `LazyGridItemInfo` say about it.
 */
data class LaidOutSlot(val index: Int, val offset: Int, val size: Int, val materialized: Boolean)

/**
 * Where a list sits in its scroll container, for [Virtualization.viewportReport].
 * [size] is one item's extent (one row's for a grid); [scrolledPast] is how far
 * the container has scrolled past the list's leading edge, negative while the
 * list starts below the top of the viewport.
 */
data class ViewportGeometry(
    val size: Double,
    val scrolledPast: Double,
    val viewportExtent: Double,
    val columns: Int = 1,
)

/** One padded layout: the window and the per-row padding size ([Virtualization.paddedItemSize]). */
data class PaddedLayout(val window: VirtWindow, val padSize: Double)

/** One item's whole-list cell, for accessibility's `CollectionItemInfo`. */
data class ItemPosition(val rowIndex: Int, val columnIndex: Int)

/** Rows and columns of a whole windowed list, for accessibility's `CollectionInfo`. */
data class CollectionShape(val rowCount: Int, val columnCount: Int)

/** Leading/trailing stand-in extent for the items outside the window. */
data class WindowPadding(val leading: Double, val trailing: Double)

object Virtualization {
    /**
     * A non-negative integer count. JSON numbers arrive from Moshi as
     * `Double`; a fractional or negative value is malformed.
     */
    private fun count(v: Any?): Int? {
        val d = when (v) {
            is Int -> return if (v >= 0) v else null
            is Long -> return if (v in 0..Int.MAX_VALUE) v.toInt() else null
            is Number -> v.toDouble()
            else -> return null
        }
        if (d.isNaN() || d < 0 || d != floor(d) || d > Int.MAX_VALUE) return null
        return d.toInt()
    }

    /** Decode a `__virt.window` prop value; `null` for anything malformed. */
    fun parseVirtWindow(value: Any?): VirtWindow? {
        val v = value as? Map<*, *> ?: return null
        val total = count(v["total"]) ?: return null
        val start = count(v["start"]) ?: return null
        val end = count(v["end"]) ?: return null
        if (start > end || end > total) return null
        val est = (v["estimatedSize"] as? Number)?.toDouble()?.takeIf { it > 0 && !it.isNaN() }
        return VirtWindow(total, start, end, est)
    }

    /**
     * Size to assume per item: the average measured size of the materialized
     * items, else the template's estimate, else [DEFAULT_ITEM_SIZE].
     */
    fun itemSize(window: VirtWindow, measuredTotal: Double, measuredCount: Int): Double {
        if (measuredCount > 0 && measuredTotal > 0) return measuredTotal / measuredCount
        return window.estimatedSize ?: DEFAULT_ITEM_SIZE
    }

    /**
     * Padding standing in for the items before and after the window. For a
     * grid with `columns > 1`, items lay out in rows of `columns` and `size`
     * is a row's extent.
     */
    fun windowPadding(window: VirtWindow, size: Double, columns: Int = 1): WindowPadding {
        val cols = max(1, columns)
        val rowsBefore = ceilDiv(window.start, cols)
        val rowsTotal = ceilDiv(window.total, cols)
        val rowsAfter = max(0, rowsTotal - rowsBefore - windowRows(window, cols))
        return WindowPadding(rowsBefore * size, rowsAfter * size)
    }

    /**
     * Rows the materialized items occupy: `end - start` for a list; for a
     * grid with `columns > 1`, every row any of them touches. Divide the
     * measured extent of the children by this to get the row size for
     * [itemSize].
     */
    fun windowRows(window: VirtWindow, columns: Int = 1): Int {
        val cols = max(1, columns)
        return ceilDiv(window.end, cols) - window.start / cols
    }

    /**
     * Children per item (§1): a multi-node template renders several children
     * for each item. Never less than 1, so `start + childIndex / n` is always
     * the item a child belongs to.
     */
    fun childrenPerItem(window: VirtWindow, childCount: Int): Int {
        val items = window.end - window.start
        if (items <= 0 || childCount <= 0) return 1
        return max(1, Math.round(childCount.toDouble() / items).toInt())
    }

    /**
     * Items the user can see.
     *
     * @param scrolledPast how far the scroll container has scrolled past the
     *   list's leading edge (0 when it hasn't reached the list)
     * @param viewportExtent the scroll container's visible extent
     */
    fun visibleRange(
        total: Int,
        size: Double,
        scrolledPast: Double,
        viewportExtent: Double,
        columns: Int = 1,
    ): ItemRange {
        val cols = max(1, columns)
        val s = if (size > 0) size else DEFAULT_ITEM_SIZE
        val past = max(0.0, scrolledPast)
        val firstRow = floor(past / s)
        val lastRow = ceil((past + max(0.0, viewportExtent)) / s)
        return ItemRange(
            start = clamp(firstRow * cols, total),
            end = clamp(lastRow * cols, total),
        )
    }

    /**
     * The range to ask the engine for: the visible range widened on both
     * sides by one viewport's worth of items, at least [MIN_OVERSCAN_ITEMS].
     */
    fun wantedRange(visible: ItemRange, total: Int): ItemRange {
        val overscan = max(MIN_OVERSCAN_ITEMS, visible.end - visible.start)
        return ItemRange(
            start = (visible.start - overscan).coerceIn(0, max(0, total)),
            end = (visible.end + overscan).coerceIn(0, max(0, total)),
        )
    }

    /**
     * Whether to report `wanted` given the current window and the last
     * report. Report when the visible range is not covered by the window, or
     * the window is more than three times what is wanted (shrink after a
     * fling) — never the same range twice in a row.
     */
    fun shouldReport(
        window: VirtWindow,
        visible: ItemRange,
        wanted: ItemRange,
        lastReported: ItemRange?,
    ): Boolean {
        if (lastReported != null && lastReported == wanted) return false
        val covered = visible.start >= window.start && visible.end <= window.end
        val wantedSize = max(1, wanted.end - wanted.start)
        val oversized = window.end - window.start > 3 * wantedSize
        return !covered || oversized
    }

    /**
     * Whether a newly received `__virt.window` differs in value from the
     * previous one (`null` = none yet). §3 step 4: when it does, forget the
     * last report — the engine may have moved the window on its own (e.g.
     * `total` changed) to exactly the range last reported, and the renderer
     * must be able to ask for it again. An identical re-send is not a change.
     */
    fun windowChanged(previous: VirtWindow?, next: VirtWindow): Boolean = previous != next

    /**
     * §3 steps 2–4 in one call: the visible range, widened by overscan, if it
     * should be reported now — else `null`. The caller sends it and keeps it
     * as [lastReported] for the next call. While the list starts below the
     * top of the viewport (`scrolledPast < 0`) only the part of the viewport
     * over the list counts as visible.
     */
    fun viewportReport(window: VirtWindow, geometry: ViewportGeometry, lastReported: ItemRange?): ItemRange? {
        val extent = geometry.viewportExtent + min(0.0, geometry.scrolledPast)
        val visible = visibleRange(window.total, geometry.size, geometry.scrolledPast, extent, geometry.columns)
        val wanted = wantedRange(visible, window.total)
        return if (shouldReport(window, visible, wanted, lastReported)) wanted else null
    }

    /**
     * The slots a native lazy container actually shows: items whose extent
     * overlaps `[viewportStart, viewportEnd)` (Compose's `visibleItemsInfo`
     * may also carry beyond-bounds items). `null` when none do.
     */
    fun visibleSlots(items: List<LaidOutSlot>, viewportStart: Int, viewportEnd: Int, total: Int): ItemRange? {
        var lo = Int.MAX_VALUE
        var hi = Int.MIN_VALUE
        for (item in items) {
            if (item.offset + item.size <= viewportStart || item.offset >= viewportEnd) continue
            lo = min(lo, item.index)
            hi = max(hi, item.index + 1)
        }
        if (lo == Int.MAX_VALUE) return null
        return ItemRange(lo.coerceIn(0, total), hi.coerceIn(0, total))
    }

    /**
     * Summed extent and count of the laid-out MATERIALIZED slots, the
     * measurement [itemSize] averages. Placeholders are excluded: their size
     * is the estimate itself.
     */
    fun measured(items: List<LaidOutSlot>): Pair<Double, Int> {
        var total = 0.0
        var count = 0
        for (item in items) {
            if (!item.materialized || item.size <= 0) continue
            total += item.size
            count++
        }
        return total to count
    }

    /**
     * The per-row size the padded path stands in with: [size], shrunk so the
     * whole padded list (the padding plus the window's own rows at [size])
     * stays within [maxExtent]. Compose cannot measure a node beyond 2^18 px
     * along one axis (a `Constraints` limit), and a 10,000-row list at 48dp
     * is far past it. The same size must drive both the padding and the
     * visible-range geometry ([paddedVisibleRange]) so the two agree.
     */
    fun paddedItemSize(window: VirtWindow, size: Double, columns: Int = 1, maxExtent: Double = MAX_PADDED_EXTENT_DP): Double {
        val cols = max(1, columns)
        val rowsIn = windowRows(window, cols)
        val rowsOutside = ceilDiv(window.total, cols) - rowsIn
        if (rowsOutside <= 0) return size
        // Never starve the padding entirely: a window too tall to fit leaves
        // it half the budget, and `paddedVisibleRange` needs a positive size.
        val budget = max(maxExtent / 2, maxExtent - rowsIn * size)
        return min(size, budget / rowsOutside)
    }

    /**
     * [visibleRange] for the padded layout, where the rows outside the window
     * are [padSize] each (see [paddedItemSize]) and the materialized rows
     * [rowSize] each: offsets map piecewise through the leading padding, the
     * window, and the trailing padding. Equals [visibleRange] when the two
     * sizes agree.
     */
    fun paddedVisibleRange(
        window: VirtWindow,
        padSize: Double,
        rowSize: Double,
        scrolledPast: Double,
        viewportExtent: Double,
        columns: Int = 1,
    ): ItemRange {
        val cols = max(1, columns)
        val pad = if (padSize > 0) padSize else DEFAULT_ITEM_SIZE
        val row = if (rowSize > 0) rowSize else pad
        val rowsBefore = ceilDiv(window.start, cols)
        val rowsIn = windowRows(window, cols)
        val lead = rowsBefore * pad
        val mid = rowsIn * row
        fun rowAt(y: Double): Double = when {
            y < lead -> y / pad
            y < lead + mid -> rowsBefore + (y - lead) / row
            else -> rowsBefore + rowsIn + (y - lead - mid) / pad
        }
        val past = max(0.0, scrolledPast)
        val firstRow = floor(rowAt(past))
        val lastRow = ceil(rowAt(past + max(0.0, viewportExtent)))
        return ItemRange(clamp(firstRow * cols, window.total), clamp(lastRow * cols, window.total))
    }

    /**
     * Scroll anchoring on the padded path (§2/§3): how far (same unit as the
     * sizes) to scroll the ancestor scroller so the first visible
     * materialized row stays at the same on-screen position when the window
     * or the padding changes. The DOM renderer's anchor capture/restore, done
     * on the geometry instead of measured element rects.
     *
     * The anchor is the first row of the [before] window whose bottom edge is
     * below the viewport's top (`scrolledPast`, in list coordinates) and that
     * is actually on screen. Its offset in the list is the leading padding
     * plus the window rows above it; the result is that offset under [after]
     * minus the one under [before] — the padding delta minus the shift of the
     * row inside the window (rows above it removed or added). Rows inside the
     * window lay out at their real size, approximated by [rowSize] (the
     * measured average) on both sides: a size re-measure moves only the
     * padding. 0 when there is no visible materialized row or the anchor item
     * left the window (the content under the viewport was replaced; nothing
     * to hold still).
     *
     * @param before the window, padding size per row ([paddedItemSize]) before
     * @param after the same after the change
     * @param rowSize the real extent of a materialized row
     * @param scrolledPast how far the scroller has scrolled past the list's
     *   leading edge before the change (negative while it starts below it)
     * @param viewportExtent the scroller's visible extent
     */
    fun anchorDelta(
        before: PaddedLayout,
        after: PaddedLayout,
        rowSize: Double,
        scrolledPast: Double,
        viewportExtent: Double,
        columns: Int = 1,
    ): Double {
        val cols = max(1, columns)
        val row = if (rowSize > 0) rowSize else return 0.0
        val rowsIn = windowRows(before.window, cols)
        if (rowsIn <= 0 || before.window.count <= 0) return 0.0
        val lead = windowPadding(before.window, before.padSize, cols).leading
        // First window row whose bottom is below the viewport's top (row k
        // spans [lead + k*row, lead + (k+1)*row)).
        val k = max(0.0, floor((scrolledPast - lead) / row)).toInt()
        if (k >= rowsIn) return 0.0
        val rowTop = lead + k * row
        if (rowTop >= scrolledPast + max(0.0, viewportExtent)) return 0.0
        val anchor = before.window.start + k * cols
        if (anchor >= before.window.end) return 0.0
        if (anchor < after.window.start || anchor >= after.window.end) return 0.0
        val newLead = windowPadding(after.window, after.padSize, cols).leading
        val newRow = (anchor - after.window.start) / cols
        val oldRow = (anchor - before.window.start) / cols
        return (newLead - lead) + (newRow - oldRow) * row
    }

    /**
     * The whole-list collection shape a windowed container exposes to
     * accessibility (TalkBack's "item n of total"), matching the per-row
     * item info: a vertical list is `total` rows of 1 column, a horizontal
     * one 1 row of `total` columns, a grid `ceil(total / columns)` rows of
     * `columns`.
     */
    fun collectionShape(window: VirtWindow, horizontal: Boolean, columns: Int = 1): CollectionShape {
        val cols = max(1, columns)
        return when {
            horizontal -> CollectionShape(rowCount = 1, columnCount = window.total)
            cols > 1 -> CollectionShape(rowCount = ceilDiv(window.total, cols), columnCount = cols)
            else -> CollectionShape(rowCount = window.total, columnCount = 1)
        }
    }

    /**
     * Item [index]'s whole-list cell for accessibility's `CollectionItemInfo`,
     * matching [collectionShape]: row [index] of a vertical list, column
     * [index] of a horizontal one, `(index / columns, index % columns)` in a
     * grid.
     */
    fun itemPosition(index: Int, horizontal: Boolean, columns: Int = 1): ItemPosition {
        val cols = max(1, columns)
        return if (horizontal) ItemPosition(rowIndex = 0, columnIndex = index)
        else ItemPosition(rowIndex = index / cols, columnIndex = index % cols)
    }

    /**
     * The whole-list cell of every materialized child on the padded path,
     * keyed by child id: child `i` belongs to item `start + i / childrenPerItem`
     * (§1 grouping, as [VirtSlots] does on the lazy path). Children beyond
     * the window (a transient batch) get none.
     */
    fun <T> childPositions(
        window: VirtWindow,
        children: List<T>,
        horizontal: Boolean,
        columns: Int = 1,
        idOf: (T) -> String,
    ): Map<String, ItemPosition> {
        val per = childrenPerItem(window, children.size)
        val out = HashMap<String, ItemPosition>(children.size * 2)
        children.forEachIndexed { i, child ->
            val index = window.start + i / per
            if (index < window.end) out[idOf(child)] = itemPosition(index, horizontal, columns)
        }
        return out
    }

    private fun ceilDiv(a: Int, b: Int): Int = (a + b - 1) / b

    private fun clamp(n: Double, total: Int): Int = min(total.toDouble(), max(0.0, n)).toInt()
}

/**
 * One of a windowed list's `total` slots: the materialized children of item
 * [index] (several for a multi-node template) or a placeholder.
 */
sealed class VirtSlot<out T> {
    abstract val index: Int

    data class Item<T>(override val index: Int, val nodes: List<T>) : VirtSlot<T>()

    data class Placeholder(override val index: Int) : VirtSlot<Nothing>()
}

/**
 * The slot view of a windowed list (docs/virtualization.md §5): [count] is
 * `total`; slot `i` holds the children of item `i` when `start <= i < end`,
 * else a placeholder. Built in O(1) — slots are resolved on demand, so a
 * 10,000-item list never allocates 10,000 entries.
 *
 * Children are grouped per item ([Virtualization.childrenPerItem]). When the
 * counts disagree (a transient batch the engine is still settling) an item
 * with no children in range falls back to a placeholder rather than
 * throwing.
 */
class VirtSlots<T>(
    val window: VirtWindow,
    private val children: List<T>,
    private val idOf: (T) -> String,
) {
    val count: Int get() = window.total

    val childrenPerItem: Int = Virtualization.childrenPerItem(window, children.size)

    operator fun get(index: Int): VirtSlot<T> {
        if (index < window.start || index >= window.end) {
            return VirtSlot.Placeholder(index)
        }
        val from = (index - window.start) * childrenPerItem
        if (from >= children.size) return VirtSlot.Placeholder(index)
        val to = min(children.size, from + childrenPerItem)
        return VirtSlot.Item(index, children.subList(from, to))
    }

    /**
     * Stable Lazy* key: the first child's node id for a materialized row,
     * the item index (a `Long`, so it never collides with an id string) for
     * a placeholder.
     */
    fun key(index: Int): Any = when (val slot = get(index)) {
        is VirtSlot.Item -> idOf(slot.nodes.first())
        is VirtSlot.Placeholder -> placeholderKey(index)
    }

    /** True when slot [index] renders a placeholder. */
    fun isPlaceholder(index: Int): Boolean = get(index) is VirtSlot.Placeholder

    /** Every slot, in order. For tests and small lists only. */
    fun toList(): List<VirtSlot<T>> = (0 until count).map { get(it) }

    companion object {
        fun placeholderKey(index: Int): Any = index.toLong()
    }
}

/**
 * How a windowed element that is not a `List` / `Grid` renders — an element
 * whose sole child is a lazy `ForEach` (a `Column`, `Row`, `Stack`…).
 */
data class WindowedShape(val horizontal: Boolean, val lazy: Boolean) {
    companion object {
        /**
         * A `Row` lays out horizontally, anything else vertically. One that
         * scrolls itself along that axis (`.scrollable(true | "both" |
         * axis)`) becomes a native lazy container over `total` slots; any
         * other is padded and reports from its ancestor scroller.
         */
        fun of(elementType: String, scrollable: Any?): WindowedShape {
            val horizontal = elementType.equals("row", ignoreCase = true)
            val scrolls = when (scrollable) {
                is Boolean -> scrollable
                is String -> scrollable.lowercase().let {
                    it == "true" || it == "both" || it == (if (horizontal) "horizontal" else "vertical")
                }
                else -> false
            }
            return WindowedShape(horizontal, lazy = scrolls)
        }
    }
}

/**
 * Per-list reporting state: the window and the last report, so the §3 rules
 * ("never the same range twice in a row") hold across frames. Pure; the
 * Compose layer feeds it visible ranges and sends what it returns.
 */
class ViewportTracker {
    var lastReported: ItemRange? = null
        private set

    private var lastWindow: VirtWindow? = null

    /**
     * The range to report for [visible] under [window], or `null` when the
     * rules say not to report. Records the report. A [window] that differs in
     * value from the previous call's forgets the last report (§3 step 4); an
     * identical re-send does not.
     */
    fun next(window: VirtWindow, visible: ItemRange): ItemRange? {
        if (Virtualization.windowChanged(lastWindow, window)) {
            lastReported = null
            lastWindow = window
        }
        val wanted = Virtualization.wantedRange(visible, window.total)
        if (!Virtualization.shouldReport(window, visible, wanted, lastReported)) return null
        lastReported = wanted
        return wanted
    }
}
