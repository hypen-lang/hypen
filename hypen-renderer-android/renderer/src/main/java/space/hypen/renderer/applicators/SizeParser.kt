package space.hypen.renderer.applicators

import android.content.res.Resources
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Represents a parsed size value for cross-platform compatibility.
 *
 * Supported formats:
 * - Numbers: treated as dp (platform default)
 * - "100px": absolute pixels (1px = 1px everywhere)
 * - "100dp" / "100pt": density-independent points (equivalent)
 * - "50%": percentage of parent/available space
 * - "50vw" / "50vh": viewport width/height percentage
 * - "fill" / "100%": fill available space
 * - "wrap" / "auto": fit content
 */
sealed class SizeValue {
    /** Fixed size in density-independent pixels (dp) */
    data class Fixed(val dp: Dp) : SizeValue()

    /** Percentage of available space (0.0 to 1.0) */
    data class Percent(val fraction: Float) : SizeValue()

    /** Viewport width percentage */
    data class ViewportWidth(val fraction: Float) : SizeValue()

    /** Viewport height percentage */
    data class ViewportHeight(val fraction: Float) : SizeValue()

    /** Fill available space with optional fraction */
    data class Fill(val fraction: Float = 1f) : SizeValue()

    /** Wrap content (auto size) */
    object Wrap : SizeValue()
}

/**
 * Parse a size value from various formats.
 */
fun parseSizeValue(value: Any?): SizeValue? {
    if (value == null) return null

    // Handle numbers as dp
    when (value) {
        is Number -> return SizeValue.Fixed(value.toFloat().dp)
        is Boolean -> return null
    }

    val str = value.toString().trim().lowercase()

    // Keywords
    when (str) {
        "fill", "match_parent" -> return SizeValue.Fill(1f)
        "wrap", "wrap_content", "auto" -> return SizeValue.Wrap
        "infinity", "inf", "max" -> return SizeValue.Fill(1f)
    }

    // Parse percentage shortcuts
    if (str == "100%") return SizeValue.Fill(1f)

    // Handle rem units (1rem = 16dp)
    if (str.endsWith("rem")) {
        val num = str.removeSuffix("rem").toFloatOrNull() ?: return null
        return SizeValue.Fixed((num * 16f).dp)
    }

    // Parse value with unit using regex
    val regex = Regex("^(-?[\\d.]+)\\s*(px|dp|pt|sp|%|vw|vh)?$")
    val match = regex.matchEntire(str) ?: return null

    val numStr = match.groupValues[1]
    val unit = match.groupValues.getOrNull(2) ?: ""
    val num = numStr.toFloatOrNull() ?: return null

    return when (unit) {
        "px" -> {
            // Convert absolute pixels to dp
            // px to dp: dp = px / density
            val density = Resources.getSystem().displayMetrics.density
            SizeValue.Fixed((num / density).dp)
        }
        "dp", "sp", "" -> {
            // dp / sp are 1 logical Compose `.dp` at standard density.
            // (`sp` does not yet scale with the user's font-scale on
            //  non-text dimensions — that's a separate change.)
            // Empty unit defaults to dp.
            SizeValue.Fixed(num.dp)
        }
        "pt" -> {
            // Typographic point = 1/72 inch = 96/72 logical pixels.
            // Matches the iOS / CSS (`pt` native) definition.
            SizeValue.Fixed((num * (96f / 72f)).dp)
        }
        "%" -> {
            // Percentage (0-100) -> fraction (0-1)
            SizeValue.Percent(num / 100f)
        }
        "vw" -> {
            // Viewport width percentage
            SizeValue.ViewportWidth(num / 100f)
        }
        "vh" -> {
            // Viewport height percentage
            SizeValue.ViewportHeight(num / 100f)
        }
        else -> SizeValue.Fixed(num.dp)
    }
}

/**
 * Parse a CSS unit string (e.g. "1.5rem", "16px", "24dp", "16sp", "12pt") to Dp.
 *
 * Units:
 *  - `rem` → num × 16 dp
 *  - `dp`, `sp`, or no unit → num dp (sp does not yet runtime-scale)
 *  - `pt` → num × 96/72 dp (typographic point = 1/72 inch at 96dpi reference)
 *  - `px` → num dp (physical-pixel conversion is done in `parseSizeValue`
 *           where we have access to display density; here we approximate
 *           1:1 to keep this helper non-composable-friendly)
 *
 * Returns null if unparseable.
 */
fun parseCssUnit(value: String): Dp? {
    val str = value.trim().lowercase()
    if (str.endsWith("rem")) {
        val num = str.removeSuffix("rem").toFloatOrNull() ?: return null
        return (num * 16f).dp
    }
    if (str.endsWith("pt")) {
        val num = str.removeSuffix("pt").toFloatOrNull() ?: return null
        return (num * (96f / 72f)).dp
    }
    val cleaned = str
        .replace("px", "")
        .replace("dp", "")
        .replace("sp", "")
        .trim()
    val num = cleaned.toFloatOrNull() ?: return null
    return num.dp
}

/**
 * Parse an arbitrary applicator value into Dp.
 *
 * Accepts:
 * - `Number` → treated as dp
 * - `String` → parsed via [parseCssUnit]
 * - `null` → null
 *
 * Returns null when the value cannot be parsed.
 */
fun parseDp(value: Any?): Dp? = when (value) {
    null -> null
    is Number -> value.toFloat().dp
    is String -> parseCssUnit(value)
    else -> null
}

/**
 * Collect positional applicator args from a grouped value map.
 *
 * Engine emits applicator positional args as `name.0`, `name.1`, … which the
 * applicator registry groups into a single map keyed by `"0"`, `"1"`, ….
 * This walks the map in order and stops at the first gap, returning the values
 * for the contiguous prefix `"0".."N"`. Returns an empty list when there are
 * no positional args.
 */
fun collectPositional(map: Map<*, *>): List<Any?> {
    val args = mutableListOf<Any?>()
    var i = 0
    while (true) {
        if (!map.containsKey(i.toString())) break
        args += map[i.toString()]
        i++
    }
    return args
}

/**
 * Resolve a 4-tuple of (start, top, end, bottom) Dp from positional CSS-shorthand args.
 *
 * Mirrors CSS shorthand semantics:
 * - 1 value: all four sides
 * - 2 values: vertical, horizontal
 * - 3 values: top, horizontal, bottom
 * - 4 values: top, right, bottom, left
 *
 * Unparseable / missing values return 0.dp for that side.
 */
data class Edges(val start: Dp, val top: Dp, val end: Dp, val bottom: Dp)

fun edgesFromPositional(args: List<Any?>): Edges {
    fun dpAt(i: Int) = parseDp(args.getOrNull(i)) ?: 0.dp
    return when (args.size) {
        1 -> {
            val all = dpAt(0)
            Edges(start = all, top = all, end = all, bottom = all)
        }
        2 -> {
            val v = dpAt(0)
            val h = dpAt(1)
            Edges(start = h, top = v, end = h, bottom = v)
        }
        3 -> {
            val t = dpAt(0)
            val h = dpAt(1)
            val b = dpAt(2)
            Edges(start = h, top = t, end = h, bottom = b)
        }
        else -> {
            // 4+ args: top, right, bottom, left (extra args ignored)
            val t = dpAt(0)
            val r = dpAt(1)
            val b = dpAt(2)
            val l = dpAt(3)
            Edges(start = l, top = t, end = r, bottom = b)
        }
    }
}

/**
 * Get screen width in dp for viewport calculations.
 * Uses system display metrics (non-composable).
 */
fun systemScreenWidthDp(): Dp {
    val metrics = Resources.getSystem().displayMetrics
    return (metrics.widthPixels / metrics.density).dp
}

/**
 * Get screen height in dp for viewport calculations.
 * Uses system display metrics (non-composable).
 */
fun systemScreenHeightDp(): Dp {
    val metrics = Resources.getSystem().displayMetrics
    return (metrics.heightPixels / metrics.density).dp
}

/**
 * Apply a width SizeValue to a Modifier.
 */
fun Modifier.applyWidth(size: SizeValue): Modifier = when (size) {
    is SizeValue.Fixed -> width(size.dp)
    is SizeValue.Percent -> fillMaxWidth(size.fraction.coerceIn(0f, 1f))
    is SizeValue.ViewportWidth -> width(systemScreenWidthDp() * size.fraction)
    is SizeValue.ViewportHeight -> width(systemScreenHeightDp() * size.fraction)
    is SizeValue.Fill -> fillMaxWidth(size.fraction.coerceIn(0f, 1f))
    is SizeValue.Wrap -> wrapContentWidth()
}

/**
 * Apply a height SizeValue to a Modifier.
 */
fun Modifier.applyHeight(size: SizeValue): Modifier = when (size) {
    is SizeValue.Fixed -> height(size.dp)
    is SizeValue.Percent -> fillMaxHeight(size.fraction.coerceIn(0f, 1f))
    is SizeValue.ViewportWidth -> height(systemScreenWidthDp() * size.fraction)
    is SizeValue.ViewportHeight -> height(systemScreenHeightDp() * size.fraction)
    is SizeValue.Fill -> fillMaxHeight(size.fraction.coerceIn(0f, 1f))
    is SizeValue.Wrap -> wrapContentHeight()
}

/**
 * Apply a min width SizeValue to a Modifier.
 */
fun Modifier.applyMinWidth(size: SizeValue): Modifier = when (size) {
    is SizeValue.Fixed -> widthIn(min = size.dp)
    is SizeValue.ViewportWidth -> widthIn(min = systemScreenWidthDp() * size.fraction)
    is SizeValue.ViewportHeight -> widthIn(min = systemScreenHeightDp() * size.fraction)
    else -> this // Percent, Fill, Wrap don't apply to min
}

/**
 * Apply a max width SizeValue to a Modifier.
 */
fun Modifier.applyMaxWidth(size: SizeValue): Modifier = when (size) {
    is SizeValue.Fixed -> widthIn(max = size.dp)
    is SizeValue.ViewportWidth -> widthIn(max = systemScreenWidthDp() * size.fraction)
    is SizeValue.ViewportHeight -> widthIn(max = systemScreenHeightDp() * size.fraction)
    is SizeValue.Fill -> fillMaxWidth(size.fraction.coerceIn(0f, 1f))
    else -> this
}

/**
 * Apply a min height SizeValue to a Modifier.
 */
fun Modifier.applyMinHeight(size: SizeValue): Modifier = when (size) {
    is SizeValue.Fixed -> heightIn(min = size.dp)
    is SizeValue.ViewportWidth -> heightIn(min = systemScreenWidthDp() * size.fraction)
    is SizeValue.ViewportHeight -> heightIn(min = systemScreenHeightDp() * size.fraction)
    else -> this
}

/**
 * Apply a max height SizeValue to a Modifier.
 */
fun Modifier.applyMaxHeight(size: SizeValue): Modifier = when (size) {
    is SizeValue.Fixed -> heightIn(max = size.dp)
    is SizeValue.ViewportWidth -> heightIn(max = systemScreenWidthDp() * size.fraction)
    is SizeValue.ViewportHeight -> heightIn(max = systemScreenHeightDp() * size.fraction)
    is SizeValue.Fill -> fillMaxHeight(size.fraction.coerceIn(0f, 1f))
    else -> this
}
