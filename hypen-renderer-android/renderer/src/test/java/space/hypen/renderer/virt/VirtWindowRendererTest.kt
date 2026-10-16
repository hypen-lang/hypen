package space.hypen.renderer.virt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import space.hypen.renderer.applicators.createDefaultApplicatorRegistry
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ComposeRenderer

/**
 * `__virt.window` through the patch pipeline: it lands with the batch's
 * structural patches, `removeProp` unwindows, and it is never a style.
 */
class VirtWindowRendererTest {
    private fun window(total: Int, start: Int, end: Int) =
        mapOf("total" to total.toDouble(), "start" to start.toDouble(), "end" to end.toDouble())

    @Test
    fun `the window lands with its rows and is withdrawn by removeProp`() {
        val renderer = ComposeRenderer()
        renderer.applyPatches(
            listOf(
                Patch.create("list", "List"),
                Patch.insert("root", "list"),
                Patch.create("r40", "Text", mapOf("0" to "row 40")),
                Patch.create("r41", "Text", mapOf("0" to "row 41")),
                Patch.insert("list", "r40"),
                Patch.insert("list", "r41"),
                Patch.setProp("list", VIRT_WINDOW_PROP, window(1000, 40, 42)),
            ),
        )
        val list = renderer.getElement("list")!!
        assertEquals(VirtWindow(1000, 40, 42), list.virtWindow())
        val slots = VirtSlots(list.virtWindow()!!, renderer.getChildren("list")) { it.id }
        assertEquals(1000, slots.count)
        assertEquals("r40", slots.key(40))
        assertEquals("r41", slots.key(41))
        assertEquals(39L, slots.key(39))

        // The window moves: rows leave as plain removes, new ones arrive.
        renderer.applyPatches(
            listOf(
                Patch.remove("r40"),
                Patch.create("r42", "Text", mapOf("0" to "row 42")),
                Patch.insert("list", "r42"),
                Patch.setProp("list", VIRT_WINDOW_PROP, window(1000, 41, 43)),
            ),
        )
        assertEquals(VirtWindow(1000, 41, 43), list.virtWindow())
        assertEquals(listOf("r41", "r42"), renderer.getChildren("list").map { it.id })

        renderer.applyPatches(listOf(Patch.removeProp("list", VIRT_WINDOW_PROP)))
        assertNull(list.virtWindow())
    }

    @Test
    fun `__virt window is not a style applicator`() {
        val registry = createDefaultApplicatorRegistry()
        assertFalse(registry.hasHandler("__virt"))
        assertFalse(registry.hasHandler(VIRT_WINDOW_PROP))
    }
}
