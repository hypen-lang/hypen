package space.hypen.renderer.remote

import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.model.*
import com.squareup.moshi.JsonAdapter
import com.squareup.moshi.Moshi
import com.squareup.moshi.adapters.EnumJsonAdapter
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory

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

    private val typeWrapperAdapter: JsonAdapter<MessageTypeWrapper> =
        moshi.adapter(MessageTypeWrapper::class.java)

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

    override fun parseMessage(json: String): RemoteMessage? {
        return try {
            // First, determine the message type
            val typeWrapper = typeWrapperAdapter.fromJson(json) ?: return null

            // Then parse the full message based on type
            when (typeWrapper.type) {
                "initialTree" -> initialTreeAdapter.fromJson(json)
                "patch" -> patchMessageAdapter.fromJson(json)
                "stateUpdate" -> stateUpdateAdapter.fromJson(json)
                "dispatchAction" -> dispatchActionAdapter.fromJson(json)
                "hello" -> helloAdapter.fromJson(json)
                "sessionAck" -> sessionAckAdapter.fromJson(json)
                "sessionExpired" -> sessionExpiredAdapter.fromJson(json)
                else -> {
                    HypenLoggers.remote.warn("Unknown message type: %s", typeWrapper.type)
                    null
                }
            }
        } catch (e: Exception) {
            HypenLoggers.remote.error("Error parsing message: %s", e.message ?: "unknown")
            null
        }
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
        }
}
