package space.hypen.renderer.components

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import space.hypen.renderer.model.HypenElement

/**
 * Composition local for RowScope modifier extension.
 * When in a Row context, children can use this to apply weight().
 */
val LocalRowScope = compositionLocalOf<RowScope?> { null }

/**
 * Composition local to indicate children should stretch to fill cross-axis.
 * When true, children in a Row should fillMaxHeight, in a Column should fillMaxWidth.
 */
val LocalStretchCrossAxis = compositionLocalOf { false }

/**
 * Handler for Row (horizontal stack) components.
 *
 * Row has no required arguments. All layout options are via applicators:
 * - .horizontalAlignment(center) - how children are arranged horizontally (main axis)
 * - .verticalAlignment(center) - how children are aligned vertically (cross axis)
 * - .gap(16) - spacing between children
 * - .scrollable(true)
 */
class RowComponent : ComponentHandler {
    override val typeName: String = "row"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // All layout options below are via applicators only (using .0 suffix pattern)

        // Gap/spacing between children - applicator: .gap(16)
        val gap = element.getFloatProp("gap.0") ?: element.getFloatProp("columnGap.0")

        // Horizontal arrangement (main axis) - applicator: .horizontalAlignment(center)
        // Also accepts CSS justify-content from .tw() classes
        val horizontalStr = element.getStringProp("horizontalAlignment.0")
            ?: element.getStringProp("justifyContent.0")

        // Parse horizontal arrangement string
        fun parseHorizontalArrangement(str: String?): Arrangement.Horizontal? = when (str?.lowercase()) {
            "start", "left", "leading", "flex-start" -> Arrangement.Start
            "end", "right", "trailing", "flex-end" -> Arrangement.End
            "center" -> Arrangement.Center
            "spacebetween", "space-between" -> Arrangement.SpaceBetween
            "spacearound", "space-around" -> Arrangement.SpaceAround
            "spaceevenly", "space-evenly" -> Arrangement.SpaceEvenly
            else -> null
        }

        val parsedArrangement = parseHorizontalArrangement(horizontalStr)

        // Combine gap with arrangement - gap adds spacing, arrangement controls alignment
        val horizontalArrangement = when {
            gap != null && gap > 0 && parsedArrangement != null -> {
                // Both gap and arrangement specified - use spacedBy with alignment
                when (parsedArrangement) {
                    Arrangement.Center -> Arrangement.spacedBy(gap.dp, Alignment.CenterHorizontally)
                    Arrangement.End -> Arrangement.spacedBy(gap.dp, Alignment.End)
                    Arrangement.Start -> Arrangement.spacedBy(gap.dp, Alignment.Start)
                    // For space-* arrangements, gap doesn't make sense - use the arrangement
                    else -> parsedArrangement
                }
            }
            gap != null && gap > 0 -> {
                // Only gap specified - use spacedBy with default Start alignment
                Arrangement.spacedBy(gap.dp)
            }
            else -> {
                // No gap - use parsed arrangement or default to Start
                parsedArrangement ?: Arrangement.Start
            }
        }

        // Vertical alignment (cross axis) - applicator: .verticalAlignment(center)
        // Also accepts CSS align-items from .tw() classes
        val verticalStr = element.getStringProp("verticalAlignment.0")
            ?: element.getStringProp("alignItems.0")

        // Check if stretch mode is requested
        val isStretch = verticalStr?.lowercase() == "stretch"

        val verticalAlignment =
            when (verticalStr?.lowercase()) {
                "top", "start", "flex-start" -> Alignment.Top
                "bottom", "end", "flex-end" -> Alignment.Bottom
                "center" -> Alignment.CenterVertically
                "stretch" -> Alignment.Top // Stretch uses Top alignment + fillMaxHeight on children
                else -> Alignment.Top
            }

        // Scrollable - applicator: .scrollable(true) or .scrollable("horizontal")/"both".
        // Accept bool true or the string values web uses so Hypen source authored once
        // (e.g. `.scrollable("horizontal")`) works on Android too. "vertical" on a Row is
        // a no-op — a Row scrolls horizontally by nature.
        val scrollable = element.getBoolProp("scrollable.0")
            ?: element.getStringProp("scrollable.0")?.lowercase()?.let { it == "horizontal" || it == "both" || it == "true" }
            ?: false

        // For arrangement (horizontalAlignment) to have visible effect,
        // the Row needs to fill available width unless scrollable
        val needsFillWidth = parsedArrangement != null && parsedArrangement != Arrangement.Start && !scrollable

        val finalModifier = modifier
            .let { if (needsFillWidth) it.fillMaxWidth() else it }
            .let { if (scrollable) it.horizontalScroll(rememberScrollState()) else it }
            // For stretch, use IntrinsicSize.Min so children know the height to stretch to
            .let { if (isStretch) it.height(IntrinsicSize.Min) else it }

        Row(
            modifier = finalModifier,
            horizontalArrangement = horizontalArrangement,
            verticalAlignment = verticalAlignment,
        ) {
            CompositionLocalProvider(
                LocalRowScope provides this,
                LocalStretchCrossAxis provides isStretch
            ) {
                renderChildren()
            }
        }
    }
}
