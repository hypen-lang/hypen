package space.hypen.renderer.virt

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Padded-path scroll anchoring ([Virtualization.anchorDelta], §2/§3) and the
 * whole-list accessibility shape ([Virtualization.collectionShape]).
 *
 * A row's offset in the padded list is the leading padding plus the window
 * rows above it, so each expected delta below is "where the anchor row is
 * after" minus "where it was before".
 */
class VirtAnchorTest {
    private fun layout(start: Int, end: Int, padSize: Double, total: Int = 1000) =
        PaddedLayout(VirtWindow(total, start, end), padSize)

    @Test
    fun `uniform sizes need no anchoring when the window slides forward`() {
        // Padding stands in for exactly the rows it replaced.
        val delta = Virtualization.anchorDelta(layout(0, 30, 50.0), layout(20, 60, 50.0), 50.0, 1200.0, 500.0)
        assertEquals(0.0, delta, 1e-9)
    }

    @Test
    fun `a shrunken padding size moves the anchor row and is undone`() {
        // Row 24 sits at 1200 under [0,30); under [20,60) with 10-per-row
        // padding it sits at 200 + 4 * 50 = 400: scroll back by 800.
        val delta = Virtualization.anchorDelta(layout(0, 30, 10.0), layout(20, 60, 10.0), 50.0, 1210.0, 500.0)
        assertEquals(-800.0, delta, 1e-9)
    }

    @Test
    fun `rows materialized above the anchor push it down`() {
        // [20,60) -> [10,60) with 10-per-row padding: row 25 goes from
        // 200 + 5 * 50 = 450 to 100 + 15 * 50 = 850.
        val delta = Virtualization.anchorDelta(layout(20, 60, 10.0), layout(10, 60, 10.0), 50.0, 450.0, 500.0)
        assertEquals(400.0, delta, 1e-9)
    }

    @Test
    fun `a re-measured item size shifts by the leading padding delta`() {
        // Same window; the padding per row goes 48 -> 50, 40 rows above.
        val before = layout(40, 70, 48.0)
        val past = 40 * 48.0 + 260.0
        assertEquals(80.0, Virtualization.anchorDelta(before, layout(40, 70, 50.0), 50.0, past, 500.0), 1e-9)
    }

    @Test
    fun `rows leaving below the anchor change nothing`() {
        assertEquals(0.0, Virtualization.anchorDelta(layout(20, 60, 10.0), layout(20, 40, 10.0), 50.0, 450.0, 500.0), 1e-9)
    }

    @Test
    fun `no anchor when the anchor row leaves the window`() {
        // Row 25 is visible under [20,60) but not materialized under [100,140).
        assertEquals(0.0, Virtualization.anchorDelta(layout(20, 60, 10.0), layout(100, 140, 10.0), 50.0, 450.0, 500.0), 1e-9)
    }

    @Test
    fun `no anchor when no materialized row is on screen`() {
        // Scrolled past every window row (lead 200 + 40 * 50 = 2200).
        assertEquals(0.0, Virtualization.anchorDelta(layout(20, 60, 10.0), layout(10, 60, 10.0), 50.0, 2300.0, 500.0), 1e-9)
        // Still in the leading padding: the window's rows are below the viewport.
        assertEquals(0.0, Virtualization.anchorDelta(layout(20, 60, 10.0), layout(10, 60, 10.0), 50.0, 0.0, 150.0), 1e-9)
        // Nothing materialized at all.
        assertEquals(0.0, Virtualization.anchorDelta(layout(20, 20, 10.0), layout(10, 60, 10.0), 50.0, 200.0, 500.0), 1e-9)
    }

    @Test
    fun `a list below the viewport top anchors its first row`() {
        // Rows unchanged at the top; only the trailing padding moved.
        assertEquals(0.0, Virtualization.anchorDelta(layout(0, 30, 50.0), layout(0, 40, 50.0), 50.0, -100.0, 500.0), 1e-9)
    }

    @Test
    fun `a list starting below the viewport top counts only the viewport over it`() {
        // The list starts 100 below the viewport's top; of a 500 viewport only
        // [0, 400) of the list is on screen (§3 step 2), for reporting and
        // anchoring alike: one geometry, the same visible span.
        val geometry = ViewportGeometry(size = 50.0, scrolledPast = -100.0, viewportExtent = 500.0)
        assertEquals(0.0 to 400.0, Virtualization.visibleSpan(geometry))
        val window = VirtWindow(1000, 0, 30)
        // Rows 0..7 are on screen, row 8 starts at 400: off screen.
        assertEquals(ItemRange(0, 8), Virtualization.paddedVisibleRange(window, 50.0, 50.0, geometry))
        // Row 8 at 400 (padding 8 * 50 under [8,40)) is below the visible part:
        // nothing on screen to hold still, so no correction.
        assertEquals(0.0, Virtualization.anchorDelta(layout(8, 40, 50.0), layout(8, 40, 10.0), 50.0, geometry), 1e-9)
        // The first row on screen is anchored: lead 7 * 50 = 350 -> 7 * 10 = 70.
        assertEquals(-280.0, Virtualization.anchorDelta(layout(7, 40, 50.0), layout(7, 40, 10.0), 50.0, geometry), 1e-9)
    }

    @Test
    fun `grids anchor by rows`() {
        // 3 columns, rows 100 tall, padding 20 per row. Grid row 6 (items
        // 18..20) at 600 under [0,30); under [15,45) it is 5 rows of padding
        // (100) plus one window row (100) down: 200.
        val delta = Virtualization.anchorDelta(
            layout(0, 30, 20.0),
            layout(15, 45, 20.0),
            rowSize = 100.0,
            scrolledPast = 650.0,
            viewportExtent = 300.0,
            columns = 3,
        )
        assertEquals(-400.0, delta, 1e-9)
    }

    @Test
    fun `an unchanged layout needs no anchoring`() {
        val l = layout(20, 60, 10.0)
        assertEquals(0.0, Virtualization.anchorDelta(l, l, 50.0, 450.0, 500.0), 1e-9)
    }

    // ---- collectionShape

    @Test
    fun `a vertical list is total rows of one column`() {
        assertEquals(CollectionShape(rowCount = 1000, columnCount = 1),
            Virtualization.collectionShape(VirtWindow(1000, 40, 70), horizontal = false))
    }

    @Test
    fun `a horizontal list is one row of total columns`() {
        assertEquals(CollectionShape(rowCount = 1, columnCount = 1000),
            Virtualization.collectionShape(VirtWindow(1000, 40, 70), horizontal = true))
    }

    @Test
    fun `a grid is whole rows of its columns`() {
        assertEquals(CollectionShape(rowCount = 32, columnCount = 3),
            Virtualization.collectionShape(VirtWindow(95, 0, 30), horizontal = false, columns = 3))
        assertEquals(CollectionShape(rowCount = 0, columnCount = 3),
            Virtualization.collectionShape(VirtWindow(0, 0, 0), horizontal = false, columns = 3))
    }

    // ---- itemPosition / childPositions (per-row CollectionItemInfo)

    @Test
    fun `itemPosition places an item in the whole list`() {
        assertEquals(ItemPosition(rowIndex = 42, columnIndex = 0), Virtualization.itemPosition(42, horizontal = false))
        assertEquals(ItemPosition(rowIndex = 0, columnIndex = 42), Virtualization.itemPosition(42, horizontal = true))
        assertEquals(ItemPosition(rowIndex = 14, columnIndex = 0), Virtualization.itemPosition(42, horizontal = false, columns = 3))
        assertEquals(ItemPosition(rowIndex = 14, columnIndex = 2), Virtualization.itemPosition(44, horizontal = false, columns = 3))
    }

    @Test
    fun `padded rows get their whole-list position from the window start`() {
        val positions = Virtualization.childPositions(VirtWindow(1000, 40, 43), listOf("a", "b", "c"), horizontal = false) { it }
        assertEquals(
            mapOf("a" to ItemPosition(40, 0), "b" to ItemPosition(41, 0), "c" to ItemPosition(42, 0)),
            positions,
        )
        val row = Virtualization.childPositions(VirtWindow(1000, 40, 42), listOf("a", "b"), horizontal = true) { it }
        assertEquals(mapOf("a" to ItemPosition(0, 40), "b" to ItemPosition(0, 41)), row)
    }

    @Test
    fun `padded grid items get their row and column`() {
        val positions = Virtualization.childPositions(VirtWindow(95, 30, 34), listOf("a", "b", "c", "d"), horizontal = false, columns = 3) { it }
        assertEquals(
            mapOf("a" to ItemPosition(10, 0), "b" to ItemPosition(10, 1), "c" to ItemPosition(10, 2), "d" to ItemPosition(11, 0)),
            positions,
        )
    }

    @Test
    fun `a multi-node template shares its item's position`() {
        // Two children per item (§1 grouping).
        val positions = Virtualization.childPositions(VirtWindow(100, 10, 12), listOf("t1", "b1", "t2", "b2"), horizontal = false) { it }
        assertEquals(ItemPosition(10, 0), positions["t1"])
        assertEquals(ItemPosition(10, 0), positions["b1"])
        assertEquals(ItemPosition(11, 0), positions["t2"])
        assertEquals(ItemPosition(11, 0), positions["b2"])
    }

    @Test
    fun `children beyond the window get no position`() {
        // A transient batch: children arrive for a window that holds no items.
        assertEquals(emptyMap<String, ItemPosition>(), Virtualization.childPositions(VirtWindow(100, 10, 10), listOf("x"), horizontal = false) { it })
    }
}
