package space.hypen.renderer.components

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import space.hypen.renderer.model.HypenElement

class StackComponentTest {
    private fun stack(props: Map<String, Any?> = emptyMap()): HypenElement =
        HypenElement(id = "stack", elementType = "stack", props = props)

    @Test
    fun `stack exposes its color applicator to child content`() {
        assertEquals(
            Color.White,
            stackContentColor(stack(mapOf("color.0" to "#ffffff"))),
        )
    }

    @Test
    fun `stack without a valid color preserves the inherited content color`() {
        assertNull(stackContentColor(stack()))
        assertNull(stackContentColor(stack(mapOf("color.0" to "not-a-color"))))
    }

    @Test
    fun `stack accepts an unindexed color property`() {
        assertEquals(
            Color(0xFF3B82F6),
            stackContentColor(stack(mapOf("color" to "#3b82f6"))),
        )
    }
}
