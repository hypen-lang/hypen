@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.device.android.AndroidGalleryPlatform
import space.hypen.renderer.device.android.ComposeDeviceActivityIndicator
import space.hypen.renderer.device.android.ConsentInputArming
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files

/**
 * Regression tests for the second Android review (review2-android.md,
 * findings 1–17) and the round-2 lead decisions D1–D8 (RFC 001).
 */
class DeviceHostRound2Test {
    private val btScan = "android.permission.BLUETOOTH_SCAN"

    private fun btPerms(granted: Boolean = true) = FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN").apply { if (granted) this.granted += btScan }

    private fun items(t: FakeTransport): List<Map<*, *>> =
        ((t.responses().single()["result"] as Map<*, *>)["items"] as List<*>).map { it as Map<*, *> }

    private class FixedGallery(val items: List<PickedMedia>) : GalleryPlatform {
        override fun canPresent() = true

        override suspend fun pick(request: GalleryPickRequest, maxItemBytes: Long, presenterGone: () -> Unit) = items
    }

    /** A stream of [n] zero bytes that allocates nothing. */
    private class Zeros(private var n: Long) : InputStream() {
        override fun read(): Int = if (n-- > 0) 0 else -1

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (n <= 0) return -1
            val k = minOf(len.toLong(), n).toInt()
            java.util.Arrays.fill(b, off, off + k, 0)
            n -= k
            return k
        }
    }

    /** Counts frames and bytes without keeping them. */
    private class CountingTransport : DeviceTransport {
        val messages = mutableListOf<Map<String, Any?>>()
        var frames = 0
        var bytes = 0L

        override fun sendMessage(message: Map<String, Any?>) {
            messages += message
        }

        override fun sendBinary(frame: ByteArray) {
            frames += 1
            bytes += frame.size - DeviceProtocol.FRAME_HEADER_LEN
        }

        override fun close(code: Int, reason: String) = Unit
    }

    // ---- #2 / D2, D5: empty and undeclared items ---------------------------------------------

    @Test
    fun `undeclared items stream without a size and report the actual bytes (D5), empty ones send no frame (D2)`() = runTest {
        val data = ByteArray(70_000) { it.toByte() }
        val host = newHost(
            listOf(
                GalleryPickDriver(
                    FixedGallery(
                        listOf(
                            PickedMedia("image/jpeg", null, { data.inputStream() }),
                            PickedMedia("image/png", null, { ByteArray(0).inputStream() }),
                            PickedMedia("image/gif", 0, { ByteArray(0).inputStream() }),
                        ),
                    ),
                ),
            ),
        )
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", mapOf("mediaTypes" to listOf("photo"), "maxCount" to 3), initialCredit = 4L * 1024 * 1024))
        runCurrent()
        // Every item announced before any bytes; undeclared ones carry no `bytes`.
        assertEquals(
            listOf(
                DeviceWire.event(2, DeviceWire.blobStart(0, "image/jpeg", null)),
                DeviceWire.event(2, DeviceWire.blobStart(1, "image/png", null)),
                DeviceWire.event(2, DeviceWire.blobStart(2, "image/gif", 0)),
            ),
            t.messages.take(3),
        )
        assertFalse((t.messages[0]["event"] as Map<*, *>).containsKey("bytes"))
        assertEquals(listOf(65_536, 4_464), t.frames.map { it.decoded.payload.size })
        assertTrue(t.frames.all { it.decoded.header.channel == 0 })
        assertEquals(listOf(70_000L, 0L, 0L), items(t).map { it["bytes"] })
        assertEquals(listOf(sha256Hex(data), sha256Hex(ByteArray(0)), sha256Hex(ByteArray(0))), items(t).map { it["sha256"] })
        host.dispose()
    }

    @Test
    fun `an undeclared item over maxItemBytes stops as it is read`() = runTest {
        val max = 64L * 1024 * 1024
        val host = newHost(
            listOf(GalleryPickDriver(FixedGallery(listOf(PickedMedia("image/heic", null, { Zeros(max + 1) }))))),
            config = DeviceHostConfig(origin = "wss://a:443", enforceCredit = false),
        )
        val t = CountingTransport()
        val c = host.openWithHello(t)
        c.onAck(ackFor(host))
        c.handleMessage(coreRequest(1))
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "item-exceeds-limit"), t.messages.last())
        assertEquals(max, t.bytes) // never a byte beyond the limit
        host.dispose()
    }

    // ---- #3: bluetooth.scan never runs invisibly ------------------------------------------------

    @Test
    fun `while suspended bluetooth scan is refused, after resuming it runs`() = runTest {
        val bt = FakeBluetooth()
        val indicator = FakeIndicator()
        val host = newHost(listOf(BluetoothScanDriver(bt, btPerms(), indicator)), consent = { ConsentDecision.CONTINUE })
        val (c, t) = connect(host)
        host.onHostSuspended()
        runCurrent()
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "host-suspended"), t.responses().single())
        assertEquals(0, bt.starts)
        assertTrue(indicator.visible.isEmpty())
        host.onHostResumed()
        c.handleMessage(request(3, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(1, bt.starts)
        assertEquals(1, indicator.visible.size)
        host.dispose()
    }

    @Test
    fun `an indicator that can no longer be seen ends the scan cancelled indicator-hidden`() = runTest {
        val bt = FakeBluetooth()
        val indicator = FakeIndicator()
        val host = newHost(listOf(BluetoothScanDriver(bt, btPerms(), indicator)), consent = { ConsentDecision.CONTINUE })
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        indicator.stopAll(IndicatorStopReason.HIDDEN)
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.CANCELLED, "indicator-hidden"), t.responses().single())
        assertEquals(1, bt.stopped)
        host.dispose()
    }

    @Test
    fun `the compose indicator is ready only while attached, and the last detach stops running streams`() {
        val indicator = ComposeDeviceActivityIndicator()
        var changes = 0
        indicator.onReadyChanged = { changes += 1 }
        assertFalse(indicator.isReady)
        assertNull(indicator.show("wss://a:443", "scan") { })
        val detachA = indicator.attach() // the overlay's screen is started
        val detachB = indicator.attach()
        assertTrue(indicator.isReady)
        val stops = mutableListOf<IndicatorStopReason>()
        val handle = indicator.show("wss://a:443", "scan") { stops += it }!!
        assertEquals(1, indicator.entries.size)
        detachA()
        detachA() // idempotent
        assertTrue(indicator.isReady)
        assertTrue(stops.isEmpty())
        detachB() // the last visible overlay went away (screen stopped)
        assertFalse(indicator.isReady)
        assertEquals(listOf(IndicatorStopReason.HIDDEN), stops)
        assertEquals(2, changes)
        handle.hide()
        assertTrue(indicator.entries.isEmpty())
    }

    // ---- #4: I/O failures always terminate --------------------------------------------------------

    @Test
    fun `failing to open or read an item terminates with a fixed token and releases the operation`() = runTest {
        val cases = listOf(
            PickedMedia("image/jpeg", 10, { throw FileNotFoundException("content://media/secret/42") }) to
                DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "read-failed"),
            PickedMedia("image/jpeg", 10, { throw SecurityException("grant revoked for content://media/secret/42") }) to
                DeviceWire.error(2, DeviceErrorCode.REVOKED, "read-denied"),
            PickedMedia("image/jpeg", null, {
                object : InputStream() {
                    override fun read(): Int = throw IOException("cloud provider failed for /data/user/0/secret")
                }
            }) to DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "read-failed"),
        )
        for ((media, expected) in cases) {
            val host = newHost(listOf(GalleryPickDriver(FixedGallery(listOf(media)))))
            val (c, t) = connect(host)
            c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS, initialCredit = 65536))
            runCurrent()
            assertEquals(expected, t.responses().single())
            assertFalse(t.messages.toString().contains("secret"))
            // The operation is gone: a renewal is ignored (no leaseAck, no second terminal).
            t.sent.clear()
            c.handleMessage(control(2, "renewLease", 1))
            runCurrent()
            assertTrue(t.sent.isEmpty())
            host.dispose()
        }
    }

    // ---- #5 / D6: the first ack carrying device is the selection ------------------------------------

    @Test
    fun `an ack without device is not selected yet, the first ack with device enables, later acks change nothing`() = runTest {
        val host = newHost(listOf(PermissionQueryDriver(FakePermissions().declare("CAMERA"))))
        val t = FakeTransport()
        val c = host.openWithHello(t)
        c.onAck(null) // e.g. a legacy hello-grace ack
        runCurrent()
        assertFalse(c.isEnabled)
        c.onAck(ackFor(host)) // the late hello's re-ack
        runCurrent()
        assertTrue(c.isEnabled)
        c.onAck(mapOf("protocolVersion" to 1, "binary" to true, "capabilities" to listOf(mapOf("name" to "core.capabilities", "version" to 1))))
        runCurrent()
        assertEquals(setOf("core.capabilities", "permission.query"), c.selection!!.capabilities.keys)
        c.handleMessage(coreRequest(1))
        c.handleMessage(request(2, "permission.query", mapOf("permission" to "camera"), timeoutMs = 30_000))
        runCurrent()
        assertEquals(DeviceWire.result(2, mapOf("status" to "prompt")), t.responses().single())
        host.dispose()
    }

    // ---- #6: only the negotiated selection runs -------------------------------------------------------

    @Test
    fun `a request outside the negotiated selection is unsupported and never runs`() = runTest {
        val perms = FakePermissions().declare("CAMERA")
        var ran = 0
        val counting = object : DeviceDriver by PermissionQueryDriver(perms) {
            override suspend fun run(ctx: DriverContext): DriverOutcome {
                ran += 1
                return DriverOutcome.Result(mapOf("status" to "granted"))
            }
        }
        val host = newHost(listOf(counting))
        val t = FakeTransport()
        val c = host.openWithHello(t)
        c.onAck(mapOf("protocolVersion" to 1, "binary" to true, "capabilities" to listOf(mapOf("name" to "core.capabilities", "version" to 1))))
        c.handleMessage(coreRequest(1))
        runCurrent()
        t.sent.clear()
        c.handleMessage(request(2, "permission.query", mapOf("permission" to "camera"), timeoutMs = 30_000))
        runCurrent()
        assertEquals("unsupported", t.errorCode(t.responses().single()))
        assertEquals(0, ran)
        host.dispose()
    }

    // ---- #7: the ack is validated against the hello actually sent -------------------------------------

    @Test
    fun `an ack is checked against the hello snapshot, unknown entries are dropped rather than disabling`() = runTest {
        val indicator = FakeIndicator(ready = true)
        val bt = FakeBluetooth()
        val host = newHost(listOf(BluetoothScanDriver(bt, btPerms(), indicator)), consent = { ConsentDecision.CONTINUE })
        val t = FakeTransport()
        val c = host.openWithHello(t) // advertised bluetooth.scan
        indicator.ready = false // the overlay left composition before the ack arrived
        c.onAck(
            mapOf(
                "protocolVersion" to 1,
                "binary" to true,
                "capabilities" to listOf(
                    mapOf("name" to "core.capabilities", "version" to 1),
                    mapOf("name" to "bluetooth.scan", "version" to 1),
                    mapOf("name" to "file.save", "version" to 1), // never offered
                ),
            ),
        )
        runCurrent()
        assertTrue(c.isEnabled)
        assertEquals(mapOf("core.capabilities" to 1L, "bluetooth.scan" to 1L), c.selection!!.capabilities)
        c.handleMessage(coreRequest(1))
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64)) // selected but not implementable now
        runCurrent()
        assertEquals("unsupported", t.errorCode(t.responses().single()))
        assertEquals(0, bt.starts)
        indicator.ready = true
        c.handleMessage(request(3, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(1, bt.starts)
        host.dispose()
    }

    // ---- #8: no spooling (D5); stale spool files are swept ---------------------------------------------

    @Test
    fun `stale spool files from older versions are swept and nothing else is touched`() {
        val dir = Files.createTempDirectory("hypen-cache").toFile()
        try {
            val stale = File(dir, "hypen-device-123.blob").apply { writeText("x") }
            val other = File(dir, "image-cache.bin").apply { writeText("y") }
            val similar = File(dir, "hypen-device-notes.txt").apply { writeText("z") }
            AndroidGalleryPlatform.sweepStaleSpoolFiles(dir)
            assertFalse(stale.exists())
            assertTrue(other.exists())
            assertTrue(similar.exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    // ---- #9: prompts, grants and cooldowns follow the connection's origin --------------------------------

    @Test
    fun `consent, grants and cooldowns are bound to the origin the socket talks to`() = runTest {
        val prompts = mutableListOf<ConsentPrompt>()
        var decision = ConsentDecision.CONTINUE
        val bt = FakeBluetooth()
        val indicator = FakeIndicator()
        val host = newHost(
            listOf(BluetoothScanDriver(bt, btPerms(), indicator)),
            config = DeviceHostConfig(origin = "wss://a.example:443"),
            consent = { prompts += it; decision },
        )
        // Continue at a.example: a 24 h grant for a.example only.
        val (ca, ta) = connect(host, origin = "wss://a.example:443")
        ca.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        ca.handleMessage(control(2, "cancel", true))
        runCurrent()
        // The same (Application-scoped) host used for b.example: a new prompt naming b.example.
        val (cb, tb) = connect(host, origin = "wss://b.example:443")
        decision = ConsentDecision.CANCEL
        cb.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(listOf("wss://a.example:443", "wss://b.example:443"), prompts.map { it.origin })
        assertEquals(DeviceWire.error(2, DeviceErrorCode.DENIED, "host-refused"), tb.responses().single())
        // b.example's refusal cooldown does not throttle a.example, whose grant still holds.
        ca.handleMessage(request(3, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(2, prompts.size)
        assertEquals("wss://a.example:443", indicator.visible.single().origin)
        assertTrue(ta.responses().none { it["id"] == 3L })
        host.dispose()
    }

    // ---- #10: a dismissed or expired permission is not a permanent denial ---------------------------------

    @Test
    fun `permission request always asks the OS - a dismissal is cancelled and can be asked again`() = runTest {
        val perms = FakePermissions().declare("CAMERA").apply {
            requested += "android.permission.CAMERA" // local history looks like "denied" (no rationale)
            dismisses = true
        }
        val host = newHost(listOf(PermissionRequestDriver(perms), PermissionQueryDriver(perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        assertEquals(1, perms.requests) // the OS dialog was shown, not short-circuited
        assertEquals(DeviceWire.error(2, DeviceErrorCode.CANCELLED, "dialog-dismissed"), t.responses().single())
        // Querying after a dismissal: still promptable.
        c.handleMessage(request(3, "permission.query", mapOf("permission" to "camera"), timeoutMs = 30_000))
        runCurrent()
        assertEquals(DeviceWire.result(3, mapOf("status" to "prompt")), t.responses().last())
        // After the short dismissal cooldown the OS is asked again, and this time the user grants.
        testScheduler.advanceTimeBy(3_001)
        perms.dismisses = false
        perms.userGrants = true
        c.handleMessage(request(4, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        assertEquals(2, perms.requests)
        assertEquals(DeviceWire.result(4, mapOf("status" to "granted")), t.responses().last())
        host.dispose()
    }

    @Test
    fun `a real denial is reported permanent only when the OS stops offering a rationale`() = runTest {
        val perms = FakePermissions().declare("CAMERA").apply { rationaleAfterRequest = false }
        val host = newHost(listOf(PermissionRequestDriver(perms), PermissionQueryDriver(perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.DENIED, "permanently-denied"), t.responses().single())
        c.handleMessage(request(3, "permission.query", mapOf("permission" to "camera"), timeoutMs = 30_000))
        runCurrent()
        assertEquals(DeviceWire.result(3, mapOf("status" to "denied")), t.responses().last())
        // Bluetooth follows the same rule: the OS dialog is shown despite local "denied" history.
        val bt = FakeBluetooth()
        val btPerms = btPerms(granted = false).apply {
            requested += btScan
            denied += btScan
            userGrants = true
        }
        val host2 = newHost(listOf(BluetoothScanDriver(bt, btPerms, FakeIndicator())), consent = { ConsentDecision.CONTINUE })
        val (c2, t2) = connect(host2)
        c2.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(1, btPerms.requests)
        assertEquals(1, bt.starts)
        assertTrue(t2.responses().isEmpty())
        host.dispose()
        host2.dispose()
    }

    // ---- #11: the prompt gate is released when the presenting Activity goes away --------------------------

    @Test
    fun `a presenter gone releases the prompt gate while the result is still awaited`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery), PermissionRequestDriver(FakePermissions().declare("CAMERA").apply { userGrants = true })))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS, initialCredit = 65536))
        runCurrent()
        assertTrue(host.gate.isPromptActive)
        assertTrue(c.hasPresentingOperation)
        gallery.presenterGone!!() // the Activity hosting the picker was destroyed (not finishing)
        assertFalse(host.gate.isPromptActive)
        // Another prompt may run meanwhile; the pick still delivers its result later.
        c.handleMessage(request(3, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        assertEquals(DeviceWire.result(3, mapOf("status" to "granted")), t.responses().single())
        val data = "late".toByteArray()
        gallery.result.complete(listOf(PickedMedia("image/jpeg", 4, { data.inputStream() })))
        runCurrent()
        assertEquals(sha256Hex(data), (((t.responses().last()["result"] as Map<*, *>)["items"] as List<*>).single() as Map<*, *>)["sha256"])
        assertFalse(c.hasPresentingOperation)
        host.dispose()
    }

    // ---- #12: a disposed host offers nothing --------------------------------------------------------------

    @Test
    fun `a disposed host opens no connection and closes the ones it had`() = runTest {
        val host = newHost()
        val (c, _) = connect(host)
        host.dispose()
        assertTrue(c.isClosed)
        assertNull(host.openConnection(FakeTransport()))
    }

    // ---- #13: gallery mediaTypes -------------------------------------------------------------------------

    @Test
    fun `gallery mediaTypes must be one or two unique items`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", mapOf("mediaTypes" to emptyList<String>(), "maxCount" to 1)))
        c.handleMessage(request(3, "gallery.pick", mapOf("mediaTypes" to listOf("photo", "photo"), "maxCount" to 1)))
        runCurrent()
        assertEquals(listOf("invalidParams", "invalidParams"), t.responses().map(t::errorCode))
        assertEquals(0, gallery.picks)
        assertNull(GalleryParams.validate(mapOf("mediaTypes" to listOf("photo", "video"), "maxCount" to 16)))
        host.dispose()
    }

    // ---- #14: consent input arming ------------------------------------------------------------------------

    @Test
    fun `consent input is armed only after the dialog held focus long enough, and disarms on focus loss`() {
        var now = 1_000L
        val arming = ConsentInputArming(600) { now }
        assertFalse(arming.accepts()) // shown, not focused yet
        arming.onFocusChanged(true)
        now += 599
        assertFalse(arming.accepts()) // a tap timed to the dialog's appearance is ignored
        assertEquals(1, arming.remainingMs())
        now += 1
        assertTrue(arming.accepts())
        arming.onFocusChanged(true) // repeated focus does not restart the clock
        assertTrue(arming.accepts())
        arming.onFocusChanged(false) // covered: disarmed again
        assertFalse(arming.accepts())
        arming.onFocusChanged(true)
        now += 100
        assertFalse(arming.accepts())
    }

    // ---- #15 / D3 / D8: violation reactions -----------------------------------------------------------------

    @Test
    fun `a server deviceResponse terminates a live id and is ignored for unknown ids (D8)`() = runTest {
        val perms = FakePermissions().declare("CAMERA").apply { pendingRequest = CompletableDeferred() }
        val host = newHost(listOf(PermissionRequestDriver(perms)), config = DeviceHostConfig(origin = "wss://a:443", maxViolations = 1))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        c.handleMessage(mapOf("type" to "deviceResponse", "id" to 99L, "result" to mapOf("status" to "granted"))) // unknown: ignored
        runCurrent()
        assertTrue(t.sent.isEmpty())
        assertNull(t.closedWith)
        c.handleMessage(mapOf("type" to "deviceResponse", "id" to 2L, "result" to mapOf("status" to "granted")))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.INVALID_PARAMS, "deviceResponse from the server"), t.responses().single())
        c.handleMessage(mapOf("type" to "deviceResponse", "id" to 2L, "result" to mapOf("status" to "granted"))) // retired: ignored
        runCurrent()
        assertEquals(1, t.responses().size)
        assertNull(t.closedWith)
        host.dispose()
    }

    @Test
    fun `a bad frame header naming a live request is counted, never request-fatal (D3)`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        c.handleFrame(DeviceFrames.encode(FrameHeader(version = 2, channel = 0, requestId = 2, seq = 0), ByteArray(4)))
        c.handleFrame(DeviceFrames.encode(FrameHeader(flags = 1, channel = 0, requestId = 2, seq = 0), ByteArray(4)))
        c.handleMessage(control(2, "renewLease", 1))
        runCurrent()
        assertEquals(listOf(DeviceWire.control(2, Control.LeaseAck(1))), t.messages) // still live, nothing refused
        assertNull(t.closedWith)
        host.dispose()
    }

    // ---- #16: no raw exception text on the wire ---------------------------------------------------------------

    @Test
    fun `a failing driver reports a fixed token, never its exception text`() = runTest {
        val leaky = object : DeviceDriver {
            override val capability = "permission.query"

            override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

            override suspend fun run(ctx: DriverContext): DriverOutcome = throw IOException("cannot open content://com.example/private/photo.jpg")
        }
        val host = newHost(listOf(leaky))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.query", mapOf("permission" to "camera"), timeoutMs = 30_000))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.INTERNAL, "driver-failure"), t.responses().single())
        host.dispose()
    }

    // ---- connection model, owner order, progress, pause (RFC 001 §2.2 / §2.3 / §2.7) ---------------------------

    @Test
    fun `an app request before the core stream, or a second live core stream, closes the device connection`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())))
        val (c, t) = connect(host, openCore = false)
        c.handleMessage(request(1, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        assertEquals(1002, t.closedWith)
        assertTrue(c.isClosed)

        val (c2, t2) = connect(host)
        c2.handleMessage(coreRequest(2))
        runCurrent()
        assertEquals(1002, t2.closedWith)
        // A planned reopen (cancel first) is fine.
        val (c3, t3) = connect(host)
        c3.handleMessage(control(1, "cancel", true))
        c3.handleMessage(coreRequest(2))
        runCurrent()
        assertNull(t3.closedWith)
        assertEquals(2, t3.messages.size) // cancelled terminal + the new stream's snapshot
        host.dispose()
    }

    @Test
    fun `activation ids never go backwards per module instance`() = runTest {
        val host = newHost(listOf(PermissionQueryDriver(FakePermissions().declare("CAMERA"))))
        val (c, t) = connect(host)
        fun q(id: Long, module: String, activation: Long) =
            request(id, "permission.query", mapOf("permission" to "camera"), timeoutMs = 30_000, owner = mapOf("moduleInstanceId" to module, "activationId" to activation))
        c.handleMessage(q(2, "editor-1", 2))
        c.handleMessage(q(3, "editor-2", 1)) // another instance: independent
        c.handleMessage(q(4, "editor-1", 2)) // same activation: fine
        c.handleMessage(q(5, "editor-1", 1)) // older: refused
        runCurrent()
        assertEquals(listOf(null, null, null, "invalidParams"), t.responses().map(t::errorCode))
        assertEquals(DeviceWire.error(5, DeviceErrorCode.INVALID_PARAMS, "activationId went backwards"), t.responses().last())
        host.dispose()
    }

    @Test
    fun `exhausted upload credit is reported once as paused and resumed on grant`() = runTest {
        val data = ByteArray(100)
        val host = newHost(listOf(GalleryPickDriver(FixedGallery(listOf(PickedMedia("image/jpeg", 100, { data.inputStream() }))))))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS, initialCredit = 40))
        runCurrent()
        assertEquals(DeviceWire.control(2, Control.Paused(true)), t.messages.last())
        assertEquals(listOf(40), t.frames.map { it.decoded.payload.size })
        c.handleMessage(control(2, "grant", 30))
        runCurrent()
        c.handleMessage(control(2, "grant", 30))
        runCurrent()
        val controls = t.messages.mapNotNull { (it["control"] as? Map<*, *>)?.get("paused") }
        assertEquals(listOf(true, false, true, false), controls)
        assertEquals(listOf(40, 30, 30), t.frames.map { it.decoded.payload.size })
        assertEquals("deviceResponse", t.messages.last()["type"])
        host.dispose()
    }

    @Test
    fun `progress consumes no credit and never goes back to pendingConsent`() = runTest {
        lateinit var context: DriverContext
        val release = CompletableDeferred<Unit>()
        val driver = object : DeviceDriver {
            override val capability = "bluetooth.scan"

            override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

            override suspend fun run(ctx: DriverContext): DriverOutcome {
                context = ctx
                release.await()
                return DriverOutcome.Result()
            }
        }
        val host = newHost(listOf(driver))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 1))
        runCurrent()
        context.progress(ProgressState.PENDING_CONSENT)
        context.progress(ProgressState.RUNNING)
        context.emit(mapOf("device" to mapOf("id" to "a", "rssi" to -1)))
        context.progress(ProgressState.PENDING_CONSENT) // regression: ignored
        context.emit(mapOf("device" to mapOf("id" to "b", "rssi" to -1))) // no credit left: buffered
        assertEquals(
            listOf(
                DeviceWire.event(2, DeviceWire.progress(ProgressState.PENDING_CONSENT)),
                DeviceWire.event(2, DeviceWire.progress(ProgressState.RUNNING)),
                DeviceWire.event(2, mapOf("device" to mapOf("id" to "a", "rssi" to -1))),
            ),
            t.messages,
        )
        context.emit(mapOf("device" to mapOf("id" to "x", "rssi" to 99_999))) // invalid event: internal, never sent
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.INTERNAL, "invalid-event"), t.responses().single())
        release.complete(Unit)
        host.dispose()
    }
}
