package space.hypen.renderer.components

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import space.hypen.renderer.model.HypenElement

internal fun stackContentColor(element: HypenElement): Color? = hypenContentColor(element)

/**
 * Handler for Stack component - overlays children on top of each other.
 * Similar to Box but semantically represents stacking/layering.
 * Default behavior: wrap content (like Web CSS Grid).
 * Content alignment: top-leading by default, configurable via
 * horizontalAlignment/verticalAlignment, alignment, or justifyContent/alignItems
 * (resolved by [hypenContentAlignment], shared with every other Box-shaped container).
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
        // Same resolution as Box/Container/Center/Button (and Swift, canvas):
        // `justifyContent` is the horizontal axis, `alignItems` the vertical.
        // Stack used to read them the other way round, so `.tw("justify-center")`
        // centred vertically here and horizontally everywhere else.
        val contentAlignment = hypenContentAlignment(element)
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
}
