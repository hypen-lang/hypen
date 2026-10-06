/**
 * Device Capability Protocol — the host driver of one connection's broker
 * (RFC 001 §2.1–§2.7).
 *
 * The broker is the Rust `DeviceBroker` (engine crate, reached through the
 * generated UniFFI bindings in `uniffi.hypen_engine`), shared by every
 * server SDK. It is sans-IO: no sockets, no timers, no clock of its own.
 * [DevicePlane] is the I/O half on the JVM:
 *
 * - socket text / binary frames → `broker.onText` / `broker.onFrame`;
 * - `broker.poll()` outputs → the [DevicePlaneSink] (`sendText`,
 *   `sendFrame`, `closeConnection`), the handler API (JSON stream events,
 *   streamed upload bytes, settlements);
 * - ONE coroutine timer, re-armed from the broker's next deadline and run
 *   through `broker.tick(now)` — leases, deadlines, drain watches and the
 *   planned `core.capabilities` reopen all live in the broker; a bulk turn
 *   due "now" runs as its own coroutine after already-queued work;
 * - the transport's buffered bytes are reported before every poll;
 * - consumer pacing: event / upload credit goes back to the broker
 *   (`consumedEvents` / `consumedData`) only after the (suspending) consumer
 *   returned, so a slow consumer backpressures the device.
 *
 * Time is injected ([DeviceClock]); with a virtual clock (e.g. a
 * `kotlinx-coroutines-test` scheduler) every lease and deadline is
 * deterministic.
 *
 * Thread safety: every broker call and the output pump run under one
 * reentrant lock, so the plane may be used from any coroutine; outputs are
 * always handled in broker order and the pump is non-reentrant (a consumer
 * or sink calling back into the plane only marks another round).
 */
package space.hypen.remote.device

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import uniffi.hypen_engine.DeviceBroker
import uniffi.hypen_engine.DeviceOpenResult
import uniffi.hypen_engine.DeviceOutcome
import uniffi.hypen_engine.DeviceOutput
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Largest integer every SDK carries losslessly through JSON (2^53 - 1): host-supplied numbers are clamped to it. */
private const val JSON_SAFE_MAX: Long = 9_007_199_254_740_991

/** Monotonic milliseconds for the broker (non-negative). */
fun interface DeviceClock {
    fun nowMs(): Long

    companion object {
        /** The process's monotonic clock (`System.nanoTime`), origin at first use. */
        val SYSTEM: DeviceClock = object : DeviceClock {
            private val origin = System.nanoTime()

            override fun nowMs(): Long = (System.nanoTime() - origin) / 1_000_000
        }
    }
}

/** Where a device plane's traffic goes. Every call must be non-blocking (enqueue). */
interface DevicePlaneSink {
    /** One server → client device JSON message (request, cancel, lease, grant). */
    fun sendText(text: String)

    /** One binary download frame. Only called on a connection that carries binary. */
    fun sendFrame(frame: ByteArray)

    /** Bytes accepted by the transport but not yet written. */
    fun bufferedAmount(): Long = 0

    /**
     * The broker closed the device plane (repeated violations, the mandatory
     * `core.capabilities` stream ended, id space exhausted): reset the socket
     * with this code so the client reconnects with a full advertisement.
     */
    fun closeConnection(code: Int, reason: String)
}

/** One verified upload item of a buffered (unary) upload. */
class VerifiedBlob(
    val channel: Int,
    /** The result item's `name`, when the revision carries one (`file.pick`). */
    val name: String?,
    val contentType: String,
    /** The received bytes; the broker checked their count and SHA-256 against the result. */
    val bytes: ByteArray,
) {
    /** Lowercase hex SHA-256 of [bytes]. */
    val sha256: String by lazy { uniffi.hypen_engine.deviceSha256Hex(bytes) }

    override fun toString(): String = "VerifiedBlob(channel=$channel, name=$name, contentType=$contentType, bytes=${bytes.size})"
}

/** A request's terminal outcome as the plane reports it. */
sealed class DeviceSettlement {
    class Success(
        /** The client's result, validated by the broker against the selected revision. */
        val result: JsonObject,
        val blobs: List<VerifiedBlob>,
        /** Produced by a development fake (RFC 001 §1.11). */
        val simulated: Boolean,
        /** Present when the result's retained-bytes charge is held until called. */
        val release: (() -> Unit)?,
    ) : DeviceSettlement()

    data class Failure(val code: DeviceErrorCode, val detail: String? = null) : DeviceSettlement()
}

/** What [DevicePlane.open] takes: the broker's open spec plus local consumers. */
class DevicePlaneOpen(
    val capability: String,
    val params: JsonObject = JsonObject(emptyMap()),
    val moduleInstanceId: String,
    val activationId: UInt,
    /** Exact revision; `null` = the live selection's revision. */
    val version: UInt? = null,
    /** `null` = the revision's default lifetime. */
    val lifetime: Lifetime? = null,
    /** `null` = the broker default; always clamped to the revision. */
    val timeoutMs: Long? = null,
    /** `null` = the data plane's default; clamped to the revision. */
    val initialCredit: Long? = null,
    /** The operation shape the caller expects (`"unary"` / `"stream"`); `null` accepts either. */
    val mode: String? = null,
    /** Hold a successful result's retained-bytes charge until its release is called. */
    val holdResult: Boolean = false,
    /** The replay firewall: refused `unavailable` before anything else. */
    val replayed: Boolean = false,
    /** `file.save` bytes (the params must announce exactly these). */
    val download: ByteArray? = null,
    /** Consumer of a JSON stream's validated capability events. */
    val onEvent: (suspend (JsonObject) -> Unit)? = null,
    /** Consumer of a binary-upload stream's bytes, one call at a time, in order. */
    val onData: (suspend (ByteArray, Int) -> Unit)? = null,
) {
    internal fun specJson(): String = buildJsonObject {
        put("capability", JsonPrimitive(capability))
        version?.let { put("version", JsonPrimitive(it.toLong())) }
        put("params", params)
        put("moduleInstanceId", JsonPrimitive(moduleInstanceId))
        put("activationId", JsonPrimitive(activationId.toLong()))
        lifetime?.let { put("lifetime", JsonPrimitive(it.wireName)) }
        timeoutMs?.let { put("timeoutMs", JsonPrimitive(it.coerceIn(1, JSON_SAFE_MAX))) }
        initialCredit?.let { put("initialCredit", JsonPrimitive(it.coerceIn(0, JSON_SAFE_MAX))) }
        mode?.let { put("mode", JsonPrimitive(it)) }
        if (holdResult) put("holdResult", JsonPrimitive(true))
        if (replayed) put("replayed", JsonPrimitive(true))
    }.toString()
}

/** A request opened through the plane. Terminal exactly once; [settled] never fails. */
class DeviceRequestHandle internal constructor(
    /** Wire request id, or `null` when the broker refused locally (nothing was sent). */
    val id: UInt?,
    val settled: Deferred<DeviceSettlement>,
    private val onCancel: () -> Unit,
) {
    /** Server-initiated cancellation (idempotent): `cancel` is sent, the request settles `cancelled`. */
    fun cancel() = onCancel()
}

/** The effective revision a broker enforces for one `capability@version`. */
data class DeviceRevisionInfo(
    val mode: String,
    val data: String,
    val lifetimes: List<String>,
    val maxItemBytes: Long,
    val maxTimeoutMs: Long,
)

class DevicePlane(
    /** The connection's broker. Owned by this plane (released when it closes). */
    private val broker: DeviceBroker,
    private val sink: DevicePlaneSink,
    /** Runs the timer, deferred bulk turns and stream consumers. */
    private val scope: CoroutineScope,
    private val clock: DeviceClock = DeviceClock.SYSTEM,
    /** Whether this connection negotiated and carries the binary profile. */
    binary: Boolean = true,
    /** Diagnostics for a failed send / broker call (the connection is torn down elsewhere). */
    private val onError: (String, Throwable) -> Unit = { _, _ -> },
) {
    private val lock = ReentrantLock()
    private val pending = HashMap<UInt, Pending>()
    private val binaryRoute = binary
    private var timer: Job? = null
    private var timerAt: ULong? = null
    private var turnQueued = false
    private var pumping = false
    private var again = false
    private var closing = false
    private var freed = false

    private class Pending(
        val id: UInt,
        val settled: CompletableDeferred<DeviceSettlement>,
        val inbox: Channel<Delivery>?,
    ) {
        var consumer: Job? = null
        var done = false

        /** Success settlement waiting for the consumer to drain [inbox]. */
        var deferredSuccess: DeviceSettlement.Success? = null
    }

    private sealed class Delivery {
        class Event(val event: JsonObject) : Delivery()
        class Data(val bytes: ByteArray, val channel: Int) : Delivery()
    }

    private fun now(): ULong = clock.nowMs().coerceAtLeast(0).toULong()

    // ---- lifecycle ---------------------------------------------------------

    /**
     * Open the connection-owned `core.capabilities` stream (RFC 001 §2.2),
     * right after the handshake — before any module callback can request
     * device work. False when it could not be opened (the caller closes the
     * plane then).
     */
    fun start(): Boolean = lock.withLock {
        if (isClosed) return false
        val r = broker.start(now())
        pump()
        r is DeviceOpenResult.Opened
    }

    /**
     * Close the device plane locally (connection teardown / reset): every
     * live request settles with [code] (nothing is sent), the timer stops and
     * the broker's memory is released. Idempotent.
     */
    fun close(code: DeviceErrorCode = DeviceErrorCode.CONNECTION_LOST) = lock.withLock {
        if (freed || closing) return
        closing = true
        clearTimer()
        try {
            if (!broker.isClosed()) broker.close(code.wireName)
        } catch (e: Exception) {
            onError("device broker close", e)
        }
        pump()
    }

    /** True once the plane closed (locally or by the broker). */
    val isClosed: Boolean
        get() = lock.withLock { freed || closing || broker.isClosed() }

    /** Whether downloads (`file.save`) can be carried on this connection. */
    val canSendBinary: Boolean get() = binaryRoute

    // ---- module ownership (RFC 001 §2.7) -------------------------------------

    /** A module instance became active as [activationId] (strictly increasing). */
    fun ownerActivated(moduleInstanceId: String, activationId: UInt): Boolean = lock.withLock {
        if (isClosed) return false
        val ok = broker.ownerActivated(moduleInstanceId, activationId, now())
        pump()
        ok
    }

    /** The activation ended: its activation-owned work is cancelled. */
    fun ownerDeactivated(moduleInstanceId: String, activationId: UInt) = lock.withLock {
        if (isClosed) return
        broker.ownerDeactivated(moduleInstanceId, activationId, now())
        pump()
    }

    /** The module instance was destroyed: all of its work is cancelled. */
    fun ownerDestroyed(moduleInstanceId: String) = lock.withLock {
        if (isClosed) return
        broker.ownerDestroyed(moduleInstanceId, now())
        pump()
    }

    // ---- requests ------------------------------------------------------------

    /**
     * Open a request through the broker. A local refusal (the broker admits
     * nothing it cannot honor) settles at once with `id == null`; nothing is
     * sent then. Never throws.
     */
    fun open(spec: DevicePlaneOpen): DeviceRequestHandle = lock.withLock {
        if (isClosed) return refused(DeviceErrorCode.CONNECTION_LOST, null)
        val r = try {
            broker.open(spec.specJson(), spec.download, now())
        } catch (e: Exception) {
            // A malformed spec is a host bug; the handler API still never throws.
            onError("device open", e)
            return refused(DeviceErrorCode.INTERNAL, (e.message ?: e.toString()).take(512))
        }
        when (r) {
            is DeviceOpenResult.Refused -> {
                pump()
                refused(DeviceErrorCode.fromWireName(r.code) ?: DeviceErrorCode.INTERNAL, r.detail)
            }
            is DeviceOpenResult.Opened -> {
                val id = r.id
                val hasConsumer = spec.onEvent != null || spec.onData != null
                val p = Pending(id, CompletableDeferred(), if (hasConsumer) Channel(Channel.UNLIMITED) else null)
                pending[id] = p
                if (p.inbox != null) p.consumer = scope.launch { consume(p, spec.onEvent, spec.onData) }
                pump()
                DeviceRequestHandle(id, p.settled) { cancel(id) }
            }
        }
    }

    /** Server-initiated cancel: `cancel` is sent and the request settles `cancelled`. */
    fun cancel(id: UInt) = lock.withLock {
        if (isClosed) return
        broker.cancel(id, now())
        pump()
    }

    /**
     * Planned reopen of `core.capabilities` now (the broker also does this on
     * its own shortly before the stream's deadline). The new id, or `null`.
     */
    fun reopenCoreCapabilities(): UInt? = lock.withLock {
        if (isClosed) return null
        val id = broker.reopenCoreCapabilities(now())
        pump()
        id
    }

    /** Release a held result's retained-bytes charge (idempotent). */
    fun releaseResult(id: UInt) = lock.withLock {
        if (freed) return
        broker.releaseResult(id)
    }

    // ---- incoming traffic ------------------------------------------------------

    /** One client → server device text message (the raw text). */
    fun receiveText(text: String): Boolean = lock.withLock {
        if (isClosed) return false
        val live = broker.onText(text, now())
        pump()
        live
    }

    /** One client → server binary frame. */
    fun receiveFrame(frame: ByteArray): Boolean = lock.withLock {
        if (isClosed) return false
        val ok = broker.onFrame(frame, now())
        pump()
        ok
    }

    /** A connection-level violation the host detected before feeding anything. */
    fun reportViolation(reason: String) = lock.withLock {
        if (isClosed) return
        broker.reportViolation(reason, now())
        pump()
    }

    /** Run due timers now (normally the plane's own timer does this). */
    fun tick() = fire()

    // ---- queries -----------------------------------------------------------

    /** Negotiated live support (the live selection after every snapshot). */
    fun supports(capability: String): Boolean = lock.withLock { !isClosed && broker.supports(capability) }

    fun selectedVersion(capability: String): UInt? = lock.withLock { if (freed) null else broker.selectedVersion(capability) }

    /** The revision the broker enforces for `capability@version`, or `null`. */
    fun revision(capability: String, version: UInt): DeviceRevisionInfo? = lock.withLock {
        if (freed) return null
        val text = broker.revisionJson(capability, version) ?: return null
        val o = kotlinx.serialization.json.Json.parseToJsonElement(text).jsonObject
        DeviceRevisionInfo(
            mode = o.string("mode"),
            data = o.string("data"),
            lifetimes = (o["lifetimes"] as? JsonArray)?.map { (it as JsonPrimitive).content }.orEmpty(),
            maxItemBytes = (o["maxItemBytes"] as JsonPrimitive).content.toLong(),
            maxTimeoutMs = (o["maxTimeoutMs"] as JsonPrimitive).content.toLong(),
        )
    }

    fun admitsBackground(moduleInstanceId: String): Boolean = lock.withLock { !freed && broker.admitsBackground(moduleInstanceId) }

    fun hasBackgroundWork(moduleInstanceId: String): Boolean = lock.withLock { !freed && broker.hasBackgroundWork(moduleInstanceId) }

    fun ownerIsActive(moduleInstanceId: String, activationId: UInt): Boolean =
        lock.withLock { !freed && broker.ownerIsActive(moduleInstanceId, activationId) }

    fun isLive(id: UInt): Boolean = lock.withLock { !freed && broker.isLive(id) }

    val liveCount: Int get() = lock.withLock { if (freed) 0 else broker.liveCount().toInt() }

    val retainedBytes: Long get() = lock.withLock { if (freed) 0 else broker.retainedBytes().toLong() }

    val coreStreamId: UInt? get() = lock.withLock { if (freed) null else broker.coreStreamId() }

    fun outstandingCredit(id: UInt): Long? = lock.withLock { if (freed) null else broker.outstandingCredit(id)?.toLong() }

    fun outstandingEventCredit(id: UInt): Long? = lock.withLock { if (freed) null else broker.outstandingEventCredit(id)?.toLong() }

    /** A snapshot of the broker's state (`device_binding::info_json`), or `null` once released. */
    fun info(): JsonObject? = lock.withLock {
        if (freed) null else kotlinx.serialization.json.Json.parseToJsonElement(broker.infoJson()).jsonObject
    }

    // ---- pump ------------------------------------------------------------------

    private fun pump() {
        lock.withLock {
            if (freed) return
            if (pumping) {
                again = true
                return
            }
            pumping = true
            try {
                do {
                    again = false
                    val outputs = try {
                        broker.setTransportBuffered(buffered())
                        broker.poll()
                    } catch (e: Exception) {
                        onError("device broker poll", e)
                        break
                    }
                    for (o in outputs) dispatch(o)
                } while (again)
            } finally {
                pumping = false
            }
            if (closing || broker.isClosed()) {
                release()
                return
            }
            schedule()
        }
    }

    private fun buffered(): ULong = try {
        sink.bufferedAmount().coerceAtLeast(0).toULong()
    } catch (_: Exception) {
        0uL
    }

    private fun dispatch(o: DeviceOutput) {
        when (o) {
            is DeviceOutput.SendText -> try {
                sink.sendText(o.text)
            } catch (e: Exception) {
                onError("device message send", e)
            }
            is DeviceOutput.SendFrame -> {
                // A request cancelled while this turn's frames were being
                // handed out sends nothing more after its cancel.
                if (o.frame.size >= 8 && !broker.isLive(frameRequestId(o.frame))) return
                if (!binaryRoute) return
                try {
                    sink.sendFrame(o.frame)
                } catch (e: Exception) {
                    onError("device frame send", e)
                }
            }
            is DeviceOutput.Event -> {
                val p = pending[o.id]
                val inbox = p?.inbox
                val event = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(o.eventJson).jsonObject }.getOrNull()
                if (p == null || inbox == null || p.done || event == null || inbox.trySend(Delivery.Event(event)).isFailure) {
                    // No consumer: the event is consumed so credit moves on.
                    broker.consumedEvents(o.id, 1uL, now())
                    again = true
                }
            }
            is DeviceOutput.Data -> {
                val p = pending[o.id]
                val inbox = p?.inbox
                if (p == null || inbox == null || p.done || inbox.trySend(Delivery.Data(o.bytes, o.channel.toInt())).isFailure) {
                    broker.consumedData(o.id, 1u, now())
                    again = true
                }
            }
            is DeviceOutput.Settled -> settle(o.id, o.outcome)
            is DeviceOutput.CloseConnection -> {
                closing = true
                clearTimer()
                try {
                    sink.closeConnection(o.code.toInt(), o.reason)
                } catch (e: Exception) {
                    onError("device plane close", e)
                }
            }
        }
    }

    /** Deliver one request's events / chunks to its consumer, one call at a time, in order. */
    private suspend fun consume(
        p: Pending,
        onEvent: (suspend (JsonObject) -> Unit)?,
        onData: (suspend (ByteArray, Int) -> Unit)?,
    ) {
        val inbox = p.inbox ?: return
        for (d in inbox) {
            when (d) {
                is Delivery.Event -> {
                    try {
                        onEvent?.invoke(d.event)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        onError("device event consumer", e) // a throwing consumer still consumed the event
                    }
                    lock.withLock {
                        if (!isClosed) {
                            broker.consumedEvents(p.id, 1uL, now())
                            pump()
                        }
                    }
                }
                is Delivery.Data -> {
                    try {
                        onData?.invoke(d.bytes, d.channel)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        onError("device data consumer", e) // a throwing consumer still consumed the chunk
                    }
                    lock.withLock {
                        if (!isClosed) {
                            broker.consumedData(p.id, 1u, now())
                            pump()
                        }
                    }
                }
            }
        }
        // The inbox closed after a success terminal: everything was delivered.
        lock.withLock { p.deferredSuccess }?.let { p.settled.complete(it) }
    }

    private fun settle(id: UInt, outcome: DeviceOutcome) {
        val p = pending.remove(id) ?: return
        p.done = true
        when (outcome) {
            is DeviceOutcome.Failure -> {
                // Undelivered chunks of a failed stream are dropped.
                p.inbox?.cancel()
                p.consumer?.cancel()
                p.settled.complete(
                    DeviceSettlement.Failure(DeviceErrorCode.fromWireName(outcome.code) ?: DeviceErrorCode.INTERNAL, outcome.detail),
                )
            }
            is DeviceOutcome.Success -> {
                val result = runCatching {
                    kotlinx.serialization.json.Json.parseToJsonElement(outcome.resultJson) as JsonObject
                }.getOrElse { JsonObject(emptyMap()) }
                val success = DeviceSettlement.Success(
                    result = result,
                    blobs = outcome.blobs.map { VerifiedBlob(it.channel.toInt(), it.name, it.contentType, it.bytes) },
                    simulated = outcome.simulated,
                    release = if (outcome.held) ({ releaseResult(id) }) else null,
                )
                if (p.inbox != null) {
                    // Settle once the consumer processed everything delivered.
                    p.deferredSuccess = success
                    p.inbox.close()
                } else {
                    p.settled.complete(success)
                }
            }
        }
    }

    // ---- timer -----------------------------------------------------------------

    private fun schedule() {
        if (freed || closing) return
        val next = broker.nextDeadline()
        if (next == null) {
            clearTimer()
            return
        }
        val now = now()
        if (next <= now) {
            // Due now (a bulk turn): after already-queued work, never inline.
            clearTimer()
            if (turnQueued) return
            turnQueued = true
            scope.launch {
                yield()
                lock.withLock { turnQueued = false }
                fire()
            }
            return
        }
        if (timer?.isActive == true && timerAt == next) return
        clearTimer()
        timerAt = next
        timer = scope.launch {
            delay((next - now).toLong().coerceAtLeast(1))
            lock.withLock {
                if (timerAt == next) {
                    timer = null
                    timerAt = null
                }
            }
            fire()
        }
    }

    private fun fire() = lock.withLock {
        if (freed || closing) return
        try {
            broker.tick(now())
        } catch (e: Exception) {
            onError("device broker tick", e)
        }
        pump()
    }

    private fun clearTimer() {
        timer?.cancel()
        timer = null
        timerAt = null
    }

    /** Release the broker (closed): anything still pending ends `connectionLost`. */
    private fun release() {
        if (freed) return
        freed = true
        closing = true
        clearTimer()
        for (p in pending.values) {
            p.done = true
            p.inbox?.cancel()
            p.consumer?.cancel()
            p.settled.complete(DeviceSettlement.Failure(DeviceErrorCode.CONNECTION_LOST))
        }
        pending.clear()
        try {
            broker.destroy()
        } catch (e: Exception) {
            onError("device broker free", e)
        }
    }

    private fun refused(code: DeviceErrorCode, detail: String?): DeviceRequestHandle =
        DeviceRequestHandle(null, CompletableDeferred(DeviceSettlement.Failure(code, detail))) {}

    private fun JsonObject.string(key: String): String = (this[key] as JsonPrimitive).content

    companion object {
        /** The request id of a device frame header (u32 LE at offset 4). */
        fun frameRequestId(frame: ByteArray): UInt =
            ((frame[4].toInt() and 0xff) or ((frame[5].toInt() and 0xff) shl 8) or
                ((frame[6].toInt() and 0xff) shl 16) or ((frame[7].toInt() and 0xff) shl 24)).toUInt()

        /** Parse JSON text into an element (lenient; the broker already validated device payloads). */
        internal fun parse(text: String): JsonElement = kotlinx.serialization.json.Json.parseToJsonElement(text)
    }
}
