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
 */
@JsonClass(generateAdapter = true)
data class InitialTreeMessage(
    @Json(name = "type") override val type: String = "initialTree",
    val module: String,
    val state: Map<String, Any?>?,
    val patches: List<Patch>,
    val revision: Int,
    val hash: String? = null,
) : RemoteMessage

/**
 * Message sent by the server with UI updates.
 */
@JsonClass(generateAdapter = true)
data class PatchMessage(
    @Json(name = "type") override val type: String = "patch",
    val module: String,
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
    val module: String,
    val state: Map<String, Any?>?,
) : RemoteMessage

/**
 * Message sent by the client after WebSocket opens to establish session.
 */
@JsonClass(generateAdapter = true)
data class HelloMessage(
    @Json(name = "type") override val type: String = "hello",
    val sessionId: String? = null,
    val props: Map<String, Any?>? = null,
) : RemoteMessage

/**
 * Message sent by the server to confirm session establishment.
 */
@JsonClass(generateAdapter = true)
data class SessionAckMessage(
    @Json(name = "type") override val type: String = "sessionAck",
    val sessionId: String,
    val isNew: Boolean,
    val isRestored: Boolean,
) : RemoteMessage

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
 * Wrapper for parsing the message type before full deserialization.
 */
@JsonClass(generateAdapter = true)
data class MessageTypeWrapper(
    val type: String,
)
