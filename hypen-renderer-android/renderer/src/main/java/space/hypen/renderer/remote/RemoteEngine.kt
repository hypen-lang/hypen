package space.hypen.renderer.remote

import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.device.DeviceConnection
import space.hypen.renderer.device.DeviceHost
import space.hypen.renderer.device.DeviceTransport
import space.hypen.renderer.device.normalizeOrigin
import space.hypen.renderer.model.*
import kotlinx.coroutines.*

import kotlinx.coroutines.flow.*
import okhttp3.*
import okio.ByteString
import okio.ByteString.Companion.toByteString
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
    /**
     * Resume credential for [id], as previously reported by
     * [SessionInfo.resumeToken] (RFC 001 §5: distinct from the public session
     * id). Sent as `hello.resumeToken` only when resuming. A secret: store it
     * like one; it is omitted from [toString] and never logged.
     */
    val resumeToken: String? = null,
) {
    override fun toString(): String =
        "SessionOptions(id=$id, props=$props, resumeToken=${if (resumeToken != null) "<redacted>" else "null"})"
}

/**
 * Session information received from server.
 */
data class SessionInfo(
    val sessionId: String,
    val isNew: Boolean,
    val isRestored: Boolean,
    /**
     * Resume credential issued by device-enabled servers (RFC 001 §5),
     * rotated on every acknowledged connection. Persist it next to
     * [sessionId] and pass it back as [SessionOptions.resumeToken] to resume
     * after a restart; without it such a server starts a new session. A
     * secret: omitted from [toString], never logged.
     */
    val resumeToken: String? = null,
) {
    override fun toString(): String =
        "SessionInfo(sessionId=$sessionId, isNew=$isNew, isRestored=$isRestored, " +
            "resumeToken=${if (resumeToken != null) "<redacted>" else "null"})"
}

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
 *
 * ## Device Capability Protocol (RFC 001)
 *
 * Pass a [DeviceHost] (see `AndroidDeviceHost.create`) to enable the device
 * plane: `hello` carries its advertisement, `sessionAck.device` selects the
 * revisions, `deviceRequest`/`deviceEvent` JSON and binary frames are routed
 * to a per-socket [DeviceConnection], and that connection is torn down when
 * the socket closes (no device operation ever survives a reconnect). The
 * engine does not own the host (it is application-scoped; see
 * `AndroidDeviceHost.create`).
 *
 * Device traffic is routed from OkHttp's reader thread straight into the
 * connection's bounded inbox (JSON, malformed JSON, the `sessionAck.device`
 * selection and binary frames share one FIFO, so their order is preserved),
 * never through an unbounded coroutine queue. A server → client binary frame
 * whose header names a live download operation (`file.save`) reaches the
 * DeviceHost whole — at most 64 KiB + 12, and only within the credit window
 * the host granted; every other frame is copied only up to its 12-byte
 * header (RFC 001 §2.3 / §5).
 *
 * ## Resume credential (RFC 001 §5)
 *
 * The latest `sessionAck.resumeToken` is kept in memory and sent as
 * `hello.resumeToken` whenever a hello resumes that session id (reconnects
 * included); it is reported through [SessionInfo.resumeToken] for
 * persistence, cleared on `sessionExpired`, and never logged.
 *
 * ## Admission (RFC 001 §5, decision D1)
 *
 * Device-enabled servers refuse native upgrades that carry no `Origin`
 * unless their authenticator accepts them: pass app credentials with
 * [RemoteEngineConfig.headers] / [RemoteEngineConfig.headersProvider]
 * (e.g. `Authorization`). No `Origin` is sent unless
 * [RemoteEngineConfig.origin] is set.
 *
 * ## Compression and the device plane
 *
 * Device data may only be compressed one message at a time, so it never
 * shares a compression history with other messages. OkHttp always offers
 * `permessage-deflate`; the device plane is enabled on the socket when the
 * server declined it, or when the negotiated extension carries BOTH
 * `server_no_context_takeover` and `client_no_context_takeover` (what the
 * Hypen servers negotiate; OkHttp honours both). With context takeover in
 * either direction the hello omits `device`, the app runs UI-only on that
 * socket, and one warning is logged.
 */
class RemoteEngine(
    private val url: String,
    private val config: RemoteEngineConfig = RemoteEngineConfig.DEFAULT,
    private val sessionOptions: SessionOptions? = null,
    private val messageParser: MessageParser = MoshiMessageParser(),
    private val deviceHost: DeviceHost? = null,
) {
    private var webSocket: WebSocket? = null
    private var okHttpClient: OkHttpClient? = null
    private var reconnectJob: Job? = null
    private val reconnectAttempts = AtomicInteger(0)
    // A failure while handling one message is logged, never rethrown into
    // the uncaught-exception handler (which would crash the app): the next
    // message is handled as usual.
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, t -> log.error("Remote engine task failed", t) },
    )

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
    @Volatile
    private var currentSessionId: String? = sessionOptions?.id

    // Resume credential for currentSessionId (RFC 001 §5). Never logged.
    @Volatile
    private var resumeToken: String? = sessionOptions?.resumeToken?.takeIf { sessionOptions?.id != null && it.isNotEmpty() }

    // The device plane of the current socket (null: none / UI-only).
    @Volatile
    private var currentDevice: DeviceConnection? = null

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

        currentDevice?.close()
        currentDevice = null
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

        // App credentials for the upgrade (RFC 001 §5, decision D1): a
        // device-enabled server admits a native client (no Origin) only when
        // its authenticator accepts them. Values are never logged.
        val builder = Request.Builder().url(url)
        config.upgradeHeaders().forEach { (name, value) -> builder.header(name, value) }
        val request = builder.build()

        webSocket = okHttpClient?.newWebSocket(request, createWebSocketListener())
    }

    /**
     * Send hello message to establish session. [advertisement] is the device
     * connection's snapshotted `hello.device` (the ack is validated against
     * exactly it), or null for a UI-only hello.
     */
    private fun sendHello(socket: WebSocket, advertisement: Map<String, Any?>?) {
        val sessionId = currentSessionId ?: sessionOptions?.id
        val hello = HelloMessage(
            sessionId = sessionId,
            props = sessionOptions?.props,
            device = advertisement,
            // Only when resuming the session the token was issued for.
            resumeToken = if (sessionId != null) resumeToken else null,
        )
        val json = messageParser.serializeMessage(hello)
        log.debug("Sending hello message")
        socket.send(json)
    }

    /**
     * Open the device plane for a freshly opened socket, or null when there is
     * no host, the host was disposed, or the server negotiated permessage-deflate
     * with context takeover in either direction ([PerMessageDeflate]). The connection is bound to this engine's server origin
     * (normalized from [url]): prompts name it, and grants and cooldowns are
     * keyed on it, whatever origin the host was created with.
     */
    private fun openDevice(socket: WebSocket, response: Response): DeviceConnection? {
        val host = deviceHost ?: return null
        if (!PerMessageDeflate.allowsDevice(response.headers("Sec-WebSocket-Extensions"))) {
            log.warn(
                "Server negotiated permessage-deflate with context takeover; device plane disabled on this socket " +
                    "(needs server_no_context_takeover and client_no_context_takeover)",
            )
            return null
        }
        val connection = host.openConnection(OkHttpDeviceTransport(socket, messageParser), normalizeOrigin(url))
        if (connection == null) log.warn("DeviceHost is disposed; this socket runs UI-only")
        return connection
    }

    /**
     * The current socket's device plane has an operation whose OS UI (system
     * picker, permission dialog) is up. `HypenApp` keeps a recreated
     * Activity's engine alive while this is true, so the result can still be
     * delivered.
     */
    fun hasPresentingDeviceWork(): Boolean = currentDevice?.hasPresentingOperation == true

    private fun createWebSocketListener(): WebSocketListener =
        object : WebSocketListener() {
            // This socket's device plane. Captured per listener so a late
            // callback from an old socket can never reach a newer one (§2.5).
            // (OkHttp's reader thread; the deferred hello reads it from the scope.)
            @Volatile
            private var device: DeviceConnection? = null

            private fun closeDevice() {
                device?.let {
                    it.close()
                    if (currentDevice === it) currentDevice = null
                }
                device = null
            }

            override fun onOpen(
                webSocket: WebSocket,
                response: Response,
            ) {
                log.debug("WebSocket connected")
                _connectionState.value = ConnectionState.CONNECTED
                reconnectAttempts.set(0)

                val opened = openDevice(webSocket, response)
                device = opened
                currentDevice = opened
                val host = deviceHost
                if (opened != null && host != null && host.helloAwaitsIndicator()) {
                    // The indicator overlay is still attaching: a hello sent now
                    // would lack mic.record / bluetooth.scan for the whole
                    // connection (the handshake is immutable, sessionAck.device
                    // is the ceiling). Wait for the overlay's readiness event
                    // (or the app leaving the foreground) — bounded, for an app
                    // that never shows the overlay; the server sends nothing
                    // before our hello.
                    scope.launch {
                        withTimeoutOrNull(DEVICE_HELLO_INDICATOR_WAIT_MS) { host.awaitIndicatorForHello() }
                        // Closed (or replaced) meanwhile: no hello on a dead socket.
                        if (device === opened && !opened.isClosed) helloWithDevice(webSocket)
                    }
                } else {
                    helloWithDevice(webSocket)
                }
            }

            /** Snapshot the advertisement this hello carries (no valid one: UI-only) and send it. */
            private fun helloWithDevice(webSocket: WebSocket) {
                val advertisement = device?.helloAdvertisement()
                if (advertisement == null) {
                    if (currentDevice === device) currentDevice = null
                    device = null
                }
                sendHello(webSocket, advertisement)
            }

            override fun onMessage(
                webSocket: WebSocket,
                text: String,
            ) {
                handleMessage(text, device)
            }

            override fun onMessage(
                webSocket: WebSocket,
                bytes: ByteString,
            ) {
                // Binary frames exist only on the device plane (RFC 001 §2.3).
                // Dropped here, before any copy, without a device plane; with
                // one, a frame for a live download (file.save) is copied whole
                // and any other only up to its header (see
                // DeviceConnection.handleFrame). Same inbox as device JSON, so
                // ordering is preserved.
                val target = device ?: return
                target.handleFrame(bytes.size) { start, end -> bytes.substring(start, end).toByteArray() }
            }

            override fun onClosing(
                webSocket: WebSocket,
                code: Int,
                reason: String,
            ) {
                log.debug { "WebSocket closing: $code - $reason" }
                closeDevice()
            }

            override fun onClosed(
                webSocket: WebSocket,
                code: Int,
                reason: String,
            ) {
                log.debug { "WebSocket closed: $code - $reason" }
                closeDevice()
                _connectionState.value = ConnectionState.DISCONNECTED
                maybeScheduleReconnect()
            }

            override fun onFailure(
                webSocket: WebSocket,
                t: Throwable,
                response: Response?,
            ) {
                log.error("WebSocket failure", t)
                closeDevice()
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

    /**
     * One text frame from OkHttp's reader thread. Nothing here may throw: an
     * exception escaping a [WebSocketListener] callback fails the socket
     * (`onFailure`), which would end every later UI update because of one bad
     * message. A message that cannot be parsed or handled is logged and
     * dropped; device traffic only ever reaches the device plane's inbox.
     */
    private fun handleMessage(text: String, device: DeviceConnection? = null) {
        val message = try {
            messageParser.parseMessage(text)
        } catch (e: Exception) {
            log.error("Failed to parse message", e)
            null
        }
        if (message == null) {
            log.warn("Failed to parse message")
            return
        }

        // Device plane only, never the patch/state path: straight into this
        // socket's bounded, ordered inbox (without a DeviceConnection the
        // message is dropped).
        try {
            when (message) {
                is DeviceWireMessage -> {
                    device?.handleMessage(message.body, message.sizeBytes)
                    return
                }
                is DeviceMalformedMessage -> {
                    device?.handleMalformed(message.type, message.detail, message.sizeBytes)
                    return
                }
                // Device selection before any later device traffic (RFC 001 §2.2).
                is SessionAckMessage -> device?.onAck(message.device, message.deviceMalformed)
                else -> Unit
            }
        } catch (e: Exception) {
            // The device plane must never take the UI path down with it.
            log.error("Device plane rejected a ${message.type} message", e)
            if (message is DeviceWireMessage || message is DeviceMalformedMessage) return
        }

        scope.launch(messageDispatcher) {
            try {
                when (message) {
                    is SessionAckMessage -> handleSessionAck(message)
                    is DeviceWireMessage, is DeviceMalformedMessage -> Unit
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
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log.error("Failed to handle ${message.type} message", e)
            }
        }
    }

    private suspend fun handleSessionAck(message: SessionAckMessage) {
        log.debug("Session established: id=${message.sessionId}, isNew=${message.isNew}, isRestored=${message.isRestored}")
        currentSessionId = message.sessionId
        // The latest credential replaces the previous one; a server without
        // the device plane sends none (legacy id-only resume).
        resumeToken = message.resumeToken

        val info = SessionInfo(
            sessionId = message.sessionId,
            isNew = message.isNew,
            isRestored = message.isRestored,
            resumeToken = message.resumeToken,
        )
        _sessionEstablished.emit(info)
    }

    private suspend fun handleSessionExpired(message: SessionExpiredMessage) {
        log.debug("Session expired: id=${message.sessionId}, reason=${message.reason}")
        currentSessionId = null
        resumeToken = null
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

        /** Longest wait for the indicator overlay before a device hello goes out without what it gates. */
        internal const val DEVICE_HELLO_INDICATOR_WAIT_MS = 2_000L
    }
}

/** [DeviceTransport] over an OkHttp [WebSocket]; OkHttp's send queue is thread-safe. */
internal class OkHttpDeviceTransport(
    private val socket: WebSocket,
    private val parser: MessageParser,
) : DeviceTransport {
    override fun sendMessage(message: Map<String, Any?>) {
        socket.send(parser.serializeMessage(DeviceWireMessage(message["type"] as? String ?: "", message)))
    }

    override fun sendBinary(frame: ByteArray) {
        socket.send(frame.toByteString())
    }

    override fun pendingBytes(): Long = socket.queueSize()

    override fun close(code: Int, reason: String) {
        socket.close(code, reason)
    }
}
