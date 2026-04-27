package space.hypen.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

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
            engine.onAction(actionName) { action ->
                if (isDestroyed) return@onAction
                val context = ActionHandlerContext(
                    action = action,
                    state = observableState,
                    context = globalContext,
                    router = routerContext?.router,
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
                        cs.launch {
                            try {
                                entry.handler(context)
                            } catch (e: Exception) {
                                if (handleError(e, actionName = actionName)) {
                                    throw e
                                }
                            }
                        }
                    }
                }
            }
        }

        // Auto-register __hypen_bind for .bind() two-way binding support
        engine.onAction("__hypen_bind") { action ->
            if (!isDestroyed) {
                val payload = action.payload
                if (payload is JsonObject) {
                    val path = (payload["path"] as? JsonPrimitive)?.content ?: return@onAction
                    val value = payload["value"]?.toKotlinValue()
                    observableState.set(path, value)
                }
            }
        }

        // Call onCreated lifecycle handler
        if (definition.onCreated != null) {
            try {
                definition.onCreated.invoke(observableState, globalContext)
            } catch (e: Exception) {
                if (handleError(e, lifecycle = "created")) {
                    throw e
                }
            }
        }

        log.debug("$lifecyclePrefix '${definition.name ?: "anonymous"}' created")
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
        definition.onActivated?.let { handler ->
            try {
                handler.invoke(observableState, globalContext)
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
        definition.onDeactivated?.let { handler ->
            try {
                handler.invoke(observableState, globalContext)
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
        definition.onReconnect?.let { handler ->
            try {
                handler(ReconnectContext(session) { restoredState ->
                    observableState.update(restoredState)
                })
            } catch (e: Exception) {
                if (handleError(e, lifecycle = "reconnect")) throw e
            }
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

        // Call onDestroyed lifecycle handler
        if (definition.onDestroyed != null) {
            try {
                definition.onDestroyed.invoke(observableState, globalContext)
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
}
