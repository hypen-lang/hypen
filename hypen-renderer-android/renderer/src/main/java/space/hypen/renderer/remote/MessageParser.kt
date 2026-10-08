package space.hypen.renderer.remote

import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.device.DeviceWire
import space.hypen.renderer.model.*
import com.squareup.moshi.JsonAdapter
import com.squareup.moshi.JsonReader
import com.squareup.moshi.Moshi
import com.squareup.moshi.adapters.EnumJsonAdapter
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import okio.Buffer

/**
 * Interface for parsing remote messages.
 */
interface MessageParser {
    /**
     * Parse an incoming message from the server.
     */
    fun parseMessage(json: String): RemoteMessage?

    /**
     * Serialize an outgoing message to the server.
     */
    fun serializeMessage(message: RemoteMessage): String
}

/**
 * Default implementation of MessageParser using Moshi.
 */
class MoshiMessageParser : MessageParser {
    private val moshi: Moshi =
        Moshi
            .Builder()
            .add(PatchType::class.java, EnumJsonAdapter.create(PatchType::class.java).withUnknownFallback(null))
            .addLast(KotlinJsonAdapterFactory())
            .build()

    private val initialTreeAdapter: JsonAdapter<InitialTreeMessage> =
        moshi.adapter(InitialTreeMessage::class.java)

    private val patchMessageAdapter: JsonAdapter<PatchMessage> =
        moshi.adapter(PatchMessage::class.java)

    private val stateUpdateAdapter: JsonAdapter<StateUpdateMessage> =
        moshi.adapter(StateUpdateMessage::class.java)

    private val dispatchActionAdapter: JsonAdapter<DispatchActionMessage> =
        moshi.adapter(DispatchActionMessage::class.java)

    private val helloAdapter: JsonAdapter<HelloMessage> =
        moshi.adapter(HelloMessage::class.java)

    private val sessionAckAdapter: JsonAdapter<SessionAckMessage> =
        moshi.adapter(SessionAckMessage::class.java)

    private val sessionExpiredAdapter: JsonAdapter<SessionExpiredMessage> =
        moshi.adapter(SessionExpiredMessage::class.java)

    private val deviceAdapter: JsonAdapter<Any> = moshi.adapter(Any::class.java)

    // Device JSON keeps explicit nulls: a present-but-null member is data
    // (RFC 001 envelope: a null sibling is still a present key).
    private val deviceWriter: JsonAdapter<Any> = deviceAdapter.serializeNulls()

    /**
     * Text from OkHttp: its bytes were decoded leniently (malformed UTF-8
     * became U+FFFD), so device JSON is parsed with raw U+FFFD refused (see
     * [StrictDeviceJson]).
     */
    override fun parseMessage(json: String): RemoteMessage? = parseMessage(json, utf8Verified = false)

    /** [utf8Verified]: [json] came from a strict UTF-8 decoder ([parseMessageBytes]). */
    fun parseMessage(json: String, utf8Verified: Boolean): RemoteMessage? {
        // One UTF-8 encoding of the message serves both the type peek and the
        // parse: `peek()` reads the buffer without consuming it, so the same
        // bytes are handed to the typed adapter below. Encoding twice cost a
        // second full-message copy per batch.
        val buffer = Buffer().writeUtf8(json)
        val type = try {
            peekMessageType(JsonReader.of(buffer.peek()))
        } catch (e: Exception) {
            // Not even loosely JSON. A device-typed text is still a
            // connection-level device violation (counted), not silence.
            DEVICE_TYPE_PREFIX.find(json)?.groupValues?.get(1)?.let { deviceType ->
                return DeviceMalformedMessage(deviceType, "not JSON", StrictDeviceJson.utf8Length(json).toSizeInt())
            }
            HypenLoggers.remote.error("Error parsing message: %s", e.message ?: "unknown")
            return null
        }
        return try {
            val reader = JsonReader.of(buffer)
            when (type) {
                "initialTree" -> initialTreeAdapter.fromJson(reader)
                "patch" -> patchMessageAdapter.fromJson(reader)
                "stateUpdate" -> stateUpdateAdapter.fromJson(reader)
                "dispatchAction" -> dispatchActionAdapter.fromJson(reader)
                "hello" -> helloAdapter.fromJson(reader)
                "sessionAck" -> parseSessionAck(json, reader, utf8Verified)
                "sessionExpired" -> sessionExpiredAdapter.fromJson(reader)
                "deviceRequest", "deviceEvent", "deviceResponse" -> parseDevice(type, json, utf8Verified)
                else -> {
                    HypenLoggers.remote.warn("Unknown message type: %s", type)
                    null
                }
            }
        } catch (e: Exception) {
            HypenLoggers.remote.error("Error parsing message: %s", e.message ?: "unknown")
            null
        }
    }

    /**
     * Parse raw text-frame bytes: strict UTF-8 first (RFC 001 §2.1), then
     * [parseMessage] with the UTF-8 verified (a raw U+FFFD is then ordinary
     * text). OkHttp hands the engine already-decoded strings, so this is for
     * transports (and tests) that see the bytes.
     */
    fun parseMessageBytes(bytes: ByteArray): RemoteMessage? {
        val text = try {
            StrictDeviceJson.decodeUtf8(bytes)
        } catch (e: DeviceJsonException) {
            val loose = String(bytes, Charsets.UTF_8)
            DEVICE_TYPE_PREFIX.find(loose)?.groupValues?.get(1)?.let { return DeviceMalformedMessage(it, "invalid UTF-8", bytes.size) }
            return null
        }
        return parseMessage(text, utf8Verified = true)
    }

    /**
     * Device envelope messages are decoded with [StrictDeviceJson] (RFC 001
     * §2.1, decision D4). Text that breaks the JSON limits never reaches the
     * DeviceHost as data: it becomes a [DeviceMalformedMessage], which the
     * connection counts as a connection-level violation without attributing
     * it to any request (decisions D3/D8).
     */
    private fun parseDevice(type: String, json: String, utf8Verified: Boolean): RemoteMessage {
        val size = StrictDeviceJson.utf8Length(json)
        if (size > StrictDeviceJson.MAX_DEVICE_JSON_BYTES) {
            return DeviceMalformedMessage(type, "device message of $size bytes exceeds ${StrictDeviceJson.MAX_DEVICE_JSON_BYTES}", size.toSizeInt())
        }
        return try {
            @Suppress("UNCHECKED_CAST")
            val body = StrictDeviceJson.parse(json, utf8Verified) as? Map<String, Any?>
                ?: return DeviceMalformedMessage(type, "device message is not an object", size.toSizeInt())
            DeviceWireMessage(type, body, size.toSizeInt())
        } catch (e: DeviceJsonException) {
            DeviceMalformedMessage(type, "JSON limits: ${e.message.orEmpty().take(128)}", size.toSizeInt())
        }
    }

    /**
     * `sessionAck`: the typed fields through Moshi, while `device` comes from
     * a strict parse of the whole text (the handshake objects obey the same
     * JSON limits, RFC 001 §2.1): a limit violation disables the device plane
     * ([SessionAckMessage.deviceMalformed]) rather than failing the session.
     * `resumeToken` is kept only when it is one non-empty string.
     */
    private fun parseSessionAck(json: String, reader: JsonReader, utf8Verified: Boolean): SessionAckMessage? {
        val extras = reader.peekJson()
        val ack = sessionAckAdapter.fromJson(reader) ?: return null
        var deviceSeen = 0
        var token: String? = null
        var tokenSeen = 0
        extras.beginObject()
        while (extras.hasNext()) {
            when (extras.nextName()) {
                "device" -> {
                    deviceSeen += 1
                    extras.skipValue()
                }
                "resumeToken" -> {
                    tokenSeen += 1
                    token = if (extras.peek() == JsonReader.Token.STRING) extras.nextString() else null.also { extras.skipValue() }
                }
                else -> extras.skipValue()
            }
        }
        if (tokenSeen > 1) token = null
        var device: Map<String, Any?>? = null
        var malformed: String? = null
        if (deviceSeen > 0) {
            try {
                @Suppress("UNCHECKED_CAST")
                val tree = StrictDeviceJson.parse(json, utf8Verified) as Map<String, Any?>
                val raw = tree["device"]
                if (raw != null) {
                    device = DeviceWire.asObject(raw)
                    if (device == null) malformed = "device must be an object"
                }
            } catch (e: DeviceJsonException) {
                malformed = e.message.orEmpty().take(128)
            }
        }
        return ack.copy(
            device = if (malformed == null) device else null,
            deviceMalformed = malformed,
            resumeToken = token?.takeIf { it.isNotEmpty() },
        )
    }

    private fun peekMessageType(reader: JsonReader): String? {
        val peeked = reader.peekJson()
        peeked.beginObject()
        while (peeked.hasNext()) {
            if (peeked.selectName(TYPE_NAME_OPTIONS) != -1) {
                return peeked.nextString()
            }
            peeked.skipName()
            peeked.skipValue()
        }
        return null
    }

    override fun serializeMessage(message: RemoteMessage): String =
        when (message) {
            is InitialTreeMessage -> initialTreeAdapter.toJson(message)
            is PatchMessage -> patchMessageAdapter.toJson(message)
            is StateUpdateMessage -> stateUpdateAdapter.toJson(message)
            is DispatchActionMessage -> dispatchActionAdapter.toJson(message)
            is HelloMessage -> helloAdapter.toJson(message)
            is SessionAckMessage -> sessionAckAdapter.toJson(message)
            is SessionExpiredMessage -> sessionExpiredAdapter.toJson(message)
            is DeviceWireMessage -> deviceWriter.toJson(message.body)
            is DeviceMalformedMessage -> throw IllegalArgumentException("DeviceMalformedMessage is receive-only")
        }

    private companion object {
        val TYPE_NAME_OPTIONS: JsonReader.Options = JsonReader.Options.of("type")

        /** A leading `"type":"device…"` member, for text too broken to peek with Moshi. */
        val DEVICE_TYPE_PREFIX = Regex("""^\s*\{\s*"type"\s*:\s*"(deviceRequest|deviceEvent|deviceResponse)"""")

        fun Long.toSizeInt(): Int = coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }
}
