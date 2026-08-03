package space.hypen.renderer.applicators

import androidx.compose.ui.Modifier
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * Negative spacing must not crash the app.
 *
 * `Modifier.padding` throws `IllegalArgumentException: Padding must be
 * non-negative`, and both spacing applicators used to hand it wire values
 * unchecked. A single negative margin — ordinary CSS, and emitted directly by
 * the Tailwind parser for `-m-4` / `-mt-2` — killed the whole Compose
 * composition with an uncaught exception.
 *
 * These call the applicators the way the renderer does; the assertion that
 * matters is simply that nothing throws.
 */
class SafeSpacingTest {

    private fun context() = ApplicatorContext(
        element = space.hypen.renderer.model.HypenElement(id = "1", elementType = "row"),
        actionDispatcher = null,
    )

    @Test
    fun `a negative margin does not throw`() {
        val result = MarginApplicator().apply(Modifier, -16, context())
        assertNotNull(result)
    }

    @Test
    fun `a negative margin string does not throw`() {
        assertNotNull(MarginApplicator().apply(Modifier, "-16px", context()))
        assertNotNull(MarginApplicator().apply(Modifier, "-1rem", context()))
    }

    @Test
    fun `negative margin edges in a map do not throw`() {
        val value = mapOf("top" to -8, "left" to -4, "bottom" to -2, "right" to -1)
        assertNotNull(MarginApplicator().apply(Modifier, value, context()))
    }

    @Test
    fun `negative positional margin shorthand does not throw`() {
        // margin(t, r, b, l) with negatives, the `-m-*` shorthand shape.
        val value = mapOf("0" to -4, "1" to -8, "2" to -4, "3" to -8)
        assertNotNull(MarginApplicator().apply(Modifier, value, context()))
    }

    @Test
    fun `a negative padding does not throw`() {
        // Invalid CSS — browsers discard it — but it must degrade, not crash.
        assertNotNull(PaddingApplicator().apply(Modifier, -12, context()))
        assertNotNull(PaddingApplicator().apply(Modifier, "-12px", context()))
    }

    @Test
    fun `negative padding edges in a map do not throw`() {
        val value = mapOf("top" to -8, "horizontal" to -4)
        assertNotNull(PaddingApplicator().apply(Modifier, value, context()))
    }

    @Test
    fun `ordinary positive spacing still applies`() {
        assertNotNull(MarginApplicator().apply(Modifier, 16, context()))
        assertNotNull(PaddingApplicator().apply(Modifier, 16, context()))
    }
}
