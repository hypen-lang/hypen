package space.hypen.renderer.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import space.hypen.renderer.model.HypenElement

/**
 * Handler for the App root component.
 *
 * A full-screen vertical container that fills all available space.
 * This is the default root component created by `hypen init`.
 */
class AppComponent : ComponentHandler {
    override val typeName: String = "app"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val gap = element.getFloatProp("gap.0") ?: 0f
        val spacing = if (gap > 0) Arrangement.spacedBy(gap.let { androidx.compose.ui.unit.Dp(it) }) else Arrangement.Top

        Column(
            modifier = modifier.fillMaxSize(),
            verticalArrangement = spacing,
            horizontalAlignment = Alignment.Start,
        ) {
            CompositionLocalProvider(
                LocalColumnScope provides this,
                LocalParentAllowsHorizontalExpansion provides true,
            ) {
                renderChildren()
            }
        }
    }
}
