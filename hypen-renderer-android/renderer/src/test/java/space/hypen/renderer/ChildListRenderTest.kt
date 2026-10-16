package space.hypen.renderer

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ComposeRenderer

/**
 * A batch that only changes a child list (no prop write anywhere) must
 * recompose the parent that renders it: composition reads children through
 * `ComposeRenderer.getChildren`, which must be snapshot-observed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h800dp-mdpi")
class ChildListRenderTest {
    @get:Rule
    val rule = createComposeRule()

    private val renderer = ComposeRenderer()

    private fun mount(parentType: String) {
        rule.setHypenContent(renderer)
        rule.apply(
            renderer,
            listOf(Patch.create("col", "Column"), Patch.create("fe", parentType), Patch.insert("col", "fe")) +
                rows("fe", 0..2) + Patch.insert("root", "col"),
        )
        for (i in 0..2) rule.onNodeWithText("row $i").assertIsDisplayed()
    }

    @Test
    fun `insert, remove and move inside a ForEach re-render`() {
        mount("ForEach")

        rule.apply(renderer, rows("fe", 3..3))
        rule.onNodeWithText("row 3").assertIsDisplayed()

        rule.apply(renderer, listOf(Patch.remove("r0")))
        rule.onNodeWithText("row 0").assertDoesNotExist()

        rule.apply(renderer, listOf(Patch.move("fe", "r3", beforeId = "r1")))
        assertEquals(0f, rule.onNodeWithText("row 3").positionInRoot().y, 0.5f)
        assertEquals(50f, rule.onNodeWithText("row 1").positionInRoot().y, 0.5f)
    }

    @Test
    fun `insert into a plain Column re-renders`() {
        mount("Column")
        rule.apply(renderer, rows("fe", 3..3))
        rule.onNodeWithText("row 3").assertIsDisplayed()
    }
}
