package space.hypen.renderer.applicators

import androidx.compose.foundation.background
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

/**
 * Utility for parsing color values.
 */
object ColorParser {
    // Full CSS named colors for cross-platform consistency
    private val namedColors = mapOf(
        // Basic colors
        "red" to Color.Red,
        "green" to Color.Green,
        "blue" to Color.Blue,
        "white" to Color.White,
        "black" to Color.Black,
        "yellow" to Color.Yellow,
        "cyan" to Color.Cyan,
        "magenta" to Color.Magenta,
        "gray" to Color.Gray,
        "grey" to Color.Gray,
        "lightgray" to Color.LightGray,
        "lightgrey" to Color.LightGray,
        "darkgray" to Color.DarkGray,
        "darkgrey" to Color.DarkGray,
        "transparent" to Color.Transparent,
        "orange" to Color(0xFFFFA500),
        "purple" to Color(0xFF800080),
        "pink" to Color(0xFFFFC0CB),
        "brown" to Color(0xFFA52A2A),
        "teal" to Color(0xFF008080),
        "indigo" to Color(0xFF4B0082),

        // Extended CSS colors
        "aliceblue" to Color(0xFFF0F8FF),
        "antiquewhite" to Color(0xFFFAEBD7),
        "aqua" to Color(0xFF00FFFF),
        "aquamarine" to Color(0xFF7FFFD4),
        "azure" to Color(0xFFF0FFFF),
        "beige" to Color(0xFFF5F5DC),
        "bisque" to Color(0xFFFFE4C4),
        "blanchedalmond" to Color(0xFFFFEBCD),
        "blueviolet" to Color(0xFF8A2BE2),
        "burlywood" to Color(0xFFDEB887),
        "cadetblue" to Color(0xFF5F9EA0),
        "chartreuse" to Color(0xFF7FFF00),
        "chocolate" to Color(0xFFD2691E),
        "coral" to Color(0xFFFF7F50),
        "cornflowerblue" to Color(0xFF6495ED),
        "cornsilk" to Color(0xFFFFF8DC),
        "crimson" to Color(0xFFDC143C),
        "darkblue" to Color(0xFF00008B),
        "darkcyan" to Color(0xFF008B8B),
        "darkgoldenrod" to Color(0xFFB8860B),
        "darkgreen" to Color(0xFF006400),
        "darkkhaki" to Color(0xFFBDB76B),
        "darkmagenta" to Color(0xFF8B008B),
        "darkolivegreen" to Color(0xFF556B2F),
        "darkorange" to Color(0xFFFF8C00),
        "darkorchid" to Color(0xFF9932CC),
        "darkred" to Color(0xFF8B0000),
        "darksalmon" to Color(0xFFE9967A),
        "darkseagreen" to Color(0xFF8FBC8F),
        "darkslateblue" to Color(0xFF483D8B),
        "darkslategray" to Color(0xFF2F4F4F),
        "darkslategrey" to Color(0xFF2F4F4F),
        "darkturquoise" to Color(0xFF00CED1),
        "darkviolet" to Color(0xFF9400D3),
        "deeppink" to Color(0xFFFF1493),
        "deepskyblue" to Color(0xFF00BFFF),
        "dimgray" to Color(0xFF696969),
        "dimgrey" to Color(0xFF696969),
        "dodgerblue" to Color(0xFF1E90FF),
        "firebrick" to Color(0xFFB22222),
        "floralwhite" to Color(0xFFFFFAF0),
        "forestgreen" to Color(0xFF228B22),
        "fuchsia" to Color(0xFFFF00FF),
        "gainsboro" to Color(0xFFDCDCDC),
        "ghostwhite" to Color(0xFFF8F8FF),
        "gold" to Color(0xFFFFD700),
        "goldenrod" to Color(0xFFDAA520),
        "greenyellow" to Color(0xFFADFF2F),
        "honeydew" to Color(0xFFF0FFF0),
        "hotpink" to Color(0xFFFF69B4),
        "indianred" to Color(0xFFCD5C5C),
        "ivory" to Color(0xFFFFFFF0),
        "khaki" to Color(0xFFF0E68C),
        "lavender" to Color(0xFFE6E6FA),
        "lavenderblush" to Color(0xFFFFF0F5),
        "lawngreen" to Color(0xFF7CFC00),
        "lemonchiffon" to Color(0xFFFFFACD),
        "lightblue" to Color(0xFFADD8E6),
        "lightcoral" to Color(0xFFF08080),
        "lightcyan" to Color(0xFFE0FFFF),
        "lightgoldenrodyellow" to Color(0xFFFAFAD2),
        "lightgreen" to Color(0xFF90EE90),
        "lightpink" to Color(0xFFFFB6C1),
        "lightsalmon" to Color(0xFFFFA07A),
        "lightseagreen" to Color(0xFF20B2AA),
        "lightskyblue" to Color(0xFF87CEFA),
        "lightslategray" to Color(0xFF778899),
        "lightslategrey" to Color(0xFF778899),
        "lightsteelblue" to Color(0xFFB0C4DE),
        "lightyellow" to Color(0xFFFFFFE0),
        "lime" to Color(0xFF00FF00),
        "limegreen" to Color(0xFF32CD32),
        "linen" to Color(0xFFFAF0E6),
        "maroon" to Color(0xFF800000),
        "mediumaquamarine" to Color(0xFF66CDAA),
        "mediumblue" to Color(0xFF0000CD),
        "mediumorchid" to Color(0xFFBA55D3),
        "mediumpurple" to Color(0xFF9370DB),
        "mediumseagreen" to Color(0xFF3CB371),
        "mediumslateblue" to Color(0xFF7B68EE),
        "mediumspringgreen" to Color(0xFF00FA9A),
        "mediumturquoise" to Color(0xFF48D1CC),
        "mediumvioletred" to Color(0xFFC71585),
        "midnightblue" to Color(0xFF191970),
        "mintcream" to Color(0xFFF5FFFA),
        "mistyrose" to Color(0xFFFFE4E1),
        "moccasin" to Color(0xFFFFE4B5),
        "navajowhite" to Color(0xFFFFDEAD),
        "navy" to Color(0xFF000080),
        "oldlace" to Color(0xFFFDF5E6),
        "olive" to Color(0xFF808000),
        "olivedrab" to Color(0xFF6B8E23),
        "orangered" to Color(0xFFFF4500),
        "orchid" to Color(0xFFDA70D6),
        "palegoldenrod" to Color(0xFFEEE8AA),
        "palegreen" to Color(0xFF98FB98),
        "paleturquoise" to Color(0xFFAFEEEE),
        "palevioletred" to Color(0xFFDB7093),
        "papayawhip" to Color(0xFFFFEFD5),
        "peachpuff" to Color(0xFFFFDAB9),
        "peru" to Color(0xFFCD853F),
        "plum" to Color(0xFFDDA0DD),
        "powderblue" to Color(0xFFB0E0E6),
        "rosybrown" to Color(0xFFBC8F8F),
        "royalblue" to Color(0xFF4169E1),
        "saddlebrown" to Color(0xFF8B4513),
        "salmon" to Color(0xFFFA8072),
        "sandybrown" to Color(0xFFF4A460),
        "seagreen" to Color(0xFF2E8B57),
        "seashell" to Color(0xFFFFF5EE),
        "sienna" to Color(0xFFA0522D),
        "silver" to Color(0xFFC0C0C0),
        "skyblue" to Color(0xFF87CEEB),
        "slateblue" to Color(0xFF6A5ACD),
        "slategray" to Color(0xFF708090),
        "slategrey" to Color(0xFF708090),
        "snow" to Color(0xFFFFFAFA),
        "springgreen" to Color(0xFF00FF7F),
        "steelblue" to Color(0xFF4682B4),
        "tan" to Color(0xFFD2B48C),
        "thistle" to Color(0xFFD8BFD8),
        "tomato" to Color(0xFFFF6347),
        "turquoise" to Color(0xFF40E0D0),
        "violet" to Color(0xFFEE82EE),
        "wheat" to Color(0xFFF5DEB3),
        "whitesmoke" to Color(0xFFF5F5F5),
        "yellowgreen" to Color(0xFF9ACD32),

        // Semantic/alias colors
        "clear" to Color.Transparent,
    )

    fun parse(value: Any?): Color? =
        when (value) {
            is String -> parseString(value)
            is Number -> Color(value.toLong())
            is Map<*, *> -> parseMap(value)
            else -> null
        }

    private fun parseString(value: String): Color? {
        val trimmed = value.trim().lowercase()

        // Check named colors
        namedColors[trimmed]?.let { return it }

        // Check for rgb/rgba format
        if (trimmed.startsWith("rgb")) {
            return parseRgb(trimmed)
        }

        // Check for hsl/hsla format
        if (trimmed.startsWith("hsl")) {
            return parseHsl(trimmed)
        }

        // Parse hex color
        return parseHex(trimmed)
    }

    // Compiled once — these run per color-bearing prop per recomposition
    private val RGB_PATTERN = Regex("""rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)""")
    private val HSL_PATTERN = Regex("""hsla?\s*\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?\s*(?:,\s*([\d.]+))?\s*\)""")

    private fun parseRgb(value: String): Color? {
        // Match rgb(r, g, b) or rgba(r, g, b, a)
        val match = RGB_PATTERN.find(value) ?: return null

        val r = match.groupValues[1].toIntOrNull() ?: return null
        val g = match.groupValues[2].toIntOrNull() ?: return null
        val b = match.groupValues[3].toIntOrNull() ?: return null
        val a = match.groupValues[4].let { alphaStr ->
            if (alphaStr.isEmpty()) 1f
            else {
                val alpha = alphaStr.toFloatOrNull() ?: 1f
                if (alpha > 1f) alpha / 255f else alpha
            }
        }

        return Color(r / 255f, g / 255f, b / 255f, a)
    }

    private fun parseHsl(value: String): Color? {
        // Match hsl(h, s%, l%) or hsla(h, s%, l%, a)
        val match = HSL_PATTERN.find(value) ?: return null

        val h = match.groupValues[1].toFloatOrNull() ?: return null
        val s = match.groupValues[2].toFloatOrNull() ?: return null
        val l = match.groupValues[3].toFloatOrNull() ?: return null
        val a = match.groupValues[4].let { alphaStr ->
            if (alphaStr.isEmpty()) 1f
            else {
                val alpha = alphaStr.toFloatOrNull() ?: 1f
                if (alpha > 1f) alpha / 255f else alpha
            }
        }

        // Convert HSL to RGB
        val rgb = hslToRgb(h / 360f, s / 100f, l / 100f)
        return Color(rgb[0], rgb[1], rgb[2], a)
    }

    private fun hslToRgb(h: Float, s: Float, l: Float): FloatArray {
        val c = (1 - kotlin.math.abs(2 * l - 1)) * s
        val x = c * (1 - kotlin.math.abs((h * 6) % 2 - 1))
        val m = l - c / 2

        val (r1, g1, b1) = when {
            h < 1f / 6 -> Triple(c, x, 0f)
            h < 2f / 6 -> Triple(x, c, 0f)
            h < 3f / 6 -> Triple(0f, c, x)
            h < 4f / 6 -> Triple(0f, x, c)
            h < 5f / 6 -> Triple(x, 0f, c)
            else -> Triple(c, 0f, x)
        }

        return floatArrayOf(r1 + m, g1 + m, b1 + m)
    }

    private fun parseHex(value: String): Color? {
        val hex = value.removePrefix("#").removePrefix("0x")
        return try {
            when (hex.length) {
                3 -> {
                    // #RGB -> #RRGGBB
                    val r = hex[0].toString().repeat(2).toInt(16)
                    val g = hex[1].toString().repeat(2).toInt(16)
                    val b = hex[2].toString().repeat(2).toInt(16)
                    Color(r, g, b)
                }
                4 -> {
                    // #RGBA -> #RRGGBBAA
                    val r = hex[0].toString().repeat(2).toInt(16)
                    val g = hex[1].toString().repeat(2).toInt(16)
                    val b = hex[2].toString().repeat(2).toInt(16)
                    val a = hex[3].toString().repeat(2).toInt(16)
                    Color(r, g, b, a)
                }
                6 -> {
                    // #RRGGBB
                    val r = hex.substring(0, 2).toInt(16)
                    val g = hex.substring(2, 4).toInt(16)
                    val b = hex.substring(4, 6).toInt(16)
                    Color(r, g, b)
                }
                8 -> {
                    // #RRGGBBAA
                    val r = hex.substring(0, 2).toInt(16)
                    val g = hex.substring(2, 4).toInt(16)
                    val b = hex.substring(4, 6).toInt(16)
                    val a = hex.substring(6, 8).toInt(16)
                    Color(r, g, b, a)
                }
                else -> null
            }
        } catch (e: NumberFormatException) {
            null
        }
    }

    private fun parseMap(value: Map<*, *>): Color? {
        val r =
            (value["r"] as? Number)?.toInt()
                ?: (value["red"] as? Number)?.toInt()
                ?: 0
        val g =
            (value["g"] as? Number)?.toInt()
                ?: (value["green"] as? Number)?.toInt()
                ?: 0
        val b =
            (value["b"] as? Number)?.toInt()
                ?: (value["blue"] as? Number)?.toInt()
                ?: 0
        val a =
            (value["a"] as? Number)?.toInt()
                ?: (value["alpha"] as? Number)?.toInt()
                ?: 255

        return Color(r, g, b, a)
    }
}

/**
 * Applicator for backgroundColor.
 */
class BackgroundColorApplicator : ApplicatorHandler {
    override val name: String = "backgroundColor"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val color = ColorParser.parse(value) ?: return modifier
        return modifier.background(color)
    }
}

/**
 * Applicator for foregroundColor (text color on non-text elements).
 */
class ForegroundColorApplicator : ApplicatorHandler {
    override val name: String = "foregroundColor"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // In Compose, foreground color for non-text elements is handled
        // at the component level via LocalContentColor. Store for component access.
        return modifier
    }
}

/**
 * The CSS `background` shorthand.
 *
 * This was an alias for `backgroundColor`, so anything that wasn't a flat
 * colour — a gradient, an image, or a layered combination of both —
 * silently vanished. The home-screen example's wallpaper arrives as
 * `linear-gradient(…), url('data:image/png;base64,…') center / cover
 * no-repeat`, which is exactly that case.
 *
 * A bare colour still takes the colour path, so `background("#fff")` is
 * unchanged.
 */
class BackgroundApplicator : ApplicatorHandler {
    override val name: String = "background"

    private val delegate = BackgroundColorApplicator()

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val layers = CssBackground.parse(value)
            ?: return delegate.apply(modifier, value, context)
        return modifier.paintCssBackground(layers)
    }
}
