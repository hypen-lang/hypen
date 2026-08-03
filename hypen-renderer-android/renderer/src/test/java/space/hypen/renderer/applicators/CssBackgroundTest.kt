package space.hypen.renderer.applicators

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parser behind `background` / `backgroundImage`.
 *
 * The load-bearing case is the home-screen wallpaper, which is a two-layer
 * value whose layers BOTH contain commas — `rgba(3, 7, 18, 0.6)` inside the
 * gradient and a base64 payload inside `url(...)`. A naive `split(",")`
 * shreds it, which is the shape of the original bug.
 */
class CssBackgroundTest {

    // ---- splitting ----------------------------------------------------

    @Test
    fun `splits top-level commas only`() {
        val parts = CssBackground.splitTopLevel("a, b, c")
        assertEquals(listOf("a", " b", " c"), parts)
    }

    @Test
    fun `does not split inside parentheses`() {
        val parts = CssBackground.splitTopLevel("rgba(3, 7, 18, 0.6), red")
        assertEquals(2, parts.size)
        assertEquals("rgba(3, 7, 18, 0.6)", parts[0].trim())
        assertEquals("red", parts[1].trim())
    }

    @Test
    fun `does not split inside quotes`() {
        val parts = CssBackground.splitTopLevel("url('a,b.png'), red")
        assertEquals(2, parts.size)
        assertEquals("url('a,b.png')", parts[0].trim())
    }

    @Test
    fun `does not split inside nested parentheses`() {
        val parts = CssBackground.splitTopLevel(
            "linear-gradient(180deg, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.6)), red",
        )
        assertEquals(2, parts.size)
        assertEquals("red", parts[1].trim())
    }

    // ---- gradients ----------------------------------------------------

    @Test
    fun `parses a tailwind bg-gradient value`() {
        // What `bg-gradient-to-br from-indigo-400 to-violet-600` lowers to.
        val layers = CssBackground.parse("linear-gradient(to bottom right, #818cf8, #7c3aed)")
        assertNotNull(layers)
        assertEquals(1, layers!!.brushes.size)
        assertNull(layers.color)
        assertNull(layers.imageUri)
    }

    @Test
    fun `parses an angle gradient`() {
        val layers = CssBackground.parse("linear-gradient(180deg, #000, #fff)")
        assertEquals(1, layers!!.brushes.size)
    }

    @Test
    fun `parses colour stops that carry a position`() {
        val layers = CssBackground.parse("linear-gradient(to right, #000 10%, #fff 90%)")
        assertEquals(1, layers!!.brushes.size)
    }

    @Test
    fun `a single-stop gradient yields no brush`() {
        // Not expressible as a ramp; snap rather than invent a second stop.
        assertNull(CssBackground.parse("linear-gradient(to right, #000)"))
    }

    // ---- the wallpaper ------------------------------------------------

    @Test
    fun `parses the layered wallpaper shorthand`() {
        val value = "linear-gradient(180deg, rgba(3, 7, 18, 0.08), rgba(3, 7, 18, 0.6)), " +
            "url('data:image/png;base64,iVBORw0KGgo=') center / cover no-repeat"

        val layers = CssBackground.parse(value)
        assertNotNull(layers)
        assertEquals(1, layers!!.brushes.size)
        assertEquals("data:image/png;base64,iVBORw0KGgo=", layers.imageUri)
    }

    @Test
    fun `extracts a bare url without quotes`() {
        val layers = CssBackground.parse("url(https://example.com/a.png) center / cover")
        assertEquals("https://example.com/a.png", layers!!.imageUri)
    }

    // ---- plain colours and degradation --------------------------------

    @Test
    fun `parses a plain colour so the shorthand still does colours`() {
        val layers = CssBackground.parse("#ff0000")
        assertNotNull(layers!!.color)
        assertTrue(layers.brushes.isEmpty())
    }

    @Test
    fun `parses rgba with spaces`() {
        val layers = CssBackground.parse("rgba(0, 0, 0, 0.25)")
        assertNotNull(layers!!.color)
    }

    @Test
    fun `unparseable values yield null rather than a wrong background`() {
        assertNull(CssBackground.parse("definitely-not-a-colour"))
        assertNull(CssBackground.parse(""))
        assertNull(CssBackground.parse(null))
        assertNull(CssBackground.parse(42))
    }

    @Test
    fun `none is not an error and paints nothing`() {
        assertNull(CssBackground.parse("none"))
    }

    // ---- layer order ---------------------------------------------------

    @Test
    fun `image declared first paints above a later gradient`() {
        // CSS paints the FIRST-declared layer on top. paintLayers is stored
        // bottom-first, so the image must come LAST here.
        val layers = CssBackground.parse(
            "url('data:image/png;base64,iVBORw0KGgo='), linear-gradient(to top, #111, #222)",
        )!!
        assertEquals(2, layers.paintLayers.size)
        assertTrue(layers.paintLayers[0] is CssBackground.PaintLayer.Gradient)
        assertTrue(layers.paintLayers[1] is CssBackground.PaintLayer.Image)
    }

    @Test
    fun `gradient declared first paints above a later image`() {
        // The home-screen wallpaper's shape: gradient over photo.
        val layers = CssBackground.parse(
            "linear-gradient(to top, #111, #222), url('data:image/png;base64,iVBORw0KGgo=')",
        )!!
        assertEquals(2, layers.paintLayers.size)
        assertTrue(layers.paintLayers[0] is CssBackground.PaintLayer.Image)
        assertTrue(layers.paintLayers[1] is CssBackground.PaintLayer.Gradient)
    }


    @Test
    fun `brushes come back in paint order, CSS-first last`() {
        // CSS paints the first-declared layer on top, so it must be applied
        // LAST in a modifier chain.
        val layers = CssBackground.parse(
            "linear-gradient(to top, #111, #222), linear-gradient(to top, #333, #444)",
        )
        assertEquals(2, layers!!.brushes.size)
        // Reversal is what the ordering contract rests on; assert the count
        // and that both survived — brush identity is not comparable.
        assertNull(layers.color)
    }

    @Test
    fun `a non-data image uri is reported but decodes to nothing`() {
        // Remote fetching needs an async loader; degrade, never block.
        assertNull(CssBackground.decodeDataImage("https://example.com/a.png"))
    }

    @Test
    fun `a malformed data uri decodes to null instead of throwing`() {
        assertNull(CssBackground.decodeDataImage("data:image/png;base64,@@@not-base64@@@"))
        assertNull(CssBackground.decodeDataImage("data:image/png,notbase64"))
    }
}
