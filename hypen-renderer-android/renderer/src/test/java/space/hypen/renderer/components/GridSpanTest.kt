package space.hypen.renderer.components

import org.junit.Assert.assertEquals
import org.junit.Test
import space.hypen.renderer.model.HypenElement

/**
 * `gridColumn: span N` packing.
 *
 * Android previously had no span support at all — it chunked children into
 * rows of `columns` regardless — so the calculator's `0` key rendered one
 * cell wide while iOS spanned it two. These pin the packing against the Swift
 * renderer's `HypenGridLayout.computeGrid` semantics.
 */
class GridSpanTest {

    private fun item(id: String, span: String? = null) = HypenElement(
        id = id,
        elementType = "button",
        props = if (span == null) emptyMap() else mapOf("gridColumn.0" to span),
    )

    @Test
    fun `an item without gridColumn spans one track`() {
        assertEquals(1, item("a").gridSpan(4))
    }

    @Test
    fun `span keyword and bare number both parse`() {
        assertEquals(2, item("a", "span 2").gridSpan(4))
        assertEquals(2, item("a", "2").gridSpan(4))
    }

    @Test
    fun `a span wider than the grid is clamped to the track count`() {
        assertEquals(4, item("a", "span 9").gridSpan(4))
    }

    @Test
    fun `an unparseable span degrades to one rather than throwing`() {
        assertEquals(1, item("a", "span banana").gridSpan(4))
    }

    @Test
    fun `rows wrap on the track count when nothing spans`() {
        val rows = packGridRows((1..5).map { item("$it") }, columns = 4)
        assertEquals(2, rows.size)
        assertEquals(4, rows[0].size)
        assertEquals(1, rows[1].size)
    }

    @Test
    fun `a spanning item consumes its tracks`() {
        // The calculator's last row: `0` spans two, then `.` and `=`.
        val rows = packGridRows(
            listOf(item("zero", "span 2"), item("dot"), item("equals")),
            columns = 4,
        )
        assertEquals(1, rows.size)
        assertEquals(listOf("zero", "dot", "equals"), rows[0].map { it.id })
    }

    @Test
    fun `an item that does not fit the remaining tracks starts a new row`() {
        // 3 singles fill 3 of 4 tracks; a span-2 cannot straddle the boundary.
        val rows = packGridRows(
            listOf(item("a"), item("b"), item("c"), item("wide", "span 2")),
            columns = 4,
        )
        assertEquals(2, rows.size)
        assertEquals(listOf("a", "b", "c"), rows[0].map { it.id })
        assertEquals(listOf("wide"), rows[1].map { it.id })
    }
}
