package space.hypen.engine

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import uniffi.hypen_engine.DeviceBindingException
import uniffi.hypen_engine.DeviceBroker
import uniffi.hypen_engine.DeviceOpenResult
import uniffi.hypen_engine.DeviceOutcome
import uniffi.hypen_engine.DeviceOutput
import uniffi.hypen_engine.DeviceRetainedBytesPool
import uniffi.hypen_engine.deviceConstantsJson
import uniffi.hypen_engine.deviceFileSaveParamsJson
import uniffi.hypen_engine.deviceIsOversizeText
import uniffi.hypen_engine.deviceHandshake
import uniffi.hypen_engine.deviceNegotiate
import uniffi.hypen_engine.deviceSelectAck
import uniffi.hypen_engine.deviceServerAdvertisementJson
import uniffi.hypen_engine.deviceServerConsumes
import uniffi.hypen_engine.deviceSha256Hex
import uniffi.hypen_engine.deviceValidateAck
import uniffi.hypen_engine.deviceValidateHello
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Device broker (RFC 001) binding tests for the Kotlin SDK: the GENERATED
 * UniFFI bindings (`uniffi/hypen_engine/hypen_engine.kt`: `DeviceBroker`,
 * `DeviceRetainedBytesPool`, `DeviceOutput`/`DeviceOutcome`/`DeviceOpenResult`
 * and the `device*` helpers) driven through JNA against the native engine
 * library (`cargo build --release --features uniffi`), exactly as the SDK's
 * native layer drives them.
 */
class DeviceBrokerBindingTest {
    private val json = Json

    private val hello = """{"protocolVersions":[1],"binary":true,"capabilities":[""" +
        """{"name":"core.capabilities","versions":[1]},{"name":"gallery.pick","versions":[1]},""" +
        """{"name":"file.save","versions":[1]},{"name":"bluetooth.scan","versions":[1]},""" +
        """{"name":"permission.query","versions":[1]}]}"""

    private fun sha(b: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    private fun frame(id: UInt, ch: Int, seq: Int, p: ByteArray): ByteArray =
        ByteBuffer.allocate(12 + p.size).order(ByteOrder.LITTLE_ENDIAN)
            .put(1).put(0).putShort(ch.toShort()).putInt(id.toInt()).putInt(seq).put(p).array()

    private fun obj(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

    /** Collects every output a broker produced, as the SDK's pump would. */
    private class Pump(val broker: DeviceBroker) {
        val sent = mutableListOf<JsonObject>()
        val frames = mutableListOf<ByteArray>()
        val settled = mutableMapOf<UInt, DeviceOutcome>()
        val events = mutableListOf<Pair<UInt, String>>()
        var closed: DeviceOutput.CloseConnection? = null

        fun drain() {
            repeat(64) {
                val out = broker.poll()
                if (out.isEmpty()) return
                for (o in out) when (o) {
                    is DeviceOutput.SendText -> sent += Json.parseToJsonElement(o.text).jsonObject
                    is DeviceOutput.SendFrame -> frames += o.frame
                    is DeviceOutput.Settled -> settled[o.id] = o.outcome
                    is DeviceOutput.Event -> events += o.id to o.eventJson
                    is DeviceOutput.Data -> {}
                    is DeviceOutput.CloseConnection -> closed = o
                }
            }
            error("broker never drained")
        }

        fun sentFor(id: UInt, type: String) = sent.filter {
            it["type"]?.jsonPrimitive?.content == type && it["id"]?.jsonPrimitive?.long == id.toLong()
        }
    }

    private fun opened(r: DeviceOpenResult): UInt = when (r) {
        is DeviceOpenResult.Opened -> r.id
        is DeviceOpenResult.Refused -> error("open refused: ${r.code} ${r.detail}")
    }

    private fun started(extra: String = "", pool: DeviceRetainedBytesPool? = null): Pump {
        val ack = assertNotNull(deviceNegotiate(hello, true))
        val broker = DeviceBroker("""{"ack":$ack$extra}""", pool, 0uL)
        val core = opened(broker.start(0uL))
        assertEquals(core, broker.coreStreamId())
        assertTrue(broker.ownerActivated("m1", 1u, 0uL))
        val pump = Pump(broker)
        pump.drain()
        assertEquals(1, pump.sentFor(core, "deviceRequest").size)
        return pump
    }

    /** The rebuilt engine's one-call server handshake (`deviceHandshake`) the SDK uses for `hello.device`. */
    @Test
    fun deviceHandshakeSelectsOrExplains() {
        val hs = deviceHandshake(hello, true, null)
        assertNull(hs.reason)
        assertEquals(deviceNegotiate(hello, true), hs.ackJson)
        // Invalid hello (protocol version 0): disabled, with a reason for the log.
        val bad = deviceHandshake("""{"protocolVersions":[0],"binary":true,"capabilities":[]}""", true, null)
        assertNull(bad.ackJson)
        assertTrue(bad.reason!!.startsWith("invalid hello.device: "), bad.reason)
        // D7 duplicates disable it too.
        val dup = hello.replace("]}]}", """]},{"name":"file.save","versions":[1]}]}""")
        assertNull(deviceHandshake(dup, true, null).ackJson)
        assertNotNull(deviceHandshake(dup, true, null).reason)
        // A server advertisement without core.capabilities selects nothing, and says why.
        val noCore = deviceHandshake(hello, true, """[{"name":"file.save","versions":[1]}]""")
        assertNull(noCore.ackJson)
        assertTrue(noCore.reason!!.contains("core.capabilities@1"), noCore.reason)
        // A malformed server list is a host error, not a disabled plane.
        assertFailsWith<DeviceBindingException> { deviceHandshake(hello, true, "x") }
    }

    @Test
    fun handshakeHelpers() {
        val ack = obj(assertNotNull(deviceNegotiate(hello, true)))
        assertEquals(1, ack["protocolVersion"]!!.jsonPrimitive.int)
        assertEquals(5, ack["capabilities"]!!.jsonArray.size)
        // D7: a duplicate capability disables device access.
        val dup = hello.replace("]}]}", """]},{"name":"file.save","versions":[1]}]}""")
        assertNull(deviceNegotiate(dup, true))
        assertNull(deviceNegotiate("{", true))
        deviceValidateHello(hello)
        assertFailsWith<DeviceBindingException> { deviceValidateHello(dup) }
        val sel = assertNotNull(
            deviceSelectAck(hello, listOf(1u), """[{"name":"core.capabilities","versions":[1]}]""", false),
        )
        assertFalse(obj(sel)["binary"]!!.jsonPrimitive.boolean)
        deviceValidateAck(sel)
        assertFailsWith<DeviceBindingException> { deviceSelectAck(hello, listOf(1u), "nope", true) }
        assertEquals(
            "core.capabilities",
            json.parseToJsonElement(deviceServerAdvertisementJson()).jsonArray[0].jsonObject["name"]!!.jsonPrimitive.content,
        )
        assertEquals(1012, obj(deviceConstantsJson())["devicePlaneCloseCode"]!!.jsonPrimitive.int)
        assertFalse(deviceIsOversizeText("""{"type":"deviceEvent"}"""))
        assertEquals(sha("abc".toByteArray()), deviceSha256Hex("abc".toByteArray()))
    }

    @Test
    fun uploadAndDownload() {
        val pump = started()
        val b = pump.broker

        val up = opened(
            b.open(
                """{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}""",
                null,
                1uL,
            ),
        )
        pump.drain()
        assertEquals("gallery.pick", pump.sentFor(up, "deviceRequest").single()["capability"]!!.jsonPrimitive.content)
        val photo = ByteArray(70_000) { (it * 7).toByte() }
        assertTrue(b.onText("""{"type":"deviceEvent","id":$up,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":${photo.size}}}""", 2uL))
        assertTrue(b.onFrame(frame(up, 0, 0, photo.copyOfRange(0, 65_536)), 3uL))
        assertTrue(b.onFrame(frame(up, 0, 1, photo.copyOfRange(65_536, photo.size)), 3uL))
        assertTrue(b.onText("""{"type":"deviceResponse","id":$up,"result":{"items":[{"channel":0,"contentType":"image/jpeg","bytes":${photo.size},"sha256":"${sha(photo)}"}]}}""", 4uL))
        pump.drain()
        val ok = pump.settled[up] as DeviceOutcome.Success
        val blob = ok.blobs.single()
        assertEquals("image/jpeg", blob.contentType)
        assertContentEquals(photo, blob.bytes)
        assertEquals(sha(photo), obj(ok.resultJson)["items"]!!.jsonArray[0].jsonObject["sha256"]!!.jsonPrimitive.content)
        assertFalse(b.isLive(up))
        assertEquals(0uL, b.retainedBytes())

        val data = "kotlin download through the rust broker".toByteArray()
        val params = deviceFileSaveParamsJson("k.txt", "text/plain", data)
        val dl = opened(b.open("""{"capability":"file.save","params":$params,"moduleInstanceId":"m1","activationId":1}""", data, 5uL))
        pump.drain()
        assertTrue(pump.frames.isEmpty(), "no download frame before a grant")
        assertEquals(0, pump.sentFor(dl, "deviceRequest").single()["initialCredit"]!!.jsonPrimitive.int)
        assertTrue(b.onText("""{"type":"deviceEvent","id":$dl,"control":{"grant":65536}}""", 6uL))
        pump.drain()
        var sent = ByteArray(0)
        for (f in pump.frames) {
            assertEquals(dl.toInt(), ByteBuffer.wrap(f, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int)
            sent += f.copyOfRange(12, f.size)
        }
        assertContentEquals(data, sent)
        assertTrue(b.onText("""{"type":"deviceResponse","id":$dl,"result":{"bytesWritten":${data.size}}}""", 7uL))
        pump.drain()
        assertTrue(pump.settled[dl] is DeviceOutcome.Success)

        val info = obj(b.infoJson())
        assertEquals(1, info["liveCount"]!!.jsonPrimitive.int)
        assertNotNull(b.tick(8uL))
        assertFailsWith<DeviceBindingException> { b.close("nope") }
        b.close("connectionLost")
        assertTrue(b.isClosed())
    }

    @Test
    fun refusalsPoolsAndSweeps() {
        val pool = DeviceRetainedBytesPool(1uL shl 20)
        val pump = started(""","maxRetainedBytes":8192""", pool)
        val b = pump.broker

        // Replay firewall: replayed dispatch is refused as a value.
        val replayed = b.open(
            """{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1,"replayed":true}""",
            null,
            1uL,
        )
        assertEquals("unavailable", (replayed as DeviceOpenResult.Refused).code)
        // Activation authority: a stale activation is refused.
        assertTrue(
            b.open("""{"capability":"permission.query","params":{"permission":"camera"},"moduleInstanceId":"m1","activationId":9}""", null, 1uL)
                is DeviceOpenResult.Refused,
        )
        // Host errors throw.
        assertFailsWith<DeviceBindingException> { b.open("{", null, 1uL) }
        assertFailsWith<DeviceBindingException> { DeviceBroker("{}", null, 0uL) }

        val id = opened(
            b.open(
                """{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}""",
                null,
                1uL,
            ),
        )
        b.onText("""{"type":"deviceEvent","id":$id,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":4096}}""", 2uL)
        assertTrue(pool.inUse() >= 4096uL)
        b.ownerDestroyed("m1", 3uL)
        pump.drain()
        val failed = pump.settled[id] as DeviceOutcome.Failure
        assertEquals("cancelled", failed.code)
        assertEquals(0uL, pool.inUse())
        assertEquals(1uL shl 20, pool.limit())
    }

    /** A started pooled broker holding one 50000-byte upload declaration. */
    private fun reserving(pool: DeviceRetainedBytesPool): DeviceBroker {
        val b = started(pool = pool).broker
        val id = opened(
            b.open(
                """{"capability":"gallery.pick","params":{"mediaTypes":["photo"],"maxCount":1},"moduleInstanceId":"m1","activationId":1}""",
                null,
                1uL,
            ),
        )
        b.poll()
        assertTrue(b.onText("""{"type":"deviceEvent","id":$id,"event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":50000}}""", 2uL))
        assertTrue(b.onFrame(frame(id, 0, 0, ByteArray(2000) { 7 }), 3uL))
        assertEquals(50000uL, b.retainedBytes())
        return b
    }

    @Test
    fun destroyWithoutCloseReturnsPooledBytes() {
        val pool = DeviceRetainedBytesPool(1uL shl 30)
        val kept = reserving(pool)
        val freed = reserving(pool)
        assertEquals(100000uL, pool.inUse())
        // A connection torn down on an error path that never called close():
        // releasing the object hands its reservation back to the shared pool.
        freed.destroy()
        assertEquals(50000uL, pool.inUse())
        // Releasing after an explicit close releases nothing twice.
        kept.close("connectionLost")
        assertEquals(0uL, pool.inUse())
        val other = reserving(pool)
        kept.destroy()
        assertEquals(50000uL, pool.inUse())
        // AutoCloseable `use {}` releases the object the same way.
        other.use { }
        assertEquals(0uL, pool.inUse())
    }

    @Test
    fun leasesAndBackgroundOwners() {
        val pump = started(""","revisionOverrides":[{"capability":"bluetooth.scan","version":1,"lifetimes":["activation","background"]}]""")
        val b = pump.broker
        assertTrue(b.admitsBackground("m1"))
        val scan = opened(
            b.open("""{"capability":"bluetooth.scan","moduleInstanceId":"m1","activationId":1,"lifetime":"background","initialCredit":4}""", null, 0uL),
        )
        pump.drain()
        fun renewals() = pump.sentFor(scan, "deviceEvent").count {
            (it["control"] as? JsonObject)?.containsKey("renewLease") == true
        }
        assertEquals(1, renewals())
        assertTrue(b.onText("""{"type":"deviceEvent","id":$scan,"event":{"device":{"id":"d1","rssi":-60}}}""", 100uL))
        pump.drain()
        val (eventId, eventJson) = pump.events.single()
        assertEquals(scan, eventId)
        assertEquals("d1", obj(eventJson)["device"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals(3uL, b.outstandingEventCredit(scan))
        b.consumedEvents(scan, 1uL, 101uL)

        // Renewals follow the 5 s cadence as the host ticks.
        b.tick(5_000uL)
        pump.drain()
        assertEquals(2, renewals())
        assertTrue(b.onText("""{"type":"deviceEvent","id":$scan,"control":{"leaseAck":2}}""", 5_001uL))

        // Deactivation keeps background work; destruction sweeps it.
        b.ownerDeactivated("m1", 1u, 5_002uL)
        assertTrue(b.isLive(scan))
        assertTrue(b.hasBackgroundWork("m1"))
        assertFalse(b.ownerIsActive("m1", 1u))
        b.ownerDestroyed("m1", 5_003uL)
        pump.drain()
        assertEquals("cancelled", (pump.settled[scan] as DeviceOutcome.Failure).code)
        assertFalse(b.hasBackgroundWork("m1"))
    }

    @Test
    fun revisionAndServerConsumes() {
        val b = started(""","maxItemBytes":2048""").broker
        val rev = assertNotNull(b.revisionJson("gallery.pick", 1u))
        val r = obj(rev)
        assertEquals("unary", r["mode"]!!.jsonPrimitive.content)
        assertEquals("binaryUpload", r["data"]!!.jsonPrimitive.content)
        assertEquals(2048, r["maxItemBytes"]!!.jsonPrimitive.int)
        assertTrue(r["lifetimes"] is JsonArray)
        assertNull(b.revisionJson("gallery.pick", 42u))
        assertNull(b.revisionJson("no.such", 1u))
        // A revision answer feeds straight back into deviceServerConsumes.
        assertTrue(deviceServerConsumes(rev))
        assertFalse(deviceServerConsumes("""{"mode":"stream","data":"binaryDownload"}"""))
        assertTrue(deviceServerConsumes("""{"mode":"stream","data":"jsonEvents"}"""))
        assertFailsWith<DeviceBindingException> { deviceServerConsumes("""{"mode":"stream"}""") }
        assertTrue(b.supports("gallery.pick"))
        assertEquals(1u, b.selectedVersion("gallery.pick"))
        assertNull(b.selectedVersion("mic.record"))
        val core = assertNotNull(b.coreStreamId())
        val reopened = assertNotNull(b.reopenCoreCapabilities(10uL))
        assertTrue(reopened > core)
        assertTrue(obj(b.infoJson())["lastConnectionViolation"] is JsonNull)
    }
}
