package space.hypen.renderer.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import space.hypen.renderer.applicators.TextApplicatorRegistry
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Text components.
 *
 * Text content is passed as an argument: Text("Hello") or Text(text: "Hello")
 * All styling is done via applicators: Text("Hello").fontSize(18).color(blue)
 */
class TextComponent : ComponentHandler {
    override val typeName: String = "text"

    // Shared registry instance for all text components
    private val textApplicatorRegistry = TextApplicatorRegistry.withDefaults()

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Text content comes from prop "0", "text", or textContent (these are arguments, not styling)
        var text =
            element.getStringProp("0")
                ?: element.getStringProp("text")
                ?: element.textContent
                ?: ""

        // Apply all text styling via applicators, recomputed only when
        // this element's props change
        val textStyle = remember(element, element.propsRevision) {
            textApplicatorRegistry.applyAll(element.props)
        }

        // Apply text transform if set
        text = textStyle.applyTransform(text)

        // Build Compose TextStyle for fontFeatureSettings and fontFamily
        val composeTextStyle = androidx.compose.ui.text.TextStyle(
            fontFeatureSettings = textStyle.fontFeatureSettings,
            fontFamily = textStyle.fontFamily,
        )

        // For textAlign to work, Text needs to fill available width
        // when alignment is not Start (default left alignment)
        val textModifier = if (textStyle.textAlign != null && textStyle.textAlign != TextAlign.Start) {
            modifier.fillMaxWidth()
        } else {
            modifier
        }

        // Use LocalContentColor if no explicit color is set (for color inheritance from parent)
        val textColor = if (textStyle.color != Color.Unspecified) {
            textStyle.color
        } else {
            LocalContentColor.current
        }

        Text(
            text = text,
            modifier = textModifier,
            fontSize = textStyle.fontSize,
            fontWeight = textStyle.fontWeight,
            fontStyle = textStyle.fontStyle,
            color = textColor,
            letterSpacing = textStyle.letterSpacing,
            lineHeight = textStyle.lineHeight,
            textAlign = textStyle.textAlign,
            textDecoration = textStyle.textDecoration,
            maxLines = textStyle.maxLines,
            overflow = textStyle.overflow,
            style = composeTextStyle,
        )
    }
}
