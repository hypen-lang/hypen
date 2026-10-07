package space.hypen.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Host side of drag-and-drop for the Kotlin SDK
 * (`hypen-web/docs/dnd.md`; design §6.5–6.7):
 *
 * - [ObservableState.move] routes through the engine's `portable_path_move`
 *   and is pinned by the shared `fixtures/dnd/path-move.json` cases.
 * - `__hypen_reorder` / `__hypen_pin` are auto-registered by every module
 *   instance and write through [ObservableState] (never the engine directly).
 * - The typed DSL's `syncBack` merges over the map, so the reserved `__dnd`
 *   subtree survives unrelated typed actions (the silent-wipe regression).
 */

private val fixtureJson = Json { ignoreUnknownKeys = true }

private fun Map<String, Any?>.asJson(): JsonElement = toJsonElement()

// -------------------------------------------------------------------------
// A. portable::path_move conformance through ObservableState.move
// -------------------------------------------------------------------------

class PathMoveFixtureTest {

    @TestFactory
    fun pathMoveFixture(): Collection<DynamicTest> {
        val file = File("../engine-compatibility-tests/fixtures/dnd/path-move.json")
        check(file.exists()) { "path-move fixture missing: ${file.absolutePath}" }
        val root = fixtureJson.parseToJsonElement(file.readText()).jsonObject
        assertEquals("path_move", root["function"]!!.jsonPrimitive.content)

        return root["cases"]!!.jsonArray.map { case ->
            val c = case.jsonObject
            DynamicTest.dynamicTest(c["name"]!!.jsonPrimitive.content) { runCase(c) }
        }
    }

    private fun runCase(c: JsonObject) {
        @Suppress("UNCHECKED_CAST")
        val initial = c["state"]!!.toKotlinValue() as Map<String, Any?>
        val op = c["op"]!!.jsonObject
        val fromPath = op["fromPath"]!!.jsonPrimitive.content
        val toPath = op["toPath"]!!.jsonPrimitive.content
        val from = op["from"]!!.jsonPrimitive.int
        val to = op["to"]!!.jsonPrimitive.int
        val expectedMoved = c["moved"]!!.jsonPrimitive.boolean

        val changes = mutableListOf<StateChange>()
        val state = ObservableState(initial.toMutableMap()) { changes.add(it) }

        val moved = state.move(fromPath, from, toPath, to)

        assertEquals(expectedMoved, moved, "moved flag")
        assertEquals(c["expected"], state.getAll().asJson(), "state after move")

        if (expectedMoved) {
            assertEquals(1, changes.size, "exactly one change notification per move")
            val paths = changes.single().paths
            assertTrue(paths.isNotEmpty(), "notified paths must not be empty")
            for (p in paths) {
                assertTrue(
                    p == fromPath || p == toPath,
                    "notified path '$p' must be one of the moved arrays",
                )
                // The notified value is the post-move array at that path.
                assertEquals(state.get(p).asJsonElement(), changes.single().newValues[p].asJsonElement())
            }
        } else {
            assertTrue(changes.isEmpty(), "a refused move must not notify")
        }
    }

    private fun Any?.asJsonElement(): JsonElement = toJsonElement()
}

// -------------------------------------------------------------------------
// B. ObservableState.move — change notification shape
// -------------------------------------------------------------------------

class ObservableStateMoveTest {

    @Test
    fun `same-array move notifies the array path once with the new order`() {
        val changes = mutableListOf<StateChange>()
        val state = ObservableState(mutableMapOf<String, Any?>("tasks" to listOf("a", "b", "c"))) { changes.add(it) }

        assertTrue(state.move("tasks", 0, "tasks", 2))

        assertEquals(listOf("b", "c", "a"), state.get("tasks"))
        assertEquals(1, changes.size)
        assertEquals(listOf("tasks"), changes[0].paths)
        assertEquals(mapOf("tasks" to listOf("b", "c", "a")), changes[0].newValues)
    }

    @Test
    fun `cross-array move notifies both arrays in one change`() {
        val changes = mutableListOf<StateChange>()
        val state = ObservableState(
            mutableMapOf<String, Any?>("todo" to listOf("a", "b"), "done" to listOf("z")),
        ) { changes.add(it) }

        assertTrue(state.move("todo", 1, "done", 0))

        assertEquals(1, changes.size)
        assertEquals(listOf("todo", "done"), changes[0].paths)
        assertEquals(listOf("a"), changes[0].newValues["todo"])
        assertEquals(listOf("b", "z"), changes[0].newValues["done"])
    }

    @Test
    fun `nested destination collapses the notification to the ancestor array`() {
        val changes = mutableListOf<StateChange>()
        val state = ObservableState(
            mutableMapOf<String, Any?>(
                "entries" to listOf(
                    mapOf("id" to "f", "children" to emptyList<Any?>()),
                    mapOf("id" to "a", "children" to listOf("a1")),
                ),
            ),
        ) { changes.add(it) }

        assertTrue(state.move("entries", 0, "entries.1.children", 1))

        // After removing index 0 the destination is re-addressed to what is
        // now entries.0.children; only `entries` is a stable path to report.
        assertEquals(1, changes.size)
        assertEquals(listOf("entries"), changes[0].paths)
        val entries = changes[0].newValues["entries"] as List<*>
        assertEquals(1, entries.size)
        val a = entries[0] as Map<*, *>
        assertEquals(listOf("a1", mapOf("id" to "f", "children" to emptyList<Any?>())), a["children"])
    }

    @Test
    fun `refused move leaves state untouched and does not notify`() {
        val changes = mutableListOf<StateChange>()
        val state = ObservableState(mutableMapOf<String, Any?>("tasks" to listOf("a", "b"))) { changes.add(it) }

        assertFalse(state.move("tasks", 5, "tasks", 0), "from out of range")
        assertFalse(state.move("tasks", 0, "missing", 0), "destination missing")
        assertFalse(state.move("tasks", -1, "tasks", 0), "negative index")
        assertFalse(state.move("tasks", 0, "tasks", -1), "negative index")

        assertEquals(listOf("a", "b"), state.get("tasks"))
        assertTrue(changes.isEmpty())
    }

    @Test
    fun `move inside a batch is applied immediately and notified with the batch`() {
        val changes = mutableListOf<StateChange>()
        val state = ObservableState(
            mutableMapOf<String, Any?>("tasks" to listOf("a", "b", "c"), "n" to 0),
        ) { changes.add(it) }

        state.batch {
            state.set("n", 1)
            assertTrue(state.move("tasks", 2, "tasks", 0))
            assertEquals(listOf("c", "a", "b"), state.get("tasks"), "visible inside the batch")
        }

        assertEquals(1, changes.size, "one flush for the whole batch")
        assertTrue(changes[0].paths.containsAll(listOf("n", "tasks")))
        assertEquals(listOf("c", "a", "b"), changes[0].newValues["tasks"])
        assertEquals(1, state.get("n"))
        assertEquals(listOf("c", "a", "b"), state.get("tasks"))
    }

    @Test
    fun `changedPathsForMove collapses ancestors`() {
        assertEquals(listOf("a"), ObservableState.changedPathsForMove("a", "a"))
        assertEquals(listOf("a"), ObservableState.changedPathsForMove("a", "a.1.children"))
        assertEquals(listOf("a"), ObservableState.changedPathsForMove("a.0.children", "a"))
        assertEquals(listOf("ab", "a"), ObservableState.changedPathsForMove("ab", "a"), "prefix without dot is NOT an ancestor")
        assertEquals(listOf("todo", "done"), ObservableState.changedPathsForMove("todo", "done"))
    }
}

// -------------------------------------------------------------------------
// C. __hypen_reorder dispatch (untyped modules)
// -------------------------------------------------------------------------

class ReorderActionTest {

    private lateinit var engine: MockEngine

    @BeforeEach
    fun setup() {
        HypenApp.clear()
        engine = MockEngine()
    }

    @Test
    fun `every module instance registers the reserved DnD actions`() {
        hypen { state { "tasks" to listOf("a") } }.createInstance(engine)

        assertTrue(engine.hasAction("__hypen_bind"))
        assertTrue(engine.hasAction(HypenDnd.REORDER_ACTION))
        assertTrue(engine.hasAction(HypenDnd.PIN_ACTION))
    }

    @Test
    fun `reorder with fromPath toPath applies path_move and notifies the engine`() {
        val instance = hypen {
            state { "tasks" to listOf("a", "b", "c", "d") }
        }.createInstance(engine)
        engine.clearStateChanges()

        engine.triggerAction(
            HypenDnd.REORDER_ACTION,
            mapOf("fromPath" to "tasks", "from" to 0, "toPath" to "tasks", "to" to 2),
        )

        assertEquals(listOf("b", "c", "a", "d"), instance.getState()["tasks"])
        val changes = engine.getStateChanges()
        assertEquals(1, changes.size, "one engine update per reorder")
        assertEquals(listOf("tasks"), changes[0].paths)
        assertEquals(listOf("b", "c", "a", "d"), changes[0].newValues["tasks"])
        assertEquals("", engine.getScopedStateChanges()[0].first, "primary module scope")
    }

    @Test
    fun `path shorthand means fromPath == toPath`() {
        val instance = hypen {
            state { "tasks" to listOf("a", "b", "c") }
        }.createInstance(engine)

        engine.triggerAction(HypenDnd.REORDER_ACTION, mapOf("path" to "tasks", "from" to 2, "to" to 0))

        assertEquals(listOf("c", "a", "b"), instance.getState()["tasks"])
    }

    @Test
    fun `cross-list reorder moves the item and notifies both arrays`() {
        val instance = hypen {
            state(
                mapOf(
                    "todo" to listOf(mapOf("id" to "t1"), mapOf("id" to "t2")),
                    "doing" to listOf(mapOf("id" to "d1")),
                ),
            )
        }.createInstance(engine)
        engine.clearStateChanges()

        engine.triggerAction(
            HypenDnd.REORDER_ACTION,
            mapOf("fromPath" to "todo", "from" to 1, "toPath" to "doing", "to" to 0),
        )

        val state = instance.getState()
        assertEquals(listOf(mapOf("id" to "t1")), state["todo"])
        assertEquals(listOf(mapOf("id" to "t2"), mapOf("id" to "d1")), state["doing"])
        val change = engine.getStateChanges().single()
        assertEquals(listOf("todo", "doing"), change.paths)
    }

    @Test
    fun `reorder change notification reaches module state listeners`() {
        val instance = hypen {
            state { "tasks" to listOf("a", "b") }
        }.createInstance(engine)
        var notified = 0
        val observed = mutableListOf<StateChange>()
        instance.onStateChange { notified++ }
        instance.getLiveState().addChangeListener { observed.add(it) }

        engine.triggerAction(HypenDnd.REORDER_ACTION, mapOf("path" to "tasks", "from" to 0, "to" to 1))

        assertEquals(1, notified)
        assertEquals(listOf("tasks"), observed.single().paths)
        assertEquals(listOf("b", "a"), observed.single().newValues["tasks"])
    }

    @Test
    fun `malformed or refused reorder payloads warn and leave state untouched`() {
        val instance = hypen {
            state { "tasks" to listOf("a", "b") }
        }.createInstance(engine)
        engine.clearStateChanges()

        val bad = listOf<Any?>(
            null,
            "tasks",
            mapOf("from" to 0, "to" to 1),                                  // no path
            mapOf("path" to "tasks", "from" to "0", "to" to 1),             // string index
            mapOf("path" to "tasks", "from" to 0.5, "to" to 1),             // fractional index
            mapOf("path" to "tasks", "from" to 0),                           // missing to
            mapOf("path" to "tasks", "from" to 7, "to" to 0),               // out of range
            mapOf("fromPath" to "tasks", "from" to 0, "toPath" to "nope", "to" to 0),
            mapOf("path" to "tasks", "from" to -1, "to" to 0),
        )
        for (payload in bad) {
            engine.triggerAction(HypenDnd.REORDER_ACTION, payload)
        }

        assertEquals(listOf("a", "b"), instance.getState()["tasks"])
        assertTrue(engine.getStateChanges().isEmpty(), "no engine update for refused moves")
    }

    @Test
    fun `destroyed instance ignores reorder`() {
        val instance = hypen {
            state { "tasks" to listOf("a", "b") }
        }.createInstance(engine)
        instance.destroy()
        engine.clearStateChanges()

        engine.triggerAction(HypenDnd.REORDER_ACTION, mapOf("path" to "tasks", "from" to 0, "to" to 1))

        assertEquals(listOf("a", "b"), instance.getState()["tasks"])
        assertTrue(engine.getStateChanges().isEmpty())
    }
}

// -------------------------------------------------------------------------
// D. __hypen_pin dispatch (untyped modules)
// -------------------------------------------------------------------------

class PinActionTest {

    private lateinit var engine: MockEngine

    @BeforeEach
    fun setup() {
        HypenApp.clear()
        engine = MockEngine()
    }

    @Test
    fun `reserved-mode pin auto-vivifies __dnd group key and writes both fields in ONE batch`() {
        val instance = hypen {
            state(mapOf("notes" to listOf(mapOf("id" to "n1"))))
        }.createInstance(engine)
        engine.clearStateChanges()

        engine.triggerAction(
            HypenDnd.PIN_ACTION,
            mapOf("path" to HypenDnd.reservedPinPath("board", "n1"), "x" to 296, "y" to 200, "xKey" to "x", "yKey" to "y"),
        )

        assertEquals(mapOf("board" to mapOf("n1" to mapOf("x" to 296, "y" to 200))), instance.getState()["__dnd"])
        val changes = engine.getStateChanges()
        assertEquals(1, changes.size, "two path sets must land in a single engine update")
        assertEquals(listOf("__dnd.board.n1.x", "__dnd.board.n1.y"), changes[0].paths)
        assertEquals(296, changes[0].newValues["__dnd.board.n1.x"])
        assertEquals(200, changes[0].newValues["__dnd.board.n1.y"])
    }

    @Test
    fun `repeated pins accumulate per key and overwrite in place`() {
        val instance = hypen { state { "n" to 0 } }.createInstance(engine)

        engine.triggerAction(HypenDnd.PIN_ACTION, mapOf("path" to "__dnd.board.n1", "x" to 1, "y" to 2))
        engine.triggerAction(HypenDnd.PIN_ACTION, mapOf("path" to "__dnd.board.n2", "x" to 3, "y" to 4))
        engine.triggerAction(HypenDnd.PIN_ACTION, mapOf("path" to "__dnd.board.n1", "x" to 10, "y" to 20))

        assertEquals(
            mapOf("board" to mapOf("n1" to mapOf("x" to 10, "y" to 20), "n2" to mapOf("x" to 3, "y" to 4))),
            instance.getState()["__dnd"],
        )
    }

    @Test
    fun `user-field pin writes the named keys on the bound item`() {
        val instance = hypen {
            state(mapOf("notes" to listOf(mapOf("id" to "n1", "left" to 0, "top" to 0), mapOf("id" to "n2"))))
        }.createInstance(engine)

        engine.triggerAction(
            HypenDnd.PIN_ACTION,
            mapOf("path" to HypenDnd.userPinPath("notes", 1), "x" to 12.5, "y" to 7, "xKey" to "left", "yKey" to "top"),
        )

        val notes = instance.getState()["notes"] as List<*>
        assertEquals(mapOf("id" to "n1", "left" to 0, "top" to 0), notes[0])
        assertEquals(mapOf("id" to "n2", "left" to 12.5, "top" to 7), notes[1])
    }

    @Test
    fun `xKey yKey default to x y`() {
        val instance = hypen { state { "n" to 0 } }.createInstance(engine)

        engine.triggerAction(HypenDnd.PIN_ACTION, mapOf("path" to "__dnd.g.k", "x" to 5, "y" to 6))

        assertEquals(mapOf("g" to mapOf("k" to mapOf("x" to 5, "y" to 6))), instance.getState()["__dnd"])
    }

    @Test
    fun `malformed pin payloads warn and leave state untouched`() {
        val instance = hypen { state { "n" to 0 } }.createInstance(engine)
        engine.clearStateChanges()

        val bad = listOf<Any?>(
            null,
            mapOf("x" to 1, "y" to 2),                          // no path
            mapOf("path" to "", "x" to 1, "y" to 2),            // empty path
            mapOf("path" to "__dnd.g.k", "x" to "1", "y" to 2), // string coordinate
            mapOf("path" to "__dnd.g.k", "x" to 1),             // missing y
            mapOf("path" to "__dnd.g.k", "x" to Double.NaN, "y" to 2),
            mapOf("path" to "__dnd.g.k", "x" to 1, "y" to Double.POSITIVE_INFINITY),
        )
        for (payload in bad) {
            engine.triggerAction(HypenDnd.PIN_ACTION, payload)
        }

        assertNull(instance.getState()["__dnd"])
        assertTrue(engine.getStateChanges().isEmpty())
    }
}

// -------------------------------------------------------------------------
// E. Typed modules — the silent-wipe regression (design §6.6)
// -------------------------------------------------------------------------

@Serializable
data class DndNote(var id: String = "", var text: String = "")

/** Deliberately declares NO x/y and NO __dnd: the reserved subtree lives only in the map. */
@Serializable
data class DndBoardState(var title: String = "", var notes: List<DndNote> = emptyList())

sealed interface DndBoardAction : HypenAction {
    @Serializable
    data class Retitle(val title: String) : DndBoardAction

    data object Touch : DndBoardAction
}

@Serializable
data class DndListState(var tasks: List<String> = emptyList(), var clicks: Int = 0)

sealed interface DndListAction : HypenAction {
    data object Click : DndListAction
}

/** Captures warnings so the dropped-key guard can be asserted without touching stdout. */
private class RecordingLogHandler : LogHandler {
    val warnings = mutableListOf<String>()
    override fun debug(tag: String, message: String, args: List<Any?>) {}
    override fun info(tag: String, message: String, args: List<Any?>) {}
    override fun warn(tag: String, message: String, args: List<Any?>) { warnings.add("[$tag] $message") }
    override fun error(tag: String, message: String, args: List<Any?>) {}
}

class TypedDndRoundTripTest {

    private lateinit var engine: MockEngine
    private val previousLevel = Logger.getLogLevel()
    private val handler = RecordingLogHandler()

    @BeforeEach
    fun setup() {
        HypenApp.clear()
        engine = MockEngine()
        Logger.configure(LoggerConfig(level = LogLevel.WARN, handler = handler))
    }

    @AfterEach
    fun restoreLogger() {
        Logger.configure(LoggerConfig(level = previousLevel))
    }

    @Test
    fun `reserved __dnd survives an unrelated typed action (silent-wipe regression)`() {
        val def = hypen(DndBoardState(title = "Board", notes = listOf(DndNote("n1", "one"), DndNote("n2", "two")))) {
            onAction<DndBoardAction.Retitle> { action, state, _ -> state.title = action.title }
            onAction<DndBoardAction.Touch> { _, state, _ -> state.notes[0].text = "touched" }
        }
        val instance = def.createInstance(engine)

        // Renderer drops a note on a reserved-mode pinboard.
        engine.triggerAction(
            HypenDnd.PIN_ACTION,
            mapOf("path" to "__dnd.board.n1", "x" to 296, "y" to 200, "xKey" to "x", "yKey" to "y"),
        )
        val pinned = mapOf("board" to mapOf("n1" to mapOf("x" to 296, "y" to 200)))
        assertEquals(pinned, instance.getState()["__dnd"])

        // Unrelated typed actions decode -> mutate -> syncBack. Before the
        // merge-over rule this re-encoded the data class WITHOUT __dnd and
        // wiped the pin.
        engine.triggerAction("Retitle", mapOf("title" to "Renamed"))
        engine.dispatchAction("Touch")

        val state = instance.getState()
        assertEquals("Renamed", state["title"])
        assertEquals("touched", (state["notes"] as List<*>).let { (it[0] as Map<*, *>)["text"] })
        assertEquals(pinned, state["__dnd"], "__dnd must survive typed round-trips")
        assertTrue(
            handler.warnings.none { "__dnd" in it },
            "reserved keys are preserved, not warned about: ${handler.warnings}",
        )
    }

    @Test
    fun `typed actions never send __dnd back to the engine as a whole-map replace`() {
        val def = hypen(DndBoardState(title = "Board")) {
            onAction<DndBoardAction.Retitle> { action, state, _ -> state.title = action.title }
        }
        def.createInstance(engine)
        engine.triggerAction(HypenDnd.PIN_ACTION, mapOf("path" to "__dnd.board.n1", "x" to 1, "y" to 2))
        engine.clearStateChanges()

        engine.triggerAction("Retitle", mapOf("title" to "Renamed"))

        // syncBack merges the typed fields only; the engine keeps its __dnd.
        val change = engine.getStateChanges().single()
        assertTrue(change.paths.none { it.startsWith("__dnd") }, "syncBack must not touch __dnd: ${change.paths}")
        assertTrue(change.paths.containsAll(listOf("title", "notes")))
    }

    @Test
    fun `reorder on a typed list survives an unrelated typed action`() {
        val def = hypen(DndListState(tasks = listOf("a", "b", "c"))) {
            onAction<DndListAction.Click> { _, state, _ -> state.clicks += 1 }
        }
        val instance = def.createInstance(engine)

        engine.triggerAction(HypenDnd.REORDER_ACTION, mapOf("path" to "tasks", "from" to 0, "to" to 2))
        assertEquals(listOf("b", "c", "a"), instance.getState()["tasks"])

        engine.dispatchAction("Click")

        assertEquals(listOf("b", "c", "a"), instance.getState()["tasks"], "sort is immune to the typed round-trip")
        assertEquals(1, instance.getState()["clicks"])
    }

    @Test
    fun `user-field pin onto an undeclared field warns once when the typed encoding drops it`() {
        val def = hypen(DndBoardState(title = "Board", notes = listOf(DndNote("n1", "one")))) {
            onAction<DndBoardAction.Touch> { _, state, _ -> state.title = "t" }
        }
        val instance = def.createInstance(engine)

        // `.pinboard(x: "x", y: "y").bind(@state.notes)` on a Note that
        // declares no x/y: the write lands in the map...
        engine.triggerAction(HypenDnd.PIN_ACTION, mapOf("path" to "notes.0", "x" to 40, "y" to 60))
        assertEquals(40, ((instance.getState()["notes"] as List<*>)[0] as Map<*, *>)["x"])

        // ...and the next typed round-trip cannot keep it (documented
        // hazard, design §6.6). The SHOULD guard makes that loud, once.
        engine.dispatchAction("Touch")
        engine.dispatchAction("Touch")

        val note = (instance.getState()["notes"] as List<*>)[0] as Map<*, *>
        assertFalse(note.containsKey("x"), "encoding without x drops the field (this is the hazard the warning reports)")
        assertEquals(1, handler.warnings.count { "`notes.0.x`" in it }, "warn once per path: ${handler.warnings}")
        assertEquals(1, handler.warnings.count { "`notes.0.y`" in it }, "warn once per path: ${handler.warnings}")
    }

    @Test
    fun `dropped-key warning can be switched off`() {
        val previous = TypedHypenModuleBuilder.warnOnDroppedKeys
        try {
            TypedHypenModuleBuilder.warnOnDroppedKeys = false
            val def = hypen(DndBoardState(notes = listOf(DndNote("n1", "one")))) {
                onAction<DndBoardAction.Touch> { _, state, _ -> state.title = "t" }
            }
            def.createInstance(engine)
            engine.triggerAction(HypenDnd.PIN_ACTION, mapOf("path" to "notes.0", "x" to 1, "y" to 2))
            engine.dispatchAction("Touch")
            assertTrue(handler.warnings.none { "dropped" in it }, handler.warnings.toString())
        } finally {
            TypedHypenModuleBuilder.warnOnDroppedKeys = previous
        }
    }

    @Test
    fun `lifecycle handlers preserve __dnd too`() {
        var seenTitle: String? = null
        val def = hypen(DndBoardState(title = "Board")) {
            onActivated { state, _ -> state.title = "active" }
            onDeactivated { state, _ -> seenTitle = state.title }
        }
        val instance = def.createInstance(engine)
        engine.triggerAction(HypenDnd.PIN_ACTION, mapOf("path" to "__dnd.board.n1", "x" to 1, "y" to 2))

        instance.activate()
        instance.deactivate()

        assertEquals("active", seenTitle)
        assertEquals(mapOf("board" to mapOf("n1" to mapOf("x" to 1, "y" to 2))), instance.getState()["__dnd"])
    }
}

// -------------------------------------------------------------------------
// F. End to end on the native engine: pin -> SetProp translateX.0/translateY.0
// -------------------------------------------------------------------------

class NativeDndPinRenderTest {

    @BeforeEach
    fun resetRegistry() {
        HypenApp.clear()
    }

    @Test
    fun `__hypen_pin on a reserved-mode pinboard re-resolves exactly the pinned node`() {
        val engineAvailable = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(engineAvailable, "Native Hypen engine library not available")

        NativeEngine().use { engine ->
            engine.registerDefaultPrimitives()
            engine.registerPrimitive("Note")

            val def = hypen {
                name("Board")
                state(
                    mapOf(
                        "notes" to listOf(mapOf("id" to "n1", "text" to "one"), mapOf("id" to "n2", "text" to "two")),
                    ),
                )
            }
            val instance = def.createInstance(engine)

            val received = mutableListOf<Patch>()
            engine.setRenderCallback { received.addAll(it) }

            val initial = engine.renderSource(
                """
                module Board {
                    Stack {
                        ForEach(items: @state.notes, key: "id") {
                            Note("@{item.text}").draggable()
                        }
                    }.pinboard(group: "board")
                }
                """.trimIndent(),
            )

            // Wire contract (fixtures/dnd/pinboard-reserved-lowering.json):
            // both Notes carry the injected translate bindings, resolving to
            // explicit null while the reserved path is unset.
            val noteCreates = initial.filter { it.type == PatchType.CREATE && it.elementType == "Note" }
            assertEquals(2, noteCreates.size, "creates: ${initial.map { it.type + ":" + it.elementType }}")
            val n1 = noteCreates.first { it.props?.get("__dnd.key") == JsonPrimitive("n1") }
            assertEquals("board", (n1.props?.get("__dnd.pinGroup") as? JsonPrimitive)?.content)
            assertTrue(n1.props!!.containsKey("translateX.0"), "translateX.0 present on Create: ${n1.props.keys}")
            assertEquals(kotlinx.serialization.json.JsonNull, n1.props["translateX.0"])
            received.clear()

            // The renderer's drop outcome.
            engine.triggerAction(
                HypenDnd.PIN_ACTION,
                mapOf("path" to "__dnd.board.n1", "x" to 120, "y" to 80, "xKey" to "x", "yKey" to "y"),
            )

            assertEquals(
                mapOf("board" to mapOf("n1" to mapOf("x" to 120, "y" to 80))),
                instance.getState()["__dnd"],
            )
            val setProps = received.filter { it.type == PatchType.SET_PROP }
            assertTrue(received.all { it.type == PatchType.SET_PROP }, "nothing structural: ${received.map { it.type }}")
            val byName = setProps.associate { it.name to it.value }
            assertEquals(JsonPrimitive(120), byName["translateX.0"], "setProps: $setProps")
            assertEquals(JsonPrimitive(80), byName["translateY.0"], "setProps: $setProps")
            assertTrue(setProps.all { it.id == n1.id }, "only the pinned node re-resolves: $setProps")
        }
    }
}
