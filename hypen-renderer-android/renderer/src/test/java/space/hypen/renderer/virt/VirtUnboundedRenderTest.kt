package space.hypen.renderer.virt

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.performSemanticsAction
import org.junit.Assert.assertEquals
import space.hypen.renderer.FakeViewportEngine
import space.hypen.renderer.FakeViewportEngine.Report
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import space.hypen.renderer.apply
import space.hypen.renderer.hasCollectionInfo
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.setHypenContent
import space.hypen.renderer.virtWindow

/**
 * A windowed container that would scroll itself (a lazy container) placed
 * inside an ancestor scroller along the same axis, with no fixed size along
 * it: its main-axis constraint is unbounded, where a lazy container cannot
 * measure. It must fall back to the padded path (decided from constraints).
 * Rows go straight into the list, as the engine emits them (control-flow
 * nodes are never sent).
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h800dp-mdpi")
class VirtUnboundedRenderTest {
    @get:Rule
    val rule = createComposeRule()

    private val renderer = ComposeRenderer()
    private val engine = FakeViewportEngine().also { it.attach(renderer) }

    private fun item(i: Int, horizontal: Boolean) = Patch.create(
        "r$i", "Text",
        mapOf("0" to "row $i", (if (horizontal) "width.0" else "height.0") to 50.0),
    )

    /**
     * [outerType] scrolls along the axis and is 300dp along it; [list] holds
     * rows [0, 10) of [total] under a `__virt.window`.
     */
    private fun mount(list: Patch, horizontal: Boolean, total: Int = 100) {
        val outer = if (horizontal) {
            Patch.create("outer", "Row", mapOf("scrollable.0" to true, "width.0" to 300.0))
        } else {
            Patch.create("outer", "Column", mapOf("scrollable.0" to true, "height.0" to 300.0))
        }
        rule.setHypenContent(renderer)
        rule.apply(
            renderer,
            listOf(outer, list, Patch.insert("outer", "list")) +
                (0 until 10).map { item(it, horizontal) } +
                (0 until 10).map { Patch.insert("list", "r$it") } +
                listOf(
                    Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(total, 0, 10)),
                    Patch.insert("root", "outer"),
                ),
        )
    }

    /** Scroll the outer scroller 2000dp: the list reports from it (padded path). */
    private fun assertReportsOnOuterScroll(horizontal: Boolean, expected: Report) {
        rule.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) {
            if (horizontal) it(2000f, 0f) else it(0f, 2000f)
        }
        rule.waitForIdle()
        assertEquals(expected, engine.reports.last())
    }

    private fun assertRendered(rowCount: Int = 100, columnCount: Int = 1) {
        rule.onNodeWithText("row 0").assertIsDisplayed()
        rule.onNodeWithText("row 9").assertExists()
        rule.onNode(hasCollectionInfo(rowCount, columnCount)).assertExists()
    }

    @Test
    fun `plain List in a scrolling Column is padded`() {
        mount(Patch.create("list", "List"), horizontal = false)
        assertRendered()
        assertReportsOnOuterScroll(false, Report("list", 34, 52))
    }

    @Test
    fun `scrollable List in a scrolling Column`() {
        mount(Patch.create("list", "List", mapOf("scrollable.0" to true)), horizontal = false)
        assertRendered()
        assertReportsOnOuterScroll(false, Report("list", 34, 52))
    }

    @Test
    fun `fillMaxHeight List in a scrolling Column`() {
        mount(Patch.create("list", "List", mapOf("fillMaxHeight.0" to true)), horizontal = false)
        assertRendered()
        assertReportsOnOuterScroll(false, Report("list", 34, 52))
    }

    @Test
    fun `scrollable Grid in a scrolling Column`() {
        mount(Patch.create("list", "Grid", mapOf("scrollable.0" to true, "columns.0" to 2.0)), horizontal = false)
        assertRendered(rowCount = 50, columnCount = 2)
        // Rows [40, 46) of 2 columns: items [80, 92), +12 each side.
        assertReportsOnOuterScroll(false, Report("list", 68, 100))
    }

    @Test
    fun `scrollable windowed Column in a scrolling Column`() {
        mount(Patch.create("list", "Column", mapOf("scrollable.0" to true)), horizontal = false)
        assertRendered()
        assertReportsOnOuterScroll(false, Report("list", 34, 52))
    }

    @Test
    fun `horizontal List in a scrolling Row`() {
        mount(Patch.create("list", "List", mapOf("direction.0" to "horizontal")), horizontal = true)
        assertRendered(rowCount = 1, columnCount = 100)
        assertReportsOnOuterScroll(true, Report("list", 34, 52))
    }

    @Test
    fun `scrollable windowed Row in a scrolling Row`() {
        mount(Patch.create("list", "Row", mapOf("scrollable.0" to true)), horizontal = true)
        assertRendered(rowCount = 1, columnCount = 100)
        assertReportsOnOuterScroll(true, Report("list", 34, 52))
    }
}
