package space.hypen.renderer

import space.hypen.renderer.model.HypenElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Tests for the list/map prop parsing helpers on [HypenElement]
 * (used by the Video component for `playlist` and `headers`).
 */
class HypenElementPropsTest {
    private fun element(props: Map<String, Any?>): HypenElement =
        HypenElement(id = "e1", elementType = "video", props = props)

    // ── getStringListProp ──────────────────────────────────────────────────

    @Test
    fun `string list prop with bare name`() {
        val el = element(mapOf("playlist" to listOf("https://cdn/ep1.mp4", "https://cdn/ep2.mp4")))

        assertEquals(
            listOf("https://cdn/ep1.mp4", "https://cdn/ep2.mp4"),
            el.getStringListProp("playlist"),
        )
    }

    @Test
    fun `string list prop with dot-zero suffix variant`() {
        val el = element(mapOf("playlist.0" to listOf("a.mp4", "b.mp4")))

        assertEquals(listOf("a.mp4", "b.mp4"), el.getStringListProp("playlist"))
    }

    @Test
    fun `bare name wins over dot-zero variant`() {
        val el = element(
            mapOf(
                "playlist" to listOf("bare.mp4"),
                "playlist.0" to listOf("suffixed.mp4"),
            ),
        )

        assertEquals(listOf("bare.mp4"), el.getStringListProp("playlist"))
    }

    @Test
    fun `string list prop drops nulls and stringifies non-strings`() {
        val el = element(mapOf("playlist" to listOf("a.mp4", null, 42)))

        assertEquals(listOf("a.mp4", "42"), el.getStringListProp("playlist"))
    }

    @Test
    fun `empty list prop returns empty list not null`() {
        val el = element(mapOf("playlist" to emptyList<String>()))

        assertEquals(emptyList<String>(), el.getStringListProp("playlist"))
    }

    @Test
    fun `absent list prop returns null`() {
        val el = element(emptyMap())

        assertNull(el.getStringListProp("playlist"))
    }

    @Test
    fun `non-list value returns null`() {
        val el = element(mapOf("playlist" to "not-a-list"))

        assertNull(el.getStringListProp("playlist"))
    }

    // ── getStringMapProp ───────────────────────────────────────────────────

    @Test
    fun `string map prop with bare name`() {
        val el = element(
            mapOf("headers" to mapOf("Authorization" to "Bearer abc", "X-Trace" to "1")),
        )

        assertEquals(
            mapOf("Authorization" to "Bearer abc", "X-Trace" to "1"),
            el.getStringMapProp("headers"),
        )
    }

    @Test
    fun `string map prop with dot-zero suffix variant`() {
        val el = element(mapOf("headers.0" to mapOf("Authorization" to "Bearer xyz")))

        assertEquals(mapOf("Authorization" to "Bearer xyz"), el.getStringMapProp("headers"))
    }

    @Test
    fun `string map prop drops null values and stringifies non-strings`() {
        val el = element(
            mapOf("headers" to mapOf("A" to null, "B" to 7, "C" to "c")),
        )

        assertEquals(mapOf("B" to "7", "C" to "c"), el.getStringMapProp("headers"))
    }

    @Test
    fun `absent map prop returns null`() {
        val el = element(emptyMap())

        assertNull(el.getStringMapProp("headers"))
    }

    @Test
    fun `non-map value returns null`() {
        val el = element(mapOf("headers" to listOf("nope")))

        assertNull(el.getStringMapProp("headers"))
    }
}
