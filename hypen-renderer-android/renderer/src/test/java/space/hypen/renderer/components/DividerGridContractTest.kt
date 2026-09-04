package space.hypen.renderer.components

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test
import space.hypen.renderer.model.HypenElement

class DividerGridContractTest {
    private fun element(type: String, props: Map<String, Any?> = emptyMap()) =
        HypenElement(id = type, elementType = type, props = props)

    @Test
    fun `raw divider uses canonical color and thickness`() {
        val style = resolveDividerStyle(element("divider"))

        assertEquals(Color(0xFFE0E0E0), style.color)
        assertEquals(1f, style.thickness)
    }

    @Test
    fun `divider background and height control its stroke`() {
        val style = resolveDividerStyle(element("divider", mapOf(
            "backgroundColor.0" to "#3b82f6",
            "height.0" to 3,
            "thickness.0" to 8,
        )))

        assertEquals(Color(0xFF3B82F6), style.color)
        assertEquals(3f, style.thickness)
    }

    @Test
    fun `raw grid uses zero spacing and two columns`() {
        val style = resolveGridStyle(element("grid"))

        assertEquals(GridStyle(columns = 2, rowGap = 0f, columnGap = 0f), style)
    }

    @Test
    fun `grid preserves columns and directional gap overrides`() {
        val style = resolveGridStyle(element("grid", mapOf(
            "gridColumns.0" to 3,
            "gap.0" to 8,
            "rowGap.0" to 4,
        )))

        assertEquals(GridStyle(columns = 3, rowGap = 4f, columnGap = 8f), style)
    }

    @Test
    fun `bare grid image stretches but authored image sizing wins`() {
        assertEquals(false, element("image").hasExplicitImageSize())
        assertEquals(true, element("image", mapOf("width.0" to 64)).hasExplicitImageSize())
        assertEquals(true, element("image", mapOf("aspectRatio.0" to 1.5)).hasExplicitImageSize())
    }
}
