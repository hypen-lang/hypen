package space.hypen.core

import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Tests for Named State Paths, App Registry (auto-registration), and ManagedRouter.
 */
class NamedStateRegistryTest {

    @BeforeEach
    fun resetRegistry() {
        app.clear()
    }

    // ========================================================================
    // A. Named State Paths Tests (5 tests)
    // ========================================================================

    @Test
    fun `primary ModuleInstance writes flat initial state to the engine`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "HomePage")
        ).build()

        ModuleInstance(engine, def)

        val state = engine.getModuleState()
        // Primary modules no longer nest state under the module name — the engine
        // receives a flat state tree and scopes it internally via module_scope.
        assertEquals(0, state["count"])
        assertFalse(state.containsKey("homepage"), "expected flat state, got $state")
    }

    @Test
    fun `anonymous module writes flat state`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(mapOf("count" to 0)).build()

        ModuleInstance(engine, def)

        val state = engine.getModuleState()
        assertEquals(0, state["count"])
    }

    @Test
    fun `empty name module has no prefix`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(
            mapOf("x" to 1),
            ModuleOptions(name = "")
        ).build()

        ModuleInstance(engine, def)

        val state = engine.getModuleState()
        assertEquals(1, state["x"])
        assertFalse(state.containsKey(""), "should not have empty key")
    }

    @Test
    fun `primary module state changes use raw paths with empty scope`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Counter")
        ).build()

        val instance = ModuleInstance(engine, def)

        // Mutate state
        instance.getLiveState().set("count", 42)

        val scoped = engine.getScopedStateChanges()
        assertTrue(scoped.isNotEmpty(), "expected state changes")

        val (scope, lastChange) = scoped.last()
        // Primary modules target the engine's unnamed scope.
        assertEquals("", scope, "expected empty scope for primary module")
        assertTrue(
            lastChange.paths.any { it == "count" },
            "expected raw path 'count', got ${lastChange.paths}"
        )
    }

    @Test
    fun `nested module state changes carry the module name as scope with raw paths`() {
        val engine = MockEngine()
        val def = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Counter")
        ).build()

        val instance = NestedModuleInstance(engine, def)

        instance.getLiveState().set("count", 42)

        val scoped = engine.getScopedStateChanges()
        assertTrue(scoped.isNotEmpty(), "expected state changes")

        // The SDK passes the module name as-is — the engine canonicalizes
        // case internally — so the recorded scope reflects the original casing.
        val (scope, lastChange) = scoped.last()
        assertEquals("Counter", scope, "expected raw module name as scope")
        assertTrue(
            lastChange.paths.any { it == "count" },
            "expected raw path 'count', got ${lastChange.paths}"
        )
    }

    // ========================================================================
    // B. App Registry — auto-registration via build() (9 tests)
    // ========================================================================

    @Test
    fun `named module auto-registers on build`() {
        val def = app.defineState(mapOf("count" to 0), ModuleOptions(name = "Counter")).build()

        assertTrue(app.has("Counter"), "expected Counter to be auto-registered")
        assertEquals(def, app.get("Counter"))
    }

    @Test
    fun `anonymous module does NOT auto-register`() {
        app.defineState(mapOf("count" to 0)).build()
        assertEquals(0, app.size)
    }

    @Test
    fun `get returns null for missing`() {
        assertNull(app.get("Missing"))
    }

    @Test
    fun `has returns false for missing`() {
        assertFalse(app.has("Missing"))
    }

    @Test
    fun `unregister removes definition`() {
        app.defineState(mapOf<String, Any>(), ModuleOptions(name = "Widget")).build()
        app.unregister("Widget")
        assertFalse(app.has("Widget"))
    }

    @Test
    fun `size tracks registrations`() {
        assertEquals(0, app.size)

        app.defineState(mapOf<String, Any>(), ModuleOptions(name = "A")).build()
        app.defineState(mapOf<String, Any>(), ModuleOptions(name = "B")).build()
        assertEquals(2, app.size)
    }

    @Test
    fun `getNames returns all names`() {
        app.defineState(mapOf<String, Any>(), ModuleOptions(name = "Foo")).build()
        app.defineState(mapOf<String, Any>(), ModuleOptions(name = "Bar")).build()

        val names = app.getNames()
        assertTrue(names.contains("Foo"))
        assertTrue(names.contains("Bar"))
    }

    @Test
    fun `clear removes all`() {
        app.defineState(mapOf<String, Any>(), ModuleOptions(name = "A")).build()
        app.defineState(mapOf<String, Any>(), ModuleOptions(name = "B")).build()
        app.clear()
        assertEquals(0, app.size)
    }

    @Test
    fun `app module() convenience auto-registers`() {
        val def = app.module("Settings")
            .defineState(mapOf("theme" to "dark"))
            .build()

        assertTrue(app.has("Settings"), "expected Settings to be auto-registered via module()")
        assertEquals(def, app.get("Settings"))
        assertEquals("Settings", def.name)
    }

    // ========================================================================
    // C. ManagedRouter Tests (4 tests)
    // ========================================================================

    @Test
    fun `managed router mounts on start`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        app.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Home")
        ).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/", component = "Home"))
        managed.start()

        assertNotNull(managed.getActiveModule(), "expected active module")
        assertTrue(globalCtx.hasModule("home"), "expected 'home' in context")
    }

    @Test
    fun `managed router unmounts on stop`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        app.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Home")
        ).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/", component = "Home"))
        managed.start()
        managed.stop()

        assertNull(managed.getActiveModule(), "expected no active module")
        assertFalse(globalCtx.hasModule("home"), "expected 'home' removed")
    }

    @Test
    fun `managed router switches module on navigate`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        app.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Home")
        ).build()
        app.defineState(
            mapOf("name" to "Alice"),
            ModuleOptions(name = "Profile")
        ).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/", component = "Home"))
        managed.addRoute(RouteDefinition(path = "/profile", component = "Profile"))
        managed.start()

        assertTrue(globalCtx.hasModule("home"))

        // Navigate to profile
        router.push("/profile")

        // Persist-by-default: "home" stays registered in GlobalContext
        // after navigating away, so the instance (and its state) is
        // reused on return. Explicit `persist = false` in ModuleOptions
        // opts out. See commit 940321a9 and the `persist=false explicit`
        // test below for the opt-out case.
        assertTrue(globalCtx.hasModule("home"), "home should persist by default")
        assertTrue(globalCtx.hasModule("profile"), "profile should be mounted")
    }

    @Test
    fun `managed router with inline module definition`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        val inlineDef = AppBuilder.defineState(
            mapOf("x" to 1),
            ModuleOptions(name = "Inline")
        ).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/", component = "Inline", module = inlineDef))
        managed.start()

        assertTrue(globalCtx.hasModule("inline"), "expected inline module mounted")
    }

    // ========================================================================
    // E. Persist Flag Tests (6 tests)
    // ========================================================================

    @Test
    fun `persist=false explicit - module destroyed on unmount`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        // Explicit opt-out of the new persist-by-default behavior.
        app.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Home", persist = false)
        ).build()
        app.defineState(
            mapOf("name" to "Alice"),
            ModuleOptions(name = "Profile", persist = false)
        ).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/", component = "Home"))
        managed.addRoute(RouteDefinition(path = "/profile", component = "Profile"))
        managed.start()

        assertTrue(globalCtx.hasModule("home"))

        // Navigate away — Home destroyed (persist=false)
        router.push("/profile")

        assertFalse(globalCtx.hasModule("home"), "home should be destroyed")
        assertTrue(globalCtx.hasModule("profile"))
    }

    @Test
    fun `persist defaults to true for module-backed routes`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        // No persist specified — both modules should persist by default.
        app.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "Home")
        ).build()
        app.defineState(
            mapOf("name" to "Alice"),
            ModuleOptions(name = "Profile")
        ).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/", component = "Home"))
        managed.addRoute(RouteDefinition(path = "/profile", component = "Profile"))
        managed.start()

        assertTrue(globalCtx.hasModule("home"))

        router.push("/profile")

        // Home should persist across navigation by default.
        assertTrue(globalCtx.hasModule("home"), "home should persist by default")
        assertTrue(globalCtx.hasModule("profile"))
    }

    @Test
    fun `persist=true - module stays registered after unmount`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        app.defineState(
            mapOf("items" to listOf<Any>()),
            ModuleOptions(name = "Cart", persist = true)
        ).build()
        app.defineState(
            mapOf("step" to 1),
            ModuleOptions(name = "Checkout")
        ).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/cart", component = "Cart"))
        managed.addRoute(RouteDefinition(path = "/checkout", component = "Checkout"))

        router.push("/cart")
        managed.start()

        assertTrue(globalCtx.hasModule("cart"))

        // Navigate to checkout — Cart should persist
        router.push("/checkout")

        assertTrue(globalCtx.hasModule("cart"), "cart should persist")
        assertTrue(globalCtx.hasModule("checkout"))
    }

    @Test
    fun `persist=true - re-navigating reuses persisted instance`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        app.defineState(
            mapOf("items" to listOf<Any>()),
            ModuleOptions(name = "Cart", persist = true)
        ).build()
        app.defineState(
            mapOf("x" to 1),
            ModuleOptions(name = "Other")
        ).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/cart", component = "Cart"))
        managed.addRoute(RouteDefinition(path = "/other", component = "Other"))

        router.push("/cart")
        managed.start()

        // Routed modules mount through NestedModuleInstance → engine.registerModule,
        // not SetModule — the primary slot stays pinned to the session's own
        // primary (in tests, nothing) and each route registers in the named-modules
        // map. Counting registerModule calls is the correct regression probe for
        // "mounted a fresh instance".
        val callCountAfterMount = engine.registerModuleCallCount

        // Navigate away and back
        router.push("/other")
        router.push("/cart")

        // Should NOT create a new instance — reuses persisted
        assertEquals(callCountAfterMount + 1, engine.registerModuleCallCount)
        assertNotNull(managed.getActiveModule())
    }

    @Test
    fun `stop destroys all persisted modules`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        app.defineState(
            mapOf("items" to listOf<Any>()),
            ModuleOptions(name = "Cart", persist = true)
        ).build()
        app.defineState(
            mapOf("x" to 1),
            ModuleOptions(name = "Other")
        ).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/cart", component = "Cart"))
        managed.addRoute(RouteDefinition(path = "/other", component = "Other"))

        router.push("/cart")
        managed.start()

        // Navigate away (Cart persisted)
        router.push("/other")
        assertTrue(globalCtx.hasModule("cart"), "cart should persist")

        // Full stop
        managed.stop()

        assertFalse(globalCtx.hasModule("cart"), "cart should be destroyed after stop")
        assertFalse(globalCtx.hasModule("other"), "other should be destroyed after stop")
    }

    @Test
    fun `persist flag set via options`() {
        val def = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "PersistModule", persist = true)
        ).build()
        assertEquals(true, def.persist)
    }

    @Test
    fun `persist field defaults to null on the definition`() {
        // The raw field is null when unset — ManagedRouter interprets
        // null as "persist by default" for module-backed routes.
        val def = AppBuilder.defineState(mapOf("count" to 0)).build()
        assertNull(def.persist)
    }

    @Test
    fun `onActivated fires on every mount and onDeactivated on every unmount`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        val events = mutableListOf<String>()

        app.defineState(
            mapOf("visits" to 0),
            ModuleOptions(name = "Screen")
        ).onCreated { _, _ -> events.add("created") }
          .onActivated { state, _ ->
              events.add("activated")
              val visits = (state.get("visits") as? Int) ?: 0
              state.set("visits", visits + 1)
          }
          .onDeactivated { _, _ -> events.add("deactivated") }
          .onDestroyed { _, _ -> events.add("destroyed") }
          .build()

        app.defineState(mapOf<String, Any?>(), ModuleOptions(name = "Other")).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/screen", component = "Screen"))
        managed.addRoute(RouteDefinition(path = "/other", component = "Other"))

        router.push("/screen")
        managed.start()

        // First mount: created → activated.
        assertEquals(listOf("created", "activated"), events)

        // Away: deactivated (persist, not destroyed).
        router.push("/other")
        assertEquals(listOf("created", "activated", "deactivated"), events)

        // Back: activated again, no re-created.
        router.push("/screen")
        assertEquals(listOf("created", "activated", "deactivated", "activated"), events)

        val screenState = managed.getActiveModule()?.getState()
        assertEquals(2, screenState?.get("visits"))

        // Full stop: deactivated + destroyed for currently-active module.
        managed.stop()
        assertEquals(
            listOf("created", "activated", "deactivated", "activated", "deactivated", "destroyed"),
            events
        )
    }

    @Test
    fun `module state survives navigation away and back - no loading flash`() {
        val engine = MockEngine()
        val router = HypenRouter()
        val globalCtx = HypenGlobalContext()

        var createdCount = 0
        app.defineState(
            mapOf("loading" to true, "items" to listOf<String>()),
            ModuleOptions(name = "Items")
        ).onCreated { state, _ ->
            createdCount += 1
            // Simulate immediate data load.
            state.set("items", listOf("a", "b", "c"))
            state.set("loading", false)
        }.build()

        app.defineState(mapOf<String, Any?>(), ModuleOptions(name = "Other")).build()

        val managed = ManagedRouter(router, engine, app, globalCtx)
        managed.addRoute(RouteDefinition(path = "/items", component = "Items"))
        managed.addRoute(RouteDefinition(path = "/other", component = "Other"))

        router.push("/items")
        managed.start()

        assertEquals(1, createdCount)
        val first = managed.getActiveModule()?.getState()
        assertEquals(false, first?.get("loading"))
        assertEquals(listOf("a", "b", "c"), first?.get("items"))

        router.push("/other")
        router.push("/items")

        // onCreated must NOT have re-run — the module was persisted.
        assertEquals(1, createdCount)
        val second = managed.getActiveModule()?.getState()
        assertEquals(false, second?.get("loading"))
        assertEquals(listOf("a", "b", "c"), second?.get("items"))
    }

    // ========================================================================
    // F. Integration: Two modules with separate namespaced state
    // ========================================================================

    @Test
    fun `two modules register with separate namespaced state`() {
        val engine = MockEngine()
        val globalCtx = HypenGlobalContext()

        val homeDef = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "home")
        ).build()
        val profileDef = AppBuilder.defineState(
            mapOf("name" to "Alice"),
            ModuleOptions(name = "profile")
        ).build()

        val homeInst = ModuleInstance(engine, homeDef, globalContext = globalCtx)
        globalCtx.registerModule("home", homeInst)

        val profileInst = ModuleInstance(engine, profileDef, globalContext = globalCtx)
        globalCtx.registerModule("profile", profileInst)

        assertEquals(2, globalCtx.getModuleIds().size)
        assertTrue(globalCtx.hasModule("home"))
        assertTrue(globalCtx.hasModule("profile"))

        val globalState = globalCtx.getGlobalState()
        assertTrue(globalState.containsKey("home"))
        assertTrue(globalState.containsKey("profile"))
    }
}
