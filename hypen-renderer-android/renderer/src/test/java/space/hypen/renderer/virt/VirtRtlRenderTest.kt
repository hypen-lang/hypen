package space.hypen.renderer.virt

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.LayoutDirection
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import space.hypen.renderer.FakeViewportEngine
import space.hypen.renderer.FakeViewportEngine.Report
import space.hypen.renderer.apply
import space.hypen.renderer.hasCollectionInfo
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.setHypenContent
import space.hypen.renderer.virtWindow

/**
 * Horizontal windowed lists under right-to-left layout: the list's start
 * edge is its right edge, so "scrolled past the start" and the anchor row's
 * position are measured from the right. Host 360dp wide, density 1.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h800dp-mdpi")
class VirtRtlRenderTest {
    @get:Rule
    val rule = createComposeRule()

    private val renderer = ComposeRenderer()
    private val engine = FakeViewportEngine().also { it.attach(renderer) }

    private fun items(range: IntRange) =
        range.map { Patch.create("r$it", "Text", mapOf("0" to "row $it", "width.0" to 50.0)) } +
            range.map { Patch.insert("list", "r$it") }

    /** Right edge (the start edge in RTL) of the node with [text], root px. */
    private fun startEdge(text: String): Float =
        rule.onNodeWithText(text).fetchSemanticsNode().let { it.positionInRoot.x + it.size.width }

    /** Scroll a horizontal scroller [px] toward its end (leftwards in RTL). */
    private fun scrollTowardEnd(px: Float) {
        rule.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(px, 0f) }
        rule.waitForIdle()
    }

    /** Scrollable Row (300dp) { header (100dp); windowed Row { rows } }, RTL. */
    private fun mountPadded(total: Int) {
        rule.setHypenContent(renderer, layoutDirection = LayoutDirection.Rtl)
        rule.apply(
            renderer,
            listOf(
                Patch.create("outer", "Row", mapOf("scrollable.0" to true, "width.0" to 300.0)),
                Patch.create("header", "Text", mapOf("0" to "header", "width.0" to 100.0)),
                Patch.create("list", "Row"),
                Patch.insert("outer", "header"),
                Patch.insert("outer", "list"),
            ) + items(0..9) + listOf(
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(total, 0, 10)),
                Patch.insert("root", "outer"),
            ),
        )
    }

    @Test
    fun `padded RTL list reports the range scrolled to`() {
        mountPadded(total = 100)
        val outerStart = startEdge("header")
        // Header at the start (right), row 0 right after it, leftwards.
        assertEquals(outerStart - 100f, startEdge("row 0"), 0.5f)
        assertEquals(emptyList<Report>(), engine.reports)

        // 2000dp past the list's start (+100 header): items [40, 46).
        scrollTowardEnd(2100f)
        assertEquals(outerStart + 2100f, startEdge("header"), 0.5f)
        assertEquals(Report("list", 34, 52), engine.reports.last())
    }

    @Test
    fun `padded RTL anchoring keeps the first visible item's start edge`() {
        mountPadded(total = 100_000)
        val outerStart = startEdge("header")
        scrollTowardEnd(500f)
        val before = startEdge("row 8")
        assertEquals(outerStart, before, 0.5f)

        rule.apply(
            renderer,
            (0..4).map { Patch.remove("r$it") } + items(10..24) +
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(100_000, 5, 25)),
        )
        rule.onNodeWithText("row 8").assertIsDisplayed()
        assertEquals(before, startEdge("row 8"), 1.5f)
    }

    @Test
    fun `lazy RTL list reports the range scrolled to`() {
        rule.setHypenContent(renderer, layoutDirection = LayoutDirection.Rtl)
        rule.apply(
            renderer,
            listOf(Patch.create("list", "List", mapOf("direction.0" to "horizontal"))) + items(0..19) + listOf(
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(1000, 0, 20)),
                Patch.insert("root", "list"),
            ),
        )
        rule.onNode(hasCollectionInfo(rowCount = 1, columnCount = 1000)).assertExists()
        assertEquals(360f, startEdge("row 0"), 0.5f)
        rule.onNode(hasScrollToIndexAction()).performScrollToIndex(500)
        rule.waitForIdle()
        // 360dp: slots [500, 508), widened by 8 each side.
        assertEquals(Report("list", 492, 516), engine.reports.last())

        rule.apply(
            renderer,
            (0..19).map { Patch.remove("r$it") } + items(492..515) +
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(1000, 492, 516)),
        )
        assertEquals(360f, startEdge("row 500"), 0.5f)
    }
}
