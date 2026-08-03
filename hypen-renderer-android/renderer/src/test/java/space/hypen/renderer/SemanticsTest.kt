package space.hypen.renderer

import androidx.compose.ui.semantics.Role
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import space.hypen.renderer.model.Patch
import space.hypen.renderer.model.PatchType
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.render.composeRole
import space.hypen.renderer.render.effectiveLabel
import space.hypen.renderer.render.stateDescriptionFor

/**
 * Accessibility semantics: the block travels on CREATE, is replaced whole by
 * SET_SEMANTICS (null clears), and the pure translation helpers map it onto
 * Compose semantics the way the DOM renderer maps it onto ARIA.
 */
class SemanticsTest {
    // ── Renderer application ────────────────────────────────────────────

    @Test
    fun `create stores the semantics block and setSemantics replaces it`() {
        val renderer = ComposeRenderer()
        renderer.applyPatches(
            listOf(
                Patch(
                    type = PatchType.CREATE,
                    id = "btn",
                    elementType = "button",
                    props = emptyMap(),
                    semantics = mapOf("role" to "button", "name" to "Menu", "expanded" to false),
                ),
                Patch.insert(parentId = "root", id = "btn"),
            ),
        )
        assertEquals(false, renderer.getElement("btn")?.semantics?.get("expanded"))

        renderer.applyPatches(
            listOf(
                Patch.setSemantics("btn", mapOf("role" to "button", "name" to "Menu", "expanded" to true)),
            ),
        )
        assertEquals(true, renderer.getElement("btn")?.semantics?.get("expanded"))

        // Clearing re-emit drops the block.
        renderer.applyPatches(listOf(Patch.setSemantics("btn", null)))
        assertNull(renderer.getElement("btn")?.semantics)
    }

    // ── Translation decisions (pure helpers) ────────────────────────────

    @Test
    fun `explicit names apply and derived names stay with visible content`() {
        assertEquals(
            "Close dialog",
            effectiveLabel(mapOf("role" to "button", "name" to "Close dialog", "nameExplicit" to true)),
        )
        // Derived name on a text-bearing control: TalkBack reads the text.
        assertNull(effectiveLabel(mapOf("role" to "button", "name" to "Save")))
        // Image alt has no visible text to derive from → applied.
        assertEquals("A cat", effectiveLabel(mapOf("role" to "img", "name" to "A cat")))
    }

    @Test
    fun `role tokens map to Compose roles where faithful`() {
        assertEquals(Role.Button, composeRole("button"))
        assertEquals(Role.Tab, composeRole("tab"))
        assertEquals(Role.Checkbox, composeRole("checkbox"))
        assertEquals(Role.Switch, composeRole("switch"))
        assertEquals(Role.Image, composeRole("img"))
        assertEquals(Role.DropdownList, composeRole("listbox"))
        // No faithful Compose role → none rather than a wrong one.
        assertNull(composeRole("paragraph"))
        assertNull(composeRole(null))
    }

    @Test
    fun `state description precedence and description folding`() {
        assertEquals("checked", stateDescriptionFor(mapOf("checked" to true)))
        assertEquals("collapsed", stateDescriptionFor(mapOf("expanded" to false)))
        assertEquals("current page", stateDescriptionFor(mapOf("current" to "page")))
        // Compose has no separate hint slot: description rides along.
        assertEquals(
            "expanded, Shows filters",
            stateDescriptionFor(mapOf("expanded" to true, "description" to "Shows filters")),
        )
        assertEquals("Shows filters", stateDescriptionFor(mapOf("description" to "Shows filters")))
        assertNull(stateDescriptionFor(mapOf("role" to "button")))
    }
}
