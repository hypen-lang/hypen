package space.hypen.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import space.hypen.remote.device.DeviceClock
import space.hypen.remote.device.Lifetime
import java.net.URI
import java.util.concurrent.atomic.AtomicLong

/**
 * A WebSocket connection as [HypenServer.openConnection] drives it: the host
 * adapts its socket (Ktor `DefaultWebSocketSession`, Netty channel, …) to
 * these three calls. The server serializes every write through one ordered
 * outbound queue, so implementations only need to write one frame at a time.
 */
interface HypenTransport {
    /** Write one text frame. */
    suspend fun sendText(text: String)

    /** Write one binary frame (device download bytes, RFC 001 §2.3). */
    suspend fun sendBinary(bytes: ByteArray)

    /** Close the socket with a WebSocket close code and reason (≤ 123 bytes). */
    suspend fun close(code: Int, reason: String)

    /**
     * Bytes the transport itself accepted but has not written to the network
     * yet (e.g. Netty's `ChannelOutboundBuffer.totalPendingWriteBytes()`),
     * when the socket exposes it; `0` when it does not. Added to what the
     * server's own queue holds so the device broker paces bulk frames
     * against everything still buffered (RFC 001 §2.3). Must not block.
     */
    fun bufferedAmount(): Long = 0
}

/**
 * The HTTP upgrade request a host hands to [HypenServer.admit] before
 * accepting a WebSocket. Header names are matched case-insensitively.
 */
class UpgradeRequest(
    headers: Map<String, List<String>> = emptyMap(),
    val path: String = "/",
    val remoteAddress: String? = null,
) {
    private val headers: Map<String, List<String>> = headers.mapKeys { it.key.lowercase() }

    /** The first value of header [name], or `null`. */
    fun header(name: String): String? = headers[name.lowercase()]?.firstOrNull()

    /** The browser `Origin` header; native clients send none. */
    val origin: String? get() = header("Origin")

    override fun toString(): String = "UpgradeRequest(path=$path, origin=$origin)"

    companion object {
        /** Convenience: single-valued headers. */
        fun of(vararg headers: Pair<String, String>, path: String = "/"): UpgradeRequest =
            UpgradeRequest(headers.groupBy({ it.first }, { it.second }), path)
    }
}

/** The verdict of [HypenServer.admit]. */
sealed class Admission {
    object Admitted : Admission() {
        override fun toString(): String = "Admitted"
    }

    /** Refuse the upgrade with this HTTP status (403) — never accept the socket. */
    data class Rejected(val status: Int, val reason: String) : Admission()

    val isAdmitted: Boolean get() = this is Admitted
}

/**
 * WebSocket upgrade admission (RFC 001 §5, decision D1). `Origin` is a
 * browser-only defence (cross-site WebSocket hijacking); native clients send
 * none and authenticate through the app's authenticator instead. Each check
 * applies exactly when it is configured, independent of the device plane:
 *
 * - `Origin` present + an allowlist → it must be in the allowlist, else 403;
 * - `Origin` absent + an allowlist → admitted only by the authenticator (no
 *   authenticator ⇒ 403, fail closed);
 * - a configured authenticator runs for every request (also WITH an allowed
 *   Origin). An authenticator that throws refuses.
 *
 * With neither configured every upgrade is admitted ([HypenServer] logs a
 * startup warning).
 */
internal class UpgradeAdmission(
    allowedOrigins: List<String>,
    private val authenticate: (suspend (UpgradeRequest) -> Boolean)?,
) {
    private val allowlist: Set<String>? = allowedOrigins.map(::normalizeOrigin).toSet().takeIf { it.isNotEmpty() }
    private val log = HypenLoggers.server

    suspend fun admit(request: UpgradeRequest): Admission {
        fun forbidden(why: String): Admission {
            log.warn("Rejected WebSocket upgrade: $why")
            return Admission.Rejected(403, why)
        }
        val origin = request.origin
        if (origin != null) {
            if (allowlist != null && normalizeOrigin(origin) !in allowlist) return forbidden("origin $origin not allowed")
        } else if (authenticate == null && allowlist != null) {
            return forbidden("no Origin and no authenticator configured")
        }
        if (authenticate != null) {
            val ok = try {
                authenticate.invoke(request)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                log.warn("authenticate() threw — upgrade refused: ${e.message}")
                false
            }
            if (!ok) return forbidden("authenticate() refused the connection")
        }
        return Admission.Admitted
    }

    companion object {
        /**
         * Normalize an Origin for allowlist comparison: lowercase scheme +
         * host, default ports dropped, no path. Invalid input normalizes to
         * itself (trimmed, lowercased) so it simply never matches.
         */
        fun normalizeOrigin(origin: String): String = try {
            val uri = URI(origin.trim())
            val scheme = uri.scheme?.lowercase() ?: error("no scheme")
            val host = uri.host?.lowercase() ?: error("no host")
            val port = uri.port.takeIf { p ->
                p != -1 && !(scheme == "http" && p == 80) && !(scheme == "https" && p == 443)
            }
            if (port != null) "$scheme://$host:$port" else "$scheme://$host"
        } catch (_: Exception) {
            origin.trim().lowercase()
        }
    }
}

/**
 * Device Capability Protocol settings of a [HypenServer] (RFC 001). The
 * device plane is on by default; tune it with
 * `HypenServer { configureDevice { … } }` (every option has a default) or
 * opt out with `disableDevice()`. Admission (`allowedOrigins(…)` /
 * `authenticate { … }`) is configured separately and is not required.
 */
class DeviceServerConfig {
    /**
     * Handshake timeout: while the device plane is on, a connection opened
     * with [HypenServer.openConnection] waits for the client's explicit
     * `hello` and closes the socket (1008) when none arrived within this
     * many ms. (Hello-less legacy clients use [HypenServer.handleConnect].)
     */
    var helloTimeoutMs: Long = 30_000

    /** Per-connection retained upload bytes (the broker default when `null`). */
    var maxRetainedBytes: Long? = null

    /** Host cap on a single blob item, applied to every revision. */
    var maxItemBytes: Long? = null

    /** Hard cap on modules pinned by live background work (per connection). */
    var maxBackgroundOwners: Int? = null

    /** Overall deadline of the `core.capabilities` control stream (reopened before it). */
    var controlStreamTimeoutMs: Long? = null

    /**
     * Aggregate retained-bytes budget shared by every connection of this
     * server (a `DeviceRetainedBytesPool`), next to each connection's own.
     * `null` shares none. Default: the broker's process default (1 GiB).
     */
    var poolBytes: Long? = DEFAULT_POOL_BYTES

    /** Monotonic clock for the brokers (tests inject a virtual one). */
    var clock: DeviceClock = DeviceClock.SYSTEM

    internal val overrides = mutableListOf<JsonObject>()

    /**
     * Replace a registry revision's bounds for this server, e.g. allow
     * `background` for `bluetooth.scan@1`. Only the named fields change; the
     * payload schemas stay the shipped ones.
     */
    fun revisionOverride(
        capability: String,
        version: Int = 1,
        lifetimes: List<Lifetime>? = null,
        maxItemBytes: Long? = null,
        maxTimeoutMs: Long? = null,
    ) {
        overrides += buildJsonObject {
            put("capability", JsonPrimitive(capability))
            put("version", JsonPrimitive(version))
            lifetimes?.let { l -> put("lifetimes", JsonArray(l.map { JsonPrimitive(it.wireName) })) }
            maxItemBytes?.let { put("maxItemBytes", JsonPrimitive(it)) }
            maxTimeoutMs?.let { put("maxTimeoutMs", JsonPrimitive(it)) }
        }
    }

    /** The broker configuration JSON (`device_binding::parse_config`) for one connection. */
    internal fun brokerConfigJson(ack: JsonElement): String = buildJsonObject {
        put("ack", ack)
        maxRetainedBytes?.let { put("maxRetainedBytes", JsonPrimitive(it)) }
        maxItemBytes?.let { put("maxItemBytes", JsonPrimitive(it)) }
        maxBackgroundOwners?.let { put("maxBackgroundOwners", JsonPrimitive(it)) }
        controlStreamTimeoutMs?.let { put("controlStreamTimeoutMs", JsonPrimitive(it)) }
        if (overrides.isNotEmpty()) put("revisionOverrides", JsonArray(overrides.toList()))
    }.toString()

    companion object {
        /** The broker's process-wide default aggregate budget. */
        val DEFAULT_POOL_BYTES: Long by lazy {
            runCatching {
                Json.parseToJsonElement(uniffi.hypen_engine.deviceConstantsJson()).jsonObject
                    .getValue("defaultProcessRetainedBytes").jsonPrimitive.long
            }.getOrDefault(1L shl 30)
        }

        /** The WebSocket close code that resets a broken device plane (1012). */
        val DEVICE_PLANE_CLOSE_CODE: Int by lazy {
            runCatching {
                Json.parseToJsonElement(uniffi.hypen_engine.deviceConstantsJson()).jsonObject
                    .getValue("devicePlaneCloseCode").jsonPrimitive.long.toInt()
            }.getOrDefault(1012)
        }
    }
}

/**
 * One ordered outbound queue per connection: UI messages, device messages
 * and device frames are written in enqueue order by one writer coroutine.
 * [buffered] is what the device broker paces bulk frames against (RFC 001
 * §2.3: 64 KiB turns, 256 KiB pending): the UTF-8 wire bytes of every text
 * and the bytes of every frame enqueued and not yet handed to the
 * transport, plus the transport's own [HypenTransport.bufferedAmount].
 */
internal class OutboundQueue(
    private val transport: HypenTransport,
    scope: CoroutineScope,
    private val onError: (String, Throwable) -> Unit,
) {
    private sealed class Out(val size: Long) {
        class Text(val text: String) : Out(utf8Length(text))
        class Binary(val bytes: ByteArray) : Out(bytes.size.toLong())
        class Close(val code: Int, val reason: String) : Out(0)
    }

    private val channel = Channel<Out>(Channel.UNLIMITED)
    private val queued = AtomicLong(0)

    @Volatile
    var closed: Boolean = false
        private set

    private val writer = scope.launch {
        for (o in channel) {
            try {
                when (o) {
                    is Out.Text -> transport.sendText(o.text)
                    is Out.Binary -> transport.sendBinary(o.bytes)
                    is Out.Close -> transport.close(o.code, truncateReason(o.reason))
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                onError("transport write", e)
            } finally {
                queued.addAndGet(-o.size)
            }
            if (o is Out.Close) break
        }
        closed = true
        channel.cancel()
    }

    private fun enqueue(o: Out) {
        if (closed) return
        queued.addAndGet(o.size)
        if (channel.trySend(o).isFailure) queued.addAndGet(-o.size)
    }

    fun sendText(text: String) = enqueue(Out.Text(text))

    fun sendBinary(bytes: ByteArray) = enqueue(Out.Binary(bytes))

    /** Close the socket after everything already queued was written. */
    fun close(code: Int, reason: String) {
        enqueue(Out.Close(code, reason))
        closed = true
    }

    /** Stop writing (the socket is gone). */
    fun stop() {
        closed = true
        channel.close()
        writer.cancel()
    }

    /** Queued wire bytes plus the transport's own buffer (when observable). */
    val buffered: Long
        get() {
            val own = queued.get().coerceAtLeast(0)
            val transportBuffered = try {
                transport.bufferedAmount().coerceAtLeast(0)
            } catch (e: Exception) {
                0L
            }
            return own + transportBuffered
        }

    companion object {
        /**
         * The UTF-8 wire size of [text] without encoding it: exactly
         * `text.toByteArray(Charsets.UTF_8).size` (the JDK encoder and Netty
         * both write a lone surrogate as the one-byte `?`), counted in one
         * pass with no allocation.
         */
        fun utf8Length(text: String): Long {
            var n = 0L
            var i = 0
            val len = text.length
            while (i < len) {
                val c = text[i]
                when {
                    c.code < 0x80 -> n += 1
                    c.code < 0x800 -> n += 2
                    Character.isHighSurrogate(c) && i + 1 < len && Character.isLowSurrogate(text[i + 1]) -> {
                        n += 4
                        i++
                    }
                    Character.isSurrogate(c) -> n += 1 // replaced by '?'
                    else -> n += 3
                }
                i++
            }
            return n
        }
    }

    private fun truncateReason(reason: String): String {
        val bytes = reason.toByteArray(Charsets.UTF_8)
        if (bytes.size <= 123) return reason
        var s = reason
        while (s.toByteArray(Charsets.UTF_8).size > 123) s = s.dropLast(1)
        return s
    }
}

/**
 * Iterative (never recursive) JSON container-depth scan. [HypenServer.handleMessage]
 * runs it before handing a text to kotlinx.serialization, whose tree reader
 * recurses per container: a ≤ 1 MiB text nested hundreds of thousands of
 * levels deep would otherwise throw `StackOverflowError` out of the host's
 * socket read loop. Brackets inside strings (with escapes) do not count.
 * Malformed text is not judged here — only depth is.
 */
internal object JsonNesting {
    /**
     * Deepest nesting any host-parsed (non-device) message may have. Device
     * messages have their own, much tighter limit (32, decision D4) enforced
     * by the Rust broker's strict decoder; this bound only keeps the lenient
     * host parser's recursion safe on any thread stack.
     */
    const val MAX_HOST_PARSE_DEPTH: Int = 256

    /** True when [text] opens more than [limit] nested `{` / `[` containers. */
    fun exceeds(text: String, limit: Int): Boolean {
        var depth = 0
        var inString = false
        var i = 0
        val n = text.length
        while (i < n) {
            val c = text[i]
            if (inString) {
                when (c) {
                    '\\' -> i++
                    '"' -> inString = false
                }
            } else {
                when (c) {
                    '"' -> inString = true
                    '{', '[' -> if (++depth > limit) return true
                    '}', ']' -> if (depth > 0) depth--
                }
            }
            i++
        }
        return false
    }
}

/**
 * Reads a negotiated `Sec-WebSocket-Extensions` value (the upgrade
 * RESPONSE) for permessage-deflate (RFC 7692). The device plane is allowed
 * on a compressed socket only when the negotiated extension carries BOTH
 * `server_no_context_takeover` and `client_no_context_takeover`: every
 * message is then compressed on its own, so device data never shares a
 * compression history with other messages (the cross-message context
 * CRIME/BREACH-style attacks rely on).
 */
internal object PerMessageDeflate {
    /**
     * True when [negotiated] carries a permessage-deflate element without
     * both no-context-takeover parameters (context takeover in at least one
     * direction). `null`, empty, or no permessage-deflate ⇒ false.
     */
    fun sharesContext(negotiated: String?): Boolean {
        if (negotiated.isNullOrBlank()) return false
        return elements(negotiated).any { params ->
            params.firstOrNull()?.equals("permessage-deflate", ignoreCase = true) == true &&
                !(hasParam(params, "server_no_context_takeover") && hasParam(params, "client_no_context_takeover"))
        }
    }

    private fun hasParam(params: List<String>, name: String): Boolean =
        params.drop(1).any { it.substringBefore('=').trim().equals(name, ignoreCase = true) }

    /** Extension elements (`,`-separated) as `[name, param, …]` (`;`-separated), quotes respected. */
    private fun elements(header: String): List<List<String>> {
        val out = mutableListOf<List<String>>()
        var params = mutableListOf<String>()
        val token = StringBuilder()
        var quoted = false
        fun endToken() {
            params += token.toString().trim()
            token.clear()
        }
        for (c in header) {
            when {
                c == '"' -> { quoted = !quoted; token.append(c) }
                quoted -> token.append(c)
                c == ';' -> endToken()
                c == ',' -> { endToken(); out += params; params = mutableListOf() }
                else -> token.append(c)
            }
        }
        endToken()
        out += params
        return out.map { element -> element.filter { it.isNotEmpty() } }.filter { it.isNotEmpty() }
    }
}

/**
 * Locate one top-level member of a JSON object text WITHOUT normalizing it,
 * so the strict device decoder sees the member's exact spelling (duplicate
 * keys, number forms, escapes). Used for `hello.device` (RFC 001 §2.2): the
 * rest of a hello (e.g. `props`) is ordinary JSON and is not subject to the
 * device limits.
 */
internal object TopLevelMember {
    sealed class Lookup {
        object Absent : Lookup()

        /** The text is not a JSON object, or the key repeats. */
        object Invalid : Lookup()

        data class Found(val raw: String) : Lookup()
    }

    fun find(text: String, key: String): Lookup {
        var i = 0
        val n = text.length
        fun ws() {
            while (i < n && (text[i] == ' ' || text[i] == '\t' || text[i] == '\n' || text[i] == '\r')) i++
        }
        fun skipString(): Boolean {
            if (i >= n || text[i] != '"') return false
            i++
            while (i < n) {
                when (text[i]) {
                    '\\' -> i += 2
                    '"' -> {
                        i++
                        return true
                    }
                    else -> i++
                }
            }
            return false
        }
        fun skipValue(): Boolean {
            if (i >= n) return false
            return when (text[i]) {
                '"' -> skipString()
                '{', '[' -> {
                    var depth = 0
                    while (i < n) {
                        when (text[i]) {
                            '"' -> {
                                if (!skipString()) return false
                                continue
                            }
                            '{', '[' -> depth++
                            '}', ']' -> {
                                depth--
                                if (depth == 0) {
                                    i++
                                    return true
                                }
                            }
                        }
                        i++
                    }
                    false
                }
                else -> {
                    val start = i
                    while (i < n && text[i] != ',' && text[i] != '}' && text[i] != ']' && !text[i].isWhitespace()) i++
                    i > start
                }
            }
        }
        ws()
        if (i >= n || text[i] != '{') return Lookup.Invalid
        i++
        var found: String? = null
        ws()
        if (i < n && text[i] == '}') return Lookup.Absent
        while (i < n) {
            ws()
            val keyStart = i
            if (!skipString()) return Lookup.Invalid
            val name = try {
                Json.parseToJsonElement(text.substring(keyStart, i)).jsonPrimitive.content
            } catch (_: Exception) {
                return Lookup.Invalid
            }
            ws()
            if (i >= n || text[i] != ':') return Lookup.Invalid
            i++
            ws()
            val valueStart = i
            if (!skipValue()) return Lookup.Invalid
            if (name == key) {
                if (found != null) return Lookup.Invalid
                found = text.substring(valueStart, i)
            }
            ws()
            if (i < n && text[i] == ',') {
                i++
                continue
            }
            if (i < n && text[i] == '}') {
                i++
                ws()
                if (i != n) return Lookup.Invalid
                return found?.let { Lookup.Found(it) } ?: Lookup.Absent
            }
            return Lookup.Invalid
        }
        return Lookup.Invalid
    }
}
