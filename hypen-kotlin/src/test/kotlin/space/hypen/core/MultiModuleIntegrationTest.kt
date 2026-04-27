package space.hypen.core

import kotlinx.serialization.Serializable
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Integration tests for multi-module support across the typed builder,
 * HypenApp registry, and nested module instantiation.
 */

@Serializable
data class SearchModuleState(var query: String = "", var results: List<String> = emptyList())

@Serializable
data class FeedModuleState(var posts: List<String> = emptyList(), var loading: Boolean = false)

@Serializable
data class ProfileModuleState(var username: String = "", var bio: String = "")

class MultiModuleIntegrationTest {

    @BeforeEach
    fun resetRegistry() {
        HypenApp.clear()
    }

    // ========================================================================
    // A. Typed hypen(State) auto-registers, appears in HypenApp.getNames()
    // ========================================================================

    @Test
    fun `typed named modules appear in HypenApp getNames`() {
        hypen(SearchModuleState()) {
            name("Search")
            onAction("search") { ctx ->
                ctx.state.set("query", "test")
            }
        }

        hypen(FeedModuleState()) {
            name("Feed")
            onAction("loadFeed") { ctx ->
                ctx.state.set("loading", true)
            }
        }

        val names = HypenApp.getNames()
        assertTrue(names.contains("Search"), "Search should be in HypenApp")
        assertTrue(names.contains("Feed"), "Feed should be in HypenApp")
        assertEquals(2, names.size, "Only 2 modules should be registered")
    }

    @Test
    fun `typed module definition has correct initial state`() {
        hypen(SearchModuleState(query = "hello", results = listOf("a", "b"))) {
            name("Search")
        }

        val def = HypenApp.get("Search")
        assertNotNull(def, "Search module should be in registry")

        // initialState is MutableMap<String, Any?> from the typed DSL serialization
        @Suppress("UNCHECKED_CAST")
        val state = def.initialState as Map<String, Any?>
        assertEquals("hello", state["query"])
        assertEquals(listOf("a", "b"), state["results"])
    }

    // ========================================================================
    // B. Typed modules + createNestedModuleInstances + registerModule tracking
    // ========================================================================

    @Test
    fun `typed modules feed into createNestedModuleInstances`() {
        val engine = MockEngine()
        val globalCtx = HypenGlobalContext()

        // Primary module (instantiated directly, not nested)
        val primaryDef = AppBuilder.defineState(
            mapOf("page" to "home"),
            ModuleOptions(name = "App")
        ).build()
        val primaryInstance = ModuleInstance(engine, primaryDef, globalContext = globalCtx)
        globalCtx.registerModule("app", primaryInstance)

        // Nested modules via typed DSL
        hypen(SearchModuleState()) {
            name("Search")
            onAction("search") { ctx ->
                ctx.state.set("results", listOf("match"))
            }
        }

        hypen(FeedModuleState()) {
            name("Feed")
            onAction("refresh") { ctx ->
                ctx.state.set("loading", true)
            }
        }

        val nested = createNestedModuleInstances(engine, HypenApp, globalCtx)

        assertEquals(2, nested.size, "Two nested modules should be created")
        assertTrue(nested.containsKey("Search"))
        assertTrue(nested.containsKey("Feed"))

        // Verify registerModule was called for each
        assertEquals(2, engine.registerModuleCallCount,
            "registerModule should be called for each nested module")
        val registered = engine.getRegisteredModules()
        assertTrue(registered.containsKey("search"))
        assertTrue(registered.containsKey("feed"))

        // setModule should only be called once (for the primary module)
        assertEquals(1, engine.setModuleCallCount,
            "setModule should only be called for the primary module")
    }

    @Test
    fun `typed nested modules are accessible via GlobalContext`() {
        val engine = MockEngine()
        val globalCtx = HypenGlobalContext()

        // Primary
        val primaryDef = AppBuilder.defineState(
            mapOf("page" to "home"),
            ModuleOptions(name = "App")
        ).build()
        val primaryInstance = ModuleInstance(engine, primaryDef, globalContext = globalCtx)
        globalCtx.registerModule("app", primaryInstance)

        // Nested via typed builder
        hypen(SearchModuleState(query = "init")) {
            name("Search")
        }

        createNestedModuleInstances(engine, HypenApp, globalCtx)

        assertTrue(globalCtx.hasModule("app"), "Primary should be in global context")
        assertTrue(globalCtx.hasModule("search"), "Search should be in global context")

        // Nested modules are stored in a separate map; verify via global state
        val globalState = globalCtx.getGlobalState()
        // The nested module should appear in global state under its prefixed key
        assertTrue(globalCtx.hasModule("search"), "Search should be accessible via hasModule")
        assertTrue(globalCtx.hasNestedModule("search"), "Search should be a nested module")
    }

    // ========================================================================
    // C. Auto-discovery pattern (mirrors HypenServer.mountRouteForClient)
    // ========================================================================

    @Test
    fun `auto-discovery skips the primary module`() {
        val primaryModuleName = "App"

        // Register primary via untyped API
        HypenApp.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = primaryModuleName)
        ).build()

        // Register nested modules
        hypen(SearchModuleState()) {
            name("Search")
        }

        hypen(FeedModuleState()) {
            name("Feed")
        }

        // Simulate the server auto-discovery loop:
        // For each name in HypenApp, skip the primary, registerModule for the rest
        val autoDiscovered = mutableListOf<String>()
        for (regName in HypenApp.getNames()) {
            if (regName == primaryModuleName) continue
            if (HypenApp.has(regName)) {
                // In real code: engine.registerModule(name, ...)
                autoDiscovered.add(regName)
            }
        }

        assertTrue(autoDiscovered.contains("Search"), "Search should be auto-discovered")
        assertTrue(autoDiscovered.contains("Feed"), "Feed should be auto-discovered")
        assertFalse(autoDiscovered.contains(primaryModuleName), "Primary should NOT be auto-discovered")
    }

    // ========================================================================
    // D. End-to-end: typed builder + nested instance + action dispatch
    // ========================================================================

    @Test
    fun `end-to-end typed multi-module with actions`() {
        val engine = MockEngine()
        val globalCtx = HypenGlobalContext()

        // Primary module via untyped API (compatible with ModuleInstance constructor)
        val primaryDef = AppBuilder.defineState(
            mapOf("count" to 0),
            ModuleOptions(name = "App")
        ).onAction("increment") { ctx ->
            val count = ctx.state.get("count") as? Int ?: 0
            ctx.state.set("count", count + 1)
        }.build()
        val primaryInstance = ModuleInstance(engine, primaryDef, globalContext = globalCtx)
        globalCtx.registerModule("app", primaryInstance)

        // Nested module via typed DSL
        hypen(SearchModuleState()) {
            name("Search")
            onAction("search") { ctx ->
                ctx.state.set("query", "typed-search")
                ctx.state.set("results", listOf("hit1", "hit2"))
            }
        }

        val nested = createNestedModuleInstances(engine, HypenApp, globalCtx)

        // Dispatch primary action
        engine.clearStateChanges()
        engine.dispatchAction("increment")

        val primaryChanges = engine.getStateChanges()
        assertTrue(primaryChanges.isNotEmpty(), "Primary module should produce state changes")

        // Dispatch nested module action
        val searchInstance = nested["Search"]
        assertNotNull(searchInstance, "Search should be in nested instances")

        engine.clearStateChanges()
        engine.triggerAction("search")

        val searchState = searchInstance.getState()
        assertEquals("typed-search", searchState["query"])

        // Both modules remain in global context
        assertTrue(globalCtx.hasModule("app"))
        assertTrue(globalCtx.hasModule("search"))
    }

    @Test
    fun `nested module cross-module state access via GlobalContext`() {
        val engine = MockEngine()
        val globalCtx = HypenGlobalContext()

        // Primary via untyped API
        val primaryDef = AppBuilder.defineState(
            mapOf("count" to 42),
            ModuleOptions(name = "App")
        ).build()
        val primaryInstance = ModuleInstance(engine, primaryDef, globalContext = globalCtx)
        globalCtx.registerModule("app", primaryInstance)

        // Nested module that reads primary state via context
        var readFromPrimary: Int? = null
        hypen(SearchModuleState()) {
            name("Search")
            onAction("readPrimary") { ctx ->
                val appRef = globalCtx.getModule<MutableMap<String, Any?>>("app")
                val appState = appRef?.getState()
                readFromPrimary = appState?.get("count") as? Int
            }
        }

        createNestedModuleInstances(engine, HypenApp, globalCtx)

        engine.triggerAction("readPrimary")

        assertEquals(42, readFromPrimary,
            "Nested module should be able to read primary module state via GlobalContext")
    }
}
