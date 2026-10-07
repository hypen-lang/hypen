package space.hypen.remote.device

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import uniffi.hypen_engine.DeviceBroker
import uniffi.hypen_engine.deviceNegotiate
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The JVM host driver ([DevicePlane]) and the handler API ([DeviceContext])
 * over the REAL Rust broker (UniFFI, `libhypen_engine`), talking to a
 * scripted client ([FakeDeviceClient]) with virtual time: pumping, the
 * coroutine timer (lease renewals, deadlines), consumer pacing, uploads with
 * hash verification, downloads, streams, cancellation through coroutine
 * cancellation, local refusals and the replay firewall.
 */
class DevicePlaneTest {
    companion object {
        val HELLO = """{"protocolVersions":[1],"binary":true,"capabilities":[""" +
            listOf(
                "core.capabilities", "gallery.pick", "file.pick", "file.save", "permission.query", "permission.request",
                "bluetooth.scan", "bluetooth.select", "camera.capture", "mic.record",
            ).joinToString(",") { """{"name":"$it","versions":[1]}""" } + "]}"

        fun ack(): String = assertNotNull(deviceNegotiate(HELLO, true))
    }

    /** One connection: plane ↔ fake client, both on the test scheduler. */
    class Harness(scope: TestScope, extraConfig: String = "", binary: Boolean = true) {
        var closedWith: Pair<Int, String>? = null
        val framesSent = mutableListOf<ByteArray>()
        lateinit var client: FakeDeviceClient
        val plane: DevicePlane
        val owner = DeviceOwner("m1", 1u)

        init {
            val bg: CoroutineScope = scope.backgroundScope
            val clock = DeviceClock { scope.testScheduler.currentTime }
            val broker = DeviceBroker("""{"ack":${ack()}$extraConfig}""", null, 0uL)
            plane = DevicePlane(
                broker,
                object : DevicePlaneSink {
                    override fun sendText(text: String) = client.fromServer(text)
                    override fun sendFrame(frame: ByteArray) {
                        framesSent += frame
                        client.fromServerFrame(frame)
                    }
                    override fun closeConnection(code: Int, reason: String) {
                        closedWith = code to reason
                    }
                },
                bg,
                clock,
                binary,
            )
            client = FakeDeviceClient(bg, { plane.receiveText(it) }, { plane.receiveFrame(it) })
            assertTrue(plane.start())
            assertTrue(plane.ownerActivated(owner.moduleInstanceId, owner.activationId))
        }

        fun context(provenance: DeviceProvenance = DeviceProvenance.ORIGIN) = DeviceContext(plane, owner, provenance)
    }

    private fun photo(n: Int = 100_000) = ByteArray(n) { ((it * 31 + 7) and 0xff).toByte() }

    @Test
    fun `start opens core capabilities before anything else`() = runTest {
        val h = Harness(this)
        runCurrent()
        val first = h.client.receivedSnapshot().first()
        assertEquals("deviceRequest", first["type"]!!.jsonPrimitive.content)
        assertEquals("core.capabilities", first["capability"]!!.jsonPrimitive.content)
        assertEquals("connection", first["lifetime"]!!.jsonPrimitive.content)
        assertEquals(first["id"]!!.jsonPrimitive.long.toUInt(), h.plane.coreStreamId)
        assertTrue(h.plane.supports("gallery.pick"))
        h.plane.close()
    }

    @Test
    fun `typed permission query round trip`() = runTest {
        val h = Harness(this)
        h.client.driver("permission.query") {
            assertEquals("camera", params["permission"]!!.jsonPrimitive.content)
            respond(buildJsonObject { put("status", "granted") })
        }
        val r = h.context().permissions.query(Permission.CAMERA)
        assertEquals(DeviceResult.Ok(PermissionStatus.GRANTED, simulated = true), r)
        // Denial is an ordinary error value.
        h.client.driver("permission.request") { fail("denied", "user-declined") }
        val d = h.context().permissions.request(Permission.NOTIFICATIONS)
        assertEquals(DeviceResult.Err(DeviceErrorCode.DENIED, "user-declined"), d)
        h.plane.close()
    }

    @Test
    fun `gallery pick upload delivers verified bytes`() = runTest {
        val h = Harness(this)
        val bytes = photo()
        h.client.driver("gallery.pick") {
            val item = upload(0, "image/jpeg", bytes)
            respond(buildJsonObject { put("items", kotlinx.serialization.json.JsonArray(listOf(item))) })
        }
        val r = h.context().gallery.pick(GalleryPickParams(listOf(MediaType.PHOTO), 1))
        val items = assertIs<DeviceResult.Ok<List<VerifiedBlob>>>(r).value
        assertEquals(1, items.size)
        assertContentEquals(bytes, items[0].bytes)
        assertEquals(FakeDeviceClient.sha256(bytes), items[0].sha256)
        assertEquals("image/jpeg", items[0].contentType)
        // Delivered outside a handler scope: nothing stays retained.
        assertEquals(0, h.plane.retainedBytes)
        h.plane.close()
    }

    @Test
    fun `an upload whose bytes do not match the declared hash fails invalidParams`() = runTest {
        val h = Harness(this)
        val bytes = photo(5000)
        h.client.driver("gallery.pick") {
            blobStart(0, "image/jpeg", bytes.size.toLong())
            val tampered = bytes.copyOf().also { it[10] = (it[10] + 1).toByte() }
            frame(0, 0, tampered)
            respond(buildJsonObject {
                put("items", kotlinx.serialization.json.JsonArray(listOf(buildJsonObject {
                    put("channel", 0); put("contentType", "image/jpeg"); put("bytes", bytes.size); put("sha256", FakeDeviceClient.sha256(bytes))
                })))
            })
        }
        val r = h.context().request(Capability.GALLERY_PICK, GalleryPickParams(listOf(MediaType.PHOTO), 1))
        assertEquals(DeviceErrorCode.INVALID_PARAMS, assertIs<DeviceResult.Err>(r).error.code)
        h.plane.close()
    }

    @Test
    fun `file save sends frames only within granted credit and checks bytesWritten`() = runTest {
        val h = Harness(this)
        val data = "hypen-save ".repeat(20_000).toByteArray() // 220 KB → 4 frames
        val r = h.context().files.save(data, "notes.txt", "text/plain")
        assertEquals(DeviceResult.Ok(FileSaveResult(data.size.toLong())), r)
        val req = h.client.requests("file.save").single()
        assertEquals(0, req["initialCredit"]!!.jsonPrimitive.int)
        assertEquals(FakeDeviceClient.sha256(data), req["params"]!!.jsonObject["sha256"]!!.jsonPrimitive.content)
        val id = req["id"]!!.jsonPrimitive.long
        assertContentEquals(data, h.client.downloads.getValue(id).toByteArray())
        assertTrue(h.framesSent.all { it.size <= 12 + 65536 && it.size > 12 })
        h.plane.close()
    }

    @Test
    fun `file save without a grant sends nothing and ends at its deadline`() = runTest {
        val h = Harness(this)
        h.client.downloadGrant = null
        val r = h.context().files.save(ByteArray(1000) { 1 }, "x.bin", "application/octet-stream", timeoutMs = 2_000)
        assertEquals(DeviceErrorCode.TIMEOUT, assertIs<DeviceResult.Err>(r).error.code)
        assertTrue(h.framesSent.isEmpty())
        h.plane.close()
    }

    @Test
    fun `bluetooth scan events are paced by the consumer`() = runTest {
        val h = Harness(this)
        h.client.driver("bluetooth.scan") {
            for (i in 1..3) event(buildJsonObject { putJsonObject("device") { put("id", "dev-$i"); put("rssi", -40 - i) } })
            cancelled.await()
            respond(JsonObject(emptyMap()))
        }
        val gate = CompletableDeferred<Unit>()
        val seen = mutableListOf<String>()
        val stream = h.context().stream(Capability.BLUETOOTH_SCAN, BluetoothScanParams, DeviceRequestOptions(initialCredit = 3)) { e ->
            seen += e.device.id
            if (seen.size == 1) gate.await()
        }
        val id = assertNotNull(stream.id)
        runCurrent()
        // The consumer holds event 1: no credit came back yet.
        assertEquals(listOf("dev-1"), seen)
        assertTrue(h.client.controls(id.toLong(), "grant").isEmpty())
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("dev-1", "dev-2", "dev-3"), seen)
        // Credit is replenished as the consumer returns.
        assertTrue(h.client.controls(id.toLong(), "grant").isNotEmpty())
        stream.cancel()
        assertEquals(DeviceErrorCode.CANCELLED, assertIs<DeviceResult.Err>(stream.await()).error.code)
        runCurrent()
        assertTrue(h.client.controls(id.toLong(), "cancel").isNotEmpty())
        h.plane.close()
    }

    @Test
    fun `events flow completes early with take and cancels the stream`() = runTest {
        val h = Harness(this)
        h.client.driver("bluetooth.scan") {
            for (i in 1..5) event(buildJsonObject { putJsonObject("device") { put("id", "b$i"); put("rssi", -50) } })
            cancelled.await()
            respond(JsonObject(emptyMap()))
        }
        val ids = h.context().events(Capability.BLUETOOTH_SCAN, BluetoothScanParams).take(2).toList().map { it.device.id }
        assertEquals(listOf("b1", "b2"), ids)
        runCurrent()
        val id = h.client.requests("bluetooth.scan").single()["id"]!!.jsonPrimitive.long
        assertTrue(h.client.controls(id, "cancel").isNotEmpty(), "stopping collection cancels the stream")
        assertEquals(1, h.plane.liveCount) // only core.capabilities
        h.plane.close()
    }

    @Test
    fun `events flow fails with DeviceException when the stream errors`() = runTest {
        val h = Harness(this)
        h.client.driver("bluetooth.scan") {
            event(buildJsonObject { putJsonObject("device") { put("id", "only"); put("rssi", -50) } })
            fail("revoked")
        }
        val got = mutableListOf<String>()
        val e = assertFailsWith<DeviceException> {
            h.context().events(Capability.BLUETOOTH_SCAN, BluetoothScanParams).collect { got += it.device.id }
        }
        assertEquals(DeviceErrorCode.REVOKED, e.failure.code)
        h.plane.close()
    }

    @Test
    fun `mic record streams bytes in order and verifies the result over everything delivered`() = runTest {
        val h = Harness(this)
        val chunks = (0 until 4).map { c -> ByteArray(3200) { ((it + c * 13) and 0xff).toByte() } }
        val all = chunks.fold(ByteArray(0)) { a, b -> a + b }
        h.client.driver("mic.record") {
            blobStart(0, "audio/L16", null)
            chunks.forEachIndexed { i, c -> frame(0, i, c) }
            respond(buildJsonObject {
                put("durationMs", 800)
                putJsonObject("item") { put("channel", 0); put("contentType", "audio/L16"); put("bytes", all.size); put("sha256", FakeDeviceClient.sha256(all)) }
            })
        }
        val got = java.io.ByteArrayOutputStream()
        val stream = h.context().mic.record(MicRecordParams(8000, MicFormat.PCM16)) { chunk ->
            delay(5) // a slow consumer is fine: credit follows it
            got.write(chunk)
        }
        val result = assertIs<DeviceResult.Ok<MicRecordResult>>(stream.await()).value
        assertContentEquals(all, got.toByteArray())
        assertEquals(800, result.durationMs)
        assertEquals(FakeDeviceClient.sha256(all), result.item.sha256)
        // The Flow variant yields the same bytes.
        val flowBytes = h.context().data(Capability.MIC_RECORD, MicRecordParams(8000, MicFormat.PCM16)).toList()
        assertContentEquals(all, flowBytes.fold(ByteArray(0)) { a, b -> a + b })
        h.plane.close()
    }

    @Test
    fun `cancelling the calling coroutine cancels the device request`() = runTest {
        val h = Harness(this)
        val driverSawCancel = CompletableDeferred<Unit>()
        h.client.driver("gallery.pick") {
            cancelled.await()
            driverSawCancel.complete(Unit)
            fail("cancelled")
        }
        val job = launch { h.context().gallery.pick(GalleryPickParams(listOf(MediaType.PHOTO), 1)) }
        runCurrent()
        assertEquals(2, h.plane.liveCount)
        job.cancel()
        runCurrent()
        assertTrue(driverSawCancel.isCompleted, "the client was told cancel")
        assertEquals(1, h.plane.liveCount)
        // withTimeout is the same mechanism.
        h.client.driver("permission.request") { cancelled.await() }
        assertFailsWith<TimeoutCancellationException> {
            withTimeout(1_000) { h.context().permissions.request(Permission.CAMERA) }
        }
        runCurrent()
        val id = h.client.requests("permission.request").single()["id"]!!.jsonPrimitive.long
        assertTrue(h.client.controls(id, "cancel").isNotEmpty())
        h.plane.close()
    }

    @Test
    fun `the coroutine timer renews leases and a stalled client is cut off`() = runTest {
        val h = Harness(this)
        h.client.driver("permission.request") {
            delay(12_000)
            respond(buildJsonObject { put("status", "granted") })
        }
        val r = h.context().permissions.request(Permission.CAMERA)
        assertEquals(PermissionStatus.GRANTED, r.getOrThrow())
        val id = h.client.requests("permission.request").single()["id"]!!.jsonPrimitive.long
        // Renewed every 5 s (seq 1 rides with the request, then 2 and 3 by the timer).
        val renewals = h.client.controls(id, "renewLease").map { it.jsonPrimitive.long }
        assertTrue(renewals.containsAll(listOf(2L, 3L)), "renewals: $renewals")

        // A client that stops acknowledging loses its request at lease expiry.
        h.client.ackLeases = false
        h.client.driver("permission.query") { cancelled.await() }
        val start = testScheduler.currentTime
        val stalled = h.context().permissions.query(Permission.CAMERA)
        assertIs<DeviceResult.Err>(stalled)
        // Cut off by lease expiry (≤ 15 s after the last acknowledged
        // renewal), not immediately and not at the 30 s request deadline.
        val elapsed = testScheduler.currentTime - start
        assertTrue(elapsed in 5_000..15_000, "ended after $elapsed ms: $stalled")
        h.plane.close()
    }

    @Test
    fun `local refusals are values and send nothing`() = runTest {
        val h = Harness(this)
        runCurrent()
        val before = h.client.receivedSnapshot().size
        // Zero credit on an upload plane.
        val zero = h.context().gallery.pick(GalleryPickParams(listOf(MediaType.PHOTO), 1), DeviceRequestOptions(initialCredit = 0))
        assertEquals(DeviceErrorCode.INVALID_PARAMS, assertIs<DeviceResult.Err>(zero).error.code)
        // Background lifetime not allowed by the shipped revision.
        val bg = h.context().permissions.query(Permission.CAMERA, DeviceRequestOptions(lifetime = Lifetime.BACKGROUND))
        assertEquals(DeviceErrorCode.UNSUPPORTED, assertIs<DeviceResult.Err>(bg).error.code)
        // Untyped: unknown capability, a stream through requestUntyped, bad params.
        assertEquals(DeviceErrorCode.UNSUPPORTED, h.context().requestUntyped("nope.cap", JsonObject(emptyMap())).errorOrNull()?.code)
        assertEquals(DeviceErrorCode.INVALID_PARAMS, h.context().requestUntyped("bluetooth.scan", JsonObject(emptyMap())).errorOrNull()?.code)
        val bad = h.context().requestUntyped("permission.query", buildJsonObject { put("permission", "camra") })
        assertEquals(DeviceErrorCode.INVALID_PARAMS, bad.errorOrNull()?.code)
        assertTrue(bad.errorOrNull()?.platformDetail!!.contains("permission"))
        // An empty download.
        assertEquals(DeviceErrorCode.INVALID_PARAMS, h.context().save(ByteArray(0), "e", "a/b").errorOrNull()?.code)
        runCurrent()
        assertEquals(before, h.client.receivedSnapshot().size, "a local refusal sends nothing")
        h.plane.close()
    }

    /**
     * The typed param classes carry no second schema: an out-of-schema value
     * constructs fine and the Rust broker — the only validator — refuses it
     * at open with `invalidParams` naming the failing field; nothing is sent.
     */
    @Test
    fun `typed params are validated by the broker only`() = runTest {
        val h = Harness(this)
        runCurrent()
        val before = h.client.receivedSnapshot().size
        val cases = listOf<Pair<String, suspend () -> DeviceResult<*>>>(
            "mediaTypes" to { h.context().gallery.pick(GalleryPickParams(emptyList(), 1)) },
            "maxCount" to { h.context().files.pick(FilePickParams(listOf("application/pdf"), 0)) },
            "maxDurationMs" to { h.context().camera.capture(CameraCaptureParams(CaptureMode.PHOTO, maxDurationMs = 5_000)) },
            "services" to { h.context().bluetooth.select(BluetoothSelectParams(services = listOf("NOT-A-UUID"))) },
            "channels" to { h.context().mic.record(MicRecordParams(16_000, MicFormat.PCM16, channels = 3)) {}.await() },
            "name" to { h.context().save(byteArrayOf(1, 2, 3), "n".repeat(513), "text/plain") },
        )
        for ((field, call) in cases) {
            val err = assertIs<DeviceResult.Err>(call(), field).error
            assertEquals(DeviceErrorCode.INVALID_PARAMS, err.code, field)
            assertTrue(err.platformDetail?.contains(field) == true, "$field: ${err.platformDetail}")
        }
        // In-schema values encode exactly (absent optionals stay absent).
        assertEquals("""{"sampleRate":16000,"format":"pcm16"}""", MicRecordParams(16_000, MicFormat.PCM16).toJson().toString())
        assertEquals("""{"mode":"video","facing":"front","maxDurationMs":3000}""", CameraCaptureParams(CaptureMode.VIDEO, CameraFacing.FRONT, 3_000).toJson().toString())
        assertEquals("{}", BluetoothSelectParams().toJson().toString())
        assertEquals(
            """{"services":["${BluetoothSelectParams.expandShortUuid(0x180d)}"]}""",
            BluetoothSelectParams(listOf(BluetoothSelectParams.expandShortUuid(0x180d))).toJson().toString(),
        )
        runCurrent()
        assertEquals(before, h.client.receivedSnapshot().size, "a local refusal sends nothing")
        h.plane.close()
    }

    @Test
    fun `replay firewall, disabled planes and inactive owners refuse unavailable`() = runTest {
        val h = Harness(this)
        val replayed = h.context(DeviceProvenance.REPLAY).permissions.query(Permission.CAMERA)
        assertEquals(DeviceResult.Err(DeviceErrorCode.UNAVAILABLE, "syncActions.replay"), replayed)
        assertEquals(DeviceResult.Err(DeviceErrorCode.UNAVAILABLE, "syncActions.replay"), DeviceContext.replayed().camera.capture(CameraCaptureParams(CaptureMode.PHOTO)))
        assertEquals(DeviceErrorCode.UNAVAILABLE, DeviceContext.disabled().bluetooth.select().errorOrNull()?.code)
        val stream = DeviceContext.replayed().bluetooth.scan { }
        assertNull(stream.id)
        assertEquals(DeviceErrorCode.UNAVAILABLE, stream.await().errorOrNull()?.code)
        // An owner whose activation ended (broker-side check).
        val stale = DeviceContext(h.plane, DeviceOwner("m1", 7u)).permissions.query(Permission.CAMERA)
        assertEquals(DeviceResult.Err(DeviceErrorCode.UNAVAILABLE, "owner-inactive"), stale)
        // A captured activation that is no longer live (SDK-side check after suspension).
        var live = true
        val ctx = DeviceContext(h.plane, h.owner, DeviceProvenance.ORIGIN, null) { live }
        live = false
        assertEquals(DeviceResult.Err(DeviceErrorCode.UNAVAILABLE, "owner-inactive"), ctx.permissions.query(Permission.CAMERA))
        assertFalse(DeviceContext.disabled().supports(Capability.GALLERY_PICK))
        assertTrue(h.context().supports(Capability.MIC_RECORD))
        runCurrent()
        assertTrue(h.client.requests("permission.query").isEmpty())
        h.plane.close()
    }

    @Test
    fun `deactivation sweeps activation-owned work`() = runTest {
        val h = Harness(this)
        h.client.driver("gallery.pick") { cancelled.await() }
        val pick = async { h.context().gallery.pick(GalleryPickParams(listOf(MediaType.PHOTO), 1)) }
        runCurrent()
        h.plane.ownerDeactivated("m1", 1u)
        assertEquals(DeviceResult.Err(DeviceErrorCode.CANCELLED), pick.await())
        h.plane.close()
    }

    @Test
    fun `handler scope cancels pending unary work and releases held results at its end`() = runTest {
        val h = Harness(this)
        val bytes = photo(4000)
        h.client.driver("gallery.pick") {
            val item = upload(0, "image/jpeg", bytes)
            respond(buildJsonObject { put("items", kotlinx.serialization.json.JsonArray(listOf(item))) })
        }
        val ctx = h.context()
        ctx.beginHandlerScope()
        val first = ctx.gallery.pick(GalleryPickParams(listOf(MediaType.PHOTO), 1))
        assertTrue(first.isOk)
        // Received inside the scope: still charged to the retained budget.
        assertTrue(h.plane.retainedBytes >= bytes.size)
        h.client.driver("permission.request") { cancelled.await() }
        val orphan = async { ctx.permissions.request(Permission.CAMERA) }
        runCurrent()
        ctx.endHandlerScope()
        assertEquals(DeviceErrorCode.CANCELLED, orphan.await().errorOrNull()?.code)
        assertEquals(0, h.plane.retainedBytes)
        h.plane.close()
    }

    @Test
    fun `a broken control stream closes the device plane with 1012`() = runTest {
        val h = Harness(this)
        runCurrent()
        val core = h.plane.coreStreamId!!.toLong()
        h.client.driver("permission.request") { cancelled.await() }
        val pending = async { h.context().permissions.request(Permission.CAMERA) }
        runCurrent()
        h.client.text(buildJsonObject { put("type", "deviceResponse"); put("id", core); put("error", buildJsonObject { put("code", "internal") }) })
        runCurrent()
        assertEquals(1012, h.closedWith?.first)
        assertTrue(h.plane.isClosed)
        assertEquals(DeviceErrorCode.CONNECTION_LOST, pending.await().errorOrNull()?.code)
        assertEquals(DeviceResult.Err(DeviceErrorCode.CONNECTION_LOST), h.context().permissions.query(Permission.CAMERA))
    }

    @Test
    fun `local close settles live work connectionLost and frees the broker`() = runTest {
        val h = Harness(this)
        h.client.driver("gallery.pick") { cancelled.await() }
        val pick = async { h.context().gallery.pick(GalleryPickParams(listOf(MediaType.PHOTO), 1)) }
        runCurrent()
        h.plane.close()
        assertEquals(DeviceErrorCode.CONNECTION_LOST, pick.await().errorOrNull()?.code)
        assertTrue(h.plane.isClosed)
        assertNull(h.plane.info())
        h.plane.close() // idempotent
    }

    @Test
    fun `a connection without the binary route refuses downloads`() = runTest {
        val h = Harness(this, binary = false)
        assertEquals(DeviceResult.Err(DeviceErrorCode.UNSUPPORTED, "no binary route"), h.context().save(byteArrayOf(1), "a", "b/c"))
        h.plane.close()
    }

    @Test
    fun `camera capture and bluetooth select wrappers are typed end to end`() = runTest {
        val h = Harness(this)
        val jpeg = photo(3000)
        h.client.driver("camera.capture") {
            assertEquals("photo", params["mode"]!!.jsonPrimitive.content)
            val item = upload(0, "image/jpeg", jpeg, declare = false)
            respond(buildJsonObject { put("items", kotlinx.serialization.json.JsonArray(listOf(item))) })
        }
        h.client.driver("bluetooth.select") {
            respond(buildJsonObject { putJsonObject("device") { put("id", "hr-1"); put("name", "Heart") } })
        }
        val shot = h.context().camera.capture(CameraCaptureParams(CaptureMode.PHOTO, CameraFacing.BACK)).getOrThrow()
        assertContentEquals(jpeg, shot.bytes)
        assertEquals(SelectedBluetoothDevice("hr-1", "Heart"), h.context().bluetooth.select().getOrThrow())
        h.plane.close()
    }
}
