package space.hypen.renderer.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import space.hypen.renderer.applicators.TextApplicatorRegistry
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Paragraph component - block of text with default paragraph styling.
 */
class ParagraphComponent : ComponentHandler {
    override val typeName: String = "paragraph"

    private val textApplicatorRegistry = TextApplicatorRegistry.withDefaults()

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        var text = element.getStringProp("0")
            ?: element.getStringProp("text")
            ?: element.textContent
            ?: ""

        // If no direct text, retain the Paragraph's own layout modifier around
        // its children. Returning the children bare discarded Row weight and
        // width allocation, so a Paragraph { Text(...) } inside a weighted Row
        // collapsed to the Text's intrinsic width (the drop-cap example).
        if (text.isEmpty()) {
            Box(modifier = modifier) {
                renderChildren()
            }
            return
        }

        // Apply text styling via applicators
        val textStyle = textApplicatorRegistry.applyAll(element.props)
        text = textStyle.applyTransform(text)

        // Default paragraph styling (16sp font, 24sp line height)
        val defaultFontSize = 16.sp
        val defaultLineHeight = 24.sp

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
            text = text,
            modifier = textModifier,
            fontSize = if (textStyle.fontSize != TextUnit.Unspecified) textStyle.fontSize else defaultFontSize,
            fontWeight = textStyle.fontWeight,
            fontStyle = textStyle.fontStyle,
            color = if (textStyle.color != Color.Unspecified) textStyle.color else Color.Unspecified,
            letterSpacing = textStyle.letterSpacing,
            lineHeight = if (textStyle.lineHeight != TextUnit.Unspecified) textStyle.lineHeight else defaultLineHeight,
            textAlign = textStyle.textAlign,
            textDecoration = textStyle.textDecoration,
            maxLines = textStyle.maxLines,
            overflow = textStyle.overflow,
            style = composeTextStyle,
        )
    }
}
