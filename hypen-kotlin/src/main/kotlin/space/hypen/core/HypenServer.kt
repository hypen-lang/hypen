package space.hypen.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.concurrent.ConcurrentHashMap

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

    suspend fun collectPatches(block: () -> Unit): List<Patch> {
        mutex.withLock {
            pendingPatches.clear()
            block()
            val result = pendingPatches.toList()
            pendingPatches.clear()
            return result
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
 * ```kotlin
 * val server = HypenServer {
 *     module("Counter", counterModule)
 *     module("Profile", profileModule)
 *     route("/counter", "Counter")
 *     route("/profile", "Profile")
 *     session { ttl = 300 }
 * }
 *
 * // In Ktor:
 * fun Application.module() {
 *     server.install(this)
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
     * When true, [handleConnect] builds a per-session [ManagedRouter]
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
    }

    /**
     * Handle a new WebSocket client connection.
     * Creates a per-client engine + module instance.
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
                            return msg
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

        // Set render callback
        engine.setRenderCallback { patches ->
            clientState.pendingPatches.addAll(patches)
        }

        clientState.sendMessage = sendMessage
        clients[connectionKey] = clientState

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

        // If restored, apply saved state
        if (isRestored && savedState != null) {
            val client = clients[connectionKey]
            if (client != null) {
                @Suppress("UNCHECKED_CAST")
                (client.moduleInstance as? ModuleInstance<Any>)?.handleReconnect(
                    session.toSessionInfo(),
                    savedState
                )
            }
        }

        // Render initial tree
        val patches = renderFullTree(connectionKey)

        // Build session ack + initial tree message
        val ackMessage = buildJsonObject {
            put("type", "sessionAck")
            put("sessionId", session.id)
            put("isNew", !isRestored)
            put("isRestored", isRestored)
        }
        sendMessage(ackMessage.toString())

        val initialTreeMessage = buildJsonObject {
            put("type", "initialTree")
            put("module", routeDefinitions.firstOrNull()?.component ?: "")
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

        return initialTreeMessage.toString()
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
        val msg = try {
            Json.decodeFromString<JsonObject>(message)
        } catch (e: Exception) {
            log.warn("Invalid message from client: $message")
            return
        }

        val type = msg["type"]?.jsonPrimitive?.contentOrNull ?: return

        when (type) {
            "hello" -> {
                // Hello message for session handshake (handled in handleConnect for simplicity)
                val sid = msg["sessionId"]?.jsonPrimitive?.contentOrNull
                val msgProps = msg["props"]?.let {
                    if (it is JsonObject) it.mapValues { (_, v) -> v.toKotlinValue() }
                    else emptyMap()
                } ?: emptyMap()
                // Session already established in handleConnect
                log.debug("Hello from session $sid")
            }

            "navigate" -> {
                val path = msg["path"]?.jsonPrimitive?.contentOrNull ?: return
                val client = clients[connectionKey] ?: return

                // Under the auto-wired ManagedRouter, navigation is
                // driven through the session's HypenRouter so it hits
                // the same mount/unmount lifecycle as `@router.push`
                // coming from the DSL. Engine patches are collected
                // under `collectPatches` rather than via renderFullTree.
                val managed = managedRouters[connectionKey]
                if (managed != null) {
                    val patches = client.collectPatches {
                        client.engine.dispatchAction(
                            "router.push",
                            mapOf("to" to path)
                        )
                    }
                    client.currentRoute = path
                    client.revision++
                    if (patches.isNotEmpty()) {
                        val response = buildJsonObject {
                            put("type", "patch")
                            putJsonArray("patches") {
                                patches.forEach { add(Json.encodeToJsonElement(it)) }
                            }
                            put("revision", client.revision)
                        }
                        sendMessage(response.toString())
                    }
                    events.emit(HypenEvents.routeChanged, HypenEvents.RouteChanged(null, path))
                    return
                }

                mountRouteForClient(connectionKey, path)
                val patches = renderFullTree(connectionKey)

                val response = buildJsonObject {
                    put("type", "render")
                    put("route", path)
                    putJsonArray("patches") {
                        patches.forEach { add(Json.encodeToJsonElement(it)) }
                    }
                    putJsonArray("routes") {
                        routeDefinitions.forEach { add(it.path) }
                    }
                }
                sendMessage(response.toString())

                events.emit(HypenEvents.routeChanged, HypenEvents.RouteChanged(null, path))
            }

            "dispatchAction", "action" -> {
                val actionName = msg["action"]?.jsonPrimitive?.contentOrNull
                    ?: msg["name"]?.jsonPrimitive?.contentOrNull
                    ?: return
                val payload = msg["payload"]?.takeIf { it !is JsonNull }

                val client = clients[connectionKey] ?: return

                val patches = client.collectPatches {
                    client.engine.dispatchAction(actionName, payload)
                }
                client.revision++

                if (patches.isNotEmpty()) {
                    val response = buildJsonObject {
                        put("type", "patch")
                        putJsonArray("patches") {
                            patches.forEach { add(Json.encodeToJsonElement(it)) }
                        }
                        put("revision", client.revision)
                    }
                    sendMessage(response.toString())
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
        val client = clients.remove(connectionKey) ?: return

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
        clients.values.forEach { client ->
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
     * Re-registers updated components on all client engines and pushes a full re-render.
     */
    private suspend fun handleComponentChanges(changes: ComponentChanges) {
        if (changes.isEmpty()) return

        log.info(
            "Component changes: +${changes.added.size} ~${changes.updated.size} -${changes.removed.size}"
        )

        for ((key, client) in clients) {
            // Register new/updated components
            for (component in changes.added + changes.updated) {
                try {
                    client.engine.registerComponent(component.name, component.template, component.hypenPath)
                } catch (e: Exception) {
                    log.warn("Failed to register component '${component.name}' for session ${client.sessionId}", e.message ?: "")
                }
            }

            // Re-render: clear tree, re-mount current route, send full render
            val patches = reRenderClient(key)
            val send = client.sendMessage ?: continue
            if (patches.isNotEmpty()) {
                val message = buildJsonObject {
                    put("type", "render")
                    put("route", client.currentRoute)
                    putJsonArray("patches") {
                        patches.forEach { add(Json.encodeToJsonElement(it)) }
                    }
                    putJsonArray("routes") {
                        routeDefinitions.forEach { add(it.path) }
                    }
                }
                try {
                    send(message.toString())
                } catch (_: Exception) { /* client may have disconnected */ }
            }
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
        if ("location" in primaryDef.stateKeys) {
            hypenRouter.onNavigate { _, to ->
                try {
                    client.engine.updateState("", listOf("location"), mapOf("location" to to))
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

        // Destroy current module instance and nested modules
        client.moduleInstance.destroy()
        client.nestedModules.values.forEach { it.destroy() }
        client.nestedModules.clear()
        client.engine.clearTree()

        // Look up module definition
        val definition = matched.module ?: modules[matched.component] ?: HypenApp.get(matched.component) ?: return

        @Suppress("UNCHECKED_CAST")
        val namedDef = if (definition.name.isNullOrEmpty()) {
            (definition as ModuleDefinition<Any>).copy(name = matched.component)
        } else {
            definition
        }

        // Create a global context for cross-module communication
        val globalContext = HypenGlobalContext()
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
     * When files change, all connected clients are re-rendered automatically.
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
