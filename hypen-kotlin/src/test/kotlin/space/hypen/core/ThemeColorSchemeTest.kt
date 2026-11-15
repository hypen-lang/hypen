package space.hypen.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.Collections
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The client-reported system color scheme on [HypenServer] (same wire
 * contract as the TypeScript server): `hello.colorScheme` seeds the session
 * theme before the first render, and a `{"type":"colorScheme","scheme":…}`
 * message updates it afterwards — for that session only, as ordinary
 * `patch` messages.
 */
class ThemeColorSchemeTest {
    private val tokens = mapOf(
        "color" to mapOf("ink" to "#111111"),
        "space" to mapOf("md" to 16),
    )
    private val dark = mapOf("color" to mapOf("ink" to "#eeeeee"))

    @BeforeEach
    fun resetRegistry() {
        HypenApp.clear()
    }

    @AfterEach
    fun cleanup() {
        HypenApp.clear()
    }

    private fun requireNative() {
        val available = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(available, "Native Hypen engine library not available")
    }

    /**
     * One themed label (`color.0` follows the scheme, `padding.0` does not)
     * and a tap counter, so a `bump` gives every test a frame to wait for —
     * and its revision shows how many frames went out before it.
     */
    private fun server(withTheme: Boolean = true): HypenServer {
        app.module("Themed")
            .defineState(mapOf("taps" to 0))
            .ui(
                """module Themed {
                    Column {
                        Text("Hi").color(@theme.color.ink).padding(@theme.space.md)
                        Text("Taps: @{state.taps}")
                        Button("@actions.bump") { Text("Bump") }
                    }
                }""".trimIndent()
            )
            .onAction("bump") { ctx -> ctx.state.set("taps", (ctx.state.get("taps") as? Int ?: 0) + 1) }
            .onAction("goLight") { ctx -> ctx.context?.theme?.setScheme("light") }
            .build()

        return HypenServer {
            module("Themed", HypenApp.get("Themed")!!)
            route("/", "Themed")
            if (withTheme) theme(createTheme(tokens = tokens, schemes = mapOf("dark" to dark)))
        }
    }

    /** One hello-driven connection ([HypenServer.openConnection]) recording what the server sends. */
    private class Conn(private val server: HypenServer) {
        private val key = Any()
        private val out: MutableList<String> = Collections.synchronizedList(mutableListOf())

        init {
            server.openConnection(key, object : HypenTransport {
                override suspend fun sendText(text: String) {
                    out += text
                }
                override suspend fun sendBinary(bytes: ByteArray) = Unit
                override suspend fun close(code: Int, reason: String) = Unit
            })
        }

        suspend fun send(text: String) =
            server.handleMessage(key, text) { error("a hello-driven connection writes through its queue") }

        fun frames(): List<JsonObject> = synchronized(out) { out.toList() }.map { Json.decodeFromString<JsonObject>(it) }

        fun patchFrames(): List<JsonObject> = frames().filter { it.type == "patch" }

        suspend fun await(what: String, p: (JsonObject) -> Boolean): JsonObject = try {
            withTimeout(10_000) {
                var found: JsonObject? = null
                while (found == null) {
                    found = frames().firstOrNull(p)
                    if (found == null) delay(5)
                }
                found
            }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out waiting for $what; got ${frames()}", e)
        }

        suspend fun hello(extra: String = ""): JsonObject {
            send("""{"type":"hello"$extra}""")
            return await("initialTree") { it.type == "initialTree" }
        }

        /** Dispatch `bump` and return the patch frame that carries the new count. */
        suspend fun bump(expectedTaps: Int): JsonObject {
            send("""{"type":"dispatchAction","action":"bump"}""")
            return await("Taps: $expectedTaps") { f -> f.type == "patch" && f.setProps().containsValue("Taps: $expectedTaps") }
        }

        suspend fun disconnect() = server.handleDisconnect(key)
    }

    private companion object {
        val JsonObject.type: String? get() = this["type"]?.jsonPrimitive?.content

        /** The ink color the initial tree created the label with. */
        fun JsonObject.inkAtCreate(): String? = this["patches"]!!.jsonArray.map { it.jsonObject }
            .first { it.type == PatchType.CREATE && it["props"]?.jsonObject?.containsKey("color.0") == true }["props"]!!
            .jsonObject["color.0"]?.jsonPrimitive?.content

        /** A patch frame as prop name → value; fails on anything but `setProp`. */
        fun JsonObject.setProps(): Map<String?, String?> = this["patches"]!!.jsonArray.map { it.jsonObject }.associate {
            check(it.type == PatchType.SET_PROP) { "expected only setProp patches, got $it" }
            it["name"]?.jsonPrimitive?.content to it["value"]?.jsonPrimitive?.content
        }

        val JsonObject.revision: Long? get() = this["revision"]?.jsonPrimitive?.long
    }

    @Test
    fun `hello colorScheme seeds the first frame`() = runBlocking<Unit> {
        requireNative()
        val server = server()
        try {
            val conn = Conn(server)
            val tree = conn.hello(""","colorScheme":"dark"""")
            assertEquals("#eeeeee", tree.inkAtCreate(), "the initial tree is already dark")

            // No light-then-dark flip: the first patch after the initial tree
            // is the bump, at revision 1, and carries nothing but the count.
            val bump = conn.bump(1)
            assertEquals(mapOf<String?, String?>("0" to "Taps: 1"), bump.setProps())
            assertEquals(1L, bump.revision)
            assertEquals(1, conn.patchFrames().size, "got ${conn.frames()}")
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a hello without a usable colorScheme keeps the theme's own system scheme`() = runBlocking<Unit> {
        requireNative()
        val server = server()
        try {
            assertEquals("#111111", Conn(server).hello().inkAtCreate())
            assertEquals("#111111", Conn(server).hello(""","colorScheme":"sepia"""").inkAtCreate())
            assertEquals("#111111", Conn(server).hello(""","colorScheme":true""").inkAtCreate())
            assertEquals("#111111", Conn(server).hello(""","colorScheme":{"scheme":"dark"}""").inkAtCreate())
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a colorScheme message re-renders only the changed prop, for this session only`() = runBlocking<Unit> {
        requireNative()
        val server = server()
        try {
            val alice = Conn(server)
            val bob = Conn(server)
            assertEquals("#111111", alice.hello().inkAtCreate())
            assertEquals("#111111", bob.hello().inkAtCreate())

            alice.send("""{"type":"colorScheme","scheme":"dark"}""")
            val patch = alice.await("the dark patch") { it.type == "patch" }
            assertEquals(mapOf<String?, String?>("color.0" to "#eeeeee"), patch.setProps(), "padding is not re-sent")
            assertEquals(1L, patch.revision)

            // Malformed reports, and one that repeats the current scheme, send nothing.
            alice.send("""{"type":"colorScheme","scheme":"sepia"}""")
            alice.send("""{"type":"colorScheme"}""")
            alice.send("""{"type":"colorScheme","scheme":1}""")
            alice.send("""{"type":"colorScheme","scheme":["dark"]}""")
            alice.send("""{"type":"colorScheme","scheme":"dark"}""")
            val bump = alice.bump(1)
            assertEquals(mapOf<String?, String?>("0" to "Taps: 1"), bump.setProps())
            assertEquals(2L, bump.revision, "nothing went out between the dark patch and the bump")
            assertEquals(2, alice.patchFrames().size, "got ${alice.frames()}")

            // Bob heard none of it: his first patch is his own bump.
            val bobBump = bob.bump(1)
            assertEquals(mapOf<String?, String?>("0" to "Taps: 1"), bobBump.setProps())
            assertEquals(1L, bobBump.revision)
            assertEquals(1, bob.patchFrames().size, "got ${bob.frames()}")

            // And a session that connects later starts from the theme's default.
            assertEquals("#111111", Conn(server).hello().inkAtCreate())
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `an explicit scheme set by a handler makes later colorScheme messages no-ops`() = runBlocking<Unit> {
        requireNative()
        val server = server()
        try {
            val conn = Conn(server)
            assertEquals("#eeeeee", conn.hello(""","colorScheme":"dark"""").inkAtCreate())

            conn.send("""{"type":"dispatchAction","action":"goLight"}""")
            val light = conn.await("the light patch") { it.type == "patch" }
            assertEquals(mapOf<String?, String?>("color.0" to "#111111"), light.setProps())

            conn.send("""{"type":"colorScheme","scheme":"light"}""")
            conn.send("""{"type":"colorScheme","scheme":"dark"}""")
            val bump = conn.bump(1)
            assertEquals(mapOf<String?, String?>("0" to "Taps: 1"), bump.setProps(), "the session stays light")
            assertEquals(2L, bump.revision, "the reports rendered nothing")
            assertEquals(2, conn.patchFrames().size, "got ${conn.frames()}")
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a colorScheme message before hello is ignored`() = runBlocking<Unit> {
        requireNative()
        val server = server()
        try {
            val conn = Conn(server)
            conn.send("""{"type":"colorScheme","scheme":"dark"}""")
            assertEquals("#111111", conn.hello().inkAtCreate())
            conn.bump(1)
            assertEquals(1, conn.patchFrames().size, "got ${conn.frames()}")
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `colorScheme is ignored by a server without a theme`() = runBlocking<Unit> {
        requireNative()
        val server = server(withTheme = false)
        try {
            val conn = Conn(server)
            conn.hello(""","colorScheme":"dark"""")
            conn.send("""{"type":"colorScheme","scheme":"light"}""")
            val bump = conn.bump(1)
            assertEquals(1L, bump.revision)
            assertEquals(1, conn.patchFrames().size, "got ${conn.frames()}")
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `parseColorScheme accepts exactly the two scheme strings`() {
        assertEquals(SystemColorScheme.LIGHT, HypenServer.parseColorScheme(JsonPrimitive("light")))
        assertEquals(SystemColorScheme.DARK, HypenServer.parseColorScheme(JsonPrimitive("dark")))
        assertNull(HypenServer.parseColorScheme(null))
        assertNull(HypenServer.parseColorScheme(JsonPrimitive("Dark")))
        assertNull(HypenServer.parseColorScheme(JsonPrimitive("system")))
        assertNull(HypenServer.parseColorScheme(JsonPrimitive(true)))
        assertNull(HypenServer.parseColorScheme(Json.parseToJsonElement("""{"scheme":"dark"}""")))
    }
}
