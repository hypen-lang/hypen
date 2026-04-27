package space.hypen.renderer.applicators

import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Extension to draw a styled border (solid, dashed, dotted, double)
 */
fun Modifier.styledBorder(
    width: Dp,
    color: Color,
    style: String = "solid",
    cornerRadius: Dp = 0.dp
): Modifier = when (style.lowercase()) {
    "none" -> this
    "dashed" -> this.drawBehind {
        val strokeWidth = width.toPx()
        val dashLength = strokeWidth * 3
        val gapLength = strokeWidth * 2
        drawRoundRect(
            color = color,
            topLeft = Offset(strokeWidth / 2, strokeWidth / 2),
            size = Size(size.width - strokeWidth, size.height - strokeWidth),
            cornerRadius = CornerRadius(cornerRadius.toPx()),
            style = Stroke(
                width = strokeWidth,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(dashLength, gapLength), 0f)
            )
        )
    }
    "dotted" -> this.drawBehind {
        val strokeWidth = width.toPx()
        val dotSpacing = strokeWidth * 2
        drawRoundRect(
            color = color,
            topLeft = Offset(strokeWidth / 2, strokeWidth / 2),
            size = Size(size.width - strokeWidth, size.height - strokeWidth),
            cornerRadius = CornerRadius(cornerRadius.toPx()),
            style = Stroke(
                width = strokeWidth,
                cap = StrokeCap.Round,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(0f, dotSpacing), 0f)
            )
        )
    }
    "double" -> this.drawBehind {
        val strokeWidth = width.toPx() / 3
        val offset = strokeWidth * 2
        // Outer border
        drawRoundRect(
            color = color,
            topLeft = Offset(strokeWidth / 2, strokeWidth / 2),
            size = Size(size.width - strokeWidth, size.height - strokeWidth),
            cornerRadius = CornerRadius(cornerRadius.toPx()),
            style = Stroke(width = strokeWidth)
        )
        // Inner border
        drawRoundRect(
            color = color,
            topLeft = Offset(offset + strokeWidth / 2, offset + strokeWidth / 2),
            size = Size(size.width - offset * 2 - strokeWidth, size.height - offset * 2 - strokeWidth),
            cornerRadius = CornerRadius(maxOf(0f, cornerRadius.toPx() - offset)),
            style = Stroke(width = strokeWidth)
        )
    }
    else -> this.border(width, color, RoundedCornerShape(cornerRadius)) // "solid" and default
}

/**
 * Applicator for border.
 */
class BorderApplicator : ApplicatorHandler {
    override val name: String = "border"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier =
        when (value) {
            is Number -> modifier.border(value.toFloat().dp, Color.Black)
            is Map<*, *> -> {
                val width = (value["width"] as? Number)?.toFloat()?.dp ?: 1.dp
                val color = ColorParser.parse(value["color"]) ?: Color.Black
                val radius = (value["radius"] as? Number)?.toFloat()?.dp ?: 0.dp
                val style = (value["style"] as? String) ?: "solid"
                modifier.styledBorder(width, color, style, radius)
            }
            else -> modifier
        }
}

/**
 * Applicator for borderWidth.
 * Reads borderColor, borderStyle, and borderRadius from element props to produce a complete border.
 */
class BorderWidthApplicator : ApplicatorHandler {
    override val name: String = "borderWidth"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        val width =
            when (value) {
                is Number -> value.toFloat().dp
                is String -> parseCssUnit(value) ?: return modifier
                else -> return modifier
            }
        // `border-0` in Tailwind emits `border-width: 0px`, which we must treat
        // as "no border at all". Compose's `Modifier.border(0.dp, ...)` still
        // strokes a sub-pixel hairline, which showed up as a visible gray ring
        // on every icon button using `border-0`. Bail out before touching the
        // modifier when the width is non-positive.
        if (width.value <= 0f) return modifier

        // Read borderColor from element props, fall back to gray (visible on both light/dark)
        val colorValue = context.element.props["borderColor.0"] ?: context.element.props["borderColor"]
        val color = ColorParser.parse(colorValue) ?: Color.Gray

        // Read borderStyle from element props
        val style = (context.element.props["borderStyle.0"] as? String)
            ?: (context.element.props["borderStyle"] as? String)
            ?: "solid"

        // Read borderRadius from element props (may be a number or CSS string like "9999px")
        val radiusValue = context.element.props["borderRadius.0"] ?: context.element.props["borderRadius"]
        val radius: Dp = when (radiusValue) {
            is Number -> radiusValue.toFloat().dp
            is String -> parseCssUnit(radiusValue) ?: 0.dp
            else -> 0.dp
        }

        return modifier.styledBorder(width, color, style, radius)
    }
}

/**
 * Applicator for borderColor.
 * If borderWidth is also set on this element, defers to BorderWidthApplicator which produces
 * the complete border. Otherwise applies a 1dp border with this color.
 */
class BorderColorApplicator : ApplicatorHandler {
    override val name: String = "borderColor"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // If borderWidth is set, it will handle the complete border with this color
        val hasBorderWidth = context.element.props.keys.any { it.startsWith("borderWidth") }
        if (hasBorderWidth) return modifier

        val color = ColorParser.parse(value) ?: return modifier
        return modifier.border(1.dp, color)
    }
}

/**
 * Applicator for borderRadius / cornerRadius.
 */
class BorderRadiusApplicator : ApplicatorHandler {
    override val name: String = "borderRadius"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier =
        when (value) {
            is Number -> modifier.clip(RoundedCornerShape(value.toFloat().dp))
            is String -> {
                // Handle CSS unit strings like "9999px", "0.5rem", "16dp"
                val dp = parseCssUnit(value) ?: return modifier
                modifier.clip(RoundedCornerShape(dp))
            }
            is Map<*, *> -> {
                val topStart = parseCornerValue(value["topStart"] ?: value["topLeft"])
                val topEnd = parseCornerValue(value["topEnd"] ?: value["topRight"])
                val bottomEnd = parseCornerValue(value["bottomEnd"] ?: value["bottomRight"])
                val bottomStart = parseCornerValue(value["bottomStart"] ?: value["bottomLeft"])
                modifier.clip(RoundedCornerShape(topStart, topEnd, bottomEnd, bottomStart))
            }
            else -> modifier
        }

    private fun parseCornerValue(value: Any?): Dp = when (value) {
        is Number -> value.toFloat().dp
        is String -> parseCssUnit(value) ?: 0.dp
        else -> 0.dp
    }
}

/**
 * Alias for borderRadius.
 */
class CornerRadiusApplicator : ApplicatorHandler {
    override val name: String = "cornerRadius"

    private val delegate = BorderRadiusApplicator()

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier = delegate.apply(modifier, value, context)
}

/**
 * Applicator for borderStyle.
 * Supports: solid, dashed, dotted, double, none
 * Defers to BorderWidthApplicator when borderWidth is also set on the element.
 */
class BorderStyleApplicator : ApplicatorHandler {
    override val name: String = "borderStyle"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier {
        // If borderWidth is set, it will handle the complete border with this style
        val hasBorderWidth = context.element.props.keys.any { it.startsWith("borderWidth") }
        if (hasBorderWidth) return modifier

        // borderStyle alone without borderWidth is a no-op
        return modifier
    }
}
