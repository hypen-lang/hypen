package space.hypen.renderer.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Data normalisation and the nice-tick maths — the half of the Chart contract
 * that has nothing to do with pixels. Mirrors the DOM renderer's
 * `dom.chart-contract` suite so both renderers read the same rows out of the
 * same props.
 */
class ChartDataTest {
    private fun xy(data: List<ChartDatum>) = data.map { it.x to it.y }

    @Test
    fun `a bare number list uses the index as x`() {
        assertEquals(
            listOf(0.0 to 3.0, 1.0 to 5.0, 2.0 to 2.0),
            xy(normalizeChartData(mapOf("points" to listOf(3, 5, 2)))),
        )
    }

    @Test
    fun `x and y tuples are read positionally`() {
        assertEquals(
            listOf(10.0 to 1.0, 20.0 to 4.0),
            xy(normalizeChartData(mapOf("0" to listOf(listOf(10, 1), listOf(20, 4))))),
        )
    }

    @Test
    fun `objects use the x and y field names and keep the raw row`() {
        val rows = listOf(
            mapOf("month" to "Jan", "count" to 3),
            mapOf("month" to "Feb", "count" to 7),
        )
        val data = normalizeChartData(mapOf("data" to rows, "x" to "month", "y" to "count"))
        assertEquals(listOf("Jan" to 3.0, "Feb" to 7.0), xy(data))
        assertSame(rows[1], data[1].raw)
    }

    @Test
    fun `bars sugar names the fields with label and value`() {
        val data = normalizeChartData(
            mapOf(
                "data" to listOf(mapOf("day" to "Mon", "kcal" to 1800)),
                "label" to "day",
                "value" to "kcal",
            ),
        )
        assertEquals(listOf("Mon" to 1800.0), xy(data))
    }

    @Test
    fun `an object row missing the x field falls back to its index`() {
        val data = normalizeChartData(mapOf("data" to listOf(mapOf("count" to 4)), "y" to "count"))
        assertEquals(listOf(0.0 to 4.0), xy(data))
    }

    @Test
    fun `a json encoded list is accepted from the wire`() {
        assertEquals(2, normalizeChartData(mapOf("points" to "[[1,2],[3,4]]")).size)
    }

    @Test
    fun `rows without a usable y are dropped, not zeroed`() {
        val data = normalizeChartData(mapOf("points" to listOf(1, null, "x", 4)))
        assertEquals(listOf(0, 3), data.map { it.index })
    }

    @Test
    fun `applicator spelling of a list prop is read too`() {
        assertEquals(3, normalizeChartData(mapOf("points.0" to listOf(1, 2, 3))).size)
    }

    @Test
    fun `nice ticks match the reference implementation`() {
        assertEquals(listOf(0.0, 20.0, 40.0, 60.0, 80.0, 100.0), chartTicks(0.0, 100.0, 5))
        assertEquals(
            listOf(0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0),
            chartTicks(0.0, 7.0, 5),
        )
        assertEquals(10.0 to 70.0, chartNiceDomain(12.0, 63.0, 5))
    }

    @Test
    fun `a degenerate domain is padded rather than collapsing`() {
        assertEquals(-1.0 to 1.0, chartNiceDomain(0.0, 0.0, 5))
        val (lo, hi) = chartNiceDomain(50.0, 50.0, 5)
        assertEquals(45.0, lo, 1e-9)
        assertEquals(55.0, hi, 1e-9)
    }

    @Test
    fun `nice step thresholds pick 1 2 5 or 10 times the magnitude`() {
        // norm < 1.5 -> 1, < 3 -> 2, < 7 -> 5, else 10.
        assertEquals(1.0, chartNiceStep(0.0, 5.0, 5), 1e-9)
        assertEquals(2.0, chartNiceStep(0.0, 10.0, 5), 1e-9)
        assertEquals(5.0, chartNiceStep(0.0, 25.0, 5), 1e-9)
        assertEquals(10.0, chartNiceStep(0.0, 45.0, 5), 1e-9)
    }

    @Test
    fun `tick labels stay integral where they can`() {
        assertEquals("0", chartFormatTick(0.0))
        assertEquals("50", chartFormatTick(50.0))
        assertEquals("-3", chartFormatTick(-3.0))
        assertEquals("0.5", chartFormatTick(0.5))
        assertEquals("0.333", chartFormatTick(1.0 / 3.0))
    }

    @Test
    fun `explicit ranges are normalised ascending and tolerate json`() {
        assertEquals(0.0 to 10.0, chartRange(listOf(10, 0)))
        assertEquals(0.0 to 100.0, chartRange("[0, 100]"))
        assertNull(chartRange(listOf(1)))
        assertNull(chartRange("nope"))
    }

    @Test
    fun `highlight accepts an index, a list, or nothing at all`() {
        assertNull(chartHighlight(null))
        assertNull(chartHighlight(false))
        assertEquals(setOf(1), chartHighlight(1))
        assertEquals(setOf(0, 2), chartHighlight(listOf(0, 2)))
        assertEquals(setOf(3), chartHighlight("[3]"))
    }

    @Test
    fun `mark kinds are registered under their lowercase wire names`() {
        assertEquals(ChartMarkKind.LINE, ChartMarkKind.fromType("Line"))
        assertEquals(ChartMarkKind.BARS, ChartMarkKind.fromType("bars"))
        assertEquals(ChartMarkKind.MARKER, ChartMarkKind.fromType("Marker"))
        assertNull(ChartMarkKind.fromType("Text"))
        assertTrue(ChartMarkKind.LINE.isData)
        assertTrue(!ChartMarkKind.AXIS.isData)
    }
}
