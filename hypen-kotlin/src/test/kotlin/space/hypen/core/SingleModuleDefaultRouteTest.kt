package space.hypen.core

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A server with modules but no `route(...)` table serves its first module at
 * "/". Regression guard for the docs quick start (servers/kotlin.mdx), which
 * registers one module and no routes and used to get an empty initial tree
 * (`"module":""`, no patches) with no module mounted.
 */
class SingleModuleDefaultRouteTest {

    @BeforeEach
    fun reset() = HypenApp.clear()

    @AfterEach
    fun cleanup() = HypenApp.clear()

    @Test
    fun `first module is served at root when no routes are declared`() = runBlocking {
        val engineAvailable = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(engineAvailable, "Native Hypen engine library not available")

        val counter = app.module("Counter")
            .defineState(mapOf("count" to 0))
            .onAction("increment") { ctx -> ctx.state.set("count", ((ctx.state.get("count") as? Number)?.toInt() ?: 0) + 1) }
            .ui("""module Counter { Column { Text("Count: @{state.count}") } }""")
            .build()

        val server = HypenServer { module("Counter", counter) }
        assertEquals(listOf("/"), server.getRoutes().map { it.path })

        try {
            val sent = mutableListOf<String>()
            val key = Any()
            val send: suspend (String) -> Unit = { msg -> synchronized(sent) { sent.add(msg) } }

            val initialTree = server.handleConnect(connectionKey = key, sendMessage = send)
            assertTrue(initialTree.contains("Count: 0"), "initialTree should render Counter, got: $initialTree")
            assertTrue(initialTree.contains("\"module\":\"Counter\""), "initialTree should name the module, got: $initialTree")

            server.handleMessage(key, """{"type":"dispatchAction","module":"Counter","action":"increment"}""", send)
            val all = synchronized(sent) { sent.joinToString("\n") }
            assertTrue(all.contains("Count: 1"), "increment should re-render, got: $all")

            server.handleDisconnect(key)
        } finally {
            server.shutdown()
        }
    }
}
