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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import space.hypen.renderer.HypenElement as RenderHypenElement
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
        val fillsFiniteWidth = LocalParentAllowsHorizontalExpansion.current
        val gridModifier = if (fillsFiniteWidth) modifier.fillMaxWidth() else modifier

        if (renderer == null) {
            Log.w(TAG, "No renderer available for Grid component, falling back to regular render")
            Box(modifier = gridModifier) {
                renderChildren()
            }
            return
        }

        // Get children from renderer
        val children = renderer.getChildren(element.id)

        val style = resolveGridStyle(element)
        val columns = style.columns
        val rowGap = style.rowGap.dp
        val columnGap = style.columnGap.dp

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
                modifier = gridModifier,
                verticalArrangement = Arrangement.spacedBy(rowGap),
            ) {
                // Rows are packed by SPAN, not by count: a `gridColumn:
                // "span 2"` item occupies two tracks, so a naive
                // `chunked(columns)` would put `columns` items in a row
                // regardless and silently ignore the span. Mirrors the Swift
                // renderer's `HypenGridLayout.computeGrid`.
                packGridRows(children, columns).forEach { rowChildren ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(columnGap),
                    ) {
                        rowChildren.forEach { child ->
                            key(child.id) {
                                Box(
                                    // A spanning item takes its tracks' share
                                    // of the row, plus the gaps it swallows.
                                    modifier = Modifier.weight(child.gridSpan(columns).toFloat()),
                                    // CSS grid stretches an item to fill its
                                    // cell (`justify-items: stretch`) unless
                                    // the item sets its own width. A plain
                                    // Box hands the child min-width 0, so an
                                    // item with no width hugs its content —
                                    // which is why every calculator key
                                    // rendered as a narrow strip of
                                    // background behind its glyph instead of
                                    // filling the key. Propagating the cell's
                                    // min constraint is Compose's native
                                    // expression of that default; items that
                                    // DO declare a width keep it.
                                    propagateMinConstraints = child.stretchesToGridCell(),
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
                        val filled = rowChildren.sumOf { it.gridSpan(columns) }
                        repeat(columns - filled) {
                            Spacer(modifier = Modifier.weight(1f))
                        }
                    }
                }
            }
            return
        }

        LazyVerticalGrid(
            columns = GridCells.Fixed(columns),
            modifier = gridModifier,
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

internal data class GridStyle(
    val columns: Int,
    val rowGap: Float,
    val columnGap: Float,
)

internal fun resolveGridStyle(element: HypenElement): GridStyle {
    val props = element.props
    val columns = (props["gridColumns.0"] ?: props["gridColumns"] ?: props["columns.0"] ?: props["columns"])
        .asGridInt()
        ?.coerceAtLeast(1)
        ?: 2
    val gap = (props["gap.0"] ?: props["gap"]).asGridFloat() ?: 0f
    val rowGap = (props["rowGap.0"] ?: props["rowGap"]).asGridFloat() ?: gap
    val columnGap = (props["columnGap.0"] ?: props["columnGap"]).asGridFloat() ?: gap
    return GridStyle(columns, rowGap, columnGap)
}

private fun Any?.asGridInt(): Int? = when (this) {
    is Number -> toInt()
    is String -> trim().toIntOrNull()
    else -> null
}

private fun Any?.asGridFloat(): Float? = when (this) {
    is Number -> toFloat()
    is String -> trim().removeSuffix("px").toFloatOrNull()
    else -> null
}

/**
 * How many column tracks this item occupies.
 *
 * `gridColumn` accepts the CSS-ish forms the DSL emits — `"span 2"` or a bare
 * `"2"` — clamped to the track count. Mirrors `GridComponent.parseGridSpan`
 * in the Swift renderer.
 */
internal fun HypenElement.gridSpan(columns: Int): Int {
    val raw = getStringProp("gridColumn.0") ?: getStringProp("gridColumn") ?: return 1
    val trimmed = raw.trim()
    val n = if (trimmed.startsWith("span ", ignoreCase = true)) {
        trimmed.drop(5).trim().toIntOrNull()
    } else {
        trimmed.toIntOrNull()
    }
    return (n ?: 1).coerceIn(1, columns.coerceAtLeast(1))
}

/**
 * Pack items into rows by span, wrapping when a row's tracks run out.
 *
 * Mirrors `HypenGridLayout.computeGrid` in the Swift renderer: an item that
 * doesn't fit the remaining tracks starts a new row, so a `span 2` item never
 * straddles a row boundary.
 */
internal fun packGridRows(children: List<HypenElement>, columns: Int): List<List<HypenElement>> {
    val tracks = columns.coerceAtLeast(1)
    val rows = mutableListOf<List<HypenElement>>()
    var row = mutableListOf<HypenElement>()
    var used = 0

    for (child in children) {
        val span = child.gridSpan(tracks)
        if (used + span > tracks && used > 0) {
            rows.add(row)
            row = mutableListOf()
            used = 0
        }
        row.add(child)
        used += span
        if (used >= tracks) {
            rows.add(row)
            row = mutableListOf()
            used = 0
        }
    }
    if (row.isNotEmpty()) rows.add(row)
    return rows
}

/**
 * Whether a grid item should stretch to fill its cell.
 *
 * CSS `justify-items: stretch` is the grid default, but any explicit
 * width-defining property on the item wins over it. Propagating the cell's
 * min constraint would otherwise coerce those sizes UP to the cell width —
 * `Modifier.width(56.dp)` cannot resolve below an incoming min of the full
 * cell — so every width-defining applicator has to opt out, not just
 * `width`:
 *
 * - `width` / `size` set the width outright.
 * - `maxWidth` caps it; a propagated min would defeat the cap exactly the
 *   way `fillMaxWidth` did before [ApplicatorPriority.SIZE_BOUNDS] existed.
 *
 * `fillMaxWidth` deliberately does NOT opt out: it already fills the cell,
 * so the propagated min is a no-op there.
 */
private fun HypenElement.stretchesToGridCell(): Boolean =
    !hasWidthProp("width") && !hasWidthProp("size") && !hasWidthProp("maxWidth")

private fun HypenElement.hasWidthProp(name: String): Boolean =
    getStringProp("$name.0") != null || getStringProp(name) != null

/**
 * Renders one grid item through the FULL element pipeline.
 *
 * Same story as `ListComponent`'s item renderer: this was a private
 * re-implementation of [HypenElement] that dropped the `__anim.*` playbacks,
 * accessibility semantics and applicator variants for the whole subtree under
 * every `Grid`. See the comment there for why the Row/Column scopes are
 * cleared before delegating.
 */
@Composable
private fun GridItemRenderer(
    element: HypenElement,
    renderer: space.hypen.renderer.render.ComposeRenderer,
) {
    CompositionLocalProvider(
        LocalRowScope provides null,
        LocalColumnScope provides null,
        LocalStretchCrossAxis provides false,
        LocalGridStretchesBareImage provides true,
    ) {
        RenderHypenElement(element = element, renderer = renderer)
    }
}

internal val LocalGridStretchesBareImage = staticCompositionLocalOf { false }
