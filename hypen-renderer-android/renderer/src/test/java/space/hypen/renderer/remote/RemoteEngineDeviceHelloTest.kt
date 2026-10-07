package space.hypen.renderer.remote

import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import space.hypen.renderer.device.AudioCaptureFormat
import space.hypen.renderer.device.AudioCapturePlatform
import space.hypen.renderer.device.AudioSink
import space.hypen.renderer.device.CaptureHandle
import space.hypen.renderer.device.DeviceHost
import space.hypen.renderer.device.DeviceHostConfig
import space.hypen.renderer.device.FakeIndicator
import space.hypen.renderer.device.FakePermissions
import space.hypen.renderer.device.MicRecordDriver
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Tester report "Android: microphone negotiation fails" over a real socket:
 * the device hello must not be snapshotted while the indicator overlay is
 * still attaching, or `mic.record` is missing from the handshake for the
 * whole connection (see `DeviceLiveSelectionTest`).
 */
class RemoteEngineDeviceHelloTest {
    private lateinit var server: MockWebServer
    private val hellos = LinkedBlockingQueue<Pair<Long, String>>()
    private val executor = Executors.newSingleThreadExecutor()
    private val dispatcher = executor.asCoroutineDispatcher()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(code, null)
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (text.contains("\"type\":\"hello\"")) hellos.put(System.nanoTime() to text)
                    }
                },
            ),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        executor.shutdownNow()
    }

    private val url get() = server.url("/").toString().replace("http", "ws")

    private val audio = object : AudioCapturePlatform {
        override fun hasMicrophone() = true

        override fun start(format: AudioCaptureFormat, sink: AudioSink): CaptureHandle = CaptureHandle { }
    }

    private fun host(indicator: FakeIndicator): DeviceHost {
        val perms = FakePermissions().declare("RECORD_AUDIO")
        return DeviceHost(DeviceHostConfig("wss://a:443"), listOf(MicRecordDriver(audio, perms, indicator)), dispatcher, activityIndicator = indicator)
    }

    private fun hello(): Pair<Long, String> = hellos.poll(10, TimeUnit.SECONDS) ?: error("no hello")

    @Test
    fun `a hello racing the indicator overlay waits for it and advertises mic record`() = runBlocking {
        val indicator = FakeIndicator(ready = false)
        val host = host(indicator)
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false), deviceHost = host)
        engine.connect()
        // The overlay attaches a moment after the socket opened (first frame).
        Thread.sleep(300)
        val attachedAt = System.nanoTime()
        indicator.ready = true
        // What the real overlay's readiness callback does (AndroidDeviceHost).
        host.recheckCapabilities()
        val (at, text) = hello()
        assertTrue("the hello waited for the overlay", at >= attachedAt)
        assertTrue("mic.record is in the hello: $text", text.contains("\"mic.record\""))
        engine.destroy()
        host.dispose()
    }

    @Test
    fun `an overlay that never attaches delays the hello by a bounded wait, without mic record`() = runBlocking {
        val indicator = FakeIndicator(ready = false)
        val host = host(indicator)
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false), deviceHost = host)
        val started = System.nanoTime()
        engine.connect()
        val (at, text) = hello()
        val waitedMs = TimeUnit.NANOSECONDS.toMillis(at - started)
        assertTrue("bounded: waited $waitedMs ms", waitedMs < RemoteEngine.DEVICE_HELLO_INDICATOR_WAIT_MS + 3_000)
        assertTrue("a device hello all the same: $text", text.contains("\"device\""))
        assertFalse(text.contains("\"mic.record\""))
        engine.destroy()
        host.dispose()
    }

    @Test
    fun `leaving the foreground mid-wait sends the hello at once`() = runBlocking {
        val indicator = FakeIndicator(ready = false)
        val host = host(indicator)
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false), deviceHost = host)
        engine.connect()
        Thread.sleep(300)
        val suspendedAt = System.nanoTime()
        host.onHostSuspended()
        val (at, text) = hello()
        assertTrue("woken by the suspension, not the bound",
            TimeUnit.NANOSECONDS.toMillis(at - suspendedAt) < RemoteEngine.DEVICE_HELLO_INDICATOR_WAIT_MS / 2)
        assertTrue(text.contains("\"device\""))
        engine.destroy()
        host.dispose()
    }

    @Test
    fun `a backgrounded host never delays the hello`() = runBlocking {
        val indicator = FakeIndicator(ready = false)
        val host = host(indicator)
        host.onHostSuspended()
        val engine = RemoteEngine(url, RemoteEngineConfig(autoReconnect = false), deviceHost = host)
        val started = System.nanoTime()
        engine.connect()
        val (at, _) = hello()
        assertTrue(TimeUnit.NANOSECONDS.toMillis(at - started) < RemoteEngine.DEVICE_HELLO_INDICATOR_WAIT_MS)
        engine.destroy()
        host.dispose()
    }
}
