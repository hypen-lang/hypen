@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device

import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import space.hypen.renderer.device.android.ComposeDeviceActivityIndicator
import space.hypen.renderer.device.android.CoverWatch
import space.hypen.renderer.model.DeviceMalformedMessage
import space.hypen.renderer.model.DeviceWireMessage
import space.hypen.renderer.model.SessionAckMessage
import space.hypen.renderer.remote.DeviceJsonException
import space.hypen.renderer.remote.MoshiMessageParser
import space.hypen.renderer.remote.StrictDeviceJson
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Regression tests for the verifier's findings on the Android review-fix pass:
 * a `bluetooth.scan` that starts while the overlay's window is already
 * covered, and D4's valid-UTF-8 rule on the real (OkHttp, String-only)
 * receive path.
 */
class DeviceVerifierFixesTest {
    // ---- a scan starting under an already-covering window ------------------------------------------

    /** A manual `View.postDelayed` / `removeCallbacks`. */
    private class ManualScheduler {
        val pending = mutableListOf<Pair<Runnable, Long>>()

        fun schedule(r: Runnable, ms: Long) {
            pending += r to ms
        }

        fun unschedule(r: Runnable) {
            pending.removeAll { it.first === r }
        }

        /** Let the grace elapse: run everything scheduled. */
        fun elapse() {
            val due = pending.toList()
            pending.clear()
            due.forEach { it.first.run() }
        }
    }

    private class Window(var focused: Boolean)

    /** One composed overlay's wiring, as `DeviceActivityOverlay` does it. */
    private fun overlay(indicator: ComposeDeviceActivityIndicator, window: Window, clock: ManualScheduler): Pair<CoverWatch, () -> Unit> {
        val watch = CoverWatch(indicator, { window.focused }, clock::schedule, clock::unschedule)
        val removeStart = indicator.onStreamStarted(watch::onStreamStarted)
        watch.onStreamStarted()
        val detach = indicator.attach()
        return watch to {
            removeStart()
            watch.dispose()
            detach()
        }
    }

    @Test
    fun `a stream that starts while the window is already covered stops after the grace`() {
        val indicator = ComposeDeviceActivityIndicator()
        val window = Window(focused = false) // e.g. the VideoFullscreen Dialog is up
        val clock = ManualScheduler()
        val (watch, _) = overlay(indicator, window, clock)
        assertTrue(indicator.isReady) // lifecycle STARTED: still ready and advertised
        assertFalse(watch.isArmed) // nothing running yet, nothing to stop
        val stops = mutableListOf<IndicatorStopReason>()
        indicator.show("wss://a.example:443", "scan") { stops += it }!!
        // No focus change will ever happen, yet the covered check is armed.
        assertTrue(watch.isArmed)
        assertEquals(listOf(ComposeDeviceActivityIndicator.COVERED_GRACE_MS), clock.pending.map { it.second })
        clock.elapse()
        assertEquals(listOf(IndicatorStopReason.HIDDEN), stops)
    }

    @Test
    fun `focus returning within the grace (consent dialog just closed) keeps the stream`() {
        val indicator = ComposeDeviceActivityIndicator()
        val window = Window(focused = false) // the host's consent dialog is still closing
        val clock = ManualScheduler()
        val (watch, _) = overlay(indicator, window, clock)
        val stops = mutableListOf<IndicatorStopReason>()
        indicator.show("wss://a.example:443", "scan") { stops += it }!!
        assertTrue(watch.isArmed)
        window.focused = true
        watch.onFocusChanged(true)
        assertFalse(watch.isArmed)
        assertTrue(clock.pending.isEmpty())
        clock.elapse()
        assertTrue(stops.isEmpty())
        // A later cover while it runs still stops it (the pre-existing path).
        window.focused = false
        watch.onFocusChanged(false)
        clock.elapse()
        assertEquals(listOf(IndicatorStopReason.HIDDEN), stops)
    }

    @Test
    fun `a stream that starts on a focused window arms nothing, and a removed overlay no longer listens`() {
        val indicator = ComposeDeviceActivityIndicator()
        val window = Window(focused = true)
        val clock = ManualScheduler()
        val (watch, remove) = overlay(indicator, window, clock)
        indicator.show("wss://a.example:443", "scan") { }!!
        assertFalse(watch.isArmed)
        assertTrue(clock.pending.isEmpty())
        remove() // overlay left composition (this also stops the running stream: last detach)
        window.focused = false
        indicator.attach() // another started screen without a CoverWatch
        indicator.show("wss://a.example:443", "scan") { }!!
        assertFalse(watch.isArmed)
        assertTrue(clock.pending.isEmpty())
    }

    @Test
    fun `an overlay that appears while a stream already runs on a covered window arms the check`() {
        val indicator = ComposeDeviceActivityIndicator()
        indicator.attach()
        val stops = mutableListOf<IndicatorStopReason>()
        indicator.show("wss://a.example:443", "scan") { stops += it }!!
        val clock = ManualScheduler()
        val (watch, _) = overlay(indicator, Window(focused = false), clock)
        assertTrue(watch.isArmed)
        clock.elapse()
        assertEquals(listOf(IndicatorStopReason.HIDDEN), stops)
    }

    @Test
    fun `bluetooth scan granted earlier, started under a covering dialog, ends cancelled indicator-hidden`() = runTest {
        val bt = FakeBluetooth()
        val perms = FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN").apply { granted += "android.permission.BLUETOOTH_SCAN" }
        val indicator = ComposeDeviceActivityIndicator()
        val window = Window(focused = false)
        val clock = ManualScheduler()
        overlay(indicator, window, clock)
        var prompts = 0
        val host = newHost(listOf(BluetoothScanDriver(bt, perms, indicator)), consent = { prompts += 1; ConsentDecision.CONTINUE })
        val (c, t) = connect(host)
        // First scan (window focused) grants the persistable consent.
        window.focused = true
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        c.handleMessage(mapOf("type" to "deviceEvent", "id" to 2L, "control" to mapOf("cancel" to true)))
        runCurrent()
        assertEquals(1, prompts)
        assertEquals(1, bt.starts)
        t.sent.clear()
        // Now a Dialog covers the window; the server starts another scan: no prompt, no focus change.
        window.focused = false
        c.handleMessage(request(3, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(1, prompts)
        assertEquals(2, bt.starts)
        assertEquals(1, indicator.entries.size)
        assertEquals(1, clock.pending.size) // the covered check was armed by the start itself
        clock.elapse()
        runCurrent()
        assertEquals(DeviceWire.error(3, DeviceErrorCode.CANCELLED, "indicator-hidden"), t.responses().single())
        assertEquals(2, bt.stopped)
        assertTrue(indicator.entries.isEmpty())
        host.dispose()
    }

    // ---- D4: valid UTF-8 on the String-only OkHttp path ---------------------------------------------

    private val parser = MoshiMessageParser()
    private val corpus = CompatFixtures.json("fixtures/device/conformance/messages.json")

    @Suppress("UNCHECKED_CAST")
    private fun cases(key: String): List<Map<String, Any?>> = corpus[key] as List<Map<String, Any?>>

    /** Exactly what OkHttp 4's WebSocketReader hands the listener for a text frame. */
    private fun okHttpText(bytes: ByteArray): String = Buffer().write(bytes).readUtf8()

    private fun accepted(text: String): Boolean = parser.parseMessage(text) is DeviceWireMessage

    @Test
    fun `every rawHex invalid-UTF-8 case is refused on the production String path`() {
        val raw = cases("invalid").filter { it["rawHex"] != null }
        assertTrue("corpus has rawHex cases", raw.size >= 5)
        val failures = mutableListOf<String>()
        for (case in raw) {
            val text = okHttpText(CorpusText.hexToBytes(case["rawHex"] as String))
            val m = parser.parseMessage(text)
            if (m !is DeviceMalformedMessage) failures += "${case["name"]}: ${m?.let { it::class.simpleName }}"
        }
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
    }

    @Test
    fun `the whole corpus classifies the same on the String path as on the byte path`() {
        val failures = mutableListOf<String>()
        for ((key, expectValid) in listOf("valid" to true, "invalid" to false)) {
            for (case in cases(key)) {
                val bytes = CorpusText.bytesOf(case) ?: CorpusText.serialize(case["message"]).toByteArray(Charsets.UTF_8)
                val strict = parser.parseMessageBytes(bytes) is DeviceWireMessage
                val production = accepted(okHttpText(bytes))
                if (strict != production) failures += "${case["name"]}: bytes=$strict string=$production"
                if (expectValid && !production) failures += "${case["name"]}: valid case refused on the String path"
            }
        }
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
    }

    private fun event(value: String) = """{"type":"deviceEvent","id":7,"event":{"name":"$value"}}"""

    @Test
    fun `raw U+FFFD is refused on unverified text, escaped U+FFFD is accepted, verified bytes keep it`() {
        val raw = event("a\uFFFDb")
        val refused = parser.parseMessage(raw)
        assertTrue(refused is DeviceMalformedMessage)
        assertTrue((refused as DeviceMalformedMessage).detail, refused.detail.contains("U+FFFD"))
        // Also in a key.
        assertTrue(parser.parseMessage("{\"type\":\"deviceEvent\",\"id\":7,\"event\":{\"k\uFFFD\":1}}") is DeviceMalformedMessage)
        // The escape is unambiguous, and decodes to the replacement character.
        val escaped = parser.parseMessage(event("a\\uFFFDb")) as DeviceWireMessage
        assertEquals("a\uFFFDb", (escaped.body["event"] as Map<*, *>)["name"])
        // Bytes that passed the strict decoder carry a genuine U+FFFD.
        val verified = parser.parseMessageBytes(raw.toByteArray(Charsets.UTF_8)) as DeviceWireMessage
        assertEquals("a\uFFFDb", (verified.body["event"] as Map<*, *>)["name"])
        // Library-level defaults: wire text is unverified.
        assertTrue(runCatching { StrictDeviceJson.parse("\"\uFFFD\"") }.exceptionOrNull() is DeviceJsonException)
        assertEquals("\uFFFD", StrictDeviceJson.parse("\"\uFFFD\"", utf8Verified = true))
        assertEquals("\uFFFD", StrictDeviceJson.parse("\"\\ufffd\""))
    }

    @Test
    fun `a sessionAck whose device carries repaired UTF-8 disables the device plane`() {
        val bad = byteArrayOf(0xff.toByte())
        val ackBytes = """{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false,"device":{"protocolVersion":1,"binary":true,"capabilities":[{"name":"core.capabilities","version":1},{"name":"x""".toByteArray() +
            bad + """","version":1}]}}""".toByteArray()
        val ack = parser.parseMessage(okHttpText(ackBytes)) as SessionAckMessage
        assertNull(ack.device)
        assertNotNull(ack.deviceMalformed)
        val clean = parser.parseMessage(okHttpText(String(ackBytes, Charsets.ISO_8859_1).replace("x\u00ff", "xy").toByteArray(Charsets.ISO_8859_1))) as SessionAckMessage
        assertNotNull(clean.device)
        assertNull(clean.deviceMalformed)
    }

    /**
     * Pins the platform behaviour the fix relies on: a real OkHttp client
     * receiving a text frame with invalid UTF-8 from a raw socket server gets
     * U+FFFD in its String — and the parser refuses that device message.
     */
    @Test
    fun `a real OkHttp socket repairs invalid UTF-8 and the parser refuses it`() {
        val payload = """{"type":"deviceEvent","id":7,"event":{"a":"x""".toByteArray() + byteArrayOf(0xff.toByte()) + """y"}}""".toByteArray()
        val server = ServerSocket(0)
        val serverThread = thread(isDaemon = true) {
            server.accept().use { s ->
                val input = s.getInputStream()
                val head = StringBuilder()
                while (!head.endsWith("\r\n\r\n")) head.append(input.read().toChar())
                val key = head.lines().first { it.startsWith("Sec-WebSocket-Key:", ignoreCase = true) }.substringAfter(':').trim()
                val accept = Base64.getEncoder().encodeToString(
                    MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()),
                )
                val out = s.getOutputStream()
                out.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
                out.write(byteArrayOf(0x81.toByte(), payload.size.toByte()) + payload) // FIN | text, unmasked
                out.flush()
                runCatching { input.read() } // hold the socket open until the client closes
            }
        }
        val texts = LinkedBlockingQueue<String>()
        val client = OkHttpClient()
        val ws = client.newWebSocket(
            Request.Builder().url("ws://127.0.0.1:${server.localPort}/").build(),
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    texts.put(text)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    texts.put("FAILURE: $t")
                }
            },
        )
        try {
            val text = texts.poll(10, TimeUnit.SECONDS) ?: error("no text frame")
            assertFalse(text, text.startsWith("FAILURE"))
            assertTrue(text.contains('\uFFFD'))
            assertTrue(parser.parseMessage(text) is DeviceMalformedMessage)
            assertTrue(parser.parseMessageBytes(payload) is DeviceMalformedMessage)
        } finally {
            ws.cancel()
            server.close()
            client.dispatcher.executorService.shutdown()
            serverThread.join(2_000)
        }
    }
}
