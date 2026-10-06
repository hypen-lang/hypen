package space.hypen.renderer.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `Path(d:)` — the chart family's escape hatch. Coordinates are data units,
 * so the parser has to hand back absolute commands the chart can push through
 * its one affine transform.
 */
class ChartPathDataTest {
    private fun ops(d: String) = parseChartPath(d).map { it.op }

    @Test
    fun `absolute moveto and lineto survive intact`() {
        val commands = parseChartPath("M0,0 L10,10")
        assertEquals(listOf('M', 'L'), commands.map { it.op })
        assertEquals(listOf(0.0, 0.0), commands[0].coords)
        assertEquals(listOf(10.0, 10.0), commands[1].coords)
    }

    @Test
    fun `relative commands are resolved against the current point`() {
        val commands = parseChartPath("m1 1 l2 3")
        assertEquals(listOf(1.0, 1.0), commands[0].coords)
        assertEquals(listOf(3.0, 4.0), commands[1].coords)
    }

    @Test
    fun `horizontal and vertical shorthands become linetos`() {
        val commands = parseChartPath("M1,1 H5 V9 h1 v1")
        assertEquals(listOf('M', 'L', 'L', 'L', 'L'), commands.map { it.op })
        assertEquals(listOf(5.0, 1.0), commands[1].coords)
        assertEquals(listOf(5.0, 9.0), commands[2].coords)
        assertEquals(listOf(6.0, 9.0), commands[3].coords)
        assertEquals(listOf(6.0, 10.0), commands[4].coords)
    }

    @Test
    fun `repeated coordinate pairs after a moveto are implicit linetos`() {
        assertEquals(listOf('M', 'L', 'L'), ops("M0,0 1,1 2,2"))
    }

    @Test
    fun `cubic and its smooth shorthand both emit cubics`() {
        val commands = parseChartPath("M0,0 C1,1 2,2 3,3 S4,4 5,5")
        assertEquals(listOf('M', 'C', 'C'), commands.map { it.op })
        // S reflects the previous control point: 2*3 - 2 = 4.
        assertEquals(4.0, commands[2].coords[0], 1e-9)
        assertEquals(4.0, commands[2].coords[1], 1e-9)
    }

    @Test
    fun `quadratic and its smooth shorthand both emit quadratics`() {
        val commands = parseChartPath("M0,0 Q1,2 3,0 T6,0")
        assertEquals(listOf('M', 'Q', 'Q'), commands.map { it.op })
        assertEquals(listOf(5.0, -2.0, 6.0, 0.0), commands[2].coords)
    }

    @Test
    fun `close returns the pen to the subpath start`() {
        val commands = parseChartPath("M2,2 L5,5 Z l1,1")
        assertEquals(listOf('M', 'L', 'Z', 'L'), commands.map { it.op })
        assertEquals(listOf(3.0, 3.0), commands[3].coords)
    }

    @Test
    fun `an arc degrades to a line to its endpoint rather than vanishing`() {
        val commands = parseChartPath("M0,0 A5,5 0 0 1 10,10")
        assertEquals(listOf('M', 'L'), commands.map { it.op })
        assertEquals(listOf(10.0, 10.0), commands[1].coords)
    }

    @Test
    fun `terse svg number forms tokenize correctly`() {
        assertEquals(
            listOf("M", "1", "-2", "L", ".5", ".5"),
            tokenizeChartPath("M1-2L.5.5"),
        )
        assertEquals(listOf("M", "1e2", "2"), tokenizeChartPath("M1e2 2"))
    }

    @Test
    fun `garbage and truncated input terminate instead of looping`() {
        assertTrue(parseChartPath("").isEmpty())
        assertTrue(parseChartPath("   ").isEmpty())
        assertTrue(parseChartPath("nonsense").isEmpty())
        // A command with too few operands stops cleanly at the last complete one.
        assertEquals(listOf('M'), ops("M0,0 L5"))
        assertEquals(listOf('M', 'Z'), ops("M0,0 Z 1 2 3"))
    }
}
