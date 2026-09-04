package space.hypen.renderer.components

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.applicators.BorderCorners
import space.hypen.renderer.applicators.Edges
import space.hypen.renderer.applicators.collectPositional
import space.hypen.renderer.applicators.edgesFromPositional
import space.hypen.renderer.applicators.parseBorderCorners
import space.hypen.renderer.applicators.parseDp
import space.hypen.renderer.applicators.resolveCompoundBorderCorners
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Card component - elevated container with default styling.
 */
class CardComponent : ComponentHandler {
    override val typeName: String = "card"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val style = resolveCardStyle(element)

        // Background color via applicator, default to white for cross-platform consistency
        val cardColors = CardDefaults.cardColors(containerColor = style.backgroundColor)

        Card(
            modifier = modifier,
            shape = style.corners.shape,
            elevation = CardDefaults.cardElevation(defaultElevation = style.componentElevation),
            colors = cardColors,
        ) {
            // Default padding for card content
            androidx.compose.foundation.layout.Box(
                modifier = Modifier.padding(
                    start = style.padding.start,
                    top = style.padding.top,
                    end = style.padding.end,
                    bottom = style.padding.bottom,
                ),
            ) {
                ProvideHypenContentColor(element, renderChildren)
            }
        }
    }
}

internal data class CardStyle(
    val padding: Edges,
    val corners: BorderCorners,
    val backgroundColor: Color,
    val componentElevation: androidx.compose.ui.unit.Dp,
)

private fun propValue(props: Map<String, Any?>, name: String): Pair<Boolean, Any?> {
    props["$name.0"]?.let { return true to it }
    props[name]?.let { return true to it }
    val entries = props.entries.filter { it.key.startsWith("$name.") }
    return if (entries.isEmpty()) false to null
    else true to entries.associate { it.key.removePrefix("$name.") to it.value }
}

internal fun resolveCardStyle(element: HypenElement): CardStyle {
    val props = element.props
    val (_, paddingValue) = propValue(props, "padding")
    var padding = when (paddingValue) {
        is Number, is String -> parseDp(paddingValue)?.let { Edges(it, it, it, it) }
        is Map<*, *> -> {
            val positional = collectPositional(paddingValue)
            if (positional.isNotEmpty()) edgesFromPositional(positional) else Edges(
                start = parseDp(paddingValue["start"] ?: paddingValue["leading"] ?: paddingValue["left"] ?: paddingValue["horizontal"]) ?: 0.dp,
                top = parseDp(paddingValue["top"] ?: paddingValue["vertical"]) ?: 0.dp,
                end = parseDp(paddingValue["end"] ?: paddingValue["trailing"] ?: paddingValue["right"] ?: paddingValue["horizontal"]) ?: 0.dp,
                bottom = parseDp(paddingValue["bottom"] ?: paddingValue["vertical"]) ?: 0.dp,
            )
        }
        else -> null
    } ?: Edges(16.dp, 16.dp, 16.dp, 16.dp)

    fun edge(name: String): androidx.compose.ui.unit.Dp? = propValue(props, name).second?.let(::parseDp)
    edge("paddingHorizontal")?.let { padding = padding.copy(start = it, end = it) }
    edge("paddingVertical")?.let { padding = padding.copy(top = it, bottom = it) }
    edge("paddingLeft")?.let { padding = padding.copy(start = it) }
    edge("paddingRight")?.let { padding = padding.copy(end = it) }
    edge("paddingTop")?.let { padding = padding.copy(top = it) }
    edge("paddingBottom")?.let { padding = padding.copy(bottom = it) }

    val (_, borderValue) = propValue(props, "border")
    val border = borderValue as? Map<*, *>
    val (hasBorderRadius, borderRadius) = propValue(props, "borderRadius")
    val (hasCornerRadius, cornerRadius) = propValue(props, "cornerRadius")
    val corners = when {
        border != null && (border.containsKey("radius") || border.keys.any { it.toString().startsWith("radius.") }) ->
            resolveCompoundBorderCorners(border, props)
        hasBorderRadius -> parseBorderCorners(borderRadius)
        hasCornerRadius -> parseBorderCorners(cornerRadius)
        else -> BorderCorners.uniform(8.dp)
    }

    val (_, backgroundValue) = propValue(props, "backgroundColor")
    val backgroundColor = ColorParser.parse(backgroundValue) ?: Color.White
    val hasAuthorShadow = props.keys.any {
        val base = it.substringBefore('.').lowercase()
        base == "shadow" || base == "boxshadow" || base == "elevation"
    }

    return CardStyle(
        padding = padding,
        corners = corners,
        backgroundColor = backgroundColor,
        // Generic shadow/elevation applicators already own explicit shadows.
        // Only inject the Card's 2dp default when the author supplied none.
        componentElevation = if (hasAuthorShadow) 0.dp else 2.dp,
    )
}
