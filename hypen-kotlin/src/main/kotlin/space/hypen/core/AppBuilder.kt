package space.hypen.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer
import kotlin.reflect.KType
import kotlin.reflect.typeOf

/**
 * Module definition containing all handlers and configuration.
 */
data class ModuleDefinition<T : Any>(
    val name: String?,
    val actions: List<String>,
    val stateKeys: List<String>,
    /**
     * Whether the ManagedRouter should keep this module instance alive
     * across navigations. `null` means "use the default" — which is `true`
     * for any route whose definition resolves to a module. Set explicitly
     * to `false` to opt out and restore per-navigation teardown.
     */
    val persist: Boolean?,
    val version: Int,
    val initialState: T,
    val ui: String?,
    val onCreated: LifecycleHandler<T>?,
    /**
     * Fires every time the module becomes the active route target — once
     * right after `onCreated` on first mount, and again on each re-mount
     * when the ManagedRouter restores a cached instance. Use for data
     * refresh or any "screen became visible" side effects.
     */
    val onActivated: LifecycleHandler<T>?,
    /**
     * Fires every time the module stops being the active route target,
     * before the module is cached for persistence OR before `onDestroyed`
     * if it's being torn down. Use for pausing timers, unsubscribing.
     */
    val onDeactivated: LifecycleHandler<T>?,
    val onDestroyed: LifecycleHandler<T>?,
    val actionHandlers: Map<String, ActionHandler<T>>,
    val onError: ModuleErrorHandler<T>? = null,
    val onDisconnect: DisconnectHandler<T>? = null,
    val onReconnect: ReconnectHandler<T>? = null,
    val onExpire: ExpireHandler? = null,
)

/**
 * Module options for configuration
 */
data class ModuleOptions(
    /**
     * Persist the module instance across route navigations. `null` means
     * "use the default" — which is persist-by-default for any module-backed
     * route. Pass `false` to opt out.
     */
    val persist: Boolean? = null,
    val version: Int = 1,
    val name: String? = null
)

/**
 * Fluent builder for creating Hypen module definitions.
 * Matches the TypeScript HypenAppBuilder API.
 */
class AppBuilder<T : Any>(
    private val initialState: T,
    private val options: ModuleOptions? = null,
    private val appRef: HypenApp? = null
) {
    private var onCreatedHandler: LifecycleHandler<T>? = null
    private var onActivatedHandler: LifecycleHandler<T>? = null
    private var onDeactivatedHandler: LifecycleHandler<T>? = null
    private var onDestroyedHandler: LifecycleHandler<T>? = null
    @PublishedApi
    internal val actionHandlers = mutableMapOf<String, ActionHandler<T>>()
    private var errorHandler: ModuleErrorHandler<T>? = null
    private var disconnectHandler: DisconnectHandler<T>? = null
    private var reconnectHandler: ReconnectHandler<T>? = null
    private var expireHandler: ExpireHandler? = null
    private var ui: String? = null

    /**
     * Register a handler to be called when the module is created
     */
    fun onCreated(handler: LifecycleHandler<T>): AppBuilder<T> {
        onCreatedHandler = handler
        return this
    }

    /**
     * Register a handler that runs every time the module becomes the
     * active route target.
     *
     * Unlike [onCreated], which only runs once per module instance,
     * [onActivated] runs on **every** mount — the first one (right after
     * `onCreated`) and every subsequent re-entry when the ManagedRouter
     * restores a cached instance. Use for data refresh, re-connecting
     * subscriptions, or any "screen became visible" side effect.
     */
    fun onActivated(handler: LifecycleHandler<T>): AppBuilder<T> {
        onActivatedHandler = handler
        return this
    }

    /**
     * Register a handler that runs every time the module stops being the
     * active route target.
     *
     * Runs before the module is cached for persistence OR before
     * [onDestroyed] if the module is being torn down. Use for pausing
     * timers, unsubscribing from ephemeral streams, etc.
     */
    fun onDeactivated(handler: LifecycleHandler<T>): AppBuilder<T> {
        onDeactivatedHandler = handler
        return this
    }

    /**
     * Register a handler to be called when the module is destroyed
     */
    fun onDestroyed(handler: LifecycleHandler<T>): AppBuilder<T> {
        onDestroyedHandler = handler
        return this
    }

    /**
     * Register an action handler (untyped — payload is raw JsonElement?)
     */
    fun onAction(name: String, handler: ModuleActionHandler<T>): AppBuilder<T> {
        actionHandlers[name] = ActionHandler.Sync(handler)
        return this
    }

    /**
     * Register a typed action handler.
     * The action payload is automatically deserialized from JSON into type [P].
     *
     * Example:
     * ```kotlin
     * data class AddPayload(val amount: Int)
     *
     * app.defineState(mapOf("count" to 0))
     *     .onAction<AddPayload>("add") { ctx, payload ->
     *         val current = ctx.state.get("count") as? Int ?: 0
     *         ctx.state.set("count", current + (payload?.amount ?: 0))
     *     }
     * ```
     */
    inline fun <reified P> onAction(
        name: String,
        noinline handler: (ActionHandlerContext<T>, P?) -> Unit
    ): AppBuilder<T> {
        val payloadType = typeOf<P>()
        actionHandlers[name] = ActionHandler.Sync { ctx ->
            val typed = ctx.action.payload?.let { deserializePayload<P>(it, payloadType) }
            handler(ctx, typed)
        }
        return this
    }

    /**
     * Register an error handler for the module.
     * Called when any error occurs in action handlers or lifecycle hooks.
     *
     * ```kotlin
     * app.defineState(mapOf("count" to 0))
     *     .onAction("increment") { ctx -> ctx.state.set("count", 1) }
     *     .onError { ctx ->
     *         println("Error in ${ctx.actionName ?: ctx.lifecycle}: ${ctx.error.message}")
     *         ErrorHandlerResult.Handled // suppress the error
     *     }
     *     .build()
     * ```
     */
    fun onError(handler: ModuleErrorHandler<T>): AppBuilder<T> {
        errorHandler = handler
        return this
    }

    /**
     * Register a suspend (async) action handler.
     * The handler runs in the module's coroutine scope.
     */
    fun onActionAsync(name: String, handler: SuspendModuleActionHandler<T>): AppBuilder<T> {
        actionHandlers[name] = ActionHandler.Suspend(handler)
        return this
    }

    /**
     * Register a handler called when the client disconnects.
     */
    fun onDisconnect(handler: DisconnectHandler<T>): AppBuilder<T> {
        disconnectHandler = handler
        return this
    }

    /**
     * Register a handler called when a client reconnects to a suspended session.
     */
    fun onReconnect(handler: ReconnectHandler<T>): AppBuilder<T> {
        reconnectHandler = handler
        return this
    }

    /**
     * Register a handler called when a suspended session expires.
     */
    fun onExpire(handler: ExpireHandler): AppBuilder<T> {
        expireHandler = handler
        return this
    }

    /**
     * Set the UI template
     */
    fun ui(template: String): AppBuilder<T> {
        this.ui = template
        return this
    }

    /**
     * Load a UI template from a .hypen file on disk.
     *
     * ```kotlin
     * val counter = app.defineState(mapOf("count" to 0))
     *     .onAction("increment") { ctx -> ... }
     *     .uiFile("src/main/resources/counter.hypen")
     * ```
     */
    fun uiFile(path: String): ModuleDefinition<T> {
        this.ui = File(path).readText().trim()
        return build()
    }

    /**
     * Load a UI template from a JVM classpath resource.
     * Files in `src/main/resources/` are bundled into the JAR at compile time.
     *
     * ```kotlin
     * // Given src/main/resources/templates/counter.hypen:
     * val counter = app.defineState(mapOf("count" to 0))
     *     .onAction("increment") { ctx -> ... }
     *     .uiResource("/templates/counter.hypen")
     * ```
     */
    fun uiResource(resourcePath: String): ModuleDefinition<T> {
        val stream = this::class.java.getResourceAsStream(resourcePath)
            ?: throw IllegalArgumentException("Resource not found: $resourcePath")
        this.ui = stream.bufferedReader().readText().trim()
        return build()
    }

    /**
     * Build the module definition.
     * If the builder was created via HypenApp.defineState() or HypenApp.module()
     * and the module has a name, the definition is automatically registered.
     */
    fun build(): ModuleDefinition<T> {
        val stateKeys = when (initialState) {
            is Map<*, *> -> initialState.keys.map { it.toString() }
            else -> listOf("value")
        }

        val definition = ModuleDefinition(
            name = options?.name,
            actions = actionHandlers.keys.toList(),
            stateKeys = stateKeys,
            persist = options?.persist,
            version = options?.version ?: 1,
            initialState = initialState,
            ui = ui,
            onCreated = onCreatedHandler,
            onActivated = onActivatedHandler,
            onDeactivated = onDeactivatedHandler,
            onDestroyed = onDestroyedHandler,
            actionHandlers = actionHandlers.toMap(),
            onError = errorHandler,
            onDisconnect = disconnectHandler,
            onReconnect = reconnectHandler,
            onExpire = expireHandler,
        )

        // Auto-register in the app registry when the module has a name
        val name = options?.name
        if (!name.isNullOrEmpty() && appRef != null) {
            appRef.register(name, definition)
        }

        return definition
    }

    companion object {
        /**
         * Create a new AppBuilder with initial state
         */
        fun <T : Any> defineState(initialState: T, options: ModuleOptions? = null): AppBuilder<T> {
            return AppBuilder(initialState, options)
        }
    }
}

/**
 * Singleton app instance — factory and component registry.
 *
 * Modules built with a name are automatically registered here.
 * Consumers (ManagedRouter, ComponentResolver) read from this registry
 * instead of requiring a separate ModuleRegistry instance.
 */
object HypenApp {
    private val registry = java.util.concurrent.ConcurrentHashMap<String, ModuleDefinition<*>>()

    /**
     * Define state and get a builder for the module.
     * Named modules are auto-registered on build().
     */
    fun <T : Any> defineState(initialState: T, options: ModuleOptions? = null): AppBuilder<T> {
        return AppBuilder(initialState, options, this)
    }

    /**
     * Convenience: start a module builder with a name pre-set.
     *
     * ```kotlin
     * app.module("Settings").defineState(mapOf("theme" to "dark")).build()
     * ```
     */
    fun module(name: String): ModuleHelper {
        return ModuleHelper(name, this)
    }

    // -------------------------------------------------------------------------
    // Registry API
    // -------------------------------------------------------------------------

    /** Register a module definition under a component name. */
    fun register(name: String, definition: ModuleDefinition<*>) {
        registry[name] = definition
    }

    /** Get a module definition by component name, or null if not found. */
    fun get(name: String): ModuleDefinition<*>? {
        return registry[name]
    }

    /** Check if a module definition exists for the given name. */
    fun has(name: String): Boolean {
        return registry.containsKey(name)
    }

    /** Get all registered component names. */
    fun getNames(): List<String> {
        return registry.keys.toList()
    }

    /** Get all registered definitions. */
    fun getAll(): Map<String, ModuleDefinition<*>> {
        return registry.toMap()
    }

    /** Unregister a module definition. */
    fun unregister(name: String) {
        registry.remove(name)
    }

    /** Number of registered definitions. */
    val size: Int get() = registry.size

    /** Clear all registered definitions. */
    fun clear() {
        registry.clear()
    }

    /**
     * Helper returned by [module] for fluent API with pre-set name.
     */
    class ModuleHelper(private val name: String, private val app: HypenApp) {
        fun <T : Any> defineState(initialState: T, options: ModuleOptions? = null): AppBuilder<T> {
            val mergedOptions = ModuleOptions(
                name = name,
                persist = options?.persist,
                version = options?.version ?: 1
            )
            return AppBuilder(initialState, mergedOptions, app)
        }
    }
}

/**
 * Global app instance for convenient access.
 * Usage: app.defineState(initialState).onAction("action") { ... }.build()
 */
val app = HypenApp

/**
 * Create nested module instances for all registered modules in the app that
 * haven't been instantiated yet. Returns a map of name to NestedModuleInstance.
 *
 * Nested modules register themselves via [IEngine.registerModule] instead of
 * [IEngine.setModule], so the primary module's engine slot is preserved, and
 * forward their state changes to the engine under a named scope via
 * [IEngine.updateState].
 */
fun createNestedModuleInstances(
    engine: IEngine,
    app: HypenApp,
    globalContext: HypenGlobalContext,
    routerContext: RouterContext? = null
): Map<String, NestedModuleInstance<*>> {
    val instances = mutableMapOf<String, NestedModuleInstance<*>>()

    for (name in app.getNames()) {
        val moduleId = name.lowercase()
        if (globalContext.hasModule(moduleId)) continue

        val def = app.get(name) ?: continue

        // Skip stateless modules (no state, no actions)
        if (def.initialState == null && def.actions.isEmpty() && def.actionHandlers.isEmpty()) continue

        val instance = NestedModuleInstance(engine, def, routerContext, globalContext)
        globalContext.registerNestedModule(moduleId, instance)
        instances[name] = instance
    }

    return instances
}

/**
 * Get merged state from a primary module instance and all nested modules.
 * Returns a single map containing all module states under their prefixed keys.
 *
 * This is the Kotlin equivalent of the TypeScript SDK's getMergedState().
 */
fun getMergedState(
    primaryInstance: ModuleInstance<*>?,
    nestedInstances: Map<String, NestedModuleInstance<*>>
): Map<String, Any?> {
    val merged = mutableMapOf<String, Any?>()

    // Include primary module state
    if (primaryInstance != null) {
        merged.putAll(primaryInstance.getState())
    }

    // Include all nested module states
    for ((_, instance) in nestedInstances) {
        merged.putAll(instance.getState())
    }

    return merged
}

/**
 * Deserialize a JsonElement payload into a typed object.
 * Returns null if deserialization fails.
 */
@Suppress("UNCHECKED_CAST")
fun <P> deserializePayload(payload: JsonElement, type: KType): P? {
    return try {
        Json.decodeFromJsonElement(Json.serializersModule.serializer(type), payload) as? P
    } catch (_: Exception) {
        null
    }
}
