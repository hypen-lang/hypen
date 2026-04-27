package space.hypen.renderer.components

import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Spinner/Loading component.
 */
class SpinnerComponent : ComponentHandler {
    override val typeName: String = "spinner"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Size can be "small", "medium", "large" or a number
        val sizeValue = element.getStringProp("size") ?: element.getStringProp("0")
        val size = when (sizeValue?.lowercase()) {
            "small" -> 24.dp
            "medium" -> 40.dp
            "large" -> 60.dp
            else -> {
                element.getFloatProp("size")?.dp
                    ?: element.getFloatProp("0")?.dp
                    ?: 40.dp
            }
        }

        // Color via prop or applicator - default to a visible blue if not specified
        val colorStr = element.getStringProp("color")
            ?: element.getStringProp("color.0")
        val color = colorStr?.let { ColorParser.parse(it) }
            ?: Color(0xFF3B82F6) // Default blue color for visibility

        // Stroke width
        val strokeWidth = element.getFloatProp("strokeWidth")?.dp ?: 4.dp

        CircularProgressIndicator(
            modifier = modifier.size(size),
            color = color,
            strokeWidth = strokeWidth,
        )
    }
}
