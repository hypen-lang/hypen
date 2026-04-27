package space.hypen.renderer.components

import android.util.Log
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Spacer components.
 *
 * Spacer automatically expands to fill available space in Row/Column layouts.
 * In Compose, this requires Modifier.weight(1f) when inside a Row or Column scope.
 *
 * Note: Weight is applied by accessing the RowScope/ColumnScope from CompositionLocals
 * provided by the parent Row/Column components.
 */
class SpacerComponent : ComponentHandler {
    override val typeName: String = "spacer"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // Get weight from props, default to 1f for automatic expansion
        val weight = element.getFloatProp("weight.0")
            ?: element.getFloatProp("weight")
            ?: element.getFloatProp("flex.0")
            ?: element.getFloatProp("flex")
            ?: 1f  // Default: Spacer expands to fill available space

        // Check if we're in a Row or Column scope
        // Note: If we're in a Row inside a Column, both will be non-null
        // We prioritize RowScope since that's the immediate parent for horizontal layouts
        val rowScope = LocalRowScope.current
        val columnScope = LocalColumnScope.current

        Log.d("SpacerComponent", "Rendering Spacer id=${element.id}: rowScope=${rowScope != null}, columnScope=${columnScope != null}, weight=$weight")

        if (rowScope != null && weight > 0) {
            // We're inside a Row - apply horizontal weight
            Log.d("SpacerComponent", "Applying weight $weight in RowScope")
            with(rowScope) {
                Spacer(modifier = modifier.weight(weight))
            }
        } else if (columnScope != null && weight > 0) {
            // We're inside a Column (but not a Row) - apply vertical weight
            Log.d("SpacerComponent", "Applying weight $weight in ColumnScope")
            with(columnScope) {
                Spacer(modifier = modifier.weight(weight))
            }
        } else {
            // No scope available, render plain spacer
            Log.d("SpacerComponent", "No scope available, using plain Spacer")
            Spacer(modifier = modifier)
        }
    }
}
