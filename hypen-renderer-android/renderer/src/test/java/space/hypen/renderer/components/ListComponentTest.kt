package space.hypen.renderer.components

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.HypenElement

class ListComponentTest {
    private fun list(props: Map<String, Any?> = emptyMap()) =
        HypenElement(id = "list", elementType = "list", props = props)

    @Test
    fun `static List fills finite width and wraps content height`() {
        val layout = resolveListLayout(list())

        assertTrue(layout.fillsFiniteWidth)
        assertFalse(layout.scrollsVertically)
    }

    @Test
    fun `bounded and explicitly scrolling Lists retain virtualization`() {
        assertTrue(resolveListLayout(list(mapOf("height.0" to 120))).scrollsVertically)
        assertTrue(resolveListLayout(list(mapOf("overflow.0" to "auto"))).scrollsVertically)
        assertTrue(resolveListLayout(list(), hasDynamicItems = true).scrollsVertically)
    }

    @Test
    fun `hidden overflow keeps a static List non scrolling`() {
        assertFalse(resolveListLayout(list(mapOf("overflow.0" to "hidden"))).scrollsVertically)
    }
}
