package space.hypen.renderer.components

import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Divider components.
 */
class DividerComponent : ComponentHandler {
    override val typeName: String = "divider"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        HorizontalDivider(modifier = modifier)
    }
}
