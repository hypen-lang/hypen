package space.hypen.renderer.components

import com.squareup.moshi.Moshi
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow

/**
 * Data model behind the `Chart` family — the platform-agnostic half.
 *
 * A `Chart` owns a coordinate space; its children are marks (`Line`, `Area`,
 * `Bars`, `Points`, `Axis`, `Rule`, `Marker`, `Path`) whose props are written
 * in DATA units, never pixels. Everything in this file is plain Kotlin so the
 * contract — data normalisation, domain resolution, nice ticks — is unit
 * testable without a device, exactly like the DOM renderer's `chart.ts`
 * exports the same functions for its contract test.
 *
 * All geometry in this family is computed in **dp**, not raw pixels: the
 * defaults below are the same numbers the web renderer uses as CSS px, and dp
 * is their density-independent analogue. [ChartComponent] multiplies by the
 * display density only at draw time.
 */
object ChartDefaults {
    /** Fallback host size when neither the modifier nor the props give one. */
    const val WIDTH = 320.0
    const val HEIGHT = 200.0

    /** Plot inset when no axis asks for label room (sparkline mode). */
    const val BARE_INSET = 4.0
    const val INSET_TOP = 10.0
    const val INSET_RIGHT = 12.0

    /** Room for a y axis' tick labels. */
    const val INSET_LEFT = 44.0

    /** Room for an x axis' tick labels. */
    const val INSET_BOTTOM = 28.0

    const val TICKS = 5
    const val POINT_RADIUS = 3.5

    /** Invisible touch target radius around a point or line vertex. */
    const val HIT_RADIUS = 12.0
    const val BAR_WIDTH = 0.7
    const val DIMMED_OPACITY = 0.45
    const val FONT_SIZE = 11.0

    /** Gap between a Marker's data point and its anchored content. */
    const val MARKER_GAP = 8.0

    const val LINE_STROKE_WIDTH = 2.0
    const val AXIS_STROKE_WIDTH = 1.0
    const val AREA_FILL_OPACITY = 0.15
    const val AXIS_STROKE_OPACITY = 0.5
    const val AXIS_LABEL_OPACITY = 0.75
    const val RULE_STROKE_OPACITY = 0.7
    const val GRID_OPACITY = 0.15
    const val AXIS_TICK_LENGTH = 4.0

    /** Default `glow()` blur radius when the applicator names only a colour. */
    const val GLOW_RADIUS = 6.0

    /** Press duration that promotes a tap to `onLongPress`. */
    const val LONG_PRESS_MS = 500L

    /** `onMove` is throttled to roughly one frame. */
    const val MOVE_THROTTLE_MS = 32L
}

/** The mark kinds a `Chart` lays out. Wire type names are the lowercase form. */
enum class ChartMarkKind(val typeName: String) {
    LINE("line"),
    AREA("area"),
    BARS("bars"),
    POINTS("points"),
    AXIS("axis"),
    RULE("rule"),
    MARKER("marker"),
    PATH("path"),
    ;

    /** Marks that carry data and therefore take part in domain resolution. */
    val isData: Boolean
        get() = this == LINE || this == AREA || this == BARS || this == POINTS

    companion object {
        private val byName = entries.associateBy { it.typeName }

        fun fromType(elementType: String?): ChartMarkKind? =
            byName[elementType?.lowercase()?.trim()]
    }
}

/**
 * One normalised row. [x] is a `Double` or a `String` (a category); [raw] is
 * the untouched row so an event payload can hand it back to the module.
 */
data class ChartDatum(
    val x: Any,
    val y: Double,
    val index: Int,
    val raw: Any?,
)

private val chartJsonAdapter by lazy { Moshi.Builder().build().adapter(Any::class.java) }

/** Numbers only; strings that parse as finite numbers count, nothing else. */
internal fun chartNumber(value: Any?): Double? =
    when (value) {
        is Number -> value.toDouble().takeIf { it.isFinite() }
        is String -> value.trim().takeIf { it.isNotEmpty() }?.toDoubleOrNull()?.takeIf { it.isFinite() }
        else -> null
    }

/** x keeps strings (categories); anything else must be numeric. */
internal fun chartX(value: Any?): Any? {
    val n = chartNumber(value)
    if (n != null) return n
    if (value is String && value.isNotEmpty()) return value
    return null
}

/** Decode a JSON literal that arrived over the wire as a string. */
private fun chartDecodeJson(value: String): Any? =
    runCatching { chartJsonAdapter.fromJson(value) }.getOrNull()

/**
 * Read a prop under its bare name or its `.0` applicator spelling.
 *
 * Constructor arguments arrive bare (`points`), applicators arrive suffixed
 * (`stroke.0`); reading both keeps `Line(points: …)` and `Line().points(…)`
 * equivalent, the way every other component in this renderer does it.
 */
internal fun chartProp(props: Map<String, Any?>, name: String): Any? =
    props[name] ?: props["$name.0"]

/** The list a data mark draws: `points` / `data` / `values` / positional `0`. */
internal fun chartList(props: Map<String, Any?>): List<Any?> {
    for (key in listOf("points", "data", "values", "0")) {
        when (val candidate = chartProp(props, key)) {
            is List<*> -> return candidate
            is String -> {
                val parsed = chartDecodeJson(candidate)
                if (parsed is List<*>) return parsed
            }
        }
    }
    return emptyList()
}

/**
 * Normalise a mark's list prop into `{x, y}` rows.
 *
 * Three shapes, all reduced to the same thing: a bare number takes the index
 * as x, an `[x, y]` tuple is read positionally, and an object reads the field
 * names from `x:` / `y:` (Bars also accepts `label:` / `value:`). Rows
 * without a usable y are dropped rather than zeroed — a gap in the data is
 * not a value of zero.
 */
fun normalizeChartData(props: Map<String, Any?>): List<ChartDatum> {
    val list = chartList(props)
    val xField = (chartProp(props, "x") as? String)
        ?: (chartProp(props, "label") as? String)
        ?: "x"
    val yField = (chartProp(props, "y") as? String)
        ?: (chartProp(props, "value") as? String)
        ?: "y"
    val out = ArrayList<ChartDatum>(list.size)
    list.forEachIndexed { index, raw ->
        var x: Any? = null
        var y: Double? = null
        when (raw) {
            is List<*> -> {
                x = chartX(raw.getOrNull(0))
                y = chartNumber(raw.getOrNull(1))
            }
            is Map<*, *> -> {
                x = chartX(raw[xField])
                y = chartNumber(raw[yField])
                if (x == null && !raw.containsKey(xField)) x = index.toDouble()
            }
            else -> {
                x = index.toDouble()
                y = chartNumber(raw)
            }
        }
        if (x != null && y != null) out.add(ChartDatum(x, y, index, raw))
    }
    return out
}

/** An explicit `x: [min, max]` / `y: [min, max]` range, normalised ascending. */
internal fun chartRange(value: Any?): Pair<Double, Double>? {
    val list = when (value) {
        is List<*> -> value
        is String -> chartDecodeJson(value) as? List<*> ?: return null
        else -> return null
    }
    if (list.size < 2) return null
    val a = chartNumber(list[0]) ?: return null
    val b = chartNumber(list[1]) ?: return null
    return if (a <= b) a to b else b to a
}

/**
 * `highlight` = index | [indices] | absent. Null means "no highlight set at
 * all"; an empty set means "highlight nothing", which dims every row.
 */
internal fun chartHighlight(value: Any?): Set<Int>? {
    if (value == null || value == "" || value == false) return null
    val list = when (value) {
        is List<*> -> value
        is String -> chartDecodeJson(value) as? List<*> ?: listOf(value)
        else -> listOf(value)
    }
    val out = LinkedHashSet<Int>()
    for (item in list) {
        val n = chartNumber(item) ?: continue
        out.add(n.toInt())
    }
    return out
}

// ============================================================================
// Scales
// ============================================================================

/**
 * Data → pixel (well, dp) mapping for one axis.
 *
 * `band` is a categorical scale over first-seen categories; `linear` is the
 * usual numeric interpolation. y ranges run bottom→top, so `range.first >
 * range.second` there. [band] is the width of one categorical slot, or — for
 * a numeric scale hosting `Bars` — the step the chart hands bars to size
 * themselves from, which is why it is writable.
 */
class ChartScale private constructor(
    val isBand: Boolean,
    val min: Double,
    val max: Double,
    val categories: List<String>,
    val rangeStart: Double,
    val rangeEnd: Double,
) {
    var band: Double = 0.0
        internal set

    private val span: Double = (max - min).takeIf { it != 0.0 } ?: 1.0
    private val px: Double = rangeEnd - rangeStart
    private val index: Map<String, Int> =
        if (isBand) categories.withIndex().associate { (i, c) -> c to i } else emptyMap()

    /** Data → dp. Null for a category this scale does not know. */
    fun map(value: Any?): Double? {
        if (isBand) {
            val i = index[value?.toString()] ?: return null
            return rangeStart + (i + 0.5) * band
        }
        val n = chartNumber(value) ?: return null
        return rangeStart + ((n - min) / span) * px
    }

    /** dp → data (a fractional band index for a categorical scale). */
    fun invert(position: Double): Double {
        if (isBand) return (position - rangeStart) / (band.takeIf { it != 0.0 } ?: 1.0)
        return min + ((position - rangeStart) / (px.takeIf { it != 0.0 } ?: 1.0)) * span
    }

    companion object {
        fun linear(min: Double, max: Double, rangeStart: Double, rangeEnd: Double): ChartScale =
            ChartScale(false, min, max, emptyList(), rangeStart, rangeEnd)

        fun band(categories: List<String>, rangeStart: Double, rangeEnd: Double): ChartScale {
            val n = max(categories.size, 1)
            val scale = ChartScale(true, 0.0, n.toDouble(), categories, rangeStart, rangeEnd)
            scale.band = (rangeEnd - rangeStart) / n
            return scale
        }
    }
}

/**
 * The 1 / 2 / 5 / 10 step whose tick count lands nearest [count] — d3's
 * thresholds, ported so both renderers label the same values.
 */
internal fun chartNiceStep(min: Double, max: Double, count: Int): Double {
    val raw = (max - min) / max(count, 1)
    if (raw <= 0.0 || !raw.isFinite()) return 1.0
    val magnitude = 10.0.pow(floor(log10(raw)))
    val norm = raw / magnitude
    val nice = when {
        norm < 1.5 -> 1.0
        norm < 3.0 -> 2.0
        norm < 7.0 -> 5.0
        else -> 10.0
    }
    return nice * magnitude
}

/** Round a domain out to tick-friendly bounds; a degenerate domain is padded. */
fun chartNiceDomain(min: Double, max: Double, count: Int): Pair<Double, Double> {
    if (min == max) {
        val pad = if (min == 0.0) 1.0 else abs(min) * 0.1
        return (min - pad) to (max + pad)
    }
    val step = chartNiceStep(min, max, count)
    return (floor(min / step) * step) to (ceil(max / step) * step)
}

/** Tick values: multiples of the nice step that fall inside the domain. */
fun chartTicks(min: Double, max: Double, count: Int): List<Double> {
    if (min == max) return listOf(min)
    val step = chartNiceStep(min, max, count)
    val out = ArrayList<Double>()
    var v = ceil(min / step) * step
    // Float drift on repeated addition would drop the last tick; the epsilon
    // is the same one the DOM renderer uses.
    var guard = 0
    while (v <= max + step * 1e-9 && guard < 10_000) {
        out.add(chartRoundValue(v))
        v += step
        guard++
    }
    return out
}

/** Kill accumulated float noise so 0.30000000000000004 prints as 0.3. */
internal fun chartRoundValue(v: Double): Double {
    if (abs(v) < 1e-9) return 0.0
    return BigDecimal(v).round(MathContext(12)).toDouble()
}

/** Tick label: integers stay integral, everything else keeps 3 decimals. */
fun chartFormatTick(v: Double): String {
    if (!v.isFinite()) return ""
    if (v == floor(v) && abs(v) < 1e15) return v.toLong().toString()
    return BigDecimal(v)
        .setScale(3, RoundingMode.HALF_UP)
        .stripTrailingZeros()
        .toPlainString()
}
