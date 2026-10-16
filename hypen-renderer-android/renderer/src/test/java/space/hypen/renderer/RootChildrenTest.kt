package space.hypen.renderer

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.anim.ANIM_EXIT_PROP
import space.hypen.renderer.anim.AlwaysAnimate
import space.hypen.renderer.anim.AnimationCoordinator
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ComposeRenderer

/**
 * Root-level control flow (Router / If / ForEach at the IR root with
 * siblings) places several nodes straight into the "root" mount container.
 * The renderer keeps them as an ordered list, matching the DOM renderer's
 * container children and the desktop renderer's `root_children`. Sequences
 * mirror `hypen-engine-rs/tests/test_control_flow_order.rs` `root_*`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RootChildrenTest {
    private val renderer = ComposeRenderer()

    private fun texts(vararg ids: String) = ids.map { Patch.create(it, "text", mapOf("0" to it)) }

    @Test
    fun `single root keeps the old shape`() {
        renderer.applyPatches(listOf(Patch.create("1", "column"), Patch.insert("root", "1")))
        assertEquals(listOf("1"), renderer.getRootChildIds())
        assertEquals("1", renderer.getRootId())
    }

    @Test
    fun `two root siblings keep insertion order`() {
        renderer.applyPatches(texts("a", "b") + listOf(Patch.insert("root", "a"), Patch.insert("root", "b")))
        assertEquals(listOf("a", "b"), renderer.getRootChildIds())
        assertEquals("a", renderer.getRootId())
    }

    @Test
    fun `root insert honours beforeId`() {
        renderer.applyPatches(texts("body") + Patch.insert("root", "body"))
        // root_router_route_if_toggle_lands_before_sibling: the banner lands before body.
        renderer.applyPatches(texts("banner") + Patch.insert("root", "banner", beforeId = "body"))
        assertEquals(listOf("banner", "body"), renderer.getRootChildIds())
    }

    @Test
    fun `root insert with an unknown anchor appends`() {
        renderer.applyPatches(texts("a", "b") + listOf(Patch.insert("root", "a"), Patch.insert("root", "b", "ghost")))
        assertEquals(listOf("a", "b"), renderer.getRootChildIds())
    }

    @Test
    fun `move at root reorders against the anchor`() {
        renderer.applyPatches(
            texts("banner", "a", "b", "c", "footer") +
                listOf("banner", "a", "b", "c", "footer").map { Patch.insert("root", it) },
        )
        // Reverse the keyed rows; Moves address "root" and anchor on the footer.
        renderer.applyPatches(
            listOf(
                Patch.move("root", "c", "a"),
                Patch.move("root", "a", "footer"),
            ),
        )
        assertEquals(listOf("banner", "c", "b", "a", "footer"), renderer.getRootChildIds())
        // A Move with no anchor goes to the end.
        renderer.applyPatches(listOf(Patch.move("root", "banner")))
        assertEquals(listOf("c", "b", "a", "footer", "banner"), renderer.getRootChildIds())
    }

    @Test
    fun `detach then attach with beforeId restores the position`() {
        renderer.applyPatches(
            texts("a", "footer") + listOf(Patch.insert("root", "a"), Patch.insert("root", "footer")),
        )
        renderer.applyPatches(listOf(Patch.detach("a"), Patch.detach("footer")))
        renderer.applyPatches(texts("other") + Patch.insert("root", "other"))
        assertEquals(listOf("other"), renderer.getRootChildIds())

        renderer.applyPatches(
            listOf(
                Patch.detach("other"),
                Patch.attach("root", "footer"),
                Patch.attach("root", "a", beforeId = "footer"),
            ),
        )
        assertEquals(listOf("a", "footer"), renderer.getRootChildIds())
        assertEquals(listOf("other"), renderer.getDetachedIds())
        assertNotNull(renderer.getElement("other"))
    }

    @Test
    fun `removing one of several roots keeps the rest`() {
        renderer.applyPatches(
            texts("a", "b", "c") + listOf("a", "b", "c").map { Patch.insert("root", it) },
        )
        renderer.applyPatches(listOf(Patch.remove("b")))
        assertEquals(listOf("a", "c"), renderer.getRootChildIds())
        assertNull(renderer.getElement("b"))
        renderer.applyPatches(listOf(Patch.remove("a"), Patch.remove("c")))
        assertEquals(emptyList<String>(), renderer.getRootChildIds())
        assertNull(renderer.getRootId())
    }

    @Test
    fun `a root child moved under an element leaves the root list, and back`() {
        renderer.applyPatches(
            listOf(Patch.create("col", "column")) + texts("x") +
                listOf(Patch.insert("root", "col"), Patch.insert("root", "x")),
        )
        renderer.applyPatches(listOf(Patch.move("col", "x")))
        assertEquals(listOf("col"), renderer.getRootChildIds())
        assertEquals(listOf("x"), renderer.getElement("col")!!.children)

        renderer.applyPatches(listOf(Patch.move("root", "x", "col")))
        assertEquals(listOf("x", "col"), renderer.getRootChildIds())
        assertTrue(renderer.getElement("col")!!.children.isEmpty())
        assertNull(renderer.getElement("x")!!.parentId)
    }

    @Test
    fun `a created but not yet inserted node is not a root child`() {
        renderer.applyPatches(texts("a"))
        assertEquals(emptyList<String>(), renderer.getRootChildIds())
    }

    @Test
    fun `clear empties the root list`() {
        renderer.applyPatches(texts("a", "b") + listOf(Patch.insert("root", "a"), Patch.insert("root", "b")))
        renderer.clear()
        assertEquals(emptyList<String>(), renderer.getRootChildIds())
    }

    @Test
    fun `hasRendered latches on the first root insert and survives an empty root`() {
        assertFalse(renderer.hasRendered())
        renderer.applyPatches(texts("a"))
        assertFalse("a created-only node is not a render", renderer.hasRendered())
        renderer.applyPatches(listOf(Patch.insert("root", "a")))
        assertTrue(renderer.hasRendered())
        // A root If turning off empties the root: no longer "loading".
        renderer.applyPatches(listOf(Patch.remove("a")))
        assertEquals(emptyList<String>(), renderer.getRootChildIds())
        assertTrue(renderer.hasRendered())
    }

    @Test
    fun `hasRendered latches on a root attach and resets on clear`() {
        renderer.applyPatches(texts("a") + listOf(Patch.insert("root", "a"), Patch.detach("a")))
        renderer.clear()
        assertFalse(renderer.hasRendered())
        renderer.applyPatches(texts("b") + listOf(Patch.insert("root", "b"), Patch.detach("b")))
        assertTrue(renderer.hasRendered())
        assertEquals(emptyList<String>(), renderer.getRootChildIds())
        renderer.applyPatches(listOf(Patch.attach("root", "b")))
        assertTrue(renderer.hasRendered())
        assertEquals(listOf("b"), renderer.getRootChildIds())
    }

    @Test
    fun `an exiting root child stays in place until its exit finalizes`() = runTest {
        val r = ComposeRenderer(animation = AnimationCoordinator(AlwaysAnimate, backgroundScope))
        val exit = mapOf("presets" to listOf("fade"), "duration" to 150.0, "curve" to "easeIn")
        r.applyPatches(
            listOf(
                Patch.create("banner", "text", mapOf(ANIM_EXIT_PROP to exit)),
                Patch.create("body", "text"),
                Patch.insert("root", "banner"),
                Patch.insert("root", "body"),
            ),
        )
        r.applyPatches(listOf(Patch.remove("banner", transition = true)))
        assertEquals(listOf("banner", "body"), r.getRootChildIds())

        // A sibling landing mid-exit anchors on live nodes; the corpse keeps its slot.
        r.applyPatches(listOf(Patch.create("new", "text"), Patch.insert("root", "new", beforeId = "body")))
        assertEquals(listOf("banner", "new", "body"), r.getRootChildIds())

        advanceTimeBy(231)
        runCurrent()
        assertNull(r.getElement("banner"))
        assertEquals(listOf("new", "body"), r.getRootChildIds())
    }
}
