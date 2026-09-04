package space.hypen.renderer.applicators

import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal data class BorderCorners(
    val topStart: Dp,
    val topEnd: Dp,
    val bottomEnd: Dp,
    val bottomStart: Dp,
) {
    val shape: RoundedCornerShape
        get() = RoundedCornerShape(topStart, topEnd, bottomEnd, bottomStart)

    companion object {
        val Square = BorderCorners(0.dp, 0.dp, 0.dp, 0.dp)

        fun uniform(radius: Dp) = BorderCorners(radius, radius, radius, radius)
    }
}

private fun parseCornerValue(value: Any?): Dp = when (value) {
    is Number -> value.toFloat().dp
    is String -> parseCssUnit(value) ?: 0.dp
    else -> 0.dp
}

internal fun parseBorderCorners(value: Any?): BorderCorners = when (value) {
    is Number -> BorderCorners.uniform(value.toFloat().dp)
    is String -> BorderCorners.uniform(parseCssUnit(value) ?: 0.dp)
    is Map<*, *> -> BorderCorners(
        topStart = parseCornerValue(value["topStart"] ?: value["topLeft"]),
        topEnd = parseCornerValue(value["topEnd"] ?: value["topRight"]),
        bottomEnd = parseCornerValue(value["bottomEnd"] ?: value["bottomRight"]),
        bottomStart = parseCornerValue(value["bottomStart"] ?: value["bottomLeft"]),
    )
    else -> BorderCorners.Square
}

/**
 * Reconstruct an applicator value from its wire representation. A scalar can
 * arrive as `name.0`, while a corner map is flattened to `name.topStart`, etc.
 */
private fun siblingApplicatorValue(props: Map<String, Any?>, name: String): Pair<Boolean, Any?> {
    val positionalName = "$name.0"
    if (props.containsKey(positionalName)) return true to props[positionalName]
    if (props.containsKey(name)) return true to props[name]

    val prefix = "$name."
    val entries = props.entries.filter { it.key.startsWith(prefix) }
    if (entries.isEmpty()) return false to null
    return true to entries.associate { it.key.removePrefix(prefix) to it.value }
}

/**
 * The compound border owns its radius when one is explicitly present. If it
 * does not, the canonical `borderRadius` sibling wins over its
 * `cornerRadius` alias, independent of declaration order.
 */
internal fun resolveCompoundBorderCorners(
    compoundBorder: Map<*, *>,
    props: Map<String, Any?>,
): BorderCorners {
    if (compoundBorder.containsKey("radius")) {
        return parseBorderCorners(compoundBorder["radius"])
    }
    val flattenedRadius = compoundBorder.entries
        .filter { (key, _) -> (key as? String)?.startsWith("radius.") == true }
        .associate { (key, value) -> (key as String).removePrefix("radius.") to value }
    if (flattenedRadius.isNotEmpty()) return parseBorderCorners(flattenedRadius)

    val (hasBorderRadius, borderRadius) = siblingApplicatorValue(props, "borderRadius")
    if (hasBorderRadius) return parseBorderCorners(borderRadius)

    val (hasCornerRadius, cornerRadius) = siblingApplicatorValue(props, "cornerRadius")
    if (hasCornerRadius) return parseBorderCorners(cornerRadius)

    return BorderCorners.Square
}

private fun explicitCompoundBorderCorners(props: Map<String, Any?>): BorderCorners? {
    val (hasBorder, borderValue) = siblingApplicatorValue(props, "border")
    if (!hasBorder) return null
    val border = borderValue as? Map<*, *> ?: return null

    if (border.containsKey("radius")) return parseBorderCorners(border["radius"])
    val flattenedRadius = border.entries
        .filter { (key, _) -> (key as? String)?.startsWith("radius.") == true }
        .associate { (key, value) -> (key as String).removePrefix("radius.") to value }
    return flattenedRadius.takeIf { it.isNotEmpty() }?.let(::parseBorderCorners)
}

internal fun resolveClipBorderCorners(
    radiusValue: Any?,
    props: Map<String, Any?>,
): BorderCorners = explicitCompoundBorderCorners(props) ?: parseBorderCorners(radiusValue)

private fun BorderCorners.roundRect(
    size: Size,
    inset: Float,
    layoutDirection: LayoutDirection,
    toPx: (Dp) -> Float,
): RoundRect {
    fun radius(value: Dp) = CornerRadius(maxOf(0f, toPx(value) - inset))
    val topLeft = if (layoutDirection == LayoutDirection.Ltr) topStart else topEnd
    val topRight = if (layoutDirection == LayoutDirection.Ltr) topEnd else topStart
    val bottomRight = if (layoutDirection == LayoutDirection.Ltr) bottomEnd else bottomStart
    val bottomLeft = if (layoutDirection == LayoutDirection.Ltr) bottomStart else bottomEnd

    return RoundRect(
        left = inset,
        top = inset,
        right = maxOf(inset, size.width - inset),
        bottom = maxOf(inset, size.height - inset),
        topLeftCornerRadius = radius(topLeft),
        topRightCornerRadius = radius(topRight),
        bottomRightCornerRadius = radius(bottomRight),
        bottomLeftCornerRadius = radius(bottomLeft),
    )
}

/**
 * Extension to draw a styled border (solid, dashed, dotted, double)
 */
fun Modifier.styledBorder(
    width: Dp,
    color: Color,
    style: String = "solid",
    cornerRadius: Dp = 0.dp
): Modifier = styledBorder(width, color, style, BorderCorners.uniform(cornerRadius))

internal fun Modifier.styledBorder(
    width: Dp,
    color: Color,
    style: String,
    corners: BorderCorners,
): Modifier = when (style.lowercase()) {
    "none" -> this
    "dashed" -> this.drawBehind {
        val strokeWidth = width.toPx()
        val dashLength = strokeWidth * 3
        val gapLength = strokeWidth * 2
        val path = Path().apply {
            addRoundRect(corners.roundRect(size, strokeWidth / 2, layoutDirection) { it.toPx() })
        }
        drawPath(
            path = path,
            color = color,
            style = Stroke(
                width = strokeWidth,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(dashLength, gapLength), 0f)
            )
        )
    }
    "dotted" -> this.drawBehind {
        val strokeWidth = width.toPx()
        val dotSpacing = strokeWidth * 2
        val path = Path().apply {
            addRoundRect(corners.roundRect(size, strokeWidth / 2, layoutDirection) { it.toPx() })
        }
        drawPath(
            path = path,
            color = color,
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
        val outerPath = Path().apply {
            addRoundRect(corners.roundRect(size, strokeWidth / 2, layoutDirection) { it.toPx() })
        }
        drawPath(
            path = outerPath,
            color = color,
            style = Stroke(width = strokeWidth)
        )
        // Inner border
        val innerInset = offset + strokeWidth / 2
        val innerPath = Path().apply {
            addRoundRect(corners.roundRect(size, innerInset, layoutDirection) { it.toPx() })
        }
        drawPath(
            path = innerPath,
            color = color,
            style = Stroke(width = strokeWidth)
        )
    }
    else -> this.border(width, color, corners.shape) // "solid" and default
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
            // Same non-positive guard as BorderWidthApplicator: `border(0.dp)`
            // still strokes a hairline ring in Compose.
            is Number -> if (value.toFloat() <= 0f) modifier else modifier.border(value.toFloat().dp, Color.Black)
            is Map<*, *> -> {
                val width = (value["width"] as? Number)?.toFloat()?.dp ?: 1.dp
                if (width.value <= 0f) {
                    modifier
                } else {
                    val color = ColorParser.parse(value["color"]) ?: Color.Black
                    val style = (value["style"] as? String) ?: "solid"
                    val corners = resolveCompoundBorderCorners(value, context.element.props)
                    modifier.styledBorder(width, color, style, corners)
                }
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

        // Use the same sibling-radius resolver as the compound border so the
        // border and the earlier clip always describe identical corners.
        val corners = resolveCompoundBorderCorners(emptyMap<Any?, Any?>(), context.element.props)

        return modifier.styledBorder(width, color, style, corners)
    }
}

/**
 * Applicator for borderColor.
 *
 * Only records the colour: the width applicators (`borderWidth` and the
 * per-side `borderTopWidth` … `borderLeftWidth`) read it back and draw the
 * border. A colour with no width draws nothing — the CSS semantics the DOM
 * renderer already has. (It used to paint a full 1dp box, which turned
 * Tailwind's `border-b border-gray-100` into a border on all four sides.)
 */
class BorderColorApplicator : ApplicatorHandler {
    override val name: String = "borderColor"

    override fun apply(
        modifier: Modifier,
        value: Any?,
        context: ApplicatorContext,
    ): Modifier = modifier
}

/** Which physical edge a per-side border width applicator paints. */
enum class BorderSide { TOP, RIGHT, BOTTOM, LEFT }

/**
 * Applicator for `borderTopWidth` / `borderRightWidth` / `borderBottomWidth` /
 * `borderLeftWidth` — what Tailwind's `border-t` / `border-b` / `border-x`
 * lower to. Paints a straight stripe along one physical edge (like CSS: a
 * per-side border ignores the corner radius) in `borderColor`, so a
 * `border-b border-gray-100` post card gets a bottom divider instead of a
 * full box. Widths of zero or less draw nothing (`border-b-0`).
 */
class BorderSideWidthApplicator(private val side: BorderSide) : ApplicatorHandler {
    override val name: String = when (side) {
        BorderSide.TOP -> "borderTopWidth"
        BorderSide.RIGHT -> "borderRightWidth"
        BorderSide.BOTTOM -> "borderBottomWidth"
        BorderSide.LEFT -> "borderLeftWidth"
    }

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
        if (width.value <= 0f) return modifier

        val style = (context.element.props["borderStyle.0"] as? String)
            ?: (context.element.props["borderStyle"] as? String)
            ?: "solid"
        if (style.equals("none", ignoreCase = true)) return modifier

        val colorValue = context.element.props["borderColor.0"] ?: context.element.props["borderColor"]
        val color = ColorParser.parse(colorValue) ?: Color.Gray

        // Draw AFTER the content: the element's background modifier sits later
        // in the chain (BORDER priority precedes BACKGROUND, like CSS), so a
        // `drawBehind` stripe would be painted over by the background.
        return modifier.drawWithContent {
            drawContent()
            val w = width.toPx()
            val (topLeft, rectSize) = when (side) {
                BorderSide.TOP -> Offset.Zero to Size(size.width, w)
                BorderSide.BOTTOM -> Offset(0f, size.height - w) to Size(size.width, w)
                BorderSide.LEFT -> Offset.Zero to Size(w, size.height)
                BorderSide.RIGHT -> Offset(size.width - w, 0f) to Size(w, size.height)
            }
            drawRect(color = color, topLeft = topLeft, size = rectSize)
        }
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
            is Number, is String, is Map<*, *> ->
                modifier.clip(resolveClipBorderCorners(value, context.element.props).shape)
            else -> modifier
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
    ): Modifier {
        // `cornerRadius` is an alias. If both spellings are present, applying
        // two Compose clips would intersect their shapes instead of letting
        // one declaration win, so the canonical spelling owns the clip.
        val (hasCanonicalRadius, _) = siblingApplicatorValue(context.element.props, "borderRadius")
        if (hasCanonicalRadius) return modifier
        return delegate.apply(modifier, value, context)
    }
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
