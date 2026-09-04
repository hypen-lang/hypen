package space.hypen.renderer.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.HypenElement

class RowWidthAllocationTest {
    @Test
    fun `fractional siblings share one content pool after gaps`() {
        val widths = allocateRowWidths(
            availableWidth = 268f,
            gap = 8f,
            naturalWidths = listOf(40f, 70f),
            items = listOf(
                RowItemSizing(fraction = 0.5f),
                RowItemSizing(fraction = 0.5f),
            ),
        )

        assertEquals(listOf(130f, 130f), widths)
        assertEquals(268f, widths.sum() + 8f, 0.001f)
    }

    @Test
    fun `numeric flex has a zero basis and honors one two one ratios`() {
        val widths = allocateRowWidths(
            availableWidth = 300f,
            gap = 8f,
            naturalWidths = listOf(90f, 30f, 140f),
            items = listOf(
                RowItemSizing(flexWeight = 1f, usesZeroFlexBasis = true),
                RowItemSizing(flexWeight = 2f, usesZeroFlexBasis = true),
                RowItemSizing(flexWeight = 1f, usesZeroFlexBasis = true),
            ),
        )

        assertEquals(listOf(71f, 142f, 71f), widths)
    }

    @Test
    fun `flexGrow starts at natural width then paints the remaining pool`() {
        val widths = allocateRowWidths(
            availableWidth = 300f,
            gap = 8f,
            naturalWidths = listOf(80f, 40f),
            items = listOf(RowItemSizing(), RowItemSizing(flexWeight = 1f)),
        )

        assertEquals(listOf(80f, 212f), widths)
    }

    @Test
    fun `flexShrink zero remains protected while its sibling absorbs overflow`() {
        val widths = allocateRowWidths(
            availableWidth = 300f,
            gap = 8f,
            naturalWidths = listOf(200f, 200f),
            items = listOf(RowItemSizing(shrink = 1f), RowItemSizing(shrink = 0f)),
        )

        assertEquals(listOf(92f, 200f), widths)
    }

    @Test
    fun `element metadata distinguishes flex basis grow and shrink`() {
        val fraction = RowItemSizing.from(
            HypenElement("fraction", "stack", props = mapOf("fillMaxWidth.0" to 0.5)),
        )
        val flex = RowItemSizing.from(
            HypenElement("flex", "stack", props = mapOf("flex.0" to 2)),
        )
        val grow = RowItemSizing.from(
            HypenElement(
                "grow",
                "stack",
                props = mapOf("flexGrow.0" to 1, "flexShrink.0" to 0),
            ),
        )

        assertEquals(0.5f, fraction.fraction)
        assertEquals(2f, flex.flexWeight)
        assertTrue(flex.usesZeroFlexBasis)
        assertEquals(1f, grow.flexWeight)
        assertFalse(grow.usesZeroFlexBasis)
        assertEquals(0f, grow.shrink)
    }
}
