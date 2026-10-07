package space.hypen.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The external capability surface, end to end against the native engine.
 *
 * These tests are the SDK-side proof of the engine's rule: **nothing is
 * externally reachable that a developer did not declare.** Each one pins a
 * half of it — what a declaration buys you, and what the absence of one
 * denies. See `hypen-engine-rs/src/agent.rs` and ExternalSurface.kt.
 */
class ExternalSurfaceTest {

    @BeforeEach
    fun resetRegistry() {
        app.clear()
    }

    /**
     * A native engine with the standard primitives, or a skipped test when
     * the native library isn't on the JNA path — same guard the other
     * native-backed suites use.
     */
    private fun nativeEngine(): NativeEngine {
        val available = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(available, "Native Hypen engine library not available")
        return NativeEngine().also { it.registerDefaultPrimitives() }
    }

    // ── Built-in names ─────────────────────────────────────────────────

    @Test
    fun `ExternalActions constants match the engine's built-in names`() {
        nativeEngine().use { engine ->
            val names = engine.externalBuiltinNames()
            assertEquals(ExternalActions.NAVIGATE, names["navigate"], "got $names")
            assertEquals(ExternalActions.BACK, names["back"], "got $names")
            assertEquals(ExternalActions.SET_INPUT, names["setInput"], "got $names")
            assertEquals(ExternalActions.BIND_ACTION, names["bindAction"], "got $names")
        }
    }

    // ── Actions ────────────────────────────────────────────────────────

    @Test
    fun `a declared module action is listed and dispatches through dispatchExternal`() {
        nativeEngine().use { engine ->
            engine.setModule("counter", listOf("increment"), listOf("count"), mapOf("count" to 0))
            val fired = mutableListOf<Action>()
            engine.onAction("increment") { fired.add(it) }

            val listed = engine.listActions()
            assertTrue(
                listed.any { it.name == "increment" && !it.builtin },
                "declared action must be externally dispatchable; got $listed"
            )
            // No Router and no .bind() were declared, so no built-in is on
            // offer — listing and dispatch have to agree.
            assertTrue(listed.none { it.builtin }, "no declaration backs any built-in; got $listed")

            engine.dispatchExternal("increment", buildJsonObject { put("by", 2) })

            assertEquals(1, fired.size, "handler should have run exactly once")
            assertEquals("increment", fired.single().name)
        }
    }

    @Test
    fun `an undeclared action name is refused`() {
        nativeEngine().use { engine ->
            engine.setModule("counter", listOf("increment"), listOf("count"), mapOf("count" to 0))

            assertFailsWith<EngineError.ActionNotFound> {
                engine.dispatchExternal("decrement")
            }
        }
    }

    @Test
    fun `framework internals stay unreachable by name even when handlers exist`() {
        nativeEngine().use { engine ->
            engine.setModule("form", emptyList(), listOf("name"), mapOf("name" to ""))
            engine.renderSource("""Input(placeholder: "Name").bind(@state.name)""")

            // Registering a handler is what the renderer needs; it must not
            // be what grants an external caller reach. All three of these
            // are live handlers for the duration of this test.
            var bindCalls = 0
            var replaceCalls = 0
            var forwardCalls = 0
            engine.onAction("__hypen_bind") { bindCalls++ }
            engine.onAction("router.replace") { replaceCalls++ }
            engine.onAction("router.forward") { forwardCalls++ }

            // `__hypen_bind` takes a caller-supplied path straight into
            // state — the exact primitive `set_input` exists to fence off.
            assertFailsWith<EngineError.ActionNotFound> {
                engine.dispatchExternal(
                    "__hypen_bind",
                    buildJsonObject { put("path", "name"); put("value", "pwned") }
                )
            }
            // `router.replace` / `router.forward` have no external alias:
            // `navigate` and `back` are the whole declared navigation
            // surface, so these are simply not on the allowlist.
            assertFailsWith<EngineError.ActionNotFound> {
                engine.dispatchExternal("router.replace", buildJsonObject { put("to", "/admin") })
            }
            assertFailsWith<EngineError.ActionNotFound> {
                engine.dispatchExternal("router.forward")
            }

            assertEquals(0, bindCalls, "__hypen_bind must not have run")
            assertEquals(0, replaceCalls, "router.replace must not have run")
            assertEquals(0, forwardCalls, "router.forward must not have run")
        }
    }

    // ── Inputs ─────────────────────────────────────────────────────────

    @Test
    fun `set_input accepts a declared bind field and refuses an undeclared one`() {
        nativeEngine().use { engine ->
            engine.setModule("form", emptyList(), listOf("name", "secret"), mapOf("name" to "", "secret" to ""))
            engine.renderSource("""Input(placeholder: "Name").bind(@state.name)""")

            val bindings = engine.listBindings()
            assertEquals(listOf("name"), bindings.map { it.path }, "got $bindings")
            assertEquals("value", bindings.single().prop)
            assertEquals("Input", bindings.single().elementType)
            assertTrue(engine.listActions().any { it.name == ExternalActions.SET_INPUT && it.builtin })

            var bound: Action? = null
            engine.onAction("__hypen_bind") { bound = it }

            engine.dispatchExternal(
                ExternalActions.SET_INPUT,
                buildJsonObject { put("field", "name"); put("value", "Ada") }
            )

            // The handler sees a payload the engine rebuilt from the
            // validated field — never the object the caller handed in.
            val payload = assertNotNull(bound, "set_input should reach __hypen_bind").payload as? JsonObject
            assertEquals("name", payload?.get("path")?.jsonPrimitive?.content)
            assertEquals("Ada", payload?.get("value")?.jsonPrimitive?.content)

            // `secret` is module state, but no `.bind()` points at it — so
            // the write primitive cannot be aimed there.
            assertFailsWith<EngineError.ActionNotFound> {
                engine.dispatchExternal(
                    ExternalActions.SET_INPUT,
                    buildJsonObject { put("field", "secret"); put("value", "x") }
                )
            }
        }
    }

    @Test
    fun `a bind inside a Route carries the route pattern and its static label`() {
        nativeEngine().use { engine ->
            engine.setModule("form", emptyList(), listOf("name"), mapOf("name" to ""))
            engine.renderSource(
                """
                Router {
                    Route(path: "/profile") {
                        Input(placeholder: "Your name").bind(@state.name)
                    }
                }
                """.trimIndent()
            )

            val binding = engine.listBindings().single()
            assertEquals("name", binding.path)
            // Which screen the field is on — the same field name under two
            // routes is two different form fields to an external caller.
            assertEquals("/profile", binding.route, "got $binding")
            // A static placeholder is the field's human label.
            assertEquals("Your name", binding.label, "got $binding")
        }
    }

    @Test
    fun `a bind outside any Route reports no route`() {
        nativeEngine().use { engine ->
            engine.setModule("form", emptyList(), listOf("query"), mapOf("query" to ""))
            engine.renderSource("""Input(placeholder: "Search").bind(@state.query)""")

            val binding = engine.listBindings().single()
            assertEquals(null, binding.route, "got $binding")
            assertEquals("Search", binding.label, "got $binding")
        }
    }

    @Test
    fun `an interpolated placeholder is never surfaced as a label`() {
        nativeEngine().use { engine ->
            engine.setModule(
                "form", emptyList(), listOf("name", "hint"),
                mapOf("name" to "", "hint" to "user@example.com")
            )
            // The label is a description of the form, not a window onto
            // state: the engine reads a *static* placeholder/label only, so
            // a template string here yields no label rather than its
            // rendered value.
            engine.renderSource("""Input(placeholder: "@{state.hint}").bind(@state.name)""")

            val binding = engine.listBindings().single()
            assertEquals("name", binding.path, "the field still lists; got $binding")
            assertEquals(null, binding.label, "interpolated labels must not surface; got $binding")
        }
    }

    // ── Navigation ─────────────────────────────────────────────────────

    @Test
    fun `navigate works when a Router is declared`() {
        nativeEngine().use { engine ->
            var pushedTo: String? = null
            engine.onAction("router.push") { action ->
                pushedTo = (action.payload as? JsonObject)?.get("to")?.jsonPrimitive?.content
            }
            engine.renderSource(
                """
                Router {
                    Route(path: "/") { Text("home") }
                    Route(path: "/settings/:tab") { Text("settings") }
                }
                """.trimIndent()
            )

            val routes = engine.listRoutes()
            assertEquals(listOf("/", "/settings/:tab"), routes.map { it.path }, "got $routes")
            assertEquals(listOf("tab"), routes.last().params)
            assertTrue(engine.listActions().any { it.name == ExternalActions.NAVIGATE && it.builtin })

            engine.dispatchExternal(ExternalActions.NAVIGATE, buildJsonObject { put("to", "/settings/general") })

            // Arrives at the handler as `router.push` — the internal name,
            // not the external alias.
            assertEquals("/settings/general", pushedTo)
        }
    }

    @Test
    fun `navigate is refused when no Router is declared`() {
        nativeEngine().use { engine ->
            var pushCalls = 0
            engine.onAction("router.push") { pushCalls++ }
            engine.renderSource("""Column { Text("no router here") }""")

            assertTrue(engine.listRoutes().isEmpty())
            assertFalse(
                engine.listActions().any { it.name == ExternalActions.NAVIGATE || it.name == ExternalActions.BACK },
                "built-ins must not be offered without the backing declaration"
            )
            assertFailsWith<EngineError.ActionNotFound> {
                engine.dispatchExternal(ExternalActions.NAVIGATE, buildJsonObject { put("to", "/settings") })
            }
            assertEquals(0, pushCalls)
        }
    }

    // ── Module teardown ────────────────────────────────────────────────

    /**
     * The destroy-only rule, from the outside.
     *
     * `ManagedRouter` unregisters a module from the engine when it actually
     * destroys the instance — never on an ordinary unmount. A persisted
     * module is off-screen but deliberately still registered, so siblings
     * can keep reading its state and its cached instance still has a home
     * in the engine when we navigate back. If `unregisterModule` ever
     * migrates to `unmountActive`'s persist branch, the first assertion
     * here fails.
     */
    @Test
    fun `destroyed modules lose their actions while persisted modules keep theirs`() {
        nativeEngine().use { engine ->
            app.module("Home")
                .defineState(mapOf("n" to 0))
                .onAction("goHome") { }
                .build()
            // Explicit opt-out: Search is torn down on every nav away.
            app.module("Search")
                .defineState(mapOf("q" to ""), ModuleOptions(persist = false))
                .onAction("query") { }
                .build()

            val router = HypenRouter()
            val globalCtx = HypenGlobalContext()
            val managed = ManagedRouter(router, engine, app, globalCtx)
            managed.addRoute(RouteDefinition(path = "/", component = "Home"))
            managed.addRoute(RouteDefinition(path = "/search", component = "Search"))
            managed.start()

            assertTrue(engine.listActions().any { it.name == "goHome" }, "Home mounts on start")

            router.push("/search")
            val afterNav = engine.listActions().map { it.name }
            assertTrue(afterNav.contains("query"), "Search mounted; got $afterNav")
            assertTrue(
                afterNav.contains("goHome"),
                "Home is persisted, not destroyed — its actions must survive the unmount; got $afterNav"
            )

            router.push("/")
            val afterTeardown = engine.listActions().map { it.name }
            assertFalse(
                afterTeardown.contains("query"),
                "Search opted out of persistence, so its destroy must drop its actions; got $afterTeardown"
            )
            assertTrue(afterTeardown.contains("goHome"), "Home restored from cache; got $afterTeardown")

            // Full stop destroys the persist cache too — the other destroy site.
            managed.stop()
            assertFalse(
                engine.listActions().any { it.name == "goHome" },
                "stop() destroys persisted modules; got ${engine.listActions()}"
            )
        }
    }
}
