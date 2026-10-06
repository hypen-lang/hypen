/**
 * Device Capability Protocol (RFC 001) — Android DeviceHost wire layer.
 *
 * Everything in `space.hypen.renderer.device` (excluding the `android`
 * sub-package) is deliberately free of Android framework imports so the
 * protocol core runs and is unit-tested on a plain JVM. Android-specific
 * drivers live in `space.hypen.renderer.device.android` behind the small
 * platform interfaces declared in [Drivers.kt].
 *
 * The design mirrors the JVM SDK's wire types in
 * `hypen-kotlin/src/main/kotlin/space/hypen/remote/device/` (not a dependency:
 * the renderer only has Moshi, not kotlinx.serialization). JSON travels as
 * plain `Map<String, Any?>` / `List<Any?>` / `String` / `Number` / `Boolean`
 * trees so the core needs no JSON library; the renderer's strict Moshi reader
 * (`space.hypen.renderer.remote.StrictDeviceJson`) produces those trees at the
 * socket edge. Tree contract: the reader enforces the RFC 001 §2.1 JSON
 * limits (decision D4), so every number is an integer token and arrives as
 * `Long` (`Int` is accepted too, for trees built in code); a non-integer
 * token (`1.0`, `1e0`, `-0`), a duplicate key, a raw control character, a
 * lone surrogate or excess depth never reaches the core: the socket edge
 * routes such text to [DeviceConnection.handleMalformed], a connection-level
 * violation attributable to no request (decisions D3/D8). A `Double` in a
 * tree built in code is never an integer.
 *
 * Provisional until the RFC 001 §6 Phase 4 real-driver gate.
 */
package space.hypen.renderer.device

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Protocol-level constants (RFC 001 §2.3 / §2.7). */
object DeviceProtocol {
    /** Device protocol versions this host implements. */
    val PROTOCOL_VERSIONS: List<Long> = listOf(1L)

    /** Binary frame header length in bytes (RFC 001 §2.3). */
    const val FRAME_HEADER_LEN: Int = 12

    /** Frame header version for protocol v1. */
    const val FRAME_VERSION: Int = 1

    /** Lease renewal interval (server side; informational here). */
    const val LEASE_RENEW_INTERVAL_MS: Long = 5_000

    /** Lease expiry after the latest accepted renewal (or request receipt). */
    const val LEASE_EXPIRY_MS: Long = 15_000

    /** Maximum binary payload per frame / per scheduling turn (§2.3). */
    const val MAX_BULK_CHUNK_BYTES: Int = 64 * 1024

    /** Stop enqueueing bulk data once the transport holds this many bytes (§2.3). */
    const val MAX_TRANSPORT_PENDING_BYTES: Long = 256L * 1024

    /** Largest integer every SDK carries losslessly through JSON (2^53 - 1). */
    const val JSON_SAFE_MAX: Long = 9_007_199_254_740_991

    /** Largest `u32`: request ids, revisions, activation ids, lease sequences and frame `seq`. */
    const val U32_MAX: Long = 4_294_967_295

    /** Largest server → client binary frame accepted at the transport edge: one 64 KiB chunk + header. */
    const val MAX_FRAME_BYTES: Int = MAX_BULK_CHUNK_BYTES + FRAME_HEADER_LEN

    /**
     * Envelope-level bounds (envelope-v1 schema): the largest value any v1
     * revision allows. Per-revision limits are checked against the registry.
     */
    const val MAX_TIMEOUT_MS: Long = 86_400_000
    const val MAX_INITIAL_CREDIT: Long = 4_194_304
    const val MAX_GRANT: Long = 8_388_608

    /** String bounds, counted in Unicode code points (never UTF-16 units). */
    const val MAX_CAPABILITY_NAME: Int = 128
    const val MAX_MODULE_INSTANCE_ID: Int = 256
    const val MAX_PLATFORM_DETAIL: Int = 512
}

/** Length in Unicode code points (a surrogate pair counts once). */
fun String.codePointLength(): Int = codePointCount(0, length)

/**
 * The first [max] code points of this string. Never splits a surrogate pair,
 * so the result is always valid UTF-16 (and encodes to valid UTF-8).
 */
fun String.truncateCodePoints(max: Int): String {
    if (length <= max) return this
    if (codePointLength() <= max) return this
    return substring(0, offsetByCodePoints(0, max))
}

/** Closed error taxonomy for protocol v1 (RFC 001 §3). */
enum class DeviceErrorCode(val wireName: String) {
    UNSUPPORTED("unsupported"),
    UNAVAILABLE("unavailable"),
    DENIED("denied"),
    REVOKED("revoked"),
    CANCELLED("cancelled"),
    TIMEOUT("timeout"),
    THROTTLED("throttled"),
    CONNECTION_LOST("connectionLost"),
    INVALID_PARAMS("invalidParams"),
    INTERNAL("internal"),
}

/** Requested lifetime for a device operation (RFC 001 §2.7). */
enum class Lifetime(val wireName: String) {
    ACTIVATION("activation"),
    BACKGROUND("background"),
    CONNECTION("connection"),
    ;

    companion object {
        fun fromWire(name: String): Lifetime? = entries.firstOrNull { it.wireName == name }
    }
}

/** Logical owner travelling with the request; shape must match [Lifetime]. */
sealed class Owner {
    data class Activation(val moduleInstanceId: String, val activationId: Long) : Owner()

    data class Module(val moduleInstanceId: String) : Owner()

    data object Connection : Owner()

    fun matches(lifetime: Lifetime): Boolean = when (this) {
        is Activation -> lifetime == Lifetime.ACTIVATION
        is Module -> lifetime == Lifetime.BACKGROUND
        Connection -> lifetime == Lifetime.CONNECTION
    }
}

/** A validated server → client `deviceRequest` (RFC 001 §2.1). */
data class DeviceRequest(
    val id: Long,
    val capability: String,
    val version: Long,
    val owner: Owner,
    val lifetime: Lifetime,
    val timeoutMs: Long,
    val initialCredit: Long,
    val params: Map<String, Any?>,
)

/** Control variants (RFC 001 §2.1 / §2.7): exactly one per control object. */
sealed class Control {
    data class Grant(val amount: Long) : Control()

    data object Cancel : Control()

    data class RenewLease(val seq: Long) : Control()

    data class LeaseAck(val seq: Long) : Control()

    data class Paused(val paused: Boolean) : Control()

    fun toWire(): Map<String, Any?> = when (this) {
        is Grant -> mapOf("grant" to amount)
        Cancel -> mapOf("cancel" to true)
        is RenewLease -> mapOf("renewLease" to seq)
        is LeaseAck -> mapOf("leaseAck" to seq)
        is Paused -> mapOf("paused" to paused)
    }
}

/** A validated server → client `deviceEvent`: exactly one of [event] / [control]. */
data class DeviceEventIn(val id: Long, val event: Map<String, Any?>?, val control: Control?)

/** Outcome of parsing one inbound wire message. */
sealed class Parsed<out T> {
    data class Ok<T>(val value: T) : Parsed<T>()

    /**
     * Invalid message. [id] is the request id when it was itself readable and
     * valid (a known-id invalid message terminates that operation with
     * `invalidParams`); `null` means the message cannot be attributed.
     */
    data class Invalid(val id: Long?, val reason: String) : Parsed<Nothing>()
}

/**
 * Closed-schema parsing and encoding of the envelope (envelope-v1). Integers
 * must be integral JSON tokens: `Long`/`Int` in the tree (see the file
 * header); a `Double` is a non-integral token (`1.0`, `1e0`, `-0`, `1.5`)
 * and is rejected wherever the schema says `integer`.
 */
object DeviceWire {
    private val REQUEST_KEYS = setOf(
        "type", "id", "capability", "version", "owner", "lifetime", "timeoutMs", "initialCredit", "params",
    )
    private val EVENT_KEYS = setOf("type", "id", "event", "control")

    /**
     * The value of an integral JSON token, or null. `Double`/`Float` are
     * non-integral tokens by the tree contract and never count as integers.
     */
    fun exactLong(v: Any?): Long? = when (v) {
        is Int -> v.toLong()
        is Long -> v
        is Short -> v.toLong()
        is Byte -> v.toLong()
        else -> null
    }

    private fun idOf(map: Map<String, Any?>): Long? =
        exactLong(map["id"])?.takeIf { it in 1..DeviceProtocol.U32_MAX }

    fun typeOf(map: Map<String, Any?>): String? = map["type"] as? String

    fun parseRequest(map: Map<String, Any?>): Parsed<DeviceRequest> {
        val id = idOf(map) ?: return Parsed.Invalid(null, "deviceRequest id missing or out of range")
        fun bad(reason: String) = Parsed.Invalid(id, reason)
        if (typeOf(map) != "deviceRequest") return bad("type is not deviceRequest")
        (map.keys - REQUEST_KEYS).firstOrNull()?.let { return bad("unexpected property $it") }
        (REQUEST_KEYS - map.keys).firstOrNull()?.let { return bad("missing required $it") }

        val capability = map["capability"] as? String ?: return bad("capability must be a string")
        if (capability.codePointLength() !in 1..DeviceProtocol.MAX_CAPABILITY_NAME) {
            return bad("capability must be 1..${DeviceProtocol.MAX_CAPABILITY_NAME} code points")
        }
        val version = exactLong(map["version"])?.takeIf { it in 1..DeviceProtocol.U32_MAX }
            ?: return bad("version out of range")
        val lifetime = (map["lifetime"] as? String)?.let(Lifetime::fromWire) ?: return bad("unknown lifetime")
        val owner = when (val o = parseOwner(map["owner"])) {
            is Parsed.Ok -> o.value
            is Parsed.Invalid -> return bad(o.reason)
        }
        if (!owner.matches(lifetime)) return bad("owner shape does not match lifetime ${lifetime.wireName}")
        val timeoutMs = exactLong(map["timeoutMs"])?.takeIf { it in 1..DeviceProtocol.MAX_TIMEOUT_MS }
            ?: return bad("timeoutMs must be an integer in 1..${DeviceProtocol.MAX_TIMEOUT_MS}")
        val initialCredit = exactLong(map["initialCredit"])?.takeIf { it in 0..DeviceProtocol.MAX_INITIAL_CREDIT }
            ?: return bad("initialCredit must be an integer in 0..${DeviceProtocol.MAX_INITIAL_CREDIT}")
        val params = asObject(map["params"]) ?: return bad("params must be an object")
        return Parsed.Ok(DeviceRequest(id, capability, version, owner, lifetime, timeoutMs, initialCredit, params))
    }

    private fun parseOwner(v: Any?): Parsed<Owner> {
        val o = asObject(v) ?: return Parsed.Invalid(null, "owner must be an object")
        fun moduleId(): String? =
            (o["moduleInstanceId"] as? String)?.takeIf { it.codePointLength() in 1..DeviceProtocol.MAX_MODULE_INSTANCE_ID }
        return when (o.keys) {
            setOf("moduleInstanceId", "activationId") -> {
                val mid = moduleId() ?: return Parsed.Invalid(null, "owner.moduleInstanceId invalid")
                val aid = exactLong(o["activationId"])?.takeIf { it in 1..DeviceProtocol.U32_MAX }
                    ?: return Parsed.Invalid(null, "owner.activationId out of range")
                Parsed.Ok(Owner.Activation(mid, aid))
            }
            setOf("moduleInstanceId") -> {
                val mid = moduleId() ?: return Parsed.Invalid(null, "owner.moduleInstanceId invalid")
                Parsed.Ok(Owner.Module(mid))
            }
            setOf("connection") ->
                if (o["connection"] == true) Parsed.Ok(Owner.Connection) else Parsed.Invalid(null, "owner.connection must be true")
            else -> Parsed.Invalid(null, "owner matches no known shape: ${o.keys}")
        }
    }

    fun parseEvent(map: Map<String, Any?>): Parsed<DeviceEventIn> {
        val id = idOf(map) ?: return Parsed.Invalid(null, "deviceEvent id missing or out of range")
        fun bad(reason: String) = Parsed.Invalid(id, reason)
        if (typeOf(map) != "deviceEvent") return bad("type is not deviceEvent")
        (map.keys - EVENT_KEYS).firstOrNull()?.let { return bad("unexpected property $it") }
        val hasEvent = "event" in map
        val hasControl = "control" in map
        if (hasEvent == hasControl) return bad("deviceEvent must carry exactly one of event/control")
        if (hasEvent) {
            val event = asObject(map["event"]) ?: return bad("event must be an object")
            return Parsed.Ok(DeviceEventIn(id, event, null))
        }
        return when (val c = parseControl(map["control"])) {
            is Parsed.Ok -> Parsed.Ok(DeviceEventIn(id, null, c.value))
            is Parsed.Invalid -> bad(c.reason)
        }
    }

    private val RESPONSE_KEYS = setOf("type", "id", "result", "error", "simulated")

    /**
     * Closed-schema check of a `deviceResponse` (envelope-v1): exactly one of
     * `result` (an object) / `error` (`{code, platformDetail?}`, detail at
     * most 512 code points), `simulated` only as `true`. Responses flow
     * client → server only; the client uses this to self-check what it sends
     * and to replay the shared corpus.
     */
    fun parseResponse(map: Map<String, Any?>): Parsed<Long> {
        val id = idOf(map) ?: return Parsed.Invalid(null, "deviceResponse id missing or out of range")
        fun bad(reason: String) = Parsed.Invalid(id, reason)
        if (typeOf(map) != "deviceResponse") return bad("type is not deviceResponse")
        (map.keys - RESPONSE_KEYS).firstOrNull()?.let { return bad("unexpected property $it") }
        if (("result" in map) == ("error" in map)) return bad("deviceResponse must carry exactly one of result/error")
        if ("simulated" in map && map["simulated"] != true) return bad("simulated must be true when present")
        if ("result" in map) {
            asObject(map["result"]) ?: return bad("result must be an object")
            return Parsed.Ok(id)
        }
        val err = asObject(map["error"]) ?: return bad("error must be an object")
        (err.keys - setOf("code", "platformDetail")).firstOrNull()?.let { return bad("unexpected error property $it") }
        val code = err["code"] as? String ?: return bad("error.code must be a string")
        if (DeviceErrorCode.entries.none { it.wireName == code }) return bad("unknown error code")
        if ("platformDetail" in err) {
            val detail = err["platformDetail"] as? String ?: return bad("platformDetail must be a string")
            if (detail.codePointLength() > DeviceProtocol.MAX_PLATFORM_DETAIL) return bad("platformDetail too long")
        }
        return Parsed.Ok(id)
    }

    fun parseControl(v: Any?): Parsed<Control> {
        val o = asObject(v) ?: return Parsed.Invalid(null, "control must be an object")
        if (o.size != 1) return Parsed.Invalid(null, "control must contain exactly one variant")
        val (key, raw) = o.entries.first()
        // grant: 1..MAX_GRANT (the schema cap: the largest maxOutstandingCredit);
        // lease sequences: u32 (1..4294967295), like ids and revisions.
        fun inRange(max: Long): Long? = exactLong(raw)?.takeIf { it in 1..max }
        return when (key) {
            "grant" -> inRange(DeviceProtocol.MAX_GRANT)?.let { Parsed.Ok(Control.Grant(it)) }
                ?: Parsed.Invalid(null, "grant must be an integer in 1..${DeviceProtocol.MAX_GRANT}")
            "cancel" -> if (raw == true) Parsed.Ok(Control.Cancel) else Parsed.Invalid(null, "cancel must be true")
            "renewLease" -> inRange(DeviceProtocol.U32_MAX)?.let { Parsed.Ok(Control.RenewLease(it)) }
                ?: Parsed.Invalid(null, "renewLease must be an integer in 1..${DeviceProtocol.U32_MAX}")
            "leaseAck" -> inRange(DeviceProtocol.U32_MAX)?.let { Parsed.Ok(Control.LeaseAck(it)) }
                ?: Parsed.Invalid(null, "leaseAck must be an integer in 1..${DeviceProtocol.U32_MAX}")
            "paused" -> (raw as? Boolean)?.let { Parsed.Ok(Control.Paused(it)) } ?: Parsed.Invalid(null, "paused must be a boolean")
            else -> Parsed.Invalid(null, "unknown control variant '$key'")
        }
    }

    @Suppress("UNCHECKED_CAST")
    fun asObject(v: Any?): Map<String, Any?>? =
        (v as? Map<*, *>)?.takeIf { m -> m.keys.all { it is String } } as Map<String, Any?>?

    // ---- client → server encoders ------------------------------------------

    fun result(id: Long, result: Map<String, Any?>, simulated: Boolean = false): Map<String, Any?> {
        val m = linkedMapOf<String, Any?>("type" to "deviceResponse", "id" to id, "result" to result)
        if (simulated) m["simulated"] = true
        return m
    }

    /**
     * A terminal error. [platformDetail] is diagnostic only; `""` is present
     * and round-trips as present, null is omitted (never sent as `null`).
     */
    fun error(id: Long, code: DeviceErrorCode, platformDetail: String? = null, simulated: Boolean = false): Map<String, Any?> {
        val err = linkedMapOf<String, Any?>("code" to code.wireName)
        if (platformDetail != null) err["platformDetail"] = platformDetail.truncateCodePoints(DeviceProtocol.MAX_PLATFORM_DETAIL)
        val m = linkedMapOf<String, Any?>("type" to "deviceResponse", "id" to id, "error" to err)
        if (simulated) m["simulated"] = true
        return m
    }

    fun event(id: Long, event: Map<String, Any?>): Map<String, Any?> =
        linkedMapOf("type" to "deviceEvent", "id" to id, "event" to event)

    fun control(id: Long, control: Control): Map<String, Any?> =
        linkedMapOf("type" to "deviceEvent", "id" to id, "control" to control.toWire())

    /** A blob announcement; [bytes] is omitted when the length is unknown (decision D5). */
    fun blobStart(channel: Int, contentType: String, bytes: Long?): Map<String, Any?> {
        val m = linkedMapOf<String, Any?>("kind" to "blobStart", "channel" to channel, "contentType" to contentType)
        if (bytes != null) m["bytes"] = bytes
        return m
    }

    fun progress(state: ProgressState): Map<String, Any?> = linkedMapOf("kind" to "progress", "state" to state.wireName)
}

// ---------------------------------------------------------------------------
// Binary frames (RFC 001 §2.3)
// ---------------------------------------------------------------------------

/**
 * A frame header. Layout, little-endian, 12 bytes:
 * `[u8 version=1][u8 flags=0][u16 channel][u32 requestId][u32 seq][payload…]`.
 */
data class FrameHeader(
    val version: Int = DeviceProtocol.FRAME_VERSION,
    val flags: Int = 0,
    val channel: Int,
    val requestId: Long,
    val seq: Long,
) {
    init {
        require(version in 0..0xFF) { "version must fit a u8, got $version" }
        require(flags in 0..0xFF) { "flags must fit a u8, got $flags" }
        require(channel in 0..0xFFFF) { "channel must fit a u16, got $channel" }
        require(requestId in 0..DeviceProtocol.U32_MAX) { "requestId must fit a u32, got $requestId" }
        require(seq in 0..DeviceProtocol.U32_MAX) { "seq must fit a u32, got $seq" }
    }
}

sealed class FrameDecode {
    class Ok(val header: FrameHeader, val payload: ByteArray) : FrameDecode()

    /** Shorter than the 12-byte header: drop silently. */
    data object Short : FrameDecode()

    /** Unknown version or nonzero flags: protocol violation. */
    data class Violation(val detail: String) : FrameDecode()
}

object DeviceFrames {
    fun encode(header: FrameHeader, payload: ByteArray = ByteArray(0), offset: Int = 0, length: Int = payload.size): ByteArray {
        val buf = ByteBuffer.allocate(DeviceProtocol.FRAME_HEADER_LEN + length).order(ByteOrder.LITTLE_ENDIAN)
        buf.put(header.version.toByte())
        buf.put(header.flags.toByte())
        buf.putShort(header.channel.toShort())
        buf.putInt(header.requestId.toInt())
        buf.putInt(header.seq.toInt())
        buf.put(payload, offset, length)
        return buf.array()
    }

    fun decode(frame: ByteArray): FrameDecode {
        if (frame.size < DeviceProtocol.FRAME_HEADER_LEN) return FrameDecode.Short
        val buf = ByteBuffer.wrap(frame, 0, DeviceProtocol.FRAME_HEADER_LEN).order(ByteOrder.LITTLE_ENDIAN)
        val version = buf.get().toInt() and 0xFF
        val flags = buf.get().toInt() and 0xFF
        if (version != DeviceProtocol.FRAME_VERSION) return FrameDecode.Violation("version $version")
        if (flags != 0) return FrameDecode.Violation("flags $flags")
        val channel = buf.getShort().toInt() and 0xFFFF
        val requestId = buf.getInt().toLong() and 0xFFFF_FFFFL
        val seq = buf.getInt().toLong() and 0xFFFF_FFFFL
        return FrameDecode.Ok(
            FrameHeader(version, flags, channel, requestId, seq),
            frame.copyOfRange(DeviceProtocol.FRAME_HEADER_LEN, frame.size),
        )
    }
}

/**
 * Receiver-side per-`(requestId, channel)` sequence rule (RFC 001 §2.3,
 * pinned by `frames.json` `sequences`): `seq` starts at 0 and advances for
 * every produced chunk; a lossless channel (overflow `pause`) needs exactly
 * the next one, `dropOldest` permits forward gaps; repeats, decreases and
 * anything after 2^32−1 are violations.
 */
class FrameSequence(private val lossless: Boolean) {
    private var last = -1L

    /** True when [seq] is acceptable next (and records it). */
    fun accept(seq: Long): Boolean {
        if (seq !in 0..DeviceProtocol.U32_MAX) return false
        val ok = if (lossless) seq == last + 1 else seq > last
        if (ok) last = seq
        return ok
    }

    /** The next sequence a lossless channel expects. */
    val next: Long get() = last + 1
}

/** Lowercase hex of [bytes]. */
internal fun hex(bytes: ByteArray): String {
    val digits = "0123456789abcdef"
    val out = CharArray(bytes.size * 2)
    for (i in bytes.indices) {
        val b = bytes[i].toInt() and 0xFF
        out[2 * i] = digits[b ushr 4]
        out[2 * i + 1] = digits[b and 0x0F]
    }
    return String(out)
}
