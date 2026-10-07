@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import space.hypen.renderer.model.DeviceMalformedMessage
import space.hypen.renderer.model.DeviceWireMessage
import space.hypen.renderer.remote.MoshiMessageParser
import space.hypen.renderer.remote.StrictDeviceJson
import java.io.ByteArrayInputStream
import java.io.File

/**
 * Replays every shared transcript in
 * `engine-compatibility-tests/fixtures/device/transcripts/` against the real
 * Android [DeviceConnection], acting as the **client** endpoint (the
 * reference model is `hypen-engine-rs/tests/test_device_transcripts.rs`).
 *
 * Every server → client step is delivered through the renderer's socket
 * edge ([MoshiMessageParser], strict device JSON; frames as bytes). Every
 * client → server step is either produced by the Android runtime itself
 * (lease acks, `paused` transitions, blob announcements, frames and verified
 * items, reactions, `cancelled` terminals) or asked of a scripted driver
 * (events, progress, terminal results, download credit) and then compared
 * with what the runtime actually sent:
 *
 * - `expectViolation` on a server step: the client detects it — `connection`
 *   closes the socket; an attributable violation terminates the id with the
 *   reaction's exact code; connection-level `malformed` text or frame
 *   headers change nothing and send nothing (decision D3);
 * - `ignored` server steps produce no output at all;
 * - a server `cancel` on a live id makes the client send its `cancelled`
 *   terminal (the transcripts show the server ignoring whatever the client
 *   sent after retiring the id);
 * - uploads are compared by meaning, not chunking: the announced items, the
 *   per-channel bytes (contiguous `seq`, no empty frame), `paused`
 *   transitions (nothing sent while paused), cumulative bytes never beyond
 *   the credit granted so far, and the terminal items;
 * - client → server steps that are themselves violations (or `ignored` late
 *   messages) describe a misbehaving or racing client and are not produced;
 *   after one, the id's remaining client output is not compared.
 *
 * The four handshake-selection fixtures are checked with [DeviceHandshake].
 * No transcript is skipped.
 */
class DeviceTranscriptTest {
    private val parser = MoshiMessageParser()

    private fun transcriptFiles(): List<File> =
        File(CompatFixtures.root, "fixtures/device/transcripts").listFiles { f -> f.name.endsWith(".json") }!!.sortedBy { it.name }

    @Suppress("UNCHECKED_CAST")
    private fun load(f: File): Map<String, Any?> = StrictDeviceJson.parseTrusted(f.readText()) as Map<String, Any?>

    @Test
    fun `every shared transcript replays against the Android client`() {
        val files = transcriptFiles()
        assertTrue("transcripts found: ${files.size}", files.size >= 100)
        val failures = mutableListOf<String>()
        val stats = Stats()
        for (f in files) {
            val doc = load(f)
            assertEquals(f.name, "${doc["name"]}.json")
            try {
                if ("hello" in doc) replayHandshake(doc, stats) else runTest { Replay(this, doc, stats).run() }
                stats.transcripts += 1
            } catch (e: AssertionError) {
                failures += "${doc["name"]}: ${e.message}"
            }
        }
        println("device transcripts (android client): $stats")
        if (failures.isNotEmpty()) fail("${failures.size} transcript(s) failed:\n" + failures.joinToString("\n"))
        assertEquals(files.size, stats.transcripts)
        assertTrue("violations detected: $stats", stats.clientDetected >= 30)
        assertTrue("reactions: $stats", stats.reactions >= 25)
    }

    class Stats {
        var transcripts = 0
        var clientDetected = 0
        var reactions = 0
        var produced = 0
        var uploadsVerified = 0
        var serverSideSteps = 0

        override fun toString() =
            "transcripts=$transcripts clientDetected=$clientDetected reactions=$reactions produced=$produced " +
                "uploadsVerified=$uploadsVerified serverSideSteps=$serverSideSteps"
    }

    // ---- handshake-selection fixtures ------------------------------------------------------

    private fun replayHandshake(doc: Map<String, Any?>, stats: Stats) {
        @Suppress("UNCHECKED_CAST")
        val hello = doc["hello"] as Map<String, Any?>
        val expect = doc["expectAck"]
        val problem = DeviceHandshake.validateHello(hello)
        if (problem != null) {
            // The Android host never sends such a hello; the reference disables device.
            if (expect != null) throw AssertionError("invalid hello ($problem) but the reference selected")
            return
        }
        if (expect == null) return
        when (val outcome = DeviceHandshake.accept(expect, hello)) {
            is AckOutcome.Disabled -> throw AssertionError("reference ack refused: ${outcome.reason}")
            is AckOutcome.Selected -> {
                @Suppress("UNCHECKED_CAST")
                val pairs = ((expect as Map<String, Any?>)["capabilities"] as List<Map<String, Any?>>).associate { it["name"] as String to it["version"] as Long }
                assertEquals(pairs, outcome.selection.capabilities)
                assertEquals(expect["binary"], outcome.selection.binary)
                stats.produced += 1
            }
        }
    }

    // ---- wire transcripts --------------------------------------------------------------------

    private sealed class Action {
        class Emit(val event: Map<String, Any?>) : Action()

        class Grant(val bytes: Long) : Action()

        class Finish(val outcome: DriverOutcome) : Action()
    }

    /** A driver whose operations do exactly what the runner tells them. */
    private class ScriptedDriver(override val capability: String, private val available: MutableSet<String>, private val runner: Replay) : DeviceDriver {
        override val binary: Boolean get() = DeviceRegistry.revision(capability, 1)?.data.let { it == DataPlane.BINARY_UPLOAD || it == DataPlane.BINARY_DOWNLOAD }

        override fun isAvailable(): Boolean = capability in available

        override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

        override suspend fun run(ctx: DriverContext): DriverOutcome {
            val actions = Channel<Action>(Channel.UNLIMITED)
            runner.scripts[ctx.request.id] = actions
            runner.contexts[ctx.request.id] = ctx
            for (a in actions) {
                when (a) {
                    is Action.Emit -> {
                        if (a.event["kind"] == "progress") {
                            ctx.progress(ProgressState.entries.first { it.wireName == a.event["state"] })
                        } else {
                            ctx.emit(a.event, coalesceKey = null)
                        }
                    }
                    is Action.Grant -> ctx.grantDownload(a.bytes)
                    is Action.Finish -> return a.outcome
                }
            }
            error("script closed")
        }
    }

    private inner class Replay(private val scope: TestScope, private val doc: Map<String, Any?>, private val stats: Stats) {
        val name = doc["name"] as String

        @Suppress("UNCHECKED_CAST")
        val steps = doc["steps"] as List<Map<String, Any?>>
        val scripts = HashMap<Long, Channel<Action>>()
        val contexts = HashMap<Long, DriverContext>()

        /** Live-capture uploads (stream revisions, e.g. mic.record): bytes are fed step by step. */
        private val liveBuffers = HashMap<Long, LiveCaptureBuffer>()

        /** Frame steps whose bytes were already fed to a live buffer. */
        private val fedSteps = HashSet<Int>()
        private var currentIndex = 0
        private val available = LinkedHashSet<String>()
        private val transport = FakeTransport()
        private lateinit var host: DeviceHost
        private lateinit var connection: DeviceConnection

        /** Outputs already matched (indexes into transport.sent). */
        private val consumed = HashSet<Int>()

        /** Ids whose remaining client output is not compared (after a client-side violation). */
        private val abandoned = HashSet<Long>()
        private val coreIds = HashSet<Long>()
        private val coreIdsWithSnapshots = HashSet<Long>()
        private val uploadTriggered = HashSet<Long>()
        private val requests = HashMap<Long, Map<String, Any?>>()
        private val credit = HashMap<Long, Long>()
        private val ackedSeqs = HashMap<Long, MutableSet<Long>>()

        /** Renewals delivered to the client: every lease ack it sends must answer one of these. */
        private val renewals = HashSet<Pair<Long, Long>>()

        /** Ids for which the transcript later shows the client misbehaving (a server-side test). */
        private val clientMisbehaves: Set<Long> by lazy {
            steps.filter { it["dir"] == "c2s" && it["expectViolation"] != null }.mapNotNull { idOfStep(it) }.toSet()
        }

        private fun fail(what: String): Nothing = throw AssertionError(what)

        private fun norm(v: Any?): Any? = StrictDeviceJson.parseTrusted(CorpusText.serialize(v))

        private fun step(i: Int) = steps[i]

        private fun idOfStep(s: Map<String, Any?>): Long? {
            @Suppress("UNCHECKED_CAST")
            (s["message"] as? Map<String, Any?>)?.let { return DeviceWire.exactLong(it["id"]) }
            @Suppress("UNCHECKED_CAST")
            (s["frame"] as? Map<String, Any?>)?.let { return ((it["header"] as Map<String, Any?>)["requestId"] as Long) }
            (s["raw"] as? String)?.let { raw -> Regex("\"id\":(\\d+)").find(raw)?.let { return it.groupValues[1].toLong() } }
            return null
        }

        @Suppress("UNCHECKED_CAST")
        private fun msg(s: Map<String, Any?>): Map<String, Any?>? = s["message"] as? Map<String, Any?>

        private fun frameBytes(s: Map<String, Any?>): ByteArray {
            @Suppress("UNCHECKED_CAST")
            val f = s["frame"] as Map<String, Any?>
            val head = CorpusText.hexToBytes(f["hex"] as String)
            @Suppress("UNCHECKED_CAST")
            val fill = f["payloadFill"] as Map<String, Any?>? ?: return head
            val n = (fill["length"] as Long).toInt()
            return head + ByteArray(n) { (fill["byte"] as Long).toByte() }
        }

        private fun outId(o: Sent): Long? = when (o) {
            is Sent.Msg -> DeviceWire.exactLong(o.message["id"])
            is Sent.Frame -> (DeviceFrames.decode(o.bytes) as? FrameDecode.Ok)?.header?.requestId
        }

        private fun pending(): List<Int> = transport.sent.indices.filter { it !in consumed && outId(transport.sent[it]) !in abandoned }

        private fun isLeaseAck(o: Sent) = o is Sent.Msg && (o.message["control"] as? Map<*, *>)?.containsKey("leaseAck") == true

        private fun isSnapshot(o: Sent) = o is Sent.Msg && (o.message["event"] as? Map<*, *>)?.containsKey("capabilities") == true

        /** Record lease acks and silently accept snapshots of core streams the transcript does not show. */
        private fun settle() {
            scope.runCurrent()
            for (i in transport.sent.indices) {
                if (i in consumed) continue
                val o = transport.sent[i]
                val id = outId(o) ?: continue
                if (isLeaseAck(o)) ackedSeqs.getOrPut(id) { HashSet() } += ((o as Sent.Msg).message["control"] as Map<*, *>)["leaseAck"] as Long
                if (isSnapshot(o) && id in coreIds && id !in coreIdsWithSnapshots) consumed += i
                if (id in abandoned) consumed += i
            }
            checkCredit()
        }

        /** Cumulative upload bytes never exceed the credit granted so far (RFC 001 §2.3). */
        private fun checkCredit() {
            val sent = HashMap<Long, Long>()
            for (o in transport.sent) {
                if (o !is Sent.Frame) continue
                val ok = DeviceFrames.decode(o.bytes) as FrameDecode.Ok
                sent[ok.header.requestId] = (sent[ok.header.requestId] ?: 0L) + ok.payload.size
            }
            for ((id, bytes) in sent) {
                val allowed = credit[id] ?: fail("frame for unknown request $id")
                if (bytes > allowed) fail("request $id sent $bytes bytes with only $allowed credit")
            }
        }

        private fun deliver(s: Map<String, Any?>) {
            val m = msg(s)
            when {
                m != null -> route(CorpusText.serialize(m))
                s["raw"] != null -> route(s["raw"] as String)
                s["frame"] != null -> connection.handleFrame(frameBytes(s))
                else -> fail("step without payload")
            }
        }

        private fun route(text: String) {
            when (val parsed = parser.parseMessage(text)) {
                is DeviceWireMessage -> connection.handleMessage(parsed.body, parsed.sizeBytes)
                is DeviceMalformedMessage -> connection.handleMalformed(parsed.type, parsed.detail, parsed.sizeBytes)
                null -> Unit
                else -> fail("not a device message: $text")
            }
        }

        fun run() {
            setUp()
            var i = 0
            while (i < steps.size) {
                currentIndex = i
                val s = step(i)
                val next = if (i + 1 < steps.size) step(i + 1) else null
                i += if (s["dir"] == "s2c") serverStep(s, next) else clientStep(s, next)
                if (connection.isClosed) {
                    if (i < steps.size) fail("connection closed before step $i")
                    return
                }
            }
            for (o in transport.sent) {
                if (!isLeaseAck(o)) continue
                val ack = (o as Sent.Msg).message
                val pair = DeviceWire.exactLong(ack["id"])!! to ((ack["control"] as Map<*, *>)["leaseAck"] as Long)
                if (pair !in renewals) fail("leaseAck without a renewal: $ack")
            }
            // Lease acks answering delivered renewals are always legitimate, shown or not.
            val left = pending().filterNot { isLeaseAck(transport.sent[it]) }
            if (left.isNotEmpty()) fail("unmatched client output: ${left.map { describe(transport.sent[it]) }}")
        }

        private fun describe(o: Sent): String = when (o) {
            is Sent.Msg -> o.message.toString()
            is Sent.Frame -> "frame(${(DeviceFrames.decode(o.bytes) as? FrameDecode.Ok)?.header})"
        }

        private fun setUp() {
            // Registration order follows the transcript's snapshots, so offers() orders names like them.
            val order = LinkedHashSet<String>()
            for (s in steps) {
                if (s["expectViolation"] != null || s["ignored"] == true) continue
                val ev = msg(s)?.get("event") as? Map<*, *> ?: continue
                (ev["capabilities"] as? List<*>)?.forEach { order += (it as Map<*, *>)["name"] as String }
            }
            DeviceRegistry.all.keys.forEach { order += it.first }
            order -= DeviceHost.CORE_CAPABILITIES
            available += order
            val drivers = order.map { ScriptedDriver(it, available, this) }
            host = scope.newHost(drivers, config = DeviceHostConfig(origin = "wss://app.example:443", localMaxTimeoutMs = 86_400_000))
            connection = host.openWithHello(transport)
            val ack = doc["ack"] ?: mapOf(
                "protocolVersion" to 1L,
                "binary" to true,
                "capabilities" to DeviceRegistry.all.keys.map { mapOf("name" to it.first, "version" to it.second) },
            )
            connection.onAck(ack)
            scope.runCurrent()
            if (!connection.isEnabled) fail("the ack was not accepted")
            for (s in steps) {
                val m = msg(s) ?: continue
                if (s["dir"] == "c2s" && m["type"] == "deviceEvent" && (m["event"] as? Map<*, *>)?.containsKey("capabilities") == true) {
                    coreIdsWithSnapshots += m["id"] as Long
                }
            }
        }

        /** The first snapshot a core stream shows: what the host offers when that stream opens. */
        private fun firstSnapshotFor(id: Long): List<String>? {
            for (s in steps) {
                val m = msg(s) ?: continue
                if (s["dir"] != "c2s" || m["id"] != id) continue
                val caps = (m["event"] as? Map<*, *>)?.get("capabilities") as? List<*> ?: continue
                return caps.map { (it as Map<*, *>)["name"] as String }
            }
            return null
        }

        private fun setAvailable(names: List<String>) {
            available.clear()
            available += names.filter { it != DeviceHost.CORE_CAPABILITIES }
        }

        // ---- server → client ------------------------------------------------------------------

        private fun serverStep(s: Map<String, Any?>, next: Map<String, Any?>?): Int {
            val m = msg(s)
            val id = idOfStep(s)
            if (m?.get("type") == "deviceRequest" && s["ignored"] != true) {
                requests[id!!] = m
                credit[id] = m["initialCredit"] as Long
                if (m["capability"] == DeviceHost.CORE_CAPABILITIES) {
                    coreIds += id
                    firstSnapshotFor(id)?.let(::setAvailable)
                }
            }
            ((m?.get("control") as? Map<*, *>)?.get("renewLease") as? Long)?.let { if (id != null) renewals += id to it }
            val grant = ((m?.get("control") as? Map<*, *>)?.get("grant") as? Long)
            if (grant != null && id != null && s["expectViolation"] == null && s["ignored"] != true) credit[id] = (credit[id] ?: 0L) + grant
            val before = transport.sent.size
            val wasLive = id != null && requests.containsKey(id) && isLive(id)
            deliver(s)
            settle()
            val fresh = (before until transport.sent.size).filter { it !in consumed && outId(transport.sent[it]) !in abandoned }
            val violation = s["expectViolation"] as String?
            when {
                s["ignored"] == true -> {
                    if (fresh.isNotEmpty()) fail("ignored step produced ${fresh.map { describe(transport.sent[it]) }}")
                    return 1
                }
                violation == "connection" -> {
                    if (!connection.isClosed || transport.closedWith == null) fail("connection violation not detected")
                    stats.clientDetected += 1
                    return 1
                }
                violation != null && next?.get("reaction") != true -> {
                    // Connection-level (D3): discarded and counted, nothing sent, nothing ended.
                    if (fresh.isNotEmpty()) fail("connection-level violation produced ${fresh.map { describe(transport.sent[it]) }}")
                    if (connection.isClosed) fail("closed on a single connection-level violation")
                    stats.clientDetected += 1
                    return 1
                }
                violation != null -> {
                    val reaction = msg(next!!)!!
                    val code = (reaction["error"] as Map<*, *>)["code"]
                    val rid = reaction["id"] as Long
                    val hit = fresh.firstOrNull { idx ->
                        val o = transport.sent[idx]
                        o is Sent.Msg && o.message["type"] == "deviceResponse" && DeviceWire.exactLong(o.message["id"]) == rid &&
                            (o.message["error"] as? Map<*, *>)?.get("code") == code
                    } ?: fail("expected reaction $reaction after $violation, got ${fresh.map { describe(transport.sent[it]) }}")
                    consumed += hit
                    abandoned += rid // retired on both sides; late output is not compared
                    stats.clientDetected += 1
                    stats.reactions += 1
                    return 2
                }
                (m?.get("control") as? Map<*, *>)?.get("cancel") == true -> {
                    // The client answers a server cancel on a live id with its own `cancelled`.
                    if (wasLive && id !in abandoned) {
                        val hit = fresh.firstOrNull { idx ->
                            val o = transport.sent[idx]
                            o is Sent.Msg && o.message["type"] == "deviceResponse" && DeviceWire.exactLong(o.message["id"]) == id
                        } ?: fail("no cancelled terminal for $id")
                        val o = (transport.sent[hit] as Sent.Msg).message
                        if ((o["error"] as? Map<*, *>)?.get("code") != "cancelled") fail("cancel answered with $o")
                        consumed += hit
                    }
                    abandoned += id!!
                    return 1
                }
                else -> {
                    if (connection.isClosed) fail("closed on a valid step")
                    val terminal = fresh.firstOrNull { idx ->
                        val o = transport.sent[idx]
                        o is Sent.Msg && o.message["type"] == "deviceResponse" &&
                            (o.message["error"] as? Map<*, *>)?.get("code").let { it == "invalidParams" || it == "unsupported" }
                    }
                    if (terminal != null) {
                        val tid = outId(transport.sent[terminal])!!
                        // The transcript then shows the *client* lying about this id (e.g. a
                        // success despite a hash mismatch); the Android client refuses instead.
                        if (tid !in clientMisbehaves) fail("valid step refused: ${describe(transport.sent[terminal])}")
                        consumed += terminal
                        abandoned += tid
                        stats.clientDetected += 1
                    }
                    return 1
                }
            }
        }

        private fun isLive(id: Long): Boolean = transport.sent.none { o ->
            o is Sent.Msg && o.message["type"] == "deviceResponse" && DeviceWire.exactLong(o.message["id"]) == id
        }

        // ---- client → server ------------------------------------------------------------------

        private fun clientStep(s: Map<String, Any?>, next: Map<String, Any?>?): Int {
            val id = idOfStep(s)
            if (s["ignored"] == true) {
                stats.serverSideSteps += 1
                return 1
            }
            val violation = s["expectViolation"] as String?
            if (violation != null) {
                // A misbehaving client: the Android client never sends this. It is
                // attributable unless it is connection-level text/frame garbage.
                stats.serverSideSteps += 1
                val connectionLevel = violation == "malformed" && next?.get("reaction") != true && (s["raw"] != null || s["frame"] != null)
                if (!connectionLevel && id != null) abandoned += id
                return 1
            }
            if (s["reaction"] == true) fail("unexpected client reaction step")
            if (id == null) fail("client step without id")
            if (id in abandoned) {
                stats.serverSideSteps += 1
                return 1
            }
            val m = msg(s)
            val req = requests[id] ?: fail("client step for unknown request $id")
            val rev = DeviceRegistry.revision(req["capability"] as String, req["version"] as Long)!!
            val control = m?.get("control") as? Map<*, *>
            when {
                control?.containsKey("leaseAck") == true -> {
                    val seq = control["leaseAck"] as Long
                    // Only messages can be lease acks (a pending upload frame is not one).
                    val idx = pending().firstOrNull { i -> (transport.sent[i] as? Sent.Msg)?.let { norm(it.message) == norm(m) } == true }
                    if (idx != null) {
                        consumed += idx
                    } else if (seq !in ackedSeqs[id].orEmpty()) {
                        fail("leaseAck $seq for $id never sent")
                    } // else: a repeated/older ack of a sent sequence — legal, not reproduced
                }
                rev.data == DataPlane.BINARY_UPLOAD && isUploadStep(s) -> uploadStep(id, s)
                control?.containsKey("grant") == true -> {
                    script(id).trySend(Action.Grant(control["grant"] as Long))
                    expectNext(id, m!!)
                }
                m?.get("type") == "deviceEvent" -> {
                    val ev = m["event"] as Map<*, *>
                    if (ev.containsKey("capabilities") && id in coreIds) {
                        if (!hasPending(id)) {
                            @Suppress("UNCHECKED_CAST")
                            setAvailable((ev["capabilities"] as List<Map<String, Any?>>).map { it["name"] as String })
                            hostChanged()
                        }
                    } else if (!hasPending(id)) {
                        @Suppress("UNCHECKED_CAST")
                        script(id).trySend(Action.Emit(ev as Map<String, Any?>))
                    }
                    expectNext(id, m)
                }
                m?.get("type") == "deviceResponse" && id in liveBuffers -> {
                    // A live capture ending with an error (e.g. throttled when credit starves).
                    val err = outcomeOf(m) as DriverOutcome.Error
                    contexts.getValue(id).abort(err.code, err.platformDetail)
                    settle()
                    verifyUpload(id, m)
                }
                m?.get("type") == "deviceResponse" -> {
                    if (!hasPending(id)) script(id).trySend(Action.Finish(outcomeOf(m)))
                    expectNext(id, m)
                }
                else -> fail("unexpected client step $s")
            }
            stats.produced += 1
            return 1
        }

        private fun hostChanged() {
            host.capabilitiesChanged()
            settle()
        }

        private fun script(id: Long): Channel<Action> {
            settle()
            return scripts[id] ?: fail("no running driver for $id")
        }

        private fun hasPending(id: Long): Boolean = pending().any { outId(transport.sent[it]) == id && !isLeaseAck(transport.sent[it]) }

        private fun expectNext(id: Long, expected: Map<String, Any?>) {
            settle()
            val idx = pending().firstOrNull { outId(transport.sent[it]) == id && !isLeaseAck(transport.sent[it]) }
                ?: fail("client sent nothing for $id; expected $expected")
            val got = (transport.sent[idx] as? Sent.Msg)?.message ?: fail("expected $expected, got ${describe(transport.sent[idx])}")
            if (norm(got) != norm(expected)) fail("expected $expected\n   got $got")
            consumed += idx
        }

        private fun outcomeOf(m: Map<String, Any?>): DriverOutcome {
            val simulated = m["simulated"] == true
            @Suppress("UNCHECKED_CAST")
            (m["result"] as? Map<String, Any?>)?.let { return DriverOutcome.Result(it, simulated = simulated) }
            val err = m["error"] as Map<*, *>
            val code = DeviceErrorCode.entries.first { it.wireName == err["code"] }
            return DriverOutcome.Error(code, err["platformDetail"] as String?, simulated)
        }

        // ---- uploads ----------------------------------------------------------------------------

        private fun isUploadStep(s: Map<String, Any?>): Boolean {
            if (s["frame"] != null) return true
            val m = msg(s) ?: return false
            if (m["type"] == "deviceResponse") return m["result"] != null
            val ev = m["event"] as? Map<*, *>
            if (ev?.get("kind") == "blobStart") return true
            return (m["control"] as? Map<*, *>)?.containsKey("paused") == true
        }

        /** Every normal client step of [id]'s upload, in transcript order. */
        private fun uploadSteps(id: Long): List<Map<String, Any?>> =
            steps.filter { it["dir"] == "c2s" && it["ignored"] != true && it["expectViolation"] == null && idOfStep(it) == id && isUploadStep(it) }

        /** A stream revision with a client → server binary plane (mic.record): bytes are captured live. */
        private fun isLiveCapture(id: Long): Boolean {
            val req = requests[id] ?: return false
            val rev = DeviceRegistry.revision(req["capability"] as String, req["version"] as Long) ?: return false
            if (rev.mode != Mode.STREAM || rev.data != DataPlane.BINARY_UPLOAD) return false
            // A declared size means an already-complete recording: streamed from a finished source.
            return uploadSteps(id).any { s -> (msg(s)?.get("event") as? Map<*, *>)?.let { it["kind"] == "blobStart" && "bytes" !in it } == true }
        }

        private fun uploadStep(id: Long, s: Map<String, Any?>) {
            if (id !in uploadTriggered) {
                uploadTriggered += id
                val outcome = if (isLiveCapture(id)) liveOutcome(id) else uploadOutcome(id)
                script(id).trySend(Action.Finish(outcome))
                settle()
            }
            val m = msg(s)
            liveBuffers[id]?.let { live ->
                when {
                    s["frame"] != null -> feed(live, currentIndex)
                    (m?.get("control") as? Map<*, *>)?.get("paused") == true -> {
                        // The sender pauses when it holds captured bytes without credit:
                        // capture the next frame now (or a filler that is never sent).
                        val next = steps.indices.firstOrNull { it > currentIndex && it !in fedSteps && steps[it]["frame"] != null && idOfStep(steps[it]) == id }
                        if (next != null) feed(live, next) else live.write(ByteArray(2))
                    }
                    m?.get("type") == "deviceResponse" -> live.finish()
                }
                settle()
            }
            if (m?.get("type") == "deviceResponse") verifyUpload(id, m)
        }

        private fun feed(live: LiveCaptureBuffer, index: Int) {
            if (!fedSteps.add(index)) return
            val ok = DeviceFrames.decode(frameBytes(steps[index])) as FrameDecode.Ok
            live.write(ok.payload)
        }

        /** The live-capture item: an undeclared blob fed frame by frame, result fields from the terminal. */
        private fun liveOutcome(id: Long): DriverOutcome.Result {
            val all = uploadSteps(id)
            val terminal = all.lastOrNull { msg(it)?.get("type") == "deviceResponse" }?.let { msg(it) }
            @Suppress("UNCHECKED_CAST")
            val result = (terminal?.get("result") as? Map<String, Any?>) ?: emptyMap()
            val bs = all.mapNotNull { s -> (msg(s)?.get("event") as? Map<*, *>)?.takeIf { it["kind"] == "blobStart" } }.single()
            val live = LiveCaptureBuffer(limit = 64 * 1024 * 1024)
            liveBuffers[id] = live
            return DriverOutcome.Result(
                blobs = listOf(DriverBlob.live((bs["channel"] as Long).toInt(), bs["contentType"] as String, live)),
                itemField = "item",
                simulated = terminal?.get("simulated") == true,
                resultAfterUpload = { result - "item" },
            )
        }

        private fun uploadOutcome(id: Long): DriverOutcome.Result {
            val all = uploadSteps(id)
            val payloads = LinkedHashMap<Long, ByteArray>()
            for (s in all) {
                if (s["frame"] == null) continue
                @Suppress("UNCHECKED_CAST")
                val ch = ((s["frame"] as Map<String, Any?>)["header"] as Map<String, Any?>)["channel"] as Long
                val ok = DeviceFrames.decode(frameBytes(s)) as FrameDecode.Ok
                payloads[ch] = (payloads[ch] ?: ByteArray(0)) + ok.payload
            }
            val terminal = all.lastOrNull { msg(it)?.get("type") == "deviceResponse" }?.let { msg(it) }
            @Suppress("UNCHECKED_CAST")
            val result = (terminal?.get("result") as? Map<String, Any?>) ?: emptyMap()
            val itemField = if ("item" in result) "item" else "items"
            @Suppress("UNCHECKED_CAST")
            val items: List<Map<String, Any?>> = when (val v = result[itemField]) {
                is Map<*, *> -> listOf(v as Map<String, Any?>)
                is List<*> -> v as List<Map<String, Any?>>
                else -> emptyList()
            }
            val blobs = all.mapNotNull { s -> (msg(s)?.get("event") as? Map<*, *>)?.takeIf { it["kind"] == "blobStart" } }.map { bs ->
                val ch = bs["channel"] as Long
                val bytes = payloads[ch] ?: ByteArray(0)
                val extra = items.firstOrNull { it["channel"] == ch }.orEmpty() - setOf("channel", "contentType", "bytes", "sha256")
                DriverBlob(ch.toInt(), bs["contentType"] as String, bs["bytes"] as Long?, { ByteArrayInputStream(bytes) }, extra = extra)
            }
            return DriverOutcome.Result(result - itemField, blobs, itemField, simulated = terminal?.get("simulated") == true)
        }

        private fun verifyUpload(id: Long, terminal: Map<String, Any?>) {
            val expected = uploadSteps(id)
            val outs = pending().filter { outId(transport.sent[it]) == id && !isLeaseAck(transport.sent[it]) }
            val announced = HashMap<Long, Map<*, *>>()
            val bytes = HashMap<Long, ByteArray>()
            val nextSeq = HashMap<Long, Long>()
            var paused = false
            var result: Map<String, Any?>? = null
            for (idx in outs) {
                when (val o = transport.sent[idx]) {
                    is Sent.Frame -> {
                        val ok = DeviceFrames.decode(o.bytes) as FrameDecode.Ok
                        val ch = ok.header.channel.toLong()
                        if (paused) fail("frame sent while paused")
                        if (ch !in announced) fail("frame before blobStart on channel $ch")
                        if (ok.payload.isEmpty()) fail("zero-length frame")
                        if (ok.header.seq != (nextSeq[ch] ?: 0L)) fail("seq ${ok.header.seq} on channel $ch")
                        nextSeq[ch] = ok.header.seq + 1
                        bytes[ch] = (bytes[ch] ?: ByteArray(0)) + ok.payload
                    }
                    is Sent.Msg -> {
                        val msg = o.message
                        val ev = msg["event"] as? Map<*, *>
                        val control = msg["control"] as? Map<*, *>
                        when {
                            ev?.get("kind") == "blobStart" -> announced[(ev["channel"] as Number).toLong()] = norm(ev) as Map<*, *>
                            control?.containsKey("paused") == true -> {
                                val p = control["paused"] as Boolean
                                if (p == paused) fail("paused repeats $p")
                                paused = p
                            }
                            msg["type"] == "deviceResponse" -> {
                                @Suppress("UNCHECKED_CAST")
                                result = norm(msg) as Map<String, Any?>
                            }
                            else -> fail("unexpected upload output $msg")
                        }
                    }
                }
                consumed += idx
            }
            // Only an error terminal may end a paused upload (e.g. throttled while starved).
            if (paused && terminal["error"] == null) fail("ended paused")
            val wantStarts = expected.mapNotNull { (msg(it)?.get("event") as? Map<*, *>)?.takeIf { e -> e["kind"] == "blobStart" } }
                .associate { (it["channel"] as Long) to norm(it) }
            if (announced != wantStarts) fail("blobStarts $announced != $wantStarts")
            val want = uploadOutcome(id).blobs.associate { it.channel.toLong() to it.open().readBytes() }
            for ((ch, b) in want) if (!(bytes[ch] ?: ByteArray(0)).contentEquals(b)) fail("channel $ch bytes differ")
            if (bytes.keys.any { it !in want }) fail("bytes on unexpected channels ${bytes.keys}")
            val got = result ?: fail("no terminal for $id")
            if (sortItems(got) != sortItems(norm(terminal))) fail("terminal $got != $terminal")
            stats.uploadsVerified += 1
        }

        @Suppress("UNCHECKED_CAST")
        private fun sortItems(m: Any?): Any? {
            val map = (m as? Map<String, Any?>)?.toMutableMap() ?: return m
            val result = (map["result"] as? Map<String, Any?>)?.toMutableMap() ?: return map
            (result["items"] as? List<Map<String, Any?>>)?.let { items -> result["items"] = items.sortedBy { it["channel"] as Long } }
            map["result"] = result
            return map
        }
    }
}
