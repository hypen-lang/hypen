package space.hypen.renderer.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Interaction: every event on a mark carries the datum it refers to, in data
 * units, never pixels — so module handlers work identically on every
 * renderer. Also pins which marks are allowed to take the pointer at all.
 */
class ChartInteractionTest {
    private val plotLeft = ChartDefaults.BARE_INSET
    private val plotRight = ChartDefaults.WIDTH - ChartDefaults.BARE_INSET
    private val plotTop = ChartDefaults.BARE_INSET
    private val plotBottom = ChartDefaults.HEIGHT - ChartDefaults.BARE_INSET

    private val rows = listOf(
        mapOf("month" to "Jan", "count" to 10),
        mapOf("month" to "Feb", "count" to 30),
        mapOf("month" to "Mar", "count" to 20),
    )

    private fun mark(kind: ChartMarkKind, props: Map<String, Any?>, id: String = kind.typeName) =
        ChartMark.of(id, kind, props)

    private fun layout(
        chartProps: Map<String, Any?> = emptyMap(),
        marks: List<ChartMark> = emptyList(),
    ) = computeChartLayout(chartProps, marks, ChartDefaults.WIDTH, ChartDefaults.HEIGHT)

    // ---- payload -----------------------------------------------------------

    @Test
    fun `a hit on a bar dispatches series, index, x, y and the original row`() {
        val bars = mark(
            ChartMarkKind.BARS,
            mapOf("data" to rows, "x" to "month", "y" to "count", "series" to "units"),
            "b",
        )
        val l = layout(marks = listOf(bars))
        val payload = resolveChartMarkPayload(bars, l, hitIndex = 1)
        assertEquals("units", payload["series"])
        assertEquals(1, payload["index"])
        assertEquals("Feb", payload["x"])
        assertEquals(30.0, payload["y"])
        assertSame(rows[1], payload["datum"])
    }

    @Test
    fun `the series name falls back to the mark kind`() {
        val line = mark(ChartMarkKind.LINE, mapOf("points" to listOf(1)))
        assertEquals("line", chartSeriesName(line))
        assertEquals(
            "revenue",
            chartSeriesName(mark(ChartMarkKind.LINE, mapOf("points" to listOf(1), "name" to "revenue"))),
        )
    }

    @Test
    fun `a hit on the line body resolves the datum nearest the pointer along x`() {
        val line = mark(ChartMarkKind.LINE, mapOf("points" to listOf(1, 5, 9)))
        val l = layout(chartProps = mapOf("x" to listOf(0, 2), "y" to listOf(0, 10)), marks = listOf(line))
        val mid = (plotLeft + plotRight) / 2
        val payload = resolveChartMarkPayload(line, l, pointerX = mid + 10)
        assertEquals("line", payload["series"])
        assertEquals(1, payload["index"])
        assertEquals(1.0, payload["x"])
        assertEquals(5.0, payload["y"])
    }

    @Test
    fun `a pointer past the last vertex clamps to the last datum`() {
        val line = mark(ChartMarkKind.LINE, mapOf("points" to listOf(1, 5, 9)))
        val l = layout(chartProps = mapOf("x" to listOf(0, 2)), marks = listOf(line))
        assertEquals(2, resolveChartMarkPayload(line, l, pointerX = 9999.0)["index"])
        assertEquals(0, resolveChartMarkPayload(line, l, pointerX = -9999.0)["index"])
    }

    @Test
    fun `a direct hit wins over the nearest-x fallback`() {
        val points = mark(ChartMarkKind.POINTS, mapOf("points" to listOf(1, 5, 9)))
        val l = layout(chartProps = mapOf("x" to listOf(0, 2)), marks = listOf(points))
        val payload = resolveChartMarkPayload(points, l, pointerX = 9999.0, hitIndex = 0)
        assertEquals(0, payload["index"])
    }

    @Test
    fun `a mark with no data resolves to the series alone`() {
        val line = mark(ChartMarkKind.LINE, mapOf("points" to emptyList<Any>(), "name" to "revenue"))
        val payload = resolveChartMarkPayload(line, layout(marks = listOf(line)), pointerX = 100.0)
        assertEquals(mapOf<String, Any?>("series" to "revenue"), payload)
        // An Axis carries no data at all, whatever the pointer says.
        val axis = mark(ChartMarkKind.AXIS, mapOf("0" to "x"))
        assertEquals(setOf("series"), resolveChartMarkPayload(axis, layout(), pointerX = 1.0).keys)
    }

    @Test
    fun `chart-level events resolve the pointer to data coordinates`() {
        val line = mark(ChartMarkKind.LINE, mapOf("points" to listOf(listOf(0, 0))))
        val l = layout(
            chartProps = mapOf("x" to listOf(0, 100), "y" to listOf(0, 10)),
            marks = listOf(line),
        )
        val payload = resolveChartPointerPayload(l, (plotLeft + plotRight) / 2, plotTop)
        assertEquals(50.0, payload["x"] as Double, 1e-6)
        assertEquals(10.0, payload["y"] as Double, 1e-6)
    }

    @Test
    fun `a band x resolves to the category name`() {
        val bars = mark(
            ChartMarkKind.BARS,
            mapOf("data" to rows, "x" to "month", "y" to "count"),
            "b",
        )
        val l = layout(marks = listOf(bars))
        assertEquals("Jan", resolveChartPointerPayload(l, plotLeft + 1.0, plotBottom)["x"])
        assertEquals("Mar", resolveChartPointerPayload(l, plotRight - 1.0, plotBottom)["x"])
        // Past the edges the category clamps rather than throwing.
        assertEquals("Jan", resolveChartPointerPayload(l, -500.0, 0.0)["x"])
        assertEquals("Mar", resolveChartPointerPayload(l, 5000.0, 0.0)["x"])
    }

    // ---- hit testing -------------------------------------------------------

    @Test
    fun `a tap inside a bar names that bar`() {
        val bars = mark(ChartMarkKind.BARS, mapOf("data" to listOf(10, 30, 20)), "b")
        val l = layout(marks = listOf(bars))
        val rect = chartBars(bars, l)[1]
        val hit = chartHitTest(bars, l, rect.left + rect.width / 2, rect.top + rect.height / 2)
        assertEquals(1, hit?.index)
        // Above the bar's top there is nothing to hit.
        assertNull(chartHitTest(bars, l, rect.left + rect.width / 2, rect.top - 20.0))
    }

    @Test
    fun `points carry an invisible touch target larger than what is drawn`() {
        val points = mark(ChartMarkKind.POINTS, mapOf("points" to listOf(listOf(1, 1))), "p")
        val l = layout(chartProps = mapOf("x" to listOf(0, 2), "y" to listOf(0, 2)), marks = listOf(points))
        val circle = chartPoints(points, l)[0]
        assertTrue(circle.radius < ChartDefaults.HIT_RADIUS)
        assertEquals(0, chartHitTest(points, l, circle.cx + 10.0, circle.cy)?.index)
        assertNull(chartHitTest(points, l, circle.cx + 40.0, circle.cy))
    }

    @Test
    fun `a line vertex is a direct hit and its body is not`() {
        val line = mark(ChartMarkKind.LINE, mapOf("points" to listOf(1, 5, 9)), "l")
        val l = layout(chartProps = mapOf("x" to listOf(0, 2), "y" to listOf(0, 10)), marks = listOf(line))
        val vertices = chartProject(line, l)
        assertEquals(2, chartHitTest(line, l, vertices[2].px, vertices[2].py)?.index)
        // Mid-segment: hit, but with no index, so it falls to nearest-x.
        val midX = (vertices[0].px + vertices[1].px) / 2
        val midY = (vertices[0].py + vertices[1].py) / 2
        val hit = chartHitTest(line, l, midX, midY)
        assertNotNull(hit)
        assertNull(hit!!.index)
        // Far from the line: nothing.
        assertNull(chartHitTest(line, l, midX, plotTop))
    }

    @Test
    fun `an axis and a marker never take the pointer themselves`() {
        val axis = mark(ChartMarkKind.AXIS, mapOf("0" to "x"), "ax")
        val marker = mark(ChartMarkKind.MARKER, mapOf("x" to 1, "y" to 1), "m")
        val l = layout(marks = listOf(axis, marker))
        assertNull(chartHitTest(axis, l, l.plot.left + 1, l.plot.bottom))
        assertNull(chartHitTest(marker, l, l.plot.left + 1, l.plot.bottom))
    }

    // ---- event applicators -------------------------------------------------

    @Test
    fun `event applicator arguments regroup into an action with its static args`() {
        val action = chartAction(
            mapOf("onClick.0" to "@actions.pick", "onClick.tag" to "targets"),
            ChartEvent.CLICK,
        )!!
        assertEquals("pick", action.actionName)
        assertEquals(mapOf<String, Any?>("tag" to "targets"), action.payload)
    }

    @Test
    fun `a bare action reference works, and aliases resolve to the same event`() {
        assertEquals("pick", chartAction(mapOf("onClick" to "@actions.pick"), ChartEvent.CLICK)?.actionName)
        assertEquals("pick", chartAction(mapOf("onPress.0" to "@actions.pick"), ChartEvent.CLICK)?.actionName)
        assertEquals(
            "detail",
            chartAction(mapOf("onLongPress.0" to "@actions.detail"), ChartEvent.LONG_PRESS)?.actionName,
        )
        assertEquals(
            "track",
            chartAction(mapOf("onMove.0" to "@actions.track"), ChartEvent.MOVE)?.actionName,
        )
        assertNull(chartAction(mapOf("onClick.0" to "not an action"), ChartEvent.CLICK))
        assertNull(chartAction(emptyMap(), ChartEvent.CLICK))
    }

    @Test
    fun `a chart with no event applicator anywhere never installs a pointer handler`() {
        val decorative = mark(ChartMarkKind.LINE, mapOf("points" to listOf(1, 2)), "l")
        assertFalse(chartIsInteractive(emptyMap(), listOf(decorative)))
        assertTrue(
            chartIsInteractive(
                emptyMap(),
                listOf(mark(ChartMarkKind.LINE, mapOf("points" to listOf(1, 2), "onMove.0" to "@actions.t"), "l")),
            ),
        )
        assertTrue(chartIsInteractive(mapOf("onClick.0" to "@actions.plot"), emptyList()))
    }

    @Test
    fun `a decorative mark never steals the pointer from an interactive one`() {
        // The tooltip case: a Points/Marker drawn under the pointer must not
        // take the hover away from the Line being tracked.
        val line = mark(
            ChartMarkKind.LINE,
            mapOf("points" to listOf(1, 5, 9), "onMove.0" to "@actions.track"),
            "l",
        )
        val decoration = mark(ChartMarkKind.POINTS, mapOf("points" to listOf(listOf(1, 5))), "p")
        val l = layout(
            chartProps = mapOf("x" to listOf(0, 2), "y" to listOf(0, 10)),
            marks = listOf(line, decoration),
        )
        val vertex = chartProject(line, l)[1]
        val target = chartResolveTarget(emptyMap(), l.marks, l, ChartEvent.MOVE, vertex.px, vertex.py)!!
        assertEquals("l", target.mark?.id)
        assertEquals(1, target.hitIndex)
    }

    @Test
    fun `a miss on every mark falls through to the chart's own event`() {
        val bars = mark(
            ChartMarkKind.BARS,
            mapOf("data" to listOf(1), "onClick.0" to "@actions.pick"),
            "b",
        )
        val chartProps = mapOf<String, Any?>("onClick.0" to "@actions.plot")
        val l = computeChartLayout(chartProps, listOf(bars), ChartDefaults.WIDTH, ChartDefaults.HEIGHT)
        val target = chartResolveTarget(chartProps, l.marks, l, ChartEvent.CLICK, plotLeft + 1, plotTop + 1)!!
        assertNull(target.mark)
        assertEquals("plot", target.action.actionName)
    }

    @Test
    fun `no handler anywhere resolves to no target`() {
        val bars = mark(ChartMarkKind.BARS, mapOf("data" to listOf(1)), "b")
        val l = layout(marks = listOf(bars))
        assertNull(chartResolveTarget(emptyMap(), l.marks, l, ChartEvent.CLICK, plotLeft + 1, plotTop + 1))
    }

    // ---- styling -----------------------------------------------------------

    @Test
    fun `each mark kind carries the reference presentation defaults`() {
        val line = resolveChartMarkStyle(ChartMarkKind.LINE, emptyMap())
        assertFalse(line.hasFill)
        assertTrue(line.hasStroke)
        assertEquals(2.0, line.strokeWidth, 1e-9)

        val area = resolveChartMarkStyle(ChartMarkKind.AREA, emptyMap())
        assertFalse(area.hasStroke)
        assertEquals(ChartDefaults.AREA_FILL_OPACITY, area.fillOpacity, 1e-9)

        val axis = resolveChartMarkStyle(ChartMarkKind.AXIS, emptyMap())
        assertEquals(ChartDefaults.AXIS_STROKE_OPACITY, axis.strokeOpacity, 1e-9)
        assertEquals(ChartDefaults.AXIS_LABEL_OPACITY, axis.fillOpacity, 1e-9)

        val rule = resolveChartMarkStyle(ChartMarkKind.RULE, emptyMap())
        assertEquals(listOf(4.0, 4.0), rule.dash)
        assertEquals(ChartDefaults.RULE_STROKE_OPACITY, rule.strokeOpacity, 1e-9)

        assertFalse(resolveChartMarkStyle(ChartMarkKind.BARS, emptyMap()).hasStroke)
        assertTrue(resolveChartMarkStyle(ChartMarkKind.BARS, emptyMap()).hasFill)
    }

    @Test
    fun `authored applicators override the defaults`() {
        val style = resolveChartMarkStyle(
            ChartMarkKind.LINE,
            mapOf(
                "stroke.0" to "#3b82f6",
                "strokeWidth.0" to 3,
                "opacity.0" to 0.5,
                "strokeDasharray.0" to "4 2",
                "strokeLinecap.0" to "square",
            ),
        )
        assertEquals("#3b82f6", style.stroke)
        assertEquals(3.0, style.strokeWidth, 1e-9)
        assertEquals(0.5, style.opacity, 1e-9)
        assertEquals(listOf(4.0, 2.0), style.dash)
        assertEquals("square", style.strokeCap)
    }

    @Test
    fun `glow accepts a colour, a radius or both`() {
        assertEquals(
            ChartGlow("#10b981", ChartDefaults.GLOW_RADIUS),
            chartGlow(mapOf("glow.0" to "#10b981")),
        )
        assertEquals(ChartGlow(null, 8.0), chartGlow(mapOf("glow.0" to 8)))
        assertEquals(
            ChartGlow("gold", 10.0),
            chartGlow(mapOf("glow.0" to mapOf("color" to "gold", "radius" to 10))),
        )
        assertNull(chartGlow(emptyMap()))
    }

    @Test
    fun `the shadow family means a shape shadow on a mark`() {
        assertEquals(
            ChartGlow("#000", 8.0, 0.0, 2.0),
            chartGlow(mapOf("shadow.0" to mapOf("y" to 2, "blur" to 8, "color" to "#000"))),
        )
        assertEquals(
            ChartGlow("red", 4.0, 0.0, 0.0),
            chartGlow(mapOf("boxShadow.0" to "0 0 4px red")),
        )
        assertEquals(ChartGlow(null, 3.0, 0.0, 2.0), chartGlow(mapOf("elevation.0" to 2)))
    }

    @Test
    fun `a dash needs at least two lengths to be a dash`() {
        assertNull(chartDash("4"))
        assertNull(chartDash(null))
        assertEquals(listOf(4.0, 4.0), chartDash(listOf(4, 4)))
        assertEquals(listOf(6.0, 2.0), chartDash("6,2"))
    }
}
