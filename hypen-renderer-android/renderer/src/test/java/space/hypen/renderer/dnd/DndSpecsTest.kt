package space.hypen.renderer.dnd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.applicators.translateDp

/**
 * The `__dnd.*` vocabulary as the engine emits it (pinned by the
 * `engine-compatibility-tests/fixtures/dnd/ JSON fixtures` wire) and the pure
 * geometry every renderer shares (`resolveBand`, `snapToGrid`).
 */
class DndSpecsTest {
    // ------------------------------------------------------------ channels

    @Test
    fun `source parses the fixture shape and fills defaults on drift`() {
        val spec = DndParse.source(mapOf("group" to null, "handle" to false, "activation" to "auto"))
        assertEquals(DndSourceSpec(null, false, DndActivation.AUTO), spec)

        assertEquals(
            DndSourceSpec("cards", true, DndActivation.PRESS),
            DndParse.source(mapOf("group" to "cards", "handle" to true, "activation" to "press")),
        )
        // Version drift: unknown activation falls back, empty group is null.
        assertEquals(
            DndSourceSpec(null, false, DndActivation.AUTO),
            DndParse.source(mapOf("group" to "", "activation" to "teleport")),
        )
        // A stringified object is tolerated (raw-JSON hosts).
        assertEquals(
            DndSourceSpec("g", false, DndActivation.SLOP),
            DndParse.source("""{"group":"g","activation":"slop"}"""),
        )
    }

    @Test
    fun `malformed channels degrade to null, never throw`() {
        assertNull(DndParse.source("nope"))
        assertNull(DndParse.source(42))
        assertNull(DndParse.source(listOf("a")))
        assertNull(DndParse.zone(true))
        assertNull(DndParse.sort(null))
        assertNull(DndParse.pin("[]"))
    }

    @Test
    fun `zone clamps band and defaults it`() {
        assertEquals(DndZoneSpec("fs", 0.3), DndParse.zone(mapOf("group" to "fs", "band" to 0.3)))
        assertEquals(DndZoneSpec(null, DND_DEFAULT_BAND), DndParse.zone(mapOf("group" to null, "band" to "wide")))
        assertEquals(1.0, DndParse.zone(mapOf("band" to 7.0))!!.band, 0.0)
        assertEquals(0.0, DndParse.zone(mapOf("band" to -1.0))!!.band, 0.0)
    }

    @Test
    fun `sort defaults axis to y`() {
        assertEquals(DndSortSpec(null, DndAxis.Y), DndParse.sort(mapOf("group" to null, "axis" to "y")))
        assertEquals(DndSortSpec("board", DndAxis.X), DndParse.sort(mapOf("group" to "board", "axis" to "x")))
        assertEquals(DndSortSpec(null, DndAxis.Y), DndParse.sort(mapOf("axis" to "z")))
        assertEquals(DndAxis.X, DndAxis.Y.cross)
    }

    @Test
    fun `pin parses the reserved fixture and drops a non-positive grid`() {
        val wire =
            mapOf("group" to "board", "xKey" to "x", "yKey" to "y", "grid" to null, "bounds" to "clamp", "units" to "px")
        assertEquals(DndPinSpec("board", "x", "y", null, DndBounds.CLAMP, DndUnits.PX), DndParse.pin(wire))
        assertEquals(
            DndPinSpec(null, "left", "top", 8.0, DndBounds.FREE, DndUnits.FRACTION),
            DndParse.pin(mapOf("xKey" to "left", "yKey" to "top", "grid" to 8.0, "bounds" to "free", "units" to "fraction")),
        )
        assertNull(DndParse.pin(mapOf("grid" to 0.0))!!.grid)
        assertNull(DndParse.pin(mapOf("grid" to -3.0))!!.grid)
    }

    @Test
    fun `enabled is true unless explicitly false`() {
        assertTrue(DndParse.enabled(null))
        assertTrue(DndParse.enabled(true))
        assertTrue(DndParse.enabled("yes"))
        assertFalse(DndParse.enabled(false))
        assertFalse(DndParse.enabled("false"))
    }

    @Test
    fun `string keys tolerate numbers and reject empties`() {
        assertEquals("t1", DndParse.string("t1"))
        assertNull(DndParse.string(""))
        assertNull(DndParse.string(null))
        assertEquals("3", DndParse.string(3.0))
        assertEquals("3", DndParse.string(3))
        assertEquals("2.5", DndParse.string(2.5))
        assertNull(DndParse.string(listOf(1)))
    }

    @Test
    fun `statePoses parse to label - lowered key - value`() {
        val poses =
            DndParse.poses(
                mapOf(
                    "lifted" to mapOf("opacity.0" to 0.6, "scale.0" to 1.04),
                    "over" to mapOf("backgroundColor.0" to "#eee"),
                    "junk" to "not a pose",
                ),
            )
        assertNotNull(poses)
        assertEquals(setOf("lifted", "over"), poses!!.keys)
        assertEquals(mapOf("opacity.0" to 0.6, "scale.0" to 1.04), poses["lifted"])
        assertNull(DndParse.poses("nope"))
        assertNull(DndParse.poses(null))
    }

    // -------------------------------------------------------------- events

    @Test
    fun `event bindings read the generic onX lowering and strip dwell`() {
        val props =
            mapOf(
                "__dnd.sort" to mapOf("group" to null, "axis" to "y"),
                "onSort.0" to "@reorder",
                "onDragOver.0" to "@peek",
                "onDragOver.dwell" to 200.0,
                "onDragOver.source" to "list",
            )
        val sort = DndParse.eventBinding(props, DndEvent.SORT)!!
        assertEquals("reorder", sort.actionName)
        assertTrue(sort.customPayload.isEmpty())
        assertNull(sort.dwell)

        val over = DndParse.eventBinding(props, DndEvent.DRAG_OVER)!!
        assertEquals("peek", over.actionName)
        assertEquals(200L, over.dwell)
        assertEquals(mapOf<String, Any?>("source" to "list"), over.customPayload)

        assertNull(DndParse.eventBinding(props, DndEvent.DROP))
    }

    @Test
    fun `an invalid dwell warns and falls back to the default`() {
        val over = DndParse.eventBinding(mapOf("onDragOver.0" to "@peek", "onDragOver.dwell" to "soon"), DndEvent.DRAG_OVER)!!
        assertNull(over.dwell)
        assertFalse(over.customPayload.containsKey("dwell"))
    }

    @Test
    fun `bare and object event forms are tolerated`() {
        assertEquals("done", DndParse.eventBinding(mapOf("onDragEnd" to "@actions.done"), DndEvent.DRAG_END)!!.actionName)
        val obj = DndParse.eventBinding(mapOf("onDrop" to mapOf("0" to "@actions.moveInto", "kind" to "bin")), DndEvent.DROP)!!
        assertEquals("moveInto", obj.actionName)
        assertEquals(mapOf<String, Any?>("kind" to "bin"), obj.customPayload)
        assertNull(DndParse.eventBinding(mapOf("onDrop.0" to "not-an-action"), DndEvent.DROP))
    }

    // ------------------------------------------------------------ geometry

    @Test
    fun `resolveBand splits the item into before - into - after`() {
        // band 0.5 on [100, 200): outer quarters are before/after.
        assertEquals(DndBand.BEFORE, resolveBand(100.0, 100.0, 100.0, 0.5))
        assertEquals(DndBand.BEFORE, resolveBand(124.9, 100.0, 100.0, 0.5))
        assertEquals(DndBand.INTO, resolveBand(125.0, 100.0, 100.0, 0.5))
        assertEquals(DndBand.INTO, resolveBand(174.9, 100.0, 100.0, 0.5))
        assertEquals(DndBand.AFTER, resolveBand(175.0, 100.0, 100.0, 0.5))
        // band 0 never yields into; band 1 is into anywhere inside.
        assertEquals(DndBand.BEFORE, resolveBand(149.0, 100.0, 100.0, 0.0))
        assertEquals(DndBand.AFTER, resolveBand(150.0, 100.0, 100.0, 0.0))
        assertEquals(DndBand.INTO, resolveBand(100.0, 100.0, 100.0, 1.0))
        assertEquals(DndBand.AFTER, resolveBand(200.0, 100.0, 100.0, 1.0))
        // Outside the item resolves by side.
        assertEquals(DndBand.BEFORE, resolveBand(50.0, 100.0, 100.0, 0.5))
        assertEquals(DndBand.AFTER, resolveBand(500.0, 100.0, 100.0, 0.5))
        // Non-finite band → default.
        assertEquals(DndBand.INTO, resolveBand(150.0, 100.0, 100.0, Double.NaN))
    }

    @Test
    fun `snapToGrid rounds to the nearest multiple and ignores a null grid`() {
        assertEquals(40.0, snapToGrid(37.0, 8.0), 0.0)
        assertEquals(32.0, snapToGrid(35.9, 8.0), 0.0)
        assertEquals(37.0, snapToGrid(37.0, null), 0.0)
        assertEquals(37.0, snapToGrid(37.0, 0.0), 0.0)
        assertEquals(0.0, snapToGrid(-3.0, 8.0), 0.0)
    }

    @Test
    fun `pin paths and round3`() {
        assertEquals("__dnd.board.n1", reservedPinPath("board", "n1"))
        assertEquals("seats.2", userPinPath("seats", 2))
        assertEquals(1.235, round3(1.23456), 0.0)
        assertEquals(40.0, round3(40.0), 0.0)
    }

    // -------------------------------------------------- padding / translate

    @Test
    fun `padding props resolve with CSS shorthand semantics`() {
        assertEquals(listOf(10.0, 10.0, 10.0, 10.0), paddingDp(mapOf("padding.0" to 10.0)).toList())
        // (vertical, horizontal)
        assertEquals(listOf(8.0, 4.0, 8.0, 4.0), paddingDp(mapOf("padding.0" to 4.0, "padding.1" to 8.0)).toList())
        // (top, horizontal, bottom)
        assertEquals(
            listOf(2.0, 1.0, 2.0, 3.0),
            paddingDp(mapOf("padding.0" to 1.0, "padding.1" to 2.0, "padding.2" to 3.0)).toList(),
        )
        // (top, right, bottom, left)
        assertEquals(
            listOf(4.0, 1.0, 2.0, 3.0),
            paddingDp(mapOf("padding.0" to 1.0, "padding.1" to 2.0, "padding.2" to 3.0, "padding.3" to 4.0)).toList(),
        )
        // Per-side applicators override; strings parse.
        assertEquals(
            listOf(16.0, 10.0, 10.0, 24.0),
            paddingDp(mapOf("padding.0" to 10.0, "paddingLeft.0" to "16px", "paddingBottom.0" to "1.5rem")).toList(),
        )
        assertEquals(listOf(0.0, 0.0, 0.0, 0.0), paddingDp(emptyMap()).toList())
    }

    @Test
    fun `translate values are dp and null reads as zero`() {
        assertEquals(0f, translateDp(null))
        assertEquals(12f, translateDp(12))
        assertEquals(12.5f, translateDp(12.5))
        assertEquals(12f, translateDp("12px"))
        assertEquals(12f, translateDp("12dp"))
        assertNull(translateDp("abc"))
        assertNull(translateDp(true))
        assertNull(translateDp(Double.NaN))
    }

    @Test
    fun `an element's own engine translate is dp times density and degrades to zero`() {
        // The reserved-mode injection: explicit null on an unpinned item.
        assertEquals(0f to 0f, dndTranslatePx(mapOf("translateX.0" to null, "translateY.0" to null), 2f))
        // Absent keys (a plain sortable row) move nothing either.
        assertEquals(0f to 0f, dndTranslatePx(emptyMap(), 3f))
        // A pinned note: dp × density, in root px.
        assertEquals(80f to 120f, dndTranslatePx(mapOf("translateX.0" to 40.0, "translateY.0" to 60), 2f))
        assertEquals(40f to 60f, dndTranslatePx(mapOf("translateX.0" to "40px", "translateY.0" to 60.0), 1f))
        // Unparseable = no transform (the applicator applies none), one axis at a time.
        assertEquals(0f to 24f, dndTranslatePx(mapOf("translateX.0" to "abc", "translateY.0" to 12.0), 2f))
        // A degenerate density reads as 1.
        assertEquals(40f to 60f, dndTranslatePx(mapOf("translateX.0" to 40.0, "translateY.0" to 60.0), 0f))
    }
}
