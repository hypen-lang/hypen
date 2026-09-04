package space.hypen.renderer.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IconComponentTest {
    private val heart = mapOf(
        "d" to "M21 8.25c0-2.485-2.099-4.5-4.688-4.5",
        "fill" to "none",
        "stroke" to "currentColor",
        "strokeWidth" to 1.5,
        "strokeLinecap" to "round",
        "strokeLinejoin" to "round",
    )

    @Test
    fun `decoded list of maps resolves to path records`() {
        val paths = IconComponent.resolveIconPaths(listOf(heart))!!
        assertEquals(1, paths.size)
        assertEquals(heart["d"], paths[0].d)
        assertEquals(1.5f, paths[0].strokeWidth)
        assertEquals("round", paths[0].strokeLinecap)
    }

    @Test
    fun `json-encoded string is tolerated`() {
        val json = """[{"d":"M0 0L1 1","strokeWidth":"2"}]"""
        val paths = IconComponent.resolveIconPaths(json)!!
        assertEquals("M0 0L1 1", paths[0].d)
        assertEquals(2f, paths[0].strokeWidth)
        assertEquals("currentColor", paths[0].stroke)
    }

    @Test
    fun `missing, empty or malformed values resolve to null`() {
        assertNull(IconComponent.resolveIconPaths(null))
        assertNull(IconComponent.resolveIconPaths(emptyList<Any>()))
        assertNull(IconComponent.resolveIconPaths(listOf(mapOf("fill" to "none"))))
        assertNull(IconComponent.resolveIconPaths("not json"))
        assertNull(IconComponent.resolveIconPaths(42))
    }
}
