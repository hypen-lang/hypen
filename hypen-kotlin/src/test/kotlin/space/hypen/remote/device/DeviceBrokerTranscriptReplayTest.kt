package space.hypen.remote.device

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import uniffi.hypen_engine.DeviceBroker
import uniffi.hypen_engine.DeviceOpenResult
import uniffi.hypen_engine.DeviceOutcome
import uniffi.hypen_engine.DeviceOutput
import uniffi.hypen_engine.deviceSha256Hex
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Every shared wire transcript (`engine-compatibility-tests/fixtures/device/
 * transcripts`) replayed through the REAL Rust `DeviceBroker` — reached
 * through the generated UniFFI bindings, exactly as `DevicePlane` drives it —
 * in the **server** role. Kotlin port of
 * `hypen-engine-rs/tests/test_device_broker_transcripts.rs`; the SDK has no
 * protocol implementation of its own, so this is its conformance runner.
 *
 * The harness plays the client: every `c2s` step goes into the broker
 * (`onText` / `onFrame`) and the broker's `poll()` outputs are checked
 * against the `s2c` steps:
 *
 * - an `s2c` `deviceRequest` is produced by `open` (or `start` / a planned
 *   reopen for `core.capabilities`) and must be exactly the message the
 *   broker emits (ids translated to the broker's own monotone ids);
 * - an `s2c` `cancel` is produced by `cancel` / an owner sweep / the planned
 *   reopen and is emitted exactly once;
 * - an `s2c` frame is the next frame the broker's scheduler hands out, byte
 *   for byte; an `s2c` `renewLease n` is reached by advancing the injected
 *   clock on the fixed 5 s cadence; an `s2c` `grant` requires that the
 *   broker also replenished that request and that the sender is not starved;
 * - a `c2s` violation is detected in its category: request-level ones
 *   terminate the request `invalidParams` with exactly one `cancel` (none
 *   after the client's own terminal); connection-level ones are counted and
 *   touch no request; a terminal on the live core stream closes the plane;
 *   an `ignored` step has no effect at all;
 * - an `s2c` step flagged as a violation is what a broken server sends: the
 *   broker refuses to produce it.
 *
 * Every output is also checked on its own (well-formed controls, renewals
 * from 1 and +1, well-formed non-empty ≤ 64 KiB channel-0 download frames
 * with contiguous `seq`), and every success is checked against the
 * transcript's result and the bytes actually delivered.
 */
class DeviceBrokerTranscriptReplayTest {
    private val json = Json

    private fun load(): List<Pair<String, JsonObject>> {
        val dir = File(DeviceFixtures.deviceFixtures, "transcripts")
        val files = dir.listFiles { f -> f.isFile && f.extension == "json" }?.sortedBy { it.name }.orEmpty()
        check(files.isNotEmpty()) { "no transcript fixtures in ${dir.absolutePath}" }
        return files.map { it.nameWithoutExtension to DeviceFixtures.load(it).jsonObject }.filter { "steps" in it.second }
    }

    // ---- small JSON helpers -------------------------------------------------------

    private fun JsonElement?.obj(): JsonObject? = this as? JsonObject

    private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonElement?.num(): Long? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

    private fun JsonObject.msg(): JsonObject = this["message"].obj() ?: JsonObject(emptyMap())

    private fun JsonObject.dir(): String = this["dir"].str()!!

    private fun JsonObject.flag(key: String): Boolean = key in this

    private fun frameBytes(frame: JsonObject): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(DeviceFixtures.hexDecode(frame["hex"].str()!!))
        frame["payloadFill"].obj()?.let { fill ->
            val b = fill["byte"].num()!!.toInt()
            repeat(fill["length"].num()!!.toInt()) { out.write(b) }
        }
        return out.toByteArray()
    }

    private fun withRequestId(frame: ByteArray, id: UInt): ByteArray =
        frame.copyOf().also { ByteBuffer.wrap(it, 4, 4).order(ByteOrder.LITTLE_ENDIAN).putInt(id.toInt()) }

    private class Header(val version: Int, val flags: Int, val channel: Int, val requestId: UInt, val seq: UInt)

    private fun header(frame: ByteArray): Header {
        assertTrue(frame.size >= 12, "frame shorter than its header")
        val b = ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN)
        return Header(b.get(0).toInt() and 0xff, b.get(1).toInt() and 0xff, b.getShort(2).toInt() and 0xffff, b.getInt(4).toUInt(), b.getInt(8).toUInt())
    }

    /** The payload of every unflagged `s2c` frame for transcript id [id] after step [from]. */
    private fun downloadFrames(steps: List<JsonObject>, from: Int, id: Long): ByteArray {
        val out = ByteArrayOutputStream()
        for (later in steps.drop(from + 1)) {
            val f = later["frame"].obj() ?: continue
            if (later.dir() == "s2c" && f["header"].obj()?.get("requestId").num() == id && !later.flag("expectViolation") && !later.flag("ignored")) {
                val bytes = frameBytes(f)
                out.write(bytes, 12, bytes.size - 12)
            }
        }
        return out.toByteArray()
    }

    /** Download payloads by SHA-256, from every transcript whose server sends the complete, matching bytes. */
    private fun downloadTable(docs: List<Pair<String, JsonObject>>): Map<String, ByteArray> {
        val table = HashMap<String, ByteArray>()
        for ((_, doc) in docs) {
            val steps = doc["steps"]!!.jsonArray.map { it.jsonObject }
            for ((i, step) in steps.withIndex()) {
                val m = step.msg()
                if (step.dir() != "s2c" || m["type"].str() != "deviceRequest" || m["capability"].str() != "file.save") continue
                val payload = downloadFrames(steps, i, m["id"].num()!!)
                val params = m["params"].obj()!!
                val sha = params["sha256"].str()!!
                if (payload.size.toLong() == params["bytes"].num() && deviceSha256Hex(payload) == sha) table[sha] = payload
            }
        }
        return table
    }

    // ---- the replay -----------------------------------------------------------------

    private class Log {
        val texts = mutableListOf<JsonObject>()
        val settled = mutableListOf<Pair<UInt, DeviceOutcome>>()
        var closed: Pair<Int, String>? = null
    }

    private inner class Replay(doc: JsonObject) : AutoCloseable {
        val steps: List<JsonObject> = doc["steps"]!!.jsonArray.map { it.jsonObject }
        val broker: DeviceBroker
        var now: ULong = 0uL
        val map = HashMap<Long, UInt>()
        val rev = HashMap<UInt, Long>()
        val selfAcking: Set<Long>
        val lease = HashMap<UInt, Long>()
        val transcriptLease = HashMap<Long, Long>()
        val grantsSince = HashMap<UInt, Long>()
        val cancels = HashMap<UInt, Int>()
        val settled = HashMap<UInt, DeviceOutcome>()
        val frames = ArrayDeque<Pair<UInt, ByteArray>>()
        val frameSeq = HashMap<UInt, UInt>()
        val delivered = HashMap<UInt, ByteArrayOutputStream>()
        val emittedRequests = ArrayDeque<JsonObject>()
        val planes = HashMap<UInt, String>()
        val owners = HashMap<UInt, JsonObject>()
        val refused = HashSet<Long>()
        val swept = HashSet<UInt>()
        var closed = false
        var log = Log()

        init {
            val ack = doc["ack"] ?: BrokerDriver.fullAck
            val server = doc["serverCapabilities"] ?: JsonArray(
                ack.jsonObject["capabilities"]!!.jsonArray.map { c ->
                    buildJsonObject {
                        put("name", c.jsonObject["name"]!!)
                        put("versions", JsonArray(listOf(c.jsonObject["version"]!!)))
                    }
                },
            )
            val extra = LinkedHashMap<String, JsonElement>()
            extra["serverCapabilities"] = server
            // The transcript's own control-stream settings (host configuration).
            steps.firstOrNull { it.dir() == "s2c" && it.msg()["type"].str() == "deviceRequest" && it.msg()["capability"].str() == "core.capabilities" }
                ?.let { core ->
                    extra["controlStreamInitialCredit"] = core.msg()["initialCredit"]!!
                    extra["controlStreamTimeoutMs"] = core.msg()["timeoutMs"]!!
                }
            broker = DeviceBroker(BrokerDriver.config(ack, extra), null, 0uL)
            selfAcking = steps.filter { it.dir() == "c2s" && it.msg()["control"].obj()?.containsKey("leaseAck") == true }
                .map { it.msg()["id"].num()!! }.toSet()
        }

        fun bid(t: Long): UInt = map[t] ?: (UNMAPPED_BASE + t).toUInt()

        fun link(t: Long, b: UInt) {
            map[t] = b
            rev[b] = t
        }

        fun info(): JsonObject = json.parseToJsonElement(broker.infoJson()).jsonObject

        val started: Boolean get() = info()["started"].toString() == "true"

        val connectionViolations: Long get() = info()["connectionViolations"].num()!!

        /** Drain the broker until quiescent, checking every output, acting as the handler and as a live client. */
        fun pump(at: String) {
            while (true) {
                val out = broker.poll()
                if (out.isEmpty()) break
                val acks = mutableListOf<Pair<UInt, Long>>()
                val consumed = mutableListOf<UInt>()
                for (o in out) when (o) {
                    is DeviceOutput.SendText -> {
                        val m = json.parseToJsonElement(o.text).jsonObject
                        val id = m["id"].num()!!.toUInt()
                        when (m["type"].str()) {
                            "deviceRequest" -> {
                                val r = assertNotNull(
                                    broker.revisionJson(m["capability"].str()!!, m["version"].num()!!.toUInt()),
                                    "$at: broker sent a request for a non-registry revision",
                                ).let { json.parseToJsonElement(it).jsonObject }
                                planes[id] = r["data"].str()!!
                                owners[id] = m["owner"].obj()!!
                                emittedRequests.addLast(m)
                            }
                            "deviceEvent" -> {
                                val control = assertNotNull(m["control"].obj(), "$at: broker sent a capability event")
                                assertEquals(1, control.size, "$at: exactly one control")
                                assertNull(m["event"], "$at: broker sent a capability event")
                                when {
                                    "cancel" in control -> {
                                        assertEquals(JsonPrimitive(true), control["cancel"])
                                        cancels[id] = (cancels[id] ?: 0) + 1
                                    }
                                    "renewLease" in control -> {
                                        val n = control["renewLease"].num()!!
                                        val last = lease[id] ?: 0
                                        assertEquals(last + 1, n, "$at: renewals start at 1 and increase by 1")
                                        lease[id] = n
                                        if (rev[id]?.let { it in selfAcking } != true) acks += id to n
                                    }
                                    "grant" in control -> {
                                        assertTrue(planes[id] == "jsonEvents" || planes[id] == "binaryUpload", "$at: grant on a request without a client → server plane")
                                        val g = control["grant"].num()!!
                                        assertTrue(g >= 1, "$at: grant ≥ 1")
                                        grantsSince[id] = (grantsSince[id] ?: 0) + g
                                    }
                                    else -> fail("$at: broker sent a client-side control $control")
                                }
                            }
                            else -> fail("$at: broker sent ${m["type"]}")
                        }
                        log.texts += m
                    }
                    is DeviceOutput.SendFrame -> {
                        val h = header(o.frame)
                        assertEquals(1, h.version)
                        assertEquals(0, h.flags)
                        assertEquals(0, h.channel, "$at: download frames use channel 0")
                        val payload = o.frame.size - 12
                        assertTrue(payload in 1..65_536, "$at: frame payload 1..=64 KiB")
                        assertEquals("binaryDownload", planes[h.requestId])
                        val seq = frameSeq[h.requestId] ?: 0u
                        assertEquals(seq, h.seq, "$at: contiguous download seq")
                        frameSeq[h.requestId] = seq + 1u
                        frames.addLast(h.requestId to o.frame)
                    }
                    is DeviceOutput.Event -> {
                        // A consumer that has not caught up: no replenishing
                        // grants beyond what the transcript shows.
                    }
                    is DeviceOutput.Data -> {
                        delivered.getOrPut(o.id) { ByteArrayOutputStream() }.write(o.bytes)
                        consumed += o.id
                    }
                    is DeviceOutput.Settled -> {
                        assertNull(settled.put(o.id, o.outcome), "$at: request ${o.id} settled twice")
                        log.settled += o.id to o.outcome
                    }
                    is DeviceOutput.CloseConnection -> {
                        assertTrue(log.closed == null && !closed, "$at: closed twice")
                        log.closed = o.code.toInt() to o.reason
                        closed = true
                    }
                }
                for (id in consumed) broker.consumedData(id, 1u, now)
                for ((id, seq) in acks) {
                    if (broker.isLive(id)) broker.onText("""{"type":"deviceEvent","id":$id,"control":{"leaseAck":$seq}}""", now)
                }
            }
        }

        fun takeLog(): Log = log.also { log = Log() }

        /** Register the owner's activation as live (the host's module lifecycle). */
        fun activate(owner: JsonObject?): Boolean {
            if (owner == null) return false
            val module = owner["moduleInstanceId"].str() ?: return false
            val activation = owner["activationId"].num()?.toUInt() ?: return false
            return broker.ownerIsActive(module, activation) || broker.ownerActivated(module, activation, now)
        }

        fun spec(m: JsonObject): JsonObject {
            val owner = m["owner"].obj()
            val (module, activation) = when {
                owner?.get("activationId") != null && owner["moduleInstanceId"].str() != null ->
                    owner["moduleInstanceId"].str()!! to owner["activationId"]!!
                owner?.get("moduleInstanceId").str() != null -> owner!!["moduleInstanceId"].str()!! to JsonPrimitive(1)
                else -> "connection" to JsonPrimitive(1)
            }
            return JsonObject(
                mapOf(
                    "capability" to m["capability"]!!,
                    "version" to m["version"]!!,
                    "params" to (m["params"] ?: JsonNull),
                    "moduleInstanceId" to JsonPrimitive(module),
                    "activationId" to activation,
                    "lifetime" to m["lifetime"]!!,
                    "timeoutMs" to m["timeoutMs"]!!,
                    "initialCredit" to m["initialCredit"]!!,
                    // Transcript servers may open an upload at zero credit.
                    "allowZeroCredit" to JsonPrimitive(true),
                ),
            )
        }

        fun open(m: JsonObject, download: ByteArray?): DeviceOpenResult = broker.open(spec(m).toString(), download, now)

        fun emittedOwner(b: UInt): JsonObject = owners[b] ?: fail("request $b was not emitted by the broker")

        fun ownedLive(owner: JsonObject): Set<UInt> = owners.filter { (id, o) -> o == owner && broker.isLive(id) }.keys

        override fun close() = broker.destroy()
    }

    private fun outcomeCode(o: DeviceOutcome?): String? = (o as? DeviceOutcome.Failure)?.code

    private class Counts {
        var transcripts = 0
        var requests = 0
        var c2sViolations = 0
        var requestLevel = 0
        var connectionLevel = 0
        var connectionCloses = 0
        var s2cRefusals = 0
        var framesMatched = 0
        var ignored = 0
        var successes = 0
        var sweeps = 0
        var reopens = 0
        var faultyServerDownloads = 0

        override fun toString(): String =
            "transcripts=$transcripts requests=$requests c2sViolations=$c2sViolations requestLevel=$requestLevel " +
                "connectionLevel=$connectionLevel connectionCloses=$connectionCloses s2cRefusals=$s2cRefusals " +
                "framesMatched=$framesMatched ignored=$ignored successes=$successes sweeps=$sweeps reopens=$reopens " +
                "faultyServerDownloads=$faultyServerDownloads"
    }

    private fun isCancel(m: JsonObject, id: UInt): Boolean =
        m["type"].str() == "deviceEvent" && m["id"].num() == id.toLong() && m["control"].obj()?.containsKey("cancel") == true

    private fun run(name: String, doc: JsonObject, table: Map<String, ByteArray>, counts: Counts) = Replay(doc).use { r ->
        val steps = r.steps
        var pendingReaction: Pair<Long, Int>? = null
        var ended = false
        val flaggedC2s = steps.count { it.dir() == "c2s" && it.flag("expectViolation") }
        var seenC2s = 0

        for ((i, step) in steps.withIndex()) {
            val at = "$name step $i"
            assertTrue(!ended, "$at: nothing may follow a closed device connection")
            val dir = step.dir()
            val reaction = step.flag("reaction")
            val ignored = step.flag("ignored")
            val category = step["expectViolation"].str()
            val msg = step.msg()

            if (dir == "s2c") {
                if (reaction) {
                    val (t, before) = pendingReaction ?: fail("$at: reaction without a violation")
                    pendingReaction = null
                    assertEquals(t, msg["id"].num(), "$at: reaction id")
                    assertEquals(JsonPrimitive(true), msg["control"].obj()?.get("cancel"), "$at: the server's reaction is cancel")
                    assertEquals(before + 1, r.cancels[r.bid(t)] ?: 0, "$at: exactly one cancel")
                    if (r.closed) ended = true // a violated core stream takes the plane down
                    continue
                }
                if (ignored) continue
                if (category != null) {
                    // A broken server's message: the broker never produces it.
                    if (msg["type"].str() == "deviceRequest") {
                        counts.s2cRefusals++
                        val t = msg["id"].num()!!
                        if (msg["capability"].str() == "core.capabilities") {
                            if (r.started) assertTrue(r.broker.start(r.now) is DeviceOpenResult.Refused, "$at: a second core stream")
                            val spec = r.spec(msg)
                            r.activate(spec)
                            assertTrue(r.open(msg, null) is DeviceOpenResult.Refused, "$at: app code opened core.capabilities")
                        } else {
                            r.activate(msg["owner"].obj())
                            when (val res = r.open(msg, null)) {
                                is DeviceOpenResult.Refused -> if (category == "unsupported") {
                                    assertTrue(res.code == "unsupported" || res.code == "unavailable", "$at: ${res.code} ${res.detail}")
                                }
                                is DeviceOpenResult.Opened -> {
                                    // Clamped into a valid request: never the violating one.
                                    r.pump(at)
                                    val emitted = r.emittedRequests.removeLastOrNull() ?: fail("$at: emitted request")
                                    assertTrue(r.emittedRequests.isEmpty())
                                    val want = JsonObject(msg + ("id" to JsonPrimitive(res.id.toLong())))
                                    assertNotEquals<JsonElement>(want, emitted, "$at: broker emitted the violating request")
                                    r.broker.cancel(res.id, r.now)
                                    r.pump(at)
                                    assertTrue(t !in r.map, "$at: a refused transcript id is never live")
                                }
                            }
                        }
                        r.pump(at)
                        assertTrue(r.emittedRequests.isEmpty(), "$at: refused request was sent")
                    }
                    continue
                }
                val frame = step["frame"].obj()
                if (frame != null) {
                    val t = frame["header"].obj()!!["requestId"].num()!!
                    if (t in r.refused) continue
                    val b = r.bid(t)
                    r.pump(at)
                    val (id, got) = r.frames.removeFirstOrNull() ?: fail("$at: broker sent no frame")
                    assertEquals(b, id, "$at: frame for the wrong request")
                    assertTrue(got.contentEquals(withRequestId(frameBytes(frame), b)), "$at: frame bytes differ")
                    counts.framesMatched++
                    continue
                }
                when (msg["type"].str()) {
                    "deviceRequest" -> {
                        val t = msg["id"].num()!!
                        counts.requests++
                        val isCore = msg["capability"].str() == "core.capabilities"
                        var skip = false
                        if (isCore && !r.started) {
                            val res = r.broker.start(r.now)
                            assertTrue(res is DeviceOpenResult.Opened, "$at: start refused: $res")
                        } else if (!isCore) {
                            assertTrue(r.activate(msg["owner"].obj()), "$at: activation refused")
                            val revision = r.broker.revisionJson(msg["capability"].str()!!, msg["version"].num()!!.toUInt())
                                ?.let { json.parseToJsonElement(it).jsonObject }
                            var download: ByteArray? = null
                            if (revision?.get("data").str() == "binaryDownload") {
                                val params = msg["params"].obj()!!
                                val declared = params["bytes"].num()!!.toInt()
                                var bytes = downloadFrames(steps, i, t)
                                if (bytes.isEmpty()) bytes = table[params["sha256"].str()!!] ?: ByteArray(0)
                                download = bytes.copyOf(declared)
                            }
                            val faulty = download != null && deviceSha256Hex(download) != msg["params"].obj()!!["sha256"].str()
                            when (val res = r.open(msg, download)) {
                                is DeviceOpenResult.Opened -> {
                                    assertTrue(!faulty, "$at: broker announced bytes it does not send")
                                    r.link(t, res.id)
                                }
                                is DeviceOpenResult.Refused -> {
                                    // The transcript's server sends bytes that do not match its own
                                    // announcement: the broker never announces such a download, and
                                    // the client's success is the flagged violation.
                                    assertTrue(faulty, "$at: open refused: ${res.code} ${res.detail}")
                                    assertEquals("invalidParams", res.code)
                                    assertTrue(
                                        steps.drop(i + 1).any {
                                            it.dir() == "c2s" && it.msg()["id"].num() == t && it.msg()["type"].str() == "deviceResponse" &&
                                                "result" in it.msg() && it.flag("expectViolation")
                                        },
                                        "$at: a faulty download must end in a flagged success",
                                    )
                                    r.refused += t
                                    counts.faultyServerDownloads++
                                    skip = true
                                }
                            }
                        }
                        if (skip) continue
                        r.pump(at)
                        val emitted = r.emittedRequests.removeFirstOrNull() ?: fail("$at: broker emitted no request")
                        assertTrue(r.emittedRequests.isEmpty(), "$at: extra requests")
                        val emittedId = emitted["id"].num()!!.toUInt()
                        if (isCore) {
                            r.link(t, emittedId)
                            assertEquals(emittedId, r.broker.coreStreamId())
                        }
                        val want = JsonObject(msg + ("id" to JsonPrimitive(emittedId.toLong())))
                        // Host configuration: the first core stream's credit is the transcript's; a reopen reuses it.
                        val got = if (isCore) JsonObject(emitted + ("initialCredit" to want["initialCredit"]!!)) else emitted
                        assertEquals<JsonElement>(want, got, "$at: emitted request differs")
                    }
                    "deviceEvent" -> {
                        val t = msg["id"].num()!!
                        if (t in r.refused) continue
                        val b = r.bid(t)
                        val control = msg["control"].obj() ?: fail("$at: unexpected server step $msg")
                        when {
                            "renewLease" in control -> {
                                val n = control["renewLease"].num()!!
                                r.transcriptLease[t] = maxOf(r.transcriptLease[t] ?: 0, n)
                                repeat(10) {
                                    if ((r.lease[b] ?: 0) >= n || !r.broker.isLive(b)) return@repeat
                                    r.now += 5_000uL
                                    r.broker.tick(r.now)
                                    r.pump(at)
                                }
                                assertTrue((r.lease[b] ?: 0) >= n, "$at: broker never renewed to $n")
                                assertTrue(r.broker.isLive(b), "$at: the request expired while renewing")
                            }
                            "cancel" in control -> {
                                if (b in r.swept) {
                                    assertEquals(1, r.cancels[b], "$at: swept request cancelled once")
                                    continue
                                }
                                assertTrue(r.broker.isLive(b), "$at: cancel of a non-live request")
                                if (r.broker.coreStreamId() == b) {
                                    // Planned reopen: retire the old stream first.
                                    val next = steps.drop(i + 1).firstOrNull { it.dir() == "s2c" && !it.flag("ignored") } ?: fail("$at: a reopen follows")
                                    assertEquals("core.capabilities", next.msg()["capability"].str(), "$at: core cancel is a reopen")
                                    val newId = r.broker.reopenCoreCapabilities(r.now) ?: fail("$at: not reopened")
                                    r.pump(at)
                                    assertEquals(1, r.cancels[b], "$at: old stream cancelled")
                                    assertTrue(!isCancel(r.log.texts.last(), b), "$at: the cancel precedes the new request")
                                    assertEquals(newId, r.broker.coreStreamId())
                                    counts.reopens++
                                    continue
                                }
                                // An owner sweep when the consecutive cancels cover exactly one
                                // activation's live work; else a caller abandon.
                                val run = steps.drop(i)
                                    .takeWhile { it.dir() == "s2c" && it.msg()["control"].obj()?.containsKey("cancel") == true && !it.flag("reaction") }
                                    .map { r.bid(it.msg()["id"].num()!!) }
                                    .toSet()
                                val owner = r.emittedOwner(b)
                                if (run.size > 1 && run == r.ownedLive(owner)) {
                                    val module = owner["moduleInstanceId"].str()
                                    val activation = owner["activationId"].num()
                                    if (module != null && activation != null) r.broker.ownerDeactivated(module, activation.toUInt(), r.now)
                                    r.pump(at)
                                    for (id in run) {
                                        assertEquals(1, r.cancels[id], "$at: swept $id")
                                        assertEquals("cancelled", outcomeCode(r.settled[id]))
                                    }
                                    r.swept += run
                                    counts.sweeps++
                                } else {
                                    r.broker.cancel(b, r.now)
                                    r.pump(at)
                                    assertEquals(1, r.cancels[b], "$at: one cancel")
                                    assertEquals("cancelled", outcomeCode(r.settled[b]))
                                }
                            }
                            "grant" in control -> {
                                r.pump(at)
                                val granted = r.grantsSince.remove(b) ?: 0
                                assertTrue(granted > 0, "$at: the broker did not replenish where the transcript server did")
                                val outstanding = r.broker.outstandingCredit(b)?.takeIf { it > 0uL } ?: r.broker.outstandingEventCredit(b) ?: 0uL
                                assertTrue(outstanding > 0uL, "$at: sender starved")
                            }
                            else -> fail("$at: unexpected server step $msg")
                        }
                    }
                    else -> fail("$at: unexpected server step type ${msg["type"]}")
                }
                val log = r.takeLog()
                r.emittedRequests.firstOrNull()?.let { fail("$at: unclaimed request $it") }
                assertNull(log.closed, "$at: unexpected close")
                continue
            }

            // ---- c2s: the client's step into the broker ----
            assertNull(pendingReaction, "$at: missing server reaction")
            r.pump(at)
            r.takeLog()
            var t: Long? = null
            var isResponse = false
            val violationsBefore = r.connectionViolations
            val frame = step["frame"].obj()
            val raw = step["raw"].str()
            var inputText: String? = null
            var inputFrame: ByteArray? = null
            when {
                frame != null -> {
                    t = frame["header"].obj()!!["requestId"].num()!!
                    inputFrame = withRequestId(frameBytes(frame), r.bid(t))
                }
                raw != null -> {
                    t = runCatching { json.parseToJsonElement(raw).jsonObject["id"].num() }.getOrNull()
                    inputText = t?.let { tid ->
                        if (r.bid(tid).toLong() != tid) raw.replace("\"id\":$tid", "\"id\":${r.bid(tid)}") else raw
                    } ?: raw
                }
                else -> {
                    val tid = msg["id"].num()!!
                    t = tid
                    isResponse = msg["type"].str() == "deviceResponse"
                    val b = r.bid(tid)
                    var m = JsonObject(msg + ("id" to JsonPrimitive(b.toLong())))
                    msg["control"].obj()?.get("leaseAck").num()?.let { ack ->
                        // The broker sends renewLease 1 WITH each request (§2.7): a transcript
                        // whose server had not renewed yet sits below it.
                        val offset = (r.lease[b] ?: 0) - (r.transcriptLease[tid] ?: 0)
                        m = JsonObject(m + ("control" to buildJsonObject { put("leaseAck", ack + maxOf(offset, 0)) }))
                    }
                    inputText = m.toString()
                }
            }
            if (t != null && t in r.refused) {
                if (category != null) seenC2s++ // prevented at the source
                continue
            }
            val b = t?.let { r.bid(it) }
            val wasLive = b != null && r.broker.isLive(b)
            val wasCore = b != null && r.broker.coreStreamId() == b
            val cancelsBefore = b?.let { r.cancels[it] ?: 0 } ?: 0
            if (inputFrame != null) r.broker.onFrame(inputFrame, r.now) else r.broker.onText(inputText!!, r.now)
            r.pump(at)
            val log = r.takeLog()

            if (ignored) {
                counts.ignored++
                assertTrue(!wasLive, "$at: an ignored step targets a live id")
                assertTrue(log.texts.isEmpty() && log.settled.isEmpty() && log.closed == null, "$at: ignored step had effects")
                assertEquals(violationsBefore, r.connectionViolations, at)
                continue
            }

            if (category == null) {
                assertEquals(violationsBefore, r.connectionViolations, "$at: unexpected connection-level violation")
                assertNull(log.closed, "$at: unexpected close ${log.closed}")
                val bb = b ?: fail("$at: attributable step")
                for (m in log.texts) assertTrue(!isCancel(m, bb), "$at: unexpected cancel")
                if (wasLive && !r.broker.isLive(bb)) {
                    assertTrue(isResponse, "$at: request ended by a non-terminal step")
                    val outcome = r.settled[bb] ?: fail("$at: not settled")
                    val err = msg["error"].obj()
                    if (err != null) {
                        assertEquals(err["code"].str(), outcomeCode(outcome), at)
                    } else {
                        checkSuccess(at, r, bb, msg, outcome)
                        counts.successes++
                    }
                } else if (wasLive) {
                    assertTrue(bb !in r.settled, "$at: settled by a non-terminal step")
                }
                continue
            }

            seenC2s++
            counts.c2sViolations++
            val next = steps.getOrNull(i + 1)
            val bb = b ?: 0u
            if (category == "connection") {
                assertTrue(wasLive && !r.broker.isLive(bb), "$at: the core stream ended")
                assertNull(r.broker.coreStreamId())
                val (code, _) = log.closed ?: fail("$at: device plane closed")
                assertEquals(1012, code)
                assertTrue(r.broker.isClosed())
                assertEquals(steps.size - 1, i, "$at: connection violations end the transcript")
                counts.connectionCloses++
                ended = true
                continue
            }
            val requestLevel = wasLive && !r.broker.isLive(bb)
            if (!requestLevel) {
                assertEquals("malformed", category, "$at: only malformed is connection-level")
                assertEquals(violationsBefore + 1, r.connectionViolations, "$at: counted")
                if (wasLive) assertTrue(r.broker.isLive(bb), "$at: the named request lives on")
                assertTrue(log.texts.isEmpty() && log.settled.isEmpty(), "$at: no request touched")
                assertTrue(next == null || !next.flag("reaction"), "$at: no reaction")
                counts.connectionLevel++
                continue
            }
            counts.requestLevel++
            if (wasCore) {
                // The violated stream was core.capabilities: cancel, then the device plane closes.
                val cancelIdx = log.texts.indexOfFirst { isCancel(it, bb) }
                assertEquals(0, cancelIdx, "$at: the reaction goes out first")
                assertTrue(r.broker.isClosed())
            } else {
                val outcome = r.settled[bb] ?: fail("$at: violation did not settle")
                assertEquals("invalidParams", outcomeCode(outcome), "$at: $outcome")
                assertEquals(violationsBefore, r.connectionViolations, at)
            }
            if (isResponse) {
                assertEquals(cancelsBefore, r.cancels[bb] ?: 0, "$at: no cancel after the client's own terminal")
                assertTrue(next == null || !next.flag("reaction"), "$at: no reaction follows a terminal")
            } else {
                assertTrue(next != null && next.flag("reaction"), "$at: reaction step expected")
                pendingReaction = t!! to cancelsBefore
            }
        }
        assertNull(pendingReaction, "$name: transcript ends before the reaction")
        assertEquals(flaggedC2s, seenC2s, "$name: every c2s violation exercised")
        if (!ended) assertTrue(r.log.closed == null && !r.broker.isClosed(), "$name: the plane must stay up")
        counts.transcripts++
    }

    private fun checkSuccess(at: String, r: Replay, b: UInt, msg: JsonObject, outcome: DeviceOutcome) {
        val ok = outcome as? DeviceOutcome.Success ?: fail("$at: expected success, got $outcome")
        val result = json.parseToJsonElement(ok.resultJson)
        assertEquals(msg["result"], result, "$at: result passes through")
        assertEquals("simulated" in msg, ok.simulated, "$at: simulated flag")
        val items: List<JsonObject> = result.obj()?.let { o ->
            (o["items"] as? JsonArray)?.map { it.jsonObject } ?: listOfNotNull(o["item"].obj())
        }.orEmpty()
        val plane = r.planes[b]
        val streamed = r.delivered[b]
        when {
            plane == "binaryUpload" && items.isNotEmpty() && streamed != null -> {
                // Streamed: the handler received exactly the one verified item.
                assertTrue(ok.blobs.isEmpty())
                val bytes = streamed.toByteArray()
                assertEquals(1, items.size)
                assertEquals(items[0]["bytes"].num(), bytes.size.toLong(), at)
                assertEquals(items[0]["sha256"].str(), deviceSha256Hex(bytes), "$at: delivered bytes verify")
            }
            plane == "binaryUpload" -> {
                assertEquals(items.size, ok.blobs.size, "$at: one blob per item")
                for ((blob, item) in ok.blobs.zip(items)) {
                    assertEquals(item["channel"].num(), blob.channel.toLong())
                    assertEquals(item["contentType"].str(), blob.contentType)
                    assertEquals(item["bytes"].num(), blob.bytes.size.toLong())
                    assertEquals(item["sha256"].str(), deviceSha256Hex(blob.bytes), "$at: blob verifies")
                }
            }
            else -> assertTrue(ok.blobs.isEmpty())
        }
    }

    @TestFactory
    fun `every wire transcript replays through the Rust broker as server`(): List<DynamicTest> {
        val docs = load()
        val table = downloadTable(docs)
        val counts = Counts()
        val tests = docs.map { (name, doc) -> DynamicTest.dynamicTest(name) { run(name, doc, table, counts) } }
        val floors = DynamicTest.dynamicTest("coverage floors") {
            assertTrue(docs.size > 100, "the shared corpus is present")
            assertTrue(table.isNotEmpty())
            println(counts)
            assertEquals(docs.size, counts.transcripts, "every transcript replayed: $counts")
            // The corpus exercises every reaction path.
            assertTrue(counts.c2sViolations > 40, "$counts")
            assertTrue(counts.requestLevel > 30, "$counts")
            assertTrue(counts.connectionLevel >= 3, "$counts")
            assertTrue(counts.connectionCloses >= 1, "$counts")
            assertTrue(counts.s2cRefusals >= 10, "$counts")
            assertTrue(counts.framesMatched >= 4, "$counts")
            assertTrue(counts.ignored >= 15, "$counts")
            assertTrue(counts.successes >= 20, "$counts")
            assertTrue(counts.sweeps >= 1, "$counts")
            assertTrue(counts.reopens >= 1, "$counts")
            assertTrue(counts.faultyServerDownloads >= 1, "$counts")
        }
        return tests + floors
    }

    private companion object {
        /** Transcript ids no step maps to a broker id get an id the broker never allocates. */
        const val UNMAPPED_BASE: Long = 0x4000_0000
    }
}
