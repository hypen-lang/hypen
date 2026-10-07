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

/**
 * Protocol conformance for [DndCoordinator] — the layer that decides WHAT a
 * drag means. Driven exactly the way the renderer drives it (the patch hooks
 * build the tree mirror, the Compose layer reports bounds and claims / moves
 * / drops), against a recording host. Everything asserted here is renderer
 * behaviour from plan §4 / §6: dispatch order and byte-exact payloads, zone
 * resolution, the sortable preview, poses, the post-drop hold, deferral, and
 * silent cancellation.
 *
 * The coordinator takes its scheduler by injection, so dwell and hold timers
 * run on `runTest`'s virtual clock.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DndCoordinatorTest {
    private class RecordingHost : DndHost {
        val dispatched = mutableListOf<Pair<String, Map<String, Any?>>>()
        val applied = mutableListOf<Triple<String, String, Any?>>()
        /** `id → pose` for an overlay, `id → null` for a clear, in order. */
        val poses = mutableListOf<Pair<String, Map<String, Any?>?>>()

        override fun dispatch(sourceId: String, action: String, payload: Map<String, Any?>) {
            @Suppress("UNCHECKED_CAST")
            dispatched.add(if (action == "__hypen_dispatch") (payload["action"] as String) to (payload["payload"] as Map<String, Any?>) else action to payload)
        }

        override fun applyProp(id: String, name: String, value: Any?) {
            applied.add(Triple(id, name, value))
        }

        override fun setPoseOverrides(id: String, pose: Map<String, Any?>) {
            poses.add(id to pose)
        }

        override fun clearPoseOverrides(id: String) {
            poses.add(id to null)
        }

        val actions: List<String> get() = dispatched.map { it.first }
    }

    private class Harness(scope: CoroutineScope) {
        val host = RecordingHost()
        val dnd = DndCoordinator(AlwaysAnimate, scope).also { it.setHost(host) }

        fun create(id: String, type: String, props: Map<String, Any?> = emptyMap()) = dnd.noteCreate(id, type, props)

        fun insert(parent: String, id: String, before: String? = null) = dnd.noteInsert(parent, id, before)

        fun rect(id: String, l: Float, t: Float, r: Float, b: Float, density: Float = 1f) =
            dnd.updateBounds(id, l, t, r, b, density)

        /**
         * `Column { ForEach { Row { Text().draggable(payload:) } } }.sortable().bind(...)`
         * — the `sortable-lowering` fixture: the Text INSIDE the Row carries
         * `__dnd.key` + `__dnd.source`; the Row is the item that moves. Rows
         * are 100px tall, stacked from [top].
         */
        fun sortable(
            id: String,
            keys: List<String>,
            top: Float = 0f,
            left: Float = 0f,
            group: String? = null,
            bind: String? = "tasks",
            extra: Map<String, Any?> = emptyMap(),
            sourceGroup: String? = null,
        ) {
            val props = LinkedHashMap<String, Any?>()
            props["__dnd.sort"] = mapOf("group" to group, "axis" to "y")
            if (bind != null) props["bind"] = bind
            props.putAll(extra)
            create(id, "Column", props)
            create("$id-fe", "ForEach")
            insert(id, "$id-fe")
            keys.forEachIndexed { i, key ->
                val row = "$id-row-$key"
                val text = "$id-text-$key"
                create(row, "Row")
                create(
                    text,
                    "Text",
                    mapOf(
                        "__dnd.key" to key,
                        "__dnd.source" to mapOf("group" to sourceGroup, "handle" to false, "activation" to "auto"),
                        "__dnd.sourcePayload" to mapOf("id" to key),
                    ),
                )
                insert("$id-fe", row)
                insert(row, text)
                val y = top + i * 100f
                rect(row, left, y, left + 200f, y + 100f)
                rect(text, left, y, left + 200f, y + 100f)
            }
            rect(id, left, top, left + 200f, top + keys.size * 100f)
        }
    }

    @Test
    fun `fractional positions reproject when board bounds change without dispatch`() = runTest {
        val h = Harness(backgroundScope)
        h.create("board", "Stack", mapOf("__dnd.pin" to mapOf("group" to "board", "units" to "fraction")))
        h.create("note", "Note", mapOf("__dnd.source" to mapOf("group" to null), "__dnd.pinX" to 0.5, "__dnd.pinY" to 0.25))
        h.insert("root", "board")
        h.insert("board", "note")
        h.rect("board", 0f, 0f, 400f, 300f)
        assertEquals(200f, h.dnd.stateFor("note").pinX)
        assertEquals(75f, h.dnd.stateFor("note").pinY)
        h.rect("board", 0f, 0f, 600f, 400f)
        assertEquals(300f, h.dnd.stateFor("note").pinX)
        assertEquals(100f, h.dnd.stateFor("note").pinY)
        assertTrue(h.host.dispatched.isEmpty())
    }

    private val payloadT1 = mapOf("id" to "t1")

    // ---------------------------------------------------------- activation

    @Test
    fun `auto activation - mouse slops, touch in a sortable cross-slops, loose touch presses`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"))
        h.create("loose", "Card", mapOf("__dnd.source" to mapOf("group" to null, "handle" to false, "activation" to "auto")))
        h.insert("root", "loose")

        assertEquals(DndActivationPlan.Slop, h.dnd.activationFor("col-text-t1", touch = false))
        assertEquals(DndActivationPlan.CrossAxisSlop(DndAxis.X), h.dnd.activationFor("col-text-t1", touch = true))
        assertEquals(DndActivationPlan.Press, h.dnd.activationFor("loose", touch = true))
        assertEquals(DndActivationPlan.Slop, h.dnd.activationFor("loose", touch = false))
    }

    @Test
    fun `explicit activation, disabled sources and non-sources`() = runTest {
        val h = Harness(backgroundScope)
        h.create("press", "Card", mapOf("__dnd.source" to mapOf("activation" to "press")))
        h.create("now", "Card", mapOf("__dnd.source" to mapOf("activation" to "immediate")))
        h.create("off", "Card", mapOf("__dnd.source" to mapOf("activation" to "auto"), "__dnd.sourceEnabled" to false))
        h.create("plain", "Card")
        assertEquals(DndActivationPlan.Press, h.dnd.activationFor("press", touch = false))
        assertEquals(DndActivationPlan.Immediate, h.dnd.activationFor("now", touch = true))
        assertNull(h.dnd.activationFor("off", touch = false))
        assertNull(h.dnd.activationFor("plain", touch = false))
        assertNull(h.dnd.activationFor("missing", touch = false))

        // A bound enabled flag flipping back on re-arms the source.
        assertFalse(h.dnd.noteSetProp("off", "__dnd.sourceEnabled", true))
        assertEquals(DndActivationPlan.Slop, h.dnd.activationFor("off", touch = false))
    }

    @Test
    fun `no drag claims while another drag or its hold is in flight`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"))
        assertTrue(h.dnd.claim("col-text-t1", 10f, 10f))
        assertNull(h.dnd.activationFor("col-text-t2", touch = false))
        assertFalse(h.dnd.claim("col-text-t2", 10f, 10f))
    }

    // -------------------------------------------------- roles for the modifier

    @Test
    fun `roles - sources, zones and sortable rows need bounds, plain nodes do not`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1"))
        h.create("zone", "Row", mapOf("__dnd.zone" to mapOf("group" to "fs", "band" to 0.5)))
        h.create("plain", "Text")
        h.insert("root", "zone")
        h.insert("root", "plain")

        assertEquals(DndRole(isSource = true, needsBounds = true, sortAxis = DndAxis.Y), h.dnd.roleFor("col-text-t1"))
        assertEquals(DndRole(isSource = false, needsBounds = true, sortAxis = null), h.dnd.roleFor("col-row-t1"))
        assertEquals(DndRole(isSource = false, needsBounds = true, sortAxis = null), h.dnd.roleFor("zone"))
        assertEquals(DndRole(isSource = false, needsBounds = true, sortAxis = null), h.dnd.roleFor("col"))
        assertEquals(DndRole.None, h.dnd.roleFor("plain"))
        assertEquals(DndRole.None, h.dnd.roleFor("col-fe"))
    }

    // ---------------------------------------------------- sortable reorder

    @Test
    fun `same-list reorder - reserved shorthand, then onSort, then onDragEnd, then hold until Move`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2", "t3"), extra = mapOf("onSort.0" to "@reorder", "onDragEnd.0" to "@ended"))

        assertTrue(h.dnd.claim("col-text-t1", 10f, 10f))
        // Zero engine traffic during the drag: no onDragStart bound, nothing sent.
        assertTrue(h.host.dispatched.isEmpty())
        val row = h.dnd.stateFor("col-row-t1")
        assertTrue("the sortable's direct child is the ghost", row.lifted)

        // Pointer from (10,10) to (10,160): past t2's midpoint (150) → slot 1.
        h.dnd.move("col-text-t1", 0f, 150f)
        assertEquals(150f, row.ghostY)
        assertEquals(0f, row.ghostX)
        assertEquals(DndLocation("col", 1), h.dnd.currentTarget())
        // t2 shifts up to open the gap; t3 stays.
        assertEquals(-100f, h.dnd.stateFor("col-row-t2").shiftY)
        assertEquals(0f, h.dnd.stateFor("col-row-t3").shiftY)
        assertTrue(h.dnd.ownsNode("col-row-t2"))
        assertTrue(h.dnd.ownsNode("col-text-t1"))
        assertFalse(h.dnd.ownsNode("col-row-t3"))
        assertTrue(h.host.dispatched.isEmpty())

        h.dnd.drop("col-text-t1")

        assertEquals(listOf(DND_REORDER_ACTION, "reorder", "ended"), h.host.actions)
        assertEquals(mapOf("path" to "tasks", "from" to 0, "to" to 1), h.host.dispatched[0].second)
        val expected =
            mapOf(
                "item" to "t1",
                "payload" to payloadT1,
                "from" to mapOf("zone" to "col", "index" to 0),
                "to" to mapOf("zone" to "col", "index" to 1),
            )
        assertEquals(expected, h.host.dispatched[1].second)
        assertEquals(listOf("item", "payload", "from", "to"), h.host.dispatched[1].second.keys.toList())
        assertEquals(expected + mapOf("dropped" to true), h.host.dispatched[2].second)
        assertEquals(listOf("item", "payload", "from", "to", "dropped"), h.host.dispatched[2].second.keys.toList())

        // The hold: transforms stay until the engine's Move lands.
        assertTrue(h.dnd.isHolding())
        assertTrue(row.lifted)
        assertEquals(150f, row.ghostY)
        assertEquals(-100f, h.dnd.stateFor("col-row-t2").shiftY)

        // Engine re-render: Move row t1 before t3 under the ForEach wrapper.
        h.insert("col-fe", "col-row-t1", "col-row-t3")
        assertFalse(h.dnd.isDragging())
        assertFalse(row.lifted)
        assertEquals(0f, row.ghostY)
        assertEquals(0f, h.dnd.stateFor("col-row-t2").shiftY)
        assertFalse("shifts snap back at release", h.dnd.shiftMotion)
        // Nothing else was dispatched by the release.
        assertEquals(3, h.host.dispatched.size)
    }

    @Test
    fun `the hold falls back to the timeout`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"))
        h.dnd.claim("col-text-t1", 10f, 10f)
        h.dnd.move("col-text-t1", 0f, 150f)
        h.dnd.drop("col-text-t1")
        assertTrue(h.dnd.isHolding())
        advanceTimeBy(499)
        runCurrent()
        assertTrue(h.dnd.isHolding())
        advanceTimeBy(1)
        runCurrent()
        assertFalse(h.dnd.isDragging())
        assertEquals(0f, h.dnd.stateFor("col-row-t1").ghostY)
    }

    @Test
    fun `a drop back on the origin slot writes nothing and fires only onDragEnd`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"), extra = mapOf("onSort.0" to "@reorder", "onDragEnd.0" to "@ended"))
        h.dnd.claim("col-text-t2", 10f, 10f)
        h.dnd.move("col-text-t2", 0f, 5f) // still over slot 1
        h.dnd.drop("col-text-t2")
        assertEquals(listOf("ended"), h.host.actions)
        assertEquals(true, h.host.dispatched[0].second["dropped"])
        // No hold either: nothing changed, nothing to wait for.
        assertFalse(h.dnd.isDragging())
    }

    @Test
    fun `moving down two slots and back up keeps the preview stable`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2", "t3"))
        h.dnd.claim("col-text-t1", 10f, 10f)
        h.dnd.move("col-text-t1", 0f, 250f) // pointer y = 260 → past both midpoints → slot 2
        assertEquals(DndLocation("col", 2), h.dnd.currentTarget())
        assertEquals(-100f, h.dnd.stateFor("col-row-t2").shiftY)
        assertEquals(-100f, h.dnd.stateFor("col-row-t3").shiftY)
        h.dnd.move("col-text-t1", 0f, -240f) // pointer y = 20 → slot 0
        assertEquals(DndLocation("col", 0), h.dnd.currentTarget())
        assertEquals(0f, h.dnd.stateFor("col-row-t2").shiftY)
        assertEquals(0f, h.dnd.stateFor("col-row-t3").shiftY)
    }

    @Test
    fun `dragging an unbound sortable fires onSort without a reserved write`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"), bind = null, extra = mapOf("onSort.0" to "@reorder"))
        h.dnd.claim("col-text-t1", 10f, 10f)
        h.dnd.move("col-text-t1", 0f, 150f)
        h.dnd.drop("col-text-t1")
        assertEquals(listOf("reorder"), h.host.actions)
    }

    // -------------------------------------------------------- cross-list

    @Test
    fun `cross-list drop between grouped sortables dispatches the long form on the destination`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("todo", listOf("a", "b"), group = "board", bind = "todo", extra = mapOf("onSort.0" to "@persist"))
        h.sortable("doing", listOf("c"), left = 300f, group = "board", bind = "doing", extra = mapOf("onSort.0" to "@persistDoing"))

        h.dnd.claim("todo-text-a", 10f, 10f)
        // Into the doing column, below its only row → append (slot 1).
        h.dnd.move("todo-text-a", 300f, 80f) // pointer (310, 90): c's midpoint is 50 → slot 1
        assertEquals(DndLocation("board", 1), h.dnd.currentTarget())
        // The foreign list opens no gap for an append; the origin closes its own.
        assertEquals(0f, h.dnd.stateFor("doing-row-c").shiftY)
        assertEquals(0f, h.dnd.stateFor("todo-row-b").shiftY)
        h.dnd.drop("todo-text-a")

        assertEquals(listOf(DND_REORDER_ACTION, "persistDoing"), h.host.actions)
        assertEquals(
            mapOf("fromPath" to "todo", "from" to 0, "toPath" to "doing", "to" to 1),
            h.host.dispatched[0].second,
        )
        assertEquals(mapOf("zone" to "board", "index" to 0), h.host.dispatched[1].second["from"])
        assertEquals(mapOf("zone" to "board", "index" to 1), h.host.dispatched[1].second["to"])

        // A Move under the destination releases the hold.
        h.insert("doing-fe", "todo-row-a")
        assertFalse(h.dnd.isDragging())
    }

    @Test
    fun `cross-list drop between a bound and an unbound sortable writes nothing but fires onSort`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("todo", listOf("a"), group = "board", bind = "todo")
        h.sortable("doing", listOf("c"), left = 300f, group = "board", bind = null, extra = mapOf("onSort.0" to "@sorted"))
        h.dnd.claim("todo-text-a", 10f, 10f)
        h.dnd.move("todo-text-a", 300f, 10f)
        h.dnd.drop("todo-text-a")
        assertEquals(listOf("sorted"), h.host.actions)
    }

    @Test
    fun `an ungrouped sortable is self-only`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("a", listOf("x"))
        h.sortable("b", listOf("y"), left = 300f, extra = mapOf("onSort.0" to "@sorted", "onDragEnd.0" to "@ended"))
        h.dnd.claim("a-text-x", 10f, 10f)
        h.dnd.move("a-text-x", 300f, 10f)
        assertNull("no compatible target under the pointer", h.dnd.currentTarget())
        h.dnd.drop("a-text-x")
        // Dropped nowhere: cancel semantics, `.onDragEnd {dropped:false}` on the origin.
        assertTrue(h.host.dispatched.isEmpty()) // origin `a` has no onDragEnd binding
        assertFalse(h.dnd.isDragging())
    }

    // ------------------------------------------------------------- zones

    @Test
    fun `a grouped drop zone accepts a grouped source and fires onDrop with into semantics`() = runTest {
        val h = Harness(backgroundScope)
        h.create("page", "Column")
        h.insert("root", "page")
        h.create(
            "card",
            "Card",
            mapOf(
                "__dnd.source" to mapOf("group" to "fs", "handle" to false, "activation" to "auto"),
                "__dnd.key" to "f1",
                "onDragStart.0" to "@started",
                "onDragEnd.0" to "@ended",
            ),
        )
        h.insert("page", "card")
        h.rect("card", 0f, 0f, 100f, 50f)
        h.create(
            "trash",
            "Row",
            mapOf(
                "__dnd.zone" to mapOf("group" to "fs", "band" to 0.3),
                "__dnd.zoneId" to "trash",
                "__dnd.zoneEnabled" to true,
                "onDrop" to mapOf("0" to "@actions.moveInto", "kind" to "bin", "item" to "spoofed"),
                "__anim.statePoses" to mapOf("over" to mapOf("backgroundColor.0" to "#eee")),
            ),
        )
        h.insert("page", "trash")
        h.rect("trash", 0f, 300f, 200f, 400f)

        h.dnd.claim("card", 5f, 5f)
        assertEquals(listOf("started"), h.host.actions)
        assertEquals(
            mapOf(
                "item" to "f1",
                "from" to mapOf("zone" to "page", "index" to null),
                "to" to mapOf("zone" to "page", "index" to null),
            ),
            h.host.dispatched[0].second,
        )
        assertFalse("no payload key without __dnd.sourcePayload", h.host.dispatched[0].second.containsKey("payload"))

        h.dnd.move("card", 0f, 340f) // pointer (5, 345) inside the trash
        assertEquals(DndLocation("trash", null), h.dnd.currentTarget())
        assertEquals(listOf<Pair<String, Map<String, Any?>?>>("trash" to mapOf("backgroundColor.0" to "#eee")), h.host.poses)

        h.dnd.drop("card")
        assertEquals(listOf("started", "moveInto", "ended"), h.host.actions)
        val drop = h.host.dispatched[1].second
        // Custom args merge UNDER the §4.2 payload: `kind` survives, `item` is not spoofable.
        assertEquals("bin", drop["kind"])
        assertEquals("f1", drop["item"])
        assertEquals(mapOf("zone" to "trash", "index" to null), drop["to"])
        assertEquals(listOf("kind", "item", "from", "to"), drop.keys.toList())
        // The over pose stays through the hold and clears at release.
        assertEquals("over", h.dnd.poseLabelOf("trash"))
        advanceTimeBy(500)
        runCurrent()
        assertEquals("trash" to null, h.host.poses.last())
        assertNull(h.dnd.poseLabelOf("trash"))
    }

    @Test
    fun `a disabled or foreign-group zone is not a target`() = runTest {
        val h = Harness(backgroundScope)
        h.create("card", "Card", mapOf("__dnd.source" to mapOf("group" to "cards")))
        h.insert("root", "card")
        h.rect("card", 0f, 0f, 100f, 50f)
        h.create("off", "Row", mapOf("__dnd.zone" to mapOf("group" to "cards", "band" to 0.5), "__dnd.zoneEnabled" to false))
        h.insert("root", "off")
        h.rect("off", 0f, 100f, 200f, 200f)
        h.create("other", "Row", mapOf("__dnd.zone" to mapOf("group" to "other", "band" to 0.5)))
        h.insert("root", "other")
        h.rect("other", 0f, 200f, 200f, 300f)

        h.dnd.claim("card", 5f, 5f)
        h.dnd.move("card", 0f, 145f)
        assertNull(h.dnd.currentTarget())
        h.dnd.move("card", 0f, 100f)
        assertNull(h.dnd.currentTarget())
        // Flipping enabled mid-drag makes the zone live on the next move.
        h.dnd.noteSetProp("off", "__dnd.zoneEnabled", true)
        h.dnd.move("card", 0f, -100f)
        assertEquals(DndLocation("off", null), h.dnd.currentTarget())
    }

    @Test
    fun `innermost zone wins`() = runTest {
        val h = Harness(backgroundScope)
        h.create("card", "Card", mapOf("__dnd.source" to mapOf("group" to "fs")))
        h.insert("root", "card")
        h.rect("card", 0f, 0f, 50f, 50f)
        h.create("outer", "Column", mapOf("__dnd.zone" to mapOf("group" to "fs", "band" to 0.5), "id.0" to "outer-zone"))
        h.insert("root", "outer")
        h.rect("outer", 0f, 100f, 400f, 500f)
        h.create("inner", "Row", mapOf("__dnd.zone" to mapOf("group" to "fs", "band" to 0.5), "__dnd.zoneId" to "inner-zone"))
        h.insert("outer", "inner")
        h.rect("inner", 100f, 200f, 300f, 300f)

        h.dnd.claim("card", 5f, 5f)
        h.dnd.move("card", 145f, 245f) // (150, 250): inside both
        assertEquals(DndLocation("inner-zone", null), h.dnd.currentTarget())
        h.dnd.move("card", -140f, 0f) // (10, 250): outer only → resolved `id` prop is its label
        assertEquals(DndLocation("outer-zone", null), h.dnd.currentTarget())
    }

    @Test
    fun `a drop zone on a sortable row uses the band rule`() = runTest {
        val h = Harness(backgroundScope)
        // File manager: rows are draggable AND folders are zones (fixture §4.5).
        h.create("fs", "Column", mapOf("__dnd.sort" to mapOf("group" to "fs", "axis" to "y"), "bind" to "entries"))
        h.create("fs-fe", "ForEach")
        h.insert("fs", "fs-fe")
        for ((i, key) in listOf("file", "folder").withIndex()) {
            val props =
                LinkedHashMap<String, Any?>(
                    mapOf(
                        "__dnd.key" to key,
                        "__dnd.source" to mapOf("group" to "fs", "handle" to false, "activation" to "auto"),
                    ),
                )
            if (key == "folder") {
                props["__dnd.zone"] = mapOf("group" to "fs", "band" to 0.5)
                props["__dnd.zoneId"] = "folder-id"
                props["onDrop.0"] = "@moveInto"
            }
            h.create("row-$key", "Row", props)
            h.insert("fs-fe", "row-$key")
            h.rect("row-$key", 0f, i * 100f, 200f, i * 100f + 100f)
        }
        h.rect("fs", 0f, 0f, 200f, 200f)

        h.dnd.claim("row-file", 10f, 10f)
        h.dnd.move("row-file", 0f, 100f) // pointer y=110: folder's top quarter → before → slot 0
        assertEquals(DndLocation("fs", 0), h.dnd.currentTarget())
        h.dnd.move("row-file", 0f, 40f) // y=150: middle band → into the folder
        assertEquals(DndLocation("folder-id", null), h.dnd.currentTarget())
        h.dnd.move("row-file", 0f, 40f) // y=190: bottom quarter → after → slot 1
        assertEquals(DndLocation("fs", 1), h.dnd.currentTarget())
        h.dnd.move("row-file", 0f, -40f) // back into the band and drop
        h.dnd.drop("row-file")
        assertEquals(listOf("moveInto"), h.host.actions)
        assertEquals(mapOf("zone" to "folder-id", "index" to null), h.host.dispatched[0].second["to"])
    }

    // ------------------------------------------------------------- dwell

    @Test
    fun `onDragOver fires once per zone entry after the dwell, without the dwell arg`() = runTest {
        val h = Harness(backgroundScope)
        h.create("card", "Card", mapOf("__dnd.source" to mapOf("group" to "fs")))
        h.insert("root", "card")
        h.rect("card", 0f, 0f, 50f, 50f)
        h.create(
            "folder",
            "Row",
            mapOf(
                "__dnd.zone" to mapOf("group" to "fs", "band" to 0.5),
                "onDragOver.0" to "@peek",
                "onDragOver.dwell" to 200.0,
            ),
        )
        h.insert("root", "folder")
        h.rect("folder", 0f, 100f, 200f, 200f)

        h.dnd.claim("card", 5f, 5f)
        h.dnd.move("card", 0f, 145f)
        advanceTimeBy(199)
        runCurrent()
        assertTrue(h.host.dispatched.isEmpty())
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf("peek"), h.host.actions)
        assertFalse(h.host.dispatched[0].second.containsKey("dwell"))
        assertEquals(mapOf("zone" to "folder", "index" to null), h.host.dispatched[0].second["to"])
        // Hovering longer does not repeat it.
        advanceTimeBy(1000)
        runCurrent()
        assertEquals(1, h.host.dispatched.size)
        // Leaving cancels a pending dwell; re-entering re-arms it.
        h.dnd.move("card", 0f, -140f)
        h.dnd.move("card", 0f, 140f)
        advanceTimeBy(100)
        runCurrent()
        h.dnd.move("card", 0f, -140f)
        advanceTimeBy(500)
        runCurrent()
        assertEquals(1, h.host.dispatched.size)
        h.dnd.move("card", 0f, 140f)
        advanceTimeBy(200)
        runCurrent()
        assertEquals(2, h.host.dispatched.size)
    }

    // ------------------------------------------------------------- poses

    @Test
    fun `the lifted pose lands on the source at claim and clears at release`() = runTest {
        val h = Harness(backgroundScope)
        h.create(
            "card",
            "Card",
            mapOf(
                "opacity.0" to 1.0,
                "__dnd.source" to mapOf("group" to null, "handle" to false, "activation" to "auto"),
                "__anim.states" to mapOf("label" to null, "runtime" to true),
                "__anim.statePoses" to mapOf("lifted" to mapOf("opacity.0" to 0.6, "scale.0" to 1.04)),
            ),
        )
        h.insert("root", "card")
        h.rect("card", 0f, 0f, 100f, 100f)

        h.dnd.claim("card", 5f, 5f)
        assertEquals("lifted", h.dnd.poseLabelOf("card"))
        assertEquals(listOf<Pair<String, Map<String, Any?>?>>("card" to mapOf("opacity.0" to 0.6, "scale.0" to 1.04)), h.host.poses)
        h.dnd.cancel("card")
        assertEquals("card" to null, h.host.poses.last())
        assertNull(h.dnd.poseLabelOf("card"))
    }

    // ------------------------------------------------------------ cancel

    @Test
    fun `a user cancel dispatches only onDragEnd dropped false`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"), extra = mapOf("onSort.0" to "@reorder", "onDragEnd.0" to "@ended"))
        h.dnd.claim("col-text-t1", 10f, 10f)
        h.dnd.move("col-text-t1", 0f, 150f)
        h.dnd.cancel("col-text-t1")
        assertEquals(listOf("ended"), h.host.actions)
        val end = h.host.dispatched[0].second
        assertEquals(false, end["dropped"])
        assertEquals(mapOf("zone" to "col", "index" to 1), end["to"])
        assertFalse(h.dnd.isDragging())
        assertEquals(0f, h.dnd.stateFor("col-row-t2").shiftY)
    }

    @Test
    fun `a Remove of the dragged item mid-drag cancels with NO dispatch`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"), extra = mapOf("onSort.0" to "@reorder", "onDragEnd.0" to "@ended"))
        h.dnd.claim("col-text-t1", 10f, 10f)
        h.dnd.move("col-text-t1", 0f, 150f)
        h.dnd.noteRemove("col-row-t1")
        assertTrue(h.host.dispatched.isEmpty())
        assertFalse(h.dnd.isDragging())
        assertEquals(0f, h.dnd.stateFor("col-row-t2").shiftY)
        assertEquals(DndRole.None, h.dnd.roleFor("col-text-t1"))
    }

    @Test
    fun `a Detach of an ancestor mid-drag cancels with NO dispatch`() = runTest {
        val h = Harness(backgroundScope)
        h.create("route", "Column")
        h.insert("root", "route")
        h.sortable("col", listOf("t1", "t2"), extra = mapOf("onDragEnd.0" to "@ended"))
        h.insert("route", "col")
        h.dnd.claim("col-text-t1", 10f, 10f)
        h.dnd.noteDetach("route")
        assertTrue(h.host.dispatched.isEmpty())
        assertFalse(h.dnd.isDragging())
    }

    @Test
    fun `an exit-flagged remove and a disabled source cancel silently`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"), extra = mapOf("onDragEnd.0" to "@ended"))
        h.dnd.claim("col-text-t1", 10f, 10f)
        h.dnd.cancelSubtree("col")
        assertFalse(h.dnd.isDragging())

        h.dnd.claim("col-text-t2", 10f, 10f)
        h.dnd.noteSetProp("col-text-t2", "__dnd.sourceEnabled", false)
        assertFalse(h.dnd.isDragging())
        assertTrue(h.host.dispatched.isEmpty())
    }

    @Test
    fun `reset cancels silently and drops every cache`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1"), extra = mapOf("onDragEnd.0" to "@ended"))
        h.dnd.claim("col-text-t1", 10f, 10f)
        h.dnd.reset()
        assertFalse(h.dnd.isDragging())
        assertTrue(h.host.dispatched.isEmpty())
        assertEquals(DndRole.None, h.dnd.roleFor("col-text-t1"))
    }

    // ---------------------------------------------------------- deferral

    @Test
    fun `engine translate writes on the dragged node are deferred and flushed at release`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"))
        h.dnd.claim("col-text-t1", 10f, 10f)
        assertTrue(h.dnd.noteSetProp("col-text-t1", "translateX.0", 40.0))
        assertTrue(h.dnd.noteSetProp("col-row-t1", "translateY.0", 8.0))
        assertFalse("other props flow", h.dnd.noteSetProp("col-text-t1", "opacity.0", 0.5))
        assertFalse("other nodes flow", h.dnd.noteSetProp("col-text-t2", "translateX.0", 1.0))
        assertTrue(h.host.applied.isEmpty())
        h.dnd.cancel("col-text-t1")
        assertEquals(
            listOf(Triple("col-text-t1", "translateX.0", 40.0), Triple("col-row-t1", "translateY.0", 8.0)),
            h.host.applied,
        )
    }

    // ---------------------------------------------------------- pinboard

    private fun Harness.pinboard(bind: String? = null, group: String? = "board", grid: Double? = 8.0, units: String = "px", density: Float = 1f) {
        val props = LinkedHashMap<String, Any?>()
        props["__dnd.pin"] = mapOf("group" to group, "xKey" to "x", "yKey" to "y", "grid" to grid, "bounds" to "clamp", "units" to units)
        props["padding.0"] = 10.0
        props["onPin.0"] = "@pinned"
        props["onDragEnd.0"] = "@ended"
        if (bind != null) props["bind"] = bind
        create("board", "Stack", props)
        insert("root", "board")
        create("board-fe", "ForEach")
        insert("board", "board-fe")
        for ((i, key) in listOf("n1", "n2").withIndex()) {
            val noteProps = LinkedHashMap<String, Any?>()
            noteProps["__dnd.key"] = key
            noteProps["__dnd.source"] = mapOf("group" to null, "handle" to false, "activation" to "auto")
            if (bind == null) noteProps["__dnd.pinGroup"] = group
            noteProps["translateX.0"] = null
            noteProps["translateY.0"] = null
            create(key, "Note", noteProps)
            insert("board-fe", key)
            // Both notes sit at the content-box origin (unpinned), 50dp square.
            rect(key, 10f * density, 10f * density, 60f * density, 60f * density, density)
        }
        rect("board", 0f, 0f, 400f * density, 400f * density, density)
    }

    @Test
    fun `reserved-mode pin - grid snap, reserved path, onPin with x y, then onDragEnd`() = runTest {
        val h = Harness(backgroundScope)
        h.pinboard()
        h.dnd.claim("n1", 5f, 5f)
        h.dnd.move("n1", 37f, 21f)
        assertEquals(DndLocation("board", 0), h.dnd.currentTarget())
        h.dnd.drop("n1")

        assertEquals(listOf(DND_PIN_ACTION, "pinned", "ended"), h.host.actions)
        assertEquals(
            mapOf("path" to "__dnd.board.n1", "x" to 40.0, "y" to 24.0, "xKey" to "x", "yKey" to "y"),
            h.host.dispatched[0].second,
        )
        assertEquals(listOf("path", "x", "y", "xKey", "yKey"), h.host.dispatched[0].second.keys.toList())
        val pin = h.host.dispatched[1].second
        assertEquals("n1", pin["item"])
        assertEquals(mapOf("zone" to "board", "index" to 0), pin["from"])
        assertEquals(mapOf("zone" to "board", "index" to 0), pin["to"])
        assertEquals(40.0, pin["x"])
        assertEquals(24.0, pin["y"])
        assertEquals(listOf("item", "from", "to", "x", "y"), pin.keys.toList())
        // The ghost snapped to the resolved position for the hold.
        assertEquals(40f, h.dnd.stateFor("n1").ghostX)
        assertEquals(24f, h.dnd.stateFor("n1").ghostY)
        assertTrue(h.dnd.isHolding())

        // The engine's re-render: the injected translate bindings re-resolve.
        // The first translate write releases the hold and flows through the flush.
        assertTrue(h.dnd.noteSetProp("n1", "translateX.0", 40.0))
        assertFalse(h.dnd.isDragging())
        assertEquals(listOf(Triple("n1", "translateX.0", 40.0)), h.host.applied)
        assertFalse(h.dnd.noteSetProp("n1", "translateY.0", 24.0))
    }

    @Test
    fun `pin clamps to the content box and converts px to dp by density`() = runTest {
        val h = Harness(backgroundScope)
        h.pinboard(grid = null, density = 2f)
        h.dnd.claim("n1", 5f, 5f)
        // 700px right (350dp: past the content box's right edge minus the
        // item) and 10px up (above the content box), pointer still over the
        // board: clamps to (380 - 50, 0) dp.
        h.dnd.move("n1", 700f, -10f)
        assertEquals(DndLocation("board", 0), h.dnd.currentTarget())
        h.dnd.drop("n1")
        assertEquals(330.0, h.host.dispatched[0].second["x"])
        assertEquals(0.0, h.host.dispatched[0].second["y"])
    }

    @Test
    fun `pin in fraction units divides by the content size`() = runTest {
        val h = Harness(backgroundScope)
        h.pinboard(grid = null, units = "fraction")
        h.dnd.claim("n1", 5f, 5f)
        h.dnd.move("n1", 95f, 190f)
        h.dnd.drop("n1")
        assertEquals(0.25, h.host.dispatched[0].second["x"])
        assertEquals(0.5, h.host.dispatched[0].second["y"])
    }

    @Test
    fun `user-field pin writes bind dot index`() = runTest {
        val h = Harness(backgroundScope)
        h.pinboard(bind = "seats", group = null)
        h.dnd.claim("n2", 5f, 5f)
        h.dnd.move("n2", 16f, 8f)
        h.dnd.drop("n2")
        assertEquals(
            mapOf("path" to "seats.1", "x" to 16.0, "y" to 8.0, "xKey" to "x", "yKey" to "y"),
            h.host.dispatched[0].second,
        )
    }

    /**
     * The note was pinned earlier: the engine wrote `translateX.0` /
     * `translateY.0`, and the Compose layer reports its RENDERED rect
     * (layout rect + that translate, `dndTranslatePx`) — exactly what the
     * coordinator receives after a re-render.
     */
    private fun Harness.positionedNote(key: String, tx: Double, ty: Double, density: Float = 1f) {
        assertFalse("outside a drag the write flows to the renderer", dnd.noteSetProp(key, "translateX.0", tx))
        assertFalse(dnd.noteSetProp(key, "translateY.0", ty))
        val l = (10.0 + tx) * density
        val t = (10.0 + ty) * density
        rect(key, l.toFloat(), t.toFloat(), (l + 50.0 * density).toFloat(), (t + 50.0 * density).toFloat(), density)
    }

    @Test
    fun `re-pin of a positioned note dispatches base plus delta from its rendered rect`() = runTest {
        val h = Harness(backgroundScope)
        h.pinboard(grid = null)
        // Drawn at (50, 70): layout origin (10, 10) + translate (40, 60).
        h.positionedNote("n1", 40.0, 60.0)
        h.dnd.claim("n1", 5f, 5f)
        h.dnd.move("n1", 10f, 10f)
        assertEquals(DndLocation("board", 0), h.dnd.currentTarget())
        h.dnd.drop("n1")

        assertEquals(listOf(DND_PIN_ACTION, "pinned", "ended"), h.host.actions)
        // §6.11: rendered top-left + delta − content-box origin = (50, 70),
        // NOT the delta from the layout origin (10, 10).
        assertEquals(
            mapOf("path" to "__dnd.board.n1", "x" to 50.0, "y" to 70.0, "xKey" to "x", "yKey" to "y"),
            h.host.dispatched[0].second,
        )
        assertEquals(50.0, h.host.dispatched[1].second["x"])
        assertEquals(70.0, h.host.dispatched[1].second["y"])
        // The held ghost stays on the pixels the pointer left it at: the delta
        // is relative to the rendered origin, so the engine's follow-up
        // translate write lands on the very pixels the ghost occupies.
        assertEquals(10f, h.dnd.stateFor("n1").ghostX)
        assertEquals(10f, h.dnd.stateFor("n1").ghostY)
        assertTrue(h.dnd.isHolding())
        assertTrue(h.dnd.noteSetProp("n1", "translateX.0", 50.0))
        assertFalse(h.dnd.isDragging())
        assertEquals(listOf(Triple("n1", "translateX.0", 50.0)), h.host.applied)
    }

    @Test
    fun `re-pin grid-snaps and clamps from the rendered origin at density 2`() = runTest {
        val h = Harness(backgroundScope)
        h.pinboard(grid = 8.0, density = 2f)
        // Content box (20, 20)–(780, 780) px; note drawn at (100, 140) px = (40, 60) dp in it.
        h.positionedNote("n1", 40.0, 60.0, density = 2f)
        h.dnd.claim("n1", 5f, 5f)
        h.dnd.move("n1", 10f, 10f)
        h.dnd.drop("n1")
        // (45, 65) dp → grid 8 → (48, 64).
        assertEquals(48.0, h.host.dispatched[0].second["x"])
        assertEquals(64.0, h.host.dispatched[0].second["y"])
        assertEquals(16f, h.dnd.stateFor("n1").ghostX)
        assertEquals(8f, h.dnd.stateFor("n1").ghostY)
        h.dnd.noteSetProp("n1", "translateX.0", 48.0)

        // Dragged past the right edge from its rendered position: clamps to
        // (380 − 50, 60 + 5) dp, i.e. the rendered origin counts toward the
        // clamp too.
        h.positionedNote("n1", 300.0, 60.0, density = 2f)
        h.dnd.claim("n1", 5f, 5f)
        h.dnd.move("n1", 150f, 10f) // pointer (775, 155) px: still over the board
        assertEquals(DndLocation("board", 0), h.dnd.currentTarget())
        h.dnd.drop("n1")
        assertEquals(330.0, h.host.dispatched[3].second["x"]) // 375 → grid 376 → clamp 330
        assertEquals(64.0, h.host.dispatched[3].second["y"])
    }

    @Test
    fun `claimAt places the pointer in root px independent of the cached rect`() = runTest {
        val h = Harness(backgroundScope)
        h.pinboard(grid = null)
        // The Compose layer mapped the down through the note's live
        // transforms: the finger is near the board's bottom-right corner even
        // though the cached rect (a stale layout-origin report) says (10, 10).
        assertTrue(h.dnd.claimAt("n1", 395f, 395f))
        h.dnd.move("n1", 0f, 0f) // the gesture's first move: the pending travel, here none
        assertEquals(DndLocation("board", 0), h.dnd.currentTarget())
        h.dnd.move("n1", 10f, 0f) // (405, 395): off the board's right edge
        assertNull(h.dnd.currentTarget())
        h.dnd.drop("n1")
        assertEquals(listOf("ended"), h.host.actions)
        assertEquals(false, h.host.dispatched[0].second["dropped"])
        assertFalse(h.dnd.isDragging())
    }

    @Test
    fun `a foreign compatible pinboard is a plain into zone`() = runTest {
        val h = Harness(backgroundScope)
        h.pinboard()
        h.create("other", "Stack", mapOf("__dnd.pin" to mapOf("group" to "board", "xKey" to "x", "yKey" to "y"), "onDrop.0" to "@dropped"))
        h.insert("root", "other")
        h.rect("other", 500f, 0f, 900f, 400f)
        h.create("card", "Card", mapOf("__dnd.source" to mapOf("group" to "board")))
        h.insert("root", "card")
        h.rect("card", 0f, 500f, 50f, 550f)

        h.dnd.claim("card", 5f, 5f)
        h.dnd.move("card", 600f, -400f) // (605, 105) inside `other`
        assertEquals(DndLocation("board", null), h.dnd.currentTarget())
        h.dnd.drop("card")
        assertEquals(listOf("dropped"), h.host.actions)
    }

    // ------------------------------------------------------ accessibility

    @Test
    fun `accessibility move runs the pointer commit path`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2", "t3"), extra = mapOf("onSort.0" to "@reorder", "onDragStart.0" to "@started", "onDragEnd.0" to "@ended"))
        assertTrue(h.dnd.accessibilityMove("col-text-t2", 1))
        assertEquals(listOf("started", DND_REORDER_ACTION, "reorder", "ended"), h.host.actions)
        assertEquals(mapOf("path" to "tasks", "from" to 1, "to" to 2), h.host.dispatched[1].second)
        assertEquals(mapOf("zone" to "col", "index" to 2), h.host.dispatched[2].second["to"])
        assertTrue(h.dnd.isHolding())
        assertFalse("no ghost for an accessibility move", h.dnd.stateFor("col-row-t2").lifted)
        h.insert("col-fe", "col-row-t2")
        assertFalse(h.dnd.isDragging())

        // Edges are a no-op.
        assertFalse(h.dnd.accessibilityMove("col-text-t1", -1))
        assertEquals(4, h.host.dispatched.size)
    }

    // ----------------------------------------------------------- geometry

    @Test
    fun `bounds reports subtract the runtime's own offsets`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"))
        h.dnd.claim("col-text-t1", 10f, 10f)
        h.dnd.move("col-text-t1", 0f, 150f)
        // A relayout reports the ghost row where the layer put it; the stored
        // rect is the rendered rect MINUS the runtime's own offsets, so a
        // later drag in the same session (after release) hit-tests correctly.
        h.rect("col-row-t1", 0f, 150f, 200f, 250f)
        h.rect("col-text-t1", 0f, 150f, 200f, 250f)
        h.dnd.cancel("col-text-t1")
        h.dnd.claim("col-text-t2", 10f, 10f)
        // Pointer (10, 120): past t1's layout midpoint (50) → t2 stays in
        // slot 1. Had the ghosted report been stored verbatim (midpoint
        // 200), t2 would have resolved to slot 0.
        h.dnd.move("col-text-t2", 0f, 10f)
        assertEquals(DndLocation("col", 1), h.dnd.currentTarget())
    }

    // ------------------------------------------- mid-drag structural changes

    /**
     * The engine inserts top-down: the row lands under the ForEach wrapper
     * first, then the source Text under the row — the row only becomes a
     * draggable slot on the second insert. Rects arrive afterwards, the way
     * Compose reports them once the rows are laid out.
     */
    private fun Harness.springLoadRow(list: String, key: String, before: String?) {
        val row = "$list-row-$key"
        val text = "$list-text-$key"
        create(row, "Row")
        insert("$list-fe", row, before)
        create(
            text,
            "Text",
            mapOf(
                "__dnd.key" to key,
                "__dnd.source" to mapOf("group" to null, "handle" to false, "activation" to "auto"),
            ),
        )
        insert(row, text)
    }

    @Test
    fun `a foreign list changing shape mid-drag rebuilds its slots from the live children`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("todo", listOf("a"), group = "board")
        h.sortable("doing", listOf("c", "d"), left = 300f, group = "board")
        h.dnd.claim("todo-text-a", 10f, 10f)
        h.dnd.move("todo-text-a", 300f, 90f) // (310, 100): past c's midpoint (50) → slot 1; d shifts down
        assertEquals(DndLocation("board", 1), h.dnd.currentTarget())
        assertEquals(0f, h.dnd.stateFor("doing-row-c").shiftY)
        assertEquals(100f, h.dnd.stateFor("doing-row-d").shiftY)

        // A spring-loaded insert of a draggable row `e` at the top of `doing`
        // pushes c and d down by a row; Compose reports the new rects (d's
        // includes its own preview shift, which `updateBounds` subtracts).
        h.springLoadRow("doing", "e", before = "doing-row-c")
        h.rect("doing-row-e", 300f, 0f, 500f, 100f)
        h.rect("doing-row-c", 300f, 100f, 500f, 200f)
        h.rect("doing-row-d", 300f, 200f + 100f, 500f, 300f + 100f)
        h.rect("doing", 300f, 0f, 500f, 300f)

        // Still at (310, 100): past e's midpoint (50), before c's new one
        // (150) → slot 1 sits between e and c now, so c joins the gap. Had c
        // kept its stale rect (midpoint 50) the pointer would read slot 2.
        assertEquals(DndLocation("board", 1), h.dnd.currentTarget())
        assertEquals(0f, h.dnd.stateFor("doing-row-e").shiftY)
        assertEquals(100f, h.dnd.stateFor("doing-row-c").shiftY)
        assertEquals(100f, h.dnd.stateFor("doing-row-d").shiftY)
        assertTrue(h.dnd.ownsNode("doing-row-c"))
        assertFalse(h.dnd.ownsNode("doing-row-e"))
    }

    @Test
    fun `an insert into the origin list mid-drag makes the reserved from the item's live index`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2", "t3", "t4"), extra = mapOf("onSort.0" to "@reorder", "onDragEnd.0" to "@ended"))
        // Lift t4 (index 3) and carry it to the top: (10, 20) → slot 0.
        assertTrue(h.dnd.claim("col-text-t4", 10f, 10f))
        h.dnd.move("col-text-t4", 0f, -290f)
        assertEquals(DndLocation("col", 0), h.dnd.currentTarget())
        assertEquals(100f, h.dnd.stateFor("col-row-t1").shiftY)

        // Dwelling on a folder: the module inserts a row `x` above t1 while
        // the pointer stays put. The rows re-report where the layout put them
        // (the runtime's own shift subtracted, as `updateBounds` does).
        h.springLoadRow("col", "x", before = "col-row-t1")
        h.rect("col-row-x", 0f, 0f, 200f, 100f)
        h.rect("col-row-t1", 0f, 100f + 100f, 200f, 200f + 100f)
        h.rect("col-row-t2", 0f, 200f + 100f, 200f, 300f + 100f)
        h.rect("col-row-t3", 0f, 300f + 100f, 200f, 400f + 100f)
        h.rect("col", 0f, 0f, 200f, 500f)

        // Still slot 0: every row, x included, opens the gap.
        assertEquals(DndLocation("col", 0), h.dnd.currentTarget())
        assertEquals(100f, h.dnd.stateFor("col-row-x").shiftY)
        assertEquals(100f, h.dnd.stateFor("col-row-t1").shiftY)
        assertEquals(100f, h.dnd.stateFor("col-row-t3").shiftY)
        assertTrue(h.host.dispatched.isEmpty())

        h.dnd.drop("col-text-t4")
        assertEquals(listOf(DND_REORDER_ACTION, "reorder", "ended"), h.host.actions)
        // The reserved write moves the item from where it LIVES now (index 4)...
        assertEquals(mapOf("path" to "tasks", "from" to 4, "to" to 0), h.host.dispatched[0].second)
        // ...while the event payload's `from` stays the lift location.
        assertEquals(mapOf("zone" to "col", "index" to 3), h.host.dispatched[1].second["from"])
        assertEquals(mapOf("zone" to "col", "index" to 0), h.host.dispatched[1].second["to"])
        assertEquals(mapOf("zone" to "col", "index" to 3), h.host.dispatched[2].second["from"])
        assertTrue(h.dnd.isHolding())
    }

    @Test
    fun `a remove from the origin list mid-drag drops the row from the slots and tracks the live index`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2", "t3"), extra = mapOf("onSort.0" to "@reorder"))
        // Lift t3 (index 2) and carry it to the top: (10, 20) → slot 0.
        assertTrue(h.dnd.claim("col-text-t3", 10f, 10f))
        h.dnd.move("col-text-t3", 0f, -190f)
        assertEquals(DndLocation("col", 0), h.dnd.currentTarget())
        assertEquals(100f, h.dnd.stateFor("col-row-t1").shiftY)
        assertEquals(100f, h.dnd.stateFor("col-row-t2").shiftY)

        // The engine removes t1; t2 re-reports at the top.
        h.dnd.noteRemove("col-row-t1")
        h.rect("col-row-t2", 0f, 0f + 100f, 200f, 100f + 100f)
        h.rect("col", 0f, 0f, 200f, 200f)

        assertEquals(DndLocation("col", 0), h.dnd.currentTarget())
        assertEquals(100f, h.dnd.stateFor("col-row-t2").shiftY)
        assertFalse(h.dnd.ownsNode("col-row-t1"))
        assertEquals(DndRole.None, h.dnd.roleFor("col-text-t1"))

        h.dnd.drop("col-text-t3")
        assertEquals(listOf(DND_REORDER_ACTION, "reorder"), h.host.actions)
        assertEquals(mapOf("path" to "tasks", "from" to 1, "to" to 0), h.host.dispatched[0].second)
        assertEquals(mapOf("zone" to "col", "index" to 2), h.host.dispatched[1].second["from"])
    }

    @Test
    fun `a drop back on the item's live slot after a mid-drag insert writes nothing`() = runTest {
        val h = Harness(backgroundScope)
        h.sortable("col", listOf("t1", "t2"), extra = mapOf("onSort.0" to "@reorder", "onDragEnd.0" to "@ended"))
        // Lift t2 (index 1); the pointer stays over its own slot at (10, 150).
        assertTrue(h.dnd.claim("col-text-t2", 10f, 50f))
        h.dnd.move("col-text-t2", 0f, 0f)
        assertEquals(DndLocation("col", 1), h.dnd.currentTarget())

        // A row inserted ABOVE the pointer pushes t2's live slot to 2, and the
        // pointer — now at t1's new midpoint — resolves to slot 2 as well.
        h.springLoadRow("col", "x", before = "col-row-t1")
        h.rect("col-row-x", 0f, 0f, 200f, 100f)
        h.rect("col-row-t1", 0f, 100f, 200f, 200f)
        h.rect("col", 0f, 0f, 200f, 300f)
        assertEquals(DndLocation("col", 2), h.dnd.currentTarget())

        h.dnd.drop("col-text-t2")
        // Live index 2 → slot 2: nothing moved, so no reserved write, no onSort.
        assertEquals(listOf("ended"), h.host.actions)
        assertFalse(h.dnd.isDragging())
    }
}
