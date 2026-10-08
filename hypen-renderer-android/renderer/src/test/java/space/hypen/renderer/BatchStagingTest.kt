package space.hypen.renderer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.ChildOrder
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ComposeRenderer

/**
 * A patch batch stages every element's prop and child-list writes and
 * publishes each element once at the end of the batch: one props map copy
 * and one revision bump per touched node, one child-list write per touched
 * parent, whatever the batch did to them.
 */
class BatchStagingTest {
    private fun mountList(renderer: ComposeRenderer, rows: Int): List<String> {
        val ids = (0 until rows).map { "row$it" }
        val patches = mutableListOf(
            Patch.create("list", "list"),
            Patch.insert("root", "list"),
        )
        for (id in ids) {
            patches += Patch.create(id, "text", mapOf("0" to id, "color" to "#000"))
            patches += Patch.insert("list", id)
        }
        renderer.applyPatches(patches)
        return ids
    }

    @Test
    fun `many prop writes on one node commit as one map and one revision bump`() {
        val renderer = ComposeRenderer()
        mountList(renderer, 1)
        val row = renderer.getElement("row0")!!
        val revisionBefore = row.propsRevision

        renderer.applyPatches(
            (1..20).map { Patch.setProp("row0", "style$it", it) } +
                Patch.setProp("row0", "color", "#fff") +
                Patch.removeProp("row0", "style3"),
        )

        assertEquals("#fff", row.props["color"])
        assertEquals(20, row.props["style20"])
        assertFalse(row.props.containsKey("style3"))
        assertEquals(revisionBefore + 1, row.propsRevision)
        assertFalse(row.isStagingProps)
    }

    @Test
    fun `a dense reorder lands as one child list write in the right order`() {
        val renderer = ComposeRenderer()
        val ids = mountList(renderer, 50)
        val list = renderer.getElement("list")!!
        assertEquals(ids, list.children.toList())

        // Reverse the list with one move per row: each row moves in front
        // of the row that was moved before it, so the head keeps changing.
        val reversed = ids.reversed()
        val moves = (1 until ids.size).map { k -> Patch.move("list", ids[k], beforeId = ids[k - 1]) }
        renderer.applyPatches(moves)

        assertEquals(reversed, list.children.toList())
        assertEquals(reversed, list.childIds)
    }

    @Test
    fun `a remove after an insert in the same batch sees the staged child list`() {
        val renderer = ComposeRenderer()
        mountList(renderer, 2)
        val list = renderer.getElement("list")!!

        renderer.applyPatches(
            listOf(
                Patch.create("row2", "text", mapOf("0" to "row2")),
                Patch.insert("list", "row2", beforeId = "row0"),
                Patch.remove("row1"),
            ),
        )

        assertEquals(listOf("row2", "row0"), list.children.toList())
        assertEquals(listOf("row2", "row0"), list.childIds)
        assertEquals(null, renderer.getElement("row1"))
    }

    @Test
    fun `a single insert is replayed as a single list write`() {
        val renderer = ComposeRenderer()
        mountList(renderer, 3)
        val list = renderer.getElement("list")!!
        renderer.applyPatches(
            listOf(
                Patch.create("rowX", "text", mapOf("0" to "x")),
                Patch.insert("list", "rowX", beforeId = "row1"),
            ),
        )
        assertEquals(listOf("row0", "rowX", "row1", "row2"), list.children.toList())
    }

    @Test
    fun `child order is a linked order with O(1) operations`() {
        val order = ChildOrder(listOf("a", "b", "c"))
        order.insertBefore("x", "b")
        assertEquals(listOf("a", "x", "b", "c"), order.toList())
        order.insertBefore("c", "a") // move an existing id to the front
        assertEquals(listOf("c", "a", "x", "b"), order.toList())
        assertTrue(order.remove("x"))
        assertFalse(order.remove("x"))
        order.append("a") // re-append moves to the end
        assertEquals(listOf("c", "b", "a"), order.toList())
        order.insertBefore("q", "missing") // unknown anchor appends
        assertEquals(listOf("c", "b", "a", "q"), order.toList())
        order.clear()
        assertEquals(emptyList<String>(), order.toList())
        assertEquals(0, order.size)
    }

    @Test
    fun `an element outside a batch still publishes prop writes immediately`() {
        val element = HypenElement(id = "e", elementType = "text", props = mapOf("a" to 1))
        val before = element.propsRevision
        element.setProp("b", 2)
        assertEquals(2, element.props["b"])
        assertFalse(element.isStagingProps)
        assertEquals(before, element.propsRevision) // the renderer bumps it, not the model
    }
}
