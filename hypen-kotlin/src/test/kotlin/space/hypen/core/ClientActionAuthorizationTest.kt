package space.hypen.core

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.util.Collections
import kotlin.test.assertEquals

/**
 * A Remote UI client is untrusted: it runs an action only while a control
 * bound to it is rendered for its session. Knowing a handler's name — bare,
 * or in the engine's internal `__hypen_scoped:` form — is not authority.
 */
class ClientActionAuthorizationTest {
    private fun definition(calls: MutableList<String>) =
        AppBuilder(mutableMapOf<String, Any?>("show" to false, "name" to ""))
            .ui(
                """module Admin {
                    Column {
                        Input(placeholder: "Name").bind(@state.name)
                        Button("@actions.save")
                        If(@state.show) { Button("@actions.wipe") }
                    }
                }""".trimIndent(),
            )
            .onAction("save") { calls += "save" }
            .onAction("wipe") { calls += "wipe" }
            .onAction("navigateBack") { calls += "navigateBack" }
            .build()
            .copy(name = "Admin")

    private fun session(server: HypenServer, block: suspend (suspend (String) -> Unit) -> Unit) = runBlocking {
        val key = Any()
        val sent = Collections.synchronizedList(mutableListOf<String>())
        try {
            sent += server.handleConnect(key) { sent += it }
            block { text -> server.handleMessage(key, text) { sent += it } }
        } finally {
            server.handleDisconnect(key)
            server.shutdown()
        }
    }

    private fun dispatch(action: String, payload: String? = null) =
        """{"type":"dispatchAction","action":"$action"${payload?.let { ""","payload":$it""" } ?: ""}}"""

    private fun nativeAvailable() = try {
        NativeEngine.isAvailable()
    } catch (_: Throwable) {
        false
    }

    @Test
    fun `an action with no rendered binding is refused in every spelling`() {
        assumeTrue(nativeAvailable())
        val calls = Collections.synchronizedList(mutableListOf<String>())
        val def = definition(calls)
        session(HypenServer { module("Admin", def); route("/", "Admin"); disableAutoRouter() }) { send ->
            send(dispatch("save")) // rendered: a bare name resolves to it
            for (name in listOf("wipe", "__hypen_scoped::wipe", "__hypen_scoped:admin:wipe", "__hypen_scoped::save", "navigateBack")) {
                send(dispatch(name))
            }
            send(dispatch("__hypen_dispatch", """{"action":"wipe"}"""))
            // The state writer is not reachable by name either.
            val write = """{"path":"show","value":true}"""
            send(dispatch("__hypen_bind", write))
            send(dispatch("__hypen_scoped::__hypen_bind", write))
            send(dispatch("__hypen_scoped:admin:__hypen_bind", write))
            send(dispatch("wipe"))
        }
        assertEquals(listOf("save"), calls.toList())
    }

    @Test
    fun `allowClientActions names what a client may call without a binding`() {
        assumeTrue(nativeAvailable())
        val calls = Collections.synchronizedList(mutableListOf<String>())
        val def = definition(calls)
        val server = HypenServer {
            module("Admin", def)
            route("/", "Admin")
            disableAutoRouter()
            allowClientActions("navigateBack", "__hypen_bind")
        }
        session(server) { send ->
            send(dispatch("navigateBack"))
            send(dispatch("wipe"))
            send(dispatch("__hypen_bind", """{"path":"show","value":true}"""))
            send(dispatch("wipe"))
        }
        assertEquals(listOf("navigateBack"), calls.toList())
    }
}
