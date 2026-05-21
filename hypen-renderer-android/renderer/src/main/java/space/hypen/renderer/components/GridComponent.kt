package space.hypen.renderer.components

import android.util.Log
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.render.LocalComposeRenderer

/**
 * Handler for Grid component - displays children in a grid layout.
 * Uses LazyVerticalGrid for efficient rendering.
 *
 * Supports unified API:
 * - gridColumns: number of columns (or "1fr 2fr" CSS-like string on web)
 * - gridRows: number of rows
 * - gap: spacing between all items
 * - rowGap: vertical spacing
 * - columnGap: horizontal spacing
 */
class GridComponent : ComponentHandler {
    override val typeName: String = "grid"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val renderer = LocalComposeRenderer.current

        if (renderer == null) {
            Log.w(TAG, "No renderer available for Grid component, falling back to regular render")
            Box(modifier = modifier) {
                renderChildren()
            }
            return
        }

        // Get children from renderer
        val children = renderer.getChildren(element.id)

        val props = element.props

        // Get column count - supports both "columns" (legacy) and "gridColumns" (unified API)
        val columns = (props["gridColumns"] ?: props["gridColumns.0"] ?: props["columns"])?.let { col ->
            when (col) {
                is Number -> col.toInt()
                is String -> col.toIntOrNull() ?: 2
                else -> 2
            }
        } ?: 2

        // Get gap from props (unified API)
        val gap = (props["gap"] ?: props["gap.0"])?.let { g ->
            when (g) {
                is Number -> g.toFloat().dp
                else -> 0.dp
            }
        } ?: 0.dp

        // Get row gap and column gap separately if specified
        val rowGap = (props["rowGap"] ?: props["rowGap.0"])?.let { rg ->
            when (rg) {
                is Number -> rg.toFloat().dp
                else -> gap
            }
        } ?: gap

        val columnGap = (props["columnGap"] ?: props["columnGap.0"])?.let { cg ->
            when (cg) {
                is Number -> cg.toFloat().dp
                else -> gap
            }
        } ?: gap

        // A Grid declared with `.scrollable(true)` owns its own scrolling
        // viewport, so `LazyVerticalGrid` is safe (and desirable — it
        // windows rows for free).
        //
        // A Grid WITHOUT `.scrollable(true)` is expected to lay out at its
        // natural content height and scroll with some ancestor — e.g. the
        // Profile screen wraps the posts grid in `Column.scrollable(true)`.
        // In that situation `LazyVerticalGrid` crashes at measure time
        // because it requires a bounded max height, but a vertical-scroll
        // parent hands down `Infinity`. Fall back to a plain Column of
        // Rows so non-scrollable grids compose inside any parent.
        val scrollable = element.getBoolProp("scrollable.0")
            ?: element.getStringProp("scrollable.0")?.lowercase()?.let { it == "vertical" || it == "both" || it == "true" }
            ?: false

        if (!scrollable) {
            Column(
                modifier = modifier,
                verticalArrangement = Arrangement.spacedBy(rowGap),
            ) {
                children.chunked(columns).forEach { rowChildren ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(columnGap),
                    ) {
                        rowChildren.forEach { child ->
                            key(child.id) {
                                Box(
                                    modifier = Modifier.weight(1f),
                                ) {
                                    GridItemRenderer(
                                        element = child,
                                        renderer = renderer,
                                    )
                                }
                            }
                        }
                        // Pad the final row so partial rows align with a
                        // fully-populated row instead of stretching the
                        // last cell across the remaining columns.
                        repeat(columns - rowChildren.size) {
                            Spacer(modifier = Modifier.weight(1f))
                        }
                    }
                }
            }
            return
        }

        LazyVerticalGrid(
            columns = GridCells.Fixed(columns),
            modifier = modifier,
            horizontalArrangement = Arrangement.spacedBy(columnGap),
            verticalArrangement = Arrangement.spacedBy(rowGap),
        ) {
            items(
                items = children,
                key = { child -> child.id }
            ) { child ->
                key(child.id) {
                    GridItemRenderer(
                        element = child,
                        renderer = renderer,
                    )
                }
            }
        }
    }

    companion object {
        private const val TAG = "GridComponent"
    }
}

/**
 * Renders a single grid item element with its modifiers and applicators.
 */
@Composable
private fun GridItemRenderer(
    element: HypenElement,
    renderer: space.hypen.renderer.render.ComposeRenderer,
) {
    // Check visibility
    val visible = element.getBoolProp("visible.0")
        ?: element.getBoolProp("visible")
        ?: true
    if (!visible) return

    val componentRegistry = renderer.getComponentRegistry()
    val applicatorRegistry = renderer.getApplicatorRegistry()

    val handler = componentRegistry.getHandler(element.elementType)
    if (handler == null) {
        Box {
            RenderGridItemChildren(element, renderer)
        }
        return
    }

    // Build modifier from applicators
    val context = renderer.createApplicatorContext(element)
    val modifier = applicatorRegistry.applyAll(Modifier, element, context)

    // Render the component
    handler.Render(
        element = element,
        modifier = modifier,
        renderChildren = {
            RenderGridItemChildren(element, renderer)
        },
    )
}

/**
 * Renders children of a grid item element.
 */
@Composable
private fun RenderGridItemChildren(
    element: HypenElement,
    renderer: space.hypen.renderer.render.ComposeRenderer,
) {
    val children = renderer.getChildren(element.id)
    for (child in children) {
        key(child.id) {
            GridItemRenderer(element = child, renderer = renderer)
        }
    }
}
