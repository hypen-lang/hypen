package space.hypen.renderer

import space.hypen.renderer.applicators.Breakpoint
import space.hypen.renderer.applicators.StateVariant
import space.hypen.renderer.applicators.VariantInfo
import space.hypen.renderer.applicators.parseVariantName
import space.hypen.renderer.applicators.ApplicatorResultWithVariants
import androidx.compose.ui.Modifier
import org.junit.Assert.*
import org.junit.Test

class VariantSupportTest {

    // MARK: - Breakpoint Tests

    @Test
    fun `breakpoint minWidthDp values are correct`() {
        assertEquals(640, Breakpoint.SM.minWidthDp)
        assertEquals(768, Breakpoint.MD.minWidthDp)
        assertEquals(1024, Breakpoint.LG.minWidthDp)
        assertEquals(1280, Breakpoint.XL.minWidthDp)
        assertEquals(1536, Breakpoint.XXL.minWidthDp)
    }

    @Test
    fun `breakpoint from string lowercase`() {
        assertEquals(Breakpoint.SM, Breakpoint.from("sm"))
        assertEquals(Breakpoint.MD, Breakpoint.from("md"))
        assertEquals(Breakpoint.LG, Breakpoint.from("lg"))
        assertEquals(Breakpoint.XL, Breakpoint.from("xl"))
        assertEquals(Breakpoint.XXL, Breakpoint.from("2xl"))
    }

    @Test
    fun `breakpoint from string case insensitive`() {
        assertEquals(Breakpoint.SM, Breakpoint.from("SM"))
        assertEquals(Breakpoint.MD, Breakpoint.from("MD"))
        assertEquals(Breakpoint.LG, Breakpoint.from("Lg"))
    }

    @Test
    fun `breakpoint from invalid string returns null`() {
        assertNull(Breakpoint.from("invalid"))
        assertNull(Breakpoint.from("xs"))
        assertNull(Breakpoint.from(""))
    }

    // MARK: - StateVariant Tests

    @Test
    fun `stateVariant from string`() {
        assertEquals(StateVariant.HOVER, StateVariant.from("hover"))
        assertEquals(StateVariant.FOCUS, StateVariant.from("focus"))
        assertEquals(StateVariant.ACTIVE, StateVariant.from("active"))
        assertEquals(StateVariant.DISABLED, StateVariant.from("disabled"))
        assertEquals(StateVariant.FOCUS_VISIBLE, StateVariant.from("focus-visible"))
        assertEquals(StateVariant.FOCUS_WITHIN, StateVariant.from("focus-within"))
    }

    @Test
    fun `stateVariant from string case insensitive`() {
        assertEquals(StateVariant.HOVER, StateVariant.from("HOVER"))
        assertEquals(StateVariant.FOCUS, StateVariant.from("Focus"))
        assertEquals(StateVariant.ACTIVE, StateVariant.from("ACTIVE"))
    }

    @Test
    fun `stateVariant from invalid string returns null`() {
        assertNull(StateVariant.from("invalid"))
        assertNull(StateVariant.from("click"))
        assertNull(StateVariant.from(""))
    }

    // MARK: - parseVariantName Tests

    @Test
    fun `parseVariantName basic property`() {
        val result = parseVariantName("padding")

        assertEquals("padding", result.baseName)
        assertNull(result.breakpoint)
        assertNull(result.state)
        assertFalse(result.isVariant)
        assertFalse(result.isResponsive)
        assertFalse(result.isStateful)
    }

    @Test
    fun `parseVariantName responsive variants`() {
        val smResult = parseVariantName("padding@sm")
        assertEquals("padding", smResult.baseName)
        assertEquals(Breakpoint.SM, smResult.breakpoint)
        assertNull(smResult.state)
        assertTrue(smResult.isResponsive)
        assertFalse(smResult.isStateful)

        val mdResult = parseVariantName("width@md")
        assertEquals("width", mdResult.baseName)
        assertEquals(Breakpoint.MD, mdResult.breakpoint)

        val xlResult = parseVariantName("font-size@xl")
        assertEquals("font-size", xlResult.baseName)
        assertEquals(Breakpoint.XL, xlResult.breakpoint)

        val xxlResult = parseVariantName("gap@2xl")
        assertEquals("gap", xxlResult.baseName)
        assertEquals(Breakpoint.XXL, xxlResult.breakpoint)
    }

    @Test
    fun `parseVariantName state variants`() {
        val hoverResult = parseVariantName("background-color:hover")
        assertEquals("background-color", hoverResult.baseName)
        assertNull(hoverResult.breakpoint)
        assertEquals(StateVariant.HOVER, hoverResult.state)
        assertFalse(hoverResult.isResponsive)
        assertTrue(hoverResult.isStateful)

        val focusResult = parseVariantName("border-color:focus")
        assertEquals("border-color", focusResult.baseName)
        assertEquals(StateVariant.FOCUS, focusResult.state)

        val activeResult = parseVariantName("opacity:active")
        assertEquals("opacity", activeResult.baseName)
        assertEquals(StateVariant.ACTIVE, activeResult.state)

        val disabledResult = parseVariantName("color:disabled")
        assertEquals("color", disabledResult.baseName)
        assertEquals(StateVariant.DISABLED, disabledResult.state)
    }

    @Test
    fun `parseVariantName invalid breakpoint`() {
        val result = parseVariantName("padding@invalid")

        // An unrecognised marker is left as part of the base name (so it never
        // matches a real applicator), matching the engine + web parsers.
        assertEquals("padding@invalid", result.baseName)
        assertNull(result.breakpoint) // Invalid breakpoint becomes null
        assertNull(result.state)
    }

    @Test
    fun `parseVariantName invalid state`() {
        val result = parseVariantName("padding:invalid")

        assertEquals("padding:invalid", result.baseName)
        assertNull(result.breakpoint)
        assertNull(result.state) // Invalid state becomes null
    }

    @Test
    fun `parseVariantName combined breakpoint and state`() {
        // Combined `@bp:state` must resolve BOTH halves (previously the state was
        // silently dropped). Mirrors the cross-SDK `parse-combined` fixture.
        val result = parseVariantName("backgroundColor@md:hover")
        assertEquals("backgroundColor", result.baseName)
        assertEquals(Breakpoint.MD, result.breakpoint)
        assertEquals(StateVariant.HOVER, result.state)
        assertTrue(result.isVariant)
        assertTrue(result.isResponsive)
        assertTrue(result.isStateful)

        val hyphenated = parseVariantName("background-color@2xl:focus-within")
        assertEquals("background-color", hyphenated.baseName)
        assertEquals(Breakpoint.XXL, hyphenated.breakpoint)
        assertEquals(StateVariant.FOCUS_WITHIN, hyphenated.state)
    }

    @Test
    fun `parseVariantName complex property names`() {
        val result1 = parseVariantName("background-color@lg")
        assertEquals("background-color", result1.baseName)
        assertEquals(Breakpoint.LG, result1.breakpoint)

        val result2 = parseVariantName("border-top-width:hover")
        assertEquals("border-top-width", result2.baseName)
        assertEquals(StateVariant.HOVER, result2.state)
    }

    // MARK: - VariantInfo Tests

    @Test
    fun `variantInfo properties`() {
        val basic = VariantInfo(baseName = "padding", breakpoint = null, state = null)
        assertFalse(basic.isVariant)
        assertFalse(basic.isResponsive)
        assertFalse(basic.isStateful)

        val responsive = VariantInfo(baseName = "padding", breakpoint = Breakpoint.MD, state = null)
        assertTrue(responsive.isVariant)
        assertTrue(responsive.isResponsive)
        assertFalse(responsive.isStateful)

        val stateful = VariantInfo(baseName = "padding", breakpoint = null, state = StateVariant.HOVER)
        assertTrue(stateful.isVariant)
        assertFalse(stateful.isResponsive)
        assertTrue(stateful.isStateful)
    }

    // MARK: - ApplicatorResultWithVariants Tests

    @Test
    fun `applicatorResultWithVariants hasVariants when empty`() {
        val result = ApplicatorResultWithVariants(
            baseModifier = Modifier,
            responsiveModifiers = emptyMap(),
            stateModifiers = emptyMap()
        )

        assertFalse(result.hasVariants)
        assertFalse(result.hasResponsiveVariants)
        assertFalse(result.hasStateVariants)
    }

    @Test
    fun `applicatorResultWithVariants hasVariants when has responsive`() {
        val result = ApplicatorResultWithVariants(
            baseModifier = Modifier,
            responsiveModifiers = mapOf(Breakpoint.MD to Modifier),
            stateModifiers = emptyMap()
        )

        assertTrue(result.hasVariants)
        assertTrue(result.hasResponsiveVariants)
        assertFalse(result.hasStateVariants)
    }

    @Test
    fun `applicatorResultWithVariants hasVariants when has states`() {
        val result = ApplicatorResultWithVariants(
            baseModifier = Modifier,
            responsiveModifiers = emptyMap(),
            stateModifiers = mapOf(StateVariant.HOVER to Modifier)
        )

        assertTrue(result.hasVariants)
        assertFalse(result.hasResponsiveVariants)
        assertTrue(result.hasStateVariants)
    }

    @Test
    fun `applicatorResultWithVariants getModifierForWidth below all breakpoints`() {
        val result = ApplicatorResultWithVariants(
            baseModifier = Modifier,
            responsiveModifiers = mapOf(
                Breakpoint.SM to Modifier,
                Breakpoint.MD to Modifier
            ),
            stateModifiers = emptyMap()
        )

        // Width below sm (640)
        val modifier = result.getModifierForWidth(500)
        // Should return base modifier (no responsive modifiers applied)
        assertNotNull(modifier)
    }

    @Test
    fun `applicatorResultWithVariants getModifierForWidth at breakpoint`() {
        val result = ApplicatorResultWithVariants(
            baseModifier = Modifier,
            responsiveModifiers = mapOf(
                Breakpoint.SM to Modifier,
                Breakpoint.MD to Modifier
            ),
            stateModifiers = emptyMap()
        )

        // Width at sm (640)
        val modifier1 = result.getModifierForWidth(640)
        assertNotNull(modifier1)

        // Width at md (768)
        val modifier2 = result.getModifierForWidth(768)
        assertNotNull(modifier2)
    }

    @Test
    fun `applicatorResultWithVariants getModifierForWidth above breakpoint`() {
        val result = ApplicatorResultWithVariants(
            baseModifier = Modifier,
            responsiveModifiers = mapOf(
                Breakpoint.SM to Modifier,
                Breakpoint.MD to Modifier
            ),
            stateModifiers = emptyMap()
        )

        // Width above md (768) but below lg (1024)
        val modifier = result.getModifierForWidth(900)
        assertNotNull(modifier)
    }

    @Test
    fun `applicatorResultWithVariants applies modifiers from smallest to largest`() {
        // This tests that the ordering is correct - sm is applied before md
        val result = ApplicatorResultWithVariants(
            baseModifier = Modifier,
            responsiveModifiers = mapOf(
                Breakpoint.LG to Modifier, // Insert out of order
                Breakpoint.SM to Modifier,
                Breakpoint.MD to Modifier
            ),
            stateModifiers = emptyMap()
        )

        // At lg width (1024), all three modifiers should be applied in order: sm, md, lg
        val modifier = result.getModifierForWidth(1024)
        assertNotNull(modifier)
    }
}
