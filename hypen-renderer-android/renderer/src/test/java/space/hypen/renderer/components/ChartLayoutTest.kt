package space.hypen.renderer.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.HypenElement

/**
 * Domain resolution, insets and mark geometry.
 *
 * The host is the default 320x200 with the bare 4dp inset, so every number
 * below is the same one the DOM renderer's contract test asserts — the two
 * renderers place a datum at the same coordinate.
 */
class ChartLayoutTest {
    @Test fun namedEffectArgumentsFromEnginePatches() {
        val glow = chartGlow(mapOf("glow.color" to "#d6fc74", "glow.radius" to 4))!!
        assertEquals("#d6fc74", glow.color)
        assertEquals(4.0, glow.radius, 0.001)
        val shadow = chartGlow(mapOf("shadow.color" to "#000000", "shadow.blur" to 8, "shadow.y" to 2))!!
        assertEquals(8.0, shadow.radius, 0.001)
        assertEquals(2.0, shadow.dy, 0.001)
    }

    private val plotLeft = ChartDefaults.BARE_INSET
    private val plotTop = ChartDefaults.BARE_INSET
    private val plotRight = ChartDefaults.WIDTH - ChartDefaults.BARE_INSET
    private val plotBottom = ChartDefaults.HEIGHT - ChartDefaults.BARE_INSET

    private fun mark(kind: ChartMarkKind, props: Map<String, Any?>, id: String = kind.typeName) =
        ChartMark.of(id, kind, props)

    private fun layout(
        chartProps: Map<String, Any?> = emptyMap(),
        marks: List<ChartMark> = emptyList(),
        width: Double = ChartDefaults.WIDTH,
        height: Double = ChartDefaults.HEIGHT,
    ) = computeChartLayout(chartProps, marks, width, height)

    // ---- domains -----------------------------------------------------------

    @Test
    fun `explicit x and y ranges on the chart win`() {
        val l = layout(
            chartProps = mapOf("x" to listOf(0, 10), "y" to listOf(0, 100)),
            marks = listOf(mark(ChartMarkKind.LINE, mapOf("points" to listOf(listOf(2, 50))))),
        )
        assertEquals(0.0, l.x.min, 1e-9)
        assertEquals(10.0, l.x.max, 1e-9)
        assertEquals(0.0, l.y.min, 1e-9)
        assertEquals(100.0, l.y.max, 1e-9)
    }

    @Test
    fun `without ranges the y domain is the nice-rounded union of the marks`() {
        val l = layout(
            marks = listOf(
                mark(ChartMarkKind.LINE, mapOf("points" to listOf(listOf(0, 12), listOf(1, 47))), "a"),
                mark(ChartMarkKind.POINTS, mapOf("points" to listOf(listOf(0, 63))), "b"),
            ),
        )
        assertEquals(0.0, l.x.min, 1e-9)
        assertEquals(1.0, l.x.max, 1e-9)
        assertEquals(chartNiceDomain(12.0, 63.0, ChartDefaults.TICKS), l.y.min to l.y.max)
        assertTrue(l.y.min <= 12.0)
        assertTrue(l.y.max >= 63.0)
    }

    @Test
    fun `bars always include zero so bar heights are honest`() {
        val l = layout(marks = listOf(mark(ChartMarkKind.BARS, mapOf("data" to listOf(40, 50, 60)))))
        assertEquals(0.0, l.y.min, 1e-9)
    }

    @Test
    fun `a string x anywhere switches x to categorical bands in first-seen order`() {
        val l = layout(
            marks = listOf(
                mark(
                    ChartMarkKind.BARS,
                    mapOf(
                        "data" to listOf(
                            mapOf("x" to "Jan", "y" to 1),
                            mapOf("x" to "Feb", "y" to 2),
                            mapOf("x" to "Jan", "y" to 3),
                        ),
                    ),
                ),
            ),
        )
        assertTrue(l.x.isBand)
        assertEquals(listOf("Jan", "Feb"), l.x.categories)
    }

    @Test
    fun `rule and marker coordinates widen the domain`() {
        val l = layout(
            marks = listOf(
                mark(ChartMarkKind.LINE, mapOf("points" to listOf(1, 2)), "l"),
                mark(ChartMarkKind.RULE, mapOf("y" to 500), "r"),
            ),
        )
        assertTrue(l.y.max >= 500.0)
    }

    @Test
    fun `a chart with no data at all still has a usable unit domain`() {
        val l = layout()
        assertEquals(0.0, l.y.min, 1e-9)
        assertEquals(1.0, l.y.max, 1e-9)
        assertFalse(l.x.isBand)
    }

    // ---- insets ------------------------------------------------------------

    @Test
    fun `a bare chart is drawn edge to edge - that is a sparkline`() {
        val l = layout(marks = listOf(mark(ChartMarkKind.LINE, mapOf("points" to listOf(1, 2)))))
        assertEquals(plotLeft, l.plot.left, 1e-9)
        assertEquals(plotTop, l.plot.top, 1e-9)
        assertEquals(plotRight, l.plot.right, 1e-9)
        assertEquals(plotBottom, l.plot.bottom, 1e-9)
    }

    @Test
    fun `axes reserve label room on the sides they label`() {
        val l = layout(
            marks = listOf(
                mark(ChartMarkKind.AXIS, mapOf("0" to "x"), "ax"),
                mark(ChartMarkKind.AXIS, mapOf("0" to "y"), "ay"),
                mark(ChartMarkKind.LINE, mapOf("points" to listOf(1, 2)), "l"),
            ),
        )
        assertEquals(ChartDefaults.INSET_LEFT, l.plot.left, 1e-9)
        assertEquals(ChartDefaults.INSET_TOP, l.plot.top, 1e-9)
        assertEquals(ChartDefaults.HEIGHT - ChartDefaults.INSET_BOTTOM, l.plot.bottom, 1e-9)
        assertEquals(ChartDefaults.WIDTH - ChartDefaults.INSET_RIGHT, l.plot.right, 1e-9)
    }

    @Test
    fun `an x axis alone leaves the left edge bare`() {
        val l = layout(marks = listOf(mark(ChartMarkKind.AXIS, mapOf("0" to "x"))))
        assertEquals(ChartDefaults.BARE_INSET, l.plot.left, 1e-9)
        assertEquals(ChartDefaults.HEIGHT - ChartDefaults.INSET_BOTTOM, l.plot.bottom, 1e-9)
    }

    @Test
    fun `an explicit padding prop overrides every inset`() {
        val l = layout(
            chartProps = mapOf("padding" to 20),
            marks = listOf(mark(ChartMarkKind.AXIS, mapOf("0" to "y"))),
        )
        assertEquals(20.0, l.plot.left, 1e-9)
        assertEquals(20.0, l.plot.top, 1e-9)
        assertEquals(ChartDefaults.WIDTH - 20.0, l.plot.right, 1e-9)
    }

    // ---- geometry ----------------------------------------------------------

    @Test
    fun `bars sit on the zero line with heights proportional to their value`() {
        val bars = mark(ChartMarkKind.BARS, mapOf("data" to listOf(25, 100)))
        val l = layout(chartProps = mapOf("y" to listOf(0, 100)), marks = listOf(bars))
        val rects = chartBars(bars, l)
        assertEquals(2, rects.size)
        val plotHeight = plotBottom - plotTop
        assertEquals(plotHeight, rects[1].height, 0.1)
        assertEquals(plotHeight / 4, rects[0].height, 0.1)
        assertEquals(plotBottom, rects[0].top + rects[0].height, 0.1)
        assertEquals(0, rects[0].datum.index)
        assertEquals(1, rects[1].datum.index)
    }

    @Test
    fun `bar width is a ratio of the band step and is centred on x`() {
        val bars = mark(ChartMarkKind.BARS, mapOf("data" to listOf(1, 2)))
        val l = layout(marks = listOf(bars))
        val rects = chartBars(bars, l)
        val step = (plotRight - plotLeft) / 2
        assertEquals(step * ChartDefaults.BAR_WIDTH, rects[0].width, 1e-9)
        val centre = l.x.map(0.0)!!
        assertEquals(centre, rects[0].left + rects[0].width / 2, 1e-9)
    }

    @Test
    fun `highlight keeps the chosen bars and dims the rest`() {
        val bars = mark(ChartMarkKind.BARS, mapOf("data" to listOf(1, 2, 3), "highlight" to 1))
        val rects = chartBars(bars, layout(marks = listOf(bars)))
        assertTrue(rects[1].highlighted)
        assertFalse(rects[1].dimmed)
        assertTrue(rects[0].dimmed)
        assertTrue(rects[2].dimmed)
    }

    @Test
    fun `without a highlight nothing is dimmed`() {
        val bars = mark(ChartMarkKind.BARS, mapOf("data" to listOf(1, 2)))
        assertTrue(chartBars(bars, layout(marks = listOf(bars))).none { it.dimmed })
    }

    @Test
    fun `a line projects its first vertex onto the plot origin`() {
        val line = mark(ChartMarkKind.LINE, mapOf("points" to listOf(0, 10, 5)))
        val l = layout(chartProps = mapOf("x" to listOf(0, 2), "y" to listOf(0, 10)), marks = listOf(line))
        val points = chartProject(line, l)
        assertEquals(3, points.size)
        assertEquals(plotLeft, points[0].px, 1e-9)
        assertEquals(plotBottom, points[0].py, 1e-9)
        assertEquals(plotRight, points[2].px, 1e-9)
    }

    @Test
    fun `smooth emits one cubic per segment and needs three points`() {
        val line = mark(ChartMarkKind.LINE, mapOf("points" to listOf(1, 3, 2, 4), "smooth" to true))
        val l = layout(marks = listOf(line))
        assertTrue(chartIsSmooth(line))
        assertEquals(3, chartSmoothCubics(chartProject(line, l)).size)
        val short = mark(ChartMarkKind.LINE, mapOf("points" to listOf(1, 3)))
        assertTrue(chartSmoothCubics(chartProject(short, layout(marks = listOf(short)))).isEmpty())
    }

    @Test
    fun `the area baseline is the zero line clamped into the y domain`() {
        val area = mark(ChartMarkKind.AREA, mapOf("points" to listOf(5, 10)))
        val zeroInside = layout(chartProps = mapOf("y" to listOf(0, 10)), marks = listOf(area))
        assertEquals(plotBottom, chartBaseline(zeroInside), 1e-9)
        // A domain that never reaches zero clamps the floor to its own minimum.
        val zeroOutside = layout(chartProps = mapOf("y" to listOf(5, 10)), marks = listOf(area))
        assertEquals(plotBottom, chartBaseline(zeroOutside), 1e-9)
    }

    @Test
    fun `points default to the 3 point 5 dp radius and honour radius`() {
        val small = mark(ChartMarkKind.POINTS, mapOf("points" to listOf(listOf(1, 1))))
        assertEquals(
            ChartDefaults.POINT_RADIUS,
            chartPoints(small, layout(marks = listOf(small)))[0].radius,
            1e-9,
        )
        val big = mark(ChartMarkKind.POINTS, mapOf("points" to listOf(listOf(1, 1)), "radius" to 5))
        assertEquals(5.0, chartPoints(big, layout(marks = listOf(big)))[0].radius, 1e-9)
    }

    @Test
    fun `an x axis labels every category and appends its title`() {
        val bars = mark(
            ChartMarkKind.BARS,
            mapOf("data" to listOf(mapOf("x" to "Jan", "y" to 10), mapOf("x" to "Feb", "y" to 90))),
            "b",
        )
        val axis = mark(ChartMarkKind.AXIS, mapOf("0" to "x", "label" to "Month"), "ax")
        val l = layout(chartProps = mapOf("y" to listOf(0, 100)), marks = listOf(axis, bars))
        val geometry = chartAxis(axis, l)
        assertFalse(geometry.vertical)
        assertEquals(listOf("Jan", "Feb"), geometry.labels.map { it.text })
        assertEquals("Month", geometry.title?.text)
        assertEquals(l.plot.bottom, geometry.axisLine.y1, 1e-9)
    }

    @Test
    fun `a y axis labels nice ticks and its line runs down the plot`() {
        val axis = mark(ChartMarkKind.AXIS, mapOf("0" to "y", "ticks" to 2), "ay")
        val l = layout(chartProps = mapOf("y" to listOf(0, 100)), marks = listOf(axis))
        val geometry = chartAxis(axis, l)
        assertTrue(geometry.vertical)
        assertEquals(listOf("0", "50", "100"), geometry.labels.map { it.text })
        assertEquals(ChartTextAlign.END, geometry.labels[0].align)
        assertEquals(l.plot.left, geometry.axisLine.x1, 1e-9)
        assertEquals(l.plot.top, geometry.axisLine.y1, 1e-9)
        assertEquals(l.plot.bottom, geometry.axisLine.y2, 1e-9)
    }

    @Test
    fun `grid lines span the plot and are off by default`() {
        val axis = mark(ChartMarkKind.AXIS, mapOf("0" to "y", "grid" to true, "ticks" to 1), "ay")
        val l = layout(chartProps = mapOf("y" to listOf(0, 10)), marks = listOf(axis))
        val grid = chartAxis(axis, l).grid
        assertTrue(grid.isNotEmpty())
        assertEquals(l.plot.right, grid[0].x2, 1e-9)
        val plain = mark(ChartMarkKind.AXIS, mapOf("0" to "y"), "ay2")
        assertTrue(chartAxis(plain, layout(marks = listOf(plain))).grid.isEmpty())
    }

    @Test
    fun `rule at a y value is a full-width line at that level`() {
        val rule = mark(ChartMarkKind.RULE, mapOf("y" to 5))
        val l = layout(chartProps = mapOf("x" to listOf(0, 1), "y" to listOf(0, 10)), marks = listOf(rule))
        val segment = chartRule(rule, l)!!
        assertEquals(plotLeft, segment.x1, 1e-9)
        assertEquals(plotRight, segment.x2, 1e-9)
        assertEquals((plotTop + plotBottom) / 2, segment.y1, 0.1)
        assertEquals(listOf(4.0, 4.0), resolveChartMarkStyle(ChartMarkKind.RULE, rule.props).dash)
    }

    @Test
    fun `rule at an x value runs down the plot`() {
        val rule = mark(ChartMarkKind.RULE, mapOf("x" to 1))
        val l = layout(chartProps = mapOf("x" to listOf(0, 2), "y" to listOf(0, 10)), marks = listOf(rule))
        val segment = chartRule(rule, l)!!
        assertEquals(plotTop, segment.y1, 1e-9)
        assertEquals(plotBottom, segment.y2, 1e-9)
        assertEquals((plotLeft + plotRight) / 2, segment.x1, 0.1)
    }

    // ---- marker ------------------------------------------------------------

    @Test
    fun `a marker sits at the data coordinate and records its anchor`() {
        val marker = mark(ChartMarkKind.MARKER, mapOf("x" to 10, "y" to 10, "anchor" to "left"))
        val l = layout(chartProps = mapOf("x" to listOf(0, 10), "y" to listOf(0, 10)), marks = listOf(marker))
        val placement = chartMarker(marker, l)!!
        assertEquals(plotRight, placement.px, 1e-9)
        assertEquals(plotTop, placement.py, 1e-9)
        assertEquals("left", placement.anchor)
    }

    @Test
    fun `a marker with no coordinates is hidden`() {
        val marker = mark(ChartMarkKind.MARKER, emptyMap())
        assertNull(chartMarker(marker, layout(marks = listOf(marker))))
    }

    @Test
    fun `one coordinate centres the marker on the other axis`() {
        val marker = mark(ChartMarkKind.MARKER, mapOf("y" to 5))
        val l = layout(chartProps = mapOf("x" to listOf(0, 10), "y" to listOf(0, 10)), marks = listOf(marker))
        val placement = chartMarker(marker, l)!!
        assertEquals((plotLeft + plotRight) / 2, placement.px, 0.1)
        assertEquals((plotTop + plotBottom) / 2, placement.py, 0.1)
        assertEquals("top", placement.anchor)
    }

    @Test
    fun `an unknown anchor falls back to top`() {
        val marker = mark(ChartMarkKind.MARKER, mapOf("x" to 1, "y" to 1, "anchor" to "sideways"))
        assertEquals("top", chartMarker(marker, layout(marks = listOf(marker)))!!.anchor)
    }

    @Test
    fun `anchors place the content around the data point`() {
        val gap = ChartDefaults.MARKER_GAP
        assertEquals(
            (100.0 - 20.0) to (50.0 - 10.0 - gap),
            chartMarkerOffset("top", 100.0, 50.0, 40.0, 10.0),
        )
        assertEquals((100.0 - 20.0) to (50.0 + gap), chartMarkerOffset("bottom", 100.0, 50.0, 40.0, 10.0))
        assertEquals((100.0 - 40.0 - gap) to 45.0, chartMarkerOffset("left", 100.0, 50.0, 40.0, 10.0))
        assertEquals((100.0 + gap) to 45.0, chartMarkerOffset("right", 100.0, 50.0, 40.0, 10.0))
        assertEquals(80.0 to 45.0, chartMarkerOffset("center", 100.0, 50.0, 40.0, 10.0))
    }

    // ---- path --------------------------------------------------------------

    @Test
    fun `a path is drawn in data units through one affine transform`() {
        val path = mark(ChartMarkKind.PATH, mapOf("d" to "M0,0 L10,10"))
        val l = layout(chartProps = mapOf("x" to listOf(0, 10), "y" to listOf(0, 10)), marks = listOf(path))
        val transform = chartPathTransform(l)
        assertEquals((plotRight - plotLeft) / 10, transform.sx, 1e-9)
        assertEquals((plotTop - plotBottom) / 10, transform.sy, 1e-9)
        assertEquals(plotLeft, transform.tx, 1e-9)
        assertEquals(plotBottom, transform.ty, 1e-9)
        assertEquals(plotRight, transform.mapX(10.0), 1e-9)
        assertEquals(plotTop, transform.mapY(10.0), 1e-9)
    }

    @Test
    fun `a path reads d from the positional argument too`() {
        assertEquals("M0,0", chartPathData(mark(ChartMarkKind.PATH, mapOf("0" to "M0,0"))))
        assertNull(chartPathData(mark(ChartMarkKind.PATH, mapOf("d" to "   "))))
    }

    // ---- host sizing -------------------------------------------------------

    @Test
    fun `the chart takes the default height unless the author sized it`() {
        assertFalse(chartHasAuthoredHeight(HypenElement(id = "c", elementType = "chart")))
        assertTrue(
            chartHasAuthoredHeight(
                HypenElement(id = "c", elementType = "chart", props = mapOf("height.0" to 240)),
            ),
        )
        assertTrue(
            chartHasAuthoredHeight(
                HypenElement(id = "c", elementType = "chart", props = mapOf("fillMaxHeight" to true)),
            ),
        )
        assertFalse(
            chartHasAuthoredHeight(
                HypenElement(id = "c", elementType = "chart", props = mapOf("width.0" to 240)),
            ),
        )
    }

    @Test
    fun `the plot never collapses to a negative size on a tiny host`() {
        val l = layout(
            marks = listOf(mark(ChartMarkKind.AXIS, mapOf("0" to "y"))),
            width = 10.0,
            height = 10.0,
        )
        assertTrue(l.plot.width >= 1.0)
        assertTrue(l.plot.height >= 1.0)
        assertNotNull(l.x.map(0.5))
    }
}
