package space.hypen.renderer.virt

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
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
 * The padded path (docs/virtualization.md §2/§3) rendered for real: a
 * windowed `Column { ForEach(lazy) }` that does not scroll itself, inside a
 * 300dp scrollable `Column` under a 100dp header. Rows are 50dp; density is
 * 1, so dp == px.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h800dp-mdpi")
class VirtPaddedRenderTest {
    @get:Rule
    val rule = createComposeRule()

    private val renderer = ComposeRenderer()
    private val engine = FakeViewportEngine().also { it.attach(renderer) }

    private fun mount(total: Int, window: IntRange) {
        rule.setHypenContent(renderer)
        rule.apply(
            renderer,
            listOf(
                Patch.create("outer", "Column", mapOf("scrollable.0" to true, "height.0" to 300.0)),
                Patch.create("header", "Text", mapOf("0" to "header", "height.0" to 100.0)),
                Patch.create("feed", "Column"),
                Patch.create("fe", "ForEach"),
                Patch.insert("outer", "header"),
                Patch.insert("outer", "feed"),
                Patch.insert("feed", "fe"),
            ) + rows("fe", window) + listOf(
                Patch.setProp("feed", VIRT_WINDOW_PROP, virtWindow(total, window.first, window.last + 1)),
                Patch.insert("root", "outer"),
            ),
        )
    }

    private fun scrollOuterBy(px: Float) {
        rule.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, px) }
        rule.waitForIdle()
    }

    private fun feed() = rule.onNode(hasCollectionInfo(rowCount = 100))

    private fun y(text: String) = rule.onNodeWithText(text).positionInRoot().y

    @Test
    fun `padding stands in for the missing rows and the outer scroll reports`() {
        mount(total = 100, window = 0..9)

        // 10 rows + 90 rows of trailing padding at the measured 50dp.
        val feedTop = feed().positionInRoot().y
        assertEquals(100f, feedTop, 0.5f)
        assertEquals(5000, feed().fetchSemanticsNode().size.height)
        assertEquals(feedTop, y("row 0"), 0.5f)
        // Visible [0, 4) is covered by [0, 10): nothing reported yet.
        assertEquals(emptyList<Report>(), engine.reports)

        // Scroll 2000dp past the list's top (+100 header): rows [40, 46) on
        // screen. The scroll is animated, so it reports on the way there
        // (each frame the visible range leaves the window and changes); it
        // settles on visible [40, 46) + 6 rows of overscan.
        scrollOuterBy(2100f)
        assertEquals(Report("feed", 34, 52), engine.reports.last())
        val reports = engine.reports.size

        rule.apply(
            renderer,
            (0..9).map { Patch.remove("r$it") } +
                rows("fe", 34..51) +
                Patch.setProp("feed", VIRT_WINDOW_PROP, virtWindow(100, 34, 52)),
        )
        // Leading padding is 34 rows; total height unchanged.
        assertEquals(5000, feed().fetchSemanticsNode().size.height)
        assertEquals(feed().positionInRoot().y + 34 * 50f, y("row 34"), 0.5f)
        // Row 40 sits at the top of the scroller, where the padding showed it.
        rule.onNodeWithText("row 40").assertIsDisplayed()
        assertEquals(0f, y("row 40"), 0.5f)
        // Whole-list positions on the padded rows (no wrapper node).
        rule.onNodeWithText("row 40").assert(hasCollectionItemRow(40))
        rule.onNodeWithText("row 51").assert(hasCollectionItemRow(51))
        // Covered now: no further report.
        assertEquals(reports, engine.reports.size)
    }

    @Test
    fun `a window move keeps the first visible row where it was`() {
        // 100k rows: the padding is capped (MAX_PADDED_EXTENT_DP), so a
        // padded row is far thinner than a real one and moving the window
        // shifts the materialized rows unless the scroller is anchored.
        mount(total = 100_000, window = 0..9)
        rule.onNode(hasCollectionInfo(rowCount = 100_000)).assertExists()

        // Row 8 at the top of the scroller.
        scrollOuterBy(500f)
        val before = y("row 8")
        assertEquals(0f, before, 0.5f)

        // Rows 0..4 leave, 10..24 arrive: 5 thin pad rows replace 5 real ones above row 8.
        rule.apply(
            renderer,
            (0..4).map { Patch.remove("r$it") } +
                rows("fe", 10..24) +
                Patch.setProp("feed", VIRT_WINDOW_PROP, virtWindow(100_000, 5, 25)),
        )
        rule.onNodeWithText("row 8").assertIsDisplayed()
        assertEquals(before, y("row 8"), 1.5f)
        // It took anchoring: the scroller moved back by the ~247dp the rows
        // above row 8 lost (5 x 50dp rows -> 5 x ~0.6dp of padding).
        assertEquals(-253f, y("header"), 1.5f)
        rule.onNodeWithText("row 8").assert(hasCollectionItemRow(8))
    }
}
