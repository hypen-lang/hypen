package space.hypen.renderer.virt

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToIndex
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
import space.hypen.renderer.hasCollectionItemRow
import space.hypen.renderer.model.Patch
import space.hypen.renderer.positionInRoot
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.rows
import space.hypen.renderer.setHypenContent
import space.hypen.renderer.virtWindow

/**
 * A windowed `List` that scrolls itself, rendered for real: the lazy slot
 * path (docs/virtualization.md §5) in `WindowedLazyList`.
 *
 * The list is 300dp tall with 50dp rows, so 6 rows fill it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h800dp-mdpi")
class VirtLazyListRenderTest {
    @get:Rule
    val rule = createComposeRule()

    private val renderer = ComposeRenderer()
    private val engine = FakeViewportEngine().also { it.attach(renderer) }

    /** List(height: 300) { ForEach { rows [0, 20) } } over 1000 items. */
    private fun mountWindowedList() {
        rule.setHypenContent(renderer)
        rule.apply(
            renderer,
            listOf(
                Patch.create("list", "List", mapOf("height.0" to 300.0)),
                Patch.create("fe", "ForEach"),
                Patch.insert("list", "fe"),
            ) + rows("fe", 0 until 20) + listOf(
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(1000, 0, 20)),
                Patch.insert("root", "list"),
            ),
        )
    }

    private fun composedRows(): List<String> =
        rule.onAllNodesWithText("row ", substring = true).fetchSemanticsNodes().map {
            it.config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString()
        }

    @Test
    fun `only the visible window rows are composed and nothing is reported while covered`() {
        mountWindowedList()

        rule.onNode(hasCollectionInfo(rowCount = 1000)).assertExists()
        for (i in 0 until 6) rule.onNodeWithText("row $i").assertIsDisplayed()
        // Lazy: rows of the window below the fold are not composed (allow
        // one row of lookahead/prefetch), let alone the 980 outside it.
        val composed = composedRows()
        assertEquals("composed: $composed", true, composed.size in 6..7)
        rule.onNodeWithText("row 19").assertDoesNotExist()
        // Visible [0, 6) is inside the window [0, 20): no report (§3 step 4).
        assertEquals(emptyList<Report>(), engine.reports)
    }

    @Test
    fun `scrolling past the window reports, a new window materializes, removeProp unwindows`() {
        mountWindowedList()

        // Jump into the placeholders: slot 500 at the top, slots [500, 506) visible.
        rule.onNode(hasScrollToIndexAction()).performScrollToIndex(500)
        rule.waitForIdle()
        assertEquals(emptyList<String>(), composedRows())
        // Visible [500, 506), overscan max(5, 6) = 6 each side.
        assertEquals(Report("list", 494, 512), engine.reports.last())
        val reportsAfterScroll = engine.reports.size

        // The engine answers with the window it was asked for.
        rule.apply(
            renderer,
            (0 until 20).map { Patch.remove("r$it") } +
                rows("fe", 494 until 512) +
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(1000, 494, 512)),
        )
        val listTop = rule.onNode(hasCollectionInfo(rowCount = 1000)).positionInRoot().y
        for (i in 500 until 506) rule.onNodeWithText("row $i").assertIsDisplayed()
        // The placeholder at the top was replaced in place by its row.
        assertEquals(listTop, rule.onNodeWithText("row 500").positionInRoot().y, 0.5f)
        rule.onNodeWithText("row 0").assertDoesNotExist()
        // The new window covers what is visible: nothing more to ask.
        assertEquals(reportsAfterScroll, engine.reports.size)

        // Rows carry their whole-list position, not the window-relative one.
        rule.onNode(hasCollectionItemRow(503)).assert(hasAnyDescendant(hasText("row 503")))

        // Unwindowed: a plain list of the 18 children, no 1000-row collection.
        rule.apply(renderer, listOf(Patch.removeProp("list", VIRT_WINDOW_PROP)))
        rule.onNode(hasCollectionInfo(rowCount = 1000)).assertDoesNotExist()
        rule.onNodeWithText("row 494").assertIsDisplayed()
        rule.onNode(hasCollectionItemRow(494)).assertDoesNotExist()
        assertEquals(reportsAfterScroll, engine.reports.size)
    }
}
