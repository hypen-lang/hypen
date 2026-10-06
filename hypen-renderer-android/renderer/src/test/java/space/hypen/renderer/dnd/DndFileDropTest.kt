package space.hypen.renderer.dnd

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.anim.AlwaysAnimate

/**
 * Files drop zones (`.dropZone(files: true, accept:)`, dnd.md "Files from
 * the OS"): the wire parse, the `accept:` filter, external-drag
 * classification, and the coordinator's `fileDrag*` surface the Compose
 * platform target drives — `over` pose (innermost enabled, accepting zone
 * wins; one at a time), `.onFileDragEnter` once per entry, and the refused
 * drop.
 */
class DndFileDropTest {
    // ------------------------------------------------------------ spec parse

    @Test
    fun `zone parses files and accept from the drop-zone-files fixture`() {
        assertEquals(
            DndZoneSpec(null, 0.5, files = true, accept = "image/*,.pdf"),
            DndParse.zone(mapOf("group" to null, "band" to 0.5, "files" to true, "accept" to "image/*,.pdf")),
        )
        assertEquals(
            DndZoneSpec(null, 0.5, files = true, accept = null),
            DndParse.zone(mapOf("group" to null, "band" to 0.5, "files" to true, "accept" to null)),
        )
        // Absent ⇒ the old in-app-only zone, equal to the two-field spec.
        val plain = DndParse.zone(mapOf("group" to "fs", "band" to 0.3))
        assertEquals(DndZoneSpec("fs", 0.3), plain)
        assertFalse(plain!!.files)
        assertNull(plain.accept)
    }

    @Test
    fun `stray or malformed files keys degrade to an in-app zone`() {
        // accept without files has no effect.
        assertEquals(DndZoneSpec(null, 0.5), DndParse.zone(mapOf("band" to 0.5, "accept" to "image/*")))
        // A non-bool files is not true.
        assertEquals(DndZoneSpec(null, 0.5), DndParse.zone(mapOf("band" to 0.5, "files" to "yes")))
        // Blank accept ⇒ any.
        assertEquals(
            DndZoneSpec(null, 0.5, files = true, accept = null),
            DndParse.zone(mapOf("band" to 0.5, "files" to true, "accept" to "  ")),
        )
        // Non-string accept ⇒ any.
        assertEquals(
            DndZoneSpec(null, 0.5, files = true, accept = null),
            DndParse.zone(mapOf("band" to 0.5, "files" to true, "accept" to 3)),
        )
    }

    // ------------------------------------------------------------ accept

    @Test
    fun `accept matches MIME lists with wildcards on either side`() {
        assertTrue(DndFileDrag.accepts("image/*", listOf("image/png")))
        assertTrue(DndFileDrag.accepts("image/*", listOf("text/plain", "image/jpeg")))
        assertFalse(DndFileDrag.accepts("image/*", listOf("application/pdf")))
        assertTrue(DndFileDrag.accepts("application/pdf", listOf("application/pdf")))
        assertTrue(DndFileDrag.accepts("Application/PDF", listOf("application/pdf; charset=binary")))
        assertFalse(DndFileDrag.accepts("application/pdf", listOf("image/png")))
        assertTrue(DndFileDrag.accepts("text/plain, application/pdf", listOf("application/pdf")))
        assertTrue(DndFileDrag.accepts("*/*", listOf("video/mp4")))
        assertTrue(DndFileDrag.accepts("*", listOf("video/mp4")))
        // A wildcard drag type (several images) overlaps a concrete token.
        assertTrue(DndFileDrag.accepts("image/png", listOf("image/*")))
        assertFalse(DndFileDrag.accepts("image/png", listOf("video/*")))
    }

    @Test
    fun `accept degrades to a match when the platform cannot tell`() {
        // No filter.
        assertTrue(DndFileDrag.accepts(null, listOf("image/png")))
        assertTrue(DndFileDrag.accepts("", listOf("image/png")))
        // Unknown types.
        assertTrue(DndFileDrag.accepts("image/*", null))
        assertTrue(DndFileDrag.accepts("image/*", emptyList()))
        // `.ext` tokens can't be checked before the drop (no names).
        assertTrue(DndFileDrag.accepts(".pdf", listOf("image/png")))
        assertTrue(DndFileDrag.accepts("image/*,.pdf", listOf("text/plain")))
        // Only malformed tokens ⇒ any.
        assertTrue(DndFileDrag.accepts("image", listOf("text/plain")))
        // A malformed token alongside a valid one is skipped.
        assertFalse(DndFileDrag.accepts("image, image/*", listOf("text/plain")))
    }

    @Test
    fun `mimeMatches follows compareMimeTypes semantics`() {
        assertTrue(DndFileDrag.mimeMatches("image/png", "image/*"))
        assertTrue(DndFileDrag.mimeMatches("image/png", "*/*"))
        assertTrue(DndFileDrag.mimeMatches("image/png", "image/png"))
        assertFalse(DndFileDrag.mimeMatches("image/png", "image/jpeg"))
        assertFalse(DndFileDrag.mimeMatches("image/png", "text/*"))
        assertFalse(DndFileDrag.mimeMatches("image", "image/*"))
    }

    // ------------------------------------------------------------ classify

    @Test
    fun `only external drags that carry content are ours`() {
        assertEquals(
            DndFileDragInfo(listOf("image/png"), 0),
            DndFileDrag.classify(listOf("image/png"), hasLocalState = false),
        )
        assertEquals(
            DndFileDragInfo(listOf("image/png", "application/pdf"), 2),
            DndFileDrag.classify(listOf("Image/PNG", "application/pdf"), hasLocalState = false, items = 2),
        )
        // An in-app platform drag carrying a local state object.
        assertNull(DndFileDrag.classify(listOf("image/png"), hasLocalState = true))
        // No description / no types / an Intent only.
        assertNull(DndFileDrag.classify(null, hasLocalState = false))
        assertNull(DndFileDrag.classify(emptyList(), hasLocalState = false))
        assertNull(DndFileDrag.classify(listOf(DndFileDrag.MIMETYPE_INTENT), hasLocalState = false))
        assertEquals(
            DndFileDragInfo(listOf(DndFileDrag.MIMETYPE_INTENT, "text/uri-list"), 0),
            DndFileDrag.classify(listOf(DndFileDrag.MIMETYPE_INTENT, "text/uri-list"), hasLocalState = false),
        )
        // A negative count is clamped to unknown.
        assertEquals(0, DndFileDrag.classify(listOf("a/b"), hasLocalState = false, items = -1)!!.items)
    }

    // ------------------------------------------------------------ coordinator

    private class RecordingHost : DndHost {
        /** `(node, action, payload)` from `__hypen_dispatch` envelopes. */
        val dispatched = mutableListOf<Triple<String, String, Map<String, Any?>>>()

        /** `id → pose` for an overlay, `id → null` for a clear, in order. */
        val poses = mutableListOf<Pair<String, Map<String, Any?>?>>()

        @Suppress("UNCHECKED_CAST")
        override fun dispatch(sourceId: String, action: String, payload: Map<String, Any?>) {
            assertEquals("__hypen_dispatch", action)
            assertEquals(sourceId, payload["node"])
            dispatched.add(Triple(sourceId, payload["action"] as String, payload["payload"] as Map<String, Any?>))
        }

        override fun applyProp(id: String, name: String, value: Any?) = Unit

        override fun setPoseOverrides(id: String, pose: Map<String, Any?>) {
            poses.add(id to pose)
        }

        override fun clearPoseOverrides(id: String) {
            poses.add(id to null)
        }
    }

    private val overPose = mapOf("over" to mapOf("backgroundColor.0" to "#eef2ff"))

    private fun filesZone(accept: String? = null, extra: Map<String, Any?> = emptyMap()): Map<String, Any?> =
        linkedMapOf<String, Any?>(
            "__dnd.zone" to mapOf("group" to null, "band" to 0.5, "files" to true, "accept" to accept),
            "__anim.statePoses" to overPose,
        ).also { it.putAll(extra) }

    private inner class Harness {
        val host = RecordingHost()
        val dnd = DndCoordinator(AlwaysAnimate, CoroutineScope(Dispatchers.Unconfined)).also {
            it.setHost(host)
            it.clock = { 1234L }
        }

        fun create(id: String, props: Map<String, Any?> = emptyMap(), parent: String? = null, type: String = "Column") {
            dnd.noteCreate(id, type, props)
            if (parent != null) dnd.noteInsert(parent, id, null)
        }
    }

    private val png = DndFileDragInfo(listOf("image/png"))

    @Test
    fun `role flags files zones only`() {
        val h = Harness()
        h.create("root")
        h.create("files", filesZone(), parent = "root")
        h.create("inapp", mapOf("__dnd.zone" to mapOf("group" to null, "band" to 0.5)), parent = "root")
        assertTrue(h.dnd.roleFor("files").filesZone)
        assertTrue(h.dnd.roleFor("files").needsBounds)
        assertFalse(h.dnd.roleFor("inapp").filesZone)
        assertFalse(h.dnd.roleFor("root").filesZone)
    }

    @Test
    fun `over pose follows enter and clears on exit, drop and end`() {
        val h = Harness()
        h.create("root")
        h.create("z", filesZone(), parent = "root")

        h.dnd.fileDragStarted(png)
        h.dnd.fileDragEntered("z")
        assertEquals("z", h.dnd.fileOverZone())
        assertEquals("over", h.dnd.poseLabelOf("z"))
        assertEquals(listOf("z" to mapOf<String, Any?>("backgroundColor.0" to "#eef2ff")), h.host.poses)

        h.dnd.fileDragExited("z")
        assertNull(h.dnd.fileOverZone())
        assertNull(h.dnd.poseLabelOf("z"))
        assertEquals("z" to null, h.host.poses.last())

        // Re-enter, then the session ends (cancel / drop elsewhere).
        h.dnd.fileDragEntered("z", png)
        assertEquals("over", h.dnd.poseLabelOf("z"))
        h.dnd.fileDragEnded()
        assertNull(h.dnd.poseLabelOf("z"))

        // Re-enter, then a release on the zone: rejected, pose cleared.
        h.dnd.fileDragEntered("z", png)
        assertFalse(h.dnd.fileDrop("z"))
        assertNull(h.dnd.poseLabelOf("z"))
        assertNull(h.dnd.fileOverZone())
        // A late `ended` after the drop is harmless.
        h.dnd.fileDragEnded()
        assertTrue(h.host.dispatched.isEmpty())
    }

    @Test
    fun `innermost enabled zone wins, one at a time`() {
        val h = Harness()
        h.create("root")
        h.create("outer", filesZone(), parent = "root")
        h.create("mid", emptyMap(), parent = "outer")
        h.create("inner", filesZone(), parent = "mid")
        h.dnd.fileDragStarted(png)

        h.dnd.fileDragEntered("outer")
        assertEquals("outer", h.dnd.fileOverZone())
        // Compose order moving into a child target: child entered, THEN parent exited.
        h.dnd.fileDragEntered("inner")
        assertEquals("inner", h.dnd.fileOverZone())
        assertNull(h.dnd.poseLabelOf("outer"))
        assertEquals("over", h.dnd.poseLabelOf("inner"))
        h.dnd.fileDragExited("outer")
        assertEquals("inner", h.dnd.fileOverZone())
        assertNull(h.dnd.poseLabelOf("outer"))

        // Back out to the parent: parent entered, THEN child exited.
        h.dnd.fileDragEntered("outer")
        assertEquals("inner", h.dnd.fileOverZone())
        h.dnd.fileDragExited("inner")
        assertEquals("outer", h.dnd.fileOverZone())
        assertEquals("over", h.dnd.poseLabelOf("outer"))
        assertNull(h.dnd.poseLabelOf("inner"))

        // Never two labels at once.
        val live = h.host.poses.fold(mutableSetOf<String>()) { acc, (id, pose) ->
            if (pose != null) acc.add(id) else acc.remove(id)
            assertTrue("two zones over at once: $acc", acc.size <= 1)
            acc
        }
        assertEquals(setOf("outer"), live)
    }

    @Test
    fun `disabled zones are transparent and the enclosing zone lights up`() {
        val h = Harness()
        h.create("root")
        h.create("outer", filesZone(), parent = "root")
        h.create("inner", filesZone(extra = mapOf("__dnd.zoneEnabled" to false)), parent = "outer")
        h.dnd.fileDragStarted(png)

        // The platform's deepest target is the disabled inner zone.
        h.dnd.fileDragEntered("inner")
        h.dnd.fileDragExited("outer")
        assertEquals("outer", h.dnd.fileOverZone())
        assertNull(h.dnd.poseLabelOf("inner"))

        // Enabling it mid-drag hands `over` to it.
        h.dnd.noteSetProp("inner", "__dnd.zoneEnabled", true)
        assertEquals("inner", h.dnd.fileOverZone())
        assertNull(h.dnd.poseLabelOf("outer"))

        // Disabling the only zone under the drag clears it.
        h.dnd.noteSetProp("outer", "__dnd.zoneEnabled", false)
        h.dnd.noteSetProp("inner", "__dnd.zoneEnabled", false)
        assertNull(h.dnd.fileOverZone())
        assertNull(h.dnd.poseLabelOf("inner"))
    }

    @Test
    fun `in-app zones and non-matching accept never light up`() {
        val h = Harness()
        h.create("root")
        h.create("inapp", mapOf("__dnd.zone" to mapOf("group" to null, "band" to 0.5), "__anim.statePoses" to overPose), parent = "root")
        h.create("pdf", filesZone(accept = "application/pdf", extra = mapOf("onFileDragEnter.0" to "@actions.upload")), parent = "inapp")
        h.dnd.fileDragStarted(png)

        h.dnd.fileDragEntered("pdf")
        assertNull(h.dnd.fileOverZone())
        assertNull(h.dnd.poseLabelOf("inapp"))
        assertNull(h.dnd.poseLabelOf("pdf"))
        assertTrue(h.host.dispatched.isEmpty())

        // The same zone with a matching drag.
        h.dnd.fileDragEnded()
        h.dnd.fileDragStarted(DndFileDragInfo(listOf("application/pdf")))
        h.dnd.fileDragEntered("pdf")
        assertEquals("pdf", h.dnd.fileOverZone())
        assertEquals(1, h.host.dispatched.size)
    }

    @Test
    fun `onFileDragEnter dispatches once per entry with the default payload`() {
        val h = Harness()
        h.create("root")
        h.create("z", filesZone(extra = mapOf("onFileDragEnter.0" to "@actions.upload")), parent = "root")
        h.create("child", filesZone(), parent = "z")
        h.dnd.fileDragStarted(DndFileDragInfo(listOf("image/png"), items = 3))

        h.dnd.fileDragEntered("z")
        assertEquals(
            listOf(Triple("z", "upload", mapOf<String, Any?>("type" to "filedragenter", "timestamp" to 1234L, "items" to 3))),
            h.host.dispatched,
        )
        // Into a nested zone and back: `z` still holds the drag — no re-fire.
        h.dnd.fileDragEntered("child")
        h.dnd.fileDragExited("z")
        h.dnd.fileDragEntered("z")
        h.dnd.fileDragExited("child")
        assertEquals(1, h.host.dispatched.size)

        // Leave and come back: a new entry.
        h.dnd.fileDragExited("z")
        h.dnd.fileDragEntered("z")
        assertEquals(2, h.host.dispatched.size)

        // A new session fires again.
        h.dnd.fileDragEnded()
        h.dnd.fileDragStarted(png)
        h.dnd.fileDragEntered("z")
        assertEquals(3, h.host.dispatched.size)
        assertEquals(0, h.host.dispatched.last().third["items"])
    }

    @Test
    fun `each nested zone fires its own entry, outermost first`() {
        val h = Harness()
        h.create("root")
        h.create("outer", filesZone(extra = mapOf("onFileDragEnter.0" to "@actions.outer")), parent = "root")
        h.create("inner", filesZone(extra = mapOf("onFileDragEnter.0" to "@actions.inner")), parent = "outer")
        h.dnd.fileDragStarted(png)
        // Straight into the inner zone from outside both.
        h.dnd.fileDragEntered("inner")
        assertEquals(listOf("outer", "inner"), h.host.dispatched.map { it.second })
        assertEquals("inner", h.dnd.fileOverZone())
    }

    @Test
    fun `custom named arguments replace the payload`() {
        val h = Harness()
        h.create("root")
        h.create(
            "z",
            filesZone(extra = mapOf("onFileDragEnter.0" to "@actions.upload", "onFileDragEnter.slot" to "avatar")),
            parent = "root",
        )
        h.dnd.fileDragEntered("z", png)
        assertEquals(listOf(Triple("z", "upload", mapOf<String, Any?>("slot" to "avatar"))), h.host.dispatched)
    }

    @Test
    fun `a zone without onFileDragEnter only poses`() {
        val h = Harness()
        h.create("root")
        h.create("z", filesZone(), parent = "root")
        h.dnd.fileDragEntered("z", png)
        assertEquals("z", h.dnd.fileOverZone())
        assertTrue(h.host.dispatched.isEmpty())
    }

    @Test
    fun `removing the hovered zone or resetting forgets the drag`() {
        val h = Harness()
        h.create("root")
        h.create("z", filesZone(), parent = "root")
        h.dnd.fileDragEntered("z", png)
        h.dnd.noteRemove("z")
        assertNull(h.dnd.fileOverZone())

        h.create("y", filesZone(), parent = "root")
        h.dnd.fileDragEntered("y", png)
        h.dnd.reset()
        assertNull(h.dnd.fileOverZone())
    }

    @Test
    fun `the in-app drag event vocabulary still has its six events plus onFileDragEnter`() {
        assertEquals("onFileDragEnter", DndEvent.FILE_DRAG_ENTER.prop)
        val binding = DndParse.eventBinding(mapOf("onFileDragEnter.0" to "@actions.upload"), DndEvent.FILE_DRAG_ENTER)
        assertEquals(DndEventBinding("upload", emptyMap(), null), binding)
    }
}
