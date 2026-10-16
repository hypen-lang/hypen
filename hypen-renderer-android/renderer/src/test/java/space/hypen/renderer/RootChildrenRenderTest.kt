package space.hypen.renderer

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import space.hypen.renderer.components.ComponentHandler
import space.hypen.renderer.components.createDefaultComponentRegistry
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ComposeRenderer

/**
 * The "root" mount container rendered for real ([HypenRoot]): order,
 * `beforeId` placement, composition identity across sibling toggles, and
 * the loading latch. The patch-level rules are in [RootChildrenTest].
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h800dp-mdpi")
class RootChildrenRenderTest {
    @get:Rule
    val rule = createComposeRule()

    /** Counts how many times a `Probe` element's composition is (re)created. */
    private var probeCompositions = 0

    private val probe = object : ComponentHandler {
        override val typeName = "probe"

        @Composable
        override fun Render(element: HypenElement, modifier: Modifier, renderChildren: @Composable () -> Unit) {
            val instance = remember { ++probeCompositions }
            Text("probe instance $instance", modifier)
        }
    }

    private val renderer = ComposeRenderer(
        componentRegistry = createDefaultComponentRegistry().also { it.register(probe) },
    )

    private fun text(id: String, label: String = id) = Patch.create(id, "Text", mapOf("0" to label, "height.0" to 40.0))

    @Test
    fun `two roots render in insertion order, stacked`() {
        rule.setHypenContent(renderer)
        rule.apply(renderer, listOf(text("a", "first"), text("b", "second"), Patch.insert("root", "a"), Patch.insert("root", "b")))

        val first = rule.onNodeWithText("first").assertIsDisplayed().positionInRoot()
        val second = rule.onNodeWithText("second").assertIsDisplayed().positionInRoot()
        assertEquals(0f, first.y, 0.5f)
        assertEquals(40f, second.y, 0.5f)
    }

    @Test
    fun `insert with beforeId places the new root before its anchor`() {
        rule.setHypenContent(renderer)
        rule.apply(renderer, listOf(text("body"), Patch.insert("root", "body")))
        assertEquals(0f, rule.onNodeWithText("body").positionInRoot().y, 0.5f)

        rule.apply(renderer, listOf(text("banner"), Patch.insert("root", "banner", beforeId = "body")))
        assertEquals(0f, rule.onNodeWithText("banner").positionInRoot().y, 0.5f)
        assertEquals(40f, rule.onNodeWithText("body").positionInRoot().y, 0.5f)
    }

    @Test
    fun `toggling a second root keeps the first root's composition`() {
        rule.setHypenContent(renderer)
        rule.apply(renderer, listOf(Patch.create("p", "Probe"), Patch.insert("root", "p")))
        rule.onNodeWithText("probe instance 1").assertIsDisplayed()

        // One -> several roots (a root `If` turning on before the probe)...
        rule.apply(renderer, listOf(text("banner"), Patch.insert("root", "banner", beforeId = "p")))
        rule.onNodeWithText("banner").assertIsDisplayed()
        rule.onNodeWithText("probe instance 1").assertIsDisplayed()

        // ...and back to one, and again after it.
        rule.apply(renderer, listOf(Patch.remove("banner")))
        rule.apply(renderer, listOf(text("footer"), Patch.insert("root", "footer")))
        rule.apply(renderer, listOf(Patch.remove("footer")))

        rule.onNodeWithText("probe instance 1").assertIsDisplayed()
        assertEquals(1, probeCompositions)
    }

    @Test
    fun `loading shows only before the first root, an emptied root renders nothing`() {
        rule.setHypenContent(renderer)
        rule.onNodeWithText(LOADING_TEXT).assertIsDisplayed()

        // A batch that places nothing at the root keeps the loading content.
        rule.apply(renderer, listOf(text("orphan")))
        rule.onNodeWithText(LOADING_TEXT).assertIsDisplayed()

        rule.apply(renderer, listOf(Patch.insert("root", "orphan")))
        rule.onNodeWithText(LOADING_TEXT).assertDoesNotExist()
        rule.onNodeWithText("orphan").assertIsDisplayed()

        // The only root leaves (a root `If` turning off): nothing, not loading.
        rule.apply(renderer, listOf(Patch.remove("orphan")))
        rule.onNodeWithText(LOADING_TEXT).assertDoesNotExist()
        rule.onNodeWithText("orphan").assertDoesNotExist()
        assertTrue(renderer.getRootChildIds().isEmpty())
        assertEquals(0, rule.onAllNodesWithText("", substring = true).fetchSemanticsNodes().size)
    }
}
