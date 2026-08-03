package space.hypen.renderer.anim

import androidx.compose.animation.core.LinearEasing
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.applicators.ColorParser

/**
 * Value interpolation and curve evaluation for `.transition` glides.
 *
 * The curve assertions are the ones that matter for cross-renderer parity:
 * the tokens map to the PINNED cubic beziers, and `spring` is the fixed
 * overshoot bezier — not Compose's physics `spring()`, which would land on a
 * visibly different motion.
 */
class AnimValuesTest {
    // ---------------------------------------------------------- easing

    @Test
    fun `linear short-circuits to Compose's LinearEasing`() {
        assertSame(LinearEasing, AnimCurve.LINEAR.toEasing())
    }

    @Test
    fun `curves are exact at the endpoints`() {
        for (curve in AnimCurve.entries) {
            val easing = curve.toEasing()
            assertEquals("${curve.wire} at t=0", 0f, easing.transform(0f), 1e-4f)
            assertEquals("${curve.wire} at t=1", 1f, easing.transform(1f), 1e-4f)
        }
    }

    @Test
    fun `spring overshoots past its target mid-flight`() {
        val easing = AnimCurve.SPRING.toEasing()
        val peak = (1..99).maxOf { easing.transform(it / 100f) }
        assertTrue("spring must overshoot (peak was $peak)", peak > 1.05f)
    }

    @Test
    fun `easeOut leads easeIn through the first half`() {
        val easeOut = AnimCurve.EASE_OUT.toEasing()
        val easeIn = AnimCurve.EASE_IN.toEasing()
        assertTrue(easeOut.transform(0.25f) > easeIn.transform(0.25f))
        assertTrue(easeOut.transform(0.5f) > easeIn.transform(0.5f))
    }

    // ---------------------------------------------------------- scalars

    @Test
    fun `scalar parses bare numbers and unit suffixes`() {
        assertEquals(AnimValues.Scalar(16.0, ""), AnimValues.scalar(16.0))
        assertEquals(AnimValues.Scalar(16.0, "px"), AnimValues.scalar("16px"))
        assertEquals(AnimValues.Scalar(1.5, "rem"), AnimValues.scalar("1.5rem"))
        assertEquals(AnimValues.Scalar(50.0, "%"), AnimValues.scalar("50%"))
        assertEquals(AnimValues.Scalar(8.0, ""), AnimValues.scalar("8"))
    }

    @Test
    fun `scalar rejects non-numeric and non-finite values`() {
        assertNull(AnimValues.scalar("auto"))
        assertNull(AnimValues.scalar(null))
        assertNull(AnimValues.scalar(true))
        assertNull(AnimValues.scalar(Double.NaN))
        assertNull(AnimValues.scalar(Double.POSITIVE_INFINITY))
    }

    // ---------------------------------------------------- interpolation

    @Test
    fun `numeric interpolation carries the unit through`() {
        val lerp = AnimValues.interpolator("padding", "8px", "24px")!!
        assertEquals("8px", lerp(0f))
        assertEquals("16px", lerp(0.5f))
        assertEquals("24px", lerp(1f))
    }

    @Test
    fun `bare numbers interpolate as numbers`() {
        val lerp = AnimValues.interpolator("opacity", 1.0, 0.0)!!
        assertEquals(1.0, lerp(0f))
        assertEquals(0.5, lerp(0.5f) as Double, 1e-6)
        assertEquals(0.0, lerp(1f))
    }

    @Test
    fun `a unit change snaps rather than lying about the quantity`() {
        assertNull(AnimValues.interpolator("width", "50%", "200px"))
        assertNull(AnimValues.interpolator("width", "auto", "200px"))
        assertNull(AnimValues.interpolator("width", "200px", null))
    }

    @Test
    fun `identical endpoints need no animation`() {
        assertNull(AnimValues.interpolator("opacity", 1.0, 1.0))
        assertNull(AnimValues.interpolator("backgroundColor", "red", "#ff0000"))
    }

    @Test
    fun `colors interpolate in RGBA and round-trip through ColorParser`() {
        val lerp = AnimValues.interpolator("backgroundColor", "#000000", "#ffffff")!!
        assertEquals(Color.Black, ColorParser.parse(lerp(0f)))
        assertEquals(Color.White, ColorParser.parse(lerp(1f)))

        // Straight sRGB, not Oklab: the midpoint of black→white is 0.5.
        val mid = ColorParser.parse(lerp(0.5f))!!
        assertEquals(0.5f, mid.red, 0.01f)
        assertEquals(mid.red, mid.green, 1e-3f)
        assertEquals(mid.green, mid.blue, 1e-3f)
        assertEquals(1f, mid.alpha, 1e-3f)
    }

    @Test
    fun `alpha interpolates too`() {
        val lerp = AnimValues.interpolator("color", "#ff000000", "#ff0000ff")!!
        assertEquals(0f, ColorParser.parse(lerp(0f))!!.alpha, 1e-2f)
        assertEquals(1f, ColorParser.parse(lerp(1f))!!.alpha, 1e-2f)
    }

    @Test
    fun `an unparseable color snaps`() {
        assertNull(AnimValues.interpolator("color", "chartreuse-ish", "#ff0000"))
        assertNull(AnimValues.interpolator("borderColor", "#ff0000",
            listOf(1, 2, 3)))
    }

    @Test
    fun `hex emits the eight-digit form ColorParser reads back`() {
        assertEquals("#ff0000ff", AnimValues.hex(Color.Red))
        assertEquals(Color.Red, ColorParser.parse(AnimValues.hex(Color.Red)))
        assertNotNull(ColorParser.parse(AnimValues.hex(Color.Transparent)))
    }

    // ------------------------------------------- onAnimationComplete props

    @Test
    fun `completion action reads the applicator's lowered props`() {
        val action = animationCompleteAction(
            mapOf("onAnimationComplete.0" to "@actions.done", "onAnimationComplete.id" to 7.0),
        )
        assertEquals("done", action?.actionName)
        assertEquals(mapOf<String, Any?>("id" to 7.0), action?.payload)
    }

    @Test
    fun `no completion prop means no action`() {
        assertNull(animationCompleteAction(mapOf("onClick.0" to "@actions.tap")))
        assertNull(animationCompleteAction(mapOf("onAnimationComplete.id" to 7.0)))
    }
}
