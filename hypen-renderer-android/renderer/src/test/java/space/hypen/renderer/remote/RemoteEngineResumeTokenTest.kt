package space.hypen.renderer.remote

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * RFC 001 §5 resume credential over a real socket (OkHttp MockWebServer):
 * the client stores `sessionAck.resumeToken` and sends it as
 * `hello.resumeToken` whenever it resumes that session id.
 */
class RemoteEngineResumeTokenTest {
    private lateinit var server: MockWebServer
    private val hellos = LinkedBlockingQueue<Map<String, Any?>>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    /** Upgrade once; the server answers the hello with [reply] (a JSON sessionAck/sessionExpired). */
    private fun enqueueSocket(vararg replies: String) {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(code, null)
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        @Suppress("UNCHECKED_CAST")
                        val msg = StrictDeviceJson.parse(text) as Map<String, Any?>
                        if (msg["type"] == "hello") {
                            hellos.put(msg)
                            replies.forEach { webSocket.send(it) }
                        }
                    }
                },
            ),
        )
    }

    private fun ack(sessionId: String, token: String?) =
        """{"type":"sessionAck","sessionId":"$sessionId","isNew":true,"isRestored":false${if (token != null) ""","resumeToken":"$token"""" else ""}}"""

    private fun nextHello(): Map<String, Any?> = hellos.poll(10, TimeUnit.SECONDS) ?: error("no hello received")

    private fun engine(options: SessionOptions? = null) = RemoteEngine(
        url = server.url("/").toString().replace("http", "ws"),
        // Reconnects are driven explicitly (disconnect + connect) for determinism.
        config = RemoteEngineConfig(autoReconnect = false),
        sessionOptions = options,
    )

    @Test
    fun `the latest resume token is sent when the session is resumed after a reconnect`() = runBlocking {
        enqueueSocket(ack("s1", "tok-1"))
        enqueueSocket(ack("s1", "tok-2"))
        enqueueSocket()
        val engine = engine()
        engine.connect()
        val first = nextHello()
        assertNull(first["sessionId"])
        assertFalse(first.containsKey("resumeToken"))
        val info = withTimeout(10_000) { engine.sessionEstablished.first() }
        assertEquals("tok-1", info.resumeToken)

        // A new socket resumes s1 with tok-1.
        engine.disconnect()
        engine.connect()
        val second = nextHello()
        assertEquals("s1", second["sessionId"])
        assertEquals("tok-1", second["resumeToken"])

        // The rotated token replaces the old one.
        withTimeout(10_000) { engine.sessionEstablished.first { it.resumeToken == "tok-2" } }
        engine.disconnect()
        engine.connect()
        val third = nextHello()
        assertEquals("s1", third["sessionId"])
        assertEquals("tok-2", third["resumeToken"])
        engine.destroy()
    }

    @Test
    fun `a stored token is sent with its session id only, and cleared on sessionExpired`() = runBlocking {
        enqueueSocket("""{"type":"sessionExpired","sessionId":"saved","reason":"ttl"}""")
        enqueueSocket()
        val engine = engine(SessionOptions(id = "saved", resumeToken = "persisted"))
        engine.connect()
        val first = nextHello()
        assertEquals("saved", first["sessionId"])
        assertEquals("persisted", first["resumeToken"])
        val deadline = System.currentTimeMillis() + 10_000
        while (engine.getSessionId() != null && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertNull(engine.getSessionId())
        engine.disconnect()
        engine.connect()
        // The configured id is still offered (legacy behaviour, as in the TS
        // client), but the expired credential is gone: the server starts a
        // new session instead of resuming.
        val second = nextHello()
        assertEquals("saved", second["sessionId"])
        assertFalse(second.containsKey("resumeToken"))
        engine.destroy()

        // A token without a session id is never sent.
        enqueueSocket()
        val orphan = engine(SessionOptions(resumeToken = "orphan"))
        orphan.connect()
        val hello = nextHello()
        assertNotNull(hello)
        assertFalse(hello.containsKey("resumeToken"))
        orphan.destroy()
    }
}
