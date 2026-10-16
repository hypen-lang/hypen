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
}
