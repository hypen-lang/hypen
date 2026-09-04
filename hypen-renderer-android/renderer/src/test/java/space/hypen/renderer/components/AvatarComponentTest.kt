package space.hypen.renderer.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.HypenElement

class AvatarComponentTest {
    private fun avatar(props: Map<String, Any?> = emptyMap()): HypenElement =
        HypenElement(id = "avatar", elementType = "avatar", props = props)

    @Test
    fun `avatar defaults to 40 dp`() {
        val resolution = resolveAvatarSize(avatar())

        assertEquals(40f, resolution.sizeDp)
        assertFalse(resolution.hasExplicitDimensions)
    }

    @Test
    fun `explicit numeric and named sizes override the default`() {
        assertEquals(52f, resolveAvatarSize(avatar(mapOf("size" to 52))).sizeDp)
        assertEquals(32f, resolveAvatarSize(avatar(mapOf("size" to "small"))).sizeDp)
        assertEquals(48f, resolveAvatarSize(avatar(mapOf("size" to "medium"))).sizeDp)
        assertEquals(64f, resolveAvatarSize(avatar(mapOf("size" to "large"))).sizeDp)
    }

    @Test
    fun `explicit width and height remain owned by applicator modifier`() {
        val width = resolveAvatarSize(avatar(mapOf("width.0" to 56)))
        val height = resolveAvatarSize(avatar(mapOf("height.0" to 60)))
        val both = resolveAvatarSize(avatar(mapOf("width.0" to 56, "height.0" to 60)))

        assertTrue(width.hasExplicitDimensions)
        assertEquals(56f, width.sizeDp)
        assertTrue(height.hasExplicitDimensions)
        assertEquals(60f, height.sizeDp)
        assertTrue(both.hasExplicitDimensions)
        assertEquals(56f, both.sizeDp)
    }
}
