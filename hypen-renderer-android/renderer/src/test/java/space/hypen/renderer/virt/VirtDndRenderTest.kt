package space.hypen.renderer.virt

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import org.junit.Assert.assertEquals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import space.hypen.renderer.apply
import space.hypen.renderer.dnd.DND_REORDER_ACTION
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ActionDispatcher
import space.hypen.renderer.scopedRenderer
import space.hypen.renderer.setHypenContent
import space.hypen.renderer.virtWindow

/**
 * Drag and drop inside windowed (padded) containers, rendered and driven by
 * touch: what the runtime writes must name whole-list indices, not
 * window-relative ones. Density 1.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h800dp-mdpi")
class VirtDndRenderTest {
    @get:Rule
    val rule = createComposeRule()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val renderer = scopedRenderer(scope)

    @After
    fun cancelRuntimeTimers() = scope.cancel()
    private val dispatched = mutableListOf<Pair<String, Map<String, Any?>?>>()

    init {
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
    }

    private fun source(key: String) = mapOf(
        "__dnd.key" to key,
        "__dnd.source" to mapOf("group" to null, "handle" to false, "activation" to "immediate"),
    )

    private fun drag(text: String, by: Offset) {
        rule.onNodeWithText(text).performTouchInput {
            down(center)
            repeat(10) { moveBy(by / 10f) }
            up()
        }
        rule.waitForIdle()
    }

    @Test
    fun `bound pinboard in a windowed Stack writes the whole-list path`() {
        rule.setHypenContent(renderer)
        val notes = (2..3).flatMap { i ->
            listOf(
                Patch.create(
                    "n$i", "Text",
                    mapOf("0" to "note $i", "width.0" to 50.0, "height.0" to 50.0, "translateX.0" to null, "translateY.0" to null) +
                        source("n$i"),
                ),
                Patch.insert("board", "n$i"),
            )
        }
        rule.apply(
            renderer,
            listOf(
                Patch.create(
                    "board", "Stack",
                    mapOf(
                        "__dnd.pin" to mapOf("group" to null, "xKey" to "x", "yKey" to "y", "grid" to null, "bounds" to "clamp", "units" to "px"),
                        "bind" to "seats",
                        "width.0" to 300.0,
                    ),
                ),
            ) + notes + listOf(
                Patch.setProp("board", VIRT_WINDOW_PROP, virtWindow(10, 2, 4)),
                Patch.insert("root", "board"),
            ),
        )
        rule.onNodeWithText("note 3").assertIsDisplayed()

        drag("note 3", Offset(40f, 20f))

        val pin = dispatched.first().second!!
        // Item 3 of the whole list, the window's second child.
        assertEquals("seats.3", pin["path"])
    }

    @Test
    fun `cross-list drop between windowed sortables names whole-list indices`() {
        rule.setHypenContent(renderer)
        fun list(id: String, onSort: String) = Patch.create(
            id, "Column",
            mapOf(
                "__dnd.sort" to mapOf("group" to "board", "axis" to "y"),
                "bind" to id,
                "onSort.0" to onSort,
                "width.0" to 150.0,
            ),
        )
        fun row(listId: String, key: String) = listOf(
            Patch.create("$listId-row-$key", "Row"),
            Patch.create("$listId-text-$key", "Text", mapOf("0" to "task $key", "width.0" to 150.0, "height.0" to 50.0) + source(key)),
            Patch.insert(listId, "$listId-row-$key"),
            Patch.insert("$listId-row-$key", "$listId-text-$key"),
        )
        rule.apply(
            renderer,
            listOf(
                Patch.create("lanes", "Row"),
                list("todo", "@persist"),
                list("doing", "@persistDoing"),
                Patch.insert("lanes", "todo"),
                Patch.insert("lanes", "doing"),
            ) + row("todo", "a") + row("todo", "b") + row("doing", "c") + listOf(
                // todo shows items [2, 4) of 4; doing item [5, 6) of 6.
                Patch.setProp("todo", VIRT_WINDOW_PROP, virtWindow(4, 2, 4)),
                Patch.setProp("doing", VIRT_WINDOW_PROP, virtWindow(6, 5, 6)),
                Patch.insert("root", "lanes"),
            ),
        )
        rule.onNodeWithText("task a").assertIsDisplayed()
        rule.onNodeWithText("task c").assertIsDisplayed()

        // a (todo item 2, at y 100..150) to below c (doing item 5, y 250..300): append.
        drag("task a", Offset(150f, 165f))

        val reorder = dispatched.first { it.first == DND_REORDER_ACTION }.second
        assertEquals(mapOf("fromPath" to "todo", "from" to 2, "toPath" to "doing", "to" to 6), reorder)
        val sort = dispatched.first { it.first == "persistDoing" }.second!!
        assertEquals(mapOf("zone" to "board", "index" to 2), sort["from"])
        assertEquals(mapOf("zone" to "board", "index" to 6), sort["to"])
    }
}
