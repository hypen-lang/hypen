@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException

/**
 * Round-3 Android drivers (RFC 001 C1–C4, P1) through fakes of their
 * platform seams, end to end through the real [DeviceConnection]: typed
 * permissions, `file.pick`, `file.save` with the server → client download
 * plane, `camera.capture`, `mic.record` and `bluetooth.select`.
 */
class DeviceCaptureDriversTest {
    // ---- fakes -----------------------------------------------------------------------------

    class FakeConsent(var decision: ConsentDecision = ConsentDecision.CONTINUE) : ConsentPresenter {
        val prompts = mutableListOf<ConsentPrompt>()
        var hold: CompletableDeferred<Unit>? = null

        override suspend fun present(prompt: ConsentPrompt): ConsentDecision {
            prompts += prompt
            hold?.await()
            return decision
        }
    }

    class FakePick(var docs: List<PickedDocument> = emptyList()) : FilePickPlatform {
        var mimeTypes: List<String>? = null
        var multiple: Boolean? = null
        var foreground = true

        override fun canPresent() = foreground

        override fun mimeForExtension(ext: String): String? = mapOf("pdf" to "application/pdf", "txt" to "text/plain")[ext]

        override suspend fun pick(mimeTypes: List<String>, multiple: Boolean, maxItemBytes: Long, presenterGone: () -> Unit): List<PickedDocument> {
            this.mimeTypes = mimeTypes
            this.multiple = multiple
            return docs
        }
    }

    class FakeTarget(private val failAt: Long? = null) : SaveTarget {
        val bytes = ByteArrayOutputStream()
        var committed = false
        var discarded = 0

        override suspend fun write(bytes: ByteArray) {
            if (failAt != null && this.bytes.size() + bytes.size > failAt) throw IOException("disk full")
            this.bytes.write(bytes)
        }

        override suspend fun commit() {
            committed = true
        }

        override suspend fun discard() {
            discarded += 1
        }
    }

    class FakeSave(var target: FakeTarget? = FakeTarget()) : FileSavePlatform {
        val destination = CompletableDeferred<Unit>()
        var requests = mutableListOf<Pair<String, String>>()

        override fun canPresent() = true

        override suspend fun createDocument(name: String, contentType: String, presenterGone: () -> Unit): SaveTarget? {
            requests += name to contentType
            destination.await()
            return target
        }
    }

    class FakeCamera : CameraPlatform {
        var result = CompletableDeferred<CapturedMedia?>()
        var request: CameraCaptureRequest? = null
        var has = true

        override fun hasCamera() = has

        override fun canPresent() = true

        override suspend fun capture(request: CameraCaptureRequest, maxItemBytes: Long, presenterGone: () -> Unit): CapturedMedia? {
            this.request = request
            return result.await()
        }
    }

    class FakeAudio : AudioCapturePlatform {
        var sink: AudioSink? = null
        var format: AudioCaptureFormat? = null
        var stops = 0
        var startError: DeviceDriverException? = null

        override fun hasMicrophone() = true

        override fun start(format: AudioCaptureFormat, sink: AudioSink): CaptureHandle {
            startError?.let { throw it }
            this.format = format
            this.sink = sink
            return CaptureHandle { stops += 1 }
        }

        fun push(n: Int, fill: Int = 7) = sink!!.onPcm(ByteArray(n) { (fill + it).toByte() })
    }

    class FakeChooser : BluetoothChooser {
        var devices: StateFlow<List<BluetoothChooserEntry>>? = null
        var origin: String? = null
        var result = CompletableDeferred<BluetoothChoice>()
        var cancelled = 0

        override suspend fun choose(origin: String, devices: StateFlow<List<BluetoothChooserEntry>>): BluetoothChoice {
            this.origin = origin
            this.devices = devices
            try {
                return result.await()
            } catch (e: CancellationException) {
                cancelled += 1
                throw e
            }
        }
    }

    private fun grants(t: FakeTransport, id: Long = 2): List<Long> =
        t.messages.filter { DeviceWire.exactLong(it["id"]) == id }.mapNotNull { (it["control"] as? Map<*, *>)?.get("grant") as Long? }

    private fun progress(t: FakeTransport, id: Long = 2): List<String> =
        t.messages.filter { DeviceWire.exactLong(it["id"]) == id }.mapNotNull { m -> (m["event"] as? Map<*, *>)?.takeIf { it["kind"] == "progress" }?.get("state") as String? }

    private fun result(t: FakeTransport): Map<*, *> = t.responses().single()["result"] as Map<*, *>

    private fun uploaded(t: FakeTransport, id: Long = 2, channel: Int = 0): ByteArray {
        val out = ByteArrayOutputStream()
        t.frames.map { it.decoded }.filter { it.header.requestId == id && it.header.channel == channel }.forEach { out.write(it.payload) }
        return out.toByteArray()
    }

    // ---- P1 typed permissions ---------------------------------------------------------------------

    @Test
    fun `every permission of the closed enum maps on every API level and nothing else resolves`() {
        assertEquals(listOf("camera", "microphone", "photos", "location", "notifications", "bluetooth", "contacts"), DevicePermissions.ALL)
        for (sdk in listOf(24, 29, 30, 31, 33, 34)) {
            for (name in DevicePermissions.ALL) assertNotNull("$name@$sdk", PermissionNames.resolve(name, sdk))
            for (bad in listOf("geolocation", "Camera", "camra", "android.permission.CAMERA", "")) assertNull(PermissionNames.resolve(bad, sdk))
        }
        for (cap in listOf("permission.query", "permission.request")) {
            for (name in DevicePermissions.ALL) assertNull(DevicePayloads.validate(cap, 1, PayloadKind.PARAMS, mapOf("permission" to name)))
            for (bad in listOf("geolocation", "camra", "CAMERA", "camera ")) {
                assertNotNull(bad, DevicePayloads.validate(cap, 1, PayloadKind.PARAMS, mapOf("permission" to bad)))
            }
        }
        assertEquals(DriverOutcome.Error(DeviceErrorCode.UNSUPPORTED, "contacts"), PermissionLogic.unsupported("contacts"))
    }

    @Test
    fun `location is the only location name - geolocation is refused invalidParams before any driver runs`() = runTest {
        val perms = FakePermissions().declare("ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION")
        perms.granted += "android.permission.ACCESS_COARSE_LOCATION"
        val host = newHost(listOf(PermissionQueryDriver(perms), PermissionRequestDriver(perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.query", mapOf("permission" to "location"), timeoutMs = 30_000))
        c.handleMessage(request(3, "permission.request", mapOf("permission" to "geolocation")))
        c.handleMessage(request(4, "permission.query", mapOf("permission" to "geolocation"), timeoutMs = 30_000))
        runCurrent()
        assertEquals(DeviceWire.result(2, mapOf("status" to "granted")), t.responses()[0])
        assertEquals(listOf("invalidParams", "invalidParams"), t.responses().drop(1).map { t.errorCode(it) })
        assertEquals(0, perms.requests)
        host.dispose()
    }

    // ---- C1 file.pick -------------------------------------------------------------------------------

    @Test
    fun `file pick filters the picker by accept, uploads named items and declares known sizes`() = runTest {
        val a = "%PDF-1.7 hello".toByteArray()
        val b = ByteArray(70_000) { (it % 251).toByte() }
        val pick = FakePick(
            listOf(
                PickedDocument("report.pdf", "application/pdf", a.size.toLong(), { ByteArrayInputStream(a) }),
                PickedDocument("photo.png", "image/png", null, { ByteArrayInputStream(b) }), // unknown size: streamed undeclared
            ),
        )
        val host = newHost(listOf(FilePickDriver(pick)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "file.pick", mapOf("accept" to listOf(".pdf", "image/*", "text/plain"), "maxCount" to 4), initialCredit = 4 * 1024 * 1024))
        runCurrent()
        assertEquals(listOf("application/pdf", "image/*", "text/plain"), pick.mimeTypes)
        assertEquals(true, pick.multiple)
        assertEquals(listOf("pendingConsent", "running"), progress(t))
        val starts = t.messages.mapNotNull { (it["event"] as? Map<*, *>)?.takeIf { e -> e["kind"] == "blobStart" } }
        assertEquals(
            listOf(
                mapOf("kind" to "blobStart", "channel" to 0, "contentType" to "application/pdf", "bytes" to a.size.toLong()),
                mapOf("kind" to "blobStart", "channel" to 1, "contentType" to "image/png"),
            ),
            starts,
        )
        val items = (result(t)["items"] as List<*>).map { it as Map<*, *> }
        assertEquals(listOf("report.pdf", "photo.png"), items.map { it["name"] })
        assertEquals(listOf(sha256Hex(a), sha256Hex(b)), items.map { it["sha256"] })
        assertTrue(uploaded(t, channel = 0).contentEquals(a))
        assertTrue(uploaded(t, channel = 1).contentEquals(b))
        host.dispose()
    }

    @Test
    fun `file pick drops items outside the filter, refuses bad accept entries, and dismissal is cancelled`() = runTest {
        var released = 0
        val pick = FakePick(
            listOf(
                PickedDocument("evil.exe", "application/octet-stream", 3, { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }, { released += 1 }),
                PickedDocument("notes.TXT", "application/octet-stream", 2, { ByteArrayInputStream(byteArrayOf(4, 5)) }, { released += 1 }),
            ),
        )
        val host = newHost(listOf(FilePickDriver(pick)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "file.pick", mapOf("accept" to listOf("txt"), "maxCount" to 1), initialCredit = 1024))
        runCurrent()
        assertEquals(listOf("text/plain"), pick.mimeTypes)
        assertEquals(false, pick.multiple)
        val items = (result(t)["items"] as List<*>).map { it as Map<*, *> }
        assertEquals(listOf("notes.TXT"), items.map { it["name"] })
        assertEquals(2, released) // the dropped item at once, the uploaded one after its upload

        t.sent.clear()
        c.handleMessage(request(3, "file.pick", mapOf("accept" to listOf("image/**"), "maxCount" to 1)))
        runCurrent()
        assertEquals("invalidParams", t.errorCode(t.responses().single()))

        t.sent.clear()
        pick.docs = listOf(PickedDocument("a.exe", "application/x-msdownload", 1, { ByteArrayInputStream(byteArrayOf(1)) }))
        c.handleMessage(request(4, "file.pick", mapOf("accept" to listOf("application/pdf"), "maxCount" to 1)))
        runCurrent()
        assertEquals(DeviceWire.error(4, DeviceErrorCode.CANCELLED, "no-matching-item"), t.responses().single())

        t.sent.clear()
        pick.docs = emptyList()
        c.handleMessage(request(5, "file.pick", mapOf("accept" to emptyList<String>(), "maxCount" to 1)))
        runCurrent()
        assertEquals(listOf("*/*"), pick.mimeTypes)
        assertEquals(DeviceWire.error(5, DeviceErrorCode.CANCELLED, "picker-dismissed"), t.responses().single())
        host.dispose()
    }

    // ---- C1 file.save + download plane ---------------------------------------------------------------

    private fun saveParams(data: ByteArray, name: String = "export.bin", sha: String = sha256Hex(data)) =
        mapOf("channel" to 0, "name" to name, "contentType" to "application/octet-stream", "bytes" to data.size, "sha256" to sha)

    private fun frame(id: Long, seq: Long, payload: ByteArray) = DeviceFrames.encode(FrameHeader(channel = 0, requestId = id, seq = seq), payload)

    /** Act as the server: send frames within the granted credit until [data] is sent or credit runs out. */
    private class Server(val c: DeviceConnection, val t: FakeTransport, val data: ByteArray, val id: Long = 2) {
        var sent = 0
        var seq = 0L
        var granted = 0L
        private var seen = 0

        fun pump(maxFrame: Int = 64 * 1024) {
            val grantMsgs = t.messages.filter { DeviceWire.exactLong(it["id"]) == id }.mapNotNull { (it["control"] as? Map<*, *>)?.get("grant") as Long? }
            for (g in grantMsgs.drop(seen)) granted += g
            seen = grantMsgs.size
            while (sent < data.size && sent < granted) {
                val n = minOf(maxFrame.toLong(), granted - sent, (data.size - sent).toLong()).toInt()
                c.handleFrame(DeviceFrames.encode(FrameHeader(channel = 0, requestId = id, seq = seq++), data, sent, n))
                sent += n
            }
        }
    }

    @Test
    fun `file save grants nothing before consent and destination, then streams within a bounded window and verifies`() = runTest {
        val data = ByteArray(600 * 1024) { (it * 31 + 7).toByte() }
        val consent = FakeConsent().apply { hold = CompletableDeferred() }
        val save = FakeSave()
        val host = newHost(listOf(FileSaveDriver(save)), consent = consent)
        val (c, t) = connect(host)
        c.handleMessage(request(2, "file.save", saveParams(data, name = "../evil/re‮port.bin")))
        runCurrent()
        // Consent up: nothing granted, the lease still answered.
        assertEquals(1, consent.prompts.size)
        assertEquals("save a .bin file (600 KB) to your device", consent.prompts.single().operation)
        c.handleMessage(control(2, "renewLease", 1))
        runCurrent()
        assertEquals(emptyList<Long>(), grants(t))
        assertEquals(DeviceWire.control(2, Control.LeaseAck(1)), t.messages.last())
        consent.hold!!.complete(Unit)
        runCurrent()
        // Destination picker up (sanitized name): still nothing granted.
        assertEquals(listOf(".._evil_re_port.bin" to "application/octet-stream"), save.requests)
        assertEquals(emptyList<Long>(), grants(t))
        assertEquals(listOf("pendingConsent"), progress(t))
        save.destination.complete(Unit)
        runCurrent()
        assertEquals(listOf("pendingConsent", "running"), progress(t))
        assertEquals(listOf(FileSaveDriver.MAX_WINDOW), grants(t))
        val server = Server(c, t, data)
        val target = save.target!!
        var rounds = 0
        while (server.sent < data.size && rounds++ < 100) {
            server.pump()
            runCurrent()
            // Never more than one window outstanding (in flight or buffered, not yet written).
            val outstanding = grants(t).sum() - target.bytes.size()
            assertTrue("outstanding $outstanding", outstanding <= FileSaveDriver.MAX_WINDOW)
            assertTrue("granted past the declaration", grants(t).sum() <= data.size)
        }
        runCurrent()
        assertEquals(data.size.toLong(), grants(t).sum())
        assertEquals(DeviceWire.result(2, mapOf("bytesWritten" to data.size.toLong())), t.responses().single())
        assertTrue(target.committed)
        assertEquals(0, target.discarded)
        assertTrue(target.bytes.toByteArray().contentEquals(data))
        host.dispose()
    }

    @Test
    fun `file save window never exceeds the declared size and frames reach the host only for live downloads`() = runTest {
        val data = ByteArray(1000) { it.toByte() }
        val save = FakeSave().apply { destination.complete(Unit) }
        val host = newHost(listOf(FileSaveDriver(save)), consent = FakeConsent())
        val (c, t) = connect(host)
        c.handleMessage(request(2, "file.save", saveParams(data)))
        runCurrent()
        assertEquals(listOf(1000L), grants(t))
        // Socket edge: a frame for the live download is copied whole; one for another id header-only.
        val reads = mutableListOf<Pair<Int, Int>>()
        val other = frame(9, 0, ByteArray(500))
        c.handleFrame(other.size) { a, b -> reads += a to b; other.copyOfRange(a, b) }
        assertEquals(listOf(0 to 12), reads)
        reads.clear()
        val mine = frame(2, 0, data)
        c.handleFrame(mine.size) { a, b -> reads += a to b; mine.copyOfRange(a, b) }
        assertEquals(listOf(0 to 12, 0 to mine.size), reads)
        runCurrent()
        assertEquals(DeviceWire.result(2, mapOf("bytesWritten" to 1000L)), t.responses().single())
        assertTrue(save.target!!.bytes.toByteArray().contentEquals(data))
        // Retired: header-only again.
        reads.clear()
        c.handleFrame(mine.size) { a, b -> reads += a to b; mine.copyOfRange(a, b) }
        assertEquals(listOf(0 to 12), reads)
        host.dispose()
    }

    @Test
    fun `file save discards partial output on hash mismatch, cancel, deadline, detach and write failure`() = runTest {
        val data = ByteArray(200_000) { (it % 7).toByte() }
        suspend fun TestScope.start(id: Long, target: FakeTarget, params: Map<String, Any?> = saveParams(data), timeoutMs: Long = 300_000): Triple<DeviceHost, DeviceConnection, FakeTransport> {
            val save = FakeSave(target).apply { destination.complete(Unit) }
            val host = newHost(listOf(FileSaveDriver(save)), consent = FakeConsent())
            val (c, t) = connect(host)
            c.handleMessage(request(id, "file.save", params, timeoutMs = timeoutMs))
            runCurrent()
            return Triple(host, c, t)
        }

        // Hash mismatch: the runtime refuses at the last byte; nothing is committed.
        run {
            val target = FakeTarget()
            val (host, c, t) = start(2, target, saveParams(data, sha = "0".repeat(64)))
            val server = Server(c, t, data)
            repeat(10) {
                server.pump()
                runCurrent()
            }
            assertEquals(DeviceWire.error(2, DeviceErrorCode.INVALID_PARAMS, "sha256 mismatch"), t.responses().single())
            assertFalse(target.committed)
            assertEquals(1, target.discarded)
            host.dispose()
        }
        // Server cancel mid-download.
        run {
            val target = FakeTarget()
            val (host, c, t) = start(2, target)
            c.handleFrame(frame(2, 0, data.copyOf(65_536)))
            runCurrent()
            assertEquals(65_536, target.bytes.size())
            c.handleMessage(control(2, "cancel", true))
            runCurrent()
            assertEquals("cancelled", t.errorCode(t.responses().single()))
            assertEquals(1, target.discarded)
            assertFalse(target.committed)
            host.dispose()
        }
        // Deadline.
        run {
            val target = FakeTarget()
            val (host, c, t) = start(2, target, timeoutMs = 5_000)
            c.handleMessage(control(2, "renewLease", 1))
            advanceTimeBy(5_001)
            runCurrent()
            assertEquals("timeout", t.errorCode(t.responses().single()))
            assertEquals(1, target.discarded)
            host.dispose()
        }
        // Detach (socket gone).
        run {
            val target = FakeTarget()
            val (host, c, _) = start(2, target)
            c.close()
            runCurrent()
            assertEquals(1, target.discarded)
            host.dispose()
        }
        // Write failure.
        run {
            val target = FakeTarget(failAt = 100_000)
            val (host, c, t) = start(2, target)
            val server = Server(c, t, data)
            repeat(10) {
                server.pump()
                runCurrent()
            }
            assertEquals(DeviceWire.error(2, DeviceErrorCode.INTERNAL, "write-failed"), t.responses().single())
            assertEquals(1, target.discarded)
            host.dispose()
        }
        // Data before any grant (credit 0): refused without writing.
        run {
            val target = FakeTarget()
            val save = FakeSave(target) // destination never chosen: no credit
            val host = newHost(listOf(FileSaveDriver(save)), consent = FakeConsent())
            val (c, t) = connect(host)
            c.handleMessage(request(2, "file.save", saveParams(data)))
            runCurrent()
            c.handleFrame(frame(2, 0, ByteArray(10)))
            runCurrent()
            assertEquals(DeviceWire.error(2, DeviceErrorCode.INVALID_PARAMS, "data exceeds credit"), t.responses().single())
            assertEquals(0, target.bytes.size())
            host.dispose()
        }
    }

    @Test
    fun `file save consent refusal is denied, a dismissed destination picker is cancelled, neither grants`() = runTest {
        val data = ByteArray(10) { 1 }
        val consent = FakeConsent(ConsentDecision.CANCEL)
        val save = FakeSave()
        val host = newHost(listOf(FileSaveDriver(save)), consent = consent)
        val (c, t) = connect(host)
        c.handleMessage(request(2, "file.save", saveParams(data)))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.DENIED, "host-refused"), t.responses().single())
        assertTrue(save.requests.isEmpty())

        val save2 = FakeSave(target = null).apply { destination.complete(Unit) }
        val host2 = newHost(listOf(FileSaveDriver(save2)), consent = FakeConsent())
        val (c2, t2) = connect(host2)
        c2.handleMessage(request(2, "file.save", saveParams(data)))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.CANCELLED, "picker-dismissed"), t2.responses().single())
        assertEquals(emptyList<Long>(), grants(t) + grants(t2))
        host.dispose()
        host2.dispose()
    }

    // ---- C2 camera.capture ---------------------------------------------------------------------------

    private val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 1, 2, 3, 4, 5)

    @Test
    fun `camera photo asks the declared camera permission, passes the facing hint and uploads one declared jpeg`() = runTest {
        val perms = FakePermissions().declare("CAMERA").apply { userGrants = true }
        val camera = FakeCamera()
        var released = false
        val host = newHost(listOf(CameraCaptureDriver(camera, perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "camera.capture", mapOf("mode" to "photo", "facing" to "front"), initialCredit = 1024, timeoutMs = 600_000))
        runCurrent()
        assertEquals(1, perms.requests)
        assertEquals(CameraCaptureRequest(video = false, facing = "front", maxDurationMs = null), camera.request)
        assertEquals(listOf("pendingConsent"), progress(t))
        camera.result.complete(CapturedMedia("image/jpeg", jpeg.size.toLong(), { ByteArrayInputStream(jpeg) }, { released = true }))
        runCurrent()
        assertEquals(listOf("pendingConsent", "running"), progress(t))
        val item = (result(t)["items"] as List<*>).single() as Map<*, *>
        assertEquals(mapOf("channel" to 0, "contentType" to "image/jpeg", "bytes" to jpeg.size.toLong(), "sha256" to sha256Hex(jpeg)), item)
        assertTrue(uploaded(t).contentEquals(jpeg))
        assertTrue(released)
        host.dispose()
    }

    @Test
    fun `camera video needs microphone too when declared, a refusal is denied with the permission name`() = runTest {
        val perms = FakePermissions().declare("CAMERA", "RECORD_AUDIO").apply { rationale = true }
        perms.granted += "android.permission.CAMERA"
        val camera = FakeCamera()
        val host = newHost(listOf(CameraCaptureDriver(camera, perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "camera.capture", mapOf("mode" to "video", "maxDurationMs" to 15_000), timeoutMs = 600_000))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.DENIED, "microphone"), t.responses().single())
        assertNull(camera.request) // never presented

        // Nothing declared: the capture app's own business, no prompt.
        val perms2 = FakePermissions()
        val camera2 = FakeCamera()
        val host2 = newHost(listOf(CameraCaptureDriver(camera2, perms2)))
        val (c2, t2) = connect(host2)
        c2.handleMessage(request(2, "camera.capture", mapOf("mode" to "video", "facing" to "back", "maxDurationMs" to 15_000), initialCredit = 1024, timeoutMs = 600_000))
        runCurrent()
        assertEquals(0, perms2.requests)
        assertEquals(CameraCaptureRequest(video = true, facing = "back", maxDurationMs = 15_000), camera2.request)
        val mp4 = byteArrayOf(0, 0, 0, 0x18, 'f'.code.toByte(), 't'.code.toByte(), 'y'.code.toByte(), 'p'.code.toByte(), 'i'.code.toByte(), 's'.code.toByte(), 'o'.code.toByte(), 'm'.code.toByte())
        camera2.result.complete(CapturedMedia("video/mp4", mp4.size.toLong(), { ByteArrayInputStream(mp4) }))
        runCurrent()
        assertEquals("video/mp4", ((result(t2)["items"] as List<*>).single() as Map<*, *>)["contentType"])
        host.dispose()
        host2.dispose()
    }

    @Test
    fun `camera dismissal is cancelled, a type outside the mode is internal, empty and oversize are unavailable, bad params refused`() = runTest {
        val perms = FakePermissions()
        suspend fun TestScope.one(media: CapturedMedia?, params: Map<String, Any?> = mapOf("mode" to "photo")): Map<String, Any?> {
            val camera = FakeCamera()
            val host = newHost(listOf(CameraCaptureDriver(camera, perms)))
            val (c, t) = connect(host)
            c.handleMessage(request(2, "camera.capture", params, initialCredit = 1024, timeoutMs = 600_000))
            runCurrent()
            camera.result.complete(media)
            runCurrent()
            host.dispose()
            return t.responses().single()
        }
        var released = 0
        assertEquals(DeviceWire.error(2, DeviceErrorCode.CANCELLED, "capture-dismissed"), one(null))
        assertEquals(
            DeviceWire.error(2, DeviceErrorCode.INTERNAL, "unexpected-media-type"),
            one(CapturedMedia("video/mp4", 3, { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }, { released += 1 })),
        )
        assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "capture-empty"), one(CapturedMedia("image/jpeg", 0, { ByteArrayInputStream(ByteArray(0)) }, { released += 1 })))
        assertEquals(
            DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "item-exceeds-limit"),
            one(CapturedMedia("image/jpeg", 64L * 1024 * 1024 + 1, { ByteArrayInputStream(ByteArray(0)) }, { released += 1 })),
        )
        assertEquals(3, released)
        for (bad in listOf(mapOf("mode" to "photo", "maxDurationMs" to 1000), mapOf("mode" to "photo", "facing" to "side"), mapOf("mode" to "audio"), mapOf("facing" to "front"))) {
            val camera = FakeCamera()
            val host = newHost(listOf(CameraCaptureDriver(camera, perms)))
            val (c, t) = connect(host)
            c.handleMessage(request(2, "camera.capture", bad, timeoutMs = 600_000))
            runCurrent()
            assertEquals("$bad", "invalidParams", t.errorCode(t.responses().single()))
            host.dispose()
        }
        // No camera: not advertised.
        val none = FakeCamera().apply { has = false }
        assertTrue(newHost(listOf(CameraCaptureDriver(none, perms))).offers().none { it["name"] == "camera.capture" })
    }

    @Test
    fun `the runtime refuses a camera item whose type does not fit the requested mode`() = runTest {
        val driver = object : DeviceDriver {
            override val capability = "camera.capture"
            override val binary = true

            override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

            override suspend fun run(ctx: DriverContext): DriverOutcome = DriverOutcome.Result(blobs = listOf(DriverBlob.ofBytes(0, "video/mp4", byteArrayOf(1))))
        }
        val host = newHost(listOf(driver))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "camera.capture", mapOf("mode" to "photo"), initialCredit = 1024, timeoutMs = 600_000))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.INTERNAL, "invalid-items"), t.responses().single())
        assertTrue(t.messages.none { (it["event"] as? Map<*, *>)?.get("kind") == "blobStart" })
        host.dispose()
    }

    // ---- C3 mic.record ---------------------------------------------------------------------------------

    private fun micHost(
        audio: FakeAudio,
        perms: FakePermissions = FakePermissions().declare("RECORD_AUDIO").apply { granted += "android.permission.RECORD_AUDIO" },
        indicator: FakeIndicator = FakeIndicator(),
        consent: ConsentPresenter = FakeConsent(),
        scope: TestScope,
        bufferLimit: Int = MicRecordDriver.DEFAULT_BUFFER_LIMIT,
    ): DeviceHost = scope.newHost(listOf(MicRecordDriver(audio, perms, indicator, bufferLimit)), consent = consent)

    private fun micRequest(id: Long = 2, sampleRate: Int = 16_000, extra: Map<String, Any?> = emptyMap(), initialCredit: Long = 256 * 1024) =
        request(id, "mic.record", mapOf("sampleRate" to sampleRate, "format" to "pcm16") + extra, initialCredit = initialCredit, timeoutMs = 600_000)

    @Test
    fun `mic record streams frames as captured under the indicator and Stop ends it successfully`() = runTest {
        val audio = FakeAudio()
        val indicator = FakeIndicator()
        val consent = FakeConsent()
        val host = micHost(audio, indicator = indicator, consent = consent, scope = this)
        val (c, t) = connect(host)
        c.handleMessage(micRequest(extra = mapOf("channels" to 2)))
        runCurrent()
        assertEquals("record audio from your microphone (stereo, 16000 Hz)", consent.prompts.single().operation)
        assertEquals(AudioCaptureFormat(16_000, 2), audio.format)
        assertEquals(MicRecordDriver.ACTIVITY, indicator.visible.single().activity)
        assertEquals("wss://app.example:443", indicator.visible.single().origin)
        assertEquals(listOf("pendingConsent", "running"), progress(t))
        assertEquals(
            mapOf("kind" to "blobStart", "channel" to 0, "contentType" to "audio/L16"),
            t.messages.mapNotNull { it["event"] as? Map<*, *> }.single { it["kind"] == "blobStart" },
        )
        // Frames as captured: each small capture is sent at once, not batched to 64 KiB.
        audio.push(640)
        runCurrent()
        audio.push(320, fill = 3)
        runCurrent()
        assertEquals(listOf(640, 320), t.frames.map { it.decoded.payload.size })
        indicator.stopAll(IndicatorStopReason.USER)
        runCurrent()
        val r = result(t)
        val all = ByteArray(640) { (7 + it).toByte() } + ByteArray(320) { (3 + it).toByte() }
        assertEquals(mapOf("channel" to 0, "contentType" to "audio/L16", "bytes" to 960L, "sha256" to sha256Hex(all)), r["item"])
        assertEquals(15L, r["durationMs"]) // 960 B / 4 B per stereo frame = 240 frames @16 kHz
        assertEquals(1, audio.stops)
        assertTrue(indicator.visible.isEmpty())
        host.dispose()
    }

    @Test
    fun `mic record ends throttled when credit starves past the bounded window`() = runTest {
        val audio = FakeAudio()
        val indicator = FakeIndicator()
        val host = micHost(audio, indicator = indicator, scope = this, bufferLimit = 64 * 1024)
        val (c, t) = connect(host)
        c.handleMessage(micRequest(initialCredit = 64))
        runCurrent()
        audio.push(64)
        runCurrent()
        audio.push(1000) // held without credit
        runCurrent()
        assertEquals(DeviceWire.control(2, Control.Paused(true)), t.messages.last())
        audio.push(64 * 1024 + 1) // the bounded window overflows
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.THROTTLED, LiveCaptureBuffer.CAPTURE_BUFFER_FULL), t.responses().single())
        assertEquals(listOf(64), t.frames.map { it.decoded.payload.size })
        assertEquals(1, audio.stops)
        assertTrue(indicator.visible.isEmpty())
        host.dispose()
    }

    @Test
    fun `mic record paused then resumed by a grant keeps every byte in order`() = runTest {
        val audio = FakeAudio()
        val host = micHost(audio, scope = this)
        val (c, t) = connect(host)
        c.handleMessage(micRequest(initialCredit = 100))
        runCurrent()
        audio.push(300)
        runCurrent()
        assertEquals(listOf(100), t.frames.map { it.decoded.payload.size })
        c.handleMessage(control(2, "grant", 500))
        runCurrent()
        audio.sink!!.onPcm(ByteArray(0)) // nothing captured: no frame
        host.onHostSuspended() // backgrounding ends it normally
        runCurrent()
        val controls = t.messages.mapNotNull { (it["control"] as? Map<*, *>)?.get("paused") }
        assertEquals(listOf(true, false), controls)
        assertTrue(uploaded(t).contentEquals(ByteArray(300) { (7 + it).toByte() }))
        assertEquals(300L, (result(t)["item"] as Map<*, *>)["bytes"])
        assertEquals(1, audio.stops)
        host.dispose()
    }

    @Test
    fun `mic record stops at maxDurationMs, and a server cancel discards it`() = runTest {
        val audio = FakeAudio()
        val host = micHost(audio, scope = this)
        val (c, t) = connect(host)
        c.handleMessage(micRequest(sampleRate = 8_000, extra = mapOf("maxDurationMs" to 10)))
        runCurrent()
        audio.push(100)
        audio.push(100) // truncated at 80 frames = 160 bytes, then the item ends by itself
        runCurrent()
        val r = result(t)
        assertEquals(160L, (r["item"] as Map<*, *>)["bytes"])
        assertEquals(10L, r["durationMs"])
        assertEquals(1, audio.stops)

        t.sent.clear()
        c.handleMessage(micRequest(id = 3))
        runCurrent()
        audio.push(10)
        runCurrent()
        c.handleMessage(control(3, "cancel", true))
        runCurrent()
        assertEquals("cancelled", t.errorCode(t.responses().single()))
        assertEquals(2, audio.stops)
        host.dispose()
    }

    @Test
    fun `mic record stops the microphone at maxDurationMs even while the server withholds credit`() = runTest {
        val audio = FakeAudio()
        val indicator = FakeIndicator()
        val host = micHost(audio, indicator = indicator, scope = this)
        val (c, t) = connect(host)
        c.handleMessage(micRequest(sampleRate = 8_000, extra = mapOf("maxDurationMs" to 10), initialCredit = 0))
        runCurrent()
        assertEquals(1, indicator.visible.size)
        audio.push(200) // past the 160-byte (80 frames @8 kHz) limit, no credit to send any of it
        // The limit stops the hardware and hides the indicator at once, before any terminal.
        assertEquals(1, audio.stops)
        assertTrue(indicator.visible.isEmpty())
        runCurrent()
        assertEquals(1, audio.stops)
        assertTrue(indicator.visible.isEmpty())
        assertTrue(t.responses().isEmpty())
        assertTrue(t.frames.isEmpty())
        audio.push(50) // a late callback after stop is dropped
        // Credit arrives later: what was captured uploads and the recording ends normally.
        c.handleMessage(control(2, "grant", 1024))
        runCurrent()
        val r = result(t)
        assertEquals(160L, (r["item"] as Map<*, *>)["bytes"])
        assertEquals(10L, r["durationMs"])
        assertTrue(uploaded(t).contentEquals(ByteArray(160) { (7 + it).toByte() }))
        assertEquals(1, audio.stops)
        host.dispose()
    }

    @Test
    fun `mic record stops the microphone at the item cap even while the server withholds credit`() = runTest {
        val audio = FakeAudio()
        val indicator = FakeIndicator()
        val cap = DeviceRegistry.revision("mic.record", 1)!!.maxItemBytes
        assertEquals(64L * 1024 * 1024, cap)
        val host = micHost(audio, indicator = indicator, scope = this, bufferLimit = (cap + 1024 * 1024).toInt())
        val (c, t) = connect(host)
        c.handleMessage(micRequest(initialCredit = 0)) // no maxDurationMs: only the item cap limits it
        runCurrent()
        val chunk = ByteArray(1024 * 1024)
        repeat((cap / chunk.size).toInt() - 1) { audio.sink!!.onPcm(chunk) }
        assertEquals(0, audio.stops)
        assertEquals(1, indicator.visible.size)
        audio.sink!!.onPcm(chunk) // reaches the 64 MiB item cap
        assertEquals(1, audio.stops)
        assertTrue(indicator.visible.isEmpty())
        runCurrent()
        assertTrue(t.responses().isEmpty())
        c.handleMessage(control(2, "cancel", true))
        runCurrent()
        assertEquals("cancelled", t.errorCode(t.responses().single()))
        assertEquals(1, audio.stops)
        host.dispose()
    }

    @Test
    fun `mic record consent refusal, permission denial, capture errors and missing indicator`() = runTest {
        // Host consent Cancel → denied, nothing started.
        run {
            val audio = FakeAudio()
            val host = micHost(audio, consent = FakeConsent(ConsentDecision.CANCEL), scope = this)
            val (c, t) = connect(host)
            c.handleMessage(micRequest())
            runCurrent()
            assertEquals(DeviceWire.error(2, DeviceErrorCode.DENIED, "host-refused"), t.responses().single())
            assertNull(audio.sink)
            host.dispose()
        }
        // OS permission refused.
        run {
            val audio = FakeAudio()
            val perms = FakePermissions().declare("RECORD_AUDIO").apply { rationale = true }
            val host = micHost(audio, perms = perms, scope = this)
            val (c, t) = connect(host)
            c.handleMessage(micRequest())
            runCurrent()
            assertEquals(DeviceWire.error(2, DeviceErrorCode.DENIED, "microphone"), t.responses().single())
            assertEquals(1, perms.requests)
            host.dispose()
        }
        // Undeclared RECORD_AUDIO: not advertised, so the request is outside the selection.
        run {
            val audio = FakeAudio()
            val host = micHost(audio, perms = FakePermissions(), scope = this)
            assertEquals(listOf("core.capabilities"), host.offers().map { it["name"] })
            val (c, t) = connect(host)
            c.handleMessage(micRequest())
            runCurrent()
            assertEquals(DeviceErrorCode.UNSUPPORTED.wireName, t.errorCode(t.responses().single()))
            assertNull(audio.sink)
            host.dispose()
        }
        // The source cannot start / fails mid-recording.
        run {
            val audio = FakeAudio().apply { startError = DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "no-audio-format") }
            val indicator = FakeIndicator()
            val host = micHost(audio, indicator = indicator, scope = this)
            val (c, t) = connect(host)
            c.handleMessage(micRequest())
            runCurrent()
            assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "no-audio-format"), t.responses().single())
            assertTrue(indicator.visible.isEmpty())
            audio.startError = null
            t.sent.clear()
            c.handleMessage(micRequest(id = 3))
            runCurrent()
            audio.sink!!.onError("record-read-failed:-3")
            runCurrent()
            assertEquals(DeviceWire.error(3, DeviceErrorCode.UNAVAILABLE, "record-read-failed:-3"), t.responses().single())
            host.dispose()
        }
        // No ready indicator: not advertised, and refused if requested anyway.
        val notReady = FakeIndicator(ready = false)
        val host = micHost(FakeAudio(), indicator = notReady, scope = this)
        assertTrue(host.offers().none { it["name"] == "mic.record" })
        assertTrue(micHost(FakeAudio(), scope = this).offers().any { it["name"] == "mic.record" })
        host.dispose()
    }

    @Test
    fun `mic record detach stops the hardware and hides the indicator, and a recording ends at the item limit`() = runTest {
        val audio = FakeAudio()
        val indicator = FakeIndicator()
        val host = micHost(audio, indicator = indicator, scope = this)
        val (c, _) = connect(host)
        c.handleMessage(micRequest())
        runCurrent()
        audio.push(10)
        runCurrent()
        assertEquals(1, indicator.visible.size)
        c.close()
        runCurrent()
        assertEquals(1, audio.stops)
        assertTrue(indicator.visible.isEmpty())
        host.dispose()

        // The end-handler contract directly: runs once, and at once when registered after the end.
        var ran = 0
        val probe = object : DeviceDriver {
            override val capability = "permission.query"

            override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

            override suspend fun run(ctx: DriverContext): DriverOutcome {
                ctx.onEnd { ran += 1 }
                return DriverOutcome.Result(mapOf("status" to "granted"))
            }
        }
        val host2 = newHost(listOf(probe))
        val (c2, t2) = connect(host2)
        c2.handleMessage(request(2, "permission.query", mapOf("permission" to "camera"), timeoutMs = 30_000))
        runCurrent()
        assertEquals(1, ran)
        assertEquals(DeviceWire.result(2, mapOf("status" to "granted")), t2.responses().single())
        host2.dispose()
    }

    @Test
    fun `mic record params accept channels 1 or 2 only`() {
        val ok = mapOf("sampleRate" to 48_000, "format" to "pcm16")
        assertNull(DevicePayloads.validate("mic.record", 1, PayloadKind.PARAMS, ok))
        assertNull(DevicePayloads.validate("mic.record", 1, PayloadKind.PARAMS, ok + ("channels" to 2)))
        for (bad in listOf(0, 3, "2")) assertNotNull(DevicePayloads.validate("mic.record", 1, PayloadKind.PARAMS, ok + ("channels" to bad)))
    }

    // ---- C4 bluetooth.select ---------------------------------------------------------------------------

    private val hr = "0000180d-0000-1000-8000-00805f9b34fb"

    private fun btPerms(granted: Boolean = true) =
        FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN").apply { if (granted) this.granted += "android.permission.BLUETOOTH_SCAN" }

    @Test
    fun `bluetooth select lists a filtered live scan in the chooser and returns the chosen identity`() = runTest {
        val bt = FakeBluetooth()
        val chooser = FakeChooser()
        val host = newHost(listOf(BluetoothSelectDriver(bt, btPerms(), chooser)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.select", mapOf("services" to listOf(hr), "namePrefix" to "Polar")))
        runCurrent()
        assertEquals(listOf("pendingConsent"), progress(t))
        assertEquals("wss://app.example:443", chooser.origin)
        val l = bt.listener!!
        l.onAdvertisement("AA", "Polar H10", -60, listOf(hr, "0000180f-0000-1000-8000-00805f9b34fb"))
        l.onAdvertisement("BB", "Polar OH1", -40, listOf(hr.uppercase()))
        l.onAdvertisement("CC", "Garmin HRM", -30, listOf(hr)) // wrong prefix
        l.onAdvertisement("DD", "Polar Verity", -20, emptyList()) // service missing
        l.onAdvertisement("EE", null, -10, listOf(hr)) // unnamed never matches a prefix
        l.onDevice("FF", "Polar X", -5) // no advertised services
        runCurrent()
        assertEquals(
            listOf(BluetoothChooserEntry("BB", "Polar OH1", -40), BluetoothChooserEntry("AA", "Polar H10", -60)),
            chooser.devices!!.value,
        )
        chooser.result.complete(BluetoothChoice.Selected("AA"))
        runCurrent()
        assertEquals(DeviceWire.result(2, mapOf("device" to mapOf("id" to "AA", "name" to "Polar H10"))), t.responses().single())
        assertEquals(1, bt.stopped)
        host.dispose()
    }

    @Test
    fun `bluetooth select without filters lists every device, strongest first, bounded`() = runTest {
        val bt = FakeBluetooth()
        val chooser = FakeChooser()
        val host = newHost(listOf(BluetoothSelectDriver(bt, btPerms(), chooser)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.select"))
        runCurrent()
        for (i in 0 until 80) bt.listener!!.onDevice("id-$i", null, -100 + i)
        runCurrent()
        val listed = chooser.devices!!.value
        assertEquals(BluetoothSelectDriver.MAX_LISTED, listed.size)
        assertEquals(listed.sortedByDescending { it.rssi }, listed)
        chooser.result.complete(BluetoothChoice.Selected("id-3"))
        runCurrent()
        assertEquals(DeviceWire.result(2, mapOf("device" to mapOf("id" to "id-3"))), t.responses().single())
        host.dispose()
    }

    @Test
    fun `bluetooth select cancel, adapter off, deadline, permission denial and params`() = runTest {
        // Chooser Cancel → cancelled; scan stopped.
        run {
            val bt = FakeBluetooth()
            val chooser = FakeChooser()
            val host = newHost(listOf(BluetoothSelectDriver(bt, btPerms(), chooser)))
            val (c, t) = connect(host)
            c.handleMessage(request(2, "bluetooth.select"))
            runCurrent()
            chooser.result.complete(BluetoothChoice.Dismissed)
            runCurrent()
            assertEquals(DeviceWire.error(2, DeviceErrorCode.CANCELLED, "chooser-dismissed"), t.responses().single())
            assertEquals(1, bt.stopped)
            host.dispose()
        }
        // Adapter turned off while choosing → unavailable, chooser dismissed.
        run {
            val bt = FakeBluetooth()
            val chooser = FakeChooser()
            val host = newHost(listOf(BluetoothSelectDriver(bt, btPerms(), chooser)))
            val (c, t) = connect(host)
            c.handleMessage(request(2, "bluetooth.select"))
            runCurrent()
            bt.listener!!.onAdapterOff()
            runCurrent()
            assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "adapter-off"), t.responses().single())
            assertEquals(1, chooser.cancelled)
            assertEquals(1, bt.stopped)
            host.dispose()
        }
        // Deadline → timeout; chooser and scan torn down.
        run {
            val bt = FakeBluetooth()
            val chooser = FakeChooser()
            val host = newHost(listOf(BluetoothSelectDriver(bt, btPerms(), chooser)))
            val (c, t) = connect(host)
            c.handleMessage(request(2, "bluetooth.select", timeoutMs = 3_000))
            c.handleMessage(control(2, "renewLease", 1))
            advanceTimeBy(3_001)
            runCurrent()
            assertEquals("timeout", t.errorCode(t.responses().single()))
            assertEquals(1, chooser.cancelled)
            assertEquals(1, bt.stopped)
            host.dispose()
        }
        // Missing OS permission is requested first; a refusal is denied, no chooser.
        run {
            val bt = FakeBluetooth()
            val chooser = FakeChooser()
            val perms = btPerms(granted = false).apply { rationale = true }
            val host = newHost(listOf(BluetoothSelectDriver(bt, perms, chooser)))
            val (c, t) = connect(host)
            c.handleMessage(request(2, "bluetooth.select"))
            runCurrent()
            assertEquals(DeviceWire.error(2, DeviceErrorCode.DENIED, "bluetooth"), t.responses().single())
            assertEquals(1, perms.requests)
            assertNull(chooser.origin)
            host.dispose()
        }
        // Adapter off up front.
        run {
            val host = newHost(listOf(BluetoothSelectDriver(FakeBluetooth(AdapterState.OFF), btPerms(), FakeChooser())))
            val (c, t) = connect(host)
            c.handleMessage(request(2, "bluetooth.select"))
            runCurrent()
            assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "adapter-off"), t.responses().single())
            host.dispose()
        }
        // Params: canonical lowercase 128-bit UUIDs, 1..16 unique; namePrefix 1..64 code points.
        val v = { p: Map<String, Any?> -> DevicePayloads.validate("bluetooth.select", 1, PayloadKind.PARAMS, p) }
        assertNull(v(emptyMap()))
        assertNull(v(mapOf("services" to listOf(hr), "namePrefix" to "P")))
        assertNull(v(mapOf("namePrefix" to "😀".repeat(64))))
        for (bad in listOf(
            mapOf("services" to listOf(hr.uppercase())),
            mapOf("services" to listOf("0x180d")),
            mapOf("services" to listOf("180d")),
            mapOf("services" to emptyList<String>()),
            mapOf("services" to listOf(hr, hr)),
            mapOf("services" to List(17) { "0000%04x-0000-1000-8000-00805f9b34fb".format(it) }),
            mapOf("namePrefix" to ""),
            mapOf("namePrefix" to "x".repeat(65)),
            mapOf("extra" to 1),
        )) assertNotNull("$bad", v(bad))
        val r = { p: Map<String, Any?> -> DevicePayloads.validate("bluetooth.select", 1, PayloadKind.RESULT, p) }
        assertNull(r(mapOf("device" to mapOf("id" to "a"))))
        assertNull(r(mapOf("device" to mapOf("id" to "a", "name" to ""))))
        assertNotNull(r(mapOf("device" to mapOf("id" to ""))))
        assertNotNull(r(mapOf("device" to mapOf("id" to "a", "rssi" to -1))))
    }
}
