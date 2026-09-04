package space.hypen.renderer.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import space.hypen.renderer.model.HypenElement

/**
 * Composition local for ColumnScope modifier extension.
 * When in a Column context, children can use this to apply weight().
 */
val LocalColumnScope = compositionLocalOf<ColumnScope?> { null }

/**
 * Composition local to indicate parent Column allows horizontal expansion.
 * When true, children with fillMaxWidth can expand horizontally.
 * This is set by Column when a width-setting applicator establishes a
 * horizontal extent (fillMaxWidth, fillMaxSize, or explicit non-wrap width).
 */
val LocalParentAllowsHorizontalExpansion = compositionLocalOf { false }

/**
 * Handler for Column (vertical stack) components.
 *
 * Column has no required arguments. All layout options are via applicators:
 * - .verticalAlignment(center) - how children are arranged vertically (main axis)
 * - .horizontalAlignment(start) - how children are aligned horizontally (cross axis)
 * - .gap(16) - spacing between children
 * - .scrollable(true)
 */
class ColumnComponent : ComponentHandler {
    override val typeName: String = "column"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        // All layout options below are via applicators only (using .0 suffix pattern)

        // Gap/spacing between children - applicator: .gap(16)
        val gap = element.getFloatProp("gap.0") ?: element.getFloatProp("rowGap.0")

        // Vertical arrangement (main axis) - applicator: .verticalAlignment(center)
        // Also accepts CSS justify-content from .tw() classes
        val verticalStr = element.getStringProp("verticalAlignment.0")
            ?: element.getStringProp("justifyContent.0")

        // Parse vertical arrangement string
        fun parseVerticalArrangement(str: String?): Arrangement.Vertical? = when (str?.lowercase()) {
            "top", "start", "flex-start" -> Arrangement.Top
            "bottom", "end", "flex-end" -> Arrangement.Bottom
            "center" -> Arrangement.Center
            "spacebetween", "space-between" -> Arrangement.SpaceBetween
            "spacearound", "space-around" -> Arrangement.SpaceAround
            "spaceevenly", "space-evenly" -> Arrangement.SpaceEvenly
            else -> null
        }

        val parsedArrangement = parseVerticalArrangement(verticalStr)

        // Combine gap with arrangement - gap adds spacing, arrangement controls alignment
        val verticalArrangement = when {
            gap != null && gap > 0 && parsedArrangement != null -> {
                // Both gap and arrangement specified - use spacedBy with alignment
                when (parsedArrangement) {
                    Arrangement.Center -> Arrangement.spacedBy(gap.dp, Alignment.CenterVertically)
                    Arrangement.Bottom -> Arrangement.spacedBy(gap.dp, Alignment.Bottom)
                    Arrangement.Top -> Arrangement.spacedBy(gap.dp, Alignment.Top)
                    // For space-* arrangements, gap doesn't make sense - use the arrangement
                    else -> parsedArrangement
                }
            }
            gap != null && gap > 0 -> {
                // Only gap specified - use spacedBy with default Top alignment
                Arrangement.spacedBy(gap.dp)
            }
            else -> {
                // No gap - use parsed arrangement or default to Top
                parsedArrangement ?: Arrangement.Top
            }
        }

        // Horizontal alignment (cross axis) - applicator: .horizontalAlignment(start)
        // Also accepts CSS align-items from .tw() classes
        val horizontalStr = element.getStringProp("horizontalAlignment.0")
            ?: element.getStringProp("alignItems.0")

        // Check if stretch mode is requested
        val isStretch = horizontalStr?.lowercase() == "stretch"

        val horizontalAlignment =
            when (horizontalStr?.lowercase()) {
                "start", "left", "leading", "flex-start" -> Alignment.Start
                "end", "right", "trailing", "flex-end" -> Alignment.End
                "center" -> Alignment.CenterHorizontally
                "stretch" -> Alignment.Start // Stretch uses Start alignment + fillMaxWidth on children
                else -> Alignment.Start
            }

        // Scrollable - applicator: .scrollable(true) or .scrollable("vertical")/"both".
        // Accept bool true or the string values web uses so Hypen source authored once
        // (e.g. `.scrollable("vertical")`) works on Android too. "horizontal" on a Column
        // is a no-op — a Column scrolls vertically by nature.
        val scrollable = element.getBoolProp("scrollable.0")
            ?: element.getStringProp("scrollable.0")?.lowercase()?.let { it == "vertical" || it == "both" || it == "true" }
            ?: false

        // For arrangement (verticalAlignment) to have visible effect,
        // the Column needs to fill available height unless scrollable
        val needsFillHeight = parsedArrangement != null && parsedArrangement != Arrangement.Top && !scrollable

        val finalModifier = modifier
            .let { if (needsFillHeight) it.fillMaxHeight() else it }
            .let { if (scrollable) it.verticalScroll(rememberScrollState()) else it }
            // For stretch, use IntrinsicSize.Min so children know the width to stretch to
            .let { if (isStretch) it.width(IntrinsicSize.Min) else it }

        // Content colour propagated to children via LocalContentColor
        val contentColor = hypenContentColor(element)

        // Preserve a finite-width capability inherited from the parent. This
        // lets a nested wrap-content Column grow around an explicit
        // fillMaxWidth child; Compose still makes fillMaxWidth a no-op when
        // the actual incoming constraint is unbounded (for example in a Row).
        val inheritedHorizontalExpansion = LocalParentAllowsHorizontalExpansion.current
        val allowsHorizontalExpansion =
            columnAllowsHorizontalExpansion(element, inheritedHorizontalExpansion)

        Column(
            modifier = finalModifier,
            verticalArrangement = verticalArrangement,
            horizontalAlignment = horizontalAlignment,
        ) {
            // Add content color if specified
            if (contentColor != null) {
                CompositionLocalProvider(
                    LocalColumnScope provides this,
                    LocalStretchCrossAxis provides isStretch,
                    LocalParentAllowsHorizontalExpansion provides allowsHorizontalExpansion,
                    LocalContentColor provides contentColor
                ) {
                    renderChildren()
                }
            } else {
                CompositionLocalProvider(
                    LocalColumnScope provides this,
                    LocalStretchCrossAxis provides isStretch,
                    LocalParentAllowsHorizontalExpansion provides allowsHorizontalExpansion
                ) {
                    renderChildren()
                }
            }
        }
    }
}
