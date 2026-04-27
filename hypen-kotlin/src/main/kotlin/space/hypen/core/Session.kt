package space.hypen.core

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.Timer
import java.util.TimerTask

/**
 * Concurrent connection policy.
 */
enum class ConcurrentPolicy {
    /** New connection kicks the existing one. */
    KICK_OLD,
    /** Reject new connection if one already exists. */
    REJECT_NEW,
    /** Allow multiple connections to the same session. */
    ALLOW_MULTIPLE
}

/**
 * Session configuration.
 */
data class SessionConfig(
    /** Session TTL in seconds after disconnect (default: 1 hour). */
    val ttl: Long = 3600,
    /** How to handle concurrent connections to the same session. */
    val concurrent: ConcurrentPolicy = ConcurrentPolicy.KICK_OLD,
    /** Custom ID generator. Defaults to UUID. */
    val generateId: () -> String = { UUID.randomUUID().toString() }
) {
    init {
        require(ttl > 0) { "Session TTL must be positive, got $ttl" }
    }
}

/**
 * Active session data.
 */
data class Session(
    val id: String,
    val ttl: Long,
    val createdAt: Long = System.currentTimeMillis(),
    var lastConnectedAt: Long = System.currentTimeMillis(),
    val props: MutableMap<String, Any?> = mutableMapOf()
) {
    fun toSessionInfo(): SessionInfo = SessionInfo(
        id = id,
        createdAt = createdAt,
        lastConnectedAt = lastConnectedAt,
        props = props.toMap()
    )
}

/**
 * Pending (disconnected) session awaiting reconnect or expiry.
 */
data class PendingSession(
    val session: Session,
    val savedState: Map<String, Any?>,
    val expiryTimer: TimerTask
)

/**
 * Manages session lifecycle: create, suspend, resume, expire.
 *
 * ```kotlin
 * val manager = SessionManager(SessionConfig(ttl = 300))
 * val session = manager.createSession()
 * manager.suspendSession(session.id, savedState) { /* expired */ }
 * manager.resumeSession(session.id) // returns PendingSession or null
 * ```
 */
class SessionManager(val config: SessionConfig = SessionConfig()) {
    private val activeSessions = ConcurrentHashMap<String, Session>()
    private val pendingSessions = ConcurrentHashMap<String, PendingSession>()
    private val sessionConnections = ConcurrentHashMap<String, MutableSet<Any>>()
    private val timer = Timer("hypen-session-timer", true)
    private val log = HypenLoggers.session

    /**
     * Create a new active session.
     */
    fun createSession(props: Map<String, Any?> = emptyMap()): Session {
        val id = config.generateId()
        val session = Session(
            id = id,
            ttl = config.ttl,
            props = props.toMutableMap()
        )
        activeSessions[id] = session
        log.debug("Created session $id")
        return session
    }

    /**
     * Get an active session by ID.
     */
    fun getActiveSession(id: String): Session? = activeSessions[id]

    /**
     * Get a pending (disconnected) session by ID.
     */
    fun getPendingSession(id: String): PendingSession? = pendingSessions[id]

    /**
     * Suspend a session (on disconnect). Moves it to pending with a TTL timer.
     */
    fun suspendSession(
        sessionId: String,
        savedState: Map<String, Any?>,
        onExpire: () -> Unit
    ) {
        val session = activeSessions.remove(sessionId) ?: return

        val task = object : TimerTask() {
            override fun run() {
                val pending = pendingSessions.remove(sessionId)
                if (pending != null) {
                    log.info("Session $sessionId expired after ${config.ttl}s TTL")
                    onExpire()
                }
            }
        }

        pendingSessions[sessionId] = PendingSession(session, savedState, task)
        timer.schedule(task, config.ttl * 1000)
        log.debug("Suspended session $sessionId with ${config.ttl}s TTL")
    }

    /**
     * Resume a pending session (on reconnect). Returns the PendingSession if found.
     */
    fun resumeSession(sessionId: String): PendingSession? {
        val pending = pendingSessions.remove(sessionId) ?: return null
        pending.expiryTimer.cancel()

        val session = pending.session
        session.lastConnectedAt = System.currentTimeMillis()
        activeSessions[sessionId] = session

        log.debug("Resumed session $sessionId")
        return pending
    }

    /**
     * Destroy a session completely (active or pending).
     */
    fun destroySession(sessionId: String) {
        activeSessions.remove(sessionId)
        pendingSessions.remove(sessionId)?.expiryTimer?.cancel()
        sessionConnections.remove(sessionId)
        log.debug("Destroyed session $sessionId")
    }

    /**
     * Track a WebSocket connection for a session.
     */
    fun trackConnection(sessionId: String, connection: Any) {
        sessionConnections.getOrPut(sessionId) {
            ConcurrentHashMap.newKeySet()
        }.add(connection)
    }

    /**
     * Untrack a WebSocket connection.
     */
    fun untrackConnection(sessionId: String, connection: Any) {
        sessionConnections[sessionId]?.remove(connection)
    }

    /**
     * Get the number of active connections for a session.
     */
    fun getConnectionCount(sessionId: String): Int {
        return sessionConnections[sessionId]?.size ?: 0
    }

    /**
     * Get session statistics.
     */
    fun getStats(): SessionStats {
        return SessionStats(
            activeSessions = activeSessions.size,
            pendingSessions = pendingSessions.size,
            totalConnections = sessionConnections.values.sumOf { it.size }
        )
    }

    /**
     * Shut down the session manager, cancelling all timers.
     */
    fun shutdown() {
        timer.cancel()
        pendingSessions.values.forEach { it.expiryTimer.cancel() }
        pendingSessions.clear()
        activeSessions.clear()
        sessionConnections.clear()
    }
}

data class SessionStats(
    val activeSessions: Int,
    val pendingSessions: Int,
    val totalConnections: Int
)
