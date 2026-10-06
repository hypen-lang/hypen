package space.hypen.renderer.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.HypenElement

class BadgeComponentTest {
    private fun badge(props: Map<String, Any?> = emptyMap()): HypenElement =
        HypenElement(id = "badge", elementType = "badge", props = props)

    @Test
    fun `raw badge uses canonical defaults`() {
        val style = resolveBadgeStyle(badge())

        assertEquals(Color(0xFFE0E0E0), style.componentBackgroundColor)
        assertEquals(Color(0xFF333333), style.textColor)
        assertEquals(4f, style.cornerRadiusDp)
        assertTrue(style.appliesComponentCornerRadius)
        assertTrue(style.appliesDefaultPadding)
        assertEquals(12f, style.fontSizeSp)
        assertEquals(FontWeight.W600, style.fontWeight)
    }

    @Test
    fun `custom padding replaces rather than adds to default`() {
        val all = resolveBadgeStyle(badge(mapOf("padding.0" to 2)))
        val directional = resolveBadgeStyle(badge(mapOf("paddingHorizontal.0" to 6)))

        assertFalse(all.appliesDefaultPadding)
        assertFalse(directional.appliesDefaultPadding)
    }

    @Test
    fun `explicit twenty dp count badge has no implicit padding`() {
        val countBadge = badge(mapOf(
            "width.0" to 20,
            "height.0" to 20,
            "horizontalAlignment.0" to "center",
            "verticalAlignment.0" to "center",
        ))
        val style = resolveBadgeStyle(countBadge)

        assertFalse(style.appliesDefaultPadding)

        // A representative 6x14 text child must be placed in the middle of
        // the fixed 20x20 border box: (20-6)/2, (20-14)/2 = (7, 3).
        val childOffset = resolveBadgeContentAlignment(countBadge).align(
            size = IntSize(width = 6, height = 14),
            space = IntSize(width = 20, height = 20),
            layoutDirection = LayoutDirection.Ltr,
        )
        assertEquals(7, childOffset.x)
        assertEquals(3, childOffset.y)
    }

    @Test
    fun `badge content alignment accepts css aliases`() {
        val cssBadge = badge(mapOf(
            "justifyContent.0" to "flex-end",
            "alignItems.0" to "center",
        ))

        val childOffset = resolveBadgeContentAlignment(cssBadge).align(
            size = IntSize(width = 6, height = 14),
            space = IntSize(width = 20, height = 20),
            layoutDirection = LayoutDirection.Ltr,
        )
        assertEquals(14, childOffset.x)
        assertEquals(3, childOffset.y)
    }

    @Test
    fun `custom visuals win over component defaults`() {
        val style = resolveBadgeStyle(badge(mapOf(
            "backgroundColor.0" to "#3b82f6",
            "color.0" to "#ffffff",
            "cornerRadius.0" to 0,
            "fontSize.0" to 14,
            "fontWeight.0" to "500",
        )))

        // Generic applicators own explicit background/radius, so the Badge
        // component does not append a conflicting default layer or clip.
        assertNull(style.componentBackgroundColor)
        assertFalse(style.appliesComponentCornerRadius)
        assertEquals(Color.White, style.textColor)
        assertEquals(14f, style.fontSizeSp)
        assertEquals(FontWeight.W500, style.fontWeight)
    }
}
