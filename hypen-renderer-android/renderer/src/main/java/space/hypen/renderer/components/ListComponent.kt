package space.hypen.renderer.components

import android.util.Log
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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

        if (renderer == null) {
            Log.w(TAG, "No renderer available for List component, falling back to regular render")
            Box(modifier = modifier) {
                renderChildren()
            }
            return
        }

        // Flatten control-flow wrappers (__ForEach, __Conditional) to get actual items
        val rawChildren = renderer.getChildren(element.id)
        val children = flattenControlFlowChildren(rawChildren, renderer)

        // Direction - prop or positional arg
        val direction = element.getStringProp("direction.0")
            ?: element.getStringProp("1")
            ?: "vertical"
        val isHorizontal = direction.lowercase() == "horizontal"

        if (isHorizontal) {
            renderHorizontalList(element, modifier, children, renderer)
        } else {
            renderVerticalList(element, modifier, children, renderer)
        }
    }

    @Composable
    private fun renderVerticalList(
        element: HypenElement,
        modifier: Modifier,
        children: List<HypenElement>,
        renderer: space.hypen.renderer.render.ComposeRenderer,
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

        LazyColumn(
            modifier = modifier,
            verticalArrangement = verticalArrangement,
            horizontalAlignment = horizontalAlignment,
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

/**
 * Renders a single list item element with its modifiers and applicators.
 * This is a simplified version of HypenElement rendering for use within Lazy* composables.
 */
@Composable
private fun ListItemRenderer(
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
        // Render as a simple box with children
        Box {
            RenderListItemChildren(element, renderer)
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
            RenderListItemChildren(element, renderer)
        },
    )
}

/**
 * Renders children of a list item element.
 */
@Composable
private fun RenderListItemChildren(
    element: HypenElement,
    renderer: space.hypen.renderer.render.ComposeRenderer,
) {
    val children = renderer.getChildren(element.id)
    for (child in children) {
        key(child.id) {
            ListItemRenderer(element = child, renderer = renderer)
        }
    }
}
