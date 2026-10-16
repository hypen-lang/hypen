package space.hypen.renderer.virt

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
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
import space.hypen.renderer.positionInRoot
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.setHypenContent
import space.hypen.renderer.virtWindow

/**
 * The windowed shapes beyond the vertical List: a lazy `Grid`, a horizontal
 * `List`, a self-scrolling `Column` / `Row` (the lazy slot path from
 * `HypenElement`), and padded anchoring inside a lazy scroller. Rows go
 * straight into the list, as the engine emits them. Items are 50dp along the
 * scroll axis; density 1.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h800dp-mdpi")
class VirtShapesRenderTest {
    @get:Rule
    val rule = createComposeRule()

    private val renderer = ComposeRenderer()
    private val engine = FakeViewportEngine().also { it.attach(renderer) }

    private fun item(i: Int, horizontal: Boolean = false) = Patch.create(
        "r$i", "Text",
        mapOf("0" to "row $i", (if (horizontal) "width.0" else "height.0") to 50.0),
    )

    private fun items(parentId: String, range: IntRange, horizontal: Boolean = false) =
        range.map { item(it, horizontal) } + range.map { Patch.insert(parentId, "r$it") }

    /** Mount [list] at the root holding items [window] of [total]. */
    private fun mount(list: Patch, total: Int, window: IntRange, horizontal: Boolean = false) {
        rule.setHypenContent(renderer)
        rule.apply(
            renderer,
            listOf(list) + items(list.id!!, window, horizontal) + listOf(
                Patch.setProp(list.id!!, VIRT_WINDOW_PROP, virtWindow(total, window.first, window.last + 1)),
                Patch.insert("root", list.id!!),
            ),
        )
    }

    private fun hasItemCell(row: Int, column: Int) = SemanticsMatcher("CollectionItemInfo($row, $column)") {
        val info = it.config.getOrNull(SemanticsProperties.CollectionItemInfo)
        info != null && info.rowIndex == row && info.columnIndex == column
    }

    /** Jump the lazy container to [index], then answer its report with that window. */
    private fun scrollAndAnswer(index: Int, expected: Report, horizontal: Boolean = false) {
        rule.onNode(hasScrollToIndexAction()).performScrollToIndex(index)
        rule.waitForIdle()
        assertEquals(expected, engine.reports.last())
        val reports = engine.reports.size
        val old = renderer.getChildren("list").map { it.id }
        rule.apply(
            renderer,
            old.map { Patch.remove(it) } + items("list", expected.start until expected.end, horizontal) +
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(renderer.getElement("list")!!.virtWindow()!!.total, expected.start, expected.end)),
        )
        rule.onNodeWithText("row $index").assertIsDisplayed()
        assertEquals(reports, engine.reports.size)
    }

    @Test
    fun `lazy Grid windows by rows, reports and exposes rows x columns`() {
        mount(Patch.create("list", "Grid", mapOf("scrollable.0" to true, "columns.0" to 2.0, "height.0" to 300.0)), 100, 0..19)
        rule.onNode(hasCollectionInfo(rowCount = 50, columnCount = 2)).assertExists()
        for (i in 0 until 12) rule.onNodeWithText("row $i").assertIsDisplayed()
        rule.onNodeWithText("row 19").assertDoesNotExist()
        assertEquals(emptyList<Report>(), engine.reports)

        // Item 60 = grid row 30 at the top: rows [30, 36) = items [60, 72) on
        // screen, widened by 12 items each side.
        scrollAndAnswer(60, Report("list", 48, 84))
        val top = rule.onNode(hasCollectionInfo(rowCount = 50, columnCount = 2)).positionInRoot().y
        assertEquals(top, rule.onNodeWithText("row 60").positionInRoot().y, 0.5f)
        rule.onNode(hasItemCell(30, 1)).assert(hasAnyDescendant(hasText("row 61")))
    }

    @Test
    fun `horizontal List is a lazy row over total slots`() {
        mount(Patch.create("list", "List", mapOf("direction.0" to "horizontal")), 1000, 0..19, horizontal = true)
        rule.onNode(hasCollectionInfo(rowCount = 1, columnCount = 1000)).assertExists()
        rule.onNodeWithText("row 0").assertIsDisplayed()
        rule.onNodeWithText("row 19").assertDoesNotExist()

        // 360dp wide: slots [500, 508) visible, widened by 8 each side.
        scrollAndAnswer(500, Report("list", 492, 516), horizontal = true)
        rule.onNode(hasItemCell(0, 503)).assert(hasAnyDescendant(hasText("row 503")))
    }

    @Test
    fun `scrollable windowed Column renders through the lazy slot path`() {
        mount(Patch.create("list", "Column", mapOf("scrollable.0" to true, "height.0" to 300.0)), 1000, 0..19)
        rule.onNode(hasCollectionInfo(rowCount = 1000)).assertExists()
        rule.onNodeWithText("row 19").assertDoesNotExist()
        scrollAndAnswer(500, Report("list", 494, 512))
        rule.onNode(hasItemCell(503, 0)).assert(hasAnyDescendant(hasText("row 503")))
    }

    @Test
    fun `scrollable windowed Row renders through the lazy slot path`() {
        mount(Patch.create("list", "Row", mapOf("scrollable.0" to true, "width.0" to 300.0)), 1000, 0..19, horizontal = true)
        rule.onNode(hasCollectionInfo(rowCount = 1, columnCount = 1000)).assertExists()
        rule.onNodeWithText("row 19").assertDoesNotExist()
        scrollAndAnswer(500, Report("list", 494, 512), horizontal = true)
    }

    @Test
    fun `padded list anchors inside a lazy scroller`() {
        // List(height: 300) { Text(header, 100dp); Column { rows } } — the
        // List is a lazy scroller of two items; the Column is padded.
        rule.setHypenContent(renderer)
        rule.apply(
            renderer,
            listOf(
                Patch.create("outer", "List", mapOf("height.0" to 300.0)),
                Patch.create("header", "Text", mapOf("0" to "header", "height.0" to 100.0)),
                Patch.create("list", "Column"),
                Patch.insert("outer", "header"),
                Patch.insert("outer", "list"),
            ) + items("list", 0..9) + listOf(
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(100_000, 0, 10)),
                Patch.insert("root", "outer"),
            ),
        )
        rule.onNode(hasCollectionInfo(rowCount = 100_000)).assertExists()

        rule.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 500f) }
        rule.waitForIdle()
        val before = rule.onNodeWithText("row 8").positionInRoot().y
        assertEquals(0f, before, 0.5f)

        // 5 thin pad rows replace rows 0..4 above row 8: anchoring holds it.
        rule.apply(
            renderer,
            (0..4).map { Patch.remove("r$it") } + items("list", 10..24) +
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(100_000, 5, 25)),
        )
        rule.onNodeWithText("row 8").assertIsDisplayed()
        assertEquals(before, rule.onNodeWithText("row 8").positionInRoot().y, 1.5f)
    }
}
