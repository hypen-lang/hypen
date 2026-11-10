package space.hypen.renderer

import com.squareup.moshi.Moshi
import com.squareup.moshi.adapters.EnumJsonAdapter
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.anim.ANIM_EXIT_PROP
import space.hypen.renderer.anim.AlwaysAnimate
import space.hypen.renderer.anim.AnimationCoordinator
import space.hypen.renderer.model.Patch
import space.hypen.renderer.model.PatchMessage
import space.hypen.renderer.model.PatchType
import space.hypen.renderer.remote.MoshiMessageParser
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.render.RendererStateListener

/**
 * `clearChildren` (hypen-web/docs/clear-children.md): exactly a plain
 * `remove` of every current child of `id`, applied with one child-list write.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ClearChildrenTest {
    private val exit = mapOf("presets" to listOf("fade"), "duration" to 150.0, "curve" to "easeIn")

    /** `list` (a column under root) with three rows, each row a column holding one text. */
    private fun listTree(rowProps: (String) -> Map<String, Any?> = { emptyMap() }): List<Patch> =
        listOf(Patch.create("list", "column", mapOf("gap" to 4.0)), Patch.insert("root", "list")) +
            listOf("1", "2", "3").flatMap { n ->
                listOf(
                    Patch.create("r$n", "column", rowProps("r$n")),
                    Patch.create("t$n", "text", mapOf("0" to "row $n", ANIM_EXIT_PROP to exit)),
                    Patch.insert("r$n", "t$n"),
                    Patch.insert("list", "r$n"),
                )
            }

    private val subtreeIds = listOf("r1", "t1", "r2", "t2", "r3", "t3")

    private class Removed : RendererStateListener {
        val ids = mutableListOf<String>()

        override fun onElementRemoved(id: String) {
            ids += id
        }
    }

    @Test
    fun `clearChildren parses from the wire and round-trips through Moshi`() {
        val json = """{"type":"patch","module":"M","patches":[{"type":"clearChildren","id":"4294967301"}],"revision":3}"""
        val message = MoshiMessageParser().parseMessage(json) as PatchMessage
        val patch = message.patches.single()
        assertEquals(PatchType.CLEAR_CHILDREN, patch.type)
        assertEquals("4294967301", patch.id)
        assertEquals(Patch.clearChildren("4294967301"), patch)

        // Same adapter configuration as MoshiMessageParser.
        val adapter =
            Moshi
                .Builder()
                .add(PatchType::class.java, EnumJsonAdapter.create(PatchType::class.java).withUnknownFallback(null))
                .addLast(KotlinJsonAdapterFactory())
                .build()
                .adapter(Patch::class.java)
        val encoded = adapter.toJson(patch)
        assertTrue(encoded, encoded.contains("\"type\":\"clearChildren\""))
        assertEquals(patch, adapter.fromJson(encoded))
    }

    @Test
    fun `all children and their descendants leave every table, the parent survives`() = runTest {
        val animation = AnimationCoordinator(AlwaysAnimate, backgroundScope)
        val r = ComposeRenderer(animation = animation)
        val removed = Removed().also(r::addStateListener)
        r.applyPatches(listTree())
        subtreeIds.forEach { assertNotNull(r.getElement(it)) }
        assertNotNull(animation.specsFor("t1"))

        r.applyPatches(listOf(Patch.clearChildren("list")))

        subtreeIds.forEach { assertNull("$it evicted", r.getElement(it)) }
        subtreeIds.forEach { assertNull("$it animation state dropped", animation.specsFor(it)) }
        assertEquals(subtreeIds.toSet(), removed.ids.toSet())
        assertEquals(subtreeIds.size, removed.ids.size)

        val list = r.getElement("list")!!
        assertTrue(list.children.isEmpty())
        assertTrue(list.childIds.isEmpty())
        assertEquals(4.0, list.rawProps["gap"])
        assertEquals(listOf("list"), r.getRootChildIds())
        assertTrue(r.getDetachedIds().isEmpty())
    }

    @Test
    fun `clear then fill in the same batch`() {
        val r = ComposeRenderer()
        r.applyPatches(listTree())
        r.applyPatches(
            listOf(
                Patch.clearChildren("list"),
                Patch.create("r4", "column"),
                Patch.create("t4", "text", mapOf("0" to "row 4")),
                Patch.insert("r4", "t4"),
                Patch.insert("list", "r4"),
                Patch.create("r5", "column"),
                Patch.insert("list", "r5"),
            ),
        )
        val list = r.getElement("list")!!
        assertEquals(listOf("r4", "r5"), list.children.toList())
        assertEquals(listOf("r4", "r5"), list.childIds)
        assertEquals("list", r.getElement("r4")!!.parentId)
        subtreeIds.forEach { assertNull(r.getElement(it)) }
    }

    @Test
    fun `unknown id and an empty element are no-ops`() {
        val r = ComposeRenderer()
        val removed = Removed().also(r::addStateListener)
        r.applyPatches(listTree())
        r.applyPatches(listOf(Patch.clearChildren("ghost")))
        r.applyPatches(listOf(Patch.clearChildren("t1")))
        subtreeIds.forEach { assertNotNull(r.getElement(it)) }
        assertEquals(listOf("r1", "r2", "r3"), r.getElement("list")!!.children.toList())
        assertTrue(removed.ids.isEmpty())
    }

    @Test
    fun `result equals a plain remove of each child`() {
        val cleared = ComposeRenderer()
        val clearedRemoved = Removed().also(cleared::addStateListener)
        val viaRemoves = ComposeRenderer()
        val viaRemovesRemoved = Removed().also(viaRemoves::addStateListener)
        listOf(cleared, viaRemoves).forEach { it.applyPatches(listTree()) }

        cleared.applyPatches(listOf(Patch.clearChildren("list")))
        viaRemoves.applyPatches(listOf("r1", "r2", "r3").map { Patch.remove(it) })

        for (id in listOf("list") + subtreeIds) {
            assertEquals(id, viaRemoves.getElement(id) == null, cleared.getElement(id) == null)
        }
        assertEquals(viaRemoves.getElement("list")!!.children.toList(), cleared.getElement("list")!!.children.toList())
        assertEquals(viaRemoves.getElement("list")!!.rawProps, cleared.getElement("list")!!.rawProps)
        assertEquals(viaRemoves.getRootChildIds(), cleared.getRootChildIds())
        assertEquals(viaRemoves.getDetachedIds(), cleared.getDetachedIds())
        assertEquals(viaRemovesRemoved.ids, clearedRemoved.ids)
    }

    @Test
    fun `a row detached earlier is not a child, so the clear leaves it alive`() {
        val r = ComposeRenderer()
        r.applyPatches(listTree())
        r.applyPatches(listOf(Patch.detach("r2")))
        r.applyPatches(listOf(Patch.clearChildren("list")))
        assertNull(r.getElement("r1"))
        assertNull(r.getElement("r3"))
        assertNotNull(r.getElement("r2"))
        assertEquals(listOf("r2"), r.getDetachedIds())
    }

    @Test
    fun `a child already playing an earlier exit finishes it, the rest go now`() = runTest {
        val r = ComposeRenderer(animation = AnimationCoordinator(AlwaysAnimate, backgroundScope))
        r.applyPatches(listTree { mapOf(ANIM_EXIT_PROP to exit) })
        r.applyPatches(listOf(Patch.remove("r1", transition = true)))
        assertNotNull(r.getElement("r1"))

        r.applyPatches(listOf(Patch.clearChildren("list"), Patch.create("r4", "column"), Patch.insert("list", "r4")))
        listOf("r2", "t2", "r3", "t3").forEach { assertNull(r.getElement(it)) }
        assertNotNull("exiting corpse keeps playing", r.getElement("r1"))
        assertEquals(listOf("r1", "r4"), r.getElement("list")!!.children.toList())

        advanceTimeBy(231)
        runCurrent()
        assertNull(r.getElement("r1"))
        assertNull(r.getElement("t1"))
        assertEquals(listOf("r4"), r.getElement("list")!!.children.toList())
    }
}
