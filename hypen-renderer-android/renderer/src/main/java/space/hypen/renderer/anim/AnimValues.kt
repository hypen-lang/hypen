package space.hypen.renderer.anim

import androidx.compose.ui.graphics.Color
import space.hypen.renderer.applicators.ColorParser

/**
 * Value interpolation for `.transition` glides — plain Kotlin so the
 * whitelist's numeric/color semantics are unit-testable.
 *
 * Two families, matching the shared contract:
 *
 * - **Colors** (`color`, `backgroundColor`, `borderColor`) interpolate in
 *   RGBA, exactly like the canvas ticker. Unparseable endpoints snap.
 * - **Everything else** interpolates numerically, carrying the unit suffix
 *   through (`"16px"` → `"12.4px"`). Mismatched or unparseable units snap —
 *   a renderer must never render a wrong pose to preserve an animation
 *   (protocol invariant 6).
 */
object AnimValues {
    /** A number with the unit suffix it was written with (empty = bare). */
    data class Scalar(val value: Double, val unit: String)

    private val UNITS = listOf("px", "dp", "pt", "rem", "em", "%")

    fun scalar(value: Any?): Scalar? =
        when (value) {
            is Number -> {
                val d = value.toDouble()
                if (d.isFinite()) Scalar(d, "") else null
            }
            is String -> {
                val trimmed = value.trim()
                val unit = UNITS.firstOrNull { trimmed.endsWith(it, ignoreCase = true) }
                val numeric = if (unit == null) trimmed else trimmed.dropLast(unit.length).trim()
                numeric.toDoubleOrNull()?.takeIf { it.isFinite() }?.let { Scalar(it, unit ?: "") }
            }
            else -> null
        }

    private fun format(value: Double, unit: String): Any =
        if (unit.isEmpty()) value else "${trimNumber(value)}$unit"

    private fun trimNumber(value: Double): String {
        val rounded = Math.round(value * 1000.0) / 1000.0
        return if (rounded == Math.floor(rounded) && !rounded.isInfinite()) {
            rounded.toLong().toString()
        } else {
            rounded.toString()
        }
    }

    /**
     * Build an interpolator between [from] and [to] for the whitelisted prop
     * [base], or null when the pair cannot be interpolated (the caller then
     * snaps to [to]).
     */
    fun interpolator(base: String, from: Any?, to: Any?): ((Float) -> Any?)? {
        if (base in COLOR_ANIMATABLE_PROPS) {
            val start = ColorParser.parse(from) ?: return null
            val end = ColorParser.parse(to) ?: return null
            if (start == end) return null
            // Straight RGBA, matching the canvas ticker and the browsers'
            // default `transition` interpolation — deliberately NOT Compose's
            // `Color.lerp`, which interpolates in Oklab and would land on a
            // different mid-flight color than every other Hypen renderer.
            return { t -> hex(lerpRgba(start, end, t.coerceIn(0f, 1f))) }
        }
        val start = scalar(from) ?: return null
        val end = scalar(to) ?: return null
        // A unit change is a different quantity — snap rather than lie.
        if (start.unit != end.unit) return null
        if (start.value == end.value) return null
        return { t -> format(start.value + (end.value - start.value) * t, start.unit) }
    }

    /** Per-channel sRGB interpolation (the cross-renderer contract). */
    fun lerpRgba(start: Color, end: Color, t: Float): Color =
        Color(
            red = start.red + (end.red - start.red) * t,
            green = start.green + (end.green - start.green) * t,
            blue = start.blue + (end.blue - start.blue) * t,
            alpha = start.alpha + (end.alpha - start.alpha) * t,
        )

    /**
     * `#RRGGBBAA` — the form `ColorParser` round-trips, so an interpolated
     * color flows back through the ordinary applicator path unchanged.
     */
    fun hex(color: Color): String {
        fun channel(v: Float): String =
            Math.round(v.coerceIn(0f, 1f) * 255f).toString(16).padStart(2, '0')
        return "#${channel(color.red)}${channel(color.green)}${channel(color.blue)}${channel(color.alpha)}"
    }
}
