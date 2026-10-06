package space.hypen.renderer.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
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

        val hasAuthoredHeight = element.props.keys.any { key ->
            key.substringBefore('.').equals("height", ignoreCase = true)
                || key.substringBefore('.').equals("size", ignoreCase = true)
        }
        val progressModifier = modifier
            .fillMaxWidth()
            .let { if (hasAuthoredHeight) it else it.height(4.dp) }

        if (progress != null) {
            // Material 3's indicator intentionally inserts a gap and stop dot.
            // Hypen's cross-platform ProgressBar contract is a continuous fill.
            Box(
                modifier = progressModifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(trackColor),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(progress)
                        .fillMaxHeight()
                        .background(color),
                )
            }
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
