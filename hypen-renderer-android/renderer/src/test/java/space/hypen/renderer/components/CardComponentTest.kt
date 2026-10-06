package space.hypen.renderer.components

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test
import space.hypen.renderer.model.HypenElement

class CardComponentTest {
    private fun card(props: Map<String, Any?> = emptyMap()) =
        HypenElement(id = "card", elementType = "card", props = props)

    @Test
    fun `raw card owns one set of canonical defaults`() {
        val style = resolveCardStyle(card())
        assertEquals(16f, style.padding.start.value)
        assertEquals(16f, style.padding.top.value)
        assertEquals(8f, style.corners.topStart.value)
        assertEquals(Color.White, style.backgroundColor)
        assertEquals(2f, style.componentElevation.value)
    }

    @Test
    fun `author padding replaces rather than adds to default`() {
        val all = resolveCardStyle(card(mapOf("padding.0" to 20)))
        assertEquals(20f, all.padding.start.value)
        assertEquals(20f, all.padding.top.value)

        val directional = resolveCardStyle(card(mapOf(
            "padding.0" to 12,
            "paddingHorizontal.0" to 24,
            "paddingBottom.0" to 6,
        )))
        assertEquals(24f, directional.padding.start.value)
        assertEquals(12f, directional.padding.top.value)
        assertEquals(24f, directional.padding.end.value)
        assertEquals(6f, directional.padding.bottom.value)
    }

    @Test
    fun `author surface values win and explicit shadow is not doubled`() {
        val style = resolveCardStyle(card(mapOf(
            "backgroundColor.0" to "#eff6ff",
            "cornerRadius.0" to 12,
            "shadow.0" to mapOf("blur" to 8),
        )))
        assertEquals(Color(0xFFEFF6FF), style.backgroundColor)
        assertEquals(12f, style.corners.topStart.value)
        assertEquals(0f, style.componentElevation.value)
    }
}
