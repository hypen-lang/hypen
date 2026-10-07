package space.hypen.renderer.dnd

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.anim.AlwaysAnimate
import space.hypen.renderer.anim.AnimationCoordinator
import space.hypen.renderer.model.Patch
import space.hypen.renderer.render.ActionDispatcher
import space.hypen.renderer.render.ComposeRenderer

/**
 * The DnD protocol as it is actually driven — through patches applied to a
 * real [ComposeRenderer] (the pure patch-consumer idiom: the `props` blocks
 * below are the byte-exact `Create` wire of
 * `engine-compatibility-tests/fixtures/dnd/ JSON fixtures`). These exercise the
 * renderer-level hooks the coordinator tests assume: channel routing off
 * `Create`/`SetProp`, the pose overlay on the element's props, the translate
 * deferral gate, hold release on the engine's `Move`, and the silent cancel
 * on `Remove`/`Detach`/exit-flagged removes.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DndRendererTest {
    private class Harness(scope: CoroutineScope) {
        val dispatched = mutableListOf<Pair<String, Map<String, Any?>?>>()
        val dnd = DndCoordinator(AlwaysAnimate, scope)
        val renderer =
            ComposeRenderer(animation = AnimationCoordinator(AlwaysAnimate, scope), dnd = dnd).also { r ->
                r.setActionDispatcher(ActionDispatcher { action, payload -> @Suppress("UNCHECKED_CAST")
                    dispatched.add(if (action == "__hypen_dispatch") (payload!!["action"] as String) to (payload["payload"] as Map<String, Any?>) else action to payload) })
            }

        val actions: List<String> get() = dispatched.map { it.first }

        /** The `sortable-lowering` fixture wire, three rows. */
        fun sortableTree() {
            renderer.applyPatches(
                listOf(
                    Patch.create(
                        "col",
                        "Column",
                        mapOf(
                            "__dnd.sort" to mapOf("group" to null, "axis" to "y"),
                            "bind" to "tasks",
                            "onSort.0" to "@reorder",
                            "onDragEnd.0" to "@ended",
                        ),
                    ),
                    Patch.create("fe", "ForEach"),
                    Patch.create("r1", "Row"),
                    Patch.create("r2", "Row"),
                    Patch.create("r3", "Row"),
                    Patch.create(
                        "t1",
                        "Text",
                        mapOf(
                            "0" to "A",
                            "opacity.0" to 1.0,
                            "__dnd.key" to "t1",
                            "__dnd.source" to mapOf("group" to null, "handle" to false, "activation" to "auto"),
                            "__dnd.sourcePayload" to mapOf("id" to "t1", "title" to "A"),
                            "__anim.states" to mapOf("label" to null, "runtime" to true),
                            "__anim.statePoses" to mapOf("lifted" to mapOf("opacity.0" to 0.6, "scale.0" to 1.04)),
                        ),
                    ),
                    Patch.create(
                        "t2",
                        "Text",
                        mapOf(
                            "0" to "B",
                            "__dnd.key" to "t2",
                            "__dnd.source" to mapOf("group" to null, "handle" to false, "activation" to "auto"),
                            "__dnd.sourcePayload" to mapOf("id" to "t2", "title" to "B"),
                        ),
                    ),
                    Patch.create(
                        "t3",
                        "Text",
                        mapOf(
                            "0" to "C",
                            "__dnd.key" to "t3",
                            "__dnd.source" to mapOf("group" to null, "handle" to false, "activation" to "auto"),
                        ),
                    ),
                    Patch.insert("root", "col"),
                    Patch.insert("col", "fe"),
                    Patch.insert("fe", "r1"),
                    Patch.insert("fe", "r2"),
                    Patch.insert("fe", "r3"),
                    Patch.insert("r1", "t1"),
                    Patch.insert("r2", "t2"),
                    Patch.insert("r3", "t3"),
                ),
            )
            dnd.updateBounds("col", 0f, 0f, 200f, 300f, 1f)
            for ((i, n) in listOf("1", "2", "3").withIndex()) {
                dnd.updateBounds("r$n", 0f, i * 100f, 200f, i * 100f + 100f, 1f)
                dnd.updateBounds("t$n", 0f, i * 100f, 200f, i * 100f + 100f, 1f)
            }
        }
    }

    @Test
    fun `channels route off Create and the runtime sees the fixture shape`() = runTest {
        val h = Harness(backgroundScope)
        h.sortableTree()
        assertEquals(DndRole(isSource = true, needsBounds = true, sortAxis = DndAxis.Y), h.dnd.roleFor("t1"))
        assertEquals(DndRole(isSource = false, needsBounds = true, sortAxis = null), h.dnd.roleFor("r1"))
        assertEquals(DndRole.None, h.dnd.roleFor("fe"))
        // `__dnd.*` and `__anim.statePoses` stay ordinary props on the element.
        assertEquals("t1", h.renderer.getElement("t1")!!.props["__dnd.key"])
    }

    @Test
    fun `a full sortable drop dispatches in contract order and holds until the Move`() = runTest {
        val h = Harness(backgroundScope)
        h.sortableTree()
        assertTrue(h.dnd.claim("t1", 10f, 10f))
        h.dnd.move("t1", 0f, 150f)
        assertTrue("nothing crosses the engine boundary during the drag", h.dispatched.isEmpty())
        h.dnd.drop("t1")

        assertEquals(listOf(DND_REORDER_ACTION, "reorder", "ended"), h.actions)
        assertEquals(mapOf("path" to "tasks", "from" to 0, "to" to 1), h.dispatched[0].second)
        assertEquals(
            mapOf(
                "item" to "t1",
                "payload" to mapOf("id" to "t1", "title" to "A"),
                "from" to mapOf("zone" to "col", "index" to 0),
                "to" to mapOf("zone" to "col", "index" to 1),
                "dropped" to true,
            ),
            h.dispatched[2].second,
        )
        assertTrue(h.dnd.isHolding())

        // The host applied the reorder; the engine moves the row (no rebuild).
        h.renderer.applyPatches(listOf(Patch.move("fe", "r1", "r3")))
        assertFalse(h.dnd.isDragging())
        assertEquals(listOf("r2", "r1", "r3"), h.renderer.getElement("fe")!!.children.toList())
        assertEquals(3, h.dispatched.size)
    }

    @Test
    fun `the lifted pose overlays the element's props and restores the base`() = runTest {
        val h = Harness(backgroundScope)
        h.sortableTree()
        val t1 = h.renderer.getElement("t1")!!
        val revision = t1.propsRevision
        assertEquals(1.0, t1.props["opacity.0"])
        assertFalse(t1.props.containsKey("scale.0"))

        h.dnd.claim("t1", 10f, 10f)
        assertEquals(0.6, t1.props["opacity.0"])
        assertEquals(1.04, t1.props["scale.0"])
        assertEquals("the engine value is untouched", 1.0, t1.rawProps["opacity.0"])
        assertTrue(t1.hasPoseOverrides)
        assertTrue("the modifier chain recomputes", t1.propsRevision > revision)

        // An engine write to a pose-overridden key lands in the base and shows through at clear.
        h.renderer.applyPatches(listOf(Patch.setProp("t1", "opacity.0", 0.9)))
        assertEquals(0.6, t1.props["opacity.0"])
        assertEquals(0.9, t1.rawProps["opacity.0"])

        h.dnd.cancel("t1")
        assertEquals(0.9, t1.props["opacity.0"])
        assertFalse(t1.props.containsKey("scale.0"))
        assertFalse(t1.hasPoseOverrides)
    }

    @Test
    fun `engine translate writes on the dragged node are deferred until release`() = runTest {
        val h = Harness(backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create(
                    "board",
                    "Stack",
                    mapOf(
                        "__dnd.pin" to mapOf("group" to "board", "xKey" to "x", "yKey" to "y", "grid" to null, "bounds" to "clamp", "units" to "px"),
                    ),
                ),
                Patch.create("fe", "ForEach"),
                Patch.create(
                    "n1",
                    "Note",
                    mapOf(
                        "__dnd.key" to "n1",
                        "__dnd.pinGroup" to "board",
                        "__dnd.source" to mapOf("group" to null, "handle" to false, "activation" to "auto"),
                        "translateX.0" to null,
                        "translateY.0" to null,
                    ),
                ),
                Patch.insert("root", "board"),
                Patch.insert("board", "fe"),
                Patch.insert("fe", "n1"),
            ),
        )
        h.dnd.updateBounds("board", 0f, 0f, 400f, 400f, 1f)
        h.dnd.updateBounds("n1", 0f, 0f, 50f, 50f, 1f)
        val n1 = h.renderer.getElement("n1")!!
        assertTrue("null translate is PRESENT on create", n1.rawProps.containsKey("translateX.0"))
        assertNull(n1.rawProps["translateX.0"])

        h.dnd.claim("n1", 5f, 5f)
        h.dnd.move("n1", 120f, 80f)
        // A write from elsewhere (another client pinned the same note) is held.
        h.renderer.applyPatches(listOf(Patch.setProp("n1", "translateX.0", 7.0)))
        assertNull("deferred: not applied while lifted", n1.rawProps["translateX.0"])

        h.dnd.drop("n1")
        assertEquals(listOf(DND_PIN_ACTION), h.actions)
        assertEquals(
            mapOf("path" to "__dnd.board.n1", "x" to 120.0, "y" to 80.0, "xKey" to "x", "yKey" to "y"),
            h.dispatched[0].second,
        )
        // The engine's re-render lands: exactly SetProp translateX.0 / translateY.0.
        h.renderer.applyPatches(
            listOf(Patch.setProp("n1", "translateX.0", 120.0), Patch.setProp("n1", "translateY.0", 80.0)),
        )
        assertFalse(h.dnd.isDragging())
        assertEquals(120.0, n1.rawProps["translateX.0"])
        assertEquals(80.0, n1.rawProps["translateY.0"])
        assertEquals(0f, h.dnd.stateFor("n1").ghostX)
    }

    @Test
    fun `a Remove of the dragged row mid-drag dispatches nothing`() = runTest {
        val h = Harness(backgroundScope)
        h.sortableTree()
        h.dnd.claim("t1", 10f, 10f)
        h.dnd.move("t1", 0f, 150f)
        h.renderer.applyPatches(listOf(Patch.remove("r1")))
        assertTrue(h.dispatched.isEmpty())
        assertFalse(h.dnd.isDragging())
        assertNull(h.renderer.getElement("t1"))
        assertEquals(0f, h.dnd.stateFor("r2").shiftY)
    }

    @Test
    fun `a Detach of the route mid-drag dispatches nothing`() = runTest {
        val h = Harness(backgroundScope)
        h.sortableTree()
        h.dnd.claim("t1", 10f, 10f)
        h.renderer.applyPatches(listOf(Patch.detach("col")))
        assertTrue(h.dispatched.isEmpty())
        assertFalse(h.dnd.isDragging())
        // The subtree came back: the runtime still knows its roles.
        h.renderer.applyPatches(listOf(Patch.attach("root", "col")))
        assertEquals(DndRole(isSource = true, needsBounds = true, sortAxis = DndAxis.Y), h.dnd.roleFor("t1"))
    }

    @Test
    fun `an exit-flagged remove cancels silently and the source cannot dispatch afterwards`() = runTest {
        val h = Harness(backgroundScope)
        h.renderer.applyPatches(
            listOf(
                Patch.create(
                    "card",
                    "Card",
                    mapOf(
                        "__anim.exit" to mapOf("presets" to listOf("fade"), "duration" to 150.0, "curve" to "easeIn"),
                        "__dnd.source" to mapOf("group" to null, "handle" to false, "activation" to "auto"),
                        "onDragEnd.0" to "@ended",
                    ),
                ),
                Patch.insert("root", "card"),
            ),
        )
        h.dnd.updateBounds("card", 0f, 0f, 100f, 100f, 1f)
        h.dnd.claim("card", 5f, 5f)
        h.renderer.applyPatches(listOf(Patch.remove("card", transition = true)))
        assertFalse(h.dnd.isDragging())
        assertTrue(h.dispatched.isEmpty())
        // Engine-side dead: even a new lift on the corpse reaches nothing.
        h.dnd.claim("card", 5f, 5f)
        h.dnd.cancel("card")
        assertTrue(h.dispatched.isEmpty())
        advanceTimeBy(231)
        runCurrent()
        assertNull(h.renderer.getElement("card"))
    }

    @Test
    fun `clear resets the drag runtime`() = runTest {
        val h = Harness(backgroundScope)
        h.sortableTree()
        h.dnd.claim("t1", 10f, 10f)
        h.renderer.clear()
        assertFalse(h.dnd.isDragging())
        assertEquals(DndRole.None, h.dnd.roleFor("t1"))
        assertTrue(h.dispatched.isEmpty())
    }

    @Test
    fun `a re-resolved bindable channel flips the role in place`() = runTest {
        val h = Harness(backgroundScope)
        h.sortableTree()
        h.renderer.applyPatches(listOf(Patch.setProp("t1", "__dnd.sourceEnabled", false)))
        assertNull(h.dnd.activationFor("t1", touch = false))
        assertFalse(h.dnd.claim("t1", 10f, 10f))
        h.renderer.applyPatches(listOf(Patch.setProp("t1", "__dnd.sourceEnabled", true)))
        assertEquals(DndActivationPlan.Slop, h.dnd.activationFor("t1", touch = false))
    }
}
