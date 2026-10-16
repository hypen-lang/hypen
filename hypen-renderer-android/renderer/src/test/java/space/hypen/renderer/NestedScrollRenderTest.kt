package space.hypen.renderer

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ComposeRenderer

/**
 * A `.scrollable(true)` Column / Row nested in a scroller on the same axis.
 * Like the DOM: when the inner one's main axis is unbounded (no size of its
 * own) it lays out at its full content size and the outer one scrolls; when
 * it is bounded it scrolls itself. Decided from constraints at measure time.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h800dp-mdpi")
class NestedScrollRenderTest {
    @get:Rule
    val rule = createComposeRule()

    private val renderer = ComposeRenderer()

    private fun item(i: Int, horizontal: Boolean) = Patch.create(
        "r$i", "Text",
        mapOf("0" to "row $i", (if (horizontal) "width.0" else "height.0") to 50.0),
    )

    private fun mount(outer: Patch, inner: Patch, horizontal: Boolean) {
        rule.setHypenContent(renderer)
        rule.apply(
            renderer,
            listOf(outer, inner, Patch.insert("outer", "inner")) +
                (0 until 10).map { item(it, horizontal) } +
                (0 until 10).map { Patch.insert("inner", "r$it") } +
                Patch.insert("root", "outer"),
        )
    }

    private fun scrollers() = rule.onAllNodes(hasScrollAction()).fetchSemanticsNodes().size

    private fun scrollOuter(px: Float, horizontal: Boolean) {
        rule.onAllNodes(hasScrollAction())[0].performSemanticsAction(SemanticsActions.ScrollBy) {
            if (horizontal) it(px, 0f) else it(0f, px)
        }
        rule.waitForIdle()
    }

    @Test
    fun `unbounded scrollable Column in a scrolling Column lays out in full`() {
        mount(
            Patch.create("outer", "Column", mapOf("scrollable.0" to true, "height.0" to 300.0)),
            Patch.create("inner", "Column", mapOf("scrollable.0" to true)),
            horizontal = false,
        )
        assertEquals(1, scrollers())
        assertEquals(450f, rule.onNodeWithText("row 9").positionInRoot().y, 0.5f)
        scrollOuter(200f, horizontal = false)
        assertEquals(0f, rule.onNodeWithText("row 4").positionInRoot().y, 0.5f)
    }

    @Test
    fun `bounded scrollable Column in a scrolling Column scrolls itself`() {
        mount(
            Patch.create("outer", "Column", mapOf("scrollable.0" to true, "height.0" to 300.0)),
            Patch.create("inner", "Column", mapOf("scrollable.0" to true, "height.0" to 200.0)),
            horizontal = false,
        )
        assertEquals(2, scrollers())
        rule.onAllNodes(hasScrollAction())[1].performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100f) }
        rule.waitForIdle()
        assertEquals(0f, rule.onNodeWithText("row 2").positionInRoot().y, 0.5f)
    }

    @Test
    fun `unbounded scrollable Row in a scrolling Row lays out in full`() {
        mount(
            Patch.create("outer", "Row", mapOf("scrollable.0" to true, "width.0" to 300.0)),
            Patch.create("inner", "Row", mapOf("scrollable.0" to true)),
            horizontal = true,
        )
        assertEquals(1, scrollers())
        assertEquals(450f, rule.onNodeWithText("row 9").positionInRoot().x, 0.5f)
        scrollOuter(200f, horizontal = true)
        assertEquals(0f, rule.onNodeWithText("row 4").positionInRoot().x, 0.5f)
    }

    @Test
    fun `scrollable Column inside a lazy List row lays out in full`() {
        mount(
            Patch.create("outer", "List", mapOf("height.0" to 300.0)),
            Patch.create("inner", "Column", mapOf("scrollable.0" to true)),
            horizontal = false,
        )
        rule.onNodeWithText("row 0").assertIsDisplayed()
        assertEquals(1, scrollers())
        assertEquals(10, rule.onAllNodesWithText("row ", substring = true).fetchSemanticsNodes().size)
    }
}
