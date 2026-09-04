package space.hypen.renderer.components

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import space.hypen.renderer.model.HypenElement

/**
 * `.foregroundColor(...)` used to be a registered no-op: the applicator
 * returned the modifier unchanged and nothing else read the prop, so only
 * Badge ever honoured it. It now resolves alongside `.color(...)` into the
 * `LocalContentColor` the containers provide around their children.
 */
class ContentColorTest {
    private fun element(props: Map<String, Any?>): HypenElement =
        HypenElement(id = "1", elementType = "Box", props = props)

    @Test
    fun `foregroundColor becomes the inherited content color`() {
        assertEquals(
            Color.White,
            hypenContentColor(element(mapOf("foregroundColor.0" to "#ffffff"))),
        )
        assertEquals(
            Color.White,
            hypenContentColor(element(mapOf("foregroundColor" to "white"))),
        )
    }

    @Test
    fun `color is canonical and outranks foregroundColor, as on every renderer`() {
        assertEquals(
            Color.Blue,
            hypenContentColor(element(mapOf("color.0" to "blue", "foregroundColor.0" to "red"))),
        )
    }

    @Test
    fun `the color applicator keeps working on its own`() {
        assertEquals(
            Color(0xFF3B82F6),
            hypenContentColor(element(mapOf("color.0" to "#3b82f6"))),
        )
        // Stack's helper is the same resolution, so its contract is unchanged.
        assertEquals(
            Color(0xFF3B82F6),
            stackContentColor(element(mapOf("color.0" to "#3b82f6"))),
        )
    }

    @Test
    fun `an absent or unparseable value leaves the inherited color alone`() {
        assertNull(hypenContentColor(element(emptyMap())))
        assertNull(hypenContentColor(element(mapOf("foregroundColor.0" to "not-a-color"))))
    }
}
