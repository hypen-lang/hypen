package space.hypen.core

import kotlinx.serialization.json.JsonElement

/**
 * Thrown by every [AgentHandle] member once the user session it was
 * attached to is no longer live — disconnected, kicked by a concurrent
 * connection, or torn down by [HypenServer.shutdown].
 */
class AgentSessionGoneException(val sessionId: String) :
    IllegalStateException("Session $sessionId is no longer attached to a live client")

/**
 * An agent's view of one **live user session** — attach mode for the
 * external capability surface.
 *
 * Obtained from [HypenServer.attach]. Every call runs against the engine of
 * the connected renderer, so a [dispatch] puts on the user's WebSocket
 * exactly what a click in that UI would: the same `patch` message, the same
 * revision bookkeeping, the same [HypenEvents.actionDispatched] event.
 *
 * What it is **not**:
 *
 * - It never owns the session. It cannot destroy, suspend or close it; when
 *   the user disconnects the handle simply starts throwing
 *   [AgentSessionGoneException] (see [isAlive]).
 * - It is never permissive. [dispatch] goes through
 *   [NativeEngine.dispatchExternal] — the engine's declared-surface guard —
 *   never the renderer's `dispatchAction` path. A refused name throws
 *   [EngineError.ActionNotFound] *before* anything reaches the wire: no
 *   message is sent and [revision] does not move.
 * - It does no authorization. The developer calling
 *   [HypenServer.attach] is the authorizer.
 *
 * ```kotlin
 * val handle = server.attach(sessionId) ?: error("no such live session")
 * handle.listActions()                    // what the app declared
 * handle.dispatch("addToCart", mapOf("sku" to "A1"))  // user sees the badge tick
 * handle.getState(path = "cart.total")
 * ```
 */
class AgentHandle internal constructor(
    private val server: HypenServer,
    private val client: ClientState
) {
    /** The user session this handle is bound to. */
    val sessionId: String
        get() = client.sessionId

    /**
     * True while the attached client is still connected and ready. Once
     * false it never becomes true again; every other member throws
     * [AgentSessionGoneException].
     */
    val isAlive: Boolean
        get() = client.ready

    /**
     * Every action an external caller may dispatch on this session right
     * now — see [NativeEngine.listActions].
     */
    fun listActions(): List<AgentAction> {
        ensureAlive()
        return client.engine.listActions()
    }

    /**
     * Dispatch a declared action on the user's session.
     *
     * Goes through [HypenServer.dispatchAndSend], the same path a renderer
     * click takes: patch collection, the revision bump and the transport
     * write all run under the client mutex, so an agent dispatch and a
     * concurrent click can never interleave between stamping a revision
     * and sending it — the user's socket sees strictly increasing
     * revisions, one `patch` frame per dispatch, in the order the engine
     * ran them.
     *
     * @throws EngineError.ActionNotFound when the engine's guard refuses the
     *   name or payload. Nothing is sent and no revision is consumed.
     * @throws AgentSessionGoneException when the session is no longer live.
     */
    suspend fun dispatch(name: String, payload: Any? = null) {
        ensureAlive()
        server.dispatchAndSend(client) {
            // Re-check under the lock: a disconnect racing with this call
            // must not drive an engine that is about to be torn down.
            ensureAlive()
            client.engine.dispatchExternal(name, payload)
        }
        server.events().emit(
            HypenEvents.actionDispatched,
            HypenEvents.ActionDispatched(client.sessionId, name, payload)
        )
    }

    /**
     * Read the session's module state, whole or at a dotted path — see
     * [NativeEngine.getStateAt]. Reads are gated to the declared surface;
     * an unknown module and an absent path are both `null`.
     */
    fun getState(module: String? = null, path: String? = null): JsonElement? {
        ensureAlive()
        return client.engine.getStateAt(module, path)
    }

    /**
     * The session's wire revision — the number stamped on the last `patch`
     * message the user received. Starts at 0 after the handshake.
     */
    fun revision(): Long {
        ensureAlive()
        return client.revision
    }

    /**
     * The MCP manifest the engine composes for this app — see
     * [NativeEngine.mcpManifest].
     */
    fun manifest(): String {
        ensureAlive()
        return client.engine.mcpManifest()
    }

    private fun ensureAlive() {
        if (!client.ready) throw AgentSessionGoneException(sessionId)
    }
}
