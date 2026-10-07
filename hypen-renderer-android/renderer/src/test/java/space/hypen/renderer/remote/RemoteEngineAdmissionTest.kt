package space.hypen.renderer.remote

import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import okio.ByteString.Companion.toByteString
import space.hypen.renderer.device.ConsentDecision
import space.hypen.renderer.device.ConsentPresenter
import space.hypen.renderer.device.DeviceDriver
import space.hypen.renderer.device.DeviceFrames
import space.hypen.renderer.device.DeviceHost
import space.hypen.renderer.device.DeviceHostConfig
import space.hypen.renderer.device.DriverContext
import space.hypen.renderer.device.DriverOutcome
import space.hypen.renderer.device.FileSaveDriver
import space.hypen.renderer.device.FileSavePlatform
import space.hypen.renderer.device.FrameHeader
import space.hypen.renderer.device.SaveTarget
import space.hypen.renderer.device.normalizeOrigin
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Connection admission (RFC 001 §5, decision D1) and device-plane binding
 * of [RemoteEngine] over a real socket (OkHttp MockWebServer): app
 * credentials as upgrade headers, no `Origin` unless configured, a disposed
 * host runs UI-only, and each socket's device connection is bound to the
 * origin of the URL it talks to.
 */
class RemoteEngineAdmissionTest {
    private lateinit var server: MockWebServer
    private val received = LinkedBlockingQueue<Map<String, Any?>>()
    private val executor = Executors.newSingleThreadExecutor()
    private val dispatcher = executor.asCoroutineDispatcher()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
        executor.shutdownNow()
    }

    private val url get() = server.url("/").toString().replace("http", "ws")

    /** Upgrade once; after the hello, send [afterHello] (JSON texts). Every client text is queued. */
    private fun enqueueSocket(vararg afterHello: String) {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(code, null)
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        @Suppress("UNCHECKED_CAST")
                        val msg = StrictDeviceJson.parse(text) as Map<String, Any?>
                        received.put(msg)
                        if (msg["type"] == "hello") afterHello.forEach { webSocket.send(it) }
                    }
                },
            ),
        )
    }

    private fun next(): Map<String, Any?> = received.poll(10, TimeUnit.SECONDS) ?: error("nothing received")

    private fun upgrade(): RecordedRequest = server.takeRequest(10, TimeUnit.SECONDS) ?: error("no upgrade")

    @Test
    fun `a native client sends no Origin by default`() = runBlocking {
        enqueueSocket()
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false))
        engine.connect()
        val request = upgrade()
        assertNull(request.getHeader("Origin"))
        assertNull(request.getHeader("Authorization"))
        assertEquals("hello", next()["type"])
        engine.destroy()
    }

    @Test
    fun `app credentials and an optional Origin are sent on every upgrade`() = runBlocking {
        enqueueSocket()
        enqueueSocket()
        val n = AtomicInteger()
        val config = RemoteEngineConfig(
            autoReconnect = false,
            headers = mapOf("Authorization" to "Bearer static", "X-App" to "gallery"),
            headersProvider = { mapOf("authorization" to "Bearer rotated-${n.incrementAndGet()}") },
            origin = "https://app.example",
        )
        val engine = RemoteEngine(url, config)
        engine.connect()
        val first = upgrade()
        assertEquals("Bearer rotated-1", first.getHeader("Authorization"))
        assertEquals(1, first.headers.values("Authorization").size) // the provider replaces, never duplicates
        assertEquals("gallery", first.getHeader("X-App"))
        assertEquals("https://app.example", first.getHeader("Origin"))
        next()
        engine.disconnect()
        engine.connect()
        assertEquals("Bearer rotated-2", upgrade().getHeader("Authorization"))
        engine.destroy()
    }

    @Test
    fun `upgrade-managed headers are refused and credentials never print`() {
        for (name in listOf("Origin", "origin", "Host", "Upgrade", "Connection", "Sec-WebSocket-Key", "sec-websocket-extensions")) {
            val e = runCatching { RemoteEngineConfig(headers = mapOf(name to "x")) }.exceptionOrNull()
            assertTrue(name, e is IllegalArgumentException)
        }
        val provided = RemoteEngineConfig(headersProvider = { mapOf("Origin" to "x") })
        assertTrue(runCatching { provided.upgradeHeaders() }.exceptionOrNull() is IllegalArgumentException)
        val config = RemoteEngineConfig(headers = mapOf("Authorization" to "Bearer secret-token"))
        assertFalse(config.toString(), config.toString().contains("secret-token"))
        assertTrue(config.toString().contains("Authorization"))
    }

    @Test
    fun `a disposed device host runs UI-only, a live one advertises`() = runBlocking {
        enqueueSocket()
        enqueueSocket()
        val disposed = DeviceHost(DeviceHostConfig("wss://a:443"), emptyList(), dispatcher)
        disposed.dispose()
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false), deviceHost = disposed)
        engine.connect()
        upgrade()
        val hello = next()
        assertEquals("hello", hello["type"])
        assertFalse(hello.containsKey("device"))
        engine.destroy()

        val live = DeviceHost(DeviceHostConfig("wss://a:443"), emptyList(), dispatcher)
        val engine2 = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false), deviceHost = live)
        engine2.connect()
        upgrade()
        assertNotNull(next()["device"])
        engine2.destroy()
        live.dispose()
    }

    @Test
    fun `each socket's device connection is bound to the origin of its URL, not the host default`() = runBlocking {
        val origins = LinkedBlockingQueue<String>()
        val recorder = object : DeviceDriver {
            override val capability = "permission.query"

            override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

            override suspend fun run(ctx: DriverContext): DriverOutcome {
                origins.put(ctx.origin)
                return DriverOutcome.Result(mapOf("status" to "prompt"))
            }
        }
        val ack = """{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false,"device":{"protocolVersion":1,"binary":true,""" +
            """"capabilities":[{"name":"core.capabilities","version":1},{"name":"permission.query","version":1}]}}"""
        val core = """{"type":"deviceRequest","id":1,"capability":"core.capabilities","version":1,"owner":{"connection":true},""" +
            """"lifetime":"connection","timeoutMs":86400000,"initialCredit":8,"params":{}}"""
        val query = """{"type":"deviceRequest","id":2,"capability":"permission.query","version":1,""" +
            """"owner":{"moduleInstanceId":"m","activationId":1},"lifetime":"activation","timeoutMs":30000,"initialCredit":0,"params":{"permission":"camera"}}"""
        enqueueSocket(ack, core, query)
        val host = DeviceHost(DeviceHostConfig("wss://configured.example:443"), listOf(recorder), dispatcher)
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false), deviceHost = host)
        engine.connect()
        upgrade()
        assertNotNull(next()["device"]) // the hello
        assertEquals(normalizeOrigin(url), origins.poll(10, TimeUnit.SECONDS))
        var response: Map<String, Any?>
        do {
            response = next()
        } while (response["type"] != "deviceResponse")
        assertEquals(mapOf("status" to "prompt"), response["result"])
        engine.destroy()
        host.dispose()
    }

    @Test
    fun `file save download frames travel the real socket to the host and are written in order`() = runBlocking {
        val data = ByteArray(300_000) { (it * 13 + 1).toByte() }
        val sha = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
        val written = ByteArrayOutputStream()
        val committed = CountDownLatch(1)
        val platform = object : FileSavePlatform {
            override fun canPresent() = true

            override suspend fun createDocument(name: String, contentType: String, presenterGone: () -> Unit): SaveTarget = object : SaveTarget {
                override suspend fun write(bytes: ByteArray) {
                    written.write(bytes)
                }

                override suspend fun commit() = committed.countDown()

                override suspend fun discard() = Unit
            }
        }
        val ack = """{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false,"device":{"protocolVersion":1,"binary":true,""" +
            """"capabilities":[{"name":"core.capabilities","version":1},{"name":"file.save","version":1}]}}"""
        val core = """{"type":"deviceRequest","id":1,"capability":"core.capabilities","version":1,"owner":{"connection":true},""" +
            """"lifetime":"connection","timeoutMs":86400000,"initialCredit":8,"params":{}}"""
        val save = """{"type":"deviceRequest","id":2,"capability":"file.save","version":1,"owner":{"moduleInstanceId":"m","activationId":1},""" +
            """"lifetime":"activation","timeoutMs":300000,"initialCredit":0,"params":{"channel":0,"name":"a.bin",""" +
            """"contentType":"application/octet-stream","bytes":${data.size},"sha256":"$sha"}}"""
        val grants = LinkedBlockingQueue<Long>()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    var sent = 0
                    var seq = 0L
                    var credit = 0L

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(code, null)
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        @Suppress("UNCHECKED_CAST")
                        val msg = StrictDeviceJson.parse(text) as Map<String, Any?>
                        received.put(msg)
                        if (msg["type"] == "hello") listOf(ack, core, save).forEach { webSocket.send(it) }
                        val grant = (msg["control"] as? Map<*, *>)?.get("grant") as Long? ?: return
                        grants.put(grant)
                        credit += grant
                        // The server sends only within the credit the client granted.
                        while (credit > 0 && sent < data.size) {
                            val n = minOf(64 * 1024L, credit, (data.size - sent).toLong()).toInt()
                            webSocket.send(DeviceFrames.encode(FrameHeader(channel = 0, requestId = 2, seq = seq++), data, sent, n).toByteString())
                            sent += n
                            credit -= n
                        }
                    }
                },
            ),
        )
        val host = DeviceHost(
            DeviceHostConfig("wss://configured.example:443"),
            listOf(FileSaveDriver(platform)),
            dispatcher,
            consent = ConsentPresenter { ConsentDecision.CONTINUE },
        )
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false), deviceHost = host)
        engine.connect()
        upgrade()
        var response: Map<String, Any?>
        do {
            response = next()
        } while (response["type"] != "deviceResponse")
        assertEquals(mapOf("bytesWritten" to data.size.toLong()), response["result"])
        assertTrue(committed.await(10, TimeUnit.SECONDS))
        assertTrue(written.toByteArray().contentEquals(data))
        // The first window is 256 KiB, then replenished as bytes were written, never past the declaration.
        val all = generateSequence { grants.poll() }.toList()
        assertEquals(FileSaveDriver.MAX_WINDOW, all.first())
        assertEquals(data.size.toLong(), all.sum())
        engine.destroy()
        host.dispose()
    }
}
