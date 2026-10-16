package space.hypen.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.util.Collections
import java.util.concurrent.CompletionStage
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * The remote `viewport` message (hypen-web/docs/virtualization.md §4):
 * accepted only after `hello`, malformed ones ignored without an error or
 * a disconnect, `start`/`end` clamped to u32, applied to THIS session's
 * engine only, and answered with an ordinary `patch` message carrying the
 * next revision — never an action, never a `stateUpdate`, never replayed
 * to another session.
 *
 * Every test body is `runBlocking<Unit>` / `withServer`: JUnit Jupiter
 * silently ignores a `@Test` method whose return type is not `void`.
 */
class HypenServerViewportTest {
    @BeforeEach
    fun reset() = HypenApp.clear()

    @AfterEach
    fun cleanup() = HypenApp.clear()

    private fun requireNative() {
        val available = try {
            NativeEngine.isAvailable()
        } catch (_: Throwable) {
            false
        }
        assumeTrue(available, "Native Hypen engine library not available")
    }

    // ── Parsing (no engine) ─────────────────────────────────────────────

    private fun parse(text: String) = HypenServer.parseViewportMessage(Json.decodeFromString<JsonObject>(text))

    @Test
    fun `a well-formed viewport parses`() {
        assertEquals(ViewportRequest("4294967301", 40u, 70u), parse("""{"type":"viewport","listId":"4294967301","start":40,"end":70}"""))
        assertEquals(ViewportRequest("7", 40u, 70u), parse("""{"type":"viewport","listId":"7","start":40.0,"end":7e1}"""), "integral numbers in any JSON spelling")
        assertEquals(ViewportRequest("7", 0u, 0u), parse("""{"type":"viewport","listId":"7","start":0,"end":0}"""))
    }

    @Test
    fun `start and end clamp to u32`() {
        assertEquals(
            ViewportRequest("7", UInt.MAX_VALUE, UInt.MAX_VALUE),
            parse("""{"type":"viewport","listId":"7","start":4294967296,"end":99999999999999999999999999}"""),
        )
        assertEquals(ViewportRequest("7", 4294967295u, 1u), parse("""{"type":"viewport","listId":"7","start":4294967295,"end":1}"""))
    }

    @Test
    fun `malformed viewports parse to null`() {
        val bad = listOf(
            """{"type":"viewport"}""",
            """{"type":"viewport","start":0,"end":10}""",
            """{"type":"viewport","listId":7,"start":0,"end":10}""",
            """{"type":"viewport","listId":null,"start":0,"end":10}""",
            """{"type":"viewport","listId":"7","end":10}""",
            """{"type":"viewport","listId":"7","start":0}""",
            """{"type":"viewport","listId":"7","start":-1,"end":10}""",
            """{"type":"viewport","listId":"7","start":0,"end":-10}""",
            """{"type":"viewport","listId":"7","start":1.5,"end":10}""",
            """{"type":"viewport","listId":"7","start":"0","end":10}""",
            """{"type":"viewport","listId":"7","start":null,"end":10}""",
            """{"type":"viewport","listId":"7","start":true,"end":10}""",
            """{"type":"viewport","listId":"7","start":[0],"end":10}""",
            """{"type":"viewport","listId":"7","start":{"n":0},"end":10}""",
        )
        for (text in bad) assertNull(parse(text), "should be malformed: $text")
    }

    // ── Server ─────────────────────────────────────────────────────────

    private val items = (0 until 100).map { mapOf("id" to "i$it", "name" to "Item $it") }

    private fun listServer(autoRouter: Boolean = false): HypenServer {
        val def = AppBuilder(mutableMapOf<String, Any?>("items" to items, "count" to 0))
            .ui(
                """module Feed {
                    Column {
                        Text("Count: @{state.count}")
                        List(@state.items, key: "id") { Text("@{item.name}") }
                    }
                }""".trimIndent(),
            )
            .onAction("increment") { ctx ->
                ctx.state.set("count", ((ctx.state.get("count") as? Number)?.toInt() ?: 0) + 1)
            }
            // A trap: were a viewport ever routed as an action, this would fire.
            .onAction("viewport") { ctx ->
                ctx.state.set("count", ((ctx.state.get("count") as? Number)?.toInt() ?: 0) + 1)
            }
            .build()
            .copy(name = "Feed")
        return HypenServer {
            module("Feed", def)
            route("/", "Feed")
            if (!autoRouter) disableAutoRouter()
        }
    }

    private fun withServer(s: HypenServer, block: suspend (HypenServer) -> Unit) = runBlocking<Unit> {
        try {
            block(s)
        } finally {
            s.shutdown()
        }
    }

    /** A hello-driven connection over an in-process transport. */
    private class Conn(val server: HypenServer) {
        val key = Any()
        val out: MutableList<String> = Collections.synchronizedList(mutableListOf())
        @Volatile var closed: Pair<Int, String>? = null

        init {
            server.openConnection(key, object : HypenTransport {
                override suspend fun sendText(text: String) {
                    out += text
                }
                override suspend fun sendBinary(bytes: ByteArray) = Unit
                override suspend fun close(code: Int, reason: String) {
                    closed = code to reason
                }
            })
        }

        suspend fun send(text: String) = server.handleMessage(key, text) { error("a hello-driven connection writes through its queue") }

        fun texts(): List<String> = synchronized(out) { out.toList() }

        fun ofType(type: String): List<JsonObject> =
            texts().map { Json.parseToJsonElement(it).jsonObject }.filter { it["type"]?.jsonPrimitive?.content == type }

        suspend fun await(timeoutMs: Long = 10_000, p: (List<String>) -> Boolean) = awaitTexts(timeoutMs, ::texts, p)
    }

    /** The window the client holds: `id` of the List and its latest `__virt.window`. */
    private data class Window(val listId: String, val total: Int, val start: Int, val end: Int)

    /** Replay every `__virt.window` set in [messages] (initialTree + patch, in order). */
    private fun windowOf(messages: List<JsonObject>): Window {
        var listId: String? = null
        var window: JsonObject? = null
        for (m in messages) {
            for (p in m["patches"]?.jsonArray ?: JsonArray(emptyList())) {
                val o = p.jsonObject
                val type = o["type"]?.jsonPrimitive?.content
                if (type == PatchType.CREATE && o["elementType"]?.jsonPrimitive?.content == "List") {
                    listId = o["id"]!!.jsonPrimitive.content
                    (o["props"] as? JsonObject)?.get("__virt.window")?.let { window = it.jsonObject }
                }
                if (type == PatchType.SET_PROP && o["name"]?.jsonPrimitive?.content == "__virt.window" && o["id"]?.jsonPrimitive?.content == listId) {
                    window = o["value"]!!.jsonObject
                }
            }
        }
        val w = assertNotNull(window, "no __virt.window in ${messages.size} messages")
        return Window(
            assertNotNull(listId),
            w["total"]!!.jsonPrimitive.int,
            w["start"]!!.jsonPrimitive.int,
            w["end"]!!.jsonPrimitive.int,
        )
    }

    private fun uiMessages(texts: List<String>) =
        texts.map { Json.parseToJsonElement(it).jsonObject }
            .filter { it["type"]?.jsonPrimitive?.content in setOf("initialTree", "patch") }

    @Test
    fun `a viewport moves this session's window and answers with one patch at the next revision`() = withServer(listServer()) { s ->
        requireNative()
        val c = Conn(s)
        c.send("""{"type":"hello"}""")
        c.await { t -> t.any { it.contains("\"initialTree\"") } }
        val before = windowOf(uiMessages(c.texts()))
        assertEquals(100, before.total)
        assertEquals(0, before.start)
        assertTrue(before.end in 1..99, "a List of 100 starts windowed: $before")
        assertTrue(
            c.ofType("initialTree").single()["patches"].toString().let { !it.contains("Item 50") && it.contains("Item 0") },
            "only the first window's rows are materialized",
        )

        c.send("""{"type":"viewport","listId":"${before.listId}","start":40,"end":70}""")
        c.await { t -> t.any { it.contains("\"patch\"") } }

        val patch = c.ofType("patch").single()
        assertEquals(1L, patch["revision"]!!.jsonPrimitive.long)
        assertEquals("Feed", patch["module"]!!.jsonPrimitive.content)
        val after = windowOf(uiMessages(c.texts()))
        assertEquals(Window(before.listId, 100, 40, 70), after)
        assertTrue(patch.toString().contains("Item 50"), "rows inside the new window are created")
        RemoteWireConformanceTest.ClientDecoder.assertDecodes(c.texts())
        assertTrue(c.ofType("stateUpdate").isEmpty(), "a viewport never sends a stateUpdate")

        // The revision sequence continues: the next action is revision 2.
        c.send("""{"type":"dispatchAction","action":"increment"}""")
        c.await { t -> t.any { it.contains("Count: 1") } }
        assertEquals(listOf(1L, 2L), c.ofType("patch").map { it["revision"]!!.jsonPrimitive.long })
        assertNull(c.closed)
    }

    @Test
    fun `a viewport reaches only the session that sent it and is never an action`() = withServer(listServer()) { s ->
        requireNative()
        val a = Conn(s)
        val b = Conn(s)
        a.send("""{"type":"hello"}""")
        b.send("""{"type":"hello"}""")
        a.await { t -> t.any { it.contains("\"initialTree\"") } }
        b.await { t -> t.any { it.contains("\"initialTree\"") } }
        val bBefore = b.texts()
        val listId = windowOf(uiMessages(a.texts())).listId

        a.send("""{"type":"viewport","listId":"$listId","start":60,"end":90}""")
        a.await { t -> t.any { it.contains("\"patch\"") } }
        delay(100)

        assertEquals(Window(listId, 100, 60, 90), windowOf(uiMessages(a.texts())))
        assertEquals(bBefore, b.texts(), "the other session receives nothing")
        val bWindow = windowOf(uiMessages(b.texts()))
        assertEquals(0, bWindow.start, "the other session's window is untouched")
        assertTrue(a.texts().none { it.contains("Count: 1") }, "a viewport never reaches an action handler named `viewport`")
    }

    @Test
    fun `a viewport before hello is ignored`() = withServer(listServer()) { s ->
        requireNative()
        val c = Conn(s)
        c.send("""{"type":"viewport","listId":"1","start":40,"end":70}""")
        assertTrue(c.texts().isEmpty(), "nothing is sent before hello")
        assertNull(c.closed, "and the socket stays open")
        c.send("""{"type":"hello"}""")
        c.await { t -> t.any { it.contains("\"initialTree\"") } }
        delay(50)
        assertTrue(c.ofType("patch").isEmpty(), "the early viewport is not replayed after hello")
        assertEquals(0, windowOf(uiMessages(c.texts())).start)
    }

    @Test
    fun `malformed and stale viewports send nothing and bump no revision`() = withServer(listServer()) { s ->
        requireNative()
        val c = Conn(s)
        c.send("""{"type":"hello"}""")
        c.await { t -> t.any { it.contains("\"initialTree\"") } }
        val listId = windowOf(uiMessages(c.texts())).listId
        val sent = c.texts().size
        val bad = listOf(
            """{"type":"viewport"}""",
            """{"type":"viewport","listId":"$listId"}""",
            """{"type":"viewport","listId":$listId,"start":40,"end":70}""",
            """{"type":"viewport","listId":"$listId","start":-1,"end":70}""",
            """{"type":"viewport","listId":"$listId","start":4.5,"end":70}""",
            """{"type":"viewport","listId":"$listId","start":"40","end":70}""",
            """{"type":"viewport","listId":"$listId","start":40,"end":null}""",
            // Well-formed but stale: no windowed list has this id.
            """{"type":"viewport","listId":"999999999","start":40,"end":70}""",
            """{"type":"viewport","listId":"not-an-id","start":40,"end":70}""",
        )
        for (text in bad) {
            try {
                c.send(text)
            } catch (e: Throwable) {
                fail("handleMessage threw ${e::class.simpleName} for $text: ${e.message}")
            }
        }
        delay(50)
        assertEquals(sent, c.texts().size, "nothing was sent: ${c.texts().drop(sent)}")
        assertNull(c.closed, "no malformed viewport closes the connection")

        // A u32-clamped huge range is well-formed: the window covers the tail.
        c.send("""{"type":"viewport","listId":"$listId","start":90,"end":99999999999}""")
        c.await { t -> t.any { it.contains("\"patch\"") } }
        assertEquals(Window(listId, 100, 90, 100), windowOf(uiMessages(c.texts())))
        assertEquals(listOf(1L), c.ofType("patch").map { it["revision"]!!.jsonPrimitive.long }, "the first real patch is revision 1")
    }

    @Test
    fun `the legacy handleConnect path handles viewports too`() = withServer(listServer()) { s ->
        requireNative()
        val key = Any()
        val sent = Collections.synchronizedList(mutableListOf<String>())
        s.handleMessage(key, """{"type":"viewport","listId":"1","start":40,"end":70}""") { sent += it }
        assertTrue(sent.isEmpty(), "no session yet: ignored")
        val tree = s.handleConnect(key) { sent += it }
        val listId = windowOf(uiMessages(listOf(tree))).listId
        s.handleMessage(key, """{"type":"viewport","listId":"$listId","start":20,"end":50}""") { sent += it }
        val patches = uiMessages(sent.toList()).filter { it["type"]!!.jsonPrimitive.content == "patch" }
        assertEquals(1, patches.size)
        assertEquals(Window(listId, 100, 20, 50), windowOf(uiMessages(listOf(tree)) + patches))
        s.handleDisconnect(key)
    }

    @Test
    fun `the auto-wired router path handles viewports`() = withServer(listServer(autoRouter = true)) { s ->
        requireNative()
        val c = Conn(s)
        c.send("""{"type":"hello"}""")
        c.await { t -> t.any { it.contains("\"initialTree\"") } }
        val listId = windowOf(uiMessages(c.texts())).listId
        c.send("""{"type":"viewport","listId":"$listId","start":30,"end":60}""")
        c.await { t -> t.any { it.contains("\"patch\"") } }
        assertEquals(Window(listId, 100, 30, 60), windowOf(uiMessages(c.texts())))
    }

    // ── Real WebSocket (Netty host + JDK client) ────────────────────────

    @Test
    fun `over a real WebSocket a List of 100 items moves its window on viewport reports`() = withServer(listServer()) { s ->
        requireNative()
        NettyHypenWebSocketServer(s).use { ws ->
            val received: MutableList<String> = Collections.synchronizedList(mutableListOf())
            val socket = HttpClient.newHttpClient().newWebSocketBuilder()
                .buildAsync(URI.create(ws.url), object : WebSocket.Listener {
                    private val buf = StringBuilder()
                    override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
                        buf.append(data)
                        if (last) {
                            received += buf.toString()
                            buf.setLength(0)
                        }
                        webSocket.request(1)
                        return null
                    }
                })
                .get(10, TimeUnit.SECONDS)
            fun texts() = synchronized(received) { received.toList() }
            try {
                socket.sendText("""{"type":"hello","props":{"platform":"web"}}""", true).get(10, TimeUnit.SECONDS)
                awaitTexts(10_000, ::texts) { t -> t.any { it.contains("\"initialTree\"") } }
                val initial = windowOf(uiMessages(texts()))
                assertEquals(100, initial.total)
                assertEquals(0, initial.start)

                // Scroll down, then further, then back to the top.
                val steps = listOf(40 to 70, 70 to 100, 0 to 30)
                for ((i, step) in steps.withIndex()) {
                    socket.sendText("""{"type":"viewport","listId":"${initial.listId}","start":${step.first},"end":${step.second}}""", true)
                        .get(10, TimeUnit.SECONDS)
                    awaitTexts(10_000, ::texts) { t -> uiMessages(t).count { it["type"]!!.jsonPrimitive.content == "patch" } == i + 1 }
                    assertEquals(Window(initial.listId, 100, step.first, step.second), windowOf(uiMessages(texts())))
                }
                val revisions = uiMessages(texts()).filter { it["type"]!!.jsonPrimitive.content == "patch" }
                    .map { it["revision"]!!.jsonPrimitive.long }
                assertEquals(listOf(1L, 2L, 3L), revisions)
                assertTrue(texts().last().contains("Item 0"), "scrolling back re-creates the first rows")
                RemoteWireConformanceTest.ClientDecoder.assertDecodes(texts())
            } finally {
                socket.sendClose(WebSocket.NORMAL_CLOSURE, "done")
            }
        }
    }

    companion object {
        suspend fun awaitTexts(timeoutMs: Long, texts: () -> List<String>, p: (List<String>) -> Boolean) = try {
            withTimeout(timeoutMs) {
                while (!p(texts())) delay(5)
            }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            fail("timed out; the client received: ${texts().joinToString("\n") { it.take(400) }}")
        }
    }
}
