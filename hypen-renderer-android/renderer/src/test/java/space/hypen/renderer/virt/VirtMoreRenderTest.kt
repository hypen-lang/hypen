package space.hypen.renderer.virt

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
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
import androidx.compose.ui.test.performTouchInput
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
import space.hypen.renderer.render.ActionDispatcher
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.setHypenContent
import space.hypen.renderer.virtWindow

/**
 * Multi-node item templates (§1 grouping), horizontal padded anchoring, and a
 * sortable inside a windowed list, all rendered. Density 1.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h800dp-mdpi")
class VirtMoreRenderTest {
    @get:Rule
    val rule = createComposeRule()

    private val renderer = ComposeRenderer()
    private val engine = FakeViewportEngine().also { it.attach(renderer) }

    /** Item i as two nodes: "title i" and "sub i", 30dp each (60dp per item). */
    private fun twoNode(parentId: String, range: IntRange): List<Patch> =
        range.flatMap { i ->
            listOf(
                Patch.create("t$i", "Text", mapOf("0" to "title $i", "height.0" to 30.0)),
                Patch.create("s$i", "Text", mapOf("0" to "sub $i", "height.0" to 30.0)),
            )
        } + range.flatMap { i -> listOf(Patch.insert(parentId, "t$i"), Patch.insert(parentId, "s$i")) }

    @Test
    fun `multi-node items group into one lazy slot each`() {
        rule.setHypenContent(renderer)
        rule.apply(
            renderer,
            listOf(Patch.create("list", "List", mapOf("height.0" to 300.0))) + twoNode("list", 0..4) + listOf(
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(100, 0, 5)),
                Patch.insert("root", "list"),
            ),
        )
        rule.onNode(hasCollectionInfo(rowCount = 100)).assertExists()
        // Both nodes of item 3 sit in slot 3 (one CollectionItemInfo), stacked.
        rule.onNode(hasCollectionItemRow(3))
            .assert(hasAnyDescendant(hasText("title 3")))
            .assert(hasAnyDescendant(hasText("sub 3")))
        assertEquals(3 * 60f + 30f, rule.onNodeWithText("sub 3").positionInRoot().y, 0.5f)

        // Slots measure 60dp: 5 slots fill 300dp, so slot 50 shows [50, 55).
        rule.onNode(hasScrollToIndexAction()).performScrollToIndex(50)
        rule.waitForIdle()
        assertEquals(Report("list", 45, 60), engine.reports.last())
    }

    @Test
    fun `multi-node items on the padded path map each node to its item`() {
        rule.setHypenContent(renderer)
        rule.apply(
            renderer,
            listOf(
                Patch.create("outer", "Column", mapOf("scrollable.0" to true, "height.0" to 300.0)),
                Patch.create("list", "Column"),
                Patch.insert("outer", "list"),
            ) + twoNode("list", 0..4) + listOf(
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(100, 0, 5)),
                Patch.insert("root", "outer"),
            ),
        )
        rule.onNodeWithText("title 3").assert(hasCollectionItemRow(3))
        rule.onNodeWithText("sub 3").assert(hasCollectionItemRow(3))
        // Padding counts items at their measured 60dp: 95 items after the window.
        assertEquals(6000, rule.onNode(hasCollectionInfo(rowCount = 100)).fetchSemanticsNode().size.height)

        // 2000dp in: items [33, 39) visible, widened by 6 each side.
        rule.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 2000f) }
        rule.waitForIdle()
        assertEquals(Report("list", 27, 45), engine.reports.last())
    }

    @Test
    fun `horizontal padded list anchors the first visible item`() {
        rule.setHypenContent(renderer)
        val items = { range: IntRange ->
            range.map { Patch.create("r$it", "Text", mapOf("0" to "row $it", "width.0" to 50.0)) } +
                range.map { Patch.insert("list", "r$it") }
        }
        rule.apply(
            renderer,
            listOf(
                Patch.create("outer", "Row", mapOf("scrollable.0" to true, "width.0" to 300.0)),
                Patch.create("header", "Text", mapOf("0" to "header", "width.0" to 100.0)),
                Patch.create("list", "Row"),
                Patch.insert("outer", "header"),
                Patch.insert("outer", "list"),
            ) + items(0..9) + listOf(
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(100_000, 0, 10)),
                Patch.insert("root", "outer"),
            ),
        )
        rule.onNode(hasCollectionInfo(rowCount = 1, columnCount = 100_000)).assertExists()
        rule.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(500f, 0f) }
        rule.waitForIdle()
        val before = rule.onNodeWithText("row 8").positionInRoot().x
        assertEquals(0f, before, 0.5f)

        rule.apply(
            renderer,
            (0..4).map { Patch.remove("r$it") } + items(10..24) +
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(100_000, 5, 25)),
        )
        rule.onNodeWithText("row 8").assertIsDisplayed()
        assertEquals(before, rule.onNodeWithText("row 8").positionInRoot().x, 1.5f)
        rule.onNodeWithText("row 8").assert(
            androidx.compose.ui.test.SemanticsMatcher("column 8") {
                it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.CollectionItemInfo)?.columnIndex == 8
            },
        )
    }

    @Test
    fun `sortable in a windowed list reorders by whole-list index`() {
        val dispatched = mutableListOf<Pair<String, Map<String, Any?>?>>()
        renderer.setActionDispatcher(
            ActionDispatcher { action, payload ->
                @Suppress("UNCHECKED_CAST")
                dispatched += if (action == "__hypen_dispatch") {
                    (payload!!["action"] as String) to (payload["payload"] as Map<String, Any?>)
                } else {
                    action to payload
                }
            },
        )
        rule.setHypenContent(renderer)
        val rows = (40..42).flatMap { i ->
            listOf(
                Patch.create("r$i", "Row"),
                Patch.create(
                    "t$i", "Text",
                    mapOf(
                        "0" to "task $i",
                        "height.0" to 50.0,
                        "__dnd.key" to "k$i",
                        "__dnd.source" to mapOf("group" to null, "handle" to false, "activation" to "immediate"),
                    ),
                ),
            )
        } + (40..42).flatMap { i -> listOf(Patch.insert("list", "r$i"), Patch.insert("r$i", "t$i")) }
        rule.apply(
            renderer,
            listOf(
                Patch.create(
                    "list", "List",
                    mapOf(
                        "height.0" to 300.0,
                        "__dnd.sort" to mapOf("group" to null, "axis" to "y"),
                        "bind" to "tasks",
                        "onSort.0" to "@reorder",
                    ),
                ),
            ) + rows + listOf(
                Patch.setProp("list", VIRT_WINDOW_PROP, virtWindow(100, 40, 43)),
                Patch.insert("root", "list"),
            ),
        )
        rule.onNode(hasScrollToIndexAction()).performScrollToIndex(40)
        rule.waitForIdle()
        rule.onNodeWithText("task 40").assertIsDisplayed()

        // Drag the window's first row (item 40) down past the second's middle.
        rule.onNodeWithText("task 40").performTouchInput {
            down(center)
            repeat(6) { moveBy(Offset(0f, 10f)) }
            up()
        }
        rule.waitForIdle()

        val reorder = dispatched.first { it.first == "__hypen_reorder" }.second
        assertEquals(mapOf("path" to "tasks", "from" to 40, "to" to 41), reorder)
        val sort = dispatched.first { it.first == "reorder" }.second!!
        assertEquals(mapOf("zone" to "list", "index" to 40), sort["from"])
        assertEquals(mapOf("zone" to "list", "index" to 41), sort["to"])
    }
}
