package space.hypen.renderer.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import space.hypen.renderer.model.HypenElement

/**
 * Embedder-supplied safe-area insets, in dp.
 *
 * Per-edge optional and **merged over the platform default**: a value of
 * `null` for an edge means "use `WindowInsets.safeDrawing` for that edge",
 * while `0.dp` explicitly zeroes it. So `HypenSafeAreaInsets(bottom = 0.dp)`
 * keeps the real status-bar inset on top and drops only the navigation-bar
 * inset at the bottom.
 *
 * `left`/`right` are absolute (not layout-direction relative), matching the
 * DSL's `edges: ["left", "right"]` and the other renderers.
 */
data class HypenSafeAreaInsets(
    val top: Dp? = null,
    val right: Dp? = null,
    val bottom: Dp? = null,
    val left: Dp? = null,
)

/**
 * Host override for the insets a `SafeArea` element pads by.
 *
 * `null` (the default) means every edge uses `WindowInsets.safeDrawing`.
 * Provided by [space.hypen.renderer.HypenApp]'s `safeAreaInsets` parameter;
 * an embedder that hosts the renderer itself can also provide it directly.
 */
val LocalHypenSafeAreaInsets = compositionLocalOf<HypenSafeAreaInsets?> { null }

/** The four edges a `SafeArea` can inset, as named by the DSL `edges` prop. */
internal enum class SafeAreaEdge { TOP, RIGHT, BOTTOM, LEFT }

internal val ALL_SAFE_AREA_EDGES: Set<SafeAreaEdge> = SafeAreaEdge.entries.toSet()

/**
 * Which edges to inset, from the wire `edges` prop.
 *
 * Absent, non-list or empty -> all four edges. A non-empty list is filtered to
 * the names we know, which can legitimately leave *no* edges selected
 * (`edges: ["banana"]` insets nothing) — only an absent/empty prop means "all".
 */
internal fun parseSafeAreaEdges(raw: List<String>?): Set<SafeAreaEdge> {
    if (raw.isNullOrEmpty()) return ALL_SAFE_AREA_EDGES
    return raw.mapNotNullTo(LinkedHashSet()) { name ->
        when (name.trim().lowercase()) {
            "top" -> SafeAreaEdge.TOP
            "right" -> SafeAreaEdge.RIGHT
            "bottom" -> SafeAreaEdge.BOTTOM
            "left" -> SafeAreaEdge.LEFT
            else -> null
        }
    }
}

/** Reads `edges` (or its `.0` applicator variant) off the element. */
internal fun parseSafeAreaEdges(element: HypenElement): Set<SafeAreaEdge> =
    parseSafeAreaEdges(element.getStringListProp("edges"))

/**
 * The insets to apply, split by where each selected edge's value comes from.
 *
 * Two sources need two modifiers: [platformEdges] resolve at layout time from
 * `WindowInsets.safeDrawing`, while [fixed] are known dp values from the
 * embedder override.
 */
internal data class ResolvedSafeArea(
    val platformEdges: Set<SafeAreaEdge>,
    val fixed: Map<SafeAreaEdge, Dp>,
)

/**
 * Merges the embedder override over the platform default, per edge, for the
 * selected [edges] only. An edge the override leaves `null` falls back to
 * `safeDrawing`; an edge it sets (including `0.dp`) wins.
 */
internal fun resolveSafeArea(
    edges: Set<SafeAreaEdge>,
    override: HypenSafeAreaInsets?,
): ResolvedSafeArea {
    val platform = LinkedHashSet<SafeAreaEdge>()
    val fixed = LinkedHashMap<SafeAreaEdge, Dp>()
    for (edge in edges) {
        val custom = when (edge) {
            SafeAreaEdge.TOP -> override?.top
            SafeAreaEdge.RIGHT -> override?.right
            SafeAreaEdge.BOTTOM -> override?.bottom
            SafeAreaEdge.LEFT -> override?.left
        }
        if (custom == null) {
            platform.add(edge)
        } else {
            // Modifier.padding throws on negative values (see SafeSpacingTest).
            fixed[edge] = if (custom.value < 0f) 0.dp else custom
        }
    }
    return ResolvedSafeArea(platform, fixed)
}

/**
 * The `WindowInsetsSides` mask for [edges], or null when nothing is selected
 * (`WindowInsetsSides` has no public "none" value, and an empty mask means we
 * skip the inset modifier entirely).
 */
internal fun safeAreaSides(edges: Set<SafeAreaEdge>): WindowInsetsSides? {
    var mask: WindowInsetsSides? = null
    for (edge in edges) {
        val side = when (edge) {
            SafeAreaEdge.TOP -> WindowInsetsSides.Top
            SafeAreaEdge.RIGHT -> WindowInsetsSides.Right
            SafeAreaEdge.BOTTOM -> WindowInsetsSides.Bottom
            SafeAreaEdge.LEFT -> WindowInsetsSides.Left
        }
        mask = mask?.plus(side) ?: side
    }
    return mask
}

/** Absolute padding for the override-supplied edges; unset edges are zero. */
internal fun ResolvedSafeArea.fixedPadding(): PaddingValues =
    PaddingValues.Absolute(
        left = fixed[SafeAreaEdge.LEFT] ?: 0.dp,
        top = fixed[SafeAreaEdge.TOP] ?: 0.dp,
        right = fixed[SafeAreaEdge.RIGHT] ?: 0.dp,
        bottom = fixed[SafeAreaEdge.BOTTOM] ?: 0.dp,
    )

/**
 * Handler for the SafeArea container.
 *
 * A full-size vertical stack (same child layout as [AppComponent]) that pads
 * its content by the effective safe-area inset on the selected edges.
 *
 * The safe-area padding is appended *after* the applicator-built [modifier],
 * so a `.background(...)` or `.padding(16)` from the user sits outside it:
 * the background paints full-bleed under the system bars while the children
 * are inset, and user padding and safe-area padding stack additively — which
 * is the wrapper behaviour the cross-renderer spec asks for, without needing
 * a second composable.
 *
 * A nested SafeArea adds nothing on edges the outer one already handled:
 * `windowInsetsPadding` consumes what it applies, so the inner one sees the
 * remaining (usually zero) insets.
 */
class SafeAreaComponent : ComponentHandler {
    override val typeName: String = "safearea"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val resolved = resolveSafeArea(parseSafeAreaEdges(element), LocalHypenSafeAreaInsets.current)

        var safeModifier = modifier.fillMaxSize()
        safeAreaSides(resolved.platformEdges)?.let { sides ->
            safeModifier = safeModifier.windowInsetsPadding(WindowInsets.safeDrawing.only(sides))
        }
        if (resolved.fixed.isNotEmpty()) {
            safeModifier = safeModifier.padding(resolved.fixedPadding())
        }

        val gap = element.getFloatProp("gap.0") ?: 0f
        val verticalArrangement = if (gap > 0) Arrangement.spacedBy(gap.dp) else Arrangement.Top

        Column(
            modifier = safeModifier,
            verticalArrangement = verticalArrangement,
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
