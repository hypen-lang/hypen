package space.hypen.renderer

import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ActionDispatcher
import space.hypen.renderer.render.ComposeRenderer
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class ComposeRendererTest {
    private lateinit var renderer: ComposeRenderer
    private val dispatchedActions = mutableListOf<Pair<String, Map<String, Any?>?>>()

    @Before
    fun setup() {
        renderer = ComposeRenderer()
        dispatchedActions.clear()
        renderer.setActionDispatcher(
            ActionDispatcher { action, payload ->
                dispatchedActions.add(action to payload)
            },
        )
    }

    @Test
    fun `create element adds to tree`() {
        val patches =
            listOf(
                Patch.create("1", "column"),
                Patch.insert("root", "1"),
            )

        renderer.applyPatches(patches)

        val element = renderer.getElement("1")
        assertNotNull(element)
        assertEquals("column", element?.elementType)
        assertEquals("1", renderer.getRootId())
    }

    @Test
    fun `create nested elements`() {
        val patches =
            listOf(
                Patch.create("1", "column"),
                Patch.create("2", "text", mapOf("0" to "Hello")),
                Patch.create("3", "text", mapOf("0" to "World")),
                Patch.insert("root", "1"),
                Patch.insert("1", "2"),
                Patch.insert("1", "3"),
            )

        renderer.applyPatches(patches)

        val parent = renderer.getElement("1")
        assertNotNull(parent)
        assertEquals(2, parent?.children?.size)
        assertTrue(parent?.children?.contains("2") == true)
        assertTrue(parent?.children?.contains("3") == true)

        val children = renderer.getChildren("1")
        assertEquals(2, children.size)
        assertEquals("Hello", children[0].textContent ?: children[0].props["0"])
        assertEquals("World", children[1].textContent ?: children[1].props["0"])
    }

    @Test
    fun `setProp updates element`() {
        val patches =
            listOf(
                Patch.create("1", "text", mapOf("0" to "Initial")),
                Patch.insert("root", "1"),
                Patch.setProp("1", "0", "Updated"),
            )

        renderer.applyPatches(patches)

        val element = renderer.getElement("1")
        assertEquals("Updated", element?.textContent)
    }

    @Test
    fun `setText updates text content`() {
        val patches =
            listOf(
                Patch.create("1", "text"),
                Patch.insert("root", "1"),
                Patch.setText("1", "New text content"),
            )

        renderer.applyPatches(patches)

        val element = renderer.getElement("1")
        assertEquals("New text content", element?.textContent)
    }

    @Test
    fun `remove element from tree`() {
        val patches =
            listOf(
                Patch.create("1", "column"),
                Patch.create("2", "text"),
                Patch.insert("root", "1"),
                Patch.insert("1", "2"),
            )

        renderer.applyPatches(patches)
        assertEquals(1, renderer.getElement("1")?.children?.size)

        renderer.applyPatches(listOf(Patch.remove("2")))

        assertNull(renderer.getElement("2"))
        assertEquals(0, renderer.getElement("1")?.children?.size)
    }

    @Test
    fun `move element between parents`() {
        val patches =
            listOf(
                Patch.create("1", "column"),
                Patch.create("2", "column"),
                Patch.create("3", "text"),
                Patch.insert("root", "1"),
                Patch.insert("root", "2"),
                Patch.insert("1", "3"),
            )

        renderer.applyPatches(patches)
        assertEquals(1, renderer.getElement("1")?.children?.size)
        assertEquals(0, renderer.getElement("2")?.children?.size)

        // Move element 3 from column 1 to column 2
        renderer.applyPatches(listOf(Patch.move("2", "3")))

        assertEquals(0, renderer.getElement("1")?.children?.size)
        assertEquals(1, renderer.getElement("2")?.children?.size)
        assertEquals("2", renderer.getElement("3")?.parentId)
    }

    @Test
    fun `insert with beforeId maintains order`() {
        val patches =
            listOf(
                Patch.create("1", "column"),
                Patch.create("2", "text", mapOf("0" to "First")),
                Patch.create("3", "text", mapOf("0" to "Third")),
                Patch.insert("root", "1"),
                Patch.insert("1", "2"),
                Patch.insert("1", "3"),
            )

        renderer.applyPatches(patches)

        // Insert new element before "3"
        renderer.applyPatches(
            listOf(
                Patch.create("4", "text", mapOf("0" to "Second")),
                Patch.insert("1", "4", "3"),
            ),
        )

        val parent = renderer.getElement("1")
        assertEquals(listOf("2", "4", "3"), parent?.children)
    }

    @Test
    fun `clear removes all elements`() {
        val patches =
            listOf(
                Patch.create("1", "column"),
                Patch.create("2", "text"),
                Patch.insert("root", "1"),
                Patch.insert("1", "2"),
            )

        renderer.applyPatches(patches)
        assertNotNull(renderer.getElement("1"))
        assertNotNull(renderer.getElement("2"))

        renderer.clear()

        assertNull(renderer.getElement("1"))
        assertNull(renderer.getElement("2"))
        assertNull(renderer.getRootId())
    }

    @Test
    fun `dispatchAction calls dispatcher`() {
        renderer.dispatchAction("increment", mapOf("amount" to 5))

        assertEquals(1, dispatchedActions.size)
        assertEquals("increment", dispatchedActions[0].first)
        assertEquals(mapOf("amount" to 5), dispatchedActions[0].second)
    }

    @Test
    fun `tree version increments on patch`() {
        val initialVersion = renderer.treeVersion.value

        renderer.applyPatches(
            listOf(
                Patch.create("1", "text"),
                Patch.insert("root", "1"),
            ),
        )

        assertEquals(initialVersion + 1, renderer.treeVersion.value)
    }

    @Test
    fun `element props are accessible`() {
        val patches =
            listOf(
                Patch.create(
                    "1",
                    "button",
                    mapOf(
                        "onClick" to "@actions.submit",
                        "padding" to 16,
                        "enabled" to true,
                    ),
                ),
                Patch.insert("root", "1"),
            )

        renderer.applyPatches(patches)

        val element = renderer.getElement("1")
        assertEquals("@actions.submit", element?.getStringProp("onClick"))
        assertEquals(16, element?.getIntProp("padding"))
        assertEquals(true, element?.getBoolProp("enabled"))
    }
}
