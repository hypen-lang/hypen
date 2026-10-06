package space.hypen.renderer.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import space.hypen.renderer.model.HypenElement

/**
 * Handler for VisuallyHidden - the screen-reader-only ("sr-only") wrapper:
 * invisible on screen, still read by TalkBack.
 *
 * Without a handler the element fell through to HypenApp's unknown-type
 * `Box { children }`, which renders the content visibly - the inverse of the
 * contract.
 *
 * Compose has no out-of-flow positioning to copy the DOM renderer's
 * `position: absolute; clip: rect(0,0,0,0)` trick with, so the contract is
 * assembled from three pieces, and each is load-bearing:
 *
 * - The wrapper occupies a real 1x1dp slot and `clipToBounds()` to it. The
 *   children are measured unbounded (so they keep their natural size and a
 *   non-degenerate semantics node) but every bound Compose derives from them
 *   - accessibility rect, pointer hit region - is clipped to that 1x1 box.
 *   Reporting 0x0 while placing the children full-size, which this first
 *   did, left the hidden subtree's semantics bounds overlapping whatever the
 *   parent laid out NEXT; Compose's accessibility delegate subtracts each
 *   sibling's bounds from an "uncovered" region in reverse draw order and
 *   drops nodes that end up covered, so a full-width Button after the sr-only
 *   text swallowed it and TalkBack never saw it. The same overlap kept a
 *   hidden Button tappable over its neighbour; clipping fixes both.
 * - `drawWithContent` deliberately never calls `drawContent()`, so not even
 *   the clipped pixel is painted. `alpha(0f)` is the shorter spelling but
 *   Compose reports a fully transparent node as not visible to the user,
 *   which is exactly the accessibility outcome this component exists to
 *   avoid.
 * - The author's applicator chain is not applied: a padding or explicit size
 *   on an sr-only wrapper would reclaim visible layout space. Swift ignores
 *   `modifier` here for the same reason; the DOM pins its sr-only styles.
 *
 * The 1dp slot is the same footprint the DOM's sr-only span has (1px, clipped)
 * and the Swift sibling's 1pt frame. Like the Swift one, the TalkBack
 * behaviour is reasoned from the framework's documented rules rather than
 * observed on a device - verify with TalkBack before relying on it.
 */
class VisuallyHiddenComponent : ComponentHandler {
    override val typeName: String = "visuallyhidden"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        Box(
            modifier = Modifier
                .size(1.dp)
                .clipToBounds()
                .drawWithContent { }
                .layout { measurable, constraints ->
                    // Natural size for the children, a 1x1 box for the parent.
                    val placeable = measurable.measure(Constraints())
                    layout(constraints.minWidth, constraints.minHeight) {
                        placeable.place(0, 0)
                    }
                },
        ) {
            renderChildren()
        }
    }
}
