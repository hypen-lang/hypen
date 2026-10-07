package space.hypen.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import space.hypen.remote.device.DeviceContext
import space.hypen.remote.device.DeviceOwner
import space.hypen.remote.device.DevicePlane
import space.hypen.remote.device.DeviceProvenance
import java.util.UUID
import kotlin.math.floor

/**
 * Shared base for [ModuleInstance] and [NestedModuleInstance].
 *
 * Both concrete types do 95%+ of the same work: create an [ObservableState],
 * register sync and suspend action handlers against the engine, wire the
 * `__hypen_bind` two-way-binding action, invoke the `onCreated` lifecycle
 * callback, and forward state mutations back to the engine. The only things
 * that differ are:
 *
 *   - `engineScope`:     `""` for primary modules (they own the engine's
 *                        primary module slot), or `definition.name` for
 *                        nested modules that bind to named state scopes.
 *   - `registerFn`:      `engine.setModule(...)` for primary modules,
 *                        `engine.registerModule(...)` for nested ones.
 *   - `anonymousFallback`: name used when `definition.name` is null.
 *   - `lifecyclePrefix`: log-message prefix (`"Module"` vs `"Nested module"`).
 *
 * Those four knobs are passed in as primary-constructor parameters so they're
 * already bound by the time this class's `init {}` block runs. No abstract
 * members are accessed during construction — avoiding Kotlin's "open member
 * called from base constructor" pitfall.
 *
 * The concrete [ModuleInstance] and [NestedModuleInstance] types stay as
 * distinct public classes — callers, tests, and downstream SDK consumers
 * construct them directly via their existing constructors.
 */
abstract class BaseModuleInstance<T : Any> protected constructor(
    protected val engine: IEngine,
    protected val definition: ModuleDefinition<T>,
    protected val routerContext: RouterContext?,
    protected val globalContext: GlobalContext?,
    protected val scope: CoroutineScope?,
    protected val engineScope: String,
    private val lifecyclePrefix: String,
    anonymousFallback: String,
    registerFn: (
        name: String,
        actions: List<String>,
        stateKeys: List<String>,
        initial: Map<String, Any?>,
    ) -> Unit,
) {
    protected val observableState: ObservableState<T>

    /** The name this instance registered its module and actions under in the engine. */
    internal val engineModuleName: String = definition.name ?: anonymousFallback
    private val stateChangeListeners = mutableListOf<() -> Unit>()
    private var isDestroyed = false
    /**
     * True when the module is currently the active route target (i.e.
     * `onActivated` has fired more recently than `onDeactivated`). Used
     * to make [activate] / [deactivate] idempotent so the ManagedRouter
     * can call them safely regardless of current state.
     */
    private var isActive = false
    private val log = HypenLoggers.module

    /** Lazily created fallback scope, owned by this instance and cancelled in destroy(). */
    private val fallbackScope: CoroutineScope by lazy {
        CoroutineScope(Dispatchers.IO + SupervisorJob())
    }
    private var fallbackScopeCreated = false

    /**
     * Device Capability Protocol identity (RFC 001 §2.7): an opaque,
     * per-instance id carried as the owner of every device request this
     * module issues. Deactivation sweeps exactly this instance's current
     * activation; destruction sweeps all of its work.
     */
    val deviceInstanceId: String = "mi-" + UUID.randomUUID()

    /** Current activation id (strictly increasing; 0 = never activated). */
    @Volatile
    private var activationId: UInt = 0u

    /** The connection's device plane, if any (bound at construction or via [attachDevice]). */
    @Volatile
    private var devicePlane: DevicePlane? =
        ((globalContext as? DeviceScopedGlobalContext)?.shared ?: globalContext).let { (it as? HypenGlobalContext)?.devicePlane }

    /** >0 while [runReplayed] runs on this thread: handler contexts built then carry replay provenance. */
    private val replayDepth = ThreadLocal.withInitial { 0 }

    init {
        // Create observable state from initial state
        @Suppress("UNCHECKED_CAST")
        val initialStateMap = when (val state = definition.initialState) {
            is Map<*, *> -> state.mapKeys { it.key.toString() } as Map<String, Any?>
            else -> mapOf("value" to state)
        }

        observableState = ObservableState(definition.initialState) { change ->
            // Forward raw (unprefixed) paths to the engine with this module's scope.
            engine.updateState(engineScope, change.paths, change.newValues)
            // Notify local listeners
            stateChangeListeners.forEach { it() }
        }

        // Register with engine (primary slot for ModuleInstance,
        // named slot for NestedModuleInstance)
        registerFn(
            definition.name ?: anonymousFallback,
            definition.actions,
            definition.stateKeys,
            initialStateMap,
        )

        // Register action handlers. Sync handlers run on the calling thread;
        // suspend handlers launch in the module's coroutine scope (or a
        // shared fallback scope when none was provided, to avoid
        // deadlocking the server thread with runBlocking).
        definition.actionHandlers.forEach { (actionName, entry) ->
            engine.onAction("__hypen_scoped:${engineScope.lowercase()}:" + actionName) { action ->
                if (isDestroyed) return@onAction
                // Owner authority and provenance are fixed right now, when
                // the dispatch arrives (RFC 001 §2.7 / §1.7).
                val device = createDeviceContext()
                val context = ActionHandlerContext(
                    action = action.copy(name = actionName),
                    state = observableState,
                    context = globalContext,
                    router = routerContext?.router,
                    device = device,
                )
                when (entry) {
                    is ActionHandler.Sync<T> -> {
                        try {
                            entry.handler(context)
                        } catch (e: Exception) {
                            if (handleError(e, actionName = actionName)) {
                                throw e
                            }
                        }
                    }
                    is ActionHandler.Suspend<T> -> {
                        val cs = scope ?: run { fallbackScopeCreated = true; fallbackScope }
                        // A suspend handler is a device handler scope
                        // (RFC 001 §2.4): unary requests it leaves pending
                        // when it returns are cancelled.
                        device.beginHandlerScope()
                        cs.launch {
                            try {
                                entry.handler(context)
                            } catch (e: Exception) {
                                if (handleError(e, actionName = actionName)) {
                                    throw e
                                }
                            } finally {
                                device.endHandlerScope()
                            }
                        }
                    }
                }
            }
        }

        // Auto-register __hypen_bind for .bind() two-way binding support
        engine.onAction("__hypen_scoped:${engineScope.lowercase()}:" + "__hypen_bind") { action ->
            if (!isDestroyed) {
                val payload = action.payload
                if (payload is JsonObject) {
                    val path = (payload["path"] as? JsonPrimitive)?.content ?: return@onAction
                    val value = payload["value"]?.toKotlinValue()
                    observableState.set(path, value)
                }
            }
        }

        // Auto-register the reserved drag-and-drop outcome actions
        // (hypen-web/docs/dnd.md). Both go through ObservableState —
        // never the engine directly — so change notification, persistence
        // and typed syncBack all see the write. Malformed payloads warn and
        // degrade to a no-op; author input never throws.
        //
        engine.onAction("__hypen_scoped:${engineScope.lowercase()}:" + HypenDnd.REORDER_ACTION) { action ->
            if (!isDestroyed) handleReorder(action)
        }
        engine.onAction("__hypen_scoped:${engineScope.lowercase()}:" + HypenDnd.PIN_ACTION) { action ->
            if (!isDestroyed) handlePin(action)
        }

        // Call onCreated lifecycle handler
        if (definition.onCreated != null) {
            try {
                definition.onCreated.invoke(observableState, lifecycleContext())
            } catch (e: Exception) {
                if (handleError(e, lifecycle = "created")) {
                    throw e
                }
            }
        }

        log.debug("$lifecyclePrefix '${definition.name ?: "anonymous"}' created")
    }

    /**
     * `__hypen_reorder {fromPath, from, toPath, to}` — `path` is accepted as
     * shorthand for `fromPath == toPath`. `to` is the moved item's FINAL
     * index; semantics are `portable::path_move` via [ObservableState.move].
     */
    private fun handleReorder(action: Action) {
        val payload = action.payload as? JsonObject
        if (payload == null) {
            log.warn("${HypenDnd.REORDER_ACTION}: missing payload")
            return
        }
        val fromPath = payload.stringField("fromPath") ?: payload.stringField("path")
        val toPath = payload.stringField("toPath") ?: fromPath
        val from = payload.intField("from")
        val to = payload.intField("to")
        if (fromPath == null || toPath == null || from == null || to == null) {
            log.warn("${HypenDnd.REORDER_ACTION}: malformed payload $payload")
            return
        }
        if (!observableState.move(fromPath, from, toPath, to)) {
            log.warn(
                "${HypenDnd.REORDER_ACTION}: no-op — \"$fromPath\"[$from] → \"$toPath\"[$to] " +
                    "does not resolve to arrays / in-range index",
            )
        }
    }

    /**
     * `__hypen_pin {path, x, y, xKey?, yKey?}` — two path sets
     * (`path.xKey`, `path.yKey`) issued as ONE [ObservableState.update] so
     * they reach the engine in a single batch. Missing intermediates
     * auto-vivify, so the first pin of a reserved-mode key creates
     * `__dnd.<group>.<key>`.
     */
    private fun handlePin(action: Action) {
        val payload = action.payload as? JsonObject
        if (payload == null) {
            log.warn("${HypenDnd.PIN_ACTION}: missing payload")
            return
        }
        val path = payload.stringField("path")?.takeIf { it.isNotEmpty() }
        val x = payload.finiteNumberField("x")
        val y = payload.finiteNumberField("y")
        if (path == null || x == null || y == null) {
            log.warn("${HypenDnd.PIN_ACTION}: malformed payload $payload")
            return
        }
        val xKey = payload.stringField("xKey")?.takeIf { it.isNotEmpty() } ?: "x"
        val yKey = payload.stringField("yKey")?.takeIf { it.isNotEmpty() } ?: "y"
        observableState.update(
            linkedMapOf(
                "$path.$xKey" to x,
                "$path.$yKey" to y,
            ),
        )
    }

    private fun JsonObject.stringField(name: String): String? =
        (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** Integral JSON number (`3`, `3.0`); anything else → null. */
    private fun JsonObject.intField(name: String): Int? {
        val prim = (this[name] as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
        prim.content.toIntOrNull()?.let { return it }
        val d = prim.content.toDoubleOrNull() ?: return null
        if (!d.isFinite() || d != floor(d) || d < Int.MIN_VALUE || d > Int.MAX_VALUE) return null
        return d.toInt()
    }

    /** Finite JSON number, kept as Int when integral so it round-trips like author state. */
    private fun JsonObject.finiteNumberField(name: String): Number? {
        val prim = (this[name] as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
        val value = prim.toKotlinValue() as? Number ?: return null
        return when (value) {
            is Double -> value.takeIf { it.isFinite() }
            is Float -> value.takeIf { it.isFinite() }
            else -> value
        }
    }

    /**
     * Route an error through the module's onError handler.
     * Returns true if the error should be rethrown.
     */
    private fun handleError(
        error: Throwable,
        actionName: String? = null,
        lifecycle: String? = null,
    ): Boolean {
        val ctx = ErrorContext(
            error = error,
            state = observableState,
            actionName = actionName,
            lifecycle = lifecycle,
        )

        // Call module-level error handler if defined
        if (definition.onError != null) {
            val result = try {
                definition.onError.invoke(ctx)
            } catch (handlerError: Exception) {
                // Error in error handler — fall through to default behavior
                null
            }

            when (result) {
                is ErrorHandlerResult.Handled -> return false
                is ErrorHandlerResult.Rethrow -> return true
                else -> { /* fall through to default behavior */ }
            }
        }

        // Default behavior: log the error
        val context = when {
            actionName != null -> "action:$actionName"
            lifecycle != null -> "lifecycle:$lifecycle"
            else -> "unknown"
        }
        System.err.println("[$context] $lifecyclePrefix error: ${error.message}")

        return false
    }

    /**
     * Add a listener for state changes
     */
    fun onStateChange(callback: () -> Unit) {
        stateChangeListeners.add(callback)
    }

    /**
     * Remove a state change listener
     */
    fun removeStateChangeListener(callback: () -> Unit) {
        stateChangeListeners.remove(callback)
    }

    /**
     * Get a snapshot of the current state
     */
    fun getState(): Map<String, Any?> {
        return observableState.getAll()
    }

    /**
     * Get the live observable state
     */
    fun getLiveState(): ObservableState<T> {
        return observableState
    }

    /**
     * Update state with a partial update
     */
    fun updateState(patch: Map<String, Any?>) {
        observableState.update(patch)
    }

    /**
     * Mark the module as the active route target and fire [onActivated].
     *
     * Idempotent: calling `activate()` on an already-active module is a
     * no-op. Called by [ManagedRouter] on every route mount — both fresh
     * constructions and re-mounts from the persistence cache.
     */
    fun activate() {
        if (isDestroyed || isActive) return
        isActive = true
        // Activation authority becomes available BEFORE onActivated runs
        // (RFC 001 §2.7): a fresh activation id owns this activation's
        // device work, registered with the connection's broker.
        activationId += 1u
        devicePlane?.ownerActivated(deviceInstanceId, activationId)
        definition.onActivated?.let { handler ->
            try {
                handler.invoke(observableState, lifecycleContext())
            } catch (e: Exception) {
                if (handleError(e, lifecycle = "activated")) {
                    throw e
                }
            }
        }
    }

    /**
     * Mark the module as no longer the active route target and fire
     * [onDeactivated].
     *
     * Idempotent: calling `deactivate()` on an inactive module is a no-op.
     * Called by [ManagedRouter] before persisting a module for later reuse
     * OR before destroying it.
     */
    fun deactivate() {
        if (isDestroyed || !isActive) return
        isActive = false
        // Authority is revoked BEFORE onDeactivated executes (RFC 001
        // §2.7): every device request owned by this activation is cancelled.
        devicePlane?.ownerDeactivated(deviceInstanceId, activationId)
        definition.onDeactivated?.let { handler ->
            try {
                handler.invoke(observableState, lifecycleContext())
            } catch (e: Exception) {
                if (handleError(e, lifecycle = "deactivated")) {
                    throw e
                }
            }
        }
    }

    /**
     * Whether the module is currently the active route target.
     */
    fun isActive(): Boolean = isActive

    /**
     * Invoke the disconnect lifecycle handler.
     * Called by the server when a client disconnects.
     */
    fun handleDisconnect(session: SessionInfo) {
        if (isDestroyed) return
        definition.onDisconnect?.let { handler ->
            try {
                handler(DisconnectContext(observableState, session))
            } catch (e: Exception) {
                if (handleError(e, lifecycle = "disconnect")) throw e
            }
        }
    }

    /**
     * Invoke the reconnect lifecycle handler.
     * Called by the server when a client reconnects to a suspended session.
     */
    fun handleReconnect(session: SessionInfo, savedState: Map<String, Any?>) {
        if (isDestroyed) return
        val handler = definition.onReconnect
        if (handler == null) {
            // No handler: restore the suspended state automatically, as the TS
            // server's `triggerReconnect` does — resuming a session and then
            // discarding the state it was suspended with would make resume a
            // no-op. Defining `onReconnect` takes over the decision (call
            // `restore()` yourself, or don't).
            observableState.update(savedState)
            return
        }
        try {
            handler(ReconnectContext(session) { restoredState ->
                observableState.update(restoredState)
            })
        } catch (e: Exception) {
            if (handleError(e, lifecycle = "reconnect")) throw e
        }
    }

    /**
     * Invoke the expire lifecycle handler.
     * Called by the server when a suspended session's TTL expires.
     */
    fun handleExpire(session: SessionInfo) {
        definition.onExpire?.let { handler ->
            try {
                handler(ExpireContext(session))
            } catch (e: Exception) {
                if (handleError(e, lifecycle = "expire")) throw e
            }
        }
    }

    /**
     * Destroy the module instance
     */
    fun destroy() {
        if (isDestroyed) return

        // If this module is still marked as active (destroy() called
        // without a preceding deactivate()), fire onDeactivated first so
        // the lifecycle order is always:
        // ...onActivated → onDeactivated → onDestroyed
        if (isActive) {
            deactivate()
        }

        isDestroyed = true

        // Destruction sweeps every device request this instance owns,
        // including background-lifetime work (RFC 001 §2.7).
        devicePlane?.ownerDestroyed(deviceInstanceId)

        // Call onDestroyed lifecycle handler
        if (definition.onDestroyed != null) {
            try {
                definition.onDestroyed.invoke(observableState, lifecycleContext())
            } catch (e: Exception) {
                if (handleError(e, lifecycle = "destroyed")) {
                    throw e
                }
            }
        }

        // Cancel the fallback scope if it was created by this instance
        if (fallbackScopeCreated) {
            fallbackScope.cancel()
        }

        // Clear listeners
        stateChangeListeners.clear()
        log.debug("$lifecyclePrefix '${definition.name ?: "anonymous"}' destroyed")
    }

    /**
     * Check if the module has been destroyed
     */
    fun isDestroyed(): Boolean = isDestroyed

    // ---- Device Capability Protocol (RFC 001 §2.7 / §4) --------------------

    /**
     * Bind this instance to a connection's device plane (or unbind with
     * `null`). The plane is the connection's; the instance only contributes
     * ownership: a currently active instance registers its live activation
     * right away.
     */
    fun attachDevice(plane: DevicePlane?) {
        devicePlane = plane
        if (plane != null && isActive && !isDestroyed) {
            plane.ownerActivated(deviceInstanceId, activationId)
        }
    }

    /** The device plane this instance is bound to, if any. */
    fun devicePlane(): DevicePlane? = devicePlane

    /**
     * Run [block] as a replayed dispatch (e.g. a synced/broadcast fan-out of
     * an action another connection originated). Any handler context
     * constructed synchronously inside carries replay provenance, so its
     * `device` refuses every request with `unavailable` — also after any
     * later suspension (the replay firewall, RFC 001 §1.7).
     */
    fun <R> runReplayed(block: () -> R): R {
        replayDepth.set(replayDepth.get() + 1)
        try {
            return block()
        } finally {
            replayDepth.set(replayDepth.get() - 1)
        }
    }

    /**
     * True while this instance owns live `background`-lifetime device work:
     * such an instance is pinned (a router must not evict it; the broker caps
     * how many modules may be pinned per connection).
     */
    val hasLiveBackgroundDeviceWork: Boolean
        get() {
            val plane = devicePlane ?: return false
            return !isDestroyed && plane.hasBackgroundWork(deviceInstanceId)
        }

    /**
     * The device surface for a handler context constructed right now: owner
     * (this instance + its current activation) and provenance are fixed at
     * this moment.
     */
    fun createDeviceContext(): DeviceContext {
        val provenance = if (replayDepth.get() > 0) DeviceProvenance.REPLAY else DeviceProvenance.ORIGIN
        val owner = DeviceOwner(deviceInstanceId, activationId)
        val plane = devicePlane ?: return DeviceContext(null, owner, provenance, "device-disabled")
        if (!isActive || isDestroyed) {
            // Calls from onCreated before the first activation, or from
            // deactivation/destruction callbacks, fail `unavailable` at once
            // instead of waiting for an activation.
            return DeviceContext(plane, owner, provenance, "owner-inactive")
        }
        val captured = activationId
        return DeviceContext(plane, owner, provenance, null) {
            !isDestroyed && isActive && activationId == captured
        }
    }

    /** The [GlobalContext] a lifecycle callback receives: shared context + this module's device. */
    private fun lifecycleContext(): GlobalContext? =
        globalContext?.let { DeviceScopedGlobalContext(it, createDeviceContext()) }
}
