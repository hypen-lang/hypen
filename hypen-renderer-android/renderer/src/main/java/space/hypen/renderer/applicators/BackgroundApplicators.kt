package space.hypen.renderer.applicators

import androidx.compose.foundation.background
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale

/**
 * Applicator for linear gradient background.
 * Supports:
 * - Map format: linearGradient({colors: ["red", "blue"], angle: 45})
 * - String format: linearGradient("to right, #3b82f6, #8b5cf6")
 * - String format: linearGradient("135deg, #667eea, #764ba2")
 */
class LinearGradientApplicator : ApplicatorHandler {
    override val name: String = "linearGradient"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val (colors, angle) = when (value) {
            is String -> parseGradientString(value)
            is Map<*, *> -> parseGradientMap(value)
            else -> return modifier
        }

        if (colors.size < 2) return modifier

        val brush = createBrushForAngle(colors, angle)
        return modifier.background(brush)
    }

    /**
     * Parse CSS-like gradient string format.
     * Examples:
     * - "to right, #3b82f6, #8b5cf6"
     * - "to bottom, red, blue"
     * - "135deg, #667eea, #764ba2"
     * - "45deg, #f093fb, #f5576c"
     */
    private fun parseGradientString(value: String): Pair<List<Color>, Float> {
        val parts = value.split(",").map { it.trim() }
        if (parts.size < 2) return emptyList<Color>() to 0f

        val firstPart = parts[0].lowercase()
        val angle: Float
        val colorStrings: List<String>

        when {
            firstPart.startsWith("to ") -> {
                angle = parseDirectionToAngle(firstPart)
                colorStrings = parts.drop(1)
            }
            firstPart.endsWith("deg") -> {
                angle = firstPart.removeSuffix("deg").toFloatOrNull() ?: 0f
                colorStrings = parts.drop(1)
            }
            else -> {
                // No direction specified, assume all parts are colors
                angle = 180f // default: top to bottom
                colorStrings = parts
            }
        }

        val colors = colorStrings.mapNotNull { ColorParser.parse(it.trim()) }
        return colors to angle
    }

    /**
     * Parse direction keywords to angle.
     * CSS gradient directions:
     * - "to top" = 0deg (bottom to top)
     * - "to right" = 90deg (left to right)
     * - "to bottom" = 180deg (top to bottom)
     * - "to left" = 270deg (right to left)
     * - "to top right" / "to bottom right" etc for diagonals
     */
    private fun parseDirectionToAngle(direction: String): Float {
        return when (direction) {
            "to top" -> 0f
            "to right" -> 90f
            "to bottom" -> 180f
            "to left" -> 270f
            "to top right", "to right top" -> 45f
            "to bottom right", "to right bottom" -> 135f
            "to bottom left", "to left bottom" -> 225f
            "to top left", "to left top" -> 315f
            else -> 180f // default: top to bottom
        }
    }

    private fun parseGradientMap(value: Map<*, *>): Pair<List<Color>, Float> {
        val colorsList = value["colors"] as? List<*> ?: return emptyList<Color>() to 0f
        val colors = colorsList.mapNotNull { ColorParser.parse(it) }
        val angle = (value["angle"] as? Number)?.toFloat() ?: 0f
        return colors to angle
    }

    private fun createBrushForAngle(colors: List<Color>, angle: Float): Brush {
        // Normalize angle to 0-360
        val normalizedAngle = ((angle % 360) + 360) % 360

        return when {
            normalizedAngle < 22.5f || normalizedAngle >= 337.5f -> {
                // ~0deg: bottom to top
                Brush.verticalGradient(colors.reversed())
            }
            normalizedAngle < 67.5f -> {
                // ~45deg: bottom-left to top-right
                Brush.linearGradient(
                    colors = colors,
                    start = androidx.compose.ui.geometry.Offset(0f, Float.POSITIVE_INFINITY),
                    end = androidx.compose.ui.geometry.Offset(Float.POSITIVE_INFINITY, 0f)
                )
            }
            normalizedAngle < 112.5f -> {
                // ~90deg: left to right
                Brush.horizontalGradient(colors)
            }
            normalizedAngle < 157.5f -> {
                // ~135deg: top-left to bottom-right
                Brush.linearGradient(
                    colors = colors,
                    start = androidx.compose.ui.geometry.Offset(0f, 0f),
                    end = androidx.compose.ui.geometry.Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY)
                )
            }
            normalizedAngle < 202.5f -> {
                // ~180deg: top to bottom
                Brush.verticalGradient(colors)
            }
            normalizedAngle < 247.5f -> {
                // ~225deg: top-right to bottom-left
                Brush.linearGradient(
                    colors = colors,
                    start = androidx.compose.ui.geometry.Offset(Float.POSITIVE_INFINITY, 0f),
                    end = androidx.compose.ui.geometry.Offset(0f, Float.POSITIVE_INFINITY)
                )
            }
            normalizedAngle < 292.5f -> {
                // ~270deg: right to left
                Brush.horizontalGradient(colors.reversed())
            }
            else -> {
                // ~315deg: bottom-right to top-left
                Brush.linearGradient(
                    colors = colors,
                    start = androidx.compose.ui.geometry.Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY),
                    end = androidx.compose.ui.geometry.Offset(0f, 0f)
                )
            }
        }
    }
}

/**
 * Applicator for radial gradient background.
 * Supports: radialGradient({colors: ["red", "blue"], radius: 100})
 */
class RadialGradientApplicator : ApplicatorHandler {
    override val name: String = "radialGradient"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        if (value !is Map<*, *>) return modifier

        val colorsList = value["colors"] as? List<*> ?: return modifier
        val colors = colorsList.mapNotNull { ColorParser.parse(it) }
        if (colors.size < 2) return modifier

        val brush = Brush.radialGradient(colors)
        return modifier.background(brush)
    }
}

/**
 * Applicator for sweep/conic gradient background.
 */
class ConicGradientApplicator : ApplicatorHandler {
    override val name: String = "conicGradient"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        if (value !is Map<*, *>) return modifier

        val colorsList = value["colors"] as? List<*> ?: return modifier
        val colors = colorsList.mapNotNull { ColorParser.parse(it) }
        if (colors.size < 2) return modifier

        val brush = Brush.sweepGradient(colors)
        return modifier.background(brush)
    }
}

/**
 * Applicator for gradient (generic).
 * Supports: gradient({type: "linear", colors: [...], angle: 45})
 */
class GradientApplicator : ApplicatorHandler {
    override val name: String = "gradient"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        if (value !is Map<*, *>) return modifier

        val type = (value["type"] as? String)?.lowercase() ?: "linear"
        val colorsList = value["colors"] as? List<*> ?: return modifier
        val colors = colorsList.mapNotNull { ColorParser.parse(it) }
        if (colors.size < 2) return modifier

        val brush = when (type) {
            "linear" -> {
                val angle = (value["angle"] as? Number)?.toFloat() ?: 0f
                when (angle.toInt() % 360) {
                    0, 360 -> Brush.verticalGradient(colors)
                    90 -> Brush.horizontalGradient(colors)
                    180 -> Brush.verticalGradient(colors.reversed())
                    270 -> Brush.horizontalGradient(colors.reversed())
                    else -> Brush.verticalGradient(colors)
                }
            }
            "radial" -> Brush.radialGradient(colors)
            "sweep", "conic" -> Brush.sweepGradient(colors)
            else -> Brush.verticalGradient(colors)
        }

        return modifier.background(brush)
    }
}

/**
 * Applicator for backgroundImage.
 * Note: In Compose, background images require AsyncImage or similar.
 * This is a placeholder that logs a warning - actual implementation
 * would need to be done at component level.
 */
class BackgroundImageApplicator : ApplicatorHandler {
    override val name: String = "backgroundImage"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Background images in Compose are typically handled differently
        // (using Box with Image behind content, or custom Painter)
        // This applicator logs a warning for now
        android.util.Log.w(
            "BackgroundImageApplicator",
            "backgroundImage applicator is not fully supported in Compose. " +
            "Consider using an Image component as a sibling in a Box/Stack."
        )
        return modifier
    }
}

/**
 * Applicator for backgroundSize.
 * Placeholder for API compatibility.
 */
class BackgroundSizeApplicator : ApplicatorHandler {
    override val name: String = "backgroundSize"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Would need to be combined with backgroundImage at component level
        return modifier
    }
}

/**
 * Applicator for backgroundPosition.
 * Placeholder for API compatibility.
 */
class BackgroundPositionApplicator : ApplicatorHandler {
    override val name: String = "backgroundPosition"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // Would need to be combined with backgroundImage at component level
        return modifier
    }
}
