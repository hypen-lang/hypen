package space.hypen.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import space.hypen.remote.device.DevicePlaneTest
import space.hypen.remote.device.DeviceRequestOptions
import space.hypen.remote.device.FakeDeviceClient
import space.hypen.remote.device.GalleryPickParams
import space.hypen.remote.device.MediaType
import space.hypen.remote.device.Permission
import java.util.Collections
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Kotlin server's device plane end to end over an in-process transport:
 * the plane is on by default (no enable call; `configureDevice` tunes it,
 * `disableDevice` opts out; compression is on too, and a socket that
 * negotiated permessage-deflate with context takeover stays UI-only),
 * upgrade admission (Origin allowlist / authenticator, each enforced exactly
 * when configured), hello-driven handshakes, `sessionAck.device` + rotating
 * `resumeToken`, the Rust broker per connection (core.capabilities first),
 * async patches after device work, binary routing, oversize text, resume
 * credentials (required only for device sessions), the legacy
 * `handleConnect` path and teardown. The client side is [FakeDeviceClient]
 * (the TS web client over a real WebSocket is `DeviceWebSocketE2ETest`).
 */
class HypenServerDeviceTest {
    private val json = Json

    @BeforeEach
    fun reset() = HypenApp.clear()

    @AfterEach
    fun cleanup() = HypenApp.clear()

    private fun appModule(): ModuleDefinition<MutableMap<String, Any?>> =
        AppBuilder(mutableMapOf<String, Any?>("q" to "", "pick" to "", "slow" to ""))
            .ui(
                """module App {
                    Column {
                        Text("q:@{state.q}")
                        Text("pick:@{state.pick}")
                        Text("slow:@{state.slow}")
                    }
                }""".trimIndent(),
            )
            .onActionAsync("query") { ctx ->
                val r = ctx.device.permissions.query(Permission.CAMERA)
                ctx.state.set("q", r.getOrNull()?.wireName ?: r.errorOrNull()!!.code.wireName)
            }
            .onActionAsync("pick") { ctx ->
                val r = ctx.device.gallery.pick(GalleryPickParams(listOf(MediaType.PHOTO), 1))
                ctx.state.set("pick", r.getOrNull()?.let { "${it[0].bytes.size}:${it[0].sha256}" } ?: r.errorOrNull()!!.code.wireName)
            }
            .onActionAsync("slow") { ctx ->
                val r = ctx.device.permissions.request(Permission.CAMERA, DeviceRequestOptions(timeoutMs = 60_000))
                ctx.state.set("slow", r.errorOrNull()?.code?.wireName ?: "ok")
            }
            .build()
            .copy(name = "App")

    private fun server(
        device: (DeviceServerConfig.() -> Unit)? = {},
        origins: List<String> = listOf("https://app.test"),
        auth: (suspend (UpgradeRequest) -> Boolean)? = { it.header("Authorization") == "Bearer ok" },
    ): HypenServer {
        val def = appModule()
        return HypenServer {
            module("App", def)
            route("/", "App")
            disableAutoRouter()
            if (origins.isNotEmpty()) allowedOrigins(*origins.toTypedArray())
            auth?.let { authenticate(it) }
            if (device == null) disableDevice() else configureDevice(device)
        }
    }

    /** One hello-driven connection with a scripted device client behind it. */
    private class Conn(val server: HypenServer, val scope: CoroutineScope, webSocketExtensions: String? = null) {
        val key = Any()
        val out: MutableList<String> = Collections.synchronizedList(mutableListOf())
        @Volatile var closed: Pair<Int, String>? = null
        private val toServer = Channel<Any>(Channel.UNLIMITED)
        val client: FakeDeviceClient = FakeDeviceClient(scope, { toServer.trySend(it) }, { toServer.trySend(it) })

        init {
            server.openConnection(key, object : HypenTransport {
                override suspend fun sendText(text: String) {
                    out += text
                    if (text.contains("\"type\":\"device")) client.fromServer(text)
                }
                override suspend fun sendBinary(bytes: ByteArray) = client.fromServerFrame(bytes)
                override suspend fun close(code: Int, reason: String) {
                    closed = code to reason
                }
            }, webSocketExtensions)
            scope.launch {
                for (m in toServer) when (m) {
                    is String -> server.handleMessage(key, m) { error("a hello-driven connection writes through its queue") }
                    is ByteArray -> server.handleBinary(key, m)
                }
            }
        }

        fun send(text: String) {
            toServer.trySend(text)
        }

        fun hello(device: Boolean = true, sessionId: String? = null, token: String? = null, rawDevice: String? = null) {
            val dev = rawDevice ?: if (device) DevicePlaneTest.HELLO else null
            val parts = mutableListOf("\"type\":\"hello\"")
            sessionId?.let { parts += "\"sessionId\":\"$it\"" }
            token?.let { parts += "\"resumeToken\":\"$it\"" }
            dev?.let { parts += "\"device\":$it" }
            send("{" + parts.joinToString(",") + "}")
        }

        fun messages(): List<JsonObject> = synchronized(out) { out.toList() }.map { Json.parseToJsonElement(it).jsonObject }

        suspend fun awaitMessage(timeoutMs: Long = 10_000, p: (String) -> Boolean): String = withTimeout(timeoutMs) {
            while (true) {
                synchronized(out) { out.firstOrNull(p) }?.let { return@withTimeout it }
                delay(5)
            }
            @Suppress("UNREACHABLE_CODE") error("unreachable")
        }

        suspend fun ack(): JsonObject = Json.parseToJsonElement(awaitMessage { it.contains("\"sessionAck\"") }).jsonObject

        suspend fun disconnect() = server.handleDisconnect(key)
    }

    private fun <T> withScope(block: suspend CoroutineScope.(CoroutineScope) -> T): T = runBlocking {
        val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        try {
            block(scope)
        } finally {
            scope.cancel()
        }
    }

    // ---- configuration + admission -------------------------------------------------

    @Test
    fun `device and compression are both on by default, independently`() {
        // No enable call and no allowlist / authenticator: the server starts.
        val bare = HypenServer { module("App", appModule()) }
        assertTrue(bare.deviceEnabled)
        assertTrue(bare.compression, "compression is on by default with the device plane on")
        val s = server()
        assertTrue(s.deviceEnabled)
        assertTrue(s.compression)
        // disableDevice(): the old UI-only server, compression unchanged.
        val ui = server(device = null)
        assertFalse(ui.deviceEnabled)
        assertTrue(ui.compression)
        // compression = false keeps the device plane.
        val raw = HypenServer { compression = false }
        assertTrue(raw.deviceEnabled)
        assertFalse(raw.compression)
        // An explicit compression = true no longer turns the device plane off.
        val explicit = HypenServer { compression = true }
        assertTrue(explicit.deviceEnabled)
        assertTrue(explicit.compression)
        listOf(bare, s, ui, raw, explicit).forEach { it.shutdown() }
    }

    private fun compressingServer() = HypenServer {
        module("App", appModule())
        route("/", "App")
        disableAutoRouter()
        compression = true
    }

    @Test
    fun `a socket compressed without context takeover negotiates the device plane`() = withScope { scope ->
        val s = compressingServer()
        val c = Conn(s, scope, "permessage-deflate; server_no_context_takeover; client_no_context_takeover")
        c.client.driver("permission.query") { respond(buildJsonObject { put("status", "granted") }) }
        c.hello()
        val ack = c.ack()
        assertNotNull(ack["device"], "per-message compression allows the device plane")
        assertNotNull(ack["resumeToken"])
        c.awaitMessage { it.contains("\"initialTree\"") }
        assertNotNull(s.devicePlane(c.key))
        c.send("""{"type":"dispatchAction","action":"query"}""")
        c.awaitMessage { it.contains("q:granted") }
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `a socket compressed with context takeover runs UI-only with one warning`() = withScope { scope ->
        val warnings = Collections.synchronizedList(mutableListOf<String>())
        val previous = Logger.getLogLevel()
        Logger.configure(
            LoggerConfig(
                level = LogLevel.WARN,
                handler = object : LogHandler {
                    override fun debug(tag: String, message: String, args: List<Any?>) {}
                    override fun info(tag: String, message: String, args: List<Any?>) {}
                    override fun warn(tag: String, message: String, args: List<Any?>) { warnings += message }
                    override fun error(tag: String, message: String, args: List<Any?>) {}
                },
            ),
        )
        val s = compressingServer()
        try {
            for (negotiated in listOf(
                "permessage-deflate",
                "permessage-deflate; server_no_context_takeover",
                "permessage-deflate; client_no_context_takeover; client_max_window_bits=15",
            )) {
                warnings.clear()
                val c = Conn(s, scope, negotiated)
                c.hello()
                val ack = c.ack()
                assertNull(ack["device"], "context takeover ($negotiated) must keep the socket UI-only")
                assertNotNull(ack["resumeToken"])
                c.awaitMessage { it.contains("\"initialTree\"") }
                assertNull(s.devicePlane(c.key))
                c.send("""{"type":"dispatchAction","action":"query"}""")
                c.awaitMessage { it.contains("q:unavailable") }
                assertEquals(1, warnings.count { it.contains("context takeover") }, "$negotiated: $warnings")
                c.disconnect()
            }
        } finally {
            s.shutdown()
            Logger.configure(LoggerConfig(level = previous))
        }
    }

    @Test
    fun `a hello offering device negotiates the plane with no enable call`() = withScope { scope ->
        val def = appModule()
        val s = HypenServer {
            module("App", def)
            route("/", "App")
            disableAutoRouter()
        }
        // Neither allowlist nor authenticator: every upgrade is admitted.
        assertTrue(s.admit(UpgradeRequest.of("Origin" to "https://anything.test")).isAdmitted)
        assertTrue(s.admit(UpgradeRequest.of()).isAdmitted)
        val c = Conn(s, scope)
        c.client.driver("permission.query") { respond(buildJsonObject { put("status", "granted") }) }
        c.hello()
        val ack = c.ack()
        assertNotNull(ack["device"])
        assertNotNull(ack["resumeToken"])
        c.awaitMessage { it.contains("\"initialTree\"") }
        assertNotNull(s.devicePlane(c.key))
        c.send("""{"type":"dispatchAction","action":"query"}""")
        c.awaitMessage { it.contains("q:granted") }
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `disableDevice opts out - a device offer gets a UI-only session`() = withScope { scope ->
        val s = server(device = null)
        val c = Conn(s, scope)
        c.hello()
        val ack = c.ack()
        assertNull(ack["device"])
        c.awaitMessage { it.contains("\"initialTree\"") }
        assertNull(s.devicePlane(c.key))
        c.send("""{"type":"dispatchAction","action":"query"}""")
        c.awaitMessage { it.contains("q:unavailable") }
        // A UI-only session resumes by its id alone.
        val sid = ack["sessionId"]!!.jsonPrimitive.content
        c.disconnect()
        val again = Conn(s, scope)
        again.hello(sessionId = sid)
        assertEquals(sid, again.ack()["sessionId"]!!.jsonPrimitive.content)
        again.disconnect()
        s.shutdown()
    }

    @Test
    fun `upgrade admission - origin allowlist and authenticator enforced exactly when configured`() = runBlocking {
        val s = server()
        assertEquals(Admission.Admitted, s.admit(UpgradeRequest.of("Origin" to "https://APP.test:443", "Authorization" to "Bearer ok")))
        assertEquals(403, (s.admit(UpgradeRequest.of("Origin" to "https://evil.test", "Authorization" to "Bearer ok")) as Admission.Rejected).status)
        // An allowed Origin still runs the authenticator.
        assertFalse(s.admit(UpgradeRequest.of("Origin" to "https://app.test")).isAdmitted)
        // Native clients (no Origin) are admitted only by the authenticator.
        assertTrue(s.admit(UpgradeRequest.of("authorization" to "Bearer ok")).isAdmitted)
        assertFalse(s.admit(UpgradeRequest.of()).isAdmitted)

        // Allowlist only: no Origin ⇒ fail closed.
        val originsOnly = server(auth = null)
        assertFalse(originsOnly.admit(UpgradeRequest.of()).isAdmitted)
        assertTrue(originsOnly.admit(UpgradeRequest.of("Origin" to "https://app.test")).isAdmitted)
        // Authenticator only: it alone decides, with or without an Origin
        // (admission is no longer tied to the device plane).
        val authOnly = server(origins = emptyList())
        assertTrue(authOnly.admit(UpgradeRequest.of("Origin" to "https://app.test", "Authorization" to "Bearer ok")).isAdmitted)
        assertFalse(authOnly.admit(UpgradeRequest.of("Origin" to "https://app.test")).isAdmitted)
        assertTrue(authOnly.admit(UpgradeRequest.of("Authorization" to "Bearer ok")).isAdmitted)
        assertFalse(authOnly.admit(UpgradeRequest.of()).isAdmitted)
        // A throwing authenticator refuses.
        val throwing = server(auth = { error("boom") })
        assertFalse(throwing.admit(UpgradeRequest.of("Origin" to "https://app.test")).isAdmitted)
        // Neither configured: open admission, device plane on or off.
        val open = server(origins = emptyList(), auth = null)
        assertTrue(open.deviceEnabled)
        assertTrue(open.admit(UpgradeRequest.of("Origin" to "https://anything.test")).isAdmitted)
        assertTrue(open.admit(UpgradeRequest.of()).isAdmitted)
        val openUi = server(device = null, origins = emptyList(), auth = null)
        assertTrue(openUi.admit(UpgradeRequest.of("Origin" to "https://anything.test")).isAdmitted)
        listOf(s, originsOnly, authOnly, throwing, open, openUi).forEach { it.shutdown() }
    }

    @Test
    fun `origin normalization`() {
        assertEquals("https://a.test", UpgradeAdmission.normalizeOrigin("HTTPS://A.test:443/path"))
        assertEquals("http://a.test:8080", UpgradeAdmission.normalizeOrigin("http://a.test:8080"))
        assertEquals("null", UpgradeAdmission.normalizeOrigin("null"))
    }

    // ---- default auto-wired router ------------------------------------------------

    /**
     * Regression: the auto-wired [ManagedRouter] (the DEFAULT path, no
     * `disableAutoRouter()`) activates the initial route module while the
     * session is being established. The device plane must already be
     * attached — `core.capabilities` open — so the route module's
     * `onActivated` gets a live device context (it used to get a dead,
     * `device-disabled` one that the later attach could not revive).
     */
    @Test
    fun `the auto-wired router activates its route module on a live device plane`() = withScope { scope ->
        val created = kotlinx.coroutines.CompletableDeferred<String>()
        val activated = kotlinx.coroutines.CompletableDeferred<String>()
        app.module("App")
            .defineState(mapOf<String, Any?>())
            .ui("""module App { Router { Route(path: "/") { Page() } } }""")
            .build()
        app.module("Page")
            .defineState(mapOf<String, Any?>("perm" to ""))
            .onCreated { _, ctx ->
                // Constructed on the plane, not yet activated: owner-inactive (never device-disabled).
                val device = ctx!!.device
                scope.launch { created.complete(device.permissions.query(Permission.CAMERA).errorOrNull()?.platformDetail ?: "ok") }
            }
            .onActivated { state, ctx ->
                val device = ctx!!.device
                scope.launch {
                    val r = device.permissions.query(Permission.CAMERA)
                    val text = r.getOrNull()?.wireName ?: "${r.errorOrNull()!!.code.wireName}:${r.errorOrNull()!!.platformDetail}"
                    state.set("perm", text) // state written from the activation's continuation
                    activated.complete(text)
                }
            }
            .build()
        val s = HypenServer {
            module("App", HypenApp.get("App")!!)
            route("/", "App")
            allowedOrigins("https://app.test")
            authenticate { it.header("Authorization") == "Bearer ok" }
        }
        val c = Conn(s, scope)
        c.client.driver("permission.query") { respond(buildJsonObject { put("status", "granted") }) }
        c.hello()
        assertNotNull(c.ack()["device"])
        assertEquals("owner-inactive", withTimeout(10_000) { created.await() })
        assertEquals("granted", withTimeout(10_000) { activated.await() }, "onActivated got a live device context")
        c.awaitMessage { it.contains("\"initialTree\"") }
        // On the wire: sessionAck, then the control stream, and only then the route module's request.
        val order = c.messages().filter { it["type"]!!.jsonPrimitive.content != "deviceEvent" }
            .map { it["type"]!!.jsonPrimitive.content + (it["capability"]?.jsonPrimitive?.content?.let { n -> ":$n" } ?: "") }
        assertEquals(listOf("sessionAck", "deviceRequest:core.capabilities"), order.take(2), "$order")
        assertTrue("deviceRequest:permission.query" in order, "$order")
        // The request carries the route module's live activation as its owner.
        val owner = c.client.requests("permission.query").single()["owner"]!!.jsonObject
        assertEquals(1L, owner["activationId"]!!.jsonPrimitive.long)
        assertTrue(s.devicePlane(c.key)!!.ownerIsActive(owner["moduleInstanceId"]!!.jsonPrimitive.content, 1u))
        c.disconnect()
        s.shutdown()
    }

    // ---- handshake ---------------------------------------------------------------

    @Test
    fun `hello with device - ack carries device and a resume token, core capabilities precedes the tree`() = withScope { scope ->
        val s = server()
        val c = Conn(s, scope)
        delay(100)
        assertTrue(c.messages().isEmpty(), "nothing is sent before the explicit hello (no hello grace)")
        c.client.driver("permission.query") { respond(buildJsonObject { put("status", "granted") }) }
        c.hello()
        val ack = c.ack()
        val device = ack["device"]!!.jsonObject
        assertEquals(1, device["protocolVersion"]!!.jsonPrimitive.long)
        assertTrue(device["capabilities"]!!.jsonArray.any { it.jsonObject["name"]!!.jsonPrimitive.content == "gallery.pick" })
        val token = ack["resumeToken"]!!.jsonPrimitive.content
        assertTrue(token.length >= 43, "≥ 256 bits base64url")
        c.awaitMessage { it.contains("\"initialTree\"") }
        // (renewLease controls ride along with the request; not ordering-relevant here)
        val types = c.messages().filter { it["type"]!!.jsonPrimitive.content != "deviceEvent" }.map { it["type"]!!.jsonPrimitive.content + (it["capability"]?.jsonPrimitive?.content?.let { n -> ":$n" } ?: "") }
        assertEquals(listOf("sessionAck", "deviceRequest:core.capabilities", "initialTree"), types.take(3))
        assertNotNull(s.devicePlane(c.key))

        // A handler's device work reaches the client, and the state change
        // after the await is flushed as its own patch message.
        c.send("""{"type":"dispatchAction","action":"query"}""")
        c.awaitMessage { it.contains("\"patch\"") && it.contains("q:granted") }
        assertEquals(1, c.client.requests("permission.query").size)
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `hello without device, or with an invalid one, disables the device plane but keeps the session`() = withScope { scope ->
        val s = server()
        val plain = Conn(s, scope)
        plain.hello(device = false)
        val ack = plain.ack()
        assertNull(ack["device"])
        assertNotNull(ack["resumeToken"])
        plain.awaitMessage { it.contains("\"initialTree\"") }
        assertNull(s.devicePlane(plain.key))
        plain.send("""{"type":"dispatchAction","action":"query"}""")
        plain.awaitMessage { it.contains("q:unavailable") }

        // Duplicate keys inside hello.device (only visible in the raw text): invalid ⇒ disabled.
        val dup = Conn(s, scope)
        dup.hello(rawDevice = """{"protocolVersions":[1],"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]}""")
        assertNull(dup.ack()["device"])
        // A duplicate capability name is invalid too (D7).
        val dupName = Conn(s, scope)
        dupName.hello(rawDevice = """{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]},{"name":"core.capabilities","versions":[1]}]}""")
        assertNull(dupName.ack()["device"])
        listOf(plain, dup, dupName).forEach { it.disconnect() }
        s.shutdown()
    }

    @Test
    fun `no hello within the timeout closes the socket 1008`() = withScope { scope ->
        val s = server(device = { helloTimeoutMs = 150 })
        val c = Conn(s, scope)
        // Messages before hello are refused.
        c.send("""{"type":"dispatchAction","action":"query"}""")
        withTimeout(5_000) { while (c.closed == null) delay(10) }
        assertEquals(1008, c.closed!!.first)
        assertTrue(c.messages().isEmpty())
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `a UI-only session resumes by id alone, a device session only with its token`() = withScope { scope ->
        val s = server()
        // A hello without device: a UI-only session on a device-capable server.
        val ui = Conn(s, scope)
        ui.hello(device = false)
        val uiAck = ui.ack()
        val uiSid = uiAck["sessionId"]!!.jsonPrimitive.content
        assertNotNull(uiAck["resumeToken"], "a token is always issued")
        ui.awaitMessage { it.contains("\"initialTree\"") }
        ui.disconnect()
        val uiBack = Conn(s, scope)
        uiBack.hello(sessionId = uiSid) // no token: the legacy id-only resume
        val uiBackAck = uiBack.ack()
        assertEquals(uiSid, uiBackAck["sessionId"]!!.jsonPrimitive.content)
        assertEquals("true", uiBackAck["isRestored"]!!.jsonPrimitive.content)
        uiBack.awaitMessage { it.contains("\"initialTree\"") }
        uiBack.disconnect()

        // A session that negotiated a device plane needs its token.
        val dev = Conn(s, scope)
        dev.hello()
        val devAck = dev.ack()
        assertNotNull(devAck["device"])
        val devSid = devAck["sessionId"]!!.jsonPrimitive.content
        dev.awaitMessage { it.contains("\"initialTree\"") }
        dev.disconnect()
        val noToken = Conn(s, scope)
        noToken.hello(sessionId = devSid)
        assertNotEquals(devSid, noToken.ack()["sessionId"]!!.jsonPrimitive.content, "the id alone starts a new session")
        noToken.disconnect()
        val withToken = Conn(s, scope)
        withToken.hello(sessionId = devSid, token = devAck["resumeToken"]!!.jsonPrimitive.content)
        assertEquals(devSid, withToken.ack()["sessionId"]!!.jsonPrimitive.content)
        withToken.disconnect()
        s.shutdown()
    }

    @Test
    fun `resume needs the rotating resume token`() = withScope { scope ->
        val s = server()
        val first = Conn(s, scope)
        first.hello()
        val ack1 = first.ack()
        val sid = ack1["sessionId"]!!.jsonPrimitive.content
        val t1 = ack1["resumeToken"]!!.jsonPrimitive.content
        first.awaitMessage { it.contains("\"initialTree\"") }
        first.disconnect()

        // The public session id alone never resumes it.
        val wrong = Conn(s, scope)
        wrong.hello(sessionId = sid, token = "not-the-token")
        val ackWrong = wrong.ack()
        assertNotEquals(sid, ackWrong["sessionId"]!!.jsonPrimitive.content)
        assertEquals(true, ackWrong["isNew"]!!.jsonPrimitive.content.toBoolean())
        wrong.disconnect()

        val resumed = Conn(s, scope)
        resumed.hello(sessionId = sid, token = t1)
        val ack2 = resumed.ack()
        assertEquals(sid, ack2["sessionId"]!!.jsonPrimitive.content)
        assertEquals("true", ack2["isRestored"]!!.jsonPrimitive.content)
        val t2 = ack2["resumeToken"]!!.jsonPrimitive.content
        assertNotEquals(t1, t2, "rotated per ack")
        assertNotNull(ack2["device"], "a fresh device plane on the resumed connection")
        resumed.awaitMessage { it.contains("\"initialTree\"") }
        resumed.disconnect()

        // The superseded token is dead.
        val stale = Conn(s, scope)
        stale.hello(sessionId = sid, token = t1)
        assertNotEquals(sid, stale.ack()["sessionId"]!!.jsonPrimitive.content)
        stale.disconnect()
        s.shutdown()
    }

    @Test
    fun `kick-old takeover needs the token and ends the old connection's device plane`() = withScope { scope ->
        val s = server()
        val first = Conn(s, scope)
        first.client.driver("permission.request") { cancelled.await() }
        first.hello()
        val ack = first.ack()
        first.awaitMessage { it.contains("\"initialTree\"") }
        val plane = assertNotNull(s.devicePlane(first.key))
        first.send("""{"type":"dispatchAction","action":"slow"}""")
        withTimeout(5_000) { while (first.client.requests("permission.request").isEmpty()) delay(5) }

        // Without the token the live session is left alone.
        val intruder = Conn(s, scope)
        intruder.hello(sessionId = ack["sessionId"]!!.jsonPrimitive.content)
        assertNotEquals(ack["sessionId"], intruder.ack()["sessionId"])
        assertNull(first.closed)
        assertFalse(plane.isClosed)

        // With it, the new connection takes over (KICK_OLD): the old one is
        // told, closed, and its device work ends connectionLost.
        val second = Conn(s, scope)
        second.hello(sessionId = ack["sessionId"]!!.jsonPrimitive.content, token = ack["resumeToken"]!!.jsonPrimitive.content)
        assertEquals(ack["sessionId"], second.ack()["sessionId"])
        withTimeout(5_000) { while (first.closed == null) delay(5) }
        assertTrue(first.messages().any { it["type"]!!.jsonPrimitive.content == "sessionExpired" })
        assertTrue(plane.isClosed)
        listOf(first, intruder, second).forEach { it.disconnect() }
        s.shutdown()
    }

    @Test
    fun `resume tokens - constant-time verification and rotation in the session manager`() {
        val m = SessionManager()
        val a = m.createSession()
        assertFalse(m.requiresResumeToken(a.id), "a UI-only session resumes by id")
        m.markDeviceSession(a.id)
        assertTrue(m.requiresResumeToken(a.id))
        val t = m.issueResumeToken(a.id)
        assertTrue(m.verifyResumeToken(a.id, t))
        assertFalse(m.verifyResumeToken(a.id, null))
        assertFalse(m.verifyResumeToken(a.id, t.dropLast(1) + (if (t.last() == 'A') 'B' else 'A')))
        assertFalse(m.verifyResumeToken("other", t))
        val t2 = m.issueResumeToken(a.id)
        assertFalse(m.verifyResumeToken(a.id, t))
        assertTrue(m.verifyResumeToken(a.id, t2))
        m.destroySession(a.id)
        assertFalse(m.verifyResumeToken(a.id, t2))
        assertFalse(m.requiresResumeToken(a.id))
        m.shutdown()
    }

    // ---- device traffic ---------------------------------------------------------

    @Test
    fun `binary upload frames are routed to the broker and verified`() = withScope { scope ->
        val s = server()
        val c = Conn(s, scope)
        val photo = ByteArray(150_000) { (it * 7).toByte() }
        c.client.driver("gallery.pick") {
            val item = upload(0, "image/jpeg", photo)
            respond(buildJsonObject { put("items", JsonArray(listOf(item))) })
        }
        c.hello()
        c.awaitMessage { it.contains("\"initialTree\"") }
        c.send("""{"type":"dispatchAction","action":"pick"}""")
        c.awaitMessage { it.contains("pick:${photo.size}:${FakeDeviceClient.sha256(photo)}") }
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `oversize device text is a connection-level violation, never parsed`() = withScope { scope ->
        val s = server()
        val c = Conn(s, scope)
        c.hello()
        c.awaitMessage { it.contains("\"initialTree\"") }
        val plane = assertNotNull(s.devicePlane(c.key))
        val big = """{"type":"deviceEvent","id":1,"event":{"pad":"${"x".repeat(1_100_000)}"}}"""
        s.handleMessage(c.key, big) {}
        assertEquals(1L, plane.info()!!["connectionViolations"]!!.jsonPrimitive.long)
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `a client deviceRequest reusing a live id cancels it and settles invalidParams (D8)`() = withScope { scope ->
        // Shared transcript violation-request-from-client.json: only the
        // server sends deviceRequest. A well-formed client one on a live id
        // is known-id wrong-direction traffic — the broker, not the UI
        // action path, must see it.
        val s = server()
        val c = Conn(s, scope)
        val gate = kotlinx.coroutines.CompletableDeferred<Long>()
        c.client.driver("permission.query") { gate.complete(id); cancelled.await() }
        c.hello()
        c.awaitMessage { it.contains("\"initialTree\"") }
        val plane = assertNotNull(s.devicePlane(c.key))
        c.send("""{"type":"dispatchAction","action":"query"}""")
        val id = withTimeout(5_000) { gate.await() }
        assertTrue(plane.isLive(id.toUInt()))
        val request = c.client.requests("permission.query").single { it["id"]!!.jsonPrimitive.long == id }
        // Echo the server's own request back, byte-for-byte the same shape.
        c.send(request.toString())
        c.awaitMessage { it.contains("q:invalidParams") }
        withTimeout(5_000) { while (c.client.controls(id, "cancel").isEmpty()) delay(5) }
        assertEquals(1, c.client.controls(id, "cancel").size)
        assertFalse(plane.isLive(id.toUInt()))
        assertFalse(plane.isClosed)
        assertNull(c.closed)

        // A client deviceRequest for a non-live id is simply ignored
        // (unknown-ids-ignored-in-any-direction): no cancel, no settlement,
        // no close, and the live core.capabilities request is untouched.
        val core = c.client.requests("core.capabilities").single()["id"]!!.jsonPrimitive.long
        val sentBefore = c.client.receivedSnapshot().size
        c.send(
            """{"type":"deviceRequest","id":987654,"capability":"permission.query","version":1,""" +
                """"owner":{"moduleInstanceId":"x","activationId":1},"lifetime":"activation",""" +
                """"timeoutMs":30000,"initialCredit":0,"params":{"permission":"camera"}}""",
        )
        // A later round trip proves the ignored text was processed first
        // (one ordered read loop).
        val gate2 = kotlinx.coroutines.CompletableDeferred<Long>()
        c.client.driver("permission.query") { gate2.complete(this.id); respond(buildJsonObject { put("status", "granted") }) }
        c.send("""{"type":"dispatchAction","action":"query"}""")
        withTimeout(5_000) { gate2.await() }
        c.awaitMessage { it.contains("q:granted") }
        assertTrue(c.client.controls(987654, "cancel").isEmpty())
        assertTrue(c.client.receivedSnapshot().drop(sentBefore).none { it["type"]!!.jsonPrimitive.content == "deviceEvent" && it["id"]!!.jsonPrimitive.long == 987654L })
        assertTrue(plane.isLive(core.toUInt()))
        assertFalse(plane.isClosed)
        assertNull(c.closed)
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `disconnect settles live device work connectionLost`() = withScope { scope ->
        val s = server()
        val c = Conn(s, scope)
        c.client.driver("permission.request") { cancelled.await() }
        c.hello()
        c.awaitMessage { it.contains("\"initialTree\"") }
        val plane = assertNotNull(s.devicePlane(c.key))
        c.send("""{"type":"dispatchAction","action":"slow"}""")
        withTimeout(5_000) { while (c.client.requests("permission.request").isEmpty()) delay(5) }
        assertEquals(2, plane.liveCount)
        c.disconnect()
        assertTrue(plane.isClosed)
        assertNull(s.devicePlane(c.key))
        s.shutdown()
    }

    @Test
    fun `a broker-closed plane resets the socket with 1012`() = withScope { scope ->
        val s = server()
        val c = Conn(s, scope)
        c.hello()
        c.awaitMessage { it.contains("\"initialTree\"") }
        val core = c.client.requests("core.capabilities").single()["id"]!!.jsonPrimitive.long
        c.client.text(buildJsonObject { put("type", "deviceResponse"); put("id", core); put("error", buildJsonObject { put("code", "internal") }) })
        withTimeout(5_000) { while (c.closed == null) delay(10) }
        assertEquals(1012, c.closed!!.first)
        assertNull(s.devicePlane(c.key))
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `top-level member lookup keeps the exact text`() {
        val t = """{"a":{"x":[1,"}",2]} , "device" : {"k":"\"v\""},"b":1e3}"""
        assertEquals(TopLevelMember.Lookup.Found("""{"k":"\"v\""}"""), TopLevelMember.find(t, "device"))
        assertEquals(TopLevelMember.Lookup.Absent, TopLevelMember.find("""{"a":1}""", "device"))
        assertEquals(TopLevelMember.Lookup.Invalid, TopLevelMember.find("""{"device":1,"device":2}""", "device"))
        assertEquals(TopLevelMember.Lookup.Found("true"), TopLevelMember.find("""{"device":true}""", "device"))
        assertEquals(TopLevelMember.Lookup.Invalid, TopLevelMember.find("""[1]""", "device"))
        assertEquals(TopLevelMember.Lookup.Invalid, TopLevelMember.find("""{"device":{"a":1}""", "device"))
    }

    // ---- the legacy hello-less path ------------------------------------------------

    @Test
    fun `the legacy handleConnect path is unchanged on a UI-only server`() = runBlocking {
        val s = server(device = null, origins = emptyList(), auth = null)
        val sent = mutableListOf<String>()
        val key = Any()
        val tree = s.handleConnect(key) { sent += it }
        val ack = json.parseToJsonElement(sent.single()).jsonObject
        assertEquals("sessionAck", ack["type"]!!.jsonPrimitive.content)
        assertNull(ack["device"])
        assertNotNull(ack["resumeToken"], "a resume token is always issued")
        assertTrue(tree.contains("\"initialTree\""))
        assertNull(s.devicePlane(key))
        // The UI-only legacy path still resumes by session id (no device plane, no token).
        val sid = ack["sessionId"]!!.jsonPrimitive.content
        s.handleDisconnect(key)
        val again = mutableListOf<String>()
        s.handleConnect(Any()) { again += it }.also { assertTrue(it.contains("\"initialTree\"")) }
        val key2 = Any()
        val resumed = mutableListOf<String>()
        s.handleConnect(key2, sid) { resumed += it }
        assertEquals(sid, json.parseToJsonElement(resumed.single()).jsonObject["sessionId"]!!.jsonPrimitive.content)
        s.shutdown()
    }

    @Test
    fun `handleConnect works on the default server - its sessions have no device plane`() = runBlocking {
        val s = server()
        assertTrue(s.deviceEnabled)
        val sent = mutableListOf<String>()
        val key = Any()
        val tree = s.handleConnect(key) { sent += it }
        val ack = json.parseToJsonElement(sent.single()).jsonObject
        assertNull(ack["device"])
        assertNotNull(ack["resumeToken"])
        assertTrue(tree.contains("\"initialTree\""))
        assertNull(s.devicePlane(key))
        // A UI-only session: the legacy path resumes it by id.
        val sid = ack["sessionId"]!!.jsonPrimitive.content
        s.handleDisconnect(key)
        val resumed = mutableListOf<String>()
        s.handleConnect(Any(), sid) { resumed += it }
        assertEquals(sid, json.parseToJsonElement(resumed.single()).jsonObject["sessionId"]!!.jsonPrimitive.content)
        s.shutdown()
    }

    @Test
    fun `handleConnect never resumes a device session by its public id`() = withScope { scope ->
        val s = server()
        val first = Conn(s, scope)
        first.hello()
        val ack = first.ack()
        assertNotNull(ack["device"])
        val sid = ack["sessionId"]!!.jsonPrimitive.content
        val token = ack["resumeToken"]!!.jsonPrimitive.content
        first.awaitMessage { it.contains("\"initialTree\"") }
        first.disconnect()

        // Probe: the hello-less path with only the public session id gets a
        // NEW session, and the pending device session is not consumed.
        val sent = mutableListOf<String>()
        val legacyKey = Any()
        s.handleConnect(legacyKey, sid) { sent += it }
        val legacyAck = json.parseToJsonElement(sent.single()).jsonObject
        assertNotEquals(sid, legacyAck["sessionId"]!!.jsonPrimitive.content)
        assertEquals("true", legacyAck["isNew"]!!.jsonPrimitive.content)
        assertNull(s.devicePlane(legacyKey))
        assertEquals(1, s.getStats()["pendingSessions"], "the disconnected device session is still pending: ${s.getStats()}")
        s.handleDisconnect(legacyKey)

        // The token holder still resumes it.
        val resumed = Conn(s, scope)
        resumed.hello(sessionId = sid, token = token)
        val ack2 = resumed.ack()
        assertEquals(sid, ack2["sessionId"]!!.jsonPrimitive.content)
        assertEquals("true", ack2["isRestored"]!!.jsonPrimitive.content)
        resumed.awaitMessage { it.contains("\"initialTree\"") }
        resumed.disconnect()
        s.shutdown()
    }

    @Test
    fun `handleConnect never takes over a live device connection under kick-old`() = withScope { scope ->
        val s = server()
        val victim = Conn(s, scope)
        victim.client.driver("permission.query") { respond(buildJsonObject { put("status", "granted") }) }
        victim.hello()
        val sid = victim.ack()["sessionId"]!!.jsonPrimitive.content
        victim.awaitMessage { it.contains("\"initialTree\"") }
        val plane = assertNotNull(s.devicePlane(victim.key))

        val sent = mutableListOf<String>()
        val legacyKey = Any()
        s.handleConnect(legacyKey, sid) { sent += it }
        assertNotEquals(sid, json.parseToJsonElement(sent.single()).jsonObject["sessionId"]!!.jsonPrimitive.content)
        delay(200)
        assertNull(victim.closed, "the live connection is not closed")
        assertFalse(plane.isClosed, "its device plane is untouched")
        assertTrue(victim.messages().none { it["type"]!!.jsonPrimitive.content == "sessionExpired" })
        // ... and it keeps working.
        victim.send("""{"type":"dispatchAction","action":"query"}""")
        victim.awaitMessage { it.contains("q:granted") }
        victim.disconnect()
        s.handleDisconnect(legacyKey)
        s.shutdown()
    }

    // ---- host-side JSON limits ----------------------------------------------------

    @Test
    fun `nesting depth scan is iterative and ignores brackets inside strings`() {
        assertFalse(JsonNesting.exceeds("""{"a":[1,{"b":[]}]}""", 4))
        assertTrue(JsonNesting.exceeds("""{"a":[1,{"b":[]}]}""", 3))
        assertTrue(JsonNesting.exceeds("[[[[]]]]", 3))
        assertFalse(JsonNesting.exceeds("[[[]]]", 3))
        assertFalse(JsonNesting.exceeds(""""[[[[[[\"[[[[" """, 1))
        assertFalse(JsonNesting.exceeds("""{"k":"\\"}""", 1), "an escaped backslash ends before the quote")
        assertTrue(JsonNesting.exceeds("""{"k":"\\",[[]]}""", 2))
        assertTrue(JsonNesting.exceeds("[".repeat(1_000_000), JsonNesting.MAX_HOST_PARSE_DEPTH))
        assertFalse(JsonNesting.exceeds("[".repeat(256) + "]".repeat(256), JsonNesting.MAX_HOST_PARSE_DEPTH))
        assertTrue(JsonNesting.exceeds("[".repeat(257) + "]".repeat(257), JsonNesting.MAX_HOST_PARSE_DEPTH))
    }

    @Test
    fun `a deeply nested device message is a counted connection-level violation, never a host crash`() = withScope { scope ->
        val s = server()
        val c = Conn(s, scope)
        c.hello()
        c.awaitMessage { it.contains("\"initialTree\"") }
        val plane = assertNotNull(s.devicePlane(c.key))
        fun violations() = plane.info()!!["connectionViolations"]!!.jsonPrimitive.long

        // ~400 KB, 200,000 levels deep: under the 1 MiB size limit, far past
        // what a recursive parser survives.
        val n = 200_000
        val deep = """{"type":"deviceEvent","id":999,"event":""" + "[".repeat(n) + "]".repeat(n) + "}"
        assertTrue(deep.length < 1_048_576)
        s.handleMessage(c.key, deep) {}
        assertEquals(1L, violations())
        assertFalse(plane.isClosed)

        // Depth 33 (envelope = 1) is under the host parser's bound but over
        // the device limit (D4): the broker's strict decoder counts it.
        val d33 = """{"type":"deviceResponse","id":998,"result":""" + "[".repeat(32) + "]".repeat(32) + "}"
        s.handleMessage(c.key, d33) {}
        assertEquals(2L, violations())

        // A deep deviceResponse for the LIVE core.capabilities id is still
        // judged by the broker (never thrown to the host).
        val core = c.client.requests("core.capabilities").single()["id"]!!.jsonPrimitive.long
        val deepKnown = """{"type":"deviceEvent","id":$core,"event":""" + "{\"a\":".repeat(n) + "1" + "}".repeat(n) + "}"
        s.handleMessage(c.key, deepKnown) {}
        assertTrue(violations() >= 2L)

        // A deep UI message (not device-typed, even when a string inside it
        // looks like one) is dropped without a device violation.
        val before = violations()
        val deepUi = """{"type":"dispatchAction","action":"query","payload":{"s":"\"type\":\"deviceEvent\"","x":""" +
            "[".repeat(n) + "]".repeat(n) + "}}"
        s.handleMessage(c.key, deepUi) {}
        assertEquals(before, violations())
        // A type member that is not a string never throws either.
        s.handleMessage(c.key, """{"type":{"nested":true}}""") {}
        s.handleMessage(c.key, """{"type":"dispatchAction","action":{"x":1}}""") {}
        s.handleMessage(c.key, """{"type":"navigate","path":[1]}""") {}

        // The connection is still fully usable afterwards.
        c.client.driver("permission.query") { respond(buildJsonObject { put("status", "prompt") }) }
        c.send("""{"type":"dispatchAction","action":"query"}""")
        c.awaitMessage { it.contains("q:prompt") }
        assertNull(c.closed)
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `a deeply nested hello before the device plane exists is dropped without a crash`() = withScope { scope ->
        val s = server()
        val c = Conn(s, scope)
        val n = 200_000
        val deepHello = """{"type":"hello","props":{"x":""" + "[".repeat(n) + "]".repeat(n) + "}," +
            "\"device\":${DevicePlaneTest.HELLO}}"
        s.handleMessage(c.key, deepHello) {}
        assertTrue(c.messages().isEmpty(), "no session from an unparseable hello")
        assertNull(s.devicePlane(c.key))
        // A deep device-typed text before the plane exists is dropped too.
        s.handleMessage(c.key, """{"type":"deviceEvent","id":1,"event":""" + "[".repeat(n) + "]".repeat(n) + "}") {}
        // The real hello still establishes the session and the plane.
        c.hello()
        val ack = c.ack()
        assertNotNull(ack["device"])
        c.awaitMessage { it.contains("\"initialTree\"") }
        assertNotNull(s.devicePlane(c.key))
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `deeply nested texts never crash the legacy UI-only path`() = runBlocking {
        val s = server(device = null, origins = emptyList(), auth = null)
        val key = Any()
        val sent = mutableListOf<String>()
        s.handleConnect(key) { sent += it }
        val n = 200_000
        s.handleMessage(key, """{"type":"dispatchAction","action":"query","payload":""" + "[".repeat(n) + "]".repeat(n) + "}") { sent += it }
        s.handleMessage(key, """{"type":"deviceEvent","id":1,"event":""" + "{\"a\":".repeat(n) + "1" + "}".repeat(n) + "}") { sent += it }
        s.handleMessage(key, """{"type":{"nested":true}}""") { sent += it }
        assertEquals(1, sent.size, "only the original sessionAck")
        s.handleDisconnect(key)
        s.shutdown()
    }

    @Test
    fun `async state changes outside a dispatch are flushed with increasing revisions`() = withScope { scope ->
        val s = server()
        val c = Conn(s, scope)
        c.client.driver("permission.query") {
            delay(50)
            respond(buildJsonObject { put("status", "denied") })
        }
        c.hello()
        c.awaitMessage { it.contains("\"initialTree\"") }
        c.send("""{"type":"dispatchAction","action":"query"}""")
        c.awaitMessage { it.contains("q:denied") }
        val revisions = c.messages().filter { it["type"]!!.jsonPrimitive.content == "patch" }.map { it["revision"]!!.jsonPrimitive.long }
        assertEquals(revisions.sorted(), revisions)
        assertEquals(revisions.distinct(), revisions)
        assertTrue(revisions.isNotEmpty())
        c.disconnect()
        s.shutdown()
    }

    @Test
    fun `a device connection's UI frames decode on every client, and malformed device texts never stop UI updates`() = withScope { scope ->
        val s = server()
        val c = Conn(s, scope)
        c.client.driver("permission.query") { respond(buildJsonObject { put("status", "granted") }) }
        c.hello()
        c.awaitMessage { it.contains("\"initialTree\"") }
        // Malformed / wrong-direction device traffic from the client: the
        // broker judges it (counted violations below the close threshold),
        // and it never reaches — or breaks — the UI path.
        c.send("""{"type":"deviceResponse","id":1.0,"result":{}}""")
        c.send("""{"type":"deviceEvent","id":999,"event":{"kind":"progress","state":"running"}}""")
        c.send("""{"type":"deviceEvent",""")
        c.send("""{"type":"dispatchAction","action":"__hypen_dispatch","payload":{"node":"999999","action":"query"}}""")
        c.send("""{"type":"dispatchAction","action":"query"}""")
        c.awaitMessage { it.contains("q:granted") }
        assertNull(c.closed)
        RemoteWireConformanceTest.ClientDecoder.assertDecodes(synchronized(c.out) { c.out.toList() })
        val patches = c.messages().filter { it["type"]!!.jsonPrimitive.content == "patch" }
        assertTrue(patches.isNotEmpty())
        assertTrue(patches.all { it["module"]!!.jsonPrimitive.content == "App" })
        c.disconnect()
        s.shutdown()
    }
}
