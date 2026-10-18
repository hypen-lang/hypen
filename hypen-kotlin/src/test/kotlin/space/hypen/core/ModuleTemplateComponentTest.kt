package space.hypen.core

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertTrue

/**
 * Server-based apps (no `watchComponents`): a module that carries its own
 * template via `.ui(...)` must render as a component wherever the primary
 * template names it — e.g. `Home()` inside `Router { Route(path: "/") }`.
 *
 * Regression guard for the `hypen init` Kotlin server-based scaffold, whose
 * Home screen rendered as an empty unknown `Home` element (blank page).
 */
class ModuleTemplateComponentTest {

    @BeforeEach
    fun reset() = HypenApp.clear()

    @AfterEach
    fun cleanup() = HypenApp.clear()

    @Test
    fun `module templates render as components in the primary Router`() = runBlocking {
        val engineAvailable = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(engineAvailable, "Native Hypen engine library not available")

        app.module("App")
            .defineState(mapOf("location" to "/"))
            .ui(
                """module App {
                    Router {
                        Route(path: "/") { Home() }
                        Route(path: "/counter") { Counter() }
                    }
                }""".trimIndent()
            )
            .build()
        app.module("Home")
            .defineState(mapOf("greeting" to "home-body"))
            .ui("""module Home { Column { Text("@{state.greeting}") } }""")
            .build()
        app.module("Counter")
            .defineState(mapOf("count" to 0))
            .ui("""module Counter { Text("counter-body") }""")
            .build()

        val server = HypenServer {
            module("App", HypenApp.get("App")!!)
            module("Home", HypenApp.get("Home")!!)
            module("Counter", HypenApp.get("Counter")!!)
            route("/", "App")
        }

        try {
            val sent = mutableListOf<String>()
            val key = Any()
            val send: suspend (String) -> Unit = { msg -> synchronized(sent) { sent.add(msg) } }

            val initialTree = server.handleConnect(connectionKey = key, sendMessage = send)
            assertTrue(
                initialTree.contains("home-body"),
                "initialTree should render Home's template, got: $initialTree"
            )

            server.handleMessage(
                key,
                """{"type":"dispatchAction","action":"router.push","payload":{"to":"/counter"}}""",
                send
            )
            val all = synchronized(sent) { sent.joinToString("\n") }
            assertTrue(all.contains("counter-body"), "navigating should render Counter's template, got: $all")

            server.handleDisconnect(key)
        } finally {
            server.shutdown()
        }
    }
}
