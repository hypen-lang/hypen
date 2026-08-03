package space.hypen.renderer.remote

import space.hypen.renderer.HypenLoggers
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

    override fun parseMessage(json: String): RemoteMessage? {
        return try {
            val reader = JsonReader.of(Buffer().writeUtf8(json))

            // Peek the "type" field without consuming the document, then
            // parse the body in a single pass from the same reader
            when (val type = peekMessageType(reader)) {
                "initialTree" -> initialTreeAdapter.fromJson(reader)
                "patch" -> patchMessageAdapter.fromJson(reader)
                "stateUpdate" -> stateUpdateAdapter.fromJson(reader)
                "dispatchAction" -> dispatchActionAdapter.fromJson(reader)
                "hello" -> helloAdapter.fromJson(reader)
                "sessionAck" -> sessionAckAdapter.fromJson(reader)
                "sessionExpired" -> sessionExpiredAdapter.fromJson(reader)
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
        }

    private companion object {
        val TYPE_NAME_OPTIONS: JsonReader.Options = JsonReader.Options.of("type")
    }
}
