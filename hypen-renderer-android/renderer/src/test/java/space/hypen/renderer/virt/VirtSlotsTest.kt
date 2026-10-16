package space.hypen.renderer.virt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The slot mapping a native lazy container declares for a windowed list
 * (docs/virtualization.md §5), the lazy-layout reading, the per-list report
 * state, and which shape a windowed non-List container takes.
 */
class VirtSlotsTest {
    private fun slots(window: VirtWindow, children: List<String>) = VirtSlots(window, children) { it }

    @Test
    fun `declares total slots with materialized rows only inside the window`() {
        val s = slots(VirtWindow(total = 6, start = 2, end = 4), listOf("a", "b"))
        assertEquals(6, s.count)
        assertEquals(
            listOf(
                VirtSlot.Placeholder(0),
                VirtSlot.Placeholder(1),
                VirtSlot.Item(2, listOf("a")),
                VirtSlot.Item(3, listOf("b")),
                VirtSlot.Placeholder(4),
                VirtSlot.Placeholder(5),
            ),
            s.toList(),
        )
    }

    @Test
    fun `groups a multi-node template's children per item`() {
        val s = slots(VirtWindow(total = 10, start = 3, end = 5), listOf("a1", "a2", "b1", "b2"))
        assertEquals(2, s.childrenPerItem)
        assertEquals(VirtSlot.Item(3, listOf("a1", "a2")), s[3])
        assertEquals(VirtSlot.Item(4, listOf("b1", "b2")), s[4])
        assertEquals(VirtSlot.Placeholder(5), s[5])
    }

    @Test
    fun `keys rows by node id and placeholders by item index`() {
        val s = slots(VirtWindow(total = 4, start = 1, end = 2), listOf("node-7"))
        assertEquals("node-7", s.key(1))
        assertEquals(0L, s.key(0))
        assertEquals(2L, s.key(2))
        // A placeholder key never collides with a node id that looks like an index.
        val t = slots(VirtWindow(total = 4, start = 0, end = 1), listOf("2"))
        assertNotEquals(t.key(0), t.key(2))
        assertEquals(4, (0 until 4).map { t.key(it) }.toSet().size)
    }

    @Test
    fun `an empty window is all placeholders`() {
        val s = slots(VirtWindow(total = 3, start = 0, end = 0), emptyList())
        assertEquals(0, s.childrenPerItem)
        assertTrue((0 until 3).all { s.isPlaceholder(it) })
    }

    @Test
    fun `fewer children than the window says degrades to placeholders, never throws`() {
        // A transient batch: the window says 3 items, only 2 rows arrived.
        val s = slots(VirtWindow(total = 5, start = 1, end = 4), listOf("a", "b"))
        assertEquals(VirtSlot.Item(1, listOf("a")), s[1])
        assertEquals(VirtSlot.Item(2, listOf("b")), s[2])
        assertEquals(VirtSlot.Placeholder(3), s[3])
    }

    @Test
    fun `visibleSlots ignores beyond-bounds items`() {
        val laid = listOf(
            LaidOutSlot(index = 9, offset = -60, size = 50, materialized = true), // fully above
            LaidOutSlot(index = 10, offset = -20, size = 50, materialized = true), // partially visible
            LaidOutSlot(index = 11, offset = 30, size = 50, materialized = false),
            LaidOutSlot(index = 12, offset = 200, size = 50, materialized = true), // below the viewport
        )
        assertEquals(ItemRange(10, 12), Virtualization.visibleSlots(laid, 0, 200, 100))
        assertNull(Virtualization.visibleSlots(emptyList(), 0, 200, 100))
    }

    @Test
    fun `measured averages materialized slots only`() {
        val laid = listOf(
            LaidOutSlot(0, 0, 40, materialized = true),
            LaidOutSlot(1, 40, 60, materialized = true),
            LaidOutSlot(2, 100, 48, materialized = false),
        )
        assertEquals(100.0 to 2, Virtualization.measured(laid))
    }

    @Test
    fun `the tracker reports once per new range`() {
        val tracker = ViewportTracker()
        val window = VirtWindow(total = 1000, start = 0, end = 30)
        // Covered: nothing to report.
        assertNull(tracker.next(window, ItemRange(0, 10)))
        // Scrolled past the window: report the overscanned range...
        assertEquals(ItemRange(10, 70), tracker.next(window, ItemRange(30, 50)))
        // ...but never the same range twice in a row.
        assertNull(tracker.next(window, ItemRange(30, 50)))
        assertEquals(ItemRange(10, 70), tracker.lastReported)
    }

    @Test
    fun `geometry gives the visible range below a scrolled ancestor`() {
        // The list starts 100px down the content; the viewport has scrolled
        // 600px, so 500px of the list are above it.
        val visible = ViewportTracker().visibleFromGeometry(
            VirtWindow(total = 1000, start = 0, end = 30),
            padSize = 50.0,
            rowSize = 50.0,
            listTop = -500.0,
            viewportTop = 0.0,
            viewportExtent = 200.0,
        )
        assertEquals(ItemRange(10, 14), visible)
    }

    @Test
    fun `paddedVisibleRange equals visibleRange when the sizes agree`() {
        val window = VirtWindow(total = 1000, start = 40, end = 70)
        for (past in listOf(0.0, 333.0, 2000.0, 3600.0, 9000.0)) {
            assertEquals(
                Virtualization.visibleRange(1000, 50.0, past, 200.0),
                Virtualization.paddedVisibleRange(window, 50.0, 50.0, past, 200.0),
            )
        }
    }

    @Test
    fun `paddedVisibleRange maps padding and rows at their own sizes`() {
        // 40 rows of padding at 10 each (400), then rows 40..70 at 50 each.
        val window = VirtWindow(total = 1000, start = 40, end = 70)
        assertEquals(ItemRange(20, 30), Virtualization.paddedVisibleRange(window, 10.0, 50.0, 200.0, 100.0))
        assertEquals(ItemRange(42, 46), Virtualization.paddedVisibleRange(window, 10.0, 50.0, 500.0, 200.0))
        // Past the window (400 + 1500 = 1900): back in 10-per-row padding.
        assertEquals(ItemRange(80, 90), Virtualization.paddedVisibleRange(window, 10.0, 50.0, 2000.0, 100.0))
    }

    @Test
    fun `paddedItemSize keeps a huge list measurable`() {
        val huge = VirtWindow(total = 100_000, start = 0, end = 30)
        assertEquals(MAX_PADDED_EXTENT_DP / 100_000, Virtualization.paddedItemSize(huge, 48.0), 1e-9)
        assertEquals(48.0, Virtualization.paddedItemSize(VirtWindow(total = 100, start = 0, end = 30), 48.0), 0.0)
        // A grid counts rows.
        assertEquals(48.0, Virtualization.paddedItemSize(VirtWindow(total = 3000, start = 0, end = 30), 48.0, 3), 0.0)
    }

    @Test
    fun `rowsInWindow counts grid rows`() {
        assertEquals(3, Virtualization.rowsInWindow(VirtWindow(30, 9, 18), 3))
        assertEquals(30, Virtualization.rowsInWindow(VirtWindow(100, 40, 70)))
    }

    @Test
    fun `windowed containers take the lazy path only when they scroll themselves`() {
        assertEquals(WindowedShape(horizontal = false, lazy = true), WindowedShape.of("Column", true))
        assertEquals(WindowedShape(horizontal = false, lazy = true), WindowedShape.of("column", "vertical"))
        assertEquals(WindowedShape(horizontal = false, lazy = false), WindowedShape.of("column", "horizontal"))
        assertEquals(WindowedShape(horizontal = false, lazy = false), WindowedShape.of("Column", null))
        assertEquals(WindowedShape(horizontal = true, lazy = true), WindowedShape.of("Row", "both"))
        assertEquals(WindowedShape(horizontal = true, lazy = false), WindowedShape.of("row", false))
        assertFalse(WindowedShape.of("Stack", "horizontal").lazy)
    }
}
