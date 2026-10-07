package space.hypen.renderer.components

import android.graphics.BlurMaskFilter
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import space.hypen.renderer.HypenElement as RenderHypenElement
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.render.ActionDispatcher
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.render.LocalActionDispatcher
import space.hypen.renderer.render.LocalComposeRenderer
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The `Chart` host and its mark family.
 *
 * `Chart` owns a coordinate space: it collects its mark children from the
 * element tree, resolves the domains ([computeChartLayout]) and draws every
 * mark into a single Compose [Canvas]. `Marker` is the exception — it pins
 * ordinary Hypen children at a data point, so those are composed on top of
 * the canvas and positioned by [chartMarkerOffset].
 *
 * Marks are NOT independent composables: registering them (see
 * [ChartMarkComponent]) only stops the renderer falling back to an unknown-type
 * `Box`, and their handlers paint nothing. A mark outside a chart therefore
 * renders nothing at all, which is what the contract asks for.
 *
 * Interaction runs off one pointer overlay rather than per-mark hit areas. It
 * resolves the topmost mark that actually declares the event applicator being
 * handled, which is how the web renderer's `pointer-events: none` on
 * decorative marks is honoured here: a tooltip's `Points`/`Marker` never
 * steals the pointer from the `Line` being hovered.
 */
class ChartComponent : ComponentHandler {
    override val typeName: String = "chart"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val renderer = LocalComposeRenderer.current
        val dispatcher = LocalActionDispatcher.current
        val density = LocalDensity.current.density

        // A chart follows `.color(...)` on itself or any ancestor: that is the
        // default stroke and fill for every mark that does not name its own.
        val contentColor = hypenContentColor(element) ?: LocalContentColor.current

        val hostModifier = modifier
            .fillMaxWidth()
            .let { if (chartHasAuthoredHeight(element)) it else it.height(ChartDefaults.HEIGHT.dp) }

        if (renderer == null) {
            Box(modifier = hostModifier)
            return
        }

        // Reading each child's props here subscribes this composable to them,
        // so any prop change on the chart or a mark, and any child added or
        // removed, re-lays the whole chart out.
        val markElements = collectChartMarkElements(element, renderer)
        val marks = markElements.map { (child, kind) ->
            ChartMark.of(child.id, kind, child.props)
        }
        val chartProps = element.props

        var size by remember { mutableStateOf(IntSize.Zero) }

        Box(modifier = hostModifier.onSizeChanged { size = it }) {
            if (size.width <= 0 || size.height <= 0) return@Box
            val layout = computeChartLayout(
                chartProps = chartProps,
                marks = marks,
                width = (size.width / density).toDouble(),
                height = (size.height / density).toDouble(),
            )

            Canvas(modifier = Modifier.matchParentSize()) {
                for (mark in marks) {
                    drawChartMark(mark, layout, contentColor, density)
                }
            }

            if (dispatcher != null && chartIsInteractive(chartProps, marks)) {
                ChartPointerOverlay(
                    layout = layout,
                    chartProps = chartProps,
                    marks = marks,
                    density = density,
                    dispatcher = dispatcher,
                )
            }

            // Markers compose last so they are hit-tested before the pointer
            // overlay: a Marker child that carries its own events stays
            // interactive, while a decorative one consumes nothing.
            for ((child, kind) in markElements) {
                if (kind != ChartMarkKind.MARKER) continue
                val mark = marks.firstOrNull { it.id == child.id } ?: continue
                val placement = chartMarker(mark, layout) ?: continue
                key(child.id) {
                    ChartMarkerSlot(placement = placement, density = density) {
                        CompositionLocalProvider(LocalContentColor provides contentColor) {
                            for (grandChild in renderer.getChildren(child.id)) {
                                key(grandChild.id) {
                                    RenderHypenElement(element = grandChild, renderer = renderer)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * A mark type the [ChartComponent] draws itself.
 *
 * Registered so an unknown-type warning and a stray `Box` never appear for
 * `Line`, `Bars` and friends; the handler paints nothing because the chart
 * already drew this mark into its own canvas.
 */
class ChartMarkComponent(private val kind: ChartMarkKind) : ComponentHandler {
    override val typeName: String = kind.typeName

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Intentionally empty: geometry belongs to the enclosing Chart, and a
        // mark outside a chart has no coordinate space to live in.
    }
}

// ============================================================================
// Children
// ============================================================================

private val CHART_CONTROL_FLOW_TYPES = setOf(
    "ForEach", "__ForEach",
    "Conditional", "__Conditional",
    "When", "__When",
    "If", "__If",
)

/**
 * The chart's mark children, with control-flow wrappers flattened.
 *
 * The engine wraps `ForEach`/`When` output in internal containers, so a chart
 * whose marks come out of a loop still has to see the marks themselves.
 * Anything that is not a mark is ignored — the contract says a chart renders
 * nothing for it.
 */
internal fun collectChartMarkElements(
    element: HypenElement,
    renderer: ComposeRenderer,
): List<Pair<HypenElement, ChartMarkKind>> {
    val out = ArrayList<Pair<HypenElement, ChartMarkKind>>()

    fun walk(children: List<HypenElement>, depth: Int) {
        if (depth > 8) return
        for (child in children) {
            val kind = ChartMarkKind.fromType(child.elementType)
            when {
                kind != null -> out.add(child to kind)
                child.elementType in CHART_CONTROL_FLOW_TYPES ->
                    walk(renderer.getChildren(child.id), depth + 1)
            }
        }
    }

    walk(renderer.getChildren(element.id), 0)
    return out
}

/** Did the author size the chart's height, or does it get the default 200dp? */
internal fun chartHasAuthoredHeight(element: HypenElement): Boolean =
    element.props.keys.any { key ->
        when (key.substringBefore('.').lowercase()) {
            "height", "size", "minheight", "maxheight", "fillmaxheight", "fillmaxsize" -> true
            else -> false
        }
    }

// ============================================================================
// Drawing
// ============================================================================

private fun ChartMarkStyle.resolvedStroke(content: Color): Color? {
    if (!hasStroke) return null
    val base = stroke?.let { ColorParser.parse(it) } ?: content
    return base.copy(alpha = (base.alpha * opacity * strokeOpacity).toFloat().coerceIn(0f, 1f))
}

private fun ChartMarkStyle.resolvedFill(content: Color, dimmed: Boolean = false): Color? {
    if (!hasFill) return null
    val base = fill?.let { ColorParser.parse(it) } ?: content
    val dim = if (dimmed) ChartDefaults.DIMMED_OPACITY else 1.0
    return base.copy(alpha = (base.alpha * opacity * fillOpacity * dim).toFloat().coerceIn(0f, 1f))
}

private fun chartStrokeCap(style: ChartMarkStyle, default: StrokeCap): StrokeCap =
    when (style.strokeCap?.lowercase()) {
        "round" -> StrokeCap.Round
        "square" -> StrokeCap.Square
        "butt" -> StrokeCap.Butt
        else -> default
    }

/** dp → device pixels; every geometry value crosses this on its way to the canvas. */
private fun Double.px(density: Float): Float = (this * density).toFloat()

private fun DrawScope.chartStroke(
    style: ChartMarkStyle,
    density: Float,
    cap: StrokeCap = StrokeCap.Round,
    join: StrokeJoin = StrokeJoin.Round,
): Stroke = Stroke(
    width = max(style.strokeWidth, 0.0).px(density),
    cap = chartStrokeCap(style, cap),
    join = join,
    pathEffect = style.dash?.let { dash ->
        PathEffect.dashPathEffect(dash.map { it.px(density) }.toFloatArray())
    },
)

/**
 * Paint a soft halo of [path] under the real geometry.
 *
 * `glow()` and the shadow family both land here; a box shadow around chart
 * geometry would be invisible, so they all mean a SHAPE shadow. The blur is a
 * framework [BlurMaskFilter] on the native canvas — where a device cannot
 * blur, the halo degrades to a wider, translucent copy of the shape rather
 * than disappearing.
 */
private fun DrawScope.drawChartGlow(
    path: Path,
    glow: ChartGlow,
    color: Color,
    density: Float,
    stroke: Stroke?,
) {
    val radius = glow.radius.px(density)
    if (radius <= 0f) return
    val glowColor = glow.color?.let { ColorParser.parse(it) } ?: color
    drawIntoCanvas { canvas ->
        val paint = android.graphics.Paint().apply {
            isAntiAlias = true
            this.color = glowColor.copy(alpha = glowColor.alpha * 0.65f).toArgb()
            maskFilter = BlurMaskFilter(radius, BlurMaskFilter.Blur.NORMAL)
            if (stroke != null) {
                style = android.graphics.Paint.Style.STROKE
                strokeWidth = stroke.width + radius / 2f
                strokeCap = android.graphics.Paint.Cap.ROUND
                strokeJoin = android.graphics.Paint.Join.ROUND
            } else {
                style = android.graphics.Paint.Style.FILL
            }
        }
        canvas.nativeCanvas.translate(glow.dx.px(density), glow.dy.px(density))
        canvas.nativeCanvas.drawPath(path.asAndroidPath(), paint)
        canvas.nativeCanvas.translate(-glow.dx.px(density), -glow.dy.px(density))
    }
}

/** The polyline (or smooth curve) through a data mark's projected points. */
private fun chartLinePath(points: List<ChartPoint>, smooth: Boolean, density: Float): Path {
    val path = Path()
    if (points.isEmpty()) return path
    path.moveTo(points[0].px.px(density), points[0].py.px(density))
    if (smooth && points.size >= 3) {
        for (cubic in chartSmoothCubics(points)) {
            path.cubicTo(
                cubic.c1x.px(density), cubic.c1y.px(density),
                cubic.c2x.px(density), cubic.c2y.px(density),
                cubic.x.px(density), cubic.y.px(density),
            )
        }
    } else {
        for (i in 1 until points.size) {
            path.lineTo(points[i].px.px(density), points[i].py.px(density))
        }
    }
    return path
}

private fun DrawScope.drawChartMark(
    mark: ChartMark,
    layout: ChartLayout,
    contentColor: Color,
    density: Float,
) {
    val style = resolveChartMarkStyle(mark.kind, mark.props)
    when (mark.kind) {
        ChartMarkKind.LINE -> drawChartLine(mark, layout, style, contentColor, density)
        ChartMarkKind.AREA -> drawChartArea(mark, layout, style, contentColor, density)
        ChartMarkKind.BARS -> drawChartBars(mark, layout, style, contentColor, density)
        ChartMarkKind.POINTS -> drawChartPoints(mark, layout, style, contentColor, density)
        ChartMarkKind.AXIS -> drawChartAxis(mark, layout, style, contentColor, density)
        ChartMarkKind.RULE -> drawChartRule(mark, layout, style, contentColor, density)
        ChartMarkKind.PATH -> drawChartPathMark(mark, layout, style, contentColor, density)
        // Marker is composed above the canvas, not painted into it.
        ChartMarkKind.MARKER -> Unit
    }
}

private fun DrawScope.drawChartLine(
    mark: ChartMark,
    layout: ChartLayout,
    style: ChartMarkStyle,
    contentColor: Color,
    density: Float,
) {
    val points = chartProject(mark, layout)
    if (points.isEmpty()) return
    val color = style.resolvedStroke(contentColor) ?: return
    val path = chartLinePath(points, chartIsSmooth(mark), density)
    val stroke = chartStroke(style, density)
    style.glow?.let { drawChartGlow(path, it, color, density, stroke) }
    drawPath(path, color, style = stroke)
}

private fun DrawScope.drawChartArea(
    mark: ChartMark,
    layout: ChartLayout,
    style: ChartMarkStyle,
    contentColor: Color,
    density: Float,
) {
    val points = chartProject(mark, layout)
    if (points.isEmpty()) return
    val path = chartLinePath(points, chartIsSmooth(mark), density)
    // Close the region back down to the zero line, clamped into the domain.
    val base = chartBaseline(layout).px(density)
    path.lineTo(points.last().px.px(density), base)
    path.lineTo(points.first().px.px(density), base)
    path.close()

    style.resolvedFill(contentColor)?.let { fill ->
        style.glow?.let { drawChartGlow(path, it, fill, density, null) }
        drawPath(path, fill, style = Fill)
    }
    style.resolvedStroke(contentColor)?.let { stroke ->
        drawPath(chartLinePath(points, chartIsSmooth(mark), density), stroke, style = chartStroke(style, density))
    }
}

private fun DrawScope.drawChartBars(
    mark: ChartMark,
    layout: ChartLayout,
    style: ChartMarkStyle,
    contentColor: Color,
    density: Float,
) {
    val bars = chartBars(mark, layout)
    if (bars.isEmpty()) return
    val stroke = style.resolvedStroke(contentColor)
    for (bar in bars) {
        val fill = style.resolvedFill(contentColor, bar.dimmed)
        val topLeft = Offset(bar.left.px(density), bar.top.px(density))
        val size = Size(bar.width.px(density), max(bar.height, 0.0).px(density))
        val radius = bar.radius.px(density)
        val path = Path().apply {
            if (radius > 0f) {
                addRoundRect(
                    androidx.compose.ui.geometry.RoundRect(
                        left = topLeft.x,
                        top = topLeft.y,
                        right = topLeft.x + size.width,
                        bottom = topLeft.y + size.height,
                        cornerRadius = CornerRadius(radius, radius),
                    ),
                )
            } else {
                addRect(androidx.compose.ui.geometry.Rect(topLeft, size))
            }
        }
        if (fill != null) {
            style.glow?.let { drawChartGlow(path, it, fill, density, null) }
            drawPath(path, fill, style = Fill)
        }
        if (stroke != null) drawPath(path, stroke, style = chartStroke(style, density))
    }
}

private fun DrawScope.drawChartPoints(
    mark: ChartMark,
    layout: ChartLayout,
    style: ChartMarkStyle,
    contentColor: Color,
    density: Float,
) {
    val circles = chartPoints(mark, layout)
    if (circles.isEmpty()) return
    val stroke = style.resolvedStroke(contentColor)
    for (circle in circles) {
        val center = Offset(circle.cx.px(density), circle.cy.px(density))
        val radius = circle.radius.px(density)
        val fill = style.resolvedFill(contentColor, circle.dimmed)
        if (fill != null) {
            style.glow?.let { glow ->
                val path = Path().apply {
                    addOval(
                        androidx.compose.ui.geometry.Rect(
                            center.x - radius, center.y - radius,
                            center.x + radius, center.y + radius,
                        ),
                    )
                }
                drawChartGlow(path, glow, fill, density, null)
            }
            drawCircle(fill, radius, center)
        }
        if (stroke != null) drawCircle(stroke, radius, center, style = chartStroke(style, density))
    }
}

private fun DrawScope.drawChartAxis(
    mark: ChartMark,
    layout: ChartLayout,
    style: ChartMarkStyle,
    contentColor: Color,
    density: Float,
) {
    val geometry = chartAxis(mark, layout)
    val baseColor = style.stroke?.let { ColorParser.parse(it) } ?: contentColor
    val lineColor = style.resolvedStroke(contentColor) ?: contentColor
    val labelColor = style.resolvedFill(contentColor) ?: contentColor
    val gridColor = baseColor.copy(
        alpha = (baseColor.alpha * style.opacity * ChartDefaults.GRID_OPACITY).toFloat().coerceIn(0f, 1f),
    )
    val width = max(style.strokeWidth, 0.0).px(density)

    fun line(segment: ChartSegment, color: Color) {
        drawLine(
            color = color,
            start = Offset(segment.x1.px(density), segment.y1.px(density)),
            end = Offset(segment.x2.px(density), segment.y2.px(density)),
            strokeWidth = width,
        )
    }

    line(geometry.axisLine, lineColor)
    for (tick in geometry.ticks) line(tick, lineColor)
    for (grid in geometry.grid) line(grid, gridColor)

    val fontSize = ChartDefaults.FONT_SIZE.px(density)
    for (label in geometry.labels) drawChartLabel(label, labelColor, fontSize, density)
    geometry.title?.let { drawChartLabel(it, labelColor, fontSize, density) }
}

private fun DrawScope.drawChartLabel(
    label: ChartLabel,
    color: Color,
    fontSizePx: Float,
    density: Float,
) {
    if (label.text.isEmpty()) return
    val paint = android.graphics.Paint().apply {
        isAntiAlias = true
        this.color = color.toArgb()
        textSize = fontSizePx
        textAlign = when (label.align) {
            ChartTextAlign.START -> android.graphics.Paint.Align.LEFT
            ChartTextAlign.MIDDLE -> android.graphics.Paint.Align.CENTER
            ChartTextAlign.END -> android.graphics.Paint.Align.RIGHT
        }
    }
    val x = label.x.px(density)
    val y = label.y.px(density)
    drawIntoCanvas { canvas ->
        val native = canvas.nativeCanvas
        if (label.rotated) {
            // The y-axis title reads bottom-to-top, like the SVG rotate(-90).
            native.save()
            native.rotate(-90f, x, y)
            native.drawText(label.text, x, y, paint)
            native.restore()
        } else {
            native.drawText(label.text, x, y, paint)
        }
    }
}

private fun DrawScope.drawChartRule(
    mark: ChartMark,
    layout: ChartLayout,
    style: ChartMarkStyle,
    contentColor: Color,
    density: Float,
) {
    val segment = chartRule(mark, layout) ?: return
    val color = style.resolvedStroke(contentColor) ?: return
    val path = Path().apply {
        moveTo(segment.x1.px(density), segment.y1.px(density))
        lineTo(segment.x2.px(density), segment.y2.px(density))
    }
    val stroke = chartStroke(style, density, cap = StrokeCap.Butt)
    style.glow?.let { drawChartGlow(path, it, color, density, stroke) }
    drawPath(path, color, style = stroke)
}

private fun DrawScope.drawChartPathMark(
    mark: ChartMark,
    layout: ChartLayout,
    style: ChartMarkStyle,
    contentColor: Color,
    density: Float,
) {
    val d = chartPathData(mark) ?: return
    val commands = parseChartPath(d)
    if (commands.isEmpty()) return
    val transform = chartPathTransform(layout)
    val path = Path()

    fun x(v: Double) = transform.mapX(v).px(density)
    fun y(v: Double) = transform.mapY(v).px(density)

    for (command in commands) {
        val c = command.coords
        when (command.op) {
            'M' -> path.moveTo(x(c[0]), y(c[1]))
            'L' -> path.lineTo(x(c[0]), y(c[1]))
            'C' -> path.cubicTo(x(c[0]), y(c[1]), x(c[2]), y(c[3]), x(c[4]), y(c[5]))
            'Q' -> path.quadraticBezierTo(x(c[0]), y(c[1]), x(c[2]), y(c[3]))
            'Z' -> path.close()
        }
    }

    // The stroke is applied AFTER the data→dp transform, so its width stays in
    // dp — the web renderer's `vector-effect: non-scaling-stroke`.
    style.resolvedFill(contentColor)?.let { drawPath(path, it, style = Fill) }
    style.resolvedStroke(contentColor)?.let { color ->
        val stroke = chartStroke(style, density)
        style.glow?.let { drawChartGlow(path, it, color, density, stroke) }
        drawPath(path, color, style = stroke)
    }
}

// ============================================================================
// Marker slot
// ============================================================================

/**
 * Places a Marker's children at its data point.
 *
 * The content is measured at its natural size and offset by the anchor rule,
 * so `Marker(x: 7, y: 82) { Badge("Launch") }` sits above the point without
 * the DSL ever naming a pixel.
 */
@Composable
private fun ChartMarkerSlot(
    placement: ChartMarkerPlacement,
    density: Float,
    content: @Composable () -> Unit,
) {
    Layout(content = content) { measurables, constraints ->
        val childConstraints = constraints.copy(minWidth = 0, minHeight = 0)
        val placeables = measurables.map { it.measure(childConstraints) }
        val width = placeables.maxOfOrNull { it.width } ?: 0
        val height = placeables.maxOfOrNull { it.height } ?: 0
        // The slot spans the whole chart so the content can be placed anywhere
        // in it; an unbounded constraint (no chart to span) falls back to the
        // content's own size rather than overflowing.
        val slotWidth = if (constraints.hasBoundedWidth) constraints.maxWidth else width
        val slotHeight = if (constraints.hasBoundedHeight) constraints.maxHeight else height
        layout(slotWidth, slotHeight) {
            val (left, top) = chartMarkerOffset(
                anchor = placement.anchor,
                px = (placement.px * density).toDouble(),
                py = (placement.py * density).toDouble(),
                contentWidth = width.toDouble(),
                contentHeight = height.toDouble(),
                gap = ChartDefaults.MARKER_GAP * density,
            )
            for (placeable in placeables) {
                placeable.place(left.roundToInt(), top.roundToInt())
            }
        }
    }
}

// ============================================================================
// Interaction
// ============================================================================

/** The action a mark (or the chart) declares for one event, if any. */
internal fun chartAction(props: Map<String, Any?>, event: ChartEvent): ActionValue? {
    for (name in event.propNames) {
        val args = chartActionArgs(props, name) ?: continue
        val single = args["0"]
        val parsed = if (args.size == 1 && single != null) {
            ActionValue.parse(single)
        } else {
            ActionValue.parse(args)
        }
        if (parsed != null) return parsed
    }
    return null
}

/** Does anything in this chart want the pointer at all? */
internal fun chartIsInteractive(chartProps: Map<String, Any?>, marks: List<ChartMark>): Boolean =
    ChartEvent.entries.any { event ->
        chartAction(chartProps, event) != null || marks.any { chartAction(it.props, event) != null }
    }

/** The mark an event resolves to, and the datum index it hit directly (if any). */
internal data class ChartTarget(val mark: ChartMark?, val action: ActionValue, val hitIndex: Int?)

/**
 * Topmost mark that both declares [event] and is under the pointer; failing
 * that, the chart itself. Marks without the applicator are transparent, which
 * is how a tooltip's decorative `Points` stays out of the `Line`'s way.
 */
internal fun chartResolveTarget(
    chartProps: Map<String, Any?>,
    marks: List<ChartMark>,
    layout: ChartLayout,
    event: ChartEvent,
    x: Double,
    y: Double,
): ChartTarget? {
    for (mark in marks.asReversed()) {
        val action = chartAction(mark.props, event) ?: continue
        val hit = chartHitTest(mark, layout, x, y) ?: continue
        return ChartTarget(mark, action, hit.index)
    }
    val hostAction = chartAction(chartProps, event) ?: return null
    return ChartTarget(null, hostAction, null)
}

private fun dispatchChartEvent(
    dispatcher: ActionDispatcher,
    target: ChartTarget,
    layout: ChartLayout,
    x: Double,
    y: Double,
) {
    val resolved = if (target.mark != null) {
        resolveChartMarkPayload(target.mark, layout, pointerX = x, hitIndex = target.hitIndex)
    } else {
        resolveChartPointerPayload(layout, x, y)
    }
    // Static action args travel alongside; the resolved datum wins on a clash.
    dispatcher.dispatch(target.action.actionName, target.action.payload + resolved)
}

@Composable
private fun BoxScope.ChartPointerOverlay(
    layout: ChartLayout,
    chartProps: Map<String, Any?>,
    marks: List<ChartMark>,
    density: Float,
    dispatcher: ActionDispatcher,
) {
    // The gesture coroutines outlive a re-layout, so they read the current
    // layout through a snapshot holder instead of being keyed on it — a
    // re-key mid-gesture would cancel the press without an up.
    val current by rememberUpdatedState(ChartPointerState(layout, chartProps, marks, dispatcher))

    Box(
        modifier = Modifier
            .matchParentSize()
            .pointerInput(density) {
                detectTapGestures(
                    onTap = { offset ->
                        current.dispatch(ChartEvent.CLICK, offset.x / density, offset.y / density)
                    },
                    onLongPress = { offset ->
                        current.dispatch(ChartEvent.LONG_PRESS, offset.x / density, offset.y / density)
                    },
                )
            }
            .pointerInput(density) {
                awaitPointerEventScope {
                    var hovered: String? = null
                    var lastMove = 0L
                    while (true) {
                        val pointerEvent = awaitPointerEvent()
                        val change = pointerEvent.changes.lastOrNull()
                        when (pointerEvent.type) {
                            PointerEventType.Exit, PointerEventType.Release -> {
                                hovered = current.leave(hovered)
                            }
                            PointerEventType.Move, PointerEventType.Enter, PointerEventType.Press -> {
                                if (change != null) {
                                    val x = change.position.x / density
                                    val y = change.position.y / density
                                    // Hover is "the pointer is over this mark",
                                    // so a mark that only takes onMove still
                                    // owns the hover slot for the leave event.
                                    val target = current.resolve(ChartEvent.HOVER, x, y)
                                        ?: current.resolve(ChartEvent.MOVE, x, y)
                                        ?: current.resolve(ChartEvent.LEAVE, x, y)
                                    val id = if (target == null) null else target.mark?.id ?: ""
                                    if (id != hovered) {
                                        hovered = current.leave(hovered)
                                        if (target != null) {
                                            current.dispatch(ChartEvent.HOVER, x, y)
                                            hovered = id
                                        }
                                    }
                                    val now = System.currentTimeMillis()
                                    if (now - lastMove >= ChartDefaults.MOVE_THROTTLE_MS &&
                                        current.dispatch(ChartEvent.MOVE, x, y)
                                    ) {
                                        lastMove = now
                                    }
                                }
                            }
                            else -> Unit
                        }
                    }
                }
            },
    )
}

/**
 * The live view of the chart a gesture coroutine works against.
 *
 * Recreated on every re-layout and read through `rememberUpdatedState`, so
 * gestures always resolve against the current domains without the pointer
 * input block being torn down and restarted.
 */
private class ChartPointerState(
    val layout: ChartLayout,
    val chartProps: Map<String, Any?>,
    val marks: List<ChartMark>,
    val dispatcher: ActionDispatcher,
) {
    fun resolve(event: ChartEvent, x: Double, y: Double): ChartTarget? =
        chartResolveTarget(chartProps, marks, layout, event, x, y)

    fun resolve(event: ChartEvent, x: Float, y: Float): ChartTarget? =
        resolve(event, x.toDouble(), y.toDouble())

    /** Returns true when something was actually dispatched. */
    fun dispatch(event: ChartEvent, x: Float, y: Float): Boolean {
        val target = resolve(event, x.toDouble(), y.toDouble()) ?: return false
        dispatchChartEvent(dispatcher, target, layout, x.toDouble(), y.toDouble())
        return true
    }

    /** Fire `onMouseLeave` for the mark the pointer was over; returns null. */
    fun leave(hoveredId: String?): String? {
        if (hoveredId == null) return null
        val mark = marks.firstOrNull { it.id == hoveredId }
        val props = mark?.props ?: chartProps
        val action = chartAction(props, ChartEvent.LEAVE)
        if (action != null) {
            val payload = if (mark != null) {
                resolveChartMarkPayload(mark, layout)
            } else {
                emptyMap()
            }
            dispatcher.dispatch(action.actionName, action.payload + payload)
        }
        return null
    }
}
