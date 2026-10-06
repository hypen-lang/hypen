package space.hypen.renderer.components

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Chart layout — the geometry half of the `Chart` family, in plain Kotlin.
 *
 * [computeChartLayout] measures the host, resolves the x/y domains from the
 * chart's explicit ranges or the union of its marks' data, and every
 * `chart*Geometry` function below turns one mark into drawable shapes. All
 * coordinates are **dp**; [ChartComponent] scales to device pixels at draw
 * time.
 *
 * Nothing here touches Compose, so the whole contract — insets, domains, bar
 * heights, axis ticks, Marker anchoring, nearest-x payload resolution — is
 * covered by ordinary JVM unit tests.
 */

/** A rectangle in dp. */
data class ChartRect(
    val left: Double,
    val top: Double,
    val width: Double,
    val height: Double,
) {
    val right: Double get() = left + width
    val bottom: Double get() = top + height
}

/** One mark child of a chart, with its list prop already normalised. */
data class ChartMark(
    val id: String,
    val kind: ChartMarkKind,
    val props: Map<String, Any?>,
    val data: List<ChartDatum>,
) {
    companion object {
        fun of(id: String, kind: ChartMarkKind, props: Map<String, Any?>): ChartMark =
            ChartMark(
                id = id,
                kind = kind,
                props = props,
                data = if (kind.isData) normalizeChartData(props) else emptyList(),
            )
    }
}

/** The resolved coordinate space plus the marks that live in it. */
class ChartLayout(
    val width: Double,
    val height: Double,
    val plot: ChartRect,
    val x: ChartScale,
    val y: ChartScale,
    val marks: List<ChartMark>,
)

/** A projected datum: its position in dp, plus the row it came from. */
data class ChartPoint(val px: Double, val py: Double, val datum: ChartDatum)

data class ChartBar(
    val left: Double,
    val top: Double,
    val width: Double,
    val height: Double,
    val radius: Double,
    val datum: ChartDatum,
    val dimmed: Boolean,
    val highlighted: Boolean,
)

data class ChartCircle(
    val cx: Double,
    val cy: Double,
    val radius: Double,
    val datum: ChartDatum,
    val dimmed: Boolean,
    val highlighted: Boolean,
)

data class ChartSegment(val x1: Double, val y1: Double, val x2: Double, val y2: Double)

/** Horizontal placement of a tick/axis label relative to its anchor point. */
enum class ChartTextAlign { START, MIDDLE, END }

/** [y] is the text baseline, matching SVG's `<text y=…>` and Canvas alike. */
data class ChartLabel(
    val x: Double,
    val y: Double,
    val text: String,
    val align: ChartTextAlign,
    val rotated: Boolean = false,
)

data class ChartAxisGeometry(
    val vertical: Boolean,
    val axisLine: ChartSegment,
    val ticks: List<ChartSegment>,
    val grid: List<ChartSegment>,
    val labels: List<ChartLabel>,
    val title: ChartLabel?,
)

/** Where a `Marker` sits, and how its children hang off that point. */
data class ChartMarkerPlacement(val px: Double, val py: Double, val anchor: String)

/** `d` in data units is drawn through this one affine transform. */
data class ChartPathTransform(val sx: Double, val sy: Double, val tx: Double, val ty: Double) {
    fun mapX(x: Double): Double = x * sx + tx

    fun mapY(y: Double): Double = y * sy + ty
}

/** One Catmull-Rom-derived cubic segment of a smooth line. */
data class ChartCubic(
    val c1x: Double,
    val c1y: Double,
    val c2x: Double,
    val c2y: Double,
    val x: Double,
    val y: Double,
)

private val MARKER_ANCHORS = setOf("top", "bottom", "left", "right", "center")

internal fun chartBool(value: Any?): Boolean =
    when (value) {
        is Boolean -> value
        is Number -> value.toDouble() != 0.0
        is String -> value.equals("true", ignoreCase = true) || value == "1"
        else -> false
    }

/** `Axis(x)` / `Axis(y)`: named `axis:` or the positional argument. */
internal fun chartAxisOrientation(props: Map<String, Any?>): String {
    val raw = chartProp(props, "axis") ?: props["0"] ?: props["1"]
    return if (raw?.toString()?.lowercase() == "y") "y" else "x"
}

private fun hasAxis(marks: List<ChartMark>, which: String): Boolean =
    marks.any { it.kind == ChartMarkKind.AXIS && chartAxisOrientation(it.props) == which }

/**
 * Plot insets: `padding` wins, else axes reserve label room and a chart with
 * no axes is drawn edge to edge — that is a sparkline.
 */
fun chartInsets(chartProps: Map<String, Any?>, marks: List<ChartMark>): ChartRect {
    val padding = chartNumber(chartProp(chartProps, "padding"))
    if (padding != null) return ChartRect(padding, padding, padding, padding)
    val xAxis = hasAxis(marks, "x")
    val yAxis = hasAxis(marks, "y")
    if (!xAxis && !yAxis) {
        val b = ChartDefaults.BARE_INSET
        return ChartRect(b, b, b, b)
    }
    // left, top, right, bottom packed into a rect's four fields.
    return ChartRect(
        left = if (yAxis) ChartDefaults.INSET_LEFT else ChartDefaults.BARE_INSET,
        top = ChartDefaults.INSET_TOP,
        width = ChartDefaults.INSET_RIGHT,
        height = if (xAxis) ChartDefaults.INSET_BOTTOM else ChartDefaults.BARE_INSET,
    )
}

/**
 * Lay a chart out: insets, then domains, then scales over the plot area.
 *
 * Explicit `x:` / `y:` ranges on the chart win. Otherwise the domain is the
 * union of the data marks (plus any `Rule` / `Marker` coordinate); a string x
 * anywhere switches x to categorical bands in first-seen order, `Bars` force
 * y to include zero so bar heights stay honest, and the auto y domain is
 * rounded out to tick-friendly bounds.
 */
fun computeChartLayout(
    chartProps: Map<String, Any?>,
    marks: List<ChartMark>,
    width: Double,
    height: Double,
): ChartLayout {
    val inset = chartInsets(chartProps, marks)
    val plot = ChartRect(
        left = inset.left,
        top = inset.top,
        width = max(width - inset.left - inset.width, 1.0),
        height = max(height - inset.top - inset.height, 1.0),
    )

    val categories = ArrayList<String>()
    val seen = HashSet<String>()
    var xMin = Double.POSITIVE_INFINITY
    var xMax = Double.NEGATIVE_INFINITY
    var yMin = Double.POSITIVE_INFINITY
    var yMax = Double.NEGATIVE_INFINITY
    var anyData = false
    var bars = 0

    for (mark in marks) {
        if (mark.kind == ChartMarkKind.BARS) {
            bars = max(bars, mark.data.size)
            // Bars grow from zero: a bar chart whose data never touches 0
            // still has to show 0 or the bar heights lie.
            yMin = min(yMin, 0.0)
            yMax = max(yMax, 0.0)
        }
        if (mark.kind.isData) {
            for (d in mark.data) {
                anyData = true
                val dx = d.x
                if (dx is String) {
                    if (seen.add(dx)) categories.add(dx)
                } else if (dx is Double) {
                    xMin = min(xMin, dx)
                    xMax = max(xMax, dx)
                }
                yMin = min(yMin, d.y)
                yMax = max(yMax, d.y)
            }
        }
        if (mark.kind == ChartMarkKind.RULE || mark.kind == ChartMarkKind.MARKER) {
            chartNumber(chartProp(mark.props, "y"))?.let {
                yMin = min(yMin, it)
                yMax = max(yMax, it)
            }
            (chartX(chartProp(mark.props, "x")) as? Double)?.let {
                xMin = min(xMin, it)
                xMax = max(xMax, it)
            }
        }
    }

    val explicitX = chartRange(chartProp(chartProps, "x"))
    val explicitY = chartRange(chartProp(chartProps, "y"))

    val xRangeStart = plot.left
    val xRangeEnd = plot.right
    val yRangeStart = plot.bottom
    val yRangeEnd = plot.top

    val xScale: ChartScale
    if (categories.isNotEmpty()) {
        xScale = ChartScale.band(categories, xRangeStart, xRangeEnd)
    } else {
        var lo: Double
        var hi: Double
        if (explicitX != null) {
            lo = explicitX.first
            hi = explicitX.second
        } else if (xMin.isFinite()) {
            lo = xMin
            hi = xMax
        } else {
            lo = 0.0
            hi = 1.0
        }
        if (lo == hi) {
            lo -= 1.0
            hi += 1.0
        }
        xScale = ChartScale.linear(lo, hi, xRangeStart, xRangeEnd)
        // Numeric bars need a step to size their width from.
        xScale.band = when {
            bars > 1 -> (xRangeEnd - xRangeStart) / bars
            bars == 1 -> (xRangeEnd - xRangeStart) / 2
            else -> 0.0
        }
    }

    val yScale: ChartScale = when {
        explicitY != null -> ChartScale.linear(explicitY.first, explicitY.second, yRangeStart, yRangeEnd)
        yMin.isFinite() -> {
            val domain = if (anyData || bars > 0) {
                chartNiceDomain(yMin, yMax, ChartDefaults.TICKS)
            } else {
                yMin to yMax
            }
            ChartScale.linear(domain.first, domain.second, yRangeStart, yRangeEnd)
        }
        else -> ChartScale.linear(0.0, 1.0, yRangeStart, yRangeEnd)
    }

    return ChartLayout(width, height, plot, xScale, yScale, marks)
}

// ============================================================================
// Mark geometry
// ============================================================================

/** Data → dp for every row the scales can place. */
fun chartProject(mark: ChartMark, layout: ChartLayout): List<ChartPoint> {
    val out = ArrayList<ChartPoint>(mark.data.size)
    for (d in mark.data) {
        val px = layout.x.map(d.x) ?: continue
        val py = layout.y.map(d.y) ?: continue
        out.add(ChartPoint(px, py, d))
    }
    return out
}

/** The zero line, clamped into the y domain — Area's floor and Bars' base. */
fun chartBaseline(layout: ChartLayout): Double {
    val zero = min(max(0.0, layout.y.min), layout.y.max)
    return layout.y.map(zero) ?: layout.plot.bottom
}

/** Catmull-Rom → cubic Bézier, the usual "smooth" line. */
fun chartSmoothCubics(points: List<ChartPoint>): List<ChartCubic> {
    if (points.size < 3) return emptyList()
    val out = ArrayList<ChartCubic>(points.size - 1)
    for (i in 0 until points.size - 1) {
        val p0 = points[max(i - 1, 0)]
        val p1 = points[i]
        val p2 = points[i + 1]
        val p3 = points[min(i + 2, points.size - 1)]
        out.add(
            ChartCubic(
                c1x = p1.px + (p2.px - p0.px) / 6.0,
                c1y = p1.py + (p2.py - p0.py) / 6.0,
                c2x = p2.px - (p3.px - p1.px) / 6.0,
                c2y = p2.py - (p3.py - p1.py) / 6.0,
                x = p2.px,
                y = p2.py,
            ),
        )
    }
    return out
}

fun chartIsSmooth(mark: ChartMark): Boolean = chartBool(chartProp(mark.props, "smooth"))

/**
 * One rect per row, rising from the zero line and centred on its x.
 *
 * `barWidth` is a ratio of the band step (0.7 by default), `radius` rounds
 * the corners, and `highlight` keeps the chosen rows at full opacity while
 * dimming the rest.
 */
fun chartBars(mark: ChartMark, layout: ChartLayout): List<ChartBar> {
    val points = chartProject(mark, layout)
    if (points.isEmpty()) return emptyList()
    val ratio = chartNumber(chartProp(mark.props, "barWidth")) ?: ChartDefaults.BAR_WIDTH
    val step = if (layout.x.band > 0.0) {
        layout.x.band
    } else {
        layout.plot.width / max(points.size, 1)
    }
    val width = max(step * min(max(ratio, 0.05), 1.0), 1.0)
    val zero = chartBaseline(layout)
    val radius = chartNumber(chartProp(mark.props, "radius")) ?: 0.0
    val highlight = chartHighlight(chartProp(mark.props, "highlight"))
    return points.map { point ->
        val highlighted = highlight?.contains(point.datum.index) == true
        ChartBar(
            left = point.px - width / 2.0,
            top = min(point.py, zero),
            width = width,
            height = abs(zero - point.py),
            radius = radius,
            datum = point.datum,
            dimmed = highlight != null && !highlighted,
            highlighted = highlighted,
        )
    }
}

/** One circle per row, at the point radius (3.5 dp unless `radius:` says otherwise). */
fun chartPoints(mark: ChartMark, layout: ChartLayout): List<ChartCircle> {
    val radius = chartNumber(chartProp(mark.props, "radius")) ?: ChartDefaults.POINT_RADIUS
    val highlight = chartHighlight(chartProp(mark.props, "highlight"))
    return chartProject(mark, layout).map { point ->
        val highlighted = highlight?.contains(point.datum.index) == true
        ChartCircle(
            cx = point.px,
            cy = point.py,
            radius = radius,
            datum = point.datum,
            dimmed = highlight != null && !highlighted,
            highlighted = highlighted,
        )
    }
}

/** Axis line, 4 dp ticks, labels, and — with `grid: true` — plot-wide rules. */
fun chartAxis(mark: ChartMark, layout: ChartLayout): ChartAxisGeometry {
    val vertical = chartAxisOrientation(mark.props) == "y"
    val plot = layout.plot
    val count = chartNumber(chartProp(mark.props, "ticks"))?.toInt() ?: ChartDefaults.TICKS
    val grid = chartBool(chartProp(mark.props, "grid"))
    val title = chartProp(mark.props, "label") as? String
    val fontSize = ChartDefaults.FONT_SIZE
    val tickLines = ArrayList<ChartSegment>()
    val gridLines = ArrayList<ChartSegment>()
    val labels = ArrayList<ChartLabel>()

    if (!vertical) {
        val y = plot.bottom
        val axisLine = ChartSegment(plot.left, y, plot.right, y)
        val entries: List<Pair<Double, String>> = if (layout.x.isBand) {
            layout.x.categories.map { (layout.x.map(it) ?: 0.0) to it }
        } else {
            chartTicks(layout.x.min, layout.x.max, count)
                .map { (layout.x.map(it) ?: 0.0) to chartFormatTick(it) }
        }
        for ((px, text) in entries) {
            tickLines.add(ChartSegment(px, y, px, y + ChartDefaults.AXIS_TICK_LENGTH))
            if (grid) gridLines.add(ChartSegment(px, plot.top, px, y))
            labels.add(ChartLabel(px, y + 6.0 + fontSize, text, ChartTextAlign.MIDDLE))
        }
        val titleLabel = title?.let {
            ChartLabel(
                x = plot.left + plot.width / 2.0,
                y = min(layout.height - 2.0, y + 8.0 + fontSize * 2.0),
                text = it,
                align = ChartTextAlign.MIDDLE,
            )
        }
        return ChartAxisGeometry(false, axisLine, tickLines, gridLines, labels, titleLabel)
    }

    val x = plot.left
    val axisLine = ChartSegment(x, plot.top, x, plot.bottom)
    for (v in chartTicks(layout.y.min, layout.y.max, count)) {
        val py = layout.y.map(v) ?: continue
        tickLines.add(ChartSegment(x - ChartDefaults.AXIS_TICK_LENGTH, py, x, py))
        if (grid) gridLines.add(ChartSegment(x, py, plot.right, py))
        labels.add(ChartLabel(x - 7.0, py + fontSize / 3.0, chartFormatTick(v), ChartTextAlign.END))
    }
    val titleLabel = title?.let {
        ChartLabel(
            x = fontSize,
            y = plot.top + plot.height / 2.0,
            text = it,
            align = ChartTextAlign.MIDDLE,
            rotated = true,
        )
    }
    return ChartAxisGeometry(true, axisLine, tickLines, gridLines, labels, titleLabel)
}

/** A dashed reference line across the plot at `y:` (or down it at `x:`). */
fun chartRule(mark: ChartMark, layout: ChartLayout): ChartSegment? {
    val plot = layout.plot
    val y = chartNumber(chartProp(mark.props, "y"))
    if (y != null) {
        val py = layout.y.map(y) ?: return null
        return ChartSegment(plot.left, py, plot.right, py)
    }
    val x = chartX(chartProp(mark.props, "x")) ?: return null
    val px = layout.x.map(x) ?: return null
    return ChartSegment(px, plot.top, px, plot.bottom)
}

/**
 * Where a `Marker` pins its children.
 *
 * No coordinates at all — a tooltip bound to `state.hover` while it is null —
 * hides the marker, so no conditional is needed around it. One missing
 * coordinate centres it on that axis.
 */
fun chartMarker(mark: ChartMark, layout: ChartLayout): ChartMarkerPlacement? {
    val plot = layout.plot
    val x = chartX(chartProp(mark.props, "x"))
    val y = chartNumber(chartProp(mark.props, "y"))
    if (x == null && y == null) return null
    val px = if (x == null) plot.left + plot.width / 2.0 else layout.x.map(x) ?: return null
    val py = if (y == null) plot.top + plot.height / 2.0 else layout.y.map(y) ?: return null
    val anchor = (chartProp(mark.props, "anchor") as? String)?.lowercase() ?: "top"
    return ChartMarkerPlacement(px, py, if (anchor in MARKER_ANCHORS) anchor else "top")
}

/**
 * Top-left corner for a Marker's content, given its measured size.
 *
 * Mirrors the DOM renderer's anchor transforms: `top` lifts the content clear
 * of the point by [ChartDefaults.MARKER_GAP], `center` centres it on the point.
 */
fun chartMarkerOffset(
    anchor: String,
    px: Double,
    py: Double,
    contentWidth: Double,
    contentHeight: Double,
    gap: Double = ChartDefaults.MARKER_GAP,
): Pair<Double, Double> =
    when (anchor) {
        "bottom" -> (px - contentWidth / 2.0) to (py + gap)
        "left" -> (px - contentWidth - gap) to (py - contentHeight / 2.0)
        "right" -> (px + gap) to (py - contentHeight / 2.0)
        "center" -> (px - contentWidth / 2.0) to (py - contentHeight / 2.0)
        else -> (px - contentWidth / 2.0) to (py - contentHeight - gap)
    }

/** The `d` string of a `Path` mark: named `d:` or the positional argument. */
fun chartPathData(mark: ChartMark): String? =
    (chartProp(mark.props, "d") as? String ?: mark.props["0"] as? String)
        ?.takeIf { it.isNotBlank() }

/** Data units → dp as one affine transform; y flips because screens grow down. */
fun chartPathTransform(layout: ChartLayout): ChartPathTransform {
    val xSpan = (layout.x.max - layout.x.min).takeIf { it != 0.0 } ?: 1.0
    val ySpan = (layout.y.max - layout.y.min).takeIf { it != 0.0 } ?: 1.0
    val sx = (layout.plot.right - layout.plot.left) / xSpan
    val sy = (layout.plot.top - layout.plot.bottom) / ySpan
    return ChartPathTransform(
        sx = sx,
        sy = sy,
        tx = layout.plot.left - layout.x.min * sx,
        ty = layout.plot.bottom - layout.y.min * sy,
    )
}

// ============================================================================
// Interaction — resolving a pointer to a datum
// ============================================================================

/** The mark's `series:` / `name:` prop, else its kind. */
fun chartSeriesName(mark: ChartMark): String {
    val explicit = chartProp(mark.props, "series") ?: chartProp(mark.props, "name")
    val text = explicit as? String
    return if (!text.isNullOrEmpty()) text else mark.kind.typeName
}

/** Squared distance from a point to a segment, for line hit testing. */
private fun distanceToSegment(
    px: Double,
    py: Double,
    x1: Double,
    y1: Double,
    x2: Double,
    y2: Double,
): Double {
    val dx = x2 - x1
    val dy = y2 - y1
    val lengthSq = dx * dx + dy * dy
    if (lengthSq == 0.0) return kotlin.math.hypot(px - x1, py - y1)
    val t = (((px - x1) * dx + (py - y1) * dy) / lengthSq).coerceIn(0.0, 1.0)
    return kotlin.math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * What a pointer at ([px], [py]) hit on this mark.
 *
 * [index] non-null is a direct hit on a bar, a point or a line vertex — that
 * row and no other. A hit on the mark's body with no index resolves later to
 * the row nearest the pointer along x. Null means the pointer missed the mark
 * entirely, and the chart looks at the mark underneath.
 */
data class ChartHit(val index: Int?)

/**
 * Hit-test one mark. Vertices and points carry an invisible 12 dp target so
 * fingers work; a line's body is hit within half its stroke (never less than
 * 6 dp) of a segment.
 */
fun chartHitTest(mark: ChartMark, layout: ChartLayout, px: Double, py: Double): ChartHit? {
    when (mark.kind) {
        ChartMarkKind.BARS -> {
            // Topmost-last: later bars win a tie, matching paint order.
            for (bar in chartBars(mark, layout).asReversed()) {
                if (px >= bar.left && px <= bar.left + bar.width &&
                    py >= bar.top - 0.001 && py <= bar.top + bar.height + 0.001
                ) {
                    return ChartHit(bar.datum.index)
                }
            }
            return null
        }
        ChartMarkKind.POINTS -> {
            val radius = chartNumber(chartProp(mark.props, "radius")) ?: ChartDefaults.POINT_RADIUS
            val reach = max(radius, ChartDefaults.HIT_RADIUS)
            var best: ChartCircle? = null
            var bestDistance = Double.MAX_VALUE
            for (circle in chartPoints(mark, layout)) {
                val distance = kotlin.math.hypot(px - circle.cx, py - circle.cy)
                if (distance <= reach && distance < bestDistance) {
                    bestDistance = distance
                    best = circle
                }
            }
            return best?.let { ChartHit(it.datum.index) }
        }
        ChartMarkKind.LINE, ChartMarkKind.AREA -> {
            val points = chartProject(mark, layout)
            if (points.isEmpty()) return null
            var best: ChartPoint? = null
            var bestDistance = Double.MAX_VALUE
            for (point in points) {
                val distance = kotlin.math.hypot(px - point.px, py - point.py)
                if (distance <= ChartDefaults.HIT_RADIUS && distance < bestDistance) {
                    bestDistance = distance
                    best = point
                }
            }
            if (best != null) return ChartHit(best.datum.index)
            if (mark.kind == ChartMarkKind.AREA) {
                // Inside the filled region: between the interpolated top edge
                // and the zero line, within the data's x span.
                val base = chartBaseline(layout)
                val topEdge = chartInterpolatedY(points, px) ?: return null
                val lo = min(topEdge, base)
                val hi = max(topEdge, base)
                return if (py in lo..hi) ChartHit(null) else null
            }
            val strokeWidth = chartNumber(chartProp(mark.props, "strokeWidth"))
                ?: ChartDefaults.LINE_STROKE_WIDTH
            val reach = max(strokeWidth / 2.0, 6.0)
            for (i in 0 until points.size - 1) {
                val a = points[i]
                val b = points[i + 1]
                if (distanceToSegment(px, py, a.px, a.py, b.px, b.py) <= reach) return ChartHit(null)
            }
            return null
        }
        ChartMarkKind.RULE -> {
            val segment = chartRule(mark, layout) ?: return null
            val reach = max(
                (chartNumber(chartProp(mark.props, "strokeWidth")) ?: ChartDefaults.AXIS_STROKE_WIDTH) / 2.0,
                6.0,
            )
            return if (distanceToSegment(px, py, segment.x1, segment.y1, segment.x2, segment.y2) <= reach) {
                ChartHit(null)
            } else {
                null
            }
        }
        // Axis, Marker and Path carry no data; Marker's children take their
        // own events as ordinary composables.
        else -> return null
    }
}

/** y of the polyline at [px], for the Area fill test. */
private fun chartInterpolatedY(points: List<ChartPoint>, px: Double): Double? {
    if (points.isEmpty()) return null
    if (points.size == 1) return if (abs(points[0].px - px) <= 0.5) points[0].py else null
    val first = points.first()
    val last = points.last()
    if (px < min(first.px, last.px) || px > max(first.px, last.px)) return null
    for (i in 0 until points.size - 1) {
        val a = points[i]
        val b = points[i + 1]
        val lo = min(a.px, b.px)
        val hi = max(a.px, b.px)
        if (px in lo..hi) {
            val span = b.px - a.px
            if (span == 0.0) return a.py
            val t = (px - a.px) / span
            return a.py + (b.py - a.py) * t
        }
    }
    return null
}

/** The row nearest [px] along x — what a hit between vertices resolves to. */
fun chartNearestDatum(mark: ChartMark, layout: ChartLayout, px: Double): ChartDatum? {
    var best: ChartDatum? = null
    var bestDistance = Double.MAX_VALUE
    for (d in mark.data) {
        val mapped = layout.x.map(d.x) ?: continue
        val distance = abs(mapped - px)
        if (distance < bestDistance) {
            bestDistance = distance
            best = d
        }
    }
    return best
}

/**
 * The payload every event on a mark carries: `{series, index, x, y, datum}`
 * in data units, never pixels, so module handlers stay platform-agnostic.
 *
 * A direct [hitIndex] (bar, point, line vertex) wins; otherwise the row
 * nearest [pointerX] along x. A mark with no data resolves to `{series}` only.
 */
fun resolveChartMarkPayload(
    mark: ChartMark,
    layout: ChartLayout?,
    pointerX: Double? = null,
    hitIndex: Int? = null,
): Map<String, Any?> {
    val payload = LinkedHashMap<String, Any?>()
    payload["series"] = chartSeriesName(mark)
    if (!mark.kind.isData || mark.data.isEmpty() || layout == null) return payload

    var datum = hitIndex?.let { index -> mark.data.firstOrNull { it.index == index } }
    if (datum == null && pointerX != null) datum = chartNearestDatum(mark, layout, pointerX)
    if (datum != null) {
        payload["index"] = datum.index
        payload["x"] = datum.x
        payload["y"] = datum.y
        payload["datum"] = datum.raw
    }
    return payload
}

/**
 * Chart-level events carry the pointer in data units, for "add a point where
 * I tapped" interactions. A band x resolves to the category name.
 */
fun resolveChartPointerPayload(layout: ChartLayout, px: Double, py: Double): Map<String, Any?> {
    val raw = layout.x.invert(px)
    val x: Any = if (layout.x.isBand) {
        val categories = layout.x.categories
        if (categories.isEmpty()) {
            raw
        } else {
            categories[kotlin.math.floor(raw).toInt().coerceIn(0, categories.size - 1)]
        }
    } else {
        raw
    }
    return linkedMapOf("x" to x, "y" to layout.y.invert(py))
}
