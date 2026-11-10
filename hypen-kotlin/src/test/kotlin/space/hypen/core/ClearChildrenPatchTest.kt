package space.hypen.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * `clearChildren` (hypen-web/docs/clear-children.md): the SDK patch model,
 * its wire JSON, the UniFFI → SDK conversion, and the client-side meaning
 * (exactly a plain `remove` of every current child).
 */
class ClearChildrenPatchTest {
    @BeforeEach
    fun reset() = HypenApp.clear()

    @AfterEach
    fun cleanup() = HypenApp.clear()

    private fun requireNative() {
        val available = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(available, "Native Hypen engine library not available")
    }

    @Test
    fun `clearChildren encodes to the exact wire shape and round-trips`() {
        val patch = Patch(type = PatchType.CLEAR_CHILDREN, id = "4294967301")
        val encoded = Json.encodeToJsonElement(patch)
        assertEquals(
            Json.parseToJsonElement("""{"type":"clearChildren","id":"4294967301"}"""),
            encoded,
            "only type + id on the wire, like the Rust serde shape",
        )
        assertEquals(patch, Json.decodeFromString<Patch>("""{"type":"clearChildren","id":"4294967301"}"""))
        assertEquals(patch, Json.decodeFromJsonElement(Patch.serializer(), encoded))
    }

    private fun message(patches: List<Patch>): String = buildJsonObject {
        put("type", "patch")
        put("patches", JsonArray(patches.map { Json.encodeToJsonElement(it) }))
    }.toString()

    private val rowsUi = """
        module Rows {
            Column {
                ForEach(items: @state.rows, key: "id") {
                    Column { Text("@{item.t}") }
                }
            }
        }
    """.trimIndent()

    private fun rows(vararg pairs: Pair<String, String>) = pairs.map { (id, t) -> mapOf("id" to id, "t" to t) }

    @Test
    fun `engine clears a whole list with one clearChildren and the client tree drops every descendant`() {
        requireNative()
        NativeEngine().use { engine ->
            engine.registerDefaultPrimitives()
            engine.setModule("Rows", emptyList(), listOf("rows"), mapOf("rows" to rows("a" to "A", "b" to "B", "c" to "C")))
            val initial = engine.renderSource(rowsUi)
            val listId = initial.first { it.type == PatchType.CREATE && it.elementType == "Column" }.id!!

            val tree = RemoteWireConformanceTest.ClientTree()
            tree.apply(message(initial))
            assertEquals("A B C", tree.dump())
            // root Column + 3 × (row Column + Text)
            assertEquals(7, tree.size)

            val received = mutableListOf<Patch>()
            engine.setRenderCallback { received.addAll(it) }
            engine.updateState("", listOf("rows"), mapOf("rows" to emptyList<Any>()))

            val clears = received.filter { it.type == PatchType.CLEAR_CHILDREN }
            assertEquals(1, clears.size, "one clearChildren: ${received.map { it.type }}")
            assertEquals(listId, clears.single().id)
            assertEquals(Patch(type = PatchType.CLEAR_CHILDREN, id = listId), clears.single(), "UniFFI record → id only")
            assertTrue(received.none { it.type == PatchType.REMOVE }, "no per-row removes: ${received.map { it.type }}")

            // Same result as a plain remove of each child.
            val viaRemoves = RemoteWireConformanceTest.ClientTree()
            viaRemoves.apply(message(initial))
            val rowIds = initial.filter { it.type == PatchType.INSERT && it.parentId == listId }.map { it.id!! }
            assertEquals(3, rowIds.size)
            viaRemoves.apply(message(rowIds.map { Patch(type = PatchType.REMOVE, id = it) }))

            tree.apply(message(received))
            assertEquals("", tree.dump())
            assertEquals(1, tree.size, "only the list element survives")
            assertEquals(viaRemoves.dump(), tree.dump())
            assertEquals(viaRemoves.size, tree.size)

            // The parent still accepts children afterwards.
            received.clear()
            engine.updateState("", listOf("rows"), mapOf("rows" to rows("d" to "D")))
            tree.apply(message(received))
            assertEquals("D", tree.dump())
        }
    }

    @Test
    fun `wholesale replace orders clearChildren before the new rows`() {
        requireNative()
        NativeEngine().use { engine ->
            engine.registerDefaultPrimitives()
            engine.setModule("Rows", emptyList(), listOf("rows"), mapOf("rows" to rows("a" to "A", "b" to "B")))
            val initial = engine.renderSource(rowsUi)
            val tree = RemoteWireConformanceTest.ClientTree().also { it.apply(message(initial)) }

            val received = mutableListOf<Patch>()
            engine.setRenderCallback { received.addAll(it) }
            engine.updateState("", listOf("rows"), mapOf("rows" to rows("x" to "X", "y" to "Y", "z" to "Z")))

            val clearAt = received.indexOfFirst { it.type == PatchType.CLEAR_CHILDREN }
            assertTrue(clearAt >= 0, "clearChildren emitted: ${received.map { it.type }}")
            val firstNew = received.indexOfFirst { it.type == PatchType.CREATE || it.type == PatchType.INSERT }
            assertTrue(clearAt < firstNew, "clear, then fill: ${received.map { it.type }}")

            tree.apply(message(received))
            assertEquals("X Y Z", tree.dump())
            assertEquals(7, tree.size, "old rows gone, new rows in")
        }
    }

    @Test
    fun `clearChildren of an unknown id is a no-op on the client tree`() {
        val tree = RemoteWireConformanceTest.ClientTree()
        tree.apply(
            message(
                listOf(
                    Patch(type = PatchType.CREATE, id = "1", elementType = "Column", props = emptyMap()),
                    Patch(type = PatchType.INSERT, id = "1", parentId = "root"),
                    Patch(type = PatchType.CREATE, id = "2", elementType = "Text", props = mapOf("0" to kotlinx.serialization.json.JsonPrimitive("hi"))),
                    Patch(type = PatchType.INSERT, id = "2", parentId = "1"),
                ),
            ),
        )
        tree.apply(message(listOf(Patch(type = PatchType.CLEAR_CHILDREN, id = "999"))))
        assertEquals("hi", tree.dump())
        assertEquals(2, tree.size)
    }
}
