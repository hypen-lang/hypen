package space.hypen.renderer.components

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import space.hypen.renderer.applicators.ColorParser
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
        // Elevation
        val elevation = element.getFloatProp("elevation")?.dp ?: 2.dp

        // Background color via applicator, default to white for cross-platform consistency
        val bgColorStr = element.getStringProp("backgroundColor.0")
        val backgroundColor = bgColorStr?.let { ColorParser.parse(it) } ?: Color.White

        val cardColors = CardDefaults.cardColors(containerColor = backgroundColor)

        Card(
            modifier = modifier,
            elevation = CardDefaults.cardElevation(defaultElevation = elevation),
            colors = cardColors,
        ) {
            // Default padding for card content
            androidx.compose.foundation.layout.Box(
                modifier = Modifier.padding(16.dp)
            ) {
                renderChildren()
            }
        }
    }
}
