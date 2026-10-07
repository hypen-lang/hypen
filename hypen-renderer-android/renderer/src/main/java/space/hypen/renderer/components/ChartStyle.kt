package space.hypen.renderer.components

/**
 * Mark styling — the props that reach a chart mark's geometry.
 *
 * On the web these ride the CSS fallback of the applicator registry and
 * inherit into the SVG shapes. Compose has no such inheritance, so the chart
 * resolves them here into a plain record and hands it to the draw pass. The
 * defaults per mark kind are the presentation attributes the DOM renderer
 * writes on each mark's `<g>`, which authored applicators override.
 *
 * Colours stay as strings: [ChartComponent] resolves them with `ColorParser`
 * and falls back to the inherited content colour, so a chart follows
 * `.color(...)` on itself or any ancestor like every other component.
 */
data class ChartMarkStyle(
    /** null = inherit the content colour; [NONE] = do not stroke. */
    val stroke: String?,
    /** null = inherit the content colour; [NONE] = do not fill. */
    val fill: String?,
    val strokeWidth: Double,
    val dash: List<Double>?,
    val strokeCap: String?,
    val opacity: Double,
    val fillOpacity: Double,
    val strokeOpacity: Double,
    val glow: ChartGlow?,
) {
    val hasStroke: Boolean get() = stroke != NONE
    val hasFill: Boolean get() = fill != NONE

    companion object {
        const val NONE = "none"
    }
}

/**
 * A soft shape shadow. `glow(...)` is the zero-offset case; the
 * `shadow` / `boxShadow` / `dropShadow` / `elevation` family lands here too,
 * because a box shadow around chart geometry would be invisible.
 */
data class ChartGlow(
    /** null = the content colour. */
    val color: String?,
    val radius: Double,
    val dx: Double = 0.0,
    val dy: Double = 0.0,
)

/** `strokeDasharray: "4 4"` / `[4, 4]` → dash lengths in dp. */
internal fun chartDash(value: Any?): List<Double>? {
    val parts: List<Any?> = when (value) {
        null -> return null
        is List<*> -> value
        is String -> value.split(',', ' ').filter { it.isNotBlank() }
        is Number -> listOf(value)
        else -> return null
    }
    val out = parts.mapNotNull { chartNumber(it) }.filter { it >= 0.0 }
    return out.takeIf { it.size >= 2 }
}

private fun chartOpacity(value: Any?, default: Double): Double =
    chartNumber(value)?.coerceIn(0.0, 1.0) ?: default

/**
 * Read `glow(...)` and the shadow family off a mark.
 *
 * `glow` accepts a colour, a radius, or `{color, radius}`. `shadow` /
 * `boxShadow` / `dropShadow` accept the same map shape the visual-effects
 * applicators take (`{x, y, blur, color}`) or a CSS-ish string
 * (`"0 0 4px red"`). `elevation(n)` is the Material ramp the DOM renderer
 * maps to `drop-shadow(0 2px 3px …)` at n = 2, scaled linearly.
 */
private fun chartEffectValue(props: Map<String, Any?>, name: String): Any? {
    chartProp(props, name)?.let { return it }
    val prefix = "$name."
    return props.filterKeys { it.startsWith(prefix) }
        .mapKeys { it.key.removePrefix(prefix) }.takeIf { it.isNotEmpty() }
}

internal fun chartGlow(props: Map<String, Any?>): ChartGlow? {
    chartEffectValue(props, "glow")?.let { raw ->
        return when (raw) {
            is Map<*, *> -> ChartGlow(
                color = raw["color"] as? String,
                radius = chartNumber(raw["radius"]) ?: ChartDefaults.GLOW_RADIUS,
            )
            is Number -> ChartGlow(null, raw.toDouble())
            is String -> chartNumber(raw)?.let { ChartGlow(null, it) }
                ?: ChartGlow(raw, ChartDefaults.GLOW_RADIUS)
            else -> null
        }
    }
    for (name in listOf("shadow", "boxShadow", "dropShadow")) {
        val raw = chartEffectValue(props, name) ?: continue
        return when (raw) {
            is Map<*, *> -> ChartGlow(
                color = raw["color"] as? String,
                radius = chartNumber(raw["blur"]) ?: ChartDefaults.GLOW_RADIUS,
                dx = chartNumber(raw["x"]) ?: 0.0,
                dy = chartNumber(raw["y"]) ?: 0.0,
            )
            is String -> chartShadowFromString(raw)
            is Number -> ChartGlow(null, raw.toDouble())
            else -> null
        }
    }
    chartNumber(chartProp(props, "elevation"))?.let { level ->
        // The DOM renderer's elevation ramp at n = 2 is `0 2px 3px`; keep the
        // same 1:1.5 offset-to-blur ratio for other levels.
        return ChartGlow(null, level * 1.5, 0.0, level)
    }
    return null
}

/** `"0 0 4px red"` → offsets, blur and colour. */
private fun chartShadowFromString(value: String): ChartGlow? {
    val parts = value.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (parts.isEmpty()) return null
    val lengths = ArrayList<Double>()
    var color: String? = null
    for (part in parts) {
        val n = chartNumber(part.removeSuffix("px").removeSuffix("dp"))
        if (n != null && lengths.size < 3) lengths.add(n) else if (color == null) color = part
    }
    if (lengths.isEmpty()) return null
    return ChartGlow(
        color = color,
        radius = lengths.getOrElse(2) { ChartDefaults.GLOW_RADIUS },
        dx = lengths.getOrElse(0) { 0.0 },
        dy = lengths.getOrElse(1) { 0.0 },
    )
}

/**
 * Resolve one mark's paint: the per-kind defaults, then whatever the author
 * wrote. Layout applicators on a mark have nothing to lay out and are ignored
 * — the `Chart` is what gets sized.
 */
fun resolveChartMarkStyle(kind: ChartMarkKind, props: Map<String, Any?>): ChartMarkStyle {
    val none = ChartMarkStyle.NONE
    val defaultStroke: String? = when (kind) {
        ChartMarkKind.AREA, ChartMarkKind.BARS, ChartMarkKind.POINTS -> none
        else -> null
    }
    val defaultFill: String? = when (kind) {
        ChartMarkKind.LINE, ChartMarkKind.RULE, ChartMarkKind.PATH -> none
        else -> null
    }
    val defaultStrokeWidth = when (kind) {
        ChartMarkKind.LINE, ChartMarkKind.PATH -> ChartDefaults.LINE_STROKE_WIDTH
        else -> ChartDefaults.AXIS_STROKE_WIDTH
    }
    val defaultFillOpacity = when (kind) {
        ChartMarkKind.AREA -> ChartDefaults.AREA_FILL_OPACITY
        ChartMarkKind.AXIS -> ChartDefaults.AXIS_LABEL_OPACITY
        else -> 1.0
    }
    val defaultStrokeOpacity = when (kind) {
        ChartMarkKind.AXIS -> ChartDefaults.AXIS_STROKE_OPACITY
        ChartMarkKind.RULE -> ChartDefaults.RULE_STROKE_OPACITY
        else -> 1.0
    }
    val defaultDash = if (kind == ChartMarkKind.RULE) listOf(4.0, 4.0) else null

    return ChartMarkStyle(
        stroke = (chartProp(props, "stroke") as? String) ?: defaultStroke,
        fill = (chartProp(props, "fill") as? String)
            ?: (chartProp(props, "color") as? String)
            ?: defaultFill,
        strokeWidth = chartNumber(chartProp(props, "strokeWidth")) ?: defaultStrokeWidth,
        dash = chartDash(chartProp(props, "strokeDasharray")) ?: defaultDash,
        strokeCap = chartProp(props, "strokeLinecap") as? String,
        opacity = chartOpacity(chartProp(props, "opacity"), 1.0),
        fillOpacity = chartOpacity(chartProp(props, "fillOpacity"), defaultFillOpacity),
        strokeOpacity = chartOpacity(chartProp(props, "strokeOpacity"), defaultStrokeOpacity),
        glow = chartGlow(props),
    )
}

/**
 * Every event applicator a mark (or the chart itself) can carry.
 *
 * `onClick`/`onPress` are the same gesture, as are `onLongClick`/`onLongPress`
 * — the aliases match the applicator registry.
 */
enum class ChartEvent(val propNames: List<String>) {
    CLICK(listOf("onClick", "onPress", "onTap")),
    LONG_PRESS(listOf("onLongPress", "onLongClick")),
    HOVER(listOf("onHover", "onMouseEnter")),
    MOVE(listOf("onMove", "onPointerMove", "onMouseMove")),
    LEAVE(listOf("onMouseLeave", "onPointerLeave", "onHoverEnd")),
}

/**
 * Collect one event applicator's arguments back into the `{0: action, …args}`
 * shape `ActionValue.parse` understands.
 *
 * The wire spells an applicator's positional argument `onClick.0` and its
 * static keyword arguments `onClick.tag`, so `.onClick(@actions.pick, tag:
 * "targets")` has to be regrouped before it can be parsed — the same grouping
 * `DefaultApplicatorRegistry.applyAll` does for modifier applicators.
 */
internal fun chartActionArgs(props: Map<String, Any?>, applicator: String): Map<String, Any?>? {
    val prefix = "${applicator.lowercase()}."
    val args = LinkedHashMap<String, Any?>()
    for ((key, value) in props) {
        val lower = key.lowercase()
        when {
            lower == applicator.lowercase() -> args["0"] = value
            lower.startsWith(prefix) -> args[key.substring(prefix.length)] = value
        }
    }
    return args.takeIf { it.isNotEmpty() }
}
