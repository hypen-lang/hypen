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
import androidx.compose.foundation.lazy.grid.GridItemSpan
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
            // Pack children into rows respecting per-child gridColumn spans.
            // A child whose span would overflow the current row's remaining
            // capacity wraps to the next row (CSS-grid auto-placement).
            val rows = mutableListOf<MutableList<Pair<HypenElement, Int>>>()
            var current = mutableListOf<Pair<HypenElement, Int>>()
            var used = 0
            for (child in children) {
                val span = gridColumnSpan(child).coerceIn(1, columns)
                if (used + span > columns) {
                    rows.add(current)
                    current = mutableListOf()
                    used = 0
                }
                current.add(child to span)
                used += span
                if (used == columns) {
                    rows.add(current)
                    current = mutableListOf()
                    used = 0
                }
            }
            if (current.isNotEmpty()) rows.add(current)

            Column(
                modifier = modifier,
                verticalArrangement = Arrangement.spacedBy(rowGap),
            ) {
                rows.forEach { rowChildren ->
                    val rowSpan = rowChildren.sumOf { it.second }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(columnGap),
                    ) {
                        rowChildren.forEach { (child, span) ->
                            key(child.id) {
                                Box(
                                    modifier = Modifier.weight(span.toFloat()),
                                ) {
                                    GridItemRenderer(
                                        element = child,
                                        renderer = renderer,
                                    )
                                }
                            }
                        }
                        // Pad partial rows so cells stay column-aligned with
                        // fully-populated rows instead of stretching to fill.
                        if (rowSpan < columns) {
                            Spacer(modifier = Modifier.weight((columns - rowSpan).toFloat()))
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
                span = { child -> GridItemSpan(gridColumnSpan(child).coerceIn(1, columns)) },
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

    private fun gridColumnSpan(child: HypenElement): Int {
        val raw = child.props["gridColumn.0"] ?: child.props["gridColumn"] ?: return 1
        return when (raw) {
            is Number -> raw.toInt().coerceAtLeast(1)
            is String -> parseSpan(raw)
            else -> 1
        }
    }

    private fun parseSpan(value: String): Int {
        val v = value.trim()
        // "span N"
        if (v.startsWith("span ", ignoreCase = true)) {
            return v.substring(5).trim().toIntOrNull()?.coerceAtLeast(1) ?: 1
        }
        // "a / b" — column-start / column-end (1-indexed, end is exclusive). "1 / 3" => span 2.
        val slash = v.indexOf('/')
        if (slash >= 0) {
            val start = v.substring(0, slash).trim().toIntOrNull()
            val endTok = v.substring(slash + 1).trim()
            if (start != null) {
                if (endTok.startsWith("span ", ignoreCase = true)) {
                    return endTok.substring(5).trim().toIntOrNull()?.coerceAtLeast(1) ?: 1
                }
                val end = endTok.toIntOrNull()
                if (end != null) return (end - start).coerceAtLeast(1)
            }
        }
        // Bare integer — treat as span N.
        return v.toIntOrNull()?.coerceAtLeast(1) ?: 1
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
