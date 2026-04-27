package space.hypen.renderer.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Container/Box components.
 * Default behavior: wrap to content (cross-platform consistency).
 * Use .fillMaxWidth(true) to stretch.
 * Content alignment: top-leading.
 */
class ContainerComponent : ComponentHandler {
    override val typeName: String = "container"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Wrap to content by default - use .fillMaxWidth(true) to stretch
        Box(
            modifier = modifier,
            contentAlignment = Alignment.TopStart
        ) {
            renderChildren()
        }
    }
}

/**
 * Handler for Box components (alias for Container).
 */
class BoxComponent : ComponentHandler {
    override val typeName: String = "box"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Wrap to content by default - use .fillMaxWidth(true) to stretch
        Box(
            modifier = modifier,
            contentAlignment = Alignment.TopStart
        ) {
            renderChildren()
        }
    }
}
