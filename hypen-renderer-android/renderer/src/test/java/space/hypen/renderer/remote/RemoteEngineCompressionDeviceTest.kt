package space.hypen.renderer.remote

import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import space.hypen.renderer.HypenLogHandler
import space.hypen.renderer.HypenLogLevel
import space.hypen.renderer.HypenLogger
import space.hypen.renderer.device.AudioCaptureFormat
import space.hypen.renderer.device.AudioCapturePlatform
import space.hypen.renderer.device.AudioSink
import space.hypen.renderer.device.CaptureHandle
import space.hypen.renderer.device.DeviceHost
import space.hypen.renderer.device.DeviceHostConfig
import space.hypen.renderer.device.FakeIndicator
import space.hypen.renderer.device.FakePermissions
import space.hypen.renderer.device.MicRecordDriver
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The device plane on a compressed socket: allowed only when the negotiated
 * permessage-deflate carries BOTH `server_no_context_takeover` and
 * `client_no_context_takeover` (each message compressed on its own, so
 * device data never shares a compression history). With context takeover in
 * either direction the hello omits `device`, the socket runs UI-only, and
 * one warning is logged.
 */
class RemoteEngineCompressionDeviceTest {
    // ---- the decision ----------------------------------------------------------

    @Test
    fun `no compression negotiated allows the device plane`() {
        assertTrue(PerMessageDeflate.allowsDevice(emptyList()))
        assertTrue(PerMessageDeflate.allowsDevice(listOf("")))
        assertTrue(PerMessageDeflate.allowsDevice(listOf("x-webkit-deflate-frame")))
    }

    @Test
    fun `both no-context-takeover params allow the device plane`() {
        for (negotiated in listOf(
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover",
            "permessage-deflate;client_no_context_takeover;server_no_context_takeover",
            "PERMESSAGE-DEFLATE; Server_No_Context_Takeover; client_no_context_takeover; server_max_window_bits=15",
            "permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=\"15\"",
        )) {
            assertTrue(negotiated, PerMessageDeflate.allowsDevice(listOf(negotiated)))
        }
    }

    @Test
    fun `context takeover in either direction refuses the device plane`() {
        for (negotiated in listOf(
            "permessage-deflate",
            "permessage-deflate; server_no_context_takeover",
            "permessage-deflate; client_no_context_takeover",
            "permessage-deflate; server_max_window_bits=15",
            // Parameter NAMES must match exactly (not a substring or a value).
            "permessage-deflate; server_no_context_takeover_x; client_no_context_takeover",
            "permessage-deflate; x=\"server_no_context_takeover; client_no_context_takeover\"",
            // Another element can't vouch for the permessage-deflate one.
            "permessage-deflate, foo; server_no_context_takeover; client_no_context_takeover",
        )) {
            assertFalse(negotiated, PerMessageDeflate.allowsDevice(listOf(negotiated)))
        }
        // Split across two header lines.
        assertFalse(
            PerMessageDeflate.allowsDevice(listOf("foo; server_no_context_takeover; client_no_context_takeover", "permessage-deflate")),
        )
    }

    // ---- over a real socket ---------------------------------------------------

    private lateinit var server: MockWebServer
    private val hellos = LinkedBlockingQueue<String>()
    private val executor = Executors.newSingleThreadExecutor()
    private val dispatcher = executor.asCoroutineDispatcher()
    private val warnings: MutableList<String> = Collections.synchronizedList(mutableListOf())

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        HypenLogger.setLogLevel(HypenLogLevel.WARN)
        HypenLogger.setLogHandler(
            HypenLogHandler { level, _, message, _ -> if (level == HypenLogLevel.WARN) warnings += message },
        )
    }

    @After
    fun tearDown() {
        HypenLogger.setLogHandler(null)
        HypenLogger.setLogLevel(HypenLogLevel.ERROR)
        server.shutdown()
        executor.shutdownNow()
    }

    private val url get() = server.url("/").toString().replace("http", "ws")

    private val audio = object : AudioCapturePlatform {
        override fun hasMicrophone() = true

        override fun start(format: AudioCaptureFormat, sink: AudioSink): CaptureHandle = CaptureHandle { }
    }

    private fun host(): DeviceHost {
        val perms = FakePermissions().declare("RECORD_AUDIO")
        val indicator = FakeIndicator(ready = true)
        return DeviceHost(DeviceHostConfig("wss://a:443"), listOf(MicRecordDriver(audio, perms, indicator)), dispatcher, activityIndicator = indicator)
    }

    /** Connect a device-capable engine to a server answering [extensions]; return its hello. */
    private fun helloOver(extensions: String?): String {
        val upgrade = MockResponse().withWebSocketUpgrade(
            object : WebSocketListener() {
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, null)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (text.contains("\"type\":\"hello\"")) hellos.put(text)
                }
            },
        )
        extensions?.let { upgrade.addHeader("Sec-WebSocket-Extensions", it) }
        server.enqueue(upgrade)
        val host = host()
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false), deviceHost = host)
        try {
            runBlocking { engine.connect() }
            return hellos.poll(10, TimeUnit.SECONDS) ?: error("no hello")
        } finally {
            engine.destroy()
            host.dispose()
        }
    }

    private fun contextWarnings() = warnings.count { it.contains("context takeover") }

    @Test
    fun `a socket compressed without context takeover negotiates the device plane`() {
        val hello = helloOver("permessage-deflate; server_no_context_takeover; client_no_context_takeover")
        assertTrue("device hello: $hello", hello.contains("\"device\""))
        assertEquals(0, contextWarnings())
    }

    @Test
    fun `an uncompressed socket negotiates the device plane`() {
        val hello = helloOver(null)
        assertTrue("device hello: $hello", hello.contains("\"device\""))
        assertEquals(0, contextWarnings())
    }

    @Test
    fun `a socket with context takeover in either direction runs UI-only with one warning`() {
        for (negotiated in listOf(
            "permessage-deflate",
            "permessage-deflate; server_no_context_takeover",
            "permessage-deflate; client_no_context_takeover",
        )) {
            warnings.clear()
            val hello = helloOver(negotiated)
            assertFalse("$negotiated: UI-only hello: $hello", hello.contains("\"device\""))
            assertEquals("$negotiated: $warnings", 1, contextWarnings())
        }
    }
}
