package space.hypen.renderer.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Divider components.
 */
class DividerComponent : ComponentHandler {
    override val typeName: String = "divider"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val style = resolveDividerStyle(element)

        // Horizontal is the cross-platform Divider contract. Appending
        // fillMaxWidth after the incoming modifier means margin/padding
        // insets consume the proposal instead of overflowing it.
        Box(
            modifier = modifier
                .fillMaxWidth()
                .height(style.thickness.dp)
                .background(style.color),
        )
    }
}

internal data class DividerStyle(
    val color: Color,
    val thickness: Float,
)

internal fun resolveDividerStyle(element: HypenElement): DividerStyle {
    val props = element.props
    val color = firstDividerProp(
        props,
        "color.0", "color", "backgroundColor.0", "backgroundColor",
    )?.let(ColorParser::parse) ?: Color(0xFFE0E0E0)
    val thickness = firstDividerProp(
        props,
        "height.0", "height", "thickness.0", "thickness",
    ).asDividerFloat() ?: 1f

    return DividerStyle(color = color, thickness = thickness.coerceAtLeast(0f))
}

private fun firstDividerProp(props: Map<String, Any?>, vararg names: String): Any? =
    names.firstNotNullOfOrNull { props[it] }

private fun Any?.asDividerFloat(): Float? = when (this) {
    is Number -> toFloat()
    is String -> trim().removeSuffix("px").toFloatOrNull()
    else -> null
}
