package space.hypen.remote.device

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * A scripted client-side device endpoint for JVM tests: it answers the
 * server broker's `deviceRequest`s with per-capability drivers, echoes
 * `renewLease` as `leaseAck`, grants download credit and collects download
 * frames — exactly the wire traffic a real client (hypen-web DeviceClient,
 * native hosts) produces. Every reply is delivered asynchronously through
 * [scope] (like a socket would), never re-entrantly.
 */
class FakeDeviceClient(
    private val scope: CoroutineScope,
    private val toServerText: (String) -> Unit,
    private val toServerFrame: (ByteArray) -> Unit,
) {
    /** Every server → client device message, parsed, in order. */
    val received = mutableListOf<JsonObject>()

    /** Every client → server text, in order. */
    val sent = mutableListOf<String>()

    /** Download bytes collected per request id. */
    val downloads = mutableMapOf<Long, java.io.ByteArrayOutputStream>()

    /** Whether leases are acknowledged (false simulates a stalled client). */
    @Volatile var ackLeases = true

    /** Credit to grant for downloads (`null` = never grant). */
    @Volatile var downloadGrant: Long? = 1 shl 20

    private val drivers = mutableMapOf<String, suspend Req.() -> Unit>()
    private val cancelled = mutableMapOf<Long, CompletableDeferred<Unit>>()
    private val inbox = Channel<Any>(Channel.UNLIMITED)

    init {
        scope.launch {
            for (m in inbox) {
                when (m) {
                    is String -> handleText(m)
                    is ByteArray -> handleFrame(m)
                }
            }
        }
    }

    class Req(
        val client: FakeDeviceClient,
        val id: Long,
        val capability: String,
        val params: JsonObject,
        val request: JsonObject,
    ) {
        val cancelled: CompletableDeferred<Unit> get() = client.cancelled.getValue(id)

        fun respond(result: JsonObject) = client.text(buildJsonObject {
            put("type", "deviceResponse")
            put("id", id)
            put("result", result)
            put("simulated", true)
        })

        fun fail(code: String, detail: String? = null) = client.text(buildJsonObject {
            put("type", "deviceResponse")
            put("id", id)
            put("error", buildJsonObject {
                put("code", code)
                detail?.let { put("platformDetail", it) }
            })
        })

        fun event(event: JsonObject) = client.text(buildJsonObject {
            put("type", "deviceEvent")
            put("id", id)
            put("event", event)
        })

        fun blobStart(channel: Int, contentType: String, bytes: Long?) = event(buildJsonObject {
            put("kind", "blobStart")
            put("channel", channel)
            put("contentType", contentType)
            bytes?.let { put("bytes", it) }
        })

        fun frame(channel: Int, seq: Int, payload: ByteArray) = client.toServerFrame(encodeFrame(id, channel, seq, payload))

        /** blobStart + frames of ≤ 64 KiB, returning the item `{channel, contentType, bytes, sha256}`. */
        fun upload(channel: Int, contentType: String, bytes: ByteArray, declare: Boolean = true): JsonObject {
            blobStart(channel, contentType, if (declare) bytes.size.toLong() else null)
            var seq = 0
            var off = 0
            while (off < bytes.size) {
                val end = minOf(bytes.size, off + 65536)
                frame(channel, seq++, bytes.copyOfRange(off, end))
                off = end
            }
            return buildJsonObject {
                put("channel", channel)
                put("contentType", contentType)
                put("bytes", bytes.size)
                put("sha256", sha256(bytes))
            }
        }
    }

    fun driver(capability: String, block: suspend Req.() -> Unit): FakeDeviceClient {
        drivers[capability] = block
        return this
    }

    /** Feed one server → client text (from the plane's sink). */
    fun fromServer(text: String) {
        inbox.trySend(text)
    }

    /** Feed one server → client binary frame. */
    fun fromServerFrame(frame: ByteArray) {
        inbox.trySend(frame)
    }

    fun text(o: JsonObject) {
        val t = o.toString()
        synchronized(sent) { sent += t }
        toServerText(t)
    }

    fun receivedSnapshot(): List<JsonObject> = synchronized(received) { received.toList() }

    fun requests(capability: String): List<JsonObject> = receivedSnapshot().filter {
        it["type"]?.jsonPrimitive?.content == "deviceRequest" && it["capability"]?.jsonPrimitive?.content == capability
    }

    fun controls(id: Long, key: String): List<JsonElement> = receivedSnapshot().filter {
        it["type"]?.jsonPrimitive?.content == "deviceEvent" && it["id"]?.jsonPrimitive?.long == id
    }.mapNotNull { (it["control"] as? JsonObject)?.get(key) }

    private suspend fun handleText(text: String) {
        val m = kotlinx.serialization.json.Json.parseToJsonElement(text).jsonObject
        synchronized(received) { received += m }
        val id = m["id"]?.jsonPrimitive?.long ?: return
        when (m["type"]?.jsonPrimitive?.content) {
            "deviceRequest" -> {
                val cap = m.getValue("capability").jsonPrimitive.content
                cancelled[id] = CompletableDeferred()
                val params = m["params"] as? JsonObject ?: JsonObject(emptyMap())
                val req = Req(this, id, cap, params, m)
                val driver = drivers[cap]
                if (cap == "file.save") {
                    downloads[id] = java.io.ByteArrayOutputStream()
                    downloadGrant?.let { g ->
                        text(buildJsonObject {
                            put("type", "deviceEvent")
                            put("id", id)
                            put("control", buildJsonObject { put("grant", g) })
                        })
                    }
                }
                when {
                    driver != null -> scope.launch { driver(req) }
                    cap == "core.capabilities" -> {} // stays open
                    cap != "file.save" -> req.fail("unsupported")
                }
            }
            "deviceEvent" -> {
                val control = m["control"] as? JsonObject ?: return
                control["renewLease"]?.let { seq ->
                    if (ackLeases) {
                        text(buildJsonObject {
                            put("type", "deviceEvent")
                            put("id", id)
                            put("control", buildJsonObject { put("leaseAck", seq.jsonPrimitive.long) })
                        })
                    }
                }
                if (control["cancel"] != null) cancelled[id]?.complete(Unit)
            }
        }
    }

    private fun handleFrame(frame: ByteArray) {
        val id = DevicePlane.frameRequestId(frame).toLong()
        val sink = downloads[id] ?: return
        sink.write(frame, 12, frame.size - 12)
        val expected = requests("file.save").firstOrNull { it["id"]?.jsonPrimitive?.long == id }
            ?.get("params")?.jsonObject?.get("bytes")?.jsonPrimitive?.long ?: return
        if (sink.size().toLong() == expected) {
            text(buildJsonObject {
                put("type", "deviceResponse")
                put("id", id)
                put("result", buildJsonObject { put("bytesWritten", expected) })
            })
        }
    }

    companion object {
        fun encodeFrame(id: Long, channel: Int, seq: Int, payload: ByteArray): ByteArray =
            ByteBuffer.allocate(12 + payload.size).order(ByteOrder.LITTLE_ENDIAN)
                .put(1).put(0).putShort(channel.toShort()).putInt(id.toInt()).putInt(seq).put(payload).array()

        fun sha256(b: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

        fun obj(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject {
            for ((k, v) in pairs) when (v) {
                is String -> put(k, v)
                is Number -> put(k, JsonPrimitive(v))
                is Boolean -> put(k, v)
                is JsonElement -> put(k, v)
                null -> {}
                else -> error("unsupported $v")
            }
        }
    }
}
