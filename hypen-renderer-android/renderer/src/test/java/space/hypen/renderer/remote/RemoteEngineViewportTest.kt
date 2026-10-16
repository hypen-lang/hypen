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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import space.hypen.renderer.model.ViewportMessage
import space.hypen.renderer.render.ComposeRenderer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The remote `viewport` message (hypen-web/docs/virtualization.md §4): its
 * exact wire shape, and that [RemoteEngine.setListViewport] sends it over a
 * real socket once connected (and drops it before).
 */
class RemoteEngineViewportTest {
    private val parser = MoshiMessageParser()

    @Test
    fun `serializes the documented wire shape`() {
        val json = parser.serializeMessage(ViewportMessage(listId = "4294967301", start = 40, end = 70))
        assertEquals("""{"type":"viewport","listId":"4294967301","start":40,"end":70}""", json)
    }

    @Test
    fun `clamps a range to non-negative start le end`() {
        assertEquals(ViewportMessage(listId = "1", start = 0, end = 5), viewportMessage("1", -3, 5))
        assertEquals(ViewportMessage(listId = "1", start = 9, end = 9), viewportMessage("1", 9, 4))
    }

    @Test
    fun `the renderer routes reports to its reporter`() {
        val renderer = ComposeRenderer()
        val seen = mutableListOf<Triple<String, Int, Int>>()
        renderer.reportViewport("7", 0, 10) // no reporter: a no-op
        renderer.setViewportReporter { id, s, e -> seen.add(Triple(id, s, e)) }
        renderer.reportViewport("7", 20, 60)
        assertEquals(listOf(Triple("7", 20, 60)), seen)
    }

    // ---- over a socket

    private lateinit var server: MockWebServer
    private val received = LinkedBlockingQueue<Map<String, Any?>>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `setListViewport sends a viewport message once connected`() = runBlocking {
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
                            webSocket.send("""{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false}""")
                        } else {
                            received.put(msg)
                        }
                    }
                },
            ),
        )
        val engine = RemoteEngine(
            url = server.url("/").toString().replace("http", "ws"),
            config = RemoteEngineConfig(autoReconnect = false),
        )
        // Not connected yet: dropped, nothing on the wire.
        engine.setListViewport("4294967301", 1, 2)
        engine.connect()
        withTimeout(10_000) { engine.connectionState.first { it == ConnectionState.CONNECTED } }
        engine.setListViewport("4294967301", 40, 70)
        val msg = received.poll(10, TimeUnit.SECONDS) ?: error("no viewport received")
        assertEquals("viewport", msg["type"])
        assertEquals("4294967301", msg["listId"])
        assertEquals(40.0, (msg["start"] as Number).toDouble(), 0.0)
        assertEquals(70.0, (msg["end"] as Number).toDouble(), 0.0)
        assertNull(received.poll(200, TimeUnit.MILLISECONDS))
        engine.destroy()
    }
}
