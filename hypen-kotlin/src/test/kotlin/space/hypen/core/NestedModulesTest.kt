package space.hypen.core

import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Tests for NestedModuleInstance and createNestedModuleInstances.
 */
class NestedModulesTest {

    @BeforeEach
    fun resetRegistry() {
        app.clear()
    }

    // ========================================================================
    // A. NestedModuleInstance calls registerModule (not setModule)
    // ========================================================================

    @Test
    fun `nested module does NOT call setModule`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Sidebar")
        ).build()

        NestedModuleInstance(engine, def)

        assertEquals(0, engine.setModuleCallCount, "NestedModuleInstance must not call setModule")
    }

    @Test
    fun `nested module calls registerModule`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Sidebar")
        ).build()

        NestedModuleInstance(engine, def)

        assertEquals(1, engine.registerModuleCallCount, "NestedModuleInstance should call registerModule once")
        val registered = engine.getRegisteredModules()
        assertTrue(registered.containsKey("sidebar"), "expected module registered under 'sidebar'")
    }

    @Test
    fun `nested module registers with prefixed initial state`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(
            mapOf("count" to 0, "label" to "hello"),
            ModuleOptions(name = "Sidebar")
        ).build()

        NestedModuleInstance(engine, def)

        val registered = engine.getRegisteredModules()
        assertTrue(registered.containsKey("sidebar"), "expected module registered under 'sidebar'")
    }

    @Test
    fun `nested module with no prefix still calls registerModule`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(mapOf("x" to 1)).build()

        NestedModuleInstance(engine, def)

        // No prefix but registerModule is still called
        assertEquals(0, engine.setModuleCallCount)
        assertEquals(1, engine.registerModuleCallCount, "registerModule should be called even for anonymous modules")
    }

    // ========================================================================
    // B. Action handlers registered
    // ========================================================================

    @Test
    fun `nested module registers action handlers`() {
        val engine = MockEngine()
        var handlerCalled = false

        val def = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Widget")
        ).onAction("increment") { ctx ->
            handlerCalled = true
            val current = ctx.state.get("count") as? Int ?: 0
            ctx.state.set("count", current + 1)
        }.build()

        NestedModuleInstance(engine, def)

        assertTrue(engine.hasAction("increment"), "action handler should be registered")

        engine.triggerAction("increment")
        assertTrue(handlerCalled, "action handler should have been called")
    }

    @Test
    fun `nested module registers __hypen_bind handler`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(
            mapOf("name" to ""),
            ModuleOptions(name = "Form")
        ).build()

        NestedModuleInstance(engine, def)

        assertTrue(engine.hasAction("__hypen_bind"), "__hypen_bind should be registered")
    }

    // ========================================================================
    // C. State changes are prefixed
    // ========================================================================

    @Test
    fun `nested module state changes carry the module name as scope`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Counter")
        ).build()

        val instance = NestedModuleInstance(engine, def)

        // Clear initial injection changes
        engine.clearStateChanges()

        // Mutate state
        instance.getLiveState().set("count", 42)

        val scoped = engine.getScopedStateChanges()
        assertTrue(scoped.isNotEmpty(), "expected state changes after mutation")

        // The SDK passes the module name as-is — the engine canonicalizes
        // case internally. The mock records the host-supplied scope verbatim.
        val (scope, lastChange) = scoped.last()
        assertEquals("Counter", scope, "expected raw module name as scope")
        assertTrue(
            lastChange.paths.any { it == "count" },
            "expected raw path 'count', got ${lastChange.paths}"
        )
        assertEquals(42, lastChange.newValues["count"])
    }

    // ========================================================================
    // D. Lifecycle (onCreated / onDestroyed)
    // ========================================================================

    @Test
    fun `nested module calls onCreated`() {
        val engine = MockEngine()
        var created = false

        val def = AppBuilder.defineState(
            mapOf("x" to 1),
            ModuleOptions(name = "Lifecycle")
        ).onCreated { _, _ ->
            created = true
        }.build()

        NestedModuleInstance(engine, def)

        assertTrue(created, "onCreated should have been called")
    }

    @Test
    fun `nested module calls onDestroyed`() {
        val engine = MockEngine()
        var destroyed = false

        val def = AppBuilder.defineState(
            mapOf("x" to 1),
            ModuleOptions(name = "Lifecycle")
        ).onDestroyed { _, _ ->
            destroyed = true
        }.build()

        val instance = NestedModuleInstance(engine, def)
        assertFalse(destroyed)

        instance.destroy()

        assertTrue(destroyed, "onDestroyed should have been called")
        assertTrue(instance.isDestroyed(), "instance should be marked destroyed")
    }

    @Test
    fun `nested module destroy is idempotent`() {
        val engine = MockEngine()
        var destroyCount = 0

        val def = AppBuilder.defineState(
            mapOf("x" to 1),
            ModuleOptions(name = "Lifecycle")
        ).onDestroyed { _, _ ->
            destroyCount++
        }.build()

        val instance = NestedModuleInstance(engine, def)
        instance.destroy()
        instance.destroy()

        assertEquals(1, destroyCount, "onDestroyed should only be called once")
    }

    // ========================================================================
    // E. createNestedModuleInstances
    // ========================================================================

    @Test
    fun `createNestedModuleInstances creates instances for registered modules`() {
        val engine = MockEngine()
        val globalCtx = HypenGlobalContext()

        app.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Sidebar")
        ).build()
        app.defineState(
            mapOf("items" to listOf<Any>()),
            ModuleOptions(name = "Cart")
        ).build()

        val instances = createNestedModuleInstances(engine, app, globalCtx)

        assertEquals(2, instances.size)
        assertTrue(instances.containsKey("Sidebar"))
        assertTrue(instances.containsKey("Cart"))
        assertTrue(globalCtx.hasModule("sidebar"), "sidebar should be registered in context")
        assertTrue(globalCtx.hasModule("cart"), "cart should be registered in context")
    }

    @Test
    fun `createNestedModuleInstances skips already-instantiated modules`() {
        val engine = MockEngine()
        val globalCtx = HypenGlobalContext()

        app.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Sidebar")
        ).build()
        app.defineState(
            mapOf("items" to listOf<Any>()),
            ModuleOptions(name = "Cart")
        ).build()

        // Pre-register "sidebar" as already existing (via a regular ModuleInstance)
        val sidebarDef = app.get("Sidebar")!!
        val existingInstance = ModuleInstance(engine, sidebarDef, globalContext = globalCtx)
        globalCtx.registerModule("sidebar", existingInstance)

        val instances = createNestedModuleInstances(engine, app, globalCtx)

        // Only Cart should be created, Sidebar was skipped
        assertEquals(1, instances.size)
        assertTrue(instances.containsKey("Cart"))
        assertFalse(instances.containsKey("Sidebar"))
    }

    @Test
    fun `createNestedModuleInstances does not call setModule`() {
        val engine = MockEngine()
        val globalCtx = HypenGlobalContext()

        app.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Widget")
        ).build()

        val callsBefore = engine.setModuleCallCount
        createNestedModuleInstances(engine, app, globalCtx)

        assertEquals(callsBefore, engine.setModuleCallCount, "nested instances must not call setModule")
    }

    @Test
    fun `createNestedModuleInstances calls registerModule for each nested module`() {
        val engine = MockEngine()
        val globalCtx = HypenGlobalContext()

        app.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Sidebar")
        ).build()
        app.defineState(
            mapOf("items" to listOf<Any>()),
            ModuleOptions(name = "Cart")
        ).build()

        createNestedModuleInstances(engine, app, globalCtx)

        assertEquals(2, engine.registerModuleCallCount, "registerModule should be called for each nested module")
        val registered = engine.getRegisteredModules()
        assertTrue(registered.containsKey("sidebar"))
        assertTrue(registered.containsKey("cart"))
    }

    // ========================================================================
    // F. Integration: primary + nested modules coexist
    // ========================================================================

    @Test
    fun `primary and nested modules coexist on same engine`() {
        val engine = MockEngine()
        val globalCtx = HypenGlobalContext()

        // Create primary module via ModuleInstance (calls setModule)
        val primaryDef = AppBuilder.defineState(
            mapOf("page" to "home"),
            ModuleOptions(name = "Main")
        ).build()
        val primaryInstance = ModuleInstance(engine, primaryDef, globalContext = globalCtx)
        globalCtx.registerModule("main", primaryInstance)

        val setModuleCountAfterPrimary = engine.setModuleCallCount
        assertEquals(1, setModuleCountAfterPrimary, "primary module should call setModule once")

        // Create nested module (does NOT call setModule)
        val nestedDef = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Sidebar")
        ).build()
        val nestedInstance = NestedModuleInstance(engine, nestedDef, globalContext = globalCtx)
        globalCtx.registerNestedModule("sidebar", nestedInstance)

        assertEquals(
            setModuleCountAfterPrimary, engine.setModuleCallCount,
            "nested module must not call setModule"
        )

        // Nested module should have called registerModule
        assertEquals(1, engine.registerModuleCallCount, "nested module should call registerModule")
        val registered = engine.getRegisteredModules()
        assertTrue(registered.containsKey("sidebar"), "sidebar should be registered via registerModule")

        // Both should be visible in context
        assertTrue(globalCtx.hasModule("main"))
        assertTrue(globalCtx.hasModule("sidebar"))

        // Mutate nested state
        engine.clearStateChanges()
        nestedInstance.getLiveState().set("count", 10)

        val nestedChanges = engine.getScopedStateChanges()
        assertTrue(
            nestedChanges.any { (scope, change) ->
                scope == "Sidebar" && change.paths.contains("count")
            },
            "nested state mutation should target the 'Sidebar' scope with raw path 'count'"
        )
    }
}
