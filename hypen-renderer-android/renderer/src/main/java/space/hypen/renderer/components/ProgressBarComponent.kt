package space.hypen.renderer.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.model.HypenElement

/**
 * Handler for ProgressBar component - linear progress indicator.
 */
class ProgressBarComponent : ComponentHandler {
    override val typeName: String = "progressbar"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Progress value (0-100 or 0-1)
        val rawValue = element.getFloatProp("value")
            ?: element.getFloatProp("0")

        // Normalize to 0-1 range
        val progress = when {
            rawValue == null -> null // Indeterminate
            rawValue > 1f -> rawValue / 100f // Assume 0-100 scale
            else -> rawValue
        }?.coerceIn(0f, 1f)

        // Color via prop or applicator
        val colorStr = element.getStringProp("color")
            ?: element.getStringProp("color.0")
        // Default to blue color (same as Spinner) when no color specified
        val defaultColor = Color(0xFF3B82F6)
        val color = colorStr?.let { ColorParser.parse(it) } ?: defaultColor

        // Track color - default to light gray
        val trackColorStr = element.getStringProp("trackColor")
        val defaultTrackColor = Color(0xFFE5E7EB)
        val trackColor = trackColorStr?.let { ColorParser.parse(it) } ?: defaultTrackColor

        val progressModifier = modifier.fillMaxWidth()

        if (progress != null) {
            // Determinate progress
            LinearProgressIndicator(
                progress = { progress },
                modifier = progressModifier,
                color = color,
                trackColor = trackColor,
            )
        } else {
            // Indeterminate progress
            LinearProgressIndicator(
                modifier = progressModifier,
                color = color,
                trackColor = trackColor,
            )
        }
    }
}
