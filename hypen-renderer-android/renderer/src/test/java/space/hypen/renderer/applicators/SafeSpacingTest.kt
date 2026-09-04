package space.hypen.renderer.applicators

import androidx.compose.ui.Modifier
import org.junit.Assert.assertEquals
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
 * Applicator tests retain the crash regression coverage. Geometry tests below
 * exercise the signed margin-box calculation that controls parent measurement
 * and subsequent sibling placement.
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

    @Test
    fun `negative start margins overlap avatar siblings and reduce row width`() {
        val margins = listOf(0, -12, -12, -12)
        var cursor = 0
        val childPositions = margins.map { startMargin ->
            val geometry = marginAxisGeometry(
                contentSize = 40,
                before = startMargin,
                after = 0,
                minSize = 0,
                maxSize = Int.MAX_VALUE,
            )
            val childPosition = cursor + geometry.childOffset
            cursor += geometry.outerSize
            childPosition
        }

        assertEquals(listOf(0, 28, 56, 84), childPositions)
        assertEquals(124, cursor)
        assertEquals(124, childPositions.maxOf { it + 40 })
    }

    @Test
    fun `negative end margin advances the next sibling toward this child`() {
        val geometry = marginAxisGeometry(
            contentSize = 40,
            before = 0,
            after = -12,
            minSize = 0,
            maxSize = Int.MAX_VALUE,
        )

        assertEquals(0, geometry.childOffset)
        assertEquals(28, geometry.outerSize)
    }

    @Test
    fun `negative vertical margins shift content and shrink measured height`() {
        val geometry = marginAxisGeometry(
            contentSize = 40,
            before = -8,
            after = -4,
            minSize = 0,
            maxSize = Int.MAX_VALUE,
        )

        assertEquals(-8, geometry.childOffset)
        assertEquals(28, geometry.outerSize)
    }

    @Test
    fun `signed margin box respects parent constraints`() {
        assertEquals(
            MarginAxisGeometry(childOffset = -12, outerSize = 30),
            marginAxisGeometry(
                // The child's minimum becomes 42 after offsetting the
                // parent's 30px minimum by the -12px signed margin.
                contentSize = 42,
                before = -12,
                after = 0,
                minSize = 30,
                maxSize = 100,
            ),
        )
        assertEquals(
            MarginAxisGeometry(childOffset = 12, outerSize = 50),
            marginAxisGeometry(
                // The child's maximum becomes 34 after reserving the 16px
                // positive margins from the parent's 50px maximum.
                contentSize = 34,
                before = 12,
                after = 4,
                minSize = 0,
                maxSize = 50,
            ),
        )
    }
}
