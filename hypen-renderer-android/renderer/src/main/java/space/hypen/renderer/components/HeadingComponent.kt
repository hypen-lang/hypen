package space.hypen.renderer.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import space.hypen.renderer.applicators.TextApplicatorRegistry
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Heading component - styled text for headings (h1-h6).
 */
class HeadingComponent : ComponentHandler {
    override val typeName: String = "heading"

    private val textApplicatorRegistry = TextApplicatorRegistry.withDefaults()

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val text = element.getStringProp("0")
            ?: element.getStringProp("text")
            ?: element.textContent

        // Level determines default size (1-6, default 1)
        val level = element.getIntProp("level")
            ?: element.getIntProp("1")
            ?: 1

        val (defaultFontSize, defaultFontWeight) = when (level) {
            1 -> 32.sp to FontWeight.Bold
            2 -> 28.sp to FontWeight.Bold
            3 -> 24.sp to FontWeight.SemiBold
            4 -> 20.sp to FontWeight.SemiBold
            5 -> 18.sp to FontWeight.Medium
            6 -> 16.sp to FontWeight.Medium
            else -> 32.sp to FontWeight.Bold
        }

        // Apply text styling via applicators (allows overriding defaults)
        val textStyle = textApplicatorRegistry.applyAll(element.props)

        // If text is provided as prop, render it directly; otherwise render children
        // This supports both: Heading("text") and Heading { Text("text") }
        if (text != null && text.isNotEmpty()) {
            val styledText = textStyle.applyTransform(text)

            // Build Compose TextStyle for fontFeatureSettings and fontFamily
            val composeTextStyle = androidx.compose.ui.text.TextStyle(
                fontFeatureSettings = textStyle.fontFeatureSettings,
                fontFamily = textStyle.fontFamily,
            )

            // For textAlign to work, Text needs to fill available width
            val textModifier = if (textStyle.textAlign != null && textStyle.textAlign != TextAlign.Start) {
                modifier.fillMaxWidth()
            } else {
                modifier
            }

            Text(
                text = styledText,
                modifier = textModifier,
                fontSize = if (textStyle.fontSize != TextUnit.Unspecified) textStyle.fontSize else defaultFontSize,
                fontWeight = textStyle.fontWeight ?: defaultFontWeight,
                fontStyle = textStyle.fontStyle,
                color = if (textStyle.color != Color.Unspecified) textStyle.color else Color.Unspecified,
                letterSpacing = textStyle.letterSpacing,
                lineHeight = textStyle.lineHeight,
                textAlign = textStyle.textAlign,
                textDecoration = textStyle.textDecoration,
                maxLines = textStyle.maxLines,
                overflow = textStyle.overflow,
                style = composeTextStyle,
            )
        } else {
            // Render children - the Heading acts as a styled container
            // Children inherit heading-level styling via CompositionLocal or should handle their own styling
            renderChildren()
        }
    }
}
