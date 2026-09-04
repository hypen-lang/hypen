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
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.render.LocalComposeRenderer
import space.hypen.renderer.model.HypenElement
import kotlin.math.roundToInt

/**
 * Composition local for RowScope modifier extension.
 * When in a Row context, children can use this to apply weight().
 */
val LocalRowScope = compositionLocalOf<RowScope?> { null }

/** The id of a Row whose direct children are sized by [ManagedRowLayout]. */
val LocalManagedRowId = compositionLocalOf<String?> { null }

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

        val renderer = LocalComposeRenderer.current
        val managedChildren = renderer?.let { managedRowChildren(element, it) }.orEmpty()
        val itemSizing = managedChildren.map(RowItemSizing::from)
        val usesManagedLayout = !scrollable && itemSizing.any { it.isManaged }

        // For arrangement (horizontalAlignment) to have visible effect,
        // the Row needs to fill available width unless scrollable
        val needsFillWidth = parsedArrangement != null && parsedArrangement != Arrangement.Start && !scrollable

        val finalModifier = modifier
            .let { if (needsFillWidth) it.fillMaxWidth() else it }
            .let { if (scrollable) it.horizontalScroll(rememberScrollState()) else it }
            // For stretch, use IntrinsicSize.Min so children know the height to stretch to
            .let { if (isStretch) it.height(IntrinsicSize.Min) else it }

        if (usesManagedLayout) {
            CompositionLocalProvider(
                LocalManagedRowId provides element.id,
                LocalRowScope provides null,
                // A Row is the immediate sizing parent. Do not let an outer
                // ColumnScope capture Spacer/flex modifiers from these children.
                LocalColumnScope provides null,
                LocalStretchCrossAxis provides isStretch,
            ) {
                ManagedRowLayout(
                    modifier = finalModifier.fillMaxWidth(),
                    itemSizing = itemSizing,
                    gapPx = gap ?: 0f,
                    horizontalArrangement = horizontalArrangement,
                    verticalAlignment = verticalAlignment,
                    content = renderChildren,
                )
            }
        } else {
            Row(
                modifier = finalModifier,
                horizontalArrangement = horizontalArrangement,
                verticalAlignment = verticalAlignment,
            ) {
                CompositionLocalProvider(
                    LocalManagedRowId provides null,
                    LocalRowScope provides this,
                    LocalStretchCrossAxis provides isStretch,
                ) {
                    renderChildren()
                }
            }
        }
    }
}

@Composable
private fun ManagedRowLayout(
    modifier: Modifier,
    itemSizing: List<RowItemSizing>,
    gapPx: Float,
    horizontalArrangement: Arrangement.Horizontal,
    verticalAlignment: Alignment.Vertical,
    content: @Composable () -> Unit,
) {
    Layout(content = content, modifier = modifier) { measurables, constraints ->
        // A horizontal scroll parent deliberately supplies infinite width. In
        // that case percentages and flex have no finite containing block and
        // retain their natural widths, matching ordinary Compose Row behavior.
        val naturalWidths = measurables.map { measurable ->
            measurable.maxIntrinsicWidth(constraints.maxHeight).toFloat()
        }
        val gap = gapPx.dp.roundToPx()
        val bounded = constraints.hasBoundedWidth
        val availableWidth = if (bounded) {
            constraints.maxWidth
        } else {
            naturalWidths.sum().roundToInt() + gap * maxOf(0, measurables.size - 1)
        }
        val widths = if (bounded) {
            allocateRowWidths(
                availableWidth = availableWidth.toFloat(),
                gap = gap.toFloat(),
                naturalWidths = naturalWidths,
                items = itemSizing.take(measurables.size),
            ).map { it.roundToInt().coerceAtLeast(0) }
        } else {
            naturalWidths.map { it.roundToInt().coerceAtLeast(0) }
        }

        val placeables = measurables.mapIndexed { index, measurable ->
            val width = widths.getOrElse(index) { naturalWidths[index].roundToInt() }
            measurable.measure(
                Constraints(
                    minWidth = width,
                    maxWidth = width,
                    minHeight = 0,
                    maxHeight = constraints.maxHeight,
                ),
            )
        }
        val layoutWidth = availableWidth.coerceIn(constraints.minWidth, constraints.maxWidth)
        val layoutHeight = (placeables.maxOfOrNull { it.height } ?: 0)
            .coerceIn(constraints.minHeight, constraints.maxHeight)
        val positions = IntArray(placeables.size)
        with(horizontalArrangement) {
            arrange(
                totalSize = layoutWidth,
                sizes = IntArray(placeables.size) { placeables[it].width },
                layoutDirection = layoutDirection,
                outPositions = positions,
            )
        }

        layout(layoutWidth, layoutHeight) {
            placeables.forEachIndexed { index, placeable ->
                val y = verticalAlignment.align(placeable.height, layoutHeight)
                placeable.placeRelative(positions[index], y)
            }
        }
    }
}

private val transparentRowWrappers = setOf(
    "ForEach", "__ForEach", "Conditional", "__Conditional", "When", "__When", "If", "__If",
)

internal fun isManagedRowChild(
    element: HypenElement,
    managedRowId: String?,
    renderer: ComposeRenderer,
): Boolean {
    if (managedRowId == null) return false
    var parentId = element.parentId
    while (parentId != null) {
        if (parentId == managedRowId) return true
        val parent = renderer.getElement(parentId) ?: return false
        if (parent.elementType !in transparentRowWrappers) return false
        parentId = parent.parentId
    }
    return false
}

/** Matches the actual layout children produced by transparent control-flow wrappers. */
private fun managedRowChildren(element: HypenElement, renderer: ComposeRenderer): List<HypenElement> =
    renderer.getChildren(element.id).flatMap { child ->
        val visible = child.getBoolProp("visible.0") ?: child.getBoolProp("visible") ?: true
        when {
            !visible -> emptyList()
            child.elementType in transparentRowWrappers -> managedRowChildren(child, renderer)
            else -> listOf(child)
        }
    }
