package space.hypen.renderer.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Center components.
 *
 * Center expands to fill available space by default (matching iOS behavior).
 * This is because a Center that wraps to content can't meaningfully center anything.
 * The expansion is constrained by parent's layout rules.
 */
class CenterComponent : ComponentHandler {
    override val typeName: String = "center"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Center expands to fill available space by default
        // This matches iOS which has .frame(maxWidth: .infinity, maxHeight: .infinity)
        Box(
            modifier = modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            renderChildren()
        }
    }
}
