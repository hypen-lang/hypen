package space.hypen.renderer.remote

import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.model.*
import kotlinx.coroutines.*

import kotlinx.coroutines.flow.*
import okhttp3.*
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Session configuration for the client.
 */
private val log = HypenLoggers.remote

data class SessionOptions(
    /** Session ID to resume (null for new session) */
    val id: String? = null,
    /** Client metadata (platform, version, userId, etc.) */
    val props: Map<String, Any?>? = null,
)

/**
 * Session information received from server.
 */
data class SessionInfo(
    val sessionId: String,
    val isNew: Boolean,
    val isRestored: Boolean,
)

/**
 * Client-side engine that connects to a remote Hypen app over WebSocket.
 * Handles connection management, message parsing, session management, and action dispatch.
 *
 * Usage:
 * ```kotlin
 * val engine = RemoteEngine(
 *     url = "ws://10.0.2.2:3000",
 *     sessionOptions = SessionOptions(
 *         id = preferences.getString("sessionId", null),
 *         props = mapOf("platform" to "android")
 *     )
 * )
 *
 * lifecycleScope.launch {
 *     engine.sessionEstablished.collect { info ->
 *         preferences.edit().putString("sessionId", info.sessionId).apply()
 *     }
 * }
 *
 * engine.connect()
 * ```
 */
class RemoteEngine(
    private val url: String,
    private val config: RemoteEngineConfig = RemoteEngineConfig.DEFAULT,
    private val sessionOptions: SessionOptions? = null,
    private val messageParser: MessageParser = MoshiMessageParser(),
) {
    private var webSocket: WebSocket? = null
    private var okHttpClient: OkHttpClient? = null
    private var reconnectJob: Job? = null
    private val reconnectAttempts = AtomicInteger(0)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Connection state
    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    // Patches flow — buffer ensures no patch batches are dropped when the server
    // sends multiple batches rapidly (e.g., during state changes that trigger
    // multiple render passes). Without buffer, emissions suspend and can be
    // reordered or lost depending on collector timing.
    private val _patches = MutableSharedFlow<List<Patch>>(replay = 0, extraBufferCapacity = 64)
    val patches: SharedFlow<List<Patch>> = _patches.asSharedFlow()

    // State flow
    private val _state = MutableStateFlow<Map<String, Any?>?>(null)
    val state: StateFlow<Map<String, Any?>?> = _state.asStateFlow()

    // Errors flow
    private val _errors = MutableSharedFlow<Throwable>(replay = 0)
    val errors: SharedFlow<Throwable> = _errors.asSharedFlow()

    // Session flows
    private val _sessionEstablished = MutableSharedFlow<SessionInfo>(replay = 1)
    val sessionEstablished: SharedFlow<SessionInfo> = _sessionEstablished.asSharedFlow()

    private val _sessionExpired = MutableSharedFlow<String>(replay = 0)
    val sessionExpired: SharedFlow<String> = _sessionExpired.asSharedFlow()

    // Internal state
    private var currentRevision = 0
    private var moduleName: String = ""
    private var currentSessionId: String? = sessionOptions?.id

    /**
     * Connect to the remote server.
     */
    suspend fun connect() {
        if (_connectionState.value == ConnectionState.CONNECTED ||
            _connectionState.value == ConnectionState.CONNECTING
        ) {
            log.debug("Already connected or connecting")
            return
        }

        _connectionState.value = ConnectionState.CONNECTING
        reconnectAttempts.set(0)

        try {
            establishConnection()
        } catch (e: Exception) {
            log.error("Connection failed", e)
            _connectionState.value = ConnectionState.ERROR
            _errors.emit(e)
            maybeScheduleReconnect()
        }
    }

    /**
     * Disconnect from the remote server.
     */
    fun disconnect() {
        log.debug("Disconnecting")
        reconnectJob?.cancel()
        reconnectJob = null

        webSocket?.close(NORMAL_CLOSURE_STATUS, "Client disconnect")
        webSocket = null

        okHttpClient?.dispatcher?.executorService?.let { executor ->
            executor.shutdown()
            try {
                if (!executor.awaitTermination(3, TimeUnit.SECONDS)) {
                    executor.shutdownNow()
                }
            } catch (e: InterruptedException) {
                executor.shutdownNow()
                Thread.currentThread().interrupt()
            }
        }
        okHttpClient = null

        _connectionState.value = ConnectionState.DISCONNECTED
    }

    /**
     * Dispatch an action to the remote server.
     */
    fun dispatchAction(
        action: String,
        payload: Map<String, Any?>? = null,
    ) {
        if (_connectionState.value != ConnectionState.CONNECTED) {
            log.warn("Cannot dispatch action: not connected")
            return
        }

        val message =
            DispatchActionMessage(
                module = moduleName,
                action = action,
                payload = payload,
            )

        val json = messageParser.serializeMessage(message)
        log.debug("Dispatching action: $action")
        webSocket?.send(json)
    }

    /**
     * Get the current revision number.
     */
    fun getRevision(): Int = currentRevision

    /**
     * Get the current module name.
     */
    fun getModuleName(): String = moduleName

    /**
     * Get the current session ID.
     */
    fun getSessionId(): String? = currentSessionId

    /**
     * Read timeout to actually use, guarding a host that configures one at or
     * below the ping interval — that races the keepalive and drops healthy
     * idle sockets. Ping/pong already proves liveness, so we widen rather
     * than honour a value that can only cause false disconnects.
     */
    private fun effectiveReadTimeoutMs(): Long {
        val configured = config.readTimeoutMs
        val ping = config.pingIntervalMs
        if (configured > 0 && ping > 0 && configured <= ping) {
            log.warn(
                "readTimeout (${configured}ms) <= pingInterval (${ping}ms) races the keepalive; " +
                    "disabling the read deadline and letting ping/pong detect a dead peer",
            )
            return 0
        }
        return configured
    }

    private fun establishConnection() {
        log.debug { "establishConnection state=${_connectionState.value}" }
        okHttpClient =
            OkHttpClient
                .Builder()
                .connectTimeout(config.connectTimeoutMs, TimeUnit.MILLISECONDS)
                // A read deadline at or below the ping interval races the
                // keepalive it depends on and kills healthy idle sockets;
                // see RemoteEngineConfig.readTimeoutMs.
                .readTimeout(effectiveReadTimeoutMs(), TimeUnit.MILLISECONDS)
                .writeTimeout(config.writeTimeoutMs, TimeUnit.MILLISECONDS)
                .pingInterval(config.pingIntervalMs, TimeUnit.MILLISECONDS)
                // No compression setup here on purpose. OkHttp always offers
                // `permessage-deflate` on the upgrade and inflates whatever the
                // server sends, so the patch stream — the direction that matters —
                // is compressed with nothing to configure. `minWebSocketMessageToCompress`
                // is left at its 1024-byte default: it only gates the *outbound*
                // direction, and our outbound traffic is small hello/action JSON that
                // deflate would grow rather than shrink. See RemoteEngineConfig.
                .build()

        val request =
            Request
                .Builder()
                .url(url)
                .build()

        webSocket = okHttpClient?.newWebSocket(request, createWebSocketListener())
    }

    /**
     * Send hello message to establish session.
     */
    private fun sendHello() {
        val hello = HelloMessage(
            sessionId = currentSessionId ?: sessionOptions?.id,
            props = sessionOptions?.props,
        )
        val json = messageParser.serializeMessage(hello)
        log.debug("Sending hello message")
        webSocket?.send(json)
    }

    private fun createWebSocketListener(): WebSocketListener =
        object : WebSocketListener() {
            override fun onOpen(
                webSocket: WebSocket,
                response: Response,
            ) {
                log.debug("WebSocket connected")
                _connectionState.value = ConnectionState.CONNECTED
                reconnectAttempts.set(0)

                // Send hello message to establish session
                sendHello()
            }

            override fun onMessage(
                webSocket: WebSocket,
                text: String,
            ) {
                handleMessage(text)
            }

            override fun onClosing(
                webSocket: WebSocket,
                code: Int,
                reason: String,
            ) {
                log.debug { "WebSocket closing: $code - $reason" }
            }

            override fun onClosed(
                webSocket: WebSocket,
                code: Int,
                reason: String,
            ) {
                log.debug { "WebSocket closed: $code - $reason" }
                _connectionState.value = ConnectionState.DISCONNECTED
                maybeScheduleReconnect()
            }

            override fun onFailure(
                webSocket: WebSocket,
                t: Throwable,
                response: Response?,
            ) {
                log.error("WebSocket failure", t)
                _connectionState.value = ConnectionState.ERROR
                scope.launch {
                    _errors.emit(t)
                }
                maybeScheduleReconnect()
            }
        }

    // Serial dispatcher ensures WebSocket messages are processed in order.
    // Without this, scope.launch on Dispatchers.IO can reorder messages
    // because the thread pool schedules coroutines concurrently.
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val messageDispatcher = Dispatchers.IO.limitedParallelism(1)

    private fun handleMessage(text: String) {
        val message = messageParser.parseMessage(text)
        if (message == null) {
            log.warn("Failed to parse message")
            return
        }

        scope.launch(messageDispatcher) {
            when (message) {
                is SessionAckMessage -> handleSessionAck(message)
                is SessionExpiredMessage -> handleSessionExpired(message)
                is InitialTreeMessage -> handleInitialTree(message)
                is PatchMessage -> handlePatch(message)
                is StateUpdateMessage -> handleStateUpdate(message)
                is DispatchActionMessage -> {
                    log.warn("Unexpected dispatchAction message from server")
                }
                is HelloMessage -> {
                    log.warn("Unexpected hello message from server")
                }
            }
        }
    }

    private suspend fun handleSessionAck(message: SessionAckMessage) {
        log.debug("Session established: id=${message.sessionId}, isNew=${message.isNew}, isRestored=${message.isRestored}")
        currentSessionId = message.sessionId

        val info = SessionInfo(
            sessionId = message.sessionId,
            isNew = message.isNew,
            isRestored = message.isRestored,
        )
        _sessionEstablished.emit(info)
    }

    private suspend fun handleSessionExpired(message: SessionExpiredMessage) {
        log.debug("Session expired: id=${message.sessionId}, reason=${message.reason}")
        currentSessionId = null
        _sessionExpired.emit(message.reason)
    }

    private suspend fun handleInitialTree(message: InitialTreeMessage) {
        log.debug { "initialTree: rev=${message.revision}, ${message.patches.size} patches" }
        moduleName = message.module
        currentRevision = message.revision
        _state.value = message.state

        if (message.patches.isNotEmpty()) {
            _patches.emit(message.patches)
        }
    }

    private suspend fun handlePatch(message: PatchMessage) {
        log.debug { "patch: rev=${message.revision}, ${message.patches.size} patches (currentRev=$currentRevision)" }

        // Check revision ordering
        if (message.revision <= currentRevision) {
            log.warn { "Dropped patch rev=${message.revision} (currentRev=$currentRevision)" }
            return
        }

        currentRevision = message.revision

        if (message.patches.isNotEmpty()) {
            _patches.emit(message.patches)
        }
    }

    private fun handleStateUpdate(message: StateUpdateMessage) {
        log.debug("Received state update")
        _state.value = message.state
    }

    private fun maybeScheduleReconnect() {
        if (!config.autoReconnect) {
            return
        }

        val attempts = reconnectAttempts.incrementAndGet()
        if (attempts > config.maxReconnectAttempts) {
            log.error("Max reconnection attempts reached ($attempts)")
            return
        }

        _connectionState.value = ConnectionState.RECONNECTING
        log.debug { "Scheduling reconnect attempt $attempts" }

        reconnectJob?.cancel()
        reconnectJob =
            scope.launch {
                delay(config.reconnectIntervalMs)
                try {
                    establishConnection()
                } catch (e: Exception) {
                    log.error("Reconnection failed", e)
                    _errors.emit(e)
                    maybeScheduleReconnect()
                }
            }
    }

    /**
     * Clean up resources.
     */
    fun destroy() {
        disconnect()
        scope.cancel()
    }

    companion object {
        private const val NORMAL_CLOSURE_STATUS = 1000
    }
}
