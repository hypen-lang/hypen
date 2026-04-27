package space.hypen.renderer.applicators

import androidx.compose.foundation.background
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp

/**
 * Applicator for opacity/alpha.
 */
class OpacityApplicator : ApplicatorHandler {
    override val name: String = "opacity"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val alpha = when (value) {
            is Number -> value.toFloat().coerceIn(0f, 1f)
            is String -> value.toFloatOrNull()?.coerceIn(0f, 1f) ?: 1f
            else -> return modifier
        }
        return modifier.alpha(alpha)
    }
}

/**
 * Applicator for visibility.
 * Maps CSS visibility values to Compose alpha.
 */
class VisibilityApplicator : ApplicatorHandler {
    override val name: String = "visibility"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val visible = when (value) {
            is Boolean -> value
            is String -> when (value.lowercase()) {
                "visible", "true" -> true
                "hidden", "false", "collapse" -> false
                else -> true
            }
            else -> true
        }
        return if (visible) modifier else modifier.alpha(0f)
    }
}

/**
 * Applicator for shadow/elevation.
 * Supports both simple elevation value and compound shadow object.
 * Note: Compose shadow uses elevation (Material Design) rather than CSS x/y offsets.
 * The y offset is approximated by adjusting elevation.
 */
class ShadowApplicator : ApplicatorHandler {
    override val name: String = "shadow"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        return when (value) {
            is Number -> modifier.shadow(elevation = value.toFloat().dp)
            is Map<*, *> -> {
                // Support multiple naming conventions
                val blur = (value["blur"] as? Number)?.toFloat()
                    ?: (value["radius"] as? Number)?.toFloat()
                    ?: (value["elevation"] as? Number)?.toFloat()
                    ?: 4f

                // Parse x/y offsets (primarily use y to influence shadow appearance)
                val offsetY = (value["y"] as? Number)?.toFloat()
                    ?: (value["offsetY"] as? Number)?.toFloat()
                    ?: 0f

                // Elevation is based on blur, with Y offset adding to it
                val elevation = (blur + kotlin.math.abs(offsetY) * 0.5f).dp

                val color = ColorParser.parse(value["color"]) ?: Color.Black.copy(alpha = 0.2f)

                modifier.shadow(elevation = elevation, ambientColor = color, spotColor = color)
            }
            else -> modifier
        }
    }
}

/**
 * Applicator for elevation (Material Design elevation).
 */
class ElevationApplicator : ApplicatorHandler {
    override val name: String = "elevation"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val elevation = when (value) {
            is Number -> value.toFloat().dp
            else -> return modifier
        }
        return modifier.shadow(elevation = elevation)
    }
}

/**
 * Applicator for boxShadow (CSS-like).
 * Supports CSS string format "x y blur spread color" and object format.
 * Note: Spread is not supported in Compose; x/y offsets are approximated.
 */
class BoxShadowApplicator : ApplicatorHandler {
    override val name: String = "boxShadow"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        return when (value) {
            is String -> {
                // Parse CSS-like shadow string: "0 4px 8px rgba(0,0,0,0.2)"
                // Format: x y blur [spread] [color]
                val parts = value.trim().split(Regex("\\s+"))
                val offsetY = parts.getOrNull(1)?.let { parseCssUnit(it)?.value } ?: 0f
                val blurRadius = parts.getOrNull(2)?.let { parseCssUnit(it)?.value } ?: 4f

                // Try to parse color from remaining parts
                val colorStr = parts.drop(3).joinToString(" ").takeIf { it.isNotEmpty() }
                val color = colorStr?.let { ColorParser.parse(it) } ?: Color.Black.copy(alpha = 0.2f)

                val elevation = (blurRadius + kotlin.math.abs(offsetY) * 0.5f).dp
                modifier.shadow(elevation = elevation, ambientColor = color, spotColor = color)
            }
            is Map<*, *> -> {
                val blur = (value["blur"] as? Number)?.toFloat()
                    ?: (value["radius"] as? Number)?.toFloat()
                    ?: 4f
                val offsetY = (value["y"] as? Number)?.toFloat()
                    ?: (value["offsetY"] as? Number)?.toFloat()
                    ?: 0f

                val elevation = (blur + kotlin.math.abs(offsetY) * 0.5f).dp
                val color = ColorParser.parse(value["color"]) ?: Color.Black.copy(alpha = 0.2f)
                modifier.shadow(elevation = elevation, ambientColor = color, spotColor = color)
            }
            is Number -> modifier.shadow(elevation = value.toFloat().dp)
            else -> modifier
        }
    }
}

/**
 * Applicator for blur effect.
 */
class BlurApplicator : ApplicatorHandler {
    override val name: String = "blur"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val radius = when (value) {
            is Number -> value.toFloat().dp
            is String -> parseCssUnit(value) ?: return modifier
            else -> return modifier
        }
        return modifier.blur(radius)
    }
}

/**
 * Applicator for clipToBounds.
 * Clips content to the element's bounds.
 */
class ClipToBoundsApplicator : ApplicatorHandler {
    override val name: String = "clipToBounds"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val clip = when (value) {
            is Boolean -> value
            is String -> value.lowercase() == "true"
            else -> return modifier
        }
        return if (clip) modifier.graphicsLayer(clip = true) else modifier
    }
}

/**
 * Applicator for rotate transform.
 */
class RotateApplicator : ApplicatorHandler {
    override val name: String = "rotate"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val degrees = when (value) {
            is Number -> value.toFloat()
            is String -> {
                val str = value.lowercase()
                when {
                    str.endsWith("deg") -> str.removeSuffix("deg").toFloatOrNull() ?: 0f
                    str.endsWith("rad") -> Math.toDegrees(str.removeSuffix("rad").toDoubleOrNull() ?: 0.0).toFloat()
                    else -> str.toFloatOrNull() ?: 0f
                }
            }
            else -> return modifier
        }
        return modifier.rotate(degrees)
    }
}

/**
 * Applicator for scale transform.
 */
class ScaleApplicator : ApplicatorHandler {
    override val name: String = "scale"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        return when (value) {
            is Number -> modifier.scale(value.toFloat())
            is Map<*, *> -> {
                val scaleX = (value["x"] as? Number)?.toFloat() ?: 1f
                val scaleY = (value["y"] as? Number)?.toFloat() ?: 1f
                modifier.scale(scaleX, scaleY)
            }
            else -> modifier
        }
    }
}

/**
 * Applicator for scaleX transform.
 */
class ScaleXApplicator : ApplicatorHandler {
    override val name: String = "scaleX"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val scale = (value as? Number)?.toFloat() ?: return modifier
        return modifier.graphicsLayer(scaleX = scale)
    }
}

/**
 * Applicator for scaleY transform.
 */
class ScaleYApplicator : ApplicatorHandler {
    override val name: String = "scaleY"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val scale = (value as? Number)?.toFloat() ?: return modifier
        return modifier.graphicsLayer(scaleY = scale)
    }
}

/**
 * Applicator for translateX.
 */
class TranslateXApplicator : ApplicatorHandler {
    override val name: String = "translateX"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val tx = when (value) {
            is Number -> value.toFloat()
            is String -> parseCssUnit(value)?.value ?: return modifier
            else -> return modifier
        }
        return modifier.graphicsLayer(translationX = tx)
    }
}

/**
 * Applicator for translateY.
 */
class TranslateYApplicator : ApplicatorHandler {
    override val name: String = "translateY"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val ty = when (value) {
            is Number -> value.toFloat()
            is String -> parseCssUnit(value)?.value ?: return modifier
            else -> return modifier
        }
        return modifier.graphicsLayer(translationY = ty)
    }
}

/**
 * Applicator for compound transform.
 * Supports object with rotate, scale, translateX, translateY.
 */
class TransformApplicator : ApplicatorHandler {
    override val name: String = "transform"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        if (value !is Map<*, *>) return modifier

        val rotationZ = (value["rotate"] as? Number)?.toFloat() ?: 0f
        val scaleX = (value["scaleX"] as? Number)?.toFloat() ?: (value["scale"] as? Number)?.toFloat() ?: 1f
        val scaleY = (value["scaleY"] as? Number)?.toFloat() ?: (value["scale"] as? Number)?.toFloat() ?: 1f
        val translationX = (value["translateX"] as? Number)?.toFloat() ?: 0f
        val translationY = (value["translateY"] as? Number)?.toFloat() ?: 0f

        return modifier.graphicsLayer(
            rotationZ = rotationZ,
            scaleX = scaleX,
            scaleY = scaleY,
            translationX = translationX,
            translationY = translationY,
        )
    }
}
