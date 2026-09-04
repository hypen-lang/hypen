package space.hypen.renderer.components

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.applicators.AlignmentApplicator
import space.hypen.renderer.model.HypenElement

internal fun stackContentColor(element: HypenElement): Color? {
    val value = element.getStringProp("color.0") ?: element.getStringProp("color")
    return value?.let(ColorParser::parse)
}

/**
 * Handler for Stack component - overlays children on top of each other.
 * Similar to Box but semantically represents stacking/layering.
 * Default behavior: wrap content (like Web CSS Grid).
 * Content alignment: top-leading by default, configurable via horizontalAlignment/verticalAlignment.
 * Use .fillMaxWidth() applicator to stretch.
 */
class StackComponent : ComponentHandler {
    override val typeName: String = "stack"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Parse alignment from applicators
        val horizontalStr = element.getStringProp("horizontalAlignment.0")
            ?: element.getStringProp("alignItems.0")
        val verticalStr = element.getStringProp("verticalAlignment.0")
            ?: element.getStringProp("justifyContent.0")
        val contentAlignment = element.getStringProp("alignment.0")
            ?.let(AlignmentApplicator::parseAlignment)
            ?: parseAlignment(horizontalStr, verticalStr)
        val contentColor = stackContentColor(element)

        // Stack wraps content by default (like Web)
        // Use .fillMaxWidth() applicator to stretch if needed
        Box(
            modifier = modifier,
            contentAlignment = contentAlignment
        ) {
            if (contentColor != null) {
                CompositionLocalProvider(LocalContentColor provides contentColor) {
                    renderChildren()
                }
            } else {
                renderChildren()
            }
        }
    }

    private fun parseAlignment(horizontal: String?, vertical: String?): Alignment {
        val h = when (horizontal?.lowercase()) {
            "start", "left", "leading", "flex-start" -> Alignment.Start
            "end", "right", "trailing", "flex-end" -> Alignment.End
            "center" -> Alignment.CenterHorizontally
            else -> Alignment.Start // Default start for Stack
        }
        val v = when (vertical?.lowercase()) {
            "top", "start", "flex-start" -> Alignment.Top
            "bottom", "end", "flex-end" -> Alignment.Bottom
            "center" -> Alignment.CenterVertically
            else -> Alignment.Top // Default top for Stack
        }
        return when {
            h == Alignment.Start && v == Alignment.Top -> Alignment.TopStart
            h == Alignment.CenterHorizontally && v == Alignment.Top -> Alignment.TopCenter
            h == Alignment.End && v == Alignment.Top -> Alignment.TopEnd
            h == Alignment.Start && v == Alignment.CenterVertically -> Alignment.CenterStart
            h == Alignment.CenterHorizontally && v == Alignment.CenterVertically -> Alignment.Center
            h == Alignment.End && v == Alignment.CenterVertically -> Alignment.CenterEnd
            h == Alignment.Start && v == Alignment.Bottom -> Alignment.BottomStart
            h == Alignment.CenterHorizontally && v == Alignment.Bottom -> Alignment.BottomCenter
            h == Alignment.End && v == Alignment.Bottom -> Alignment.BottomEnd
            else -> Alignment.TopStart
        }
    }
}
