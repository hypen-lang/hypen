package space.hypen.renderer.model

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

/**
 * Base interface for all remote messages.
 */
sealed interface RemoteMessage {
    val type: String
}

/**
 * Message sent by the server on initial connection.
 * Contains the initial UI tree as patches and initial state.
 *
 * [module] and [state] are informational on this client (the tree is the
 * patches), so a server that omits them — the Kotlin server did before its
 * wire fix — still renders instead of losing the whole message.
 */
@JsonClass(generateAdapter = true)
data class InitialTreeMessage(
    @Json(name = "type") override val type: String = "initialTree",
    val module: String = "",
    val state: Map<String, Any?>? = null,
    val patches: List<Patch>,
    val revision: Int,
    val hash: String? = null,
) : RemoteMessage

/**
 * Message sent by the server with UI updates.
 *
 * [module] is informational (TS / Go / Kotlin servers send it; nothing here
 * routes on it): a `patch` without it is applied, never dropped whole —
 * dropping it lost every UI update from servers that omitted it.
 */
@JsonClass(generateAdapter = true)
data class PatchMessage(
    @Json(name = "type") override val type: String = "patch",
    val module: String = "",
    val patches: List<Patch>,
    val revision: Int,
    val hash: String? = null,
) : RemoteMessage

/**
 * Message sent by the client to dispatch an action.
 */
@JsonClass(generateAdapter = true)
data class DispatchActionMessage(
    @Json(name = "type") override val type: String = "dispatchAction",
    val module: String,
    val action: String,
    val payload: Map<String, Any?>? = null,
) : RemoteMessage

/**
 * Message sent by the server with state updates.
 */
@JsonClass(generateAdapter = true)
data class StateUpdateMessage(
    @Json(name = "type") override val type: String = "stateUpdate",
    val module: String = "",
    val state: Map<String, Any?>? = null,
) : RemoteMessage

/**
 * Message sent by the client after WebSocket opens to establish session.
 */
@JsonClass(generateAdapter = true)
data class HelloMessage(
    @Json(name = "type") override val type: String = "hello",
    val sessionId: String? = null,
    val props: Map<String, Any?>? = null,
    /**
     * Device Capability Protocol advertisement (RFC 001 §2.2), present only
     * when a DeviceHost is attached to an uncompressed socket. Null is
     * omitted from the wire, so the legacy hello is byte-identical.
     */
    val device: Map<String, Any?>? = null,
    /**
     * Resume credential for [sessionId] (RFC 001 §5), sent only when resuming
     * that session. A secret: omitted from [toString], never logged.
     */
    val resumeToken: String? = null,
) : RemoteMessage {
    override fun toString(): String =
        "HelloMessage(type=$type, sessionId=$sessionId, props=$props, device=$device, resumeToken=${if (resumeToken != null) "<redacted>" else "null"})"
}

/**
 * Message sent by the server to confirm session establishment.
 *
 * [device] and [resumeToken] are not bound by Moshi's reflective adapter:
 * `MoshiMessageParser` decodes `device` with the strict device reader (a
 * duplicate key there disables the device plane — [deviceMalformed] — instead
 * of failing the whole `sessionAck`) and accepts `resumeToken` only as a
 * non-empty string.
 */
@JsonClass(generateAdapter = true)
data class SessionAckMessage(
    @Json(name = "type") override val type: String = "sessionAck",
    val sessionId: String,
    val isNew: Boolean,
    val isRestored: Boolean,
    /** Server's device selection (RFC 001 §2.2); null when the device plane is off. */
    @Transient val device: Map<String, Any?>? = null,
    /**
     * Resume credential issued by a device-enabled server (RFC 001 §5),
     * rotated on every acknowledged connection. A secret: omitted from
     * [toString], never logged.
     */
    @Transient val resumeToken: String? = null,
    /** Why `sessionAck.device` could not be decoded strictly, or null. */
    @Transient val deviceMalformed: String? = null,
) : RemoteMessage {
    override fun toString(): String =
        "SessionAckMessage(type=$type, sessionId=$sessionId, isNew=$isNew, isRestored=$isRestored, device=$device, " +
            "resumeToken=${if (resumeToken != null) "<redacted>" else "null"}, deviceMalformed=$deviceMalformed)"
}

/**
 * Message sent by the server when session is terminated.
 */
@JsonClass(generateAdapter = true)
data class SessionExpiredMessage(
    @Json(name = "type") override val type: String = "sessionExpired",
    val sessionId: String,
    val reason: String, // "ttl", "kicked", "manual"
) : RemoteMessage

/**
 * A Device Capability Protocol envelope message (`deviceRequest`,
 * `deviceEvent`, `deviceResponse`; RFC 001 §2.1) carried as a raw JSON tree.
 * Routed only to the socket's `DeviceConnection`, never into the patch/state
 * path or the action dispatcher.
 */
data class DeviceWireMessage(
    override val type: String,
    val body: Map<String, Any?>,
    /** UTF-8 size of the JSON text (counted against the device inbox byte bound). */
    val sizeBytes: Int = 0,
) : RemoteMessage

/**
 * A device message the socket edge refused before trusting its JSON: text
 * that breaks the RFC 001 §2.1 JSON limits (decision D4: oversize text,
 * nesting deeper than 32, non-integer number tokens, raw control characters,
 * lone surrogates, duplicate keys, bad literals). Such text is attributable
 * to no request (decisions D3/D8): `DeviceConnection.handleMalformed`
 * discards and counts it as a connection-level violation and never
 * terminates the request its (untrusted) id seems to name. Receive-only:
 * never serialized.
 */
data class DeviceMalformedMessage(
    override val type: String,
    val detail: String,
    val sizeBytes: Int = 0,
) : RemoteMessage

/**
 * Wrapper for parsing the message type before full deserialization.
 */
@JsonClass(generateAdapter = true)
data class MessageTypeWrapper(
    val type: String,
)
