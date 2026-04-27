package space.hypen.renderer.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Badge component - small status indicator.
 */
class BadgeComponent : ComponentHandler {
    override val typeName: String = "badge"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val text = element.getStringProp("0")
            ?: element.getStringProp("text")
            ?: element.getStringProp("label")
            ?: ""

        // Variant/color scheme
        val variant = element.getStringProp("variant") ?: "default"

        // Custom colors via applicators
        val bgColorStr = element.getStringProp("backgroundColor.0")
        val textColorStr = element.getStringProp("color.0")

        val (backgroundColor, textColor) = when {
            bgColorStr != null -> {
                ColorParser.parse(bgColorStr) to (textColorStr?.let { ColorParser.parse(it) } ?: Color.White)
            }
            else -> when (variant.lowercase()) {
                "primary" -> Color(0xFF1976D2) to Color.White
                "secondary" -> Color(0xFF9C27B0) to Color.White
                "success" -> Color(0xFF4CAF50) to Color.White
                "warning" -> Color(0xFFFF9800) to Color.Black
                "error", "danger" -> Color(0xFFF44336) to Color.White
                "info" -> Color(0xFF2196F3) to Color.White
                else -> Color(0xFFE0E0E0) to Color.Black
            }
        }

        Box(
            modifier = modifier
                .clip(RoundedCornerShape(12.dp))
                .background(backgroundColor ?: Color(0xFFE0E0E0))
                .padding(horizontal = 8.dp, vertical = 4.dp)
        ) {
            // If text prop is provided, render it; otherwise render children
            if (text.isNotEmpty()) {
                Text(
                    text = text,
                    color = textColor ?: Color.Black,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                )
            } else {
                renderChildren()
            }
        }
    }
}
