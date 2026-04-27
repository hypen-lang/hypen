package space.hypen.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.serializer
import kotlin.reflect.KParameter
import kotlin.reflect.full.primaryConstructor
import kotlin.reflect.typeOf

/**
 * Hypen Kotlin DSL for building stateful modules.
 *
 * ## Typed DSL (recommended)
 *
 * State is a `@Serializable` data class with `var` fields — mutate directly:
 *
 * ```kotlin
 * @Serializable
 * data class CounterState(var count: Int = 0)
 *
 * sealed interface CounterAction : HypenAction {
 *     data object Increment : CounterAction
 *     data object Decrement : CounterAction
 *     data class Add(val amount: Int) : CounterAction
 * }
 *
 * val counterModule = hypen(CounterState()) {
 *     name("counter")
 *
 *     onAction<CounterAction.Increment> { action, state, context ->
 *         state.count += 1
 *     }
 *
 *     onAction<CounterAction.Add> { action, state, context ->
 *         state.count += action.amount
 *     }
 * }
 * ```
 *
 * ## Untyped DSL
 *
 * ```kotlin
 * val counterModule = hypen {
 *     state { "count" to 0 }
 *     onAction("increment") { ctx ->
 *         val current = ctx.state.get("count") as? Int ?: 0
 *         ctx.state.set("count", current + 1)
 *     }
 * }
 * ```
 */

@DslMarker
annotation class HypenDsl

@HypenDsl
class StateBuilder {
    private val state = mutableMapOf<String, Any?>()

    infix fun String.to(value: Any?) {
        state[this] = value
    }

    operator fun set(key: String, value: Any?) {
        state[key] = value
    }

    internal fun build(): MutableMap<String, Any?> = state
}

// ---------------------------------------------------------------------------
// Untyped DSL (map-based state, string-based actions)
// ---------------------------------------------------------------------------

@HypenDsl
class HypenModuleBuilder {
    private var initialState: MutableMap<String, Any?> = mutableMapOf()
    private var onCreatedHandler: LifecycleHandler<MutableMap<String, Any?>>? = null
    private var onActivatedHandler: LifecycleHandler<MutableMap<String, Any?>>? = null
    private var onDeactivatedHandler: LifecycleHandler<MutableMap<String, Any?>>? = null
    private var onDestroyedHandler: LifecycleHandler<MutableMap<String, Any?>>? = null
    private val actionHandlers = mutableMapOf<String, ActionHandler<MutableMap<String, Any?>>>()
    private var moduleName: String? = null
    private var persist: Boolean? = null
    private var version: Int = 1
    private var ui: String? = null

    fun name(name: String) { moduleName = name }
    fun persist(enabled: Boolean = true) { persist = enabled }
    fun version(version: Int) { this.version = version }
    fun ui(template: String) { ui = template }

    fun state(block: StateBuilder.() -> Unit) {
        initialState = StateBuilder().apply(block).build()
    }

    fun state(initial: Map<String, Any?>) {
        initialState = initial.toMutableMap()
    }

    fun onCreated(handler: LifecycleHandler<MutableMap<String, Any?>>) { onCreatedHandler = handler }
    fun onActivated(handler: LifecycleHandler<MutableMap<String, Any?>>) { onActivatedHandler = handler }
    fun onDeactivated(handler: LifecycleHandler<MutableMap<String, Any?>>) { onDeactivatedHandler = handler }
    fun onDestroyed(handler: LifecycleHandler<MutableMap<String, Any?>>) { onDestroyedHandler = handler }

    fun onAction(name: String, handler: ModuleActionHandler<MutableMap<String, Any?>>) {
        actionHandlers[name] = ActionHandler.Sync(handler)
    }

    /**
     * Load a UI template from a .hypen file on disk
     */
    fun uiFile(path: String) {
        this.ui = java.io.File(path).readText().trim()
    }

    /**
     * Load a UI template from a JVM classpath resource
     */
    fun uiResource(resourcePath: String) {
        val stream = this::class.java.getResourceAsStream(resourcePath)
            ?: throw IllegalArgumentException("Resource not found: $resourcePath")
        this.ui = stream.bufferedReader().readText().trim()
    }

    internal fun build(): ModuleDefinition<MutableMap<String, Any?>> {
        val def = ModuleDefinition(
            name = moduleName,
            actions = actionHandlers.keys.toList(),
            stateKeys = initialState.keys.toList(),
            persist = persist,
            version = version,
            initialState = initialState,
            ui = ui,
            onCreated = onCreatedHandler,
            onActivated = onActivatedHandler,
            onDeactivated = onDeactivatedHandler,
            onDestroyed = onDestroyedHandler,
            actionHandlers = actionHandlers.toMap()
        )
        if (!moduleName.isNullOrEmpty()) {
            HypenApp.register(moduleName!!, def)
        }
        return def
    }
}

fun hypen(block: HypenModuleBuilder.() -> Unit): ModuleDefinition<MutableMap<String, Any?>> {
    return HypenModuleBuilder().apply(block).build()
}

// ---------------------------------------------------------------------------
// Typed DSL (data class state, sealed interface actions)
// ---------------------------------------------------------------------------

/** JSON instance for state (de)serialization — lenient to handle numeric coercion. */
@PublishedApi
internal val hypenJson = Json { isLenient = true; ignoreUnknownKeys = true; coerceInputValues = true; encodeDefaults = true }

/**
 * Typed module builder with direct state access matching the TypeScript SDK.
 *
 * Handlers receive [TypedActionHandlerContext] where `state` is the typed [S]
 * instance. Mutate `var` fields directly — changes are synced back to the
 * reactive engine automatically after the handler returns.
 */
@HypenDsl
class TypedHypenModuleBuilder<S : Any> @PublishedApi internal constructor(
    private val initialState: MutableMap<String, Any?>,
    @PublishedApi internal val stateSerializer: KSerializer<S>
) {
    private var moduleName: String? = null
    private var persist: Boolean? = null
    private var version: Int = 1
    private var ui: String? = null
    private var onCreatedHandler: LifecycleHandler<MutableMap<String, Any?>>? = null
    private var onActivatedHandler: LifecycleHandler<MutableMap<String, Any?>>? = null
    private var onDeactivatedHandler: LifecycleHandler<MutableMap<String, Any?>>? = null
    private var onDestroyedHandler: LifecycleHandler<MutableMap<String, Any?>>? = null
    @PublishedApi
    internal val actionHandlers = mutableMapOf<String, ActionHandler<MutableMap<String, Any?>>>()
    private var errorHandler: ModuleErrorHandler<MutableMap<String, Any?>>? = null
    private var disconnectHandler: DisconnectHandler<MutableMap<String, Any?>>? = null
    private var reconnectHandler: ReconnectHandler<MutableMap<String, Any?>>? = null
    private var expireHandler: ExpireHandler? = null

    fun name(name: String) { moduleName = name }
    fun persist(enabled: Boolean = true) { persist = enabled }
    fun version(version: Int) { this.version = version }
    fun ui(template: String) { ui = template }
    fun onError(handler: ModuleErrorHandler<MutableMap<String, Any?>>) { errorHandler = handler }

    /**
     * Register a handler called when the client disconnects.
     */
    fun onDisconnect(handler: (state: S, session: SessionInfo) -> Unit) {
        val ser = stateSerializer
        disconnectHandler = { ctx ->
            val typed = hypenJson.decodeFromJsonElement(ser, ctx.state.getAll().toJsonElement())
            handler(typed, ctx.session)
        }
    }

    /**
     * Register a handler called when a client reconnects.
     */
    fun onReconnect(handler: (session: SessionInfo, restore: (Map<String, Any?>) -> Unit) -> Unit) {
        reconnectHandler = { ctx ->
            handler(ctx.session, ctx.restore)
        }
    }

    /**
     * Register a handler called when a suspended session expires.
     */
    fun onExpire(handler: (session: SessionInfo) -> Unit) {
        expireHandler = { ctx ->
            handler(ctx.session)
        }
    }

    /**
     * Register a suspend (async) typed action handler.
     */
    inline fun <reified A : HypenAction> onActionAsync(
        noinline handler: suspend (action: A, state: S, context: GlobalContext?) -> Unit
    ) {
        val instance = A::class.objectInstance
        val actionName = instance?._actionName
            ?: resolveDataClassActionName<A>()
            ?: A::class.simpleName
            ?: error("Cannot determine action name for ${A::class}")
        val payloadType = typeOf<A>()
        val ser = stateSerializer
        actionHandlers[actionName] = ActionHandler.Suspend { ctx ->
            val typedState = hypenJson.decodeFromJsonElement(ser, ctx.state.getAll().toJsonElement())
            val typedAction: A = instance
                ?: ctx.action.payload?.let { deserializePayload<A>(it, payloadType) }
                ?: error("Action $actionName requires a payload")
            handler(typedAction, typedState, ctx.context)
            syncBack(ser, typedState, ctx.state)
        }
    }

    fun onCreated(handler: (state: S, context: GlobalContext?) -> Unit) {
        val ser = stateSerializer
        onCreatedHandler = { observableState, context ->
            val typed = hypenJson.decodeFromJsonElement(ser, observableState.getAll().toJsonElement())
            handler(typed, context)
            syncBack(ser, typed, observableState)
        }
    }

    /**
     * Register a handler that runs every time the module becomes the
     * active route target (on first mount after `onCreated`, and on each
     * re-mount from the ManagedRouter's persistence cache).
     */
    fun onActivated(handler: (state: S, context: GlobalContext?) -> Unit) {
        val ser = stateSerializer
        onActivatedHandler = { observableState, context ->
            val typed = hypenJson.decodeFromJsonElement(ser, observableState.getAll().toJsonElement())
            handler(typed, context)
            syncBack(ser, typed, observableState)
        }
    }

    /**
     * Register a handler that runs every time the module stops being the
     * active route target (before persistence OR before `onDestroyed`).
     */
    fun onDeactivated(handler: (state: S, context: GlobalContext?) -> Unit) {
        val ser = stateSerializer
        onDeactivatedHandler = { observableState, context ->
            val typed = hypenJson.decodeFromJsonElement(ser, observableState.getAll().toJsonElement())
            handler(typed, context)
            syncBack(ser, typed, observableState)
        }
    }

    fun onDestroyed(handler: (state: S, context: GlobalContext?) -> Unit) {
        val ser = stateSerializer
        onDestroyedHandler = { observableState, context ->
            val typed = hypenJson.decodeFromJsonElement(ser, observableState.getAll().toJsonElement())
            handler(typed, context)
            syncBack(ser, typed, observableState)
        }
    }

    /**
     * Register a string-based action handler (escape hatch).
     */
    fun onAction(name: String, handler: ModuleActionHandler<MutableMap<String, Any?>>) {
        actionHandlers[name] = ActionHandler.Sync(handler)
    }

    /**
     * Register a typed action handler matching the TypeScript SDK signature.
     *
     * ```kotlin
     * onAction<CounterAction.Increment> { action, state, context ->
     *     state.count += 1
     * }
     *
     * // Data class actions carry payload fields directly:
     * onAction<CounterAction.Add> { action, state, context ->
     *     state.count += action.amount
     * }
     * ```
     */
    inline fun <reified A : HypenAction> onAction(
        noinline handler: (action: A, state: S, context: GlobalContext?) -> Unit
    ) {
        val instance = A::class.objectInstance
        val actionName = instance?._actionName
            ?: resolveDataClassActionName<A>()
            ?: A::class.simpleName
            ?: error("Cannot determine action name for ${A::class}")
        val payloadType = typeOf<A>()
        val ser = stateSerializer
        actionHandlers[actionName] = ActionHandler.Sync { ctx ->
            val typedState = hypenJson.decodeFromJsonElement(ser, ctx.state.getAll().toJsonElement())
            val typedAction: A = instance
                ?: ctx.action.payload?.let { deserializePayload<A>(it, payloadType) }
                ?: error("Action $actionName requires a payload")
            handler(typedAction, typedState, ctx.context)
            syncBack(ser, typedState, ctx.state)
        }
    }

    @PublishedApi
    internal fun build(): ModuleDefinition<MutableMap<String, Any?>> {
        val def = ModuleDefinition(
            name = moduleName,
            actions = actionHandlers.keys.toList(),
            stateKeys = initialState.keys.toList(),
            persist = persist,
            version = version,
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
        if (!moduleName.isNullOrEmpty()) {
            HypenApp.register(moduleName!!, def)
        }
        return def
    }

    companion object {
        /** Serialize the typed state back to the engine's ObservableState. */
        @PublishedApi
        internal fun <S : Any> syncBack(
            ser: KSerializer<S>,
            typedState: S,
            observableState: ObservableState<MutableMap<String, Any?>>
        ) {
            val newJson = hypenJson.encodeToJsonElement(ser, typedState)
            if (newJson is JsonObject) {
                observableState.update(newJson.mapValues { (_, v) -> v.toKotlinValue() })
            }
        }
    }
}

/**
 * For data class actions, create a temporary instance via reflection to read [HypenAction._actionName].
 * Returns `null` when the simple name should be used (no custom override, or reflection fails).
 */
@PublishedApi
internal inline fun <reified A : HypenAction> resolveDataClassActionName(): String? {
    return try {
        val ctor = A::class.primaryConstructor ?: return null
        val args = mutableMapOf<KParameter, Any?>()
        for (param in ctor.parameters) {
            if (param.isOptional) continue
            args[param] = when (param.type.classifier) {
                Int::class -> 0
                Long::class -> 0L
                String::class -> ""
                Boolean::class -> false
                Double::class -> 0.0
                Float::class -> 0f
                else -> return null
            }
        }
        val temp = ctor.callBy(args)
        val name = temp._actionName
        // Only return if it differs from the simple class name (i.e. actually overridden)
        if (name != A::class.simpleName) name else null
    } catch (_: Exception) {
        null
    }
}

/**
 * Create a typed Hypen module.
 *
 * [S] must be a `@Serializable` data class. Use `var` fields for mutable state:
 *
 * ```kotlin
 * @Serializable
 * data class CounterState(var count: Int = 0)
 *
 * val module = hypen(CounterState()) {
 *     onAction<Increment> { action, state, context ->
 *         state.count += 1
 *     }
 * }
 * ```
 */
inline fun <reified S : Any> hypen(
    initialState: S,
    block: TypedHypenModuleBuilder<S>.() -> Unit
): ModuleDefinition<MutableMap<String, Any?>> {
    val ser = serializer<S>()
    val stateMap: MutableMap<String, Any?> = when (initialState) {
        is MutableMap<*, *> -> {
            @Suppress("UNCHECKED_CAST")
            initialState as MutableMap<String, Any?>
        }
        is Map<*, *> -> {
            initialState.entries.associate { it.key.toString() to it.value }.toMutableMap()
        }
        else -> {
            val jsonElement = hypenJson.encodeToJsonElement(ser, initialState)
            if (jsonElement is JsonObject) {
                jsonElement.mapValues { (_, v) -> v.toKotlinValue() }.toMutableMap()
            } else {
                mutableMapOf("value" to initialState as Any?)
            }
        }
    }
    return TypedHypenModuleBuilder(stateMap, ser).apply(block).build()
}

// ---------------------------------------------------------------------------
// Convenience extensions
// ---------------------------------------------------------------------------

/**
 * Create a module instance. Defaults to [NativeEngine] — no engine setup needed.
 *
 * ```kotlin
 * val instance = counterModule.createInstance()
 * ```
 */
fun ModuleDefinition<MutableMap<String, Any?>>.createInstance(
    engine: IEngine = NativeEngine(),
    router: HypenRouter? = null,
    context: GlobalContext? = null
): ModuleInstance<MutableMap<String, Any?>> {
    return ModuleInstance(
        engine = engine,
        definition = this,
        routerContext = router?.let { RouterContext(it) },
        globalContext = context
    )
}

inline fun <reified T : Any> hypenTyped(
    initialState: T,
    block: AppBuilder<T>.() -> Unit
): ModuleDefinition<T> {
    return AppBuilder.defineState(initialState).apply(block).build()
}

fun <T : Any> defineState(initialState: T): AppBuilder<T> = AppBuilder.defineState(initialState)

fun globalContext(block: HypenGlobalContext.() -> Unit = {}): HypenGlobalContext {
    return HypenGlobalContext().apply(block)
}

fun router(initialPath: String = "/"): HypenRouter {
    return HypenRouter().also { it.push(initialPath) }
}
