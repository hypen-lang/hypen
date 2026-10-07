@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device

import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tester report "Android: microphone negotiation fails".
 *
 * `mic.record` (like `bluetooth.scan`) is advertised only while the
 * host-owned indicator overlay is composed on a started screen. The hello is
 * snapshotted when the socket opens. When that happened before the overlay
 * attached, the hello — and so `sessionAck.device` — lacked `mic.record`, and
 * the handshake is immutable per socket: the ack's selection is the client's
 * ceiling (`fixtures/device` connection model; `violation-capability-not-
 * selected` pins the `unsupported` reaction). The overlay then attached, a
 * `core.capabilities` snapshot offered `mic.record`, the server's broker
 * added it to ITS live selection from that snapshot, and every `mic.record`
 * request was refused `unsupported` by the client for the rest of the
 * connection.
 *
 * The client now waits (bounded, foreground only) for the indicator before
 * snapshotting the hello ([DeviceHost.helloAwaitsIndicator], used by
 * `RemoteEngine`; see `RemoteEngineDeviceHelloTest`). These tests pin the
 * host-side predicate and the ceiling it exists to respect.
 */
class DeviceLiveSelectionTest {
    private fun perms() = FakePermissions().declare("RECORD_AUDIO").apply { granted += "android.permission.RECORD_AUDIO" }

    private val audio = object : AudioCapturePlatform {
        override fun hasMicrophone() = true

        override fun start(format: AudioCaptureFormat, sink: AudioSink): CaptureHandle = CaptureHandle { }
    }

    private fun micRequest(id: Long) =
        request(id, "mic.record", mapOf("sampleRate" to 16_000L, "format" to "pcm16"), initialCredit = 256 * 1024, timeoutMs = 600_000)

    @Test
    fun `the hello awaits the indicator only when that is all an implementable capability is missing, in the foreground`() = runTest {
        val indicator = FakeIndicator(ready = false)
        val host = newHost(listOf(MicRecordDriver(audio, perms(), indicator)), config = DeviceHostConfig(origin = "wss://app.example:443"))
        assertTrue(host.helloAwaitsIndicator())
        assertFalse("not advertised yet", host.offers().any { it["name"] == "mic.record" })

        indicator.ready = true
        assertFalse(host.helloAwaitsIndicator())
        assertTrue(host.offers().any { it["name"] == "mic.record" })

        // Backgrounded: the user, not a frame, decides when the overlay returns — never wait.
        indicator.ready = false
        host.onHostSuspended()
        assertFalse(host.helloAwaitsIndicator())
        host.onHostResumed()
        assertTrue(host.helloAwaitsIndicator())

        host.dispose()
        assertFalse(host.helloAwaitsIndicator())
    }

    @Test
    fun `nothing to wait for without the microphone, without RECORD_AUDIO, or without an indicator-gated driver`() = runTest {
        val noMic = object : AudioCapturePlatform by audio {
            override fun hasMicrophone() = false
        }
        val indicator = FakeIndicator(ready = false)
        assertFalse(newHost(listOf(MicRecordDriver(noMic, perms(), indicator))).helloAwaitsIndicator())
        assertFalse(newHost(listOf(MicRecordDriver(audio, FakePermissions(), indicator))).helloAwaitsIndicator())
        assertFalse(newHost(listOf(PermissionQueryDriver(perms()))).helloAwaitsIndicator())
    }

    @Test
    fun `a capability that joined after the hello stays unsupported on that socket - the ack is the ceiling`() = runTest {
        val indicator = FakeIndicator(ready = false)
        val host = newHost(listOf(MicRecordDriver(audio, perms(), indicator)))
        val (c, t) = connect(host)
        assertNull(c.selection!!.capabilities["mic.record"])
        indicator.ready = true
        assertTrue(host.recheckCapabilities())
        runCurrent()
        c.handleMessage(micRequest(2))
        runCurrent()
        assertEquals("unsupported", t.errorCode(t.responses().single()))
        c.close()
        host.dispose()
    }

    @Test
    fun `with the indicator ready at hello time the ack selects mic record and it runs`() = runTest {
        val indicator = FakeIndicator(ready = true)
        val consent = DeviceCaptureDriversTest.FakeConsent(ConsentDecision.CANCEL)
        val host = newHost(listOf(MicRecordDriver(audio, perms(), indicator)), consent = consent)
        val (c, t) = connect(host)
        assertEquals(1L, c.selection!!.capabilities["mic.record"])
        c.handleMessage(micRequest(2))
        runCurrent()
        assertEquals("record audio from your microphone (mono, 16000 Hz)", consent.prompts.single().operation)
        assertEquals("denied", t.errorCode(t.responses().single()))
        c.close()
        host.dispose()
    }
}
