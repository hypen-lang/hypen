package space.hypen.renderer.applicators

import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import space.hypen.renderer.model.HypenElement

/**
 * The alignment family (`alignment`, `justifyContent`/`alignItems`,
 * `horizontalAlignment`/`verticalAlignment`) as applicators.
 *
 * Two things are load-bearing and pinned here: they reach elements whose
 * handler has no alignment of its own (they used to be read only inside
 * Column/Row/Stack/List/Badge and were dropped everywhere else), and they
 * stand down on the containers that resolve the same props themselves —
 * applying both would align twice and shrink the painted box.
 */
class ContentAlignmentApplicatorTest {

    private fun context(elementType: String) = ApplicatorContext(
        element = HypenElement(id = "1", elementType = elementType),
        actionDispatcher = null,
    )

    @Test
    fun `an element with no alignment of its own gets a real modifier`() {
        val base: Modifier = Modifier
        assertNotSame(base, JustifyContentApplicator().apply(base, "center", context("Image")))
        assertNotSame(base, AlignItemsApplicator().apply(base, "center", context("Image")))
        assertNotSame(base, HorizontalAlignmentApplicator().apply(base, "end", context("Text")))
        assertNotSame(base, VerticalAlignmentApplicator().apply(base, "bottom", context("Text")))
        assertNotSame(base, AlignmentApplicator().apply(base, "center", context("Icon")))
    }

    @Test
    fun `containers that resolve alignment themselves keep winning`() {
        // Column/Row/List fold these props into an Arrangement, and
        // App/Badge/Box/Button/Center/Container/Stack into a Box
        // contentAlignment; Card/Grid/SafeArea size and paint inside this
        // chain. A wrapContent* on top would fight them, so the applicator
        // must hand the modifier straight back.
        val base: Modifier = Modifier
        val owning = listOf(
            "App", "Badge", "Box", "Button", "Card", "Center", "Column",
            "Container", "Grid", "List", "Row", "SafeArea", "Stack",
        )
        for (type in owning) {
            assertSame(type, base, JustifyContentApplicator().apply(base, "center", context(type)))
            assertSame(type, base, AlignItemsApplicator().apply(base, "center", context(type)))
            assertSame(type, base, HorizontalAlignmentApplicator().apply(base, "center", context(type)))
            assertSame(type, base, VerticalAlignmentApplicator().apply(base, "center", context(type)))
            assertSame(type, base, AlignmentApplicator().apply(base, "center", context(type)))
        }
    }

    @Test
    fun `distribution keywords have no single-box meaning and are left alone`() {
        // space-between/around/evenly distribute *between* children, which is
        // the parent Row/Column's job; on a single box there is nothing to
        // distribute, so the modifier is untouched rather than guessed at.
        val base: Modifier = Modifier
        assertSame(base, JustifyContentApplicator().apply(base, "space-between", context("Image")))
        assertSame(base, AlignItemsApplicator().apply(base, "stretch", context("Image")))
    }

    @Test
    fun `flex spellings resolve to the same alignment as the native tokens`() {
        assertEquals(Alignment.Start, AlignmentApplicator.parseHorizontalAlignment("flex-start"))
        assertEquals(Alignment.End, AlignmentApplicator.parseHorizontalAlignment("trailing"))
        assertEquals(Alignment.Top, AlignmentApplicator.parseVerticalAlignment("flex-start"))
        assertEquals(Alignment.Bottom, AlignmentApplicator.parseVerticalAlignment("flex-end"))
        assertNull(AlignmentApplicator.parseHorizontalAlignment("space-around"))
    }
}
