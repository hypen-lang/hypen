package space.hypen.renderer.components

import android.util.Log
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import space.hypen.renderer.HypenElement as RenderHypenElement
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.render.LocalComposeRenderer

/**
 * Known control-flow element types that should be flattened (transparent containers).
 * The engine wraps ForEach/Conditional items in internal container elements,
 * but List needs to render individual items directly.
 */
private val CONTROL_FLOW_TYPES = setOf(
    "ForEach", "__ForEach",
    "Conditional", "__Conditional",
    "When", "__When",
    "If", "__If",
)

/**
 * Recursively flatten control-flow wrapper elements to get actual renderable children.
 */
private fun flattenControlFlowChildren(
    elements: List<HypenElement>,
    renderer: space.hypen.renderer.render.ComposeRenderer,
): List<HypenElement> {
    val result = mutableListOf<HypenElement>()
    for (element in elements) {
        if (element.elementType in CONTROL_FLOW_TYPES) {
            val innerChildren = renderer.getChildren(element.id)
            result.addAll(flattenControlFlowChildren(innerChildren, renderer))
        } else {
            result.add(element)
        }
    }
    return result
}

/**
 * Handler for List components using LazyColumn/LazyRow for virtualized scrolling.
 *
 * The engine expands List items but preserves the "list" element type,
 * so this component can use Lazy* composables for efficient rendering of long lists.
 *
 * Supported props:
 * - direction: "vertical" (default) or "horizontal"
 * - .verticalAlignment(center) - arrangement/alignment
 * - .horizontalAlignment(start) - arrangement/alignment
 */
class ListComponent : ComponentHandler {
    override val typeName: String = "list"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val renderer = LocalComposeRenderer.current
        val listModifier = if (LocalParentAllowsHorizontalExpansion.current) {
            modifier.fillMaxWidth()
        } else {
            modifier
        }

        if (renderer == null) {
            Log.w(TAG, "No renderer available for List component, falling back to regular render")
            Box(modifier = listModifier) {
                renderChildren()
            }
            return
        }

        // Flatten control-flow wrappers (__ForEach, __Conditional) to get actual items
        val rawChildren = renderer.getChildren(element.id)
        val children = flattenControlFlowChildren(rawChildren, renderer)
        val hasDynamicItems = rawChildren.any { it.elementType in CONTROL_FLOW_TYPES }

        // Direction - prop or positional arg
        val direction = element.getStringProp("direction.0")
            ?: element.getStringProp("1")
            ?: "vertical"
        val isHorizontal = direction.lowercase() == "horizontal"

        if (isHorizontal) {
            renderHorizontalList(element, listModifier, children, renderer)
        } else {
            renderVerticalList(element, listModifier, children, renderer, hasDynamicItems)
        }
    }

    @Composable
    private fun renderVerticalList(
        element: HypenElement,
        modifier: Modifier,
        children: List<HypenElement>,
        renderer: space.hypen.renderer.render.ComposeRenderer,
        hasDynamicItems: Boolean,
    ) {
        val verticalStr = element.getStringProp("verticalAlignment.0")
            ?: element.getStringProp("justifyContent.0")
        val verticalArrangement = when (verticalStr?.lowercase()) {
            "top", "start" -> Arrangement.Top
            "bottom", "end" -> Arrangement.Bottom
            "center" -> Arrangement.Center
            "spacebetween", "space-between" -> Arrangement.SpaceBetween
            "spacearound", "space-around" -> Arrangement.SpaceAround
            "spaceevenly", "space-evenly" -> Arrangement.SpaceEvenly
            else -> Arrangement.Top
        }

        val horizontalStr = element.getStringProp("horizontalAlignment.0")
            ?: element.getStringProp("alignItems.0")
        val horizontalAlignment = when (horizontalStr?.lowercase()) {
            "start", "left" -> Alignment.Start
            "end", "right" -> Alignment.End
            "center" -> Alignment.CenterHorizontally
            else -> Alignment.Start
        }

        val gap = element.getFloatProp("gap.0") ?: element.getFloatProp("gap") ?: 0f
        val layout = resolveListLayout(element, hasDynamicItems)

        if (layout.scrollsVertically) {
            LazyColumn(
                modifier = modifier,
                verticalArrangement = if (gap > 0 && verticalArrangement == Arrangement.Top) {
                    Arrangement.spacedBy(gap.dp)
                } else {
                    verticalArrangement
                },
                horizontalAlignment = horizontalAlignment,
            ) {
                items(
                    items = children,
                    key = { child -> child.id }
                ) { child ->
                    key(child.id) {
                        ListItemRenderer(element = child, renderer = renderer, fillsWidth = true)
                    }
                }
            }
        } else {
            Column(
                modifier = modifier,
                verticalArrangement = if (gap > 0 && verticalArrangement == Arrangement.Top) {
                    Arrangement.spacedBy(gap.dp)
                } else {
                    verticalArrangement
                },
                horizontalAlignment = horizontalAlignment,
            ) {
                children.forEach { child ->
                    key(child.id) {
                        ListItemRenderer(element = child, renderer = renderer, fillsWidth = true)
                    }
                }
            }
        }
    }

    @Composable
    private fun renderHorizontalList(
        element: HypenElement,
        modifier: Modifier,
        children: List<HypenElement>,
        renderer: space.hypen.renderer.render.ComposeRenderer,
    ) {
        val horizontalStr = element.getStringProp("horizontalAlignment.0")
            ?: element.getStringProp("justifyContent.0")
        val horizontalArrangement = when (horizontalStr?.lowercase()) {
            "start", "left" -> Arrangement.Start
            "end", "right" -> Arrangement.End
            "center" -> Arrangement.Center
            "spacebetween", "space-between" -> Arrangement.SpaceBetween
            "spacearound", "space-around" -> Arrangement.SpaceAround
            "spaceevenly", "space-evenly" -> Arrangement.SpaceEvenly
            else -> Arrangement.Start
        }

        val verticalStr = element.getStringProp("verticalAlignment.0")
            ?: element.getStringProp("alignItems.0")
        val verticalAlignment = when (verticalStr?.lowercase()) {
            "top", "start" -> Alignment.Top
            "bottom", "end" -> Alignment.Bottom
            "center" -> Alignment.CenterVertically
            else -> Alignment.Top
        }

        LazyRow(
            modifier = modifier,
            horizontalArrangement = horizontalArrangement,
            verticalAlignment = verticalAlignment,
        ) {
            items(
                items = children,
                key = { child -> child.id }
            ) { child ->
                key(child.id) {
                    ListItemRenderer(element = child, renderer = renderer)
                }
            }
        }
    }

    companion object {
        private const val TAG = "ListComponent"
    }
}

internal data class ListLayout(
    val fillsFiniteWidth: Boolean = true,
    val scrollsVertically: Boolean,
)

/**
 * When a `List` virtualises. It composes through `LazyColumn` (only the
 * visible rows exist) when it scrolls, and it scrolls when any of these
 * hold and overflow is not `hidden` / `clip`:
 * - it has dynamic items (a `ForEach` / conditional wrapper among its
 *   children — the engine-driven feed case),
 * - it is explicitly `.scrollable(...)`,
 * - it has a finite height (`height`, `maxHeight`, `size`, `fillMaxHeight`
 *   or `fillMaxSize`), or
 * - `overflow` is `auto` / `scroll`.
 *
 * Otherwise it is a plain `Column` and composes every child. That is the
 * only correct choice for a list that must size to its content inside
 * another scroller (a `LazyColumn` needs a bounded height), so a long
 * STATIC list that should virtualise must say so: give it a height or mark
 * it scrollable. Same rule as the Swift renderer's `resolveListLayout`.
 */
internal fun resolveListLayout(element: HypenElement, hasDynamicItems: Boolean = false): ListLayout {
    val props = element.props
    val overflow = listOf(
        "overflowY.0", "overflow-y.0", "overflowY", "overflow-y", "overflow.0", "overflow",
    ).firstNotNullOfOrNull { props[it]?.toString()?.lowercase() }
    val explicitlyScrollable = element.getBoolProp("scrollable.0") == true ||
        element.getStringProp("scrollable.0")?.lowercase() in setOf("true", "vertical", "both", "auto", "scroll")
    val hasFiniteHeight = listOf("height.0", "height", "maxHeight.0", "maxHeight", "size.0", "size")
        .any { props[it] != null } ||
        element.getBoolProp("fillMaxHeight.0") == true ||
        element.getBoolProp("fillMaxSize.0") == true
    val clipsOverflow = overflow in setOf("hidden", "clip")
    val scrolls = !clipsOverflow && (
        hasDynamicItems || explicitlyScrollable || hasFiniteHeight || overflow in setOf("auto", "scroll")
    )
    return ListLayout(scrollsVertically = scrolls)
}

/**
 * Renders one list item through the FULL element pipeline.
 *
 * This used to be a private re-implementation of [HypenElement] ("a
 * simplified version"), which silently dropped everything the real pipeline
 * layers on: the `__anim.*` playbacks (so `.enter`/`.exit`/`.transition` on
 * a `List` item never reached the pixels — the exit still deferred teardown
 * on the coordinator's timer, so a removed row froze for its exit duration
 * and then snapped), engine-derived accessibility semantics, and applicator
 * variants. Since it recursed into its own children, the whole subtree under
 * every `List` was affected. [HypenElement] is `internal` precisely so
 * handlers can reuse it, so we delegate.
 *
 * The Row/Column scopes are cleared first. Lazy item content inherits the
 * CompositionLocals of the composition that declared the `List`, so an outer
 * `Column`'s [LocalColumnScope] would still be visible here — and
 * `Modifier.weight` from a foreign scope is not valid in a Lazy item. The old
 * simplified renderer avoided that by never applying weight at all; clearing
 * the scopes preserves exactly that behaviour while everything else in the
 * pipeline comes back.
 */
@Composable
private fun ListItemRenderer(
    element: HypenElement,
    renderer: space.hypen.renderer.render.ComposeRenderer,
    fillsWidth: Boolean = false,
) {
    val content: @Composable () -> Unit = {
        CompositionLocalProvider(
            LocalRowScope provides null,
            LocalColumnScope provides null,
            LocalStretchCrossAxis provides false,
            LocalParentAllowsHorizontalExpansion provides fillsWidth,
        ) {
            RenderHypenElement(element = element, renderer = renderer)
        }
    }

    if (fillsWidth) {
        Box(
            modifier = Modifier.fillMaxWidth(),
            propagateMinConstraints = element.stretchesToListWidth(),
        ) {
            content()
        }
    } else {
        content()
    }
}

private fun HypenElement.stretchesToListWidth(): Boolean =
    listOf("width", "size", "maxWidth").none { name ->
        props["$name.0"] != null || props[name] != null
    }
