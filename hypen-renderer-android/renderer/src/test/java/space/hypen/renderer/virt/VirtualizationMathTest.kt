package space.hypen.renderer.virt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The renderer-side window math from docs/virtualization.md. Mirrors
 * hypen-web/tests/virtualization-math.test.ts case for case; keep aligned.
 */
class VirtualizationMathTest {
    private fun w(total: Int, start: Int, end: Int, est: Double? = null) = VirtWindow(total, start, end, est)

    private fun r(start: Int, end: Int) = ItemRange(start, end)

    // ---- parseVirtWindow

    @Test
    fun `parse decodes the engine's prop`() {
        assertEquals(w(100, 10, 40), Virtualization.parseVirtWindow(mapOf("total" to 100, "start" to 10, "end" to 40)))
        assertEquals(
            w(5, 0, 2, 48.0),
            Virtualization.parseVirtWindow(mapOf("total" to 5, "start" to 0, "end" to 2, "estimatedSize" to 48)),
        )
    }

    @Test
    fun `parse decodes Moshi doubles`() {
        // JSON numbers arrive from Moshi as Double.
        assertEquals(w(100, 10, 40), Virtualization.parseVirtWindow(mapOf("total" to 100.0, "start" to 10.0, "end" to 40.0)))
    }

    @Test
    fun `parse rejects malformed values`() {
        assertNull(Virtualization.parseVirtWindow(null))
        assertNull(Virtualization.parseVirtWindow(mapOf("total" to 10, "start" to 5, "end" to 3)))
        assertNull(Virtualization.parseVirtWindow(mapOf("total" to 10, "start" to 0, "end" to 11)))
        assertNull(Virtualization.parseVirtWindow(mapOf("total" to 10, "start" to -1, "end" to 3)))
        assertNull(Virtualization.parseVirtWindow(mapOf("total" to "10", "start" to 0, "end" to 3)))
        assertNull(Virtualization.parseVirtWindow(mapOf("total" to 10.5, "start" to 0, "end" to 3)))
        assertNull(Virtualization.parseVirtWindow("{\"total\":10}"))
    }

    // ---- itemSize

    @Test
    fun `itemSize prefers the measured average`() {
        assertEquals(50.0, Virtualization.itemSize(w(100, 0, 10, 30.0), 500.0, 10), 0.0)
    }

    @Test
    fun `itemSize falls back to the estimate, then the default`() {
        assertEquals(30.0, Virtualization.itemSize(w(100, 0, 10, 30.0), 0.0, 0), 0.0)
        assertEquals(DEFAULT_ITEM_SIZE, Virtualization.itemSize(w(100, 0, 10), 0.0, 0), 0.0)
    }

    // ---- windowPadding

    @Test
    fun `windowPadding stands in for the items outside the window`() {
        assertEquals(WindowPadding(400.0, 300.0), Virtualization.windowPadding(w(100, 40, 70), 10.0))
    }

    @Test
    fun `windowPadding is zero when the window covers everything`() {
        assertEquals(WindowPadding(0.0, 0.0), Virtualization.windowPadding(w(5, 0, 5), 10.0))
    }

    @Test
    fun `windowPadding counts grid rows`() {
        // 3 columns: items 0..8 are rows 0..2; window 9..18 is rows 3..5; 30 items = 10 rows.
        assertEquals(WindowPadding(300.0, 400.0), Virtualization.windowPadding(w(30, 9, 18), 100.0, 3))
    }

    // ---- windowRows

    @Test
    fun `windowRows is the item count for a list`() {
        assertEquals(30, Virtualization.windowRows(w(100, 40, 70)))
    }

    @Test
    fun `windowRows counts every grid row the window touches`() {
        assertEquals(3, Virtualization.windowRows(w(30, 9, 18), 3))
        assertEquals(3, Virtualization.windowRows(w(30, 10, 17), 3))
    }

    // ---- childrenPerItem

    @Test
    fun `childrenPerItem groups a multi-node template's children into items`() {
        assertEquals(1, Virtualization.childrenPerItem(w(100, 10, 20), 10))
        assertEquals(3, Virtualization.childrenPerItem(w(100, 10, 20), 30))
    }

    @Test
    fun `childrenPerItem is at least 1`() {
        assertEquals(1, Virtualization.childrenPerItem(w(100, 10, 10), 0))
        assertEquals(1, Virtualization.childrenPerItem(w(100, 10, 20), 0))
    }

    // ---- visibleRange

    @Test
    fun `visibleRange maps the scroll offset to items`() {
        assertEquals(r(10, 14), Virtualization.visibleRange(1000, 50.0, 500.0, 200.0))
    }

    @Test
    fun `visibleRange clamps to the list`() {
        assertEquals(r(10, 12), Virtualization.visibleRange(12, 50.0, 500.0, 200.0))
        assertEquals(r(0, 4), Virtualization.visibleRange(100, 50.0, -300.0, 200.0))
    }

    @Test
    fun `visibleRange counts grid rows`() {
        assertEquals(r(9, 15), Virtualization.visibleRange(90, 100.0, 300.0, 200.0, 3))
    }

    // ---- wantedRange

    @Test
    fun `wantedRange adds a viewport of overscan on each side`() {
        assertEquals(r(20, 80), Virtualization.wantedRange(r(40, 60), 1000))
    }

    @Test
    fun `wantedRange overscans at least five items`() {
        assertEquals(r(35, 47), Virtualization.wantedRange(r(40, 42), 1000))
    }

    @Test
    fun `wantedRange clamps to the list`() {
        assertEquals(r(0, 12), Virtualization.wantedRange(r(2, 10), 12))
    }

    // ---- shouldReport

    private val window = w(1000, 20, 80)

    @Test
    fun `shouldReport not while the visible range is covered`() {
        assertFalse(Virtualization.shouldReport(window, r(40, 60), r(20, 80), null))
    }

    @Test
    fun `shouldReport when the visible range leaves the window`() {
        assertTrue(Virtualization.shouldReport(window, r(70, 90), r(50, 110), null))
    }

    @Test
    fun `shouldReport when the window is far larger than needed`() {
        assertTrue(Virtualization.shouldReport(w(1000, 0, 500), r(100, 110), r(90, 120), null))
    }

    @Test
    fun `shouldReport never the same range twice`() {
        val wanted = r(50, 110)
        assertFalse(Virtualization.shouldReport(window, r(70, 90), wanted, wanted))
    }

    // ---- viewportReport

    private val top = w(1000, 0, 20)

    @Test
    fun `viewportReport nothing while the window covers the visible range`() {
        assertNull(Virtualization.viewportReport(top, ViewportGeometry(50.0, 0.0, 500.0), null))
    }

    @Test
    fun `viewportReport the overscanned range once the user scrolls past the window`() {
        val geometry = ViewportGeometry(50.0, 2000.0, 500.0)
        // visible [40,50) -> one viewport (10 items) of overscan each side.
        assertEquals(r(30, 60), Virtualization.viewportReport(top, geometry, null))
        assertNull(Virtualization.viewportReport(top, geometry, r(30, 60)))
    }

    @Test
    fun `viewportReport counts only the part of the viewport over a list that starts below its top`() {
        val short = w(1000, 0, 2)
        // The list starts 100px down a 300px viewport: 200px (4 items) of it shows.
        assertEquals(r(0, 9), Virtualization.viewportReport(short, ViewportGeometry(50.0, -100.0, 300.0), null))
        // Entirely below the viewport: nothing is visible, nothing to report.
        assertNull(Virtualization.viewportReport(short, ViewportGeometry(50.0, -400.0, 300.0), null))
    }

    @Test
    fun `viewportReport grids report whole rows`() {
        val grid = w(90, 0, 9)
        assertEquals(r(3, 21), Virtualization.viewportReport(grid, ViewportGeometry(100.0, 300.0, 200.0, 3), null))
    }
}
