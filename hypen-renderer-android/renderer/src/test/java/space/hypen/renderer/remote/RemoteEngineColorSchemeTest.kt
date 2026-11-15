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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import space.hypen.renderer.model.ColorSchemeMessage
import space.hypen.renderer.model.HelloMessage
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The system color scheme report: `hello.colorScheme` and the `colorScheme`
 * message (their exact wire shape), and [RemoteEngine.setColorScheme] over a
 * real socket (OkHttp MockWebServer) — a change is sent once, an unchanged
 * value sends nothing, and the value is carried by the hello of a reconnect.
 */
class RemoteEngineColorSchemeTest {
    private val parser = MoshiMessageParser()

    @Test
    fun `hello without a color scheme omits the field`() {
        val json = parser.serializeMessage(HelloMessage(sessionId = "s1"))
        assertFalse(json.contains("colorScheme"))
    }

    @Test
    fun `hello carries the color scheme`() {
        val json = parser.serializeMessage(HelloMessage(colorScheme = HypenColorScheme.DARK.wireName))
        assertEquals("""{"type":"hello","colorScheme":"dark"}""", json)
    }

    @Test
    fun `serializes the documented colorScheme message`() {
        assertEquals(
            """{"type":"colorScheme","scheme":"light"}""",
            parser.serializeMessage(ColorSchemeMessage(scheme = HypenColorScheme.LIGHT.wireName)),
        )
        assertEquals(
            """{"type":"colorScheme","scheme":"dark"}""",
            parser.serializeMessage(ColorSchemeMessage(scheme = HypenColorScheme.DARK.wireName)),
        )
    }

    @Test
    fun `uiMode night bits map to a scheme`() {
        // Configuration.UI_MODE_NIGHT_YES = 0x20, UI_MODE_NIGHT_NO = 0x10, UI_MODE_TYPE_NORMAL = 0x01.
        assertEquals(HypenColorScheme.DARK, HypenColorScheme.fromUiMode(0x20 or 0x01))
        assertEquals(HypenColorScheme.LIGHT, HypenColorScheme.fromUiMode(0x10 or 0x01))
        assertEquals(HypenColorScheme.LIGHT, HypenColorScheme.fromUiMode(0x01))
    }

    @Test
    fun `the reporting option names its fixed scheme`() {
        assertNull(ColorSchemeReporting.AUTO.fixedScheme)
        assertNull(ColorSchemeReporting.OFF.fixedScheme)
        assertEquals(HypenColorScheme.LIGHT, ColorSchemeReporting.LIGHT.fixedScheme)
        assertEquals(HypenColorScheme.DARK, ColorSchemeReporting.DARK.fixedScheme)
        assertEquals(ColorSchemeReporting.AUTO, RemoteEngineConfig.DEFAULT.colorScheme)
    }

    // ---- over a socket

    private lateinit var server: MockWebServer
    private val hellos = LinkedBlockingQueue<Map<String, Any?>>()
    private val others = LinkedBlockingQueue<Map<String, Any?>>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    /** Upgrade once; hellos are acknowledged and recorded, everything else lands in [others]. */
    private fun enqueueSocket() {
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
                            webSocket.send("""{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false}""")
                        } else {
                            others.put(msg)
                        }
                    }
                },
            ),
        )
    }

    private fun nextHello(): Map<String, Any?> = hellos.poll(10, TimeUnit.SECONDS) ?: error("no hello received")

    private fun engine(reporting: ColorSchemeReporting = ColorSchemeReporting.AUTO) = RemoteEngine(
        url = server.url("/").toString().replace("http", "ws"),
        // Reconnects are driven explicitly (disconnect + connect) for determinism.
        config = RemoteEngineConfig(autoReconnect = false, colorScheme = reporting),
    )

    @Test
    fun `an engine that was told nothing reports nothing`() = runBlocking {
        enqueueSocket()
        val engine = engine()
        assertNull(engine.colorScheme)
        engine.connect()
        assertFalse(nextHello().containsKey("colorScheme"))
        engine.destroy()
    }

    @Test
    fun `a fixed option is reported in the hello`() = runBlocking {
        enqueueSocket()
        val engine = engine(ColorSchemeReporting.DARK)
        assertEquals(HypenColorScheme.DARK, engine.colorScheme)
        engine.connect()
        assertEquals("dark", nextHello()["colorScheme"])
        engine.destroy()
    }

    @Test
    fun `a scheme set before connecting travels in the hello only`() = runBlocking {
        enqueueSocket()
        val engine = engine()
        engine.setColorScheme(HypenColorScheme.DARK)
        engine.connect()
        assertEquals("dark", nextHello()["colorScheme"])
        withTimeout(10_000) { engine.sessionEstablished.first() }
        assertNull(others.poll(200, TimeUnit.MILLISECONDS))
        engine.destroy()
    }

    @Test
    fun `a change while connected is sent once and remembered for the next hello`() = runBlocking {
        enqueueSocket()
        enqueueSocket()
        val engine = engine(ColorSchemeReporting.LIGHT)
        engine.connect()
        assertEquals("light", nextHello()["colorScheme"])
        withTimeout(10_000) { engine.sessionEstablished.first() }

        // Unchanged: nothing on the wire.
        engine.setColorScheme(HypenColorScheme.LIGHT)
        assertNull(others.poll(200, TimeUnit.MILLISECONDS))

        engine.setColorScheme(HypenColorScheme.DARK)
        val msg = others.poll(10, TimeUnit.SECONDS) ?: error("no colorScheme received")
        assertEquals(mapOf<String, Any?>("type" to "colorScheme", "scheme" to "dark"), msg)

        // The same value again: nothing more.
        engine.setColorScheme(HypenColorScheme.DARK)
        assertNull(others.poll(200, TimeUnit.MILLISECONDS))
        assertEquals(HypenColorScheme.DARK, engine.colorScheme)

        // A new socket: the hello carries the remembered value, no extra message.
        engine.disconnect()
        engine.connect()
        assertEquals("dark", nextHello()["colorScheme"])
        assertNull(others.poll(200, TimeUnit.MILLISECONDS))
        engine.destroy()
    }
}
