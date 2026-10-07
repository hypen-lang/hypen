package space.hypen.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import space.hypen.remote.device.DeviceErrorCode
import space.hypen.remote.device.DevicePlane
import space.hypen.remote.device.DevicePlaneSink
import uniffi.hypen_engine.DeviceBroker
import uniffi.hypen_engine.DeviceRetainedBytesPool
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Reserved cross-boundary payload key TypeScript renderers use to carry an
 * event applicator's `animate:` transaction-animation stamp (Option D)
 * through `dispatchAction`. A renderer→host directive, never handler data:
 * the Kotlin host strips it before module handlers run (Kotlin does not
 * implement transaction stamping yet).
 */
internal const val RESERVED_ANIMATE_KEY = "__hypenAnimate"

/**
 * Per-client data managed by HypenServer.
 */
class ClientState(
    val id: String,
    val engine: NativeEngine,
    var moduleInstance: ModuleInstance<*>,
    val scope: CoroutineScope,
    var sessionId: String,
    var revision: Long = 0,
    val connectedAt: Long = System.currentTimeMillis(),
    var currentRoute: String = "/",
    var sendMessage: (suspend (String) -> Unit)? = null,
    val nestedModules: MutableMap<String, NestedModuleInstance<*>> = mutableMapOf(),
    var globalContext: HypenGlobalContext? = null
) {
    val pendingPatches = mutableListOf<Patch>()
    val mutex = Mutex()

    /** The connection's device plane (RFC 001), when negotiated. */
    @Volatile
    var devicePlane: DevicePlane? = null

    internal val flushScheduled = AtomicBoolean(false)

    /**
     * Ids of the top-level nodes (inserted under `root`) the client holds,
     * in the order the delivered patches left them. A full re-render
     * (route-table navigation, hot reload on a legacy connection) removes
     * exactly these before sending the new tree as an ordinary `patch`.
     */
    internal val rootIds = LinkedHashSet<String>()

    /** Record what [patches] do to the client's top level (see [rootIds]). */
    internal fun trackRoots(patches: List<Patch>) = synchronized(rootIds) {
        for (p in patches) {
            val id = p.id ?: continue
            when (p.type) {
                PatchType.INSERT, PatchType.MOVE, PatchType.ATTACH ->
                    if (p.parentId == ROOT_ID) rootIds += id else rootIds -= id
                PatchType.REMOVE, PatchType.DETACH -> rootIds -= id
            }
        }
    }

    internal fun rootSnapshot(): List<String> = synchronized(rootIds) { rootIds.toList() }

    companion object {
        /** The implicit container every renderer inserts top-level nodes into. */
        const val ROOT_ID = "root"
    }

    /**
     * True from the moment the hello (via [HypenServer.openConnection]) or
     * the legacy [HypenServer.handleConnect] has finished the
     * handshake (session ack sent, initial tree rendered) until the
     * connection is torn down by [HypenServer.handleDisconnect], kicked by
     * a concurrent connection, or the server shuts down. An [AgentHandle]
     * is only handed out for — and only acts on — a ready client.
     */
    @Volatile
    var ready: Boolean = false

    suspend fun collectPatches(block: () -> Unit): List<Patch> {
        mutex.withLock {
            synchronized(pendingPatches) { pendingPatches.clear() }
            block()
            return synchronized(pendingPatches) {
                val result = pendingPatches.toList()
                pendingPatches.clear()
                result
            }
        }
    }
}

/**
 * Remote client reference passed to connection/disconnection callbacks.
 */
data class RemoteClient(
    val id: String,
    val sessionId: String,
    val connectedAt: Long
)

/**
 * Callback type for connection events.
 */
typealias ConnectionCallback = (RemoteClient) -> Unit

/**
 * Server-driven UI orchestrator with per-client engine isolation.
 *
 * Each WebSocket client gets its own `NativeEngine` + `ModuleInstance`.
 * Sessions are managed with TTL-based expiry and reconnection support.
 *
 * This class is transport-agnostic: it owns sessions, engines and module
 * lifecycles, but never the socket. Your application installs Ktor's
 * `WebSockets` plugin, admits the upgrade with [admit], and pumps frames
 * through [openConnection], [handleMessage], [handleBinary] and
 * [handleDisconnect]. (The legacy hello-less [handleConnect] still works;
 * its sessions have no device plane.) The Device Capability Protocol
 * (RFC 001) is on by default for clients whose hello offers it — tune it
 * with `configureDevice { }`, opt out with `disableDevice()`.
 *
 * ```kotlin
 * val server = HypenServer {
 *     module("Counter", counterModule)
 *     module("Profile", profileModule)
 *     route("/counter", "Counter")
 *     route("/profile", "Profile")
 *     session { ttl = 300 }
 *     allowedOrigins("https://app.example")          // admission (production)
 *     authenticate { req -> verify(req) }            // native clients
 * }
 *
 * // In Ktor:
 * fun Application.module() {
 *     install(WebSockets) {
 *         // see [compression]: permessage-deflate with no context
 *         // takeover in both directions (safe for device traffic)
 *         if (server.compression) {
 *             extensions { install(HypenDeflate) }  // example-server/.../HypenDeflate.kt
 *         }
 *     }
 *     routing {
 *         route("/ws") {
 *             // Refuse the upgrade (403) when server.admit(...) rejects it —
 *             // see example-server/src/main/kotlin/Sockets.kt.
 *             install(HypenAdmission)
 *             webSocket {
 *                 val key = this
 *                 server.openConnection(key, object : HypenTransport {
 *                     override suspend fun sendText(text: String) = send(Frame.Text(text))
 *                     override suspend fun sendBinary(bytes: ByteArray) = send(Frame.Binary(true, bytes))
 *                     override suspend fun close(code: Int, reason: String) = close(CloseReason(code.toShort(), reason))
 *                 })
 *                 try {
 *                     for (frame in incoming) when (frame) {
 *                         is Frame.Text -> server.handleMessage(key, frame.readText()) {}
 *                         is Frame.Binary -> server.handleBinary(key, frame.readBytes())
 *                         else -> {}
 *                     }
 *                 } finally {
 *                     server.handleDisconnect(key)
 *                 }
 *             }
 *         }
 *     }
 * }
 * ```
 */
class HypenServer(block: HypenServerBuilder.() -> Unit = {}) {
    private val modules = mutableMapOf<String, ModuleDefinition<*>>()
    private val routeDefinitions: List<RouteDefinition>
    private val clients = ConcurrentHashMap<Any, ClientState>()
    private val sessionManager: SessionManager
    private val events = TypedEventEmitter()
    private val log = HypenLoggers.server
    private var onConnectionCallback: ConnectionCallback? = null
    private var onDisconnectionCallback: ConnectionCallback? = null
    private var componentWatcher: ComponentWatcher? = null
    private val serverScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val resourceJsonList = mutableListOf<String>()
    /**
     * When true, each new session (hello via [openConnection], or the legacy
     * [handleConnect]) builds a per-session [ManagedRouter]
     * from the primary module's `.ui` template via
     * `uniffi.discoverRouters(...)` instead of relying on the host's
     * route table. Matches the TS / Go / Swift SDKs so Social-style
     * apps can ship without any routing ceremony in host code. Disable
     * via [HypenServerBuilder.disableAutoRouter].
     */
    private val autoRouterEnabled: Boolean
    /**
     * Per-client [ManagedRouter] instances built by the auto-wire path.
     * Held so `handleDisconnect` can `stop()` them and release their
     * `router.*` action-handler coroutine scopes on teardown.
     */
    private val managedRouters = ConcurrentHashMap<Any, ManagedRouter>()

    /** Hello-driven connections ([openConnection]), by connection key. */
    private val connections = ConcurrentHashMap<Any, Connection>()

    /**
     * Device Capability Protocol settings; `null` = this server negotiates no
     * device plane ([HypenServerBuilder.disableDevice]). On by default.
     */
    private val deviceConfig: DeviceServerConfig?

    /** Aggregate retained-bytes budget shared by this server's brokers. */
    private val devicePool: DeviceRetainedBytesPool?

    private val admission: UpgradeAdmission

    /**
     * Whether this server wants WebSocket permessage-deflate (RFC 7692)
     * compression on its transport: `compression` in the
     * [HypenServerBuilder] block, `true` by default — with or without the
     * device plane.
     *
     * Device traffic may only be compressed **one message at a time**: the
     * negotiated extension must carry both `server_no_context_takeover` and
     * `client_no_context_takeover`, so device data never shares a
     * compression history with other messages. Clients enforce this (a
     * client keeps a context-takeover socket UI-only), and so does
     * [openConnection] when the route reports what it negotiated.
     *
     * **Advisory, not enforced.** [HypenServer] is transport-agnostic — it
     * only exposes [openConnection] / [handleMessage] / [handleBinary] /
     * [handleDisconnect] and never installs Ktor's `WebSockets` plugin itself. Your Ktor
     * application owns that install, so it must read this flag when
     * wiring the socket up, and must negotiate no context takeover in both
     * directions. Ktor 3.1's server-side `WebSocketDeflateExtension` answers
     * only the no-context-takeover parameters the client offered (its
     * `clientNoContextTakeOver` / `serverNoContextTakeOver` settings apply
     * to Ktor as a client) — browsers and OkHttp offer none, so use a
     * wrapper that adds both, such as the example server's `HypenDeflate`:
     *
     * ```kotlin
     * install(WebSockets) {
     *     if (hypenServer.compression) {
     *         extensions { install(HypenDeflate) }
     *     }
     * }
     * ```
     *
     * See `example-server/src/main/kotlin/Sockets.kt` for the full wiring.
     */
    val compression: Boolean

    /** Default primitives are registered on every engine via engine.registerDefaultPrimitives(). */

    init {
        val builder = HypenServerBuilder().apply(block)
        modules.putAll(builder.modules)
        routeDefinitions = builder.routes.toList()
        sessionManager = SessionManager(builder.sessionConfig)
        onConnectionCallback = builder.onConnectionCallback
        onDisconnectionCallback = builder.onDisconnectionCallback
        resourceJsonList.addAll(builder.resourceJsonList)
        autoRouterEnabled = builder.autoRouterEnabled
        // The device plane is on by default; it never stops the server from
        // starting. Compression is independent of it: permessage-deflate
        // with no context takeover in both directions is allowed on device
        // connections (see [compression]).
        deviceConfig = if (builder.deviceDisabled) null else builder.deviceConfig
        compression = builder.compression
        devicePool = deviceConfig?.poolBytes?.let { DeviceRetainedBytesPool(it.toULong()) }
        admission = UpgradeAdmission(builder.allowedOrigins.toList(), builder.authenticator)
        if (builder.allowedOrigins.isEmpty() && builder.authenticator == null) {
            log.warn(
                "no allowedOrigins/authenticate configured — any client can connect; set them in production"
            )
        }

        // Register modules in HypenApp
        modules.forEach { (name, def) ->
            if (!HypenApp.has(name)) {
                HypenApp.register(name, def)
            }
        }

        // Start component watcher if configured
        if (builder.watchDir != null) {
            val watchConfig = builder.watchConfig ?: ComponentWatchConfig()
            componentWatcher = ComponentWatcher(
                baseDir = java.nio.file.Path.of(builder.watchDir!!),
                patterns = watchConfig.patterns,
                debounceMs = watchConfig.debounceMs,
                recursive = watchConfig.recursive,
                onChange = { changes ->
                    serverScope.launch { handleComponentChanges(changes) }
                }
            ).also { it.start() }
            log.info("Watching components in ${builder.watchDir}")
        }

        log.info("HypenServer initialized with ${modules.size} modules, ${routeDefinitions.size} routes")
        log.debug(
            "WebSocket permessage-deflate compression " +
                if (compression) "enabled (advisory — host must install permessage-deflate with no context takeover)"
                else "disabled"
        )
    }

    /**
     * Handle a new WebSocket client connection (legacy, hello-less path).
     * Creates a per-client engine + module instance right away; the
     * `sessionAck` (with a fresh `resumeToken`) is sent through
     * [sendMessage] and the `initialTree` returned for the caller to send.
     * It never negotiates the Device Capability Protocol — the session simply
     * has no device plane; use [openConnection] for that.
     *
     * [sessionId] resumes (or, under [ConcurrentPolicy.KICK_OLD], takes
     * over) a UI-only session by id, as it always did. A session that had a
     * negotiated device plane is never resumed or taken over by its public
     * id alone (RFC 001 §5): that needs the server-issued `resumeToken`,
     * which only the hello path ([openConnection] + [handleMessage])
     * verifies — here such an id starts a new session instead.
     *
     * @param connectionKey Unique key identifying this connection (e.g., WebSocket session)
     * @param sessionId Optional session ID for reconnection
     * @param props Optional session properties
     * @param sendMessage Function to send a message to this client
     * @return Initial render message to send to the client
     */
    suspend fun handleConnect(
        connectionKey: Any,
        sessionId: String? = null,
        props: Map<String, Any?> = emptyMap(),
        sendMessage: suspend (String) -> Unit
    ): String {
        val resumable = sessionId?.takeUnless { sessionManager.requiresResumeToken(it) }
        if (sessionId != null && resumable == null) {
            log.info("Legacy connect for device session $sessionId (no resume token on this path) — new session")
        }
        val r = establishSession(
            connectionKey,
            resumable,
            props,
            sendMessage,
            ackExtras = { session, b -> b.put("resumeToken", sessionManager.issueResumeToken(session.id)) },
        )
        return when (r) {
            is Established.Ready -> {
                r.client.ready = true
                r.initialTree
            }
            is Established.Rejected -> r.message
        }
    }

    private sealed class Established {
        class Ready(val client: ClientState, val initialTree: String) : Established()
        class Rejected(val message: String) : Established()
    }

    /**
     * Resolve the session (resume / concurrent policy / new), build the
     * client's engine, send `sessionAck` (with [ackExtras] members), run
     * [afterAck], then mount the modules, render and return the
     * `initialTree` text.
     *
     * [afterAck] runs BEFORE any module is constructed or activated: the
     * device plane attaches there (RFC 001 §2.2/§2.7), so the connection's
     * `core.capabilities` stream is open and every module instance — the
     * primary, nested ones, and the route module the auto-wired
     * [ManagedRouter] activates while mounting — is bound to the plane from
     * construction. Its `onCreated` / `onActivated` get a live device
     * context, never a dead one that a later attach cannot revive.
     */
    private suspend fun establishSession(
        connectionKey: Any,
        sessionId: String?,
        props: Map<String, Any?>,
        sendMessage: suspend (String) -> Unit,
        ackExtras: (Session, JsonObjectBuilder) -> Unit = { _, _ -> },
        afterAck: suspend (ClientState) -> Unit = {},
    ): Established {
        // Try to resume existing session
        var isRestored = false
        var savedState: Map<String, Any?>? = null
        val session: Session

        if (sessionId != null) {
            val pending = sessionManager.resumeSession(sessionId)
            if (pending != null) {
                session = pending.session
                savedState = pending.savedState
                isRestored = true
                log.info("Resumed session ${session.id}")
            } else {
                // Check if active session exists (concurrent connection)
                val active = sessionManager.getActiveSession(sessionId)
                if (active != null) {
                    session = when (sessionManager.config.concurrent) {
                        ConcurrentPolicy.REJECT_NEW -> {
                            val msg = buildSessionExpiredMessage(sessionId, "kicked")
                            sendMessage(msg)
                            return Established.Rejected(msg)
                        }
                        ConcurrentPolicy.KICK_OLD -> {
                            // Kick old connection
                            kickSession(sessionId)
                            active.also { it.lastConnectedAt = System.currentTimeMillis() }
                        }
                        ConcurrentPolicy.ALLOW_MULTIPLE -> active
                    }
                } else {
                    session = sessionManager.createSession(props)
                }
            }
        } else {
            session = sessionManager.createSession(props)
        }

        sessionManager.trackConnection(session.id, connectionKey)

        // Create per-client engine
        val engine = NativeEngine()
        engine.registerDefaultPrimitives()

        // Register discovered components on the new engine
        componentWatcher?.getComponents()?.values?.forEach { comp ->
            try {
                engine.registerComponent(comp.name, comp.template, comp.hypenPath)
            } catch (e: Exception) {
                log.warn("Failed to register component '${comp.name}' for new client", e.message ?: "")
            }
        }

        // Register resources (flat name → SVG string map). The engine owns
        // SVG parsing; each raw string is parsed once per client engine and
        // resolved into `__iconPaths` patches at render time.
        for (resJson in resourceJsonList) {
            engine.registerResources(resJson)
        }

        val clientScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

        // Create the client state
        val clientState = ClientState(
            id = session.id,
            engine = engine,
            moduleInstance = createDummyModuleInstance(engine), // placeholder, replaced by mountRoute
            scope = clientScope,
            sessionId = session.id
        )

        // Set render callback. Patches produced outside a dispatch (e.g. a
        // suspend handler mutating state after awaiting device work) are
        // flushed as their own `patch` message once the client is ready.
        engine.setRenderCallback { patches ->
            synchronized(clientState.pendingPatches) { clientState.pendingPatches.addAll(patches) }
            if (clientState.ready) scheduleFlush(clientState)
        }

        clientState.sendMessage = sendMessage
        clients[connectionKey] = clientState

        // Session ack first: the device plane (afterAck) may send device
        // messages, which must follow `sessionAck.device` on the wire.
        val ackMessage = buildJsonObject {
            put("type", "sessionAck")
            put("sessionId", session.id)
            put("isNew", !isRestored)
            put("isRestored", isRestored)
            ackExtras(session, this)
        }
        sendMessage(ackMessage.toString())

        // The device plane attaches here, before any module exists (see above).
        afterAck(clientState)

        // Mount initial route. Prefer the auto-wire path when enabled:
        // it inspects the primary module's `.ui` for `Router { Route ... }`
        // blocks and attaches a per-session [ManagedRouter] so host code
        // can ship the Router DSL without repeating the route table via
        // `route(...)` calls. Falls back to the legacy route-per-client
        // mounting when auto-wire isn't applicable (no primary ui, no
        // Router block, disabled, etc.).
        val initialRoute = routeDefinitions.firstOrNull()?.path ?: "/"
        val autoWired = autoRouterEnabled && autoWireRouterForClient(connectionKey, initialRoute)
        if (!autoWired) {
            mountRouteForClient(connectionKey, initialRoute)
        }

        // Resumed within the TTL (network reconnect, hot-reload reconnect):
        // restore the state the session was suspended with — automatically,
        // or through the module's `onReconnect` when it defines one (TS
        // `triggerReconnect`) — before the initial tree is rendered.
        if (isRestored && savedState != null) {
            val client = clients[connectionKey]
            if (client != null) {
                @Suppress("UNCHECKED_CAST")
                (client.moduleInstance as? ModuleInstance<Any>)?.handleReconnect(
                    session.toSessionInfo(),
                    savedState
                )
                // Under the auto-wired router, a restored `location` moves the
                // router there (TS seeds its router from the restored
                // location), so the mounted route module matches the state.
                if (managedRouters[connectionKey] != null) {
                    val location = client.moduleInstance.getState()["location"] as? String
                    val router = client.globalContext?.getRouter()
                    if (!location.isNullOrEmpty() && router != null && router.getCurrentPath() != location) {
                        router.replace(location)
                    }
                }
            }
        }

        // Render initial tree
        val patches = renderFullTree(connectionKey)
        clientState.trackRoots(patches)

        // Same members as the TS server's `initialTree` (module, state,
        // patches, revision): the Android client (Moshi) and the native
        // desktop client (serde) refuse the whole message without them.
        val initialTreeMessage = buildJsonObject {
            put("type", "initialTree")
            put("module", wireModuleName)
            put("state", wireState(clientState))
            putJsonArray("patches") {
                patches.forEach { add(Json.encodeToJsonElement(it)) }
            }
            put("revision", clientState.revision)
            putJsonArray("routes") {
                routeDefinitions.forEach { add(it.path) }
            }
        }

        onConnectionCallback?.invoke(RemoteClient(session.id, session.id, clientState.connectedAt))
        events.emit(HypenEvents.moduleCreated, HypenEvents.ModuleCreated(session.id))

        return Established.Ready(clientState, initialTreeMessage.toString())
    }

    // ---- Hello-driven connections + Device Capability Protocol (RFC 001) ----

    /**
     * WebSocket upgrade admission (RFC 001 §5, decision D1). Call it with the
     * HTTP upgrade request BEFORE accepting the socket, and answer
     * [Admission.Rejected.status] (403) instead of upgrading when it refuses.
     * Each check applies exactly when it is configured:
     *
     * - `Origin` present + [HypenServerBuilder.allowedOrigins] configured →
     *   the Origin must be in the allowlist;
     * - `Origin` absent + an allowlist configured → admitted only by
     *   [HypenServerBuilder.authenticate] (no authenticator ⇒ 403, fail
     *   closed);
     * - a configured authenticator runs for every request (also WITH an
     *   allowed Origin).
     *
     * With neither allowlist nor authenticator every upgrade is admitted
     * (and the server logged a startup warning). Admission is independent of
     * the device plane.
     */
    suspend fun admit(request: UpgradeRequest): Admission = admission.admit(request)

    /**
     * Start a hello-driven connection on an admitted socket. Nothing is sent
     * until the client's explicit `hello` arrives through [handleMessage]
     * (while the device plane is on — the default — the socket is closed
     * 1008 after [DeviceServerConfig.helloTimeoutMs] without one; hello-less
     * legacy clients use [handleConnect]). The hello establishes or resumes
     * the session and the ack carries a rotating `resumeToken`; when the
     * hello offers `device` (and the server did not `disableDevice()`), it
     * also negotiates `hello.device` into `sessionAck.device` and attaches
     * the connection's device broker. A hello without `device` gets a
     * UI-only session.
     *
     * Every write to the client goes through one ordered queue over
     * [transport]; feed incoming text to [handleMessage], binary frames to
     * [handleBinary], and call [handleDisconnect] when the socket closes.
     *
     * [webSocketExtensions] is the `Sec-WebSocket-Extensions` value of this
     * socket's upgrade RESPONSE — what was negotiated (`""` for none). When
     * it carries permessage-deflate with context takeover in either
     * direction (missing `server_no_context_takeover` or
     * `client_no_context_takeover`), a hello offering `device` gets a
     * UI-only session and one warning is logged: device data must not share
     * a compression history with other messages. `null` (the default) means
     * the route does not report it and vouches that any compression it
     * negotiates has no context takeover in both directions.
     *
     * ```kotlin
     * webSocket("/ws") {
     *     val key = this
     *     server.openConnection(key, object : HypenTransport {
     *         override suspend fun sendText(text: String) = send(Frame.Text(text))
     *         override suspend fun sendBinary(bytes: ByteArray) = send(Frame.Binary(true, bytes))
     *         override suspend fun close(code: Int, reason: String) = close(CloseReason(code.toShort(), reason))
     *     }, webSocketExtensions = extensionOrNull(HypenDeflate)?.negotiated ?: "")
     *     try {
     *         for (frame in incoming) when (frame) {
     *             is Frame.Text -> server.handleMessage(key, frame.readText()) {}
     *             is Frame.Binary -> server.handleBinary(key, frame.readBytes())
     *             else -> {}
     *         }
     *     } finally { server.handleDisconnect(key) }
     * }
     * ```
     */
    fun openConnection(connectionKey: Any, transport: HypenTransport, webSocketExtensions: String? = null) {
        val conn = Connection(connectionKey)
        conn.compressionSharesContext = PerMessageDeflate.sharesContext(webSocketExtensions)
        conn.out = OutboundQueue(transport, serverScope) { what, e ->
            log.debug("Connection write failed ($what): ${e.message}")
        }
        connections[connectionKey] = conn
        val timeout = deviceConfig?.helloTimeoutMs
        if (timeout != null && timeout > 0) {
            conn.helloTimer = serverScope.launch {
                delay(timeout)
                if (!conn.helloReceived && connections[connectionKey] === conn) {
                    log.warn("No hello within $timeout ms — closing")
                    conn.out.close(1008, "hello timeout")
                }
            }
        }
    }

    /**
     * Feed one client → server binary frame (a device upload frame, RFC 001
     * §2.3). Dropped when the connection has no device plane.
     */
    fun handleBinary(connectionKey: Any, frame: ByteArray) {
        connections[connectionKey]?.plane?.receiveFrame(frame)
    }

    /**
     * Whether this server negotiates the Device Capability Protocol with
     * clients that offer it. `true` by default; `false` after
     * `disableDevice()`. Read-only status, not a switch. (A single
     * connection can still run UI-only — see [openConnection].)
     */
    val deviceEnabled: Boolean get() = deviceConfig != null

    /** The device plane of a connection opened with [openConnection], if negotiated. */
    fun devicePlane(connectionKey: Any): DevicePlane? = connections[connectionKey]?.plane

    /** The aggregate retained-bytes pool shared by this server's brokers, if any. */
    val deviceRetainedBytesPool: DeviceRetainedBytesPool? get() = devicePool

    private inner class Connection(val key: Any) {
        lateinit var out: OutboundQueue
        @Volatile var helloReceived = false
        var helloTimer: Job? = null
        /** permessage-deflate with context takeover negotiated on this socket (see [openConnection]). */
        var compressionSharesContext = false
        @Volatile var plane: DevicePlane? = null
        @Volatile var client: ClientState? = null
    }

    private suspend fun handleHello(conn: Connection, msg: JsonObject, text: String) {
        if (conn.helloReceived) {
            // The handshake is immutable per socket (RFC 001 §2.2).
            log.debug("Ignoring a second hello on one connection")
            return
        }
        conn.helloReceived = true
        conn.helloTimer?.cancel()

        val requested = (msg["sessionId"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
        val props = (msg["props"] as? JsonObject)?.mapValues { (_, v) -> v.toKotlinValue() } ?: emptyMap()
        val token = (msg["resumeToken"] as? JsonPrimitive)?.takeIf { it.isString }?.content

        // Device handshake selection (RFC 001 §2.2) is pure and computed
        // before any side effect. The member is strictly decoded from its
        // exact text (duplicate keys, number forms); invalid ⇒ disabled.
        var deviceAck: JsonElement? = null
        if (deviceEnabled && msg.containsKey("device") && conn.compressionSharesContext) {
            // Device data must not share a compression history with other
            // messages: only per-message compression (no context takeover
            // in both directions) is allowed on a device connection.
            log.warn(
                "hello.device on a socket that negotiated permessage-deflate with context takeover — " +
                    "device plane disabled for this connection (negotiate server_no_context_takeover and " +
                    "client_no_context_takeover)"
            )
        } else if (deviceEnabled && msg.containsKey("device")) {
            when (val m = TopLevelMember.find(text, "device")) {
                is TopLevelMember.Lookup.Found -> {
                    // Strict validation + selection in one engine call, with
                    // the reason when the plane ends up disabled.
                    val ack = try {
                        val hs = uniffi.hypen_engine.deviceHandshake(m.raw, true, null)
                        hs.reason?.let { log.warn("hello.device: $it — device plane disabled") }
                        hs.ackJson
                    } catch (e: Exception) {
                        log.warn("Device negotiation failed — device plane disabled: ${e.message}")
                        null
                    }
                    deviceAck = ack?.let { Json.parseToJsonElement(it) }
                }
                else -> log.warn("hello.device unreadable — device plane disabled")
            }
        }

        // Resume credential (RFC 001 §5 / Phase S): the public session id
        // alone never resumes (or, under kick-old, takes over) a session
        // that had a negotiated device plane — the hello must also present
        // the server-issued resume token. A missing/mismatched token is a
        // NEW session, never an error or a hijack. A UI-only session keeps
        // the legacy id-only resume.
        var sessionId = requested
        if (sessionId != null && sessionManager.requiresResumeToken(sessionId) &&
            !sessionManager.verifyResumeToken(sessionId, token)
        ) {
            log.info("Resume of device session $sessionId without a valid resume token — new session")
            sessionId = null
        }

        val send: suspend (String) -> Unit = { conn.out.sendText(it) }
        val result = establishSession(
            conn.key,
            sessionId,
            props,
            send,
            ackExtras = { session, b ->
                // A fresh resume credential per acknowledged connection
                // (rotated on every resume; the previous one stops working).
                b.put("resumeToken", sessionManager.issueResumeToken(session.id))
                deviceAck?.let {
                    // From now on this session resumes only with its token.
                    sessionManager.markDeviceSession(session.id)
                    b.put("device", it)
                }
            },
            afterAck = { client ->
                conn.client = client
                deviceAck?.let { attachDevicePlane(conn, client, it) }
            },
        )
        when (result) {
            is Established.Rejected -> conn.out.close(1008, "session in use")
            is Established.Ready -> {
                val client = result.client
                conn.out.sendText(result.initialTree)
                client.ready = true
                scheduleFlush(client)
                // Activate the mounted modules so single-screen apps have a
                // live activation authority for device work (RFC 001 §2.7);
                // the core.capabilities stream already opened before any
                // module callback can request device work. Under the
                // auto-wired ManagedRouter, route modules are activated by
                // the router as usual.
                try {
                    client.moduleInstance.activate()
                    client.nestedModules.values.forEach { it.activate() }
                } catch (e: Exception) {
                    log.error("Module activation failed for ${client.sessionId}", e.message ?: "")
                }
            }
        }
    }

    /**
     * Create the connection's broker (the Rust `DeviceBroker`), start it —
     * which opens the connection-owned `core.capabilities` stream before any
     * module callback can request device work (§2.2) — and bind every live
     * module instance to it.
     */
    private fun attachDevicePlane(conn: Connection, client: ClientState, ack: JsonElement) {
        val config = deviceConfig ?: return
        val clock = config.clock
        val binary = ((ack as? JsonObject)?.get("binary") as? JsonPrimitive)?.content == "true"
        val plane = try {
            val broker = DeviceBroker(config.brokerConfigJson(ack), devicePool, clock.nowMs().coerceAtLeast(0).toULong())
            DevicePlane(
                broker,
                object : DevicePlaneSink {
                    override fun sendText(text: String) = conn.out.sendText(text)
                    override fun sendFrame(frame: ByteArray) = conn.out.sendBinary(frame)
                    override fun bufferedAmount(): Long = conn.out.buffered
                    override fun closeConnection(code: Int, reason: String) {
                        log.warn("Session ${client.sessionId}: $reason — closing")
                        closeDevicePlane(conn, client, code, reason)
                    }
                },
                client.scope,
                clock,
                binary,
            ) { what, e -> log.error("Session ${client.sessionId}: $what failed", e.message ?: "") }
        } catch (e: Exception) {
            log.error("Session ${client.sessionId}: device broker creation failed — device plane disabled", e.message ?: "")
            return
        }
        conn.plane = plane
        client.devicePlane = plane
        (client.globalContext as? HypenGlobalContext)?.devicePlane = plane
        if (!plane.start()) {
            log.warn("Session ${client.sessionId}: core.capabilities could not open — device plane closed")
            closeDevicePlane(conn, client, DeviceServerConfig.DEVICE_PLANE_CLOSE_CODE, "device plane closed: core.capabilities unavailable")
            return
        }
        for (instance in liveModuleInstances(client)) instance.attachDevice(plane)
        log.info("Session ${client.sessionId}: device plane enabled")
    }

    /** Every live module instance of a client: primary, nested, and router-owned. */
    private fun liveModuleInstances(client: ClientState): List<BaseModuleInstance<*>> {
        val out = mutableListOf<BaseModuleInstance<*>>(client.moduleInstance)
        out += client.nestedModules.values
        val key = clients.entries.firstOrNull { it.value === client }?.key
        key?.let { k -> managedRouters[k]?.liveInstances()?.let { out += it } }
        return out.distinct()
    }

    /**
     * Close the device connection (RFC 001 §2.2/§2.5): reject all live device
     * work, detach every module instance and reset the socket (1012 by
     * default) — a socket with a device plane never survives without its broker.
     */
    private fun closeDevicePlane(conn: Connection, client: ClientState, code: Int, reason: String) {
        val plane = conn.plane ?: return
        conn.plane = null
        client.devicePlane = null
        (client.globalContext as? HypenGlobalContext)?.devicePlane = null
        plane.close(DeviceErrorCode.CONNECTION_LOST)
        for (instance in liveModuleInstances(client)) instance.attachDevice(null)
        conn.out.close(code, reason)
    }

    /** Send patches produced outside a dispatch as one `patch` message (after any in-flight dispatch). */
    private fun scheduleFlush(client: ClientState) {
        if (!client.flushScheduled.compareAndSet(false, true)) return
        client.scope.launch {
            client.flushScheduled.set(false)
            client.mutex.withLock {
                if (!client.ready) return@withLock
                val patches = synchronized(client.pendingPatches) {
                    client.pendingPatches.toList().also { client.pendingPatches.clear() }
                }
                if (patches.isEmpty()) return@withLock
                client.revision++
                sendPatchBatch(client, patches)
            }
        }
    }

    /**
     * Handle an incoming WebSocket message from a client.
     *
     * @return Response message(s) to send back, or null if no response needed
     */
    suspend fun handleMessage(
        connectionKey: Any,
        message: String,
        sendMessage: suspend (String) -> Unit
    ) {
        val conn = connections[connectionKey]
        // Device JSON limits start BEFORE parsing (RFC 001 §2.1): an
        // over-limit text announcing itself as a device message is dropped
        // unparsed — a connection-level violation, attributable to no request.
        conn?.plane?.let { plane ->
            if (uniffi.hypen_engine.deviceIsOversizeText(message)) {
                plane.reportViolation("device message over 1 MiB")
                return
            }
        }
        // The lenient host parser recurses per container, so nesting is
        // bounded BEFORE it runs (an iterative scan): a ≤ 1 MiB text nested
        // hundreds of thousands of levels deep must never throw
        // StackOverflowError into the host's socket read loop. Such a text
        // is never a valid message; device-typed ones go to the broker's
        // strict decoder (depth 33+ is a counted violation, D4).
        if (JsonNesting.exceeds(message, JsonNesting.MAX_HOST_PARSE_DEPTH)) {
            rejectUnparsed(conn, message, "nested deeper than ${JsonNesting.MAX_HOST_PARSE_DEPTH} containers")
            return
        }
        val msg = try {
            Json.decodeFromString<JsonObject>(message)
        } catch (e: StackOverflowError) {
            // Defence in depth: the scan above already bounds the recursion.
            rejectUnparsed(conn, message, "parser stack exhausted")
            return
        } catch (e: Exception) {
            rejectUnparsed(conn, message, "not a JSON object")
            return
        }

        val type = msg.stringMember("type") ?: return

        // One inbound message never ends the connection (the TS server logs
        // and drops a failing message too): an exception thrown here would
        // unwind the host's socket read loop (`for (frame in incoming)`),
        // close the socket and stop every later UI update. A dispatch the
        // engine refuses — a UI action on a node a re-render just removed
        // ("stale UI action target"), a malformed `__hypen_dispatch`
        // envelope — or a throwing handler is logged and dropped; nothing is
        // sent and the revision is untouched.
        try {
            routeMessage(conn, connectionKey, msg, message, type, sendMessage)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log.warn("Dropped '$type' message that failed: ${e::class.simpleName}: ${e.message?.take(200)}")
            if (type == "hello" && conn != null) {
                // The session could not be established (render failure):
                // like the TS server, reset the socket instead of leaving a
                // half-initialised connection that never sends a tree.
                conn.out.close(1011, "session setup failed")
            }
        }
    }

    private suspend fun routeMessage(
        conn: Connection?,
        connectionKey: Any,
        msg: JsonObject,
        message: String,
        type: String,
        sendMessage: suspend (String) -> Unit,
    ) {
        if (conn != null) {
            // A hello-driven connection writes only through its ordered queue.
            when (type) {
                "hello" -> {
                    handleHello(conn, msg, message)
                    return
                }
                "deviceEvent", "deviceResponse", "deviceRequest" -> {
                    // Routed to the broker, never through the action path; the
                    // raw text is strictly decoded there. A client
                    // `deviceRequest` is wrong-direction traffic the broker
                    // reacts to (D8: a live id is cancelled and settled
                    // invalidParams; an unknown id is ignored), exactly as it
                    // judges a malformed one via [rejectUnparsed]. No plane ⇒
                    // dropped.
                    conn.plane?.receiveText(message)
                    return
                }
            }
            if (!conn.helloReceived || clients[connectionKey] == null) {
                log.warn("$type before hello — rejected")
                return
            }
            return handleUiMessage(connectionKey, msg, type) { conn.out.sendText(it) }
        }
        if (type in DEVICE_TYPE_NAMES) return
        handleUiMessage(connectionKey, msg, type, sendMessage)
    }

    /**
     * A text the host parser does not accept (malformed, not an object, or
     * nested too deep). Device traffic is still the broker's to judge —
     * strict decode, attribution, violation counting (D4/D8) — everything
     * else is logged and dropped. Never throws.
     */
    private fun rejectUnparsed(conn: Connection?, message: String, why: String) {
        val plane = conn?.plane
        if (plane != null && isDeviceTyped(message)) {
            plane.receiveText(message)
            return
        }
        log.warn("Invalid message from client ($why): ${message.take(256)}")
    }

    private suspend fun handleUiMessage(
        connectionKey: Any,
        msg: JsonObject,
        type: String,
        sendMessage: suspend (String) -> Unit,
    ) {
        when (type) {
            "hello" -> {
                // Hello message for session handshake (handled in handleConnect for simplicity)
                val sid = msg.stringMember("sessionId")
                val msgProps = msg["props"]?.let {
                    if (it is JsonObject) it.mapValues { (_, v) -> v.toKotlinValue() }
                    else emptyMap()
                } ?: emptyMap()
                // Session already established in handleConnect
                log.debug("Hello from session $sid")
            }

            "navigate" -> {
                val path = msg.stringMember("path") ?: return
                val client = clients[connectionKey] ?: return

                // Under the auto-wired ManagedRouter, navigation is
                // driven through the session's HypenRouter so it hits
                // the same mount/unmount lifecycle as `@router.push`
                // coming from the DSL. Engine patches are collected
                // under `dispatchAndSend` rather than via renderFullTree.
                val managed = managedRouters[connectionKey]
                if (managed != null) {
                    dispatchAndSend(client, sendMessage) {
                        client.engine.dispatchAction(
                            "router.push",
                            mapOf("to" to path)
                        )
                    }
                    client.currentRoute = path
                    events.emit(HypenEvents.routeChanged, HypenEvents.RouteChanged(null, path))
                    return
                }

                // A path no route matches is ignored: re-rendering the current
                // template without remounting its module would leave the
                // engine without the module's action handlers, freezing the UI.
                if (routeDefinitions.none { matchPath(it.path, path) }) {
                    log.warn("navigate to $path matches no route — ignored")
                    return
                }
                // Route-table mounting (a Kotlin-only mode: the TS server
                // navigates only through its router, whose `router.push`
                // answers with a `patch`). The new route's module is mounted
                // on a cleared tree, so the client gets ONE ordinary `patch`
                // that removes the screen it holds and builds the new one —
                // never a `render` message, which no client decodes.
                val removed = client.rootSnapshot()
                mountRouteForClient(connectionKey, path)
                val patches = renderFullTree(connectionKey)
                sendReplacement(client, removed, patches, sendMessage)

                events.emit(HypenEvents.routeChanged, HypenEvents.RouteChanged(null, path))
            }

            "dispatchAction", "action" -> {
                val actionName = msg.stringMember("action")
                    ?: msg.stringMember("name")
                    ?: return
                // Strip the reserved transaction-animation stamp (Option D):
                // TS renderers carry the `animate:` event argument across the
                // dispatch boundary under "__hypenAnimate". It is a
                // renderer→host directive, never handler data — the Kotlin
                // host does not implement transaction stamping, and module
                // handlers must never observe the key either way.
                val payload = msg["payload"]
                    ?.takeIf { it !is JsonNull }
                    ?.let { raw ->
                        if (raw is JsonObject && raw.containsKey(RESERVED_ANIMATE_KEY)) {
                            JsonObject(raw.filterKeys { it != RESERVED_ANIMATE_KEY })
                        } else {
                            raw
                        }
                    }

                val client = clients[connectionKey] ?: return

                dispatchAndSend(client, sendMessage) {
                    client.engine.dispatchAction(actionName, payload)
                }

                events.emit(
                    HypenEvents.actionDispatched,
                    HypenEvents.ActionDispatched(client.sessionId, actionName, payload)
                )
            }
        }
    }

    /**
     * Handle a WebSocket client disconnection.
     */
    suspend fun handleDisconnect(connectionKey: Any) {
        connections.remove(connectionKey)?.let { conn ->
            conn.helloTimer?.cancel()
            // Connection loss: every live device request settles
            // `connectionLost` locally (nothing more is sent).
            conn.plane?.let { plane ->
                conn.plane = null
                plane.close(DeviceErrorCode.CONNECTION_LOST)
                conn.client?.let { c ->
                    c.devicePlane = null
                    (c.globalContext as? HypenGlobalContext)?.devicePlane = null
                    liveModuleInstances(c).forEach { it.attachDevice(null) }
                }
            }
            conn.out.stop()
        }
        val client = clients.remove(connectionKey) ?: return
        client.ready = false

        // Tear down the per-session ManagedRouter (if auto-wire built
        // one) before we start unwinding the client state so its
        // router.* action handlers don't fire against a half-destroyed
        // engine during shutdown.
        managedRouters.remove(connectionKey)?.stop()

        sessionManager.untrackConnection(client.sessionId, connectionKey)

        // If no more connections for this session, suspend it
        if (sessionManager.getConnectionCount(client.sessionId) == 0) {
            val session = sessionManager.getActiveSession(client.sessionId)
            if (session != null) {
                // Save state before suspending
                val savedState = client.moduleInstance.getState()

                // Call disconnect handler
                @Suppress("UNCHECKED_CAST")
                (client.moduleInstance as? ModuleInstance<Any>)?.handleDisconnect(session.toSessionInfo())

                // Suspend the session
                sessionManager.suspendSession(client.sessionId, savedState) {
                    // On expire callback
                    @Suppress("UNCHECKED_CAST")
                    (client.moduleInstance as? ModuleInstance<Any>)?.handleExpire(session.toSessionInfo())
                    client.moduleInstance.destroy()
                    // Destroy nested modules
                    client.nestedModules.values.forEach { it.destroy() }
                    client.nestedModules.clear()
                    client.engine.close()
                    client.scope.cancel()
                    log.info("Session ${client.sessionId} expired")
                }
            }
        }

        onDisconnectionCallback?.invoke(RemoteClient(client.id, client.sessionId, client.connectedAt))
        events.emit(HypenEvents.moduleDestroyed, HypenEvents.ModuleDestroyed(client.sessionId))
        log.debug("Client ${client.sessionId} disconnected")
    }

    /**
     * Run one engine dispatch on [client] and push whatever it rendered to
     * the user as a single `patch` message.
     *
     * Patch collection, the [ClientState.revision] bump and the transport
     * write all happen under [ClientState.mutex]. That is what makes a
     * renderer click ([handleMessage]) and an attached-agent dispatch
     * ([AgentHandle.dispatch]) — which by construction runs on another
     * coroutine — safe to interleave: neither can stamp a revision until
     * the other's frame is on the wire, so revisions reach the client
     * strictly increasing, one frame per dispatch. (The browser client
     * discards any `patch` whose revision is not greater than the last it
     * applied; two dispatches racing between bump and send would silently
     * lose one set of patches.)
     *
     * If [block] throws — the external-surface guard refusing a name, a
     * handler failing — nothing is sent and the revision is untouched.
     *
     * @param send The transport to write to. Defaults to the client's own
     *   [ClientState.sendMessage]; [handleMessage] passes the socket it was
     *   handed so the two never diverge.
     * @return The patches that were sent (empty when the dispatch rendered
     *   nothing, in which case no frame was written but the revision still
     *   advanced — the same bookkeeping a click has always had).
     */
    internal suspend fun dispatchAndSend(
        client: ClientState,
        send: (suspend (String) -> Unit)? = null,
        block: () -> Unit
    ): List<Patch> = client.mutex.withLock {
        // Patches still pending from outside a dispatch (an async handler's
        // state change whose flush has not run yet) are real deltas: they go
        // out first, in this same message.
        block()
        val patches = synchronized(client.pendingPatches) {
            client.pendingPatches.toList().also { client.pendingPatches.clear() }
        }
        client.revision++
        sendPatchBatch(client, patches, send)
        patches
    }

    /**
     * Push one batch of engine patches to a client as a single `patch`
     * message, bumping nothing — the caller owns [ClientState.revision]
     * and must have incremented it already. An empty batch sends nothing.
     *
     * This is the one place a post-handshake patch message is built, so a
     * renderer click ([handleMessage]) and an attached agent dispatch
     * ([AgentHandle.dispatch]) put byte-identical frames on the wire.
     * Both reach it through [dispatchAndSend]; call it directly only while
     * already holding [ClientState.mutex].
     *
     * @param send The transport to write to. Defaults to the client's own
     *   [ClientState.sendMessage].
     */
    private suspend fun sendPatchBatch(
        client: ClientState,
        patches: List<Patch>,
        send: (suspend (String) -> Unit)? = null
    ) {
        if (patches.isEmpty()) return
        val transport = send ?: client.sendMessage ?: return
        client.trackRoots(patches)
        // `module` is required by the Android (Moshi) and desktop (serde)
        // clients: a `patch` without it is dropped whole on both, so every
        // UI update after the initial tree would be lost (TS / Go send it).
        val response = buildJsonObject {
            put("type", "patch")
            put("module", wireModuleName)
            putJsonArray("patches") {
                patches.forEach { add(Json.encodeToJsonElement(it)) }
            }
            put("revision", client.revision)
        }
        transport(response.toString())
    }

    /**
     * Attach an agent to a live user session.
     *
     * Returns an [AgentHandle] bound to the engine of the connected,
     * handshake-completed client whose session id is [sessionId], or
     * `null` when no such client is ready (unknown id, still connecting,
     * disconnected, kicked, or shut down). Under
     * [ConcurrentPolicy.ALLOW_MULTIPLE] the first ready connection wins.
     *
     * Authorization is yours: this method does no authentication. Call it
     * from a handler that has already established the caller may act on
     * that user's session — a session id is a resume token, and whoever
     * holds one can drive the UI the user is looking at.
     *
     * The handle never owns the session. Disconnecting, kicking or
     * shutting down still go through the usual paths; the handle merely
     * starts throwing [AgentSessionGoneException] once its client is gone.
     */
    fun attach(sessionId: String): AgentHandle? {
        val client = clients.values.firstOrNull { it.sessionId == sessionId && it.ready }
            ?: return null
        return AgentHandle(this, client)
    }

    /**
     * Get session statistics.
     */
    fun getStats(): Map<String, Any> {
        val sessionStats = sessionManager.getStats()
        return mapOf(
            "activeSessions" to sessionStats.activeSessions,
            "pendingSessions" to sessionStats.pendingSessions,
            "totalConnections" to sessionStats.totalConnections,
            "registeredModules" to modules.size,
            "routes" to routeDefinitions.size
        )
    }

    /**
     * Get the event emitter for subscribing to framework events.
     */
    fun events(): TypedEventEmitter = events

    /**
     * Get the route definitions.
     */
    fun getRoutes(): List<RouteDefinition> = routeDefinitions.toList()

    /**
     * Shut down the server, cleaning up all clients and sessions.
     */
    fun shutdown() {
        componentWatcher?.stop()
        managedRouters.values.forEach { it.stop() }
        managedRouters.clear()
        serverScope.cancel()
        connections.values.forEach { conn ->
            conn.helloTimer?.cancel()
            conn.plane?.close(DeviceErrorCode.CONNECTION_LOST)
            conn.plane = null
            conn.out.stop()
        }
        connections.clear()
        devicePool?.destroy()
        clients.values.forEach { client ->
            client.ready = false
            client.moduleInstance.destroy()
            client.nestedModules.values.forEach { it.destroy() }
            client.nestedModules.clear()
            client.engine.close()
            client.scope.cancel()
        }
        clients.clear()
        sessionManager.shutdown()
        log.info("HypenServer shut down")
    }

    /**
     * Handle component file changes from the watcher.
     * Hello-driven connections are closed 1012 so they reconnect into the new
     * sources (the TS server's hot reload); legacy connections get the new
     * tree as one replacing `patch`.
     */
    private suspend fun handleComponentChanges(changes: ComponentChanges) {
        if (changes.isEmpty()) return

        log.info(
            "Component changes: +${changes.added.size} ~${changes.updated.size} -${changes.removed.size}"
        )

        for ((key, client) in clients.entries.toList()) {
            // Hello-driven connections reload the way the TS server does
            // (`RemoteServer.reload` → `disconnectForReload`): the socket is
            // closed 1012 ("service restart") WITHOUT expiring the session.
            // The client reconnects with its session id (and resume token),
            // the suspended session resumes with its saved state, and a new
            // engine built from the new sources sends a fresh `initialTree`.
            // Re-rendering into the live engine is not reliable (router-cached
            // subtrees, nested modules' reactive wiring).
            val conn = connections[key]
            if (conn != null) {
                if (conn.helloReceived) conn.out.close(RELOAD_CLOSE_CODE, "Hot reload")
                continue
            }

            // Legacy hello-less connections (handleConnect) expose no way to
            // close their socket: re-register the sources, re-render, and
            // send the new tree as one ordinary `patch` replacing the old one.
            for (component in changes.added + changes.updated) {
                try {
                    client.engine.registerComponent(component.name, component.template, component.hypenPath)
                } catch (e: Exception) {
                    log.warn("Failed to register component '${component.name}' for session ${client.sessionId}", e.message ?: "")
                }
            }
            val send = client.sendMessage ?: continue
            try {
                val removed = client.rootSnapshot()
                val patches = reRenderClient(key)
                sendReplacement(client, removed, patches, send)
            } catch (e: Exception) {
                log.warn("Hot reload of session ${client.sessionId} failed: ${e.message}")
            }
        }
    }

    /**
     * Send a re-rendered tree ([patches], built on a cleared engine tree) as
     * one `patch` message that first removes the top-level nodes the client
     * held ([removed]), so the client ends up with exactly the new tree.
     */
    private suspend fun sendReplacement(
        client: ClientState,
        removed: List<String>,
        patches: List<Patch>,
        send: suspend (String) -> Unit,
    ) {
        client.mutex.withLock {
            // Deltas the render callback queued since (e.g. a new module's
            // async onCreated) follow the new tree in the same message.
            val pending = synchronized(client.pendingPatches) {
                client.pendingPatches.toList().also { client.pendingPatches.clear() }
            }
            val batch = removed.map { Patch(type = PatchType.REMOVE, id = it) } + patches + pending
            if (batch.isEmpty()) return
            client.revision++
            sendPatchBatch(client, batch, send)
        }
    }

    /**
     * Re-render a client's current route from scratch. Returns the patches.
     */
    private suspend fun reRenderClient(connectionKey: Any): List<Patch> {
        val client = clients[connectionKey] ?: return emptyList()

        // Clear and re-mount
        client.moduleInstance.destroy()
        client.engine.clearTree()
        mountRouteForClient(connectionKey, client.currentRoute)

        return renderFullTree(connectionKey)
    }

    // ---- Internal ----

    /**
     * The `module` member of every `initialTree` / `patch` message: the
     * primary module's name (the first route's component), constant for the
     * server. Clients echo it back in `dispatchAction.module`.
     */
    private val wireModuleName: String get() = routeDefinitions.firstOrNull()?.component ?: ""

    /**
     * `initialTree.state`: the primary module's state as JSON (the TS server
     * sends `getState()`), or `null` when it cannot be read. The member is
     * always present — the desktop client's decoder requires it.
     */
    private fun wireState(client: ClientState): JsonElement =
        try {
            finiteJson(client.moduleInstance.getState().toJsonElement())
        } catch (e: Exception) {
            log.debug("initialTree.state unavailable: ${e.message}")
            JsonNull
        }

    /**
     * [e] with every non-finite number (`NaN`, `±Infinity`, which kotlinx
     * prints as bare, invalid JSON tokens) replaced by `null`, as
     * `JSON.stringify` does on the TS server: one such value in module state
     * would otherwise make the whole `initialTree` unparseable on the client.
     */
    private fun finiteJson(e: JsonElement): JsonElement = when (e) {
        is JsonObject -> JsonObject(e.mapValues { (_, v) -> finiteJson(v) })
        is JsonArray -> JsonArray(e.map(::finiteJson))
        is JsonPrimitive ->
            if (!e.isString && e !is JsonNull && e.content.let { it == "NaN" || it == "Infinity" || it == "-Infinity" }) JsonNull else e
    }

    /**
     * Inspect the primary module's `.ui` for `Router { Route ... }`
     * blocks via the engine's `discoverRouters` and, if any top-level
     * Router is found, spin up a per-session [ManagedRouter] bound to
     * the client's engine + [HypenApp] registry and mirror navigation
     * into the primary module's `location` field.
     *
     * Returns `true` when auto-wiring succeeded and the caller should
     * skip its legacy route mounting. Returns `false` when auto-wire is
     * not applicable (no primary module, no `.ui`, no Router block, no
     * registered component matched any route body, or discovery failed)
     * — the caller then falls back to [mountRouteForClient].
     *
     * Mirrors `autoWireManagedRouter` on the Go / TS / Swift SDKs.
     */
    @Suppress("UNCHECKED_CAST")
    private fun autoWireRouterForClient(connectionKey: Any, initialRoute: String): Boolean {
        val client = clients[connectionKey] ?: return false

        // Primary module selection: first `route(...)` declaration wins,
        // falling back to a module named "App" if no routes are set.
        // Mirrors the convention every Social example already follows.
        val primaryName = routeDefinitions.firstOrNull()?.component ?: "App"
        val primaryDef = (modules[primaryName] ?: HypenApp.get(primaryName)) ?: return false
        val ui = primaryDef.ui ?: return false

        // Collect router blocks from both the primary template AND
        // every registered child module's `.ui`. `discoverRouters`
        // walks a single IR tree and does not resolve `Foo()`
        // component references — child templates live in separate
        // source strings on each [ModuleDefinition.ui]. Running
        // discover on each separately and concatenating (primary
        // first) gives us the true cross-tree router inventory.
        // Without this pass, a nested `module Home { Router { ... }
        // }` declared only in `Home/component.hypen` (or a Home
        // sidecar `.ui(...)`) is invisible to the SDK and the route
        // never mounts. Mirrors the TS P1-A fix (commit 9adcb3f2).
        val allRouters = mutableListOf<JsonObject>()
        val runDiscover = { source: String, label: String ->
            try {
                val blocks = Json.parseToJsonElement(
                    uniffi.hypen_engine.discoverRouters(source)
                ).jsonArray
                for (b in blocks) {
                    (b as? JsonObject)?.let { allRouters.add(it) }
                }
            } catch (e: Exception) {
                log.warn("Auto-router: discoverRouters failed on $label: ${e.message ?: e.toString()}")
            }
            Unit
        }
        runDiscover(ui, client.sessionId)
        for (name in HypenApp.getNames()) {
            if (name.equals(primaryName, ignoreCase = true)) continue
            val childUi = HypenApp.get(name)?.ui
            if (childUi.isNullOrEmpty()) continue
            runDiscover(childUi, "${client.sessionId} / $name")
        }
        if (allRouters.isEmpty()) return false

        val primaryScope = primaryName.lowercase()
        // Include every discovered router — top-level (module_scope
        // empty or == primary) AND routers nested inside per-route
        // module templates. Flattening them into a single route table
        // shares the parent's URL space; authors spell out the full
        // prefix in `Route(path:)`. The de-dup below preserves first
        // emission order so outer routes win on conflicts.

        // Engine-side preparation: destroy any placeholder primary
        // instance from [handleConnect] (the dummy) and clear the tree
        // so the forthcoming render starts from a clean slate.
        client.moduleInstance.destroy()
        client.nestedModules.values.forEach { it.destroy() }
        client.nestedModules.clear()
        client.engine.clearTree()

        // Register every non-primary named module on the engine so the
        // `@{state.xxx}` bindings inside `module <Name> { ... }` blocks
        // resolve once their route's subtree activates. Action handlers
        // for the mounted route come from the [ManagedRouter]-built
        // [ModuleInstance] each time, so we pass `emptyList()` here to
        // avoid double-registering them up front.
        for (name in HypenApp.getNames()) {
            if (name.equals(primaryName, ignoreCase = true)) continue
            val def = HypenApp.get(name) ?: continue
            if (def.initialState == null && def.actions.isEmpty() && def.actionHandlers.isEmpty()) continue
            val initial = def.initialState
                ?.let { (it as? Map<String, Any?>) ?: mapOf() }
                ?: emptyMap()
            client.engine.registerModule(name, emptyList(), def.stateKeys, initial)
        }

        val globalContext = HypenGlobalContext()
        // Instances built against this context (the primary below and every
        // route module the ManagedRouter mounts) bind to the connection's
        // device plane at construction.
        globalContext.devicePlane = client.devicePlane
        client.globalContext = globalContext

        // Attach the session's router so per-route modules can read
        // route params from lifecycle handlers (onActivated etc.) via
        // `context.getRouter()`. Must happen before primary module
        // construction so onCreated on the primary already sees it.
        val hypenRouter = HypenRouter()
        globalContext.setRouter(hypenRouter)

        val namedPrimary = if (primaryDef.name.isNullOrEmpty()) {
            (primaryDef as ModuleDefinition<Any>).copy(name = primaryName)
        } else {
            primaryDef
        }
        val primaryInstance = ModuleInstance(
            engine = client.engine,
            definition = namedPrimary as ModuleDefinition<Any>,
            scope = client.scope,
            globalContext = globalContext,
        )
        client.moduleInstance = primaryInstance
        client.currentRoute = initialRoute
        globalContext.registerModule(primaryScope, primaryInstance)

        val managed = ManagedRouter(
            router = hypenRouter,
            engine = client.engine,
            registry = HypenApp,
            globalContext = globalContext,
            routerActionScope = client.scope,
        )

        var added = 0
        val seenPaths = mutableSetOf<String>()
        for (r in allRouters) {
            val routes = (r["routes"] as? JsonArray) ?: continue
            for (routeElem in routes) {
                val ro = routeElem as? JsonObject ?: continue
                val path = (ro["path"] as? JsonPrimitive)?.contentOrNull ?: continue
                if (!seenPaths.add(path)) {
                    log.debug("Auto-router: path $path already registered; ignoring nested duplicate")
                    continue
                }
                val elementNames = (ro["element_names"] as? JsonArray) ?: continue
                var component: String? = null
                for (nameElem in elementNames) {
                    val n = (nameElem as? JsonPrimitive)?.contentOrNull ?: continue
                    if (HypenApp.has(n)) {
                        component = n
                        break
                    }
                }
                if (component == null) {
                    log.debug("Auto-router: no registered module matched route $path — skipping")
                    continue
                }
                managed.addRoute(RouteDefinition(path = path, component = component))
                added++
            }
        }
        if (added == 0) {
            log.debug("Auto-router: nothing to mount for ${client.sessionId}")
            // Primary is set up and will still render through renderFullTree,
            // so we return true — there's no sensible fallback route table.
            return true
        }
        log.info("Auto-router: wired $added routes for ${client.sessionId}")

        // Mirror router navigation into the primary scope's `location`
        // field when the state shape carries one. We write synchronously
        // so the resulting engine patches land inside the caller's
        // [collectPatches] window (every `dispatchAction` response
        // goroutine) — Kotlin's JNA engine doesn't have the WASM
        // borrow-checker reentrance issue that the Go / TS / Swift
        // `@router.*` handlers defer around, so there's no need to
        // queue the write off the dispatch stack here.
        //
        // Written through the primary module's state (which forwards to the
        // engine synchronously), not to the engine alone, so the module's
        // own state — what `getState()`, a suspended session's saved state
        // and `initialTree.state` report — holds the location too (TS writes
        // `state[locationKey]`); a resumed session then returns to it.
        if ("location" in primaryDef.stateKeys) {
            hypenRouter.onNavigate { _, to ->
                try {
                    if (primaryInstance.getState()["location"] != to) {
                        primaryInstance.updateState(mapOf("location" to to))
                    }
                } catch (e: Exception) {
                    log.warn("Auto-router: updateState(location) failed: ${e.message ?: e.toString()}")
                }
            }
        }

        managed.start()
        managedRouters[connectionKey] = managed
        return true
    }

    private fun mountRouteForClient(connectionKey: Any, path: String) {
        val client = clients[connectionKey] ?: return
        val matched = routeDefinitions.firstOrNull { route ->
            matchPath(route.path, path)
        } ?: return

        // Destroy current module instance and nested modules. This is a
        // destroy site, so their engine registrations go too (as
        // `ManagedRouter.stop` does): the engine's module registry is
        // append-only otherwise, and the route module about to be mounted as
        // the primary is also still registered as a nested module from the
        // previous route — both would answer its actions ("ambiguous unscoped
        // action") and every dispatch after a navigation was dropped.
        val destroyed = listOf<BaseModuleInstance<*>>(client.moduleInstance) + client.nestedModules.values
        destroyed.forEach { it.destroy() }
        client.nestedModules.clear()
        destroyed.map { it.engineModuleName }.distinct().forEach { name ->
            try {
                client.engine.unregisterModule(name)
            } catch (e: Exception) {
                log.debug("unregisterModule($name) failed: ${e.message}")
            }
        }
        client.engine.clearTree()

        // Look up module definition
        val definition = matched.module ?: modules[matched.component] ?: HypenApp.get(matched.component) ?: return

        @Suppress("UNCHECKED_CAST")
        val namedDef = if (definition.name.isNullOrEmpty()) {
            (definition as ModuleDefinition<Any>).copy(name = matched.component)
        } else {
            definition
        }

        // Create a global context for cross-module communication; modules
        // built against it bind to the connection's device plane.
        val globalContext = HypenGlobalContext()
        globalContext.devicePlane = client.devicePlane
        client.globalContext = globalContext

        // Create new module instance for this client (primary module)
        @Suppress("UNCHECKED_CAST")
        val instance = ModuleInstance(
            engine = client.engine,
            definition = namedDef as ModuleDefinition<Any>,
            scope = client.scope,
            globalContext = globalContext
        )

        client.moduleInstance = instance
        client.currentRoute = path

        // Register primary module in global context so nested modules can reference it
        globalContext.registerModule(matched.component.lowercase(), instance)

        // Auto-register non-primary modules from the HypenApp registry.
        // Create NestedModuleInstance for each so that action handlers are
        // registered with the engine (not just state). Without this, dispatching
        // an action for a nested module would queue it in the engine but
        // processPendingActions() would find no Kotlin-side handler.
        val primaryName = matched.component
        for (name in HypenApp.getNames()) {
            if (name == primaryName) continue
            val def = HypenApp.get(name) ?: continue

            // Skip stateless modules (no state, no actions, no handlers)
            if (def.initialState == null && def.actions.isEmpty()
                && def.actionHandlers.isEmpty()) continue

            @Suppress("UNCHECKED_CAST")
            val namedNestedDef = if (def.name.isNullOrEmpty()) {
                (def as ModuleDefinition<Any>).copy(name = name)
            } else {
                def
            }

            @Suppress("UNCHECKED_CAST")
            val nestedInstance = NestedModuleInstance(
                engine = client.engine,
                definition = namedNestedDef as ModuleDefinition<Any>,
                globalContext = globalContext,
                scope = client.scope
            )

            client.nestedModules[name] = nestedInstance
            globalContext.registerNestedModule(name.lowercase(), nestedInstance)
        }
    }

    private suspend fun renderFullTree(connectionKey: Any): List<Patch> {
        val client = clients[connectionKey] ?: return emptyList()

        // Find the current route's template
        val matched = routeDefinitions.firstOrNull { matchPath(it.path, client.currentRoute) }
        val template = matched?.let { route ->
            val def = route.module ?: modules[route.component] ?: HypenApp.get(route.component)
            def?.ui
        }

        if (template == null) return emptyList()

        return client.collectPatches {
            client.engine.renderSource(template)
        }
    }

    private fun kickSession(sessionId: String) {
        // Find and disconnect the old client
        val oldEntry = clients.entries.firstOrNull { it.value.sessionId == sessionId }
        if (oldEntry != null) {
            val oldClient = oldEntry.value
            // A hello-driven connection is told and closed; its device plane
            // ends first (every live request settles connectionLost).
            connections.remove(oldEntry.key)?.let { conn ->
                conn.helloTimer?.cancel()
                conn.plane?.let { plane ->
                    conn.plane = null
                    plane.close(DeviceErrorCode.CONNECTION_LOST)
                }
                conn.out.sendText(buildSessionExpiredMessage(sessionId, "kicked"))
                conn.out.close(1000, "session taken over")
            }
            oldClient.devicePlane = null
            oldClient.ready = false
            oldClient.moduleInstance.destroy()
            oldClient.engine.close()
            oldClient.scope.cancel()
            clients.remove(oldEntry.key)
            log.debug("Kicked old connection for session $sessionId")
        }
    }

    private fun matchPath(pattern: String, path: String): Boolean {
        val patternParts = pattern.split("/").filter { it.isNotEmpty() }
        val pathParts = path.split("?")[0].split("/").filter { it.isNotEmpty() }
        if (patternParts.size != pathParts.size) return false
        return patternParts.zip(pathParts).all { (p, a) ->
            p.startsWith(":") || p == "*" || p == a
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun createDummyModuleInstance(engine: NativeEngine): ModuleInstance<Any> {
        val emptyDef = ModuleDefinition<MutableMap<String, Any?>>(
            name = "_placeholder",
            actions = emptyList(),
            stateKeys = emptyList(),
            persist = false,
            version = 1,
            initialState = mutableMapOf(),
            ui = null,
            onCreated = null,
            onActivated = null,
            onDeactivated = null,
            onDestroyed = null,
            actionHandlers = emptyMap()
        )
        return ModuleInstance(engine, emptyDef as ModuleDefinition<Any>)
    }

    companion object {
        /** WebSocket close code of a hot reload ("service restart"), as the TS server's `disconnectForReload`. */
        const val RELOAD_CLOSE_CODE = 1012

        private val DEVICE_MESSAGE_TYPE = Regex("\"type\"\\s*:\\s*\"device(Event|Response|Request)\"")

        /**
         * Whether an unparsed text is device traffic: its top-level `type`
         * (found without recursion, so any depth is safe) names a device
         * message. Text too broken to locate a top-level member (e.g.
         * truncated) falls back to a textual match.
         */
        private fun isDeviceTyped(message: String): Boolean =
            when (val t = TopLevelMember.find(message, "type")) {
                is TopLevelMember.Lookup.Found -> {
                    val raw = t.raw
                    raw.startsWith("\"") &&
                        (runCatching { Json.parseToJsonElement(raw) }.getOrNull() as? JsonPrimitive)
                            ?.takeIf { it.isString }?.content?.let { DEVICE_TYPE_NAMES.contains(it) } == true
                }
                TopLevelMember.Lookup.Absent -> false
                TopLevelMember.Lookup.Invalid -> DEVICE_MESSAGE_TYPE.containsMatchIn(message)
            }

        private val DEVICE_TYPE_NAMES = setOf("deviceEvent", "deviceResponse", "deviceRequest")

        /** A top-level string member, or `null` (absent, or not a string — never throws). */
        private fun JsonObject.stringMember(key: String): String? =
            (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun buildSessionExpiredMessage(sessionId: String, reason: String): String {
            return buildJsonObject {
                put("type", "sessionExpired")
                put("sessionId", sessionId)
                put("reason", reason)
            }.toString()
        }
    }
}

/**
 * Builder DSL for HypenServer.
 */
class HypenServerBuilder {
    internal val modules = mutableMapOf<String, ModuleDefinition<*>>()
    internal val routes = mutableListOf<RouteDefinition>()
    internal var sessionConfig = SessionConfig()
    internal var onConnectionCallback: ConnectionCallback? = null
    internal var onDisconnectionCallback: ConnectionCallback? = null
    internal var watchDir: String? = null
    internal var watchConfig: ComponentWatchConfig? = null
    internal val resourceJsonList = mutableListOf<String>()
    internal var autoRouterEnabled: Boolean = true
    internal val allowedOrigins = mutableListOf<String>()
    internal var authenticator: (suspend (UpgradeRequest) -> Boolean)? = null
    internal val deviceConfig = DeviceServerConfig()
    internal var deviceDisabled: Boolean = false

    /**
     * Browser origins allowed to open a WebSocket (RFC 001 §5, decision D1).
     * With an allowlist, a request carrying another `Origin` is refused 403
     * by [HypenServer.admit], and one carrying none needs [authenticate].
     * Configure it (and/or [authenticate]) in production: with neither, any
     * client is admitted and the server logs a startup warning.
     */
    fun allowedOrigins(vararg origins: String) {
        allowedOrigins += origins
    }

    /**
     * The app's upgrade authenticator (RFC 001 §5, decision D1): the only
     * admission for native clients (no `Origin`), and also run for browser
     * requests with an allowed Origin. Return `true` to admit.
     */
    fun authenticate(block: suspend (UpgradeRequest) -> Boolean) {
        authenticator = block
    }

    /**
     * Tune the Device Capability Protocol (RFC 001) — limits, budgets,
     * broker options, the hello timeout. The device plane itself is **on by
     * default**: every connection opened with [HypenServer.openConnection]
     * whose `hello` offers `device` negotiates one, with no call needed.
     * Calls accumulate onto one [DeviceServerConfig]; unset options keep
     * their defaults. Ignored after [disableDevice].
     *
     * ```kotlin
     * HypenServer {
     *     configureDevice { maxBackgroundOwners = 2; revisionOverride("bluetooth.scan", lifetimes = listOf(Lifetime.ACTIVATION, Lifetime.BACKGROUND)) }
     * }
     * ```
     */
    fun configureDevice(block: DeviceServerConfig.() -> Unit) {
        deviceConfig.apply(block)
    }

    /**
     * Opt out of the Device Capability Protocol: the server never negotiates
     * a device plane (a `hello.device` offer gets no `sessionAck.device`) and
     * uses no hello timeout — exactly the UI-only server. Compression is
     * independent of it ([compression]).
     */
    fun disableDevice() {
        deviceDisabled = true
    }

    /**
     * WebSocket permessage-deflate (RFC 7692) compression on the transport,
     * `true` by default, with or without the device plane — patch streams
     * are JSON and compress extremely well, and compression is negotiated
     * per-connection, so clients that don't advertise the extension fall
     * back to raw frames automatically. The name matches `compression` on
     * the TypeScript SDK (Go spells it `DisableCompression` only because a
     * struct zero value cannot express "default true").
     *
     * The transport must negotiate it with no context takeover in BOTH
     * directions (`server_no_context_takeover; client_no_context_takeover`)
     * so every message is compressed on its own and device data never
     * shares a compression history with other messages; clients keep a
     * context-takeover socket UI-only. See [HypenServer.compression].
     *
     * Set to `false` to force raw, uncompressed frames — useful when
     * debugging the wire protocol, since a deflated payload is opaque to
     * `tcpdump` and to most WebSocket frame inspectors.
     *
     * ```kotlin
     * val server = HypenServer {
     *     module("Counter", counterModule)
     *     compression = false  // raw-wire debugging
     * }
     * ```
     *
     * Note that [HypenServer] cannot apply this itself: it is transport
     * agnostic and never installs Ktor's `WebSockets` plugin — your Ktor
     * application does. Read [HypenServer.compression] where you install
     * the plugin so this flag actually takes effect.
     */
    var compression: Boolean = true

    /**
     * Opt out of the per-session auto-wired [ManagedRouter]. After this
     * call, [HypenServer] falls back to its legacy route-per-client
     * mounting driven by explicit [route] declarations. Matches the
     * `DisableAutoRouter()` / `disableAutoRouter()` escape hatch on the
     * Go / TS / Swift SDKs.
     */
    fun disableAutoRouter() {
        autoRouterEnabled = false
    }

    /**
     * Register a module definition.
     */
    fun module(name: String, definition: ModuleDefinition<*>) {
        modules[name] = definition
    }

    /**
     * Add a route definition.
     */
    fun route(path: String, component: String) {
        routes.add(RouteDefinition(path = path, component = component))
    }

    /**
     * Configure session management.
     */
    fun session(block: SessionConfigBuilder.() -> Unit) {
        sessionConfig = SessionConfigBuilder().apply(block).build()
    }

    /**
     * Register a connection callback.
     */
    fun onConnection(callback: ConnectionCallback) {
        onConnectionCallback = callback
    }

    /**
     * Register a disconnection callback.
     */
    fun onDisconnection(callback: ConnectionCallback) {
        onDisconnectionCallback = callback
    }

    /**
     * Register resources from a flat map of name → raw SVG string.
     * Each client engine will have these resources registered on connection.
     *
     * ```kotlin
     * resources(mapOf("heart" to "<svg>...</svg>", "search" to "<svg>...</svg>"))
     * ```
     */
    fun resources(map: Map<String, String>) {
        val json = buildJsonObject {
            map.forEach { (k, v) -> put(k, v) }
        }
        resourceJsonList.add(json.toString())
    }

    /**
     * Register resources from a JSON file containing a flat name → SVG map.
     * The file should be a JSON object like `{"heart": "<svg>...</svg>"}`.
     *
     * ```kotlin
     * resourcesFile("../resources.json")
     * ```
     */
    fun resourcesFile(path: String) {
        val content = java.io.File(path).readText()
        resourceJsonList.add(content)
    }

    /**
     * Load every `.svg` file in `dir` and register its contents as a resource
     * keyed by the filename without extension.
     *
     * For example, `arrow-right.svg` → `@resources.arrow-right` in the DSL.
     *
     * SVG parsing is delegated to the Rust engine, so the Kotlin side is a
     * dumb filesystem reader — this method just ships a flat `{name: svg}`
     * JSON map per session.
     *
     * ```kotlin
     * resourcesDir("./icons")
     * ```
     */
    fun resourcesDir(dir: String) {
        val files = java.io.File(dir).listFiles { _, n -> n.endsWith(".svg") } ?: return
        val json = buildJsonObject {
            files.forEach { file ->
                put(file.nameWithoutExtension, file.readText(Charsets.UTF_8))
            }
        }
        resourceJsonList.add(json.toString())
    }

    /**
     * Watch a directory for `.hypen` component file changes.
     * When files change, every hello-driven connection is closed with 1012
     * ("service restart", as the TS server's hot reload): the client
     * reconnects with its session id, the session resumes, and a new engine
     * built from the changed sources sends a fresh `initialTree`. Legacy
     * [HypenServer.handleConnect] connections, which have no socket handle,
     * receive the re-rendered tree as one `patch` replacing the old one.
     *
     * ```kotlin
     * watchComponents("./components")
     * watchComponents("./components") {
     *     debounceMs = 200
     *     recursive = true
     * }
     * ```
     */
    fun watchComponents(dir: String, block: (ComponentWatchConfig.() -> Unit)? = null) {
        watchDir = dir
        if (block != null) {
            watchConfig = ComponentWatchConfig().apply(block)
        }
    }
}

/**
 * Builder for SessionConfig within HypenServer DSL.
 */
class SessionConfigBuilder {
    var ttl: Long = 3600
    var concurrent: ConcurrentPolicy = ConcurrentPolicy.KICK_OLD

    fun build(): SessionConfig = SessionConfig(
        ttl = ttl,
        concurrent = concurrent
    )
}
