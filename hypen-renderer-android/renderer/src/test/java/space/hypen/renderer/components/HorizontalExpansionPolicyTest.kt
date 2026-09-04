package space.hypen.renderer.components

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.HypenElement

class HorizontalExpansionPolicyTest {
    private fun column(vararg props: Pair<String, Any?>) =
        HypenElement(
            id = "column",
            elementType = "column",
            props = mapOf(*props),
        )

    private fun childFillMaxWidth() =
        HypenElement(
            id = "child",
            elementType = "stack",
            props = mapOf("fillMaxWidth.0" to true),
        )

    @Test
    fun `fillMaxSize column permits a fillMaxWidth child`() {
        val parentAllowsExpansion =
            columnAllowsHorizontalExpansion(column("fillMaxSize.0" to true))

        assertTrue(parentAllowsExpansion)
        assertTrue(permittedFillMaxWidthFraction(childFillMaxWidth(), parentAllowsExpansion) != null)
    }

    @Test
    fun `nested column preserves a finite parent width for a fill child`() {
        val outerAllowsExpansion =
            columnAllowsHorizontalExpansion(column("fillMaxSize.0" to true))
        val nestedAllowsExpansion =
            columnAllowsHorizontalExpansion(column(), outerAllowsExpansion)

        assertTrue(nestedAllowsExpansion)
        assertTrue(permittedFillMaxWidthFraction(childFillMaxWidth(), nestedAllowsExpansion) != null)
    }

    @Test
    fun `disabled fillMaxSize does not establish a width`() {
        assertFalse(columnAllowsHorizontalExpansion(column("fillMaxSize.0" to false)))
    }

    @Test
    fun `numeric and unit widths establish a width`() {
        listOf<Any>(320, "320px", "320dp", "50%", "40vw", "fill").forEach { width ->
            assertTrue(
                "Expected width '$width' to allow horizontal expansion",
                columnAllowsHorizontalExpansion(column("width.0" to width)),
            )
        }
    }

    @Test
    fun `fractional fill applicators establish and consume width`() {
        val parentAllowsExpansion =
            columnAllowsHorizontalExpansion(column("fillMaxSize.0" to 0.5))
        val child = column("fillMaxWidth.0" to 0.5)

        assertTrue(parentAllowsExpansion)
        assertTrue(permittedFillMaxWidthFraction(child, parentAllowsExpansion) == 0.5f)
    }

    @Test
    fun `wrap and invalid widths preserve wrap-content behavior`() {
        listOf("wrap", "wrap_content", "auto", "not-a-size").forEach { width ->
            assertFalse(
                "Expected width '$width' to preserve wrap-content behavior",
                columnAllowsHorizontalExpansion(column("width.0" to width)),
            )
        }
    }

    @Test
    fun `parent permission remains required`() {
        assertTrue(permittedFillMaxWidthFraction(childFillMaxWidth(), false) == null)
    }
}
