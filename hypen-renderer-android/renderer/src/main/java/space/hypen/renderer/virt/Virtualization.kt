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
    fun parse(value: Any?): VirtWindow? {
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
        val rowsInWindow = ceilDiv(window.end, cols) - window.start / cols
        val rowsAfter = max(0, rowsTotal - rowsBefore - rowsInWindow)
        return WindowPadding(rowsBefore * size, rowsAfter * size)
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
     * whole padded list stays within [maxExtent]. Compose cannot measure a
     * node beyond 2^18 px along one axis (a `Constraints` limit), and a
     * 10,000-row list at 48dp is far past it. The same size must drive both
     * the padding and the visible-range geometry so the two agree.
     */
    fun paddedItemSize(window: VirtWindow, size: Double, columns: Int = 1, maxExtent: Double = MAX_PADDED_EXTENT_DP): Double {
        val rows = ceilDiv(window.total, max(1, columns))
        if (rows <= 0) return size
        return min(size, maxExtent / rows)
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
        val rowsIn = rowsInWindow(window, cols)
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

    /** Rows of a `columns`-wide grid the window `[start, end)` occupies. */
    fun rowsInWindow(window: VirtWindow, columns: Int = 1): Int {
        val cols = max(1, columns)
        return ceilDiv(window.end, cols) - window.start / cols
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
 * Children are grouped per item: `childrenPerItem = children / (end - start)`.
 * When the counts disagree (a transient batch the engine is still settling)
 * an item with no children in range falls back to a placeholder rather than
 * throwing.
 */
class VirtSlots<T>(
    val window: VirtWindow,
    private val children: List<T>,
    private val idOf: (T) -> String,
) {
    val count: Int get() = window.total

    val childrenPerItem: Int =
        if (window.count <= 0) 0 else max(1, children.size / window.count)

    operator fun get(index: Int): VirtSlot<T> {
        if (index < window.start || index >= window.end || childrenPerItem == 0) {
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

    /**
     * The range to report for [visible] under [window], or `null` when the
     * rules say not to report. Records the report.
     */
    fun next(window: VirtWindow, visible: ItemRange): ItemRange? {
        val wanted = Virtualization.wantedRange(visible, window.total)
        if (!Virtualization.shouldReport(window, visible, wanted, lastReported)) return null
        lastReported = wanted
        return wanted
    }

    /**
     * Visible range from a scroll geometry (the padded, non-lazy path):
     * [listTop] is where the list's leading edge sits and [viewportTop] /
     * [viewportExtent] the visible part of the scroll container, all in the
     * same unit along the scroll axis. Rows outside the window are [padSize]
     * each, materialized rows [rowSize] ([Virtualization.paddedVisibleRange]).
     */
    fun visibleFromGeometry(
        window: VirtWindow,
        padSize: Double,
        rowSize: Double,
        listTop: Double,
        viewportTop: Double,
        viewportExtent: Double,
        columns: Int = 1,
    ): ItemRange = Virtualization.paddedVisibleRange(
        window,
        padSize,
        rowSize,
        scrolledPast = viewportTop - listTop,
        viewportExtent = viewportExtent,
        columns = columns,
    )
}
