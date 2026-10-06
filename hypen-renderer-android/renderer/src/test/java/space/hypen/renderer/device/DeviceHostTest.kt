@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceHostTest {
    // ---- handshake -----------------------------------------------------------

    @Test
    fun `advertisement carries protocol, binary and core capabilities first`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())))
        val adv = host.advertisement()!!
        assertEquals(listOf(1L), adv["protocolVersions"])
        assertEquals(true, adv["binary"])
        assertEquals(
            listOf(
                mapOf("name" to "core.capabilities", "versions" to listOf(1L)),
                mapOf("name" to "gallery.pick", "versions" to listOf(1L)),
            ),
            adv["capabilities"],
        )
        host.dispose()
    }

    @Test
    fun `device messages are dropped until the ack enables the plane, and without device extension`() = runTest {
        val host = newHost()
        val t = FakeTransport()
        val c = host.openWithHello(t)
        c.handleMessage(coreRequest(1))
        runCurrent()
        assertTrue(t.sent.isEmpty())
        c.onAck(null) // server omitted sessionAck.device: not selected (yet)
        c.handleMessage(coreRequest(2))
        runCurrent()
        assertFalse(c.isEnabled)
        assertTrue(t.sent.isEmpty())
        host.dispose()
    }

    @Test
    fun `ack selecting only an unoffered capability or another protocol disables the plane`() = runTest {
        val host = newHost()
        val c = host.openWithHello()
        c.onAck(mapOf("protocolVersion" to 1, "binary" to true, "capabilities" to listOf(mapOf("name" to "mic.record", "version" to 1))))
        runCurrent()
        assertFalse(c.isEnabled)
        val c2 = host.openWithHello()
        c2.onAck(mapOf("protocolVersion" to 2, "binary" to true, "capabilities" to listOf(mapOf("name" to "core.capabilities", "version" to 1))))
        runCurrent()
        assertFalse(c2.isEnabled)
        host.dispose()
    }

    // ---- core.capabilities -----------------------------------------------------

    @Test
    fun `core capabilities emits the full advertisement, idles, and settles once on cancel`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())))
        val (c, t) = connect(host, openCore = false)
        c.handleMessage(coreRequest(1))
        runCurrent()
        assertEquals(
            listOf(mapOf("type" to "deviceEvent", "id" to 1L, "event" to mapOf("capabilities" to host.offers()))),
            t.messages,
        )
        c.handleMessage(control(1, "cancel", true))
        runCurrent()
        assertEquals(DeviceWire.error(1, DeviceErrorCode.CANCELLED), t.messages.last())
        c.handleMessage(control(1, "cancel", true)) // retired id: ignored
        runCurrent()
        assertEquals(2, t.messages.size)
        host.dispose()
    }

    // ---- request validation ------------------------------------------------------

    @Test
    fun `unsupported capability and revision reply unsupported`() = runTest {
        val host = newHost()
        val (c, t) = connect(host)
        c.handleMessage(request(2, "mic.record", mapOf("format" to "pcm16", "sampleRate" to 16000)))
        c.handleMessage(request(3, "core.capabilities", version = 2, owner = CONNECTION_OWNER, lifetime = "connection"))
        c.handleMessage(request(4, "camera.teleport"))
        runCurrent()
        assertEquals(listOf("unsupported", "unsupported", "unsupported"), t.responses().map(t::errorCode))
        assertEquals(listOf(2L, 3L, 4L), t.responses().map { it["id"] })
        host.dispose()
    }

    @Test
    fun `binary capability without negotiated binary profile is unsupported`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())))
        val (c, t) = connect(host, binary = false)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS, initialCredit = 65536))
        runCurrent()
        assertEquals("unsupported", t.errorCode(t.responses().single()))
        host.dispose()
    }

    @Test
    fun `invalid params, owner-lifetime mismatch and excess credit reply invalidParams`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", mapOf("mediaTypes" to listOf("photo"), "maxCount" to 99)))
        c.handleMessage(request(3, "gallery.pick", GALLERY_PARAMS + ("extra" to 1)))
        c.handleMessage(request(4, "gallery.pick", GALLERY_PARAMS, owner = mapOf("connection" to true)))
        c.handleMessage(request(5, "gallery.pick", GALLERY_PARAMS, owner = mapOf("connection" to true), lifetime = "connection"))
        c.handleMessage(request(6, "gallery.pick", GALLERY_PARAMS, initialCredit = 64L * 1024 * 1024))
        runCurrent()
        assertEquals(List(5) { "invalidParams" }, t.responses().map(t::errorCode))
        host.dispose()
    }

    @Test
    fun `duplicate and older request ids are dropped without executing`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)))
        val (c, t) = connect(host)
        c.handleMessage(request(5, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        c.handleMessage(request(5, "gallery.pick", GALLERY_PARAMS))
        c.handleMessage(request(4, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        assertEquals(1, gallery.picks)
        assertTrue(t.responses().isEmpty())
        host.dispose()
    }

    // ---- leases ------------------------------------------------------------------

    @Test
    fun `renewLease is echoed as leaseAck even while pending, and keeps the request alive`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)))
        val (c, t) = connect(host)
        c.handleMessage(request(17, "gallery.pick", GALLERY_PARAMS))
        c.handleMessage(control(17, "renewLease", 1))
        runCurrent()
        assertEquals(DeviceWire.control(17, Control.LeaseAck(1)), t.messages.single())
        // Renew every 5 s for 60 s: never expires.
        for (seq in 2L..13L) {
            testScheduler.advanceTimeBy(5_000)
            c.handleMessage(control(17, "renewLease", seq))
            runCurrent()
        }
        // (The never-renewed core stream, id 1, expired meanwhile.)
        assertTrue(t.responses().none { it["id"] == 17L })
        assertEquals((1L..13L).map { DeviceWire.control(17, Control.LeaseAck(it)) }, t.messages.filter { it["id"] == 17L })
        host.dispose()
    }

    @Test
    fun `renewals start at 1 and strictly increase, gaps allowed, otherwise invalidParams`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        c.handleMessage(control(2, "renewLease", 1))
        c.handleMessage(control(2, "renewLease", 4)) // a skipped renewal is fine
        runCurrent()
        assertEquals(listOf(DeviceWire.control(2, Control.LeaseAck(1)), DeviceWire.control(2, Control.LeaseAck(4))), t.messages)
        c.handleMessage(control(2, "renewLease", 4)) // repeat (transcript violation-renew-lease-not-increasing)
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.INVALID_PARAMS, "renewLease must strictly increase"), t.responses().single())

        c.handleMessage(request(3, "gallery.pick", GALLERY_PARAMS))
        c.handleMessage(control(3, "renewLease", 4_294_967_295L)) // violation-renew-lease-not-starting-at-1
        runCurrent()
        assertEquals(DeviceWire.error(3, DeviceErrorCode.INVALID_PARAMS, "first renewLease must be 1"), t.responses().last())
        host.dispose()
    }

    @Test
    fun `silence expires the client lease with connectionLost and late renewals cannot revive it`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        testScheduler.advanceTimeBy(15_001)
        runCurrent()
        // The core stream (never renewed here) expired too.
        assertEquals("connectionLost", t.errorCode(t.responses().single { it["id"] == 2L }))
        assertEquals(1, gallery.cancelledPicks)
        t.sent.clear()
        c.handleMessage(control(2, "renewLease", 1))
        runCurrent()
        assertTrue(t.messages.isEmpty()) // no ack for a retired id
        host.dispose()
    }

    // ---- cancellation --------------------------------------------------------------

    /** Finishes with a blob result only after [release] — even if cancelled (undismissable OS dialog). */
    private class StubbornUploadDriver : DeviceDriver {
        val release = CompletableDeferred<Unit>()
        var blobReleased = false
        override val capability = "gallery.pick"
        override val binary = true

        override fun validateParams(version: Long, params: Map<String, Any?>) = GalleryParams.validate(params)

        override suspend fun run(ctx: DriverContext): DriverOutcome = withContext(NonCancellable) {
            release.await()
            DriverOutcome.Result(
                blobs = listOf(DriverBlob(0, "image/jpeg", 3, { "abc".byteInputStream() }, { blobReleased = true })),
            )
        }
    }

    @Test
    fun `server cancel settles cancelled once and suppresses the late driver result and bytes`() = runTest {
        val driver = StubbornUploadDriver()
        val host = newHost(listOf(driver))
        val (c, t) = connect(host)
        c.handleMessage(request(3, "gallery.pick", GALLERY_PARAMS, initialCredit = 65536))
        runCurrent()
        c.handleMessage(control(3, "cancel", true))
        runCurrent()
        assertEquals(listOf(DeviceWire.error(3, DeviceErrorCode.CANCELLED)), t.messages)
        driver.release.complete(Unit)
        runCurrent()
        assertEquals(1, t.sent.size) // no blobStart, no frames, no second terminal
        assertTrue(driver.blobReleased)
        host.dispose()
    }

    @Test
    fun `closing the connection stops drivers and sends nothing more`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        c.close()
        runCurrent()
        assertEquals(1, gallery.cancelledPicks)
        c.handleMessage(control(2, "renewLease", 1))
        testScheduler.advanceTimeBy(20_000)
        runCurrent()
        assertTrue(t.sent.isEmpty())
        host.dispose()
    }

    // ---- deadlines -------------------------------------------------------------------

    @Test
    fun `deadline is shortened by the local maximum and reported as timeout`() = runTest {
        val perms = FakePermissions().declare("CAMERA")
        perms.pendingRequest = CompletableDeferred() // OS dialog never answers
        val host = newHost(listOf(PermissionRequestDriver(perms)), config = DeviceHostConfig(origin = "wss://a:443", localMaxTimeoutMs = 20_000))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.request", mapOf("permission" to "camera"), timeoutMs = 300_000))
        for (seq in 1L..3L) {
            c.handleMessage(control(2, "renewLease", seq))
            c.handleMessage(control(1, "renewLease", seq))
            runCurrent()
            testScheduler.advanceTimeBy(5_000)
        }
        c.handleMessage(control(2, "renewLease", 4))
        c.handleMessage(control(1, "renewLease", 4))
        runCurrent()
        assertTrue(t.responses().isEmpty())
        testScheduler.advanceTimeBy(5_001) // t = 20 s: local maximum wins over 300 s
        runCurrent()
        assertEquals("timeout", t.errorCode(t.responses().single()))
        host.dispose()
    }

    // ---- blob upload -----------------------------------------------------------------

    private fun bytes(n: Int) = ByteArray(n) { (it * 31 + 7).toByte() }

    private class FixedGallery(val items: List<PickedMedia>) : GalleryPlatform {
        override fun canPresent() = true

        override suspend fun pick(request: GalleryPickRequest, maxItemBytes: Long, presenterGone: () -> Unit) = items
    }

    @Test
    fun `upload announces, chunks at 64 KiB with contiguous seq, then returns sha256 items`() = runTest {
        val data = bytes(150_000)
        var released = false
        val host = newHost(
            listOf(GalleryPickDriver(FixedGallery(listOf(PickedMedia("image/jpeg", data.size.toLong(), { data.inputStream() }, { released = true }))))),
        )
        val (c, t) = connect(host)
        c.handleMessage(request(9, "gallery.pick", GALLERY_PARAMS, initialCredit = 4L * 1024 * 1024))
        runCurrent()

        val first = t.sent.first() as Sent.Msg
        assertEquals(DeviceWire.event(9, DeviceWire.blobStart(0, "image/jpeg", 150_000)), first.message)
        val frames = t.frames
        assertEquals(listOf(65_536, 65_536, 18_928), frames.map { it.decoded.payload.size })
        assertEquals(listOf(0L, 1L, 2L), frames.map { it.decoded.header.seq })
        assertTrue(frames.all { it.decoded.header.requestId == 9L && it.decoded.header.channel == 0 && it.bytes.size <= 12 + 65_536 })
        val reassembled = frames.flatMap { it.decoded.payload.toList() }.toByteArray()
        assertTrue(reassembled.contentEquals(data))

        val last = (t.sent.last() as Sent.Msg).message
        assertEquals(
            DeviceWire.result(
                9,
                mapOf("items" to listOf(mapOf("channel" to 0, "contentType" to "image/jpeg", "bytes" to 150_000L, "sha256" to sha256Hex(data)))),
            ),
            last,
        )
        assertEquals(5, t.sent.size)
        assertTrue(released)
        host.dispose()
    }

    @Test
    fun `sha256 matches the shared fixture item`() = runTest {
        val data = "hello-hypen-photo".toByteArray()
        val host = newHost(listOf(GalleryPickDriver(FixedGallery(listOf(PickedMedia("image/jpeg", 17, { data.inputStream() }))))))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS, initialCredit = 65536))
        runCurrent()
        // engine-compatibility-tests/fixtures/device/transcripts/gallery-pick-upload.json
        assertEquals("01000000020000000000000068656c6c6f2d687970656e2d70686f746f", hex(t.frames.single().bytes))
        val item = ((t.responses().single()["result"] as Map<*, *>)["items"] as List<*>).single() as Map<*, *>
        assertEquals("5ed7ddab0fc86c9cadfcd6033e603644db19c156e7167dcced16b839f422a347", item["sha256"])
        host.dispose()
    }

    @Test
    fun `upload is paced by credit and resumes on grant`() = runTest {
        val data = bytes(100_000)
        val host = newHost(listOf(GalleryPickDriver(FixedGallery(listOf(PickedMedia("image/png", data.size.toLong(), { data.inputStream() }))))))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS, initialCredit = 65_536))
        runCurrent()
        assertEquals(listOf(65_536), t.frames.map { it.decoded.payload.size })
        assertTrue(t.responses().isEmpty())
        c.handleMessage(control(2, "renewLease", 1)) // control still serviced while starved
        c.handleMessage(control(2, "grant", 20_000))
        runCurrent()
        assertEquals(listOf(65_536, 20_000), t.frames.map { it.decoded.payload.size })
        c.handleMessage(control(2, "grant", 1_000_000))
        runCurrent()
        assertEquals(listOf(65_536, 20_000, 14_464), t.frames.map { it.decoded.payload.size })
        assertEquals(sha256Hex(data), (((t.responses().single()["result"] as Map<*, *>)["items"] as List<*>).single() as Map<*, *>)["sha256"])
        host.dispose()
    }

    @Test
    fun `credit overflow and wrong-direction controls terminate with invalidParams`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS, initialCredit = 4L * 1024 * 1024))
        runCurrent()
        c.handleMessage(control(2, "grant", 8L * 1024 * 1024)) // exceeds 8 MiB outstanding
        c.handleMessage(control(1, "leaseAck", 1)) // client → server only (on the core stream)
        runCurrent()
        assertEquals(listOf(2L, 1L), t.responses().map { it["id"] })
        assertEquals(listOf("invalidParams", "invalidParams"), t.responses().map(t::errorCode))
        host.dispose()
    }

    @Test
    fun `an empty item is announced and sends no frames (D2)`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FixedGallery(listOf(PickedMedia("image/gif", 0, { ByteArray(0).inputStream() }))))))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        assertTrue(t.frames.isEmpty())
        assertEquals(DeviceWire.event(2, DeviceWire.blobStart(0, "image/gif", 0)), t.messages.first())
        assertEquals(sha256Hex(ByteArray(0)), (((t.responses().single()["result"] as Map<*, *>)["items"] as List<*>).single() as Map<*, *>)["sha256"])
        host.dispose()
    }

    @Test
    fun `a stream shorter than its declared size fails internal`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FixedGallery(listOf(PickedMedia("image/jpeg", 10, { ByteArray(4).inputStream() }))))))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS, initialCredit = 65536))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.INTERNAL, "item shorter than declared"), t.responses().single())
        host.dispose()
    }

    @Test
    fun `bulk enqueueing waits while the transport holds 256 KiB`() = runTest {
        val data = bytes(10)
        val host = newHost(listOf(GalleryPickDriver(FixedGallery(listOf(PickedMedia("image/jpeg", 10, { data.inputStream() }))))))
        val (c, t) = connect(host)
        t.pending = 256L * 1024
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS, initialCredit = 65536))
        runCurrent()
        testScheduler.advanceTimeBy(100)
        runCurrent()
        assertTrue(t.frames.isEmpty())
        t.pending = 0
        testScheduler.advanceTimeBy(20)
        runCurrent()
        assertEquals(1, t.frames.size)
        host.dispose()
    }

    // ---- admission ---------------------------------------------------------------------

    @Test
    fun `one prompt at a time across connections, others throttled`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)))
        val (c1, t1) = connect(host)
        val (c2, t2) = connect(host)
        c1.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        c1.handleMessage(request(3, "gallery.pick", GALLERY_PARAMS))
        c2.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        assertEquals(DeviceWire.error(3, DeviceErrorCode.THROTTLED, "prompt-in-progress"), t1.responses().single())
        assertEquals(DeviceWire.error(2, DeviceErrorCode.THROTTLED, "prompt-in-progress"), t2.responses().single())
        assertEquals(1, gallery.picks)
        // Picker dismissed: cancelled, gate released (after a short dismissal cooldown).
        gallery.result.complete(emptyList())
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.CANCELLED, "picker-dismissed"), t1.responses().last())
        gallery.result = CompletableDeferred()
        c2.handleMessage(request(3, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        assertEquals(DeviceWire.error(3, DeviceErrorCode.THROTTLED, "cooldown"), t2.responses().last())
        testScheduler.advanceTimeBy(3_001)
        c2.handleMessage(request(4, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        assertEquals(2, gallery.picks)
        host.dispose()
    }

    @Test
    fun `no foreground activity means unavailable`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery(foreground = false))))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "no-foreground-activity"), t.responses().single())
        host.dispose()
    }

    @Test
    fun `permission denial starts a cooldown that survives reconnect`() = runTest {
        val perms = FakePermissions().declare("CAMERA").apply { rationaleAfterRequest = true }
        val host = newHost(listOf(PermissionRequestDriver(perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.DENIED, "user-declined"), t.responses().single())
        // Android would allow asking again (rationale true)...
        c.close()
        val (c2, t2) = connect(host)
        c2.handleMessage(request(2, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.THROTTLED, "cooldown"), t2.responses().single()) // ...but the host cools down
        testScheduler.advanceTimeBy(30_001)
        perms.userGrants = true
        c2.handleMessage(request(3, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        assertEquals(DeviceWire.result(3, mapOf("status" to "granted")), t2.responses().last())
        assertEquals(2, perms.requests)
        host.dispose()
    }

    @Test
    fun `permission query never prompts and maps history to prompt or denied`() = runTest {
        val perms = FakePermissions().declare("CAMERA", "RECORD_AUDIO")
        val host = newHost(listOf(PermissionQueryDriver(perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.query", mapOf("permission" to "camera"), timeoutMs = 30_000))
        // An explicit OS denial with no rationale is the only evidence of "denied".
        perms.requested += "android.permission.RECORD_AUDIO"
        perms.denied += "android.permission.RECORD_AUDIO"
        c.handleMessage(request(3, "permission.query", mapOf("permission" to "microphone"), timeoutMs = 30_000))
        c.handleMessage(request(4, "permission.query", mapOf("permission" to "contacts"), timeoutMs = 30_000))
        c.handleMessage(request(5, "permission.query", mapOf("permission" to "teleport"), timeoutMs = 30_000))
        c.handleMessage(request(6, "permission.query", mapOf("permission" to "geolocation"), timeoutMs = 30_000))
        runCurrent()
        assertEquals(
            listOf(
                DeviceWire.result(2, mapOf("status" to "prompt")),
                DeviceWire.result(3, mapOf("status" to "denied")),
                DeviceWire.error(4, DeviceErrorCode.UNAVAILABLE, "not-declared:contacts"),
            ),
            t.responses().take(3),
        )
        // P1: names outside the closed enum (typos, the dropped geolocation alias) fail at decode.
        assertEquals(listOf("invalidParams", "invalidParams"), t.responses().drop(3).map { t.errorCode(it) })
        assertEquals(0, perms.requests)
        host.dispose()
    }

    // ---- bluetooth.scan --------------------------------------------------------------------

    private fun btPerms() = FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN")

    @Test
    fun `bluetooth adapter off is unavailable`() = runTest {
        val host = newHost(listOf(BluetoothScanDriver(FakeBluetooth(AdapterState.OFF), btPerms(), FakeIndicator())))
        val (c, t) = connect(host)
        c.handleMessage(request(4, "bluetooth.scan", timeoutMs = 600_000, initialCredit = 64))
        runCurrent()
        assertEquals(DeviceWire.error(4, DeviceErrorCode.UNAVAILABLE, "adapter-off"), t.responses().single())
        host.dispose()
    }

    @Test
    fun `bluetooth host consent refusal is denied with cooldown`() = runTest {
        val host = newHost(listOf(BluetoothScanDriver(FakeBluetooth(), btPerms(), FakeIndicator())), consent = { ConsentDecision.CANCEL })
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        c.handleMessage(request(3, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(
            listOf(DeviceWire.error(2, DeviceErrorCode.DENIED, "host-refused"), DeviceWire.error(3, DeviceErrorCode.THROTTLED, "cooldown")),
            t.responses(),
        )
        host.dispose()
    }

    @Test
    fun `bluetooth OS permission refusal is denied, headless consent is unavailable`() = runTest {
        val bt = FakeBluetooth()
        val host = newHost(listOf(BluetoothScanDriver(bt, btPerms().apply { rationaleAfterRequest = true }, FakeIndicator())), consent = { ConsentDecision.CONTINUE })
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.DENIED, "permission-denied"), t.responses().single())
        assertEquals(0, bt.starts)

        val headless = newHost(listOf(BluetoothScanDriver(FakeBluetooth(), btPerms(), FakeIndicator())))
        val (c2, t2) = connect(headless)
        c2.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "consent-unavailable"), t2.responses().single())
        host.dispose()
        headless.dispose()
    }

    @Test
    fun `bluetooth scan streams coalesced device events and stops on cancel`() = runTest {
        val bt = FakeBluetooth()
        val perms = btPerms().apply { userGrants = true }
        var prompts = 0
        val host = newHost(listOf(BluetoothScanDriver(bt, perms, FakeIndicator())), consent = { prompts += 1; ConsentDecision.CONTINUE })
        val (c, t) = connect(host)
        c.handleMessage(request(4, "bluetooth.scan", timeoutMs = 600_000, initialCredit = 64))
        runCurrent()
        val l = bt.listener!!
        l.onDevice("aa:bb:cc:dd:ee:ff", "Speaker", -41)
        l.onDevice("aa:bb:cc:dd:ee:ff", "Speaker", -43) // within 1 s, small delta: coalesced away
        l.onDevice("11:22:33:44:55:66", null, -70)
        runCurrent()
        testScheduler.advanceTimeBy(1_000)
        l.onDevice("aa:bb:cc:dd:ee:ff", null, -44) // due again; keeps the learned name
        runCurrent()
        val events = t.messages.filter { it["event"] != null }.map { it["event"] }
        assertEquals(
            listOf(
                mapOf("device" to mapOf("id" to "aa:bb:cc:dd:ee:ff", "name" to "Speaker", "rssi" to -41)),
                mapOf("device" to mapOf("id" to "11:22:33:44:55:66", "rssi" to -70)),
                mapOf("device" to mapOf("id" to "aa:bb:cc:dd:ee:ff", "name" to "Speaker", "rssi" to -44)),
            ),
            events,
        )
        c.handleMessage(control(4, "cancel", true))
        runCurrent()
        assertEquals(1, bt.stopped)
        assertEquals(DeviceWire.error(4, DeviceErrorCode.CANCELLED), t.responses().single())

        // Consent persisted for this (wss) origin: a second scan does not prompt again.
        c.handleMessage(request(5, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(1, prompts)
        assertEquals(2, bt.starts)
        host.dispose()
    }

    @Test
    fun `credit-starved stream coalesces per device id and flushes on grant`() = runTest {
        val bt = FakeBluetooth()
        val perms = btPerms().apply { granted += "android.permission.BLUETOOTH_SCAN" }
        val host = newHost(listOf(BluetoothScanDriver(bt, perms, FakeIndicator(), coalesceIntervalMs = 0)), consent = { ConsentDecision.CONTINUE })
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 1))
        runCurrent()
        val l = bt.listener!!
        l.onDevice("A", null, -10)
        l.onDevice("B", null, -20)
        l.onDevice("B", null, -30)
        l.onDevice("C", null, -40)
        l.onDevice("B", null, -50)
        runCurrent()
        assertEquals(1, t.messages.count { it["event"] != null })
        c.handleMessage(control(2, "grant", 10))
        runCurrent()
        val ids = t.messages.mapNotNull { (it["event"] as? Map<*, *>)?.get("device") as? Map<*, *> }.map { it["id"] to it["rssi"] }
        assertEquals(listOf("A" to -10, "C" to -40, "B" to -50), ids)
        host.dispose()
    }

    @Test
    fun `lease expiry and host suspension stop the scan`() = runTest {
        val bt = FakeBluetooth()
        val perms = btPerms().apply { granted += "android.permission.BLUETOOTH_SCAN" }
        val host = newHost(listOf(BluetoothScanDriver(bt, perms, FakeIndicator())), consent = { ConsentDecision.CONTINUE })
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        testScheduler.advanceTimeBy(15_001)
        runCurrent()
        assertEquals(1, bt.stopped)
        assertEquals("connectionLost", t.errorCode(t.responses().single { it["id"] == 2L }))

        c.handleMessage(request(3, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        host.onHostSuspended()
        runCurrent()
        assertEquals(2, bt.stopped)
        assertEquals(DeviceWire.error(3, DeviceErrorCode.CANCELLED, "host-suspended"), t.responses().last())
        host.dispose()
    }

    @Test
    fun `host suspension caused by the picker itself does not cancel the pick`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        host.onHostSuspended()
        runCurrent()
        assertTrue(t.responses().isEmpty())
        assertEquals(0, gallery.cancelledPicks)
        host.dispose()
    }

    // ---- binary frames from the server --------------------------------------------------------

    @Test
    fun `server frames - short dropped, unknown id dropped, known id terminates, header violations count and close when repeated`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())), config = DeviceHostConfig(origin = "wss://a:443", maxViolations = 2))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        c.handleMessage(request(3, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        t.sent.clear() // request 3 was throttled (one prompt at a time)
        c.handleFrame(ByteArray(11))
        c.handleFrame(DeviceFrames.encode(FrameHeader(channel = 0, requestId = 99, seq = 0), ByteArray(3)))
        runCurrent()
        assertTrue(t.sent.isEmpty())
        c.handleFrame(DeviceFrames.encode(FrameHeader(channel = 0, requestId = 2, seq = 0), ByteArray(3)))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.INVALID_PARAMS, "unexpected frame on channel 0"), t.responses().single())
        // Bad version/flags: connection-level (D3), never request-fatal, closed only when repeated.
        c.handleFrame(DeviceFrames.encode(FrameHeader(version = 2, channel = 0, requestId = 1, seq = 0), ByteArray(3)))
        runCurrent()
        assertNull(t.closedWith)
        c.handleFrame(DeviceFrames.encode(FrameHeader(flags = 1, channel = 0, requestId = 1, seq = 0), ByteArray(3)))
        runCurrent()
        assertEquals(1002, t.closedWith)
        assertTrue(c.isClosed)
        host.dispose()
    }

    // ---- pure helpers ---------------------------------------------------------------------------

    @Test
    fun `origin normalization and authentication`() {
        assertEquals("wss://app.example:443", normalizeOrigin("wss://App.Example/session?x=1"))
        assertEquals("ws://10.0.2.2:3000", normalizeOrigin("ws://10.0.2.2:3000/"))
        assertEquals("ws://host:80", normalizeOrigin("ws://host"))
        assertTrue(isAuthenticatedOrigin("wss://app.example:443"))
        assertFalse(isAuthenticatedOrigin("ws://10.0.2.2:3000"))
    }

    @Test
    fun `bluetooth permission mapping follows the API level`() {
        assertEquals(listOf("android.permission.BLUETOOTH_SCAN"), PermissionNames.resolve("bluetooth", 31)!!.permissions)
        assertEquals(listOf("android.permission.ACCESS_FINE_LOCATION"), PermissionNames.resolve("bluetooth", 30)!!.permissions)
        assertEquals(emptyList<String>(), PermissionNames.resolve("notifications", 32)!!.permissions)
        assertEquals(listOf("android.permission.POST_NOTIFICATIONS"), PermissionNames.resolve("notifications", 33)!!.permissions)
        assertNull(PermissionNames.resolve("android.permission.CAMERA", 34))
    }

    @Test
    fun `wire parser rejects non-integral number tokens and malformed controls`() {
        // Doubles in the tree are non-integral tokens (1.0, 1e0, -0): never integers.
        val parsed = DeviceWire.parseRequest(
            request(1, "gallery.pick", GALLERY_PARAMS).mapValues { (k, v) -> if (v is Long && k != "type") v.toDouble() else v },
        )
        assertEquals(Parsed.Invalid(null, "deviceRequest id missing or out of range"), parsed)
        assertTrue(DeviceWire.parseRequest(request(1, "gallery.pick", GALLERY_PARAMS) + ("version" to 1.0)) is Parsed.Invalid)
        assertTrue(DeviceWire.parseEvent(mapOf("type" to "deviceEvent", "id" to 1.0, "control" to mapOf("renewLease" to 1))) is Parsed.Invalid)
        assertTrue(DeviceWire.parseEvent(mapOf("type" to "deviceEvent", "id" to 1, "control" to mapOf("grant" to 1.0))) is Parsed.Invalid)
        assertTrue(DeviceWire.parseEvent(mapOf("type" to "deviceEvent", "id" to 1.0, "control" to mapOf("renewLease" to 1.5))) is Parsed.Invalid)
        assertTrue(DeviceWire.parseEvent(mapOf("type" to "deviceEvent", "id" to 1, "control" to mapOf("cancel" to true, "grant" to 1))) is Parsed.Invalid)
        assertTrue(DeviceWire.parseEvent(mapOf("type" to "deviceEvent", "id" to 1, "event" to emptyMap<String, Any>(), "control" to mapOf("cancel" to true))) is Parsed.Invalid)
        assertEquals(Parsed.Invalid(null, "deviceRequest id missing or out of range"), DeviceWire.parseRequest(request(0, "x")))
    }
}
