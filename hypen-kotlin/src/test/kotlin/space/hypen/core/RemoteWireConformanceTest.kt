package space.hypen.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.Collections
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * The Remote UI wire shape the Kotlin server puts on the socket, judged the
 * way the clients judge it — not by what kotlinx happens to accept.
 *
 * The Android renderer decodes `patch` / `initialTree` with Moshi's Kotlin
 * adapter (a missing non-null member throws, the message is dropped) and the
 * native desktop client with serde's `RemoteMessage` (`hypen-sdk-rs`, a
 * missing `module` / `state` fails the whole message). A frame either of them
 * cannot decode is silently skipped, so a server that omits a member the TS
 * server sends (`hypen-web/packages/core/src/remote/types.ts`) breaks every
 * UI update on Android and every render on desktop while its own tests stay
 * green. [ClientDecoder] is that contract, member for member.
 *
 * It also pins that a malformed or failing inbound message is logged and
 * dropped (as the TS server does), never thrown into the host's socket read
 * loop, where it would end the connection and every later update with it.
 */
class RemoteWireConformanceTest {
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

    /**
     * The members each server → client UI message MUST carry for the
     * Android (Moshi) and desktop (serde) decoders, with their JSON kinds:
     * the union of both clients' required fields, equal to the TS server's
     * interfaces. Extra members are allowed (every client ignores them).
     */
    object ClientDecoder {
        private enum class Kind { STRING, BOOL, INT, ARRAY, ANY }

        private val required: Map<String, Map<String, Kind>> = mapOf(
            "sessionAck" to mapOf("sessionId" to Kind.STRING, "isNew" to Kind.BOOL, "isRestored" to Kind.BOOL),
            "initialTree" to mapOf("module" to Kind.STRING, "state" to Kind.ANY, "patches" to Kind.ARRAY, "revision" to Kind.INT),
            "patch" to mapOf("module" to Kind.STRING, "patches" to Kind.ARRAY, "revision" to Kind.INT),
            "stateUpdate" to mapOf("module" to Kind.STRING, "state" to Kind.ANY, "revision" to Kind.INT),
            "sessionExpired" to mapOf("sessionId" to Kind.STRING, "reason" to Kind.STRING),
        )

        /** Why a client would drop [text], or null when both clients decode it. Device messages are the broker's, not judged here. */
        fun reject(text: String): String? {
            val o = runCatching { Json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return "not a JSON object"
            val type = (o["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return "no string type"
            if (type.startsWith("device")) return null
            val members = required[type] ?: return "type '$type' is unknown to the Android and desktop clients"
            for ((name, kind) in members) {
                val v: JsonElement = o[name] ?: return "$type without '$name'"
                val ok = when (kind) {
                    Kind.STRING -> v is JsonPrimitive && v.isString
                    Kind.BOOL -> v is JsonPrimitive && !v.isString && v.booleanOrNull != null
                    Kind.INT -> v is JsonPrimitive && !v.isString && v.longOrNull != null && v.longOrNull!! >= 0
                    Kind.ARRAY -> v is JsonArray
                    Kind.ANY -> true
                }
                if (!ok) return "$type.$name is not a ${kind.name.lowercase()}"
            }
            if (type == "initialTree" || type == "patch") {
                for (p in o["patches"] as JsonArray) {
                    val t = ((p as? JsonObject)?.get("type") as? JsonPrimitive)?.content
                    if (t == null) return "$type carries a patch without a type"
                }
            }
            return null
        }

        fun assertDecodes(texts: List<String>) {
            for (t in texts) reject(t)?.let { fail("a client would drop this frame ($it): ${t.take(300)}") }
        }
    }

    private fun counterDef(throwing: Boolean = false): ModuleDefinition<MutableMap<String, Any?>> =
        AppBuilder(mutableMapOf<String, Any?>("count" to 0))
            .ui(
                """module Counter {
                    Column {
                        Text("Count: @{state.count}")
                        Button("@actions.increment") { Text("+") }
                    }
                }""".trimIndent(),
            )
            .onAction("increment") { ctx ->
                ctx.state.set("count", ((ctx.state.get("count") as? Number)?.toInt() ?: 0) + 1)
            }
            .onAction("boom") { _ -> if (throwing) error("handler failed") }
            .build()
            .copy(name = "Counter")

    private fun server(throwing: Boolean = false, autoRouter: Boolean = false): HypenServer {
        val def = counterDef(throwing)
        return HypenServer {
            module("Counter", def)
            route("/", "Counter")
            if (!autoRouter) disableAutoRouter()
        }
    }

    /** A hello-driven connection (what the Android and desktop clients open) over an in-process transport. */
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

        /** Exactly what a Ktor read loop does: any exception here ends the socket. */
        suspend fun send(text: String) = server.handleMessage(key, text) { error("a hello-driven connection writes through its queue") }

        fun texts(): List<String> = synchronized(out) { out.toList() }

        fun ofType(type: String): List<JsonObject> =
            texts().map { Json.parseToJsonElement(it).jsonObject }.filter { it["type"]?.jsonPrimitive?.content == type }

        suspend fun await(timeoutMs: Long = 10_000, p: (List<String>) -> Boolean) = try {
            withTimeout(timeoutMs) {
                while (!p(texts())) delay(5)
            }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            fail("timed out; the client received: ${texts().joinToString("\n") { it.take(400) }}")
        }
    }

    private fun withServer(s: HypenServer, block: suspend (HypenServer) -> Unit) = runBlocking {
        try {
            block(s)
        } finally {
            s.shutdown()
        }
    }

    @Test
    fun `initialTree and patch carry every member the clients require - hello-driven connection`() = withServer(server()) { s ->
        requireNative()
        val c = Conn(s)
        c.send("""{"type":"hello","props":{"platform":"android"}}""")
        c.await { t -> t.any { it.contains("\"initialTree\"") } }
        c.send("""{"type":"dispatchAction","module":"Counter","action":"increment"}""")
        c.await { t -> t.any { it.contains("Count: 1") } }

        ClientDecoder.assertDecodes(c.texts())
        val tree = c.ofType("initialTree").single()
        val patch = c.ofType("patch").single()
        assertEquals("Counter", tree["module"]!!.jsonPrimitive.content)
        assertEquals(tree["module"], patch["module"], "one module name for the whole session")
        assertEquals(JsonPrimitive(0), tree["state"]!!.jsonObject["count"], "initialTree.state is the module's state, like the TS server")
        assertEquals(1L, patch["revision"]!!.jsonPrimitive.longOrNull)
    }

    @Test
    fun `the legacy handleConnect path sends the same shapes`() = withServer(server()) { s ->
        requireNative()
        val key = Any()
        val sent = Collections.synchronizedList(mutableListOf<String>())
        val tree = s.handleConnect(key) { sent += it }
        s.handleMessage(key, """{"type":"dispatchAction","action":"increment"}""") { sent += it }
        ClientDecoder.assertDecodes(sent + tree)
        assertTrue(sent.any { it.contains("\"type\":\"patch\"") })
        s.handleDisconnect(key)
    }

    @Test
    fun `the auto-wired router path sends the same shapes`() = withServer(server(autoRouter = true)) { s ->
        requireNative()
        val c = Conn(s)
        c.send("""{"type":"hello"}""")
        c.await { t -> t.any { it.contains("\"initialTree\"") } }
        c.send("""{"type":"dispatchAction","action":"increment"}""")
        c.await { t -> t.any { it.contains("\"patch\"") } }
        ClientDecoder.assertDecodes(c.texts())
    }

    @Test
    fun `malformed and failing inbound messages never end the connection - later actions still update the UI`() =
        withServer(server(throwing = true)) { s ->
            requireNative()
            val c = Conn(s)
            c.send("""{"type":"hello"}""")
            c.await { t -> t.any { it.contains("\"initialTree\"") } }
            val bad = listOf(
                // Renderer UI-action envelopes the engine refuses (a stale or unknown node, a
                // missing node / action, a nested envelope): the native engine throws.
                """{"type":"dispatchAction","action":"__hypen_dispatch","payload":{"node":"999999","action":"increment"}}""",
                """{"type":"dispatchAction","action":"__hypen_dispatch","payload":{"action":"increment"}}""",
                """{"type":"dispatchAction","action":"__hypen_dispatch","payload":"not an envelope"}""",
                """{"type":"dispatchAction","action":"__hypen_dispatch","payload":{"node":"1","action":"__hypen_dispatch"}}""",
                // A handler that throws.
                """{"type":"dispatchAction","action":"boom"}""",
                // Shapes that are simply wrong.
                """{"type":"dispatchAction","action":42}""",
                """{"type":"dispatchAction"}""",
                """{"type":"navigate","path":{"x":1}}""",
                """{"type":"navigate","path":"/nowhere/at/all"}""",
                """{"type":"subscribeState"}""",
                """{"type":"nonsense"}""",
                """{"type":"deviceEvent","id":1,"event":{}}""",
                """{"type":"deviceResponse","id":"x"}""",
                """{"no":"type"}""",
                """[1,2,3]""",
                """{"type":"dispatchAction","action":"increment""",
                "",
            )
            for (text in bad) {
                try {
                    c.send(text)
                } catch (e: Throwable) {
                    fail("handleMessage threw ${e::class.simpleName} for ${text.take(120)} — the host's read loop would end the socket: ${e.message}")
                }
            }
            assertNull(c.closed, "no inbound message may close the connection")
            c.send("""{"type":"dispatchAction","action":"increment"}""")
            c.await { t -> t.any { it.contains("Count: 1") } }
            ClientDecoder.assertDecodes(c.texts())
            val revisions = c.ofType("patch").map { it["revision"]!!.jsonPrimitive.longOrNull!! }
            assertEquals(revisions.sorted().distinct(), revisions, "revisions strictly increase across refused dispatches")
        }

    @Test
    fun `a failing dispatch on the legacy path is dropped, not thrown`() = withServer(server(throwing = true)) { s ->
        requireNative()
        val key = Any()
        val sent = Collections.synchronizedList(mutableListOf<String>())
        s.handleConnect(key) { sent += it }
        s.handleMessage(key, """{"type":"dispatchAction","action":"__hypen_dispatch","payload":{"node":"999999","action":"increment"}}""") { sent += it }
        s.handleMessage(key, """{"type":"dispatchAction","action":"boom"}""") { sent += it }
        s.handleMessage(key, """{"type":"dispatchAction","action":"increment"}""") { sent += it }
        assertTrue(sent.any { it.contains("Count: 1") }, "a later action still renders: $sent")
        s.handleDisconnect(key)
    }

    @Test
    fun `non-finite numbers in module state never make initialTree invalid JSON`() = runBlocking {
        requireNative()
        val def = AppBuilder(mutableMapOf<String, Any?>("ratio" to Double.NaN, "peak" to Double.NEGATIVE_INFINITY, "ok" to 1.5))
            .ui("""module Stats { Text("stats") }""")
            .build()
            .copy(name = "Stats")
        val s = HypenServer {
            module("Stats", def)
            route("/", "Stats")
            disableAutoRouter()
        }
        try {
            val c = Conn(s)
            c.send("""{"type":"hello"}""")
            c.await { t -> t.any { it.contains("\"initialTree\"") } }
            ClientDecoder.assertDecodes(c.texts())
            val state = c.ofType("initialTree").single()["state"]!!.jsonObject
            assertEquals(kotlinx.serialization.json.JsonNull, state["ratio"])
            assertEquals(kotlinx.serialization.json.JsonNull, state["peak"])
            assertEquals(JsonPrimitive(1.5), state["ok"])
        } finally {
            s.shutdown()
        }
    }

    // ---- navigation and hot reload: every frame decodable, the client tree correct ----

    /**
     * A renderer's element tree, applying patches with the Android /
     * desktop semantics (create replaces an id, remove drops the subtree,
     * `root` is the implicit container). [dump] is the visible text.
     */
    class ClientTree {
        private class Node(val type: String, var props: MutableMap<String, JsonElement>) {
            val children = mutableListOf<String>()
            var parent: String? = null
        }

        private val nodes = HashMap<String, Node>()
        private val roots = mutableListOf<String>()

        fun apply(message: String) {
            val o = Json.parseToJsonElement(message).jsonObject
            val t = o["type"]!!.jsonPrimitive.content
            if (t != "initialTree" && t != "patch") return
            for (p in o["patches"] as JsonArray) patch(p.jsonObject)
        }

        private fun str(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun unlink(id: String) {
            val n = nodes[id] ?: return
            n.parent?.let { if (it == "root") roots.remove(id) else nodes[it]?.children?.remove(id) }
            n.parent = null
        }

        private fun link(parent: String, id: String, before: String?) {
            unlink(id)
            val list = if (parent == "root") roots else nodes[parent]?.children ?: return
            val at = before?.let { list.indexOf(it) }?.takeIf { it >= 0 } ?: list.size
            list.add(at, id)
            nodes[id]?.parent = parent
        }

        private fun drop(id: String) {
            val n = nodes[id] ?: return
            unlink(id)
            n.children.toList().forEach(::drop)
            nodes.remove(id)
        }

        private fun patch(p: JsonObject) {
            val id = str(p, "id") ?: return
            when (str(p, "type")) {
                "create" -> {
                    drop(id)
                    nodes[id] = Node(str(p, "elementType")!!, (p["props"] as? JsonObject)?.toMutableMap() ?: mutableMapOf())
                }
                "setProp" -> nodes[id]?.props?.put(str(p, "name")!!, p["value"]!!)
                "removeProp" -> nodes[id]?.props?.remove(str(p, "name")!!)
                "insert", "move", "attach" -> link(str(p, "parentId")!!, id, str(p, "beforeId"))
                "detach" -> unlink(id)
                "remove" -> drop(id)
            }
        }

        fun dump(): String = buildString { roots.forEach { render(it) } }.trim()

        private fun StringBuilder.render(id: String) {
            val n = nodes[id] ?: return
            (n.props["0"] as? JsonPrimitive)?.takeIf { it.isString }?.let { append(it.content).append(' ') }
            n.children.forEach { render(it) }
        }

        val size: Int get() = nodes.size
    }

    private fun tree(texts: List<String>) = ClientTree().also { t -> texts.forEach(t::apply) }

    private fun screen(name: String, text: String) = AppBuilder(mutableMapOf<String, Any?>("n" to 0))
        .ui("""module $name { Column { Text("$text") Text("n=@{state.n}") } }""")
        .onAction("bump$name") { ctx -> ctx.state.set("n", ((ctx.state.get("n") as? Number)?.toInt() ?: 0) + 1) }
        .build()
        .copy(name = name)

    private fun routeTableServer(): HypenServer {
        val a = screen("Alpha", "screen A")
        val b = screen("Beta", "screen B")
        return HypenServer {
            module("Alpha", a)
            module("Beta", b)
            route("/", "Alpha")
            route("/b", "Beta")
            disableAutoRouter()
        }
    }

    @Test
    fun `navigate on a route-table server sends a decodable patch that replaces the screen`() = withServer(routeTableServer()) { s ->
        requireNative()
        val c = Conn(s)
        c.send("""{"type":"hello"}""")
        c.await { t -> t.any { it.contains("\"initialTree\"") } }
        c.send("""{"type":"navigate","path":"/b"}""")
        c.await { t -> t.any { it.contains("screen B") } }
        ClientDecoder.assertDecodes(c.texts())
        assertEquals("screen B n=0", tree(c.texts()).dump(), "the client shows only the new screen")
        c.send("""{"type":"navigate","path":"/"}""")
        c.await { t -> tree(t).dump() == "screen A n=0" }
        ClientDecoder.assertDecodes(c.texts())
        val revisions = c.ofType("patch").map { it["revision"]!!.jsonPrimitive.longOrNull!! }
        assertEquals(revisions.sorted().distinct(), revisions)
    }

    @Test
    fun `route-table navigation A to B to A - every screen's actions reach its module`() = withServer(routeTableServer()) { s ->
        requireNative()
        val c = Conn(s)
        c.send("""{"type":"hello"}""")
        c.await { t -> t.any { it.contains("\"initialTree\"") } }
        c.send("""{"type":"dispatchAction","action":"bumpAlpha"}""")
        c.await { t -> tree(t).dump() == "screen A n=1" }
        c.send("""{"type":"navigate","path":"/b"}""")
        c.await { t -> tree(t).dump() == "screen B n=0" }
        c.send("""{"type":"dispatchAction","action":"bumpBeta"}""")
        c.await { t -> tree(t).dump() == "screen B n=1" }
        c.send("""{"type":"dispatchAction","action":"bumpBeta"}""")
        c.await { t -> tree(t).dump() == "screen B n=2" }
        c.send("""{"type":"navigate","path":"/"}""")
        c.await { t -> tree(t).dump().startsWith("screen A") }
        // Route-table mode remounts the route's module on every visit (fresh state).
        c.await { t -> tree(t).dump() == "screen A n=0" }
        c.send("""{"type":"dispatchAction","action":"bumpAlpha"}""")
        c.await { t -> tree(t).dump() == "screen A n=1" }
        ClientDecoder.assertDecodes(c.texts())
    }

    @Test
    fun `a network reconnect within the TTL resumes the session with its state restored`() {
        requireNative()
        withServer(server()) { s ->
            val c = Conn(s)
            c.send("""{"type":"hello"}""")
            c.await { t -> t.any { it.contains("\"initialTree\"") } }
            c.send("""{"type":"dispatchAction","action":"increment"}""")
            c.send("""{"type":"dispatchAction","action":"increment"}""")
            c.await { t -> tree(t).dump().startsWith("Count: 2") }
            val id = c.ofType("sessionAck").single()["sessionId"]!!.jsonPrimitive.content
            s.handleDisconnect(c.key) // the socket dropped

            val again = Conn(s)
            again.send("""{"type":"hello","sessionId":"$id"}""")
            again.await { t -> t.any { it.contains("\"initialTree\"") } }
            assertEquals("true", again.ofType("sessionAck").single()["isRestored"]!!.jsonPrimitive.content)
            assertEquals(JsonPrimitive(2), again.ofType("initialTree").single()["state"]!!.jsonObject["count"])
            assertTrue(tree(again.texts()).dump().startsWith("Count: 2"), tree(again.texts()).dump())
            // And it stays live.
            again.send("""{"type":"dispatchAction","action":"increment"}""")
            again.await { t -> tree(t).dump().startsWith("Count: 3") }
        }
    }

    @Test
    fun `resuming under the auto-wired router returns to the restored location`() {
        requireNative()
        val source = """
            module App { Column { Router { Route(path: "/") { Home() } Route(path: "/about") { About() } } } }
            module Home { Text("home") }
            module About { Text("about") }
        """.trimIndent()
        val active = Collections.synchronizedList(mutableListOf<String>())
        app.module("App").defineState(mapOf("location" to "/")).ui(source).build()
        app.module("Home").defineState(mapOf<String, Any?>()).onActivated { _, _ -> active += "Home" }.onDeactivated { _, _ -> active -= "Home" }.build()
        app.module("About").defineState(mapOf<String, Any?>()).onActivated { _, _ -> active += "About" }.onDeactivated { _, _ -> active -= "About" }.build()
        withServer(HypenServer { module("App", HypenApp.get("App")!!); route("/", "App") }) { s ->
            val c = Conn(s)
            c.send("""{"type":"hello"}""")
            c.await { t -> t.any { it.contains("\"initialTree\"") } }
            c.send("""{"type":"dispatchAction","action":"router.push","payload":{"to":"/about"}}""")
            c.await { t -> t.any { it.contains("\"About\"") } }
            val id = c.ofType("sessionAck").single()["sessionId"]!!.jsonPrimitive.content
            s.handleDisconnect(c.key)

            val again = Conn(s)
            again.send("""{"type":"hello","sessionId":"$id"}""")
            again.await { t -> t.any { it.contains("\"initialTree\"") } }
            val tree = again.ofType("initialTree").single()
            assertEquals(JsonPrimitive("/about"), tree["state"]!!.jsonObject["location"])
            val types = (tree["patches"] as JsonArray).mapNotNull { (it.jsonObject["elementType"] as? JsonPrimitive)?.content }
            assertTrue("About" in types && "Home" !in types, "the resumed tree shows the restored route: $types")
            // The router followed too: the restored route's module is the active one.
            assertEquals(listOf("About"), active.toList().takeLast(1), "active modules: $active")
            assertTrue("Home" !in active, "the resumed session's Home module is not left active: $active")
        }
    }

    @Test
    fun `an onReconnect handler takes over the restore decision, as on the TS server`() {
        requireNative()
        val calls = Collections.synchronizedList(mutableListOf<String>())
        val def = AppBuilder(mutableMapOf<String, Any?>("count" to 0))
            .ui("""module Counter { Text("Count: @{state.count}") }""")
            .onAction("increment") { ctx -> ctx.state.set("count", ((ctx.state.get("count") as? Number)?.toInt() ?: 0) + 1) }
            .onReconnect { ctx ->
                calls += ctx.session.id
                ctx.restore(mapOf("count" to 40))
            }
            .build()
            .copy(name = "Counter")
        withServer(HypenServer { module("Counter", def); route("/", "Counter"); disableAutoRouter() }) { s ->
            val c = Conn(s)
            c.send("""{"type":"hello"}""")
            c.await { t -> t.any { it.contains("\"initialTree\"") } }
            c.send("""{"type":"dispatchAction","action":"increment"}""")
            c.await { t -> tree(t).dump() == "Count: 1" }
            val id = c.ofType("sessionAck").single()["sessionId"]!!.jsonPrimitive.content
            s.handleDisconnect(c.key)
            val again = Conn(s)
            again.send("""{"type":"hello","sessionId":"$id"}""")
            again.await { t -> t.any { it.contains("\"initialTree\"") } }
            assertEquals(listOf(id), calls.toList())
            assertEquals("Count: 40", tree(again.texts()).dump(), "the handler's restore(), not the automatic one")
        }
    }

    @Test
    fun `navigate on the legacy handleConnect path is decodable too`() = withServer(routeTableServer()) { s ->
        requireNative()
        val key = Any()
        val sent = Collections.synchronizedList(mutableListOf<String>())
        sent += s.handleConnect(key) { sent += it }
        s.handleMessage(key, """{"type":"navigate","path":"/b"}""") { sent += it }
        ClientDecoder.assertDecodes(sent.sortedBy { if (it.contains("sessionAck")) 0 else 1 })
        assertEquals("screen B n=0", tree(sent.filterNot { it.contains("sessionAck") }).dump())
        s.handleDisconnect(key)
    }

    @Test
    fun `navigate under the auto-wired router sends a decodable patch`() {
        requireNative()
        // One multi-module document, as the auto-wire path expects (see NestedRouterAutoWireTest).
        val source = """
            module App { Column { Router { Route(path: "/") { Home() } Route(path: "/about") { About() } } } }
            module Home { Text("home") }
            module About { Text("about") }
        """.trimIndent()
        app.module("App").defineState(mapOf("location" to "/")).ui(source).build()
        app.module("Home").defineState(mapOf<String, Any?>()).build()
        app.module("About").defineState(mapOf<String, Any?>()).build()
        withServer(HypenServer { module("App", HypenApp.get("App")!!); route("/", "App") }) { s ->
            val c = Conn(s)
            c.send("""{"type":"hello"}""")
            c.await { t -> t.any { it.contains("\"initialTree\"") } }
            c.send("""{"type":"navigate","path":"/about"}""")
            c.await { t -> t.any { it.contains("\"About\"") } }
            ClientDecoder.assertDecodes(c.texts())
            // The router's own patch (detach the old route, attach/create the new one) — the
            // same frame a `dispatchAction router.push` produces on the TS server.
            assertEquals(1, c.ofType("patch").size)
        }
    }

    @Test
    fun `hot reload closes hello-driven sockets 1012 and the reconnect resumes with a fresh initialTree`() {
        requireNative()
        val dir = java.nio.file.Files.createTempDirectory("hypen-hot")
        val badge = dir.resolve("Badge.hypen")
        java.nio.file.Files.writeString(badge, """Text("badge v1")""")
        val def = AppBuilder(mutableMapOf<String, Any?>("n" to 0))
            .ui("""module Hot { Column { Badge() Text("n=@{state.n}") } }""")
            .onAction("bump") { ctx -> ctx.state.set("n", ((ctx.state.get("n") as? Number)?.toInt() ?: 0) + 1) }
            .build()
            .copy(name = "Hot")
        val s = HypenServer {
            module("Hot", def)
            route("/", "Hot")
            disableAutoRouter()
            watchComponents(dir.toString()) { debounceMs = 20 }
        }
        withServer(s) {
            val c = Conn(s)
            c.send("""{"type":"hello"}""")
            c.await { t -> t.any { it.contains("badge v1") } }
            c.send("""{"type":"dispatchAction","action":"bump"}""")
            c.await { t -> t.any { it.contains("n=1") } }
            // No `render` (or any other) frame into the live socket: the reload is a reconnect.
            val before = c.texts().size
            val sessionId = c.ofType("sessionAck").single()["sessionId"]!!.jsonPrimitive.content
            java.nio.file.Files.writeString(badge, """Text("badge v2")""")
            withTimeout(15_000) { while (c.closed == null) delay(10) }
            assertEquals(1012, c.closed!!.first, "the TS server's hot-reload reset")
            assertEquals(before, c.texts().size, "nothing is sent into a socket that is being reset")
            ClientDecoder.assertDecodes(c.texts())
            s.handleDisconnect(c.key) // the host's read loop ends with the socket

            // The client reconnects with its session id: resumed, fresh tree from the new source.
            val again = Conn(s)
            again.send("""{"type":"hello","sessionId":"$sessionId"}""")
            again.await { t -> t.any { it.contains("\"initialTree\"") } }
            ClientDecoder.assertDecodes(again.texts())
            val ack = again.ofType("sessionAck").single()
            assertEquals(sessionId, ack["sessionId"]!!.jsonPrimitive.content)
            assertEquals("true", ack["isRestored"]!!.jsonPrimitive.content)
            // The suspended state is restored automatically (TS `triggerReconnect`): n survives.
            assertEquals("badge v2 n=1", tree(again.texts()).dump())
        }
        dir.toFile().deleteRecursively()
    }

    @Test
    fun `hot reload on the legacy handleConnect path sends a decodable patch with the new source`() {
        requireNative()
        val dir = java.nio.file.Files.createTempDirectory("hypen-hot")
        val badge = dir.resolve("Badge.hypen")
        java.nio.file.Files.writeString(badge, """Text("badge v1")""")
        val def = AppBuilder(mutableMapOf<String, Any?>()).ui("""module Hot { Column { Badge() } }""").build().copy(name = "Hot")
        val s = HypenServer {
            module("Hot", def)
            route("/", "Hot")
            disableAutoRouter()
            watchComponents(dir.toString()) { debounceMs = 20 }
        }
        withServer(s) {
            val key = Any()
            val sent = Collections.synchronizedList(mutableListOf<String>())
            sent += s.handleConnect(key) { sent += it }
            java.nio.file.Files.writeString(badge, """Text("badge v2")""")
            withTimeout(15_000) { while (synchronized(sent) { sent.none { it.contains("badge v2") } }) delay(10) }
            val frames = synchronized(sent) { sent.toList() }
            ClientDecoder.assertDecodes(frames)
            assertEquals("badge v2", tree(frames.filterNot { it.contains("sessionAck") }).dump())
            s.handleDisconnect(key)
        }
        dir.toFile().deleteRecursively()
    }

    @Test
    fun `sessionExpired from reject-new and kick-old is decodable`() {
        requireNative()
        for (policy in listOf(ConcurrentPolicy.REJECT_NEW, ConcurrentPolicy.KICK_OLD)) {
            val def = counterDef()
            val s = HypenServer {
                module("Counter", def)
                route("/", "Counter")
                disableAutoRouter()
                session { concurrent = policy }
            }
            withServer(s) {
                val first = Conn(s)
                first.send("""{"type":"hello"}""")
                first.await { t -> t.any { it.contains("\"initialTree\"") } }
                val id = first.ofType("sessionAck").single()["sessionId"]!!.jsonPrimitive.content
                val second = Conn(s)
                second.send("""{"type":"hello","sessionId":"$id"}""")
                val loser = if (policy == ConcurrentPolicy.REJECT_NEW) second else first
                loser.await { t -> t.any { it.contains("\"sessionExpired\"") } }
                ClientDecoder.assertDecodes(first.texts())
                ClientDecoder.assertDecodes(second.texts())
            }
        }
    }

    @Test
    fun `the client decoder itself rejects what the clients reject`() {
        assertEquals("patch without 'module'", ClientDecoder.reject("""{"type":"patch","patches":[],"revision":1}"""))
        assertEquals("initialTree without 'state'", ClientDecoder.reject("""{"type":"initialTree","module":"M","patches":[],"revision":0}"""))
        assertEquals(null, ClientDecoder.reject("""{"type":"initialTree","module":"M","state":null,"patches":[],"revision":0,"routes":[]}"""))
        assertTrue(ClientDecoder.reject("""{"type":"render","patches":[]}""")!!.contains("unknown"))
        assertEquals(null, ClientDecoder.reject("""{"type":"deviceRequest","id":1}"""))
    }
}
