package space.hypen.renderer.applicators

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Modifier ordering rules that are load-bearing for layout correctness.
 *
 * Compose applies a modifier chain outer→inner, so "runs earlier" means
 * "constrains from further out". Getting these bands wrong produces silent
 * layout bugs rather than errors, which is why they're pinned here.
 */
class ApplicatorPriorityTest {

    private fun order(name: String) = ApplicatorPriorityMap.getPriority(name).order

    @Test
    fun `max bounds run before width and height`() {
        // CSS `max-width` always beats `width`. In Compose that requires the
        // cap OUTSIDE the fill — `widthIn(max).fillMaxWidth()`. Reversed,
        // `fillMaxWidth()` pins min = max and the inner cap is coerced away,
        // which is what made the home-screen launcher ignore max-w-[250px].
        assertTrue(order("maxwidth") < order("width"))
        assertTrue(order("maxheight") < order("height"))
        assertTrue(order("minwidth") < order("width"))
        assertTrue(order("minheight") < order("height"))
    }

    @Test
    fun `bounds also run before the combined size applicator`() {
        assertTrue(order("maxwidth") < order("size"))
        assertTrue(order("maxheight") < order("size"))
    }

    @Test
    fun `margin still runs before every size applicator`() {
        // Pre-existing rule: margin must grow the outer box, not inset content.
        assertTrue(order("margin") < order("maxwidth"))
        assertTrue(order("margin") < order("width"))
    }

    @Test
    fun `size still runs before layout, and the visual bands keep their order`() {
        assertTrue(order("width") < order("weight"))
        assertTrue(order("weight") < order("shadow"))
        assertTrue(order("shadow") < order("borderradius"))
        assertTrue(order("borderradius") < order("border"))
        assertTrue(order("border") < order("backgroundcolor"))
        assertTrue(order("background") < order("padding"))
    }

    @Test
    fun `background color paints beneath gradients and images`() {
        // CSS longhands are order-independent: `background-color` is always
        // the bottom layer regardless of declaration order. Compose draws in
        // chain order, so sharing a band with `backgroundImage` left this to
        // wire prop order and an opaque colour could erase the image.
        assertTrue(order("backgroundcolor") < order("backgroundimage"))
        assertTrue(order("backgroundcolor") < order("lineargradient"))
        assertTrue(order("backgroundcolor") < order("radialgradient"))
        assertTrue(order("backgroundcolor") < order("conicgradient"))
        assertTrue(order("backgroundcolor") < order("gradient"))
    }

    @Test
    fun `the background shorthand stays with the layers it owns`() {
        // The shorthand carries its own stack (colour, then image, then
        // gradients), so it belongs in the layer band, not the colour band.
        assertTrue(order("background") >= order("backgroundimage"))
    }
}
