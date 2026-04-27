package space.hypen.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

// -------------------------------------------------------------------------
// Test state & action types
// -------------------------------------------------------------------------

@Serializable
data class CounterState(var count: Int = 0)

@Serializable
data class ProfileState(var name: String = "", var age: Int = 0, var active: Boolean = true)

sealed interface CounterAction : HypenAction {
    data object Increment : CounterAction
    data object Decrement : CounterAction
    data object Reset : CounterAction
}

sealed interface ProfileAction : HypenAction {
    @Serializable
    data class Rename(val newName: String) : ProfileAction

    @Serializable
    data class SetAge(val value: Int) : ProfileAction {
        override val _actionName: String get() = "updateAge"
    }

    data object Deactivate : ProfileAction
}

// -------------------------------------------------------------------------
// A. Typed hypen() builder — state initialization
// -------------------------------------------------------------------------

class TypedDslStateTest {

    @BeforeEach
    fun setup() {
        HypenApp.clear()
    }

    @Test
    fun `serializable data class is flattened to map`() {
        val def = hypen(CounterState(42)) {
            name("counter")
        }

        assertEquals(42, def.initialState["count"], "count should be flattened from data class")
        assertEquals(listOf("count"), def.stateKeys)
    }

    @Test
    fun `multi-field data class flattened correctly`() {
        val def = hypen(ProfileState(name = "Alice", age = 30, active = true)) {
            name("profile")
        }

        assertEquals("Alice", def.initialState["name"])
        assertEquals(30, def.initialState["age"])
        assertEquals(true, def.initialState["active"])
        assertTrue(def.stateKeys.containsAll(listOf("name", "age", "active")))
    }

    @Test
    fun `module name is set`() {
        val def = hypen(CounterState()) { name("myCounter") }
        assertEquals("myCounter", def.name)
    }

    @Test
    fun `persist and version are set`() {
        val def = hypen(CounterState()) {
            name("counter")
            persist(true)
            version(3)
        }
        assertEquals(true, def.persist)
        assertEquals(3, def.version)
    }
}

// -------------------------------------------------------------------------
// B. HypenAction — _actionName resolution
// -------------------------------------------------------------------------

class HypenActionNameTest {

    @Test
    fun `data object uses class simple name`() {
        assertEquals("Increment", CounterAction.Increment._actionName)
        assertEquals("Decrement", CounterAction.Decrement._actionName)
        assertEquals("Deactivate", ProfileAction.Deactivate._actionName)
    }

    @Test
    fun `data class defaults to simple name`() {
        val rename = ProfileAction.Rename("Bob")
        assertEquals("Rename", rename._actionName)
    }

    @Test
    fun `custom _actionName override`() {
        val setAge = ProfileAction.SetAge(25)
        assertEquals("updateAge", setAge._actionName)
    }
}

// -------------------------------------------------------------------------
// C. onAction — typed handler registration & dispatch
// -------------------------------------------------------------------------

class TypedDslActionTest {

    private lateinit var engine: MockEngine

    @BeforeEach
    fun setup() {
        HypenApp.clear()
        engine = MockEngine()
    }

    @Test
    fun `onAction registers handlers under correct action names`() {
        val def = hypen(CounterState()) {
            onAction<CounterAction.Increment> { _, _, _ -> }
            onAction<CounterAction.Decrement> { _, _, _ -> }
            onAction<CounterAction.Reset> { _, _, _ -> }
        }

        assertEquals(
            listOf("Increment", "Decrement", "Reset").sorted(),
            def.actions.sorted()
        )
    }

    @Test
    fun `onAction with custom _actionName uses override`() {
        val def = hypen(ProfileState()) {
            onAction<ProfileAction.SetAge> { _, _, _ -> }
        }

        assertTrue(def.actions.contains("updateAge"), "should use overridden _actionName")
    }

    @Test
    fun `data object action mutates state via var fields`() {
        val def = hypen(CounterState(count = 10)) {
            onAction<CounterAction.Increment> { action, state, context ->
                state.count += 1
            }
        }

        val instance = def.createInstance(engine)
        engine.dispatchAction("Increment")

        val state = instance.getState()
        assertEquals(11, state["count"], "count should be 11 after increment from 10")
    }

    @Test
    fun `multiple actions mutate state correctly`() {
        val def = hypen(CounterState(count = 0)) {
            onAction<CounterAction.Increment> { _, state, _ -> state.count += 1 }
            onAction<CounterAction.Decrement> { _, state, _ -> state.count -= 1 }
            onAction<CounterAction.Reset> { _, state, _ -> state.count = 0 }
        }

        val instance = def.createInstance(engine)

        engine.dispatchAction("Increment")
        engine.dispatchAction("Increment")
        engine.dispatchAction("Increment")
        assertEquals(3, instance.getState()["count"])

        engine.dispatchAction("Decrement")
        assertEquals(2, instance.getState()["count"])

        engine.dispatchAction("Reset")
        assertEquals(0, instance.getState()["count"])
    }

    @Test
    fun `data class action payload is deserialized and accessible`() {
        val def = hypen(ProfileState(name = "Alice")) {
            onAction<ProfileAction.Rename> { action, state, _ ->
                state.name = action.newName
            }
        }

        val instance = def.createInstance(engine)

        // Dispatch with JSON payload matching the Rename data class
        engine.triggerAction("Rename", mapOf("newName" to "Bob"))

        assertEquals("Bob", instance.getState()["name"])
    }

    @Test
    fun `data class action with custom name dispatches correctly`() {
        val def = hypen(ProfileState(age = 20)) {
            onAction<ProfileAction.SetAge> { action, state, _ ->
                state.age = action.value
            }
        }

        val instance = def.createInstance(engine)

        engine.triggerAction("updateAge", mapOf("value" to 35))

        assertEquals(35, instance.getState()["age"])
    }

    @Test
    fun `handler receives action instance for data objects`() {
        var receivedAction: CounterAction.Increment? = null

        val def = hypen(CounterState()) {
            onAction<CounterAction.Increment> { action, state, _ ->
                receivedAction = action
                state.count += 1
            }
        }

        def.createInstance(engine)
        engine.dispatchAction("Increment")

        assertNotNull(receivedAction, "handler should receive the data object instance")
        assertEquals("Increment", receivedAction!!._actionName)
    }

    @Test
    fun `handler receives context`() {
        var receivedContext: GlobalContext? = null
        val ctx = HypenGlobalContext()

        val def = hypen(CounterState()) {
            onAction<CounterAction.Increment> { _, state, context ->
                receivedContext = context
                state.count += 1
            }
        }

        def.createInstance(engine, context = ctx)
        engine.dispatchAction("Increment")

        assertEquals(ctx, receivedContext, "handler should receive the global context")
    }

    @Test
    fun `string-based onAction escape hatch works in typed builder`() {
        val def = hypen(CounterState()) {
            onAction("legacyAction") { ctx ->
                ctx.state.set("count", 99)
            }
        }

        val instance = def.createInstance(engine)
        engine.dispatchAction("legacyAction")

        assertEquals(99, instance.getState()["count"])
    }
}

// -------------------------------------------------------------------------
// D. State sync — var mutations flow back to engine
// -------------------------------------------------------------------------

class TypedDslStateSyncTest {

    private lateinit var engine: MockEngine

    @BeforeEach
    fun setup() {
        HypenApp.clear()
        engine = MockEngine()
    }

    @Test
    fun `state changes are notified to engine`() {
        val def = hypen(CounterState()) {
            onAction<CounterAction.Increment> { _, state, _ -> state.count += 1 }
        }

        def.createInstance(engine)
        engine.clearStateChanges()

        engine.dispatchAction("Increment")

        val changes = engine.getStateChanges()
        assertTrue(changes.isNotEmpty(), "engine should be notified of state change")
    }

    @Test
    fun `multi-field state syncs all changed fields`() {
        val def = hypen(ProfileState(name = "Alice", age = 25, active = true)) {
            onAction<ProfileAction.Deactivate> { _, state, _ ->
                state.active = false
                state.name = "Deactivated"
            }
        }

        val instance = def.createInstance(engine)
        engine.dispatchAction("Deactivate")

        val state = instance.getState()
        assertEquals(false, state["active"])
        assertEquals("Deactivated", state["name"])
        assertEquals(25, state["age"], "unchanged field should remain")
    }

    @Test
    fun `sequential actions accumulate state correctly`() {
        val def = hypen(CounterState()) {
            onAction<CounterAction.Increment> { _, state, _ -> state.count += 1 }
        }

        val instance = def.createInstance(engine)

        repeat(100) { engine.dispatchAction("Increment") }

        assertEquals(100, instance.getState()["count"])
    }
}

// -------------------------------------------------------------------------
// E. Lifecycle handlers — onCreated / onDestroyed with typed state
// -------------------------------------------------------------------------

class TypedDslLifecycleTest {

    @Test
    fun `onCreated receives typed state`() {
        var createdCount: Int? = null

        val def = hypen(CounterState(count = 42)) {
            onCreated { state, _ ->
                createdCount = state.count
            }
        }

        MockEngine().let { def.createInstance(it) }

        assertEquals(42, createdCount, "onCreated should receive the typed initial state")
    }

    @Test
    fun `onCreated can mutate state`() {
        val def = hypen(CounterState(count = 0)) {
            onCreated { state, _ ->
                state.count = 100
            }
            onAction<CounterAction.Increment> { _, state, _ -> state.count += 1 }
        }

        val engine = MockEngine()
        val instance = def.createInstance(engine)

        assertEquals(100, instance.getState()["count"], "onCreated mutation should be synced")

        engine.dispatchAction("Increment")
        assertEquals(101, instance.getState()["count"])
    }

    @Test
    fun `onDestroyed receives current typed state`() {
        var destroyedCount: Int? = null

        val def = hypen(CounterState()) {
            onAction<CounterAction.Increment> { _, state, _ -> state.count += 1 }
            onDestroyed { state, _ ->
                destroyedCount = state.count
            }
        }

        val engine = MockEngine()
        val instance = def.createInstance(engine)

        engine.dispatchAction("Increment")
        engine.dispatchAction("Increment")
        engine.dispatchAction("Increment")

        instance.destroy()

        assertEquals(3, destroyedCount, "onDestroyed should see the final state")
    }
}

// -------------------------------------------------------------------------
// F. Untyped DSL — backward compatibility
// -------------------------------------------------------------------------

class UntypedDslTest {

    @BeforeEach
    fun setup() {
        HypenApp.clear()
    }

    @Test
    fun `untyped hypen DSL still works`() {
        val def = hypen {
            name("legacy")
            state { "count" to 0 }
            onAction("increment") { ctx ->
                val current = ctx.state.get("count") as? Int ?: 0
                ctx.state.set("count", current + 1)
            }
        }

        val engine = MockEngine()
        val instance = def.createInstance(engine)

        engine.dispatchAction("increment")

        assertEquals(1, instance.getState()["count"])
    }

    @Test
    fun `untyped DSL registers actions`() {
        val def = hypen {
            state { "x" to 0 }
            onAction("a") { _ -> }
            onAction("b") { _ -> }
        }

        assertEquals(listOf("a", "b").sorted(), def.actions.sorted())
    }

    @Test
    fun `untyped DSL ui() sets template`() {
        val def = hypen {
            state { "greeting" to "hello" }
            ui("""Text("hello")""")
        }

        assertEquals("""Text("hello")""", def.ui)
    }
}

// -------------------------------------------------------------------------
// G. ui() and auto-registration
// -------------------------------------------------------------------------

class DslUiTest {

    @BeforeEach
    fun setup() {
        HypenApp.clear()
    }

    @Test
    fun `typed DSL ui() sets template on definition`() {
        val def = hypen(CounterState()) {
            name("counter")
            ui("""Text("count: @{state.count}")""")
        }

        assertEquals("""Text("count: @{state.count}")""", def.ui)
    }

    @Test
    fun `typed DSL without ui() leaves it null`() {
        val def = hypen(CounterState()) {
            name("counter")
        }

        assertEquals(null, def.ui)
    }

    @Test
    fun `untyped DSL ui() sets template on definition`() {
        val def = hypen {
            name("greeting")
            state { "msg" to "hi" }
            ui("""Text("hi")""")
        }

        assertEquals("""Text("hi")""", def.ui)
    }

    @Test
    fun `named typed module auto-registers in HypenApp`() {
        val def = hypen(CounterState()) {
            name("counter")
            ui("""Text("count: @{state.count}")""")
        }

        assertTrue(HypenApp.has("counter"))
        assertEquals(def.ui, HypenApp.get("counter")?.ui)
    }

    @Test
    fun `named untyped module auto-registers in HypenApp`() {
        hypen {
            name("greeting")
            state { "msg" to "hi" }
            ui("""Text("hi")""")
        }

        assertTrue(HypenApp.has("greeting"))
        assertEquals("""Text("hi")""", HypenApp.get("greeting")?.ui)
    }

    @Test
    fun `unnamed module does not auto-register`() {
        hypen(CounterState()) {
            ui("""Text("anon")""")
        }

        assertEquals(0, HypenApp.size)
    }
}
