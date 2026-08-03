package space.hypen.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Base interface for typed Hypen actions.
 *
 * Implement this as a sealed interface to define type-safe actions for a module.
 * The [name] property defaults to the class simple name, but can be overridden.
 *
 * ```kotlin
 * sealed interface CounterAction : HypenAction {
 *     data object Increment : CounterAction              // name = "Increment"
 *     data object Decrement : CounterAction              // name = "Decrement"
 *     data class Add(val amount: Int) : CounterAction {
 *         override val _actionName: String get() = "add"  // custom name
 *     }
 * }
 * ```
 */
interface HypenAction {
    val _actionName: String get() = this::class.simpleName ?: "unknown"
}

/**
 * Patch types for DOM operations
 */
object PatchType {
    const val CREATE = "create"
    const val SET_PROP = "setProp"
    const val REMOVE_PROP = "removeProp"
    const val SET_TEXT = "setText"
    const val INSERT = "insert"
    const val MOVE = "move"
    const val REMOVE = "remove"
    const val ATTACH_EVENT = "attachEvent"
    const val DETACH_EVENT = "detachEvent"

    /**
     * Unlink a subtree from its parent without destroying it. The
     * renderer keeps the native element alive for a later `ATTACH`.
     * Emitted by the engine's Router subtree cache on nav-away.
     */
    const val DETACH = "detach"

    /**
     * Reattach a previously-detached subtree under the same NodeId.
     * Emitted by the engine's Router subtree cache on nav-back.
     */
    const val ATTACH = "attach"

    /**
     * Replace a node's accessibility semantics after a reactive change
     * (templated accessible name, bound self-state, bound checked). Carries
     * the node's complete re-resolved semantics block in [Patch.semantics];
     * renderers re-apply it with the same translation they run at create,
     * clearing anything the new block no longer sets. A null block means
     * the node lost all derivable semantics.
     */
    const val SET_SEMANTICS = "setSemantics"

    /**
     * Transaction prelude for the animation protocol: a batch-wide
     * animation spec that applies to every whitelisted prop the batch
     * writes. Carries the spec in [Patch.spec].
     *
     * Honored by renderers at batch index 0 ONLY (protocol invariant 3,
     * "first-patch-only preludes") — a prelude anywhere else, or inside a
     * replayed initialTree, is not a stamp. See
     * `.notes/ANIMATION_ANDROID.md`.
     */
    const val BATCH_ANIMATION = "batchAnimation"
}

/**
 * Represents a DOM patch operation
 */
@Serializable
data class Patch(
    val type: String,
    val id: String? = null,
    @SerialName("elementType")
    val elementType: String? = null,
    val props: Map<String, JsonElement>? = null,
    val name: String? = null,
    val value: JsonElement? = null,
    val text: String? = null,
    @SerialName("parentId")
    val parentId: String? = null,
    @SerialName("beforeId")
    val beforeId: String? = null,
    @SerialName("eventName")
    val eventName: String? = null,
    /**
     * Engine-derived accessibility semantics block (camelCase JSON object —
     * role/name/state/hidden/…, same shape as the web wire format). Present
     * on `create` for nodes with derivable a11y and on every
     * `setSemantics`; null otherwise.
     */
    val semantics: JsonElement? = null,
    /**
     * Set on a `remove` patch whose subtree root carried an `__anim.exit`
     * spec: the renderer owns the corpse and may defer teardown to play
     * the exit (protocol invariant 2). Only the flagged root carries it;
     * descendants arrive as plain removes.
     *
     * Declared non-null with a `false` default on purpose: the Rust wire
     * format skips the field when false (`serde` skip-if-false,
     * `reconcile/patch.rs`), and kotlinx's default `encodeDefaults = false`
     * reproduces exactly that — `false` is omitted, `true` is emitted — so
     * [HypenServer]'s `Json.encodeToJsonElement(patch)` relay stays
     * byte-identical to the TS host for every non-animated remove.
     */
    val transition: Boolean = false,
    /**
     * Batch-animation spec carried by a [PatchType.BATCH_ANIMATION]
     * prelude (`{duration, curve, delay, props}`). Null on every other
     * patch type, so it is omitted from the relayed JSON.
     */
    val spec: JsonElement? = null
)

/**
 * Represents an action to be dispatched
 */
@Serializable
data class Action(
    val name: String,
    val payload: JsonElement? = null,
    val sender: String? = null
)

/**
 * Represents a state change notification
 */
data class StateChange(
    val paths: List<String>,
    val newValues: Map<String, Any?>
)

/**
 * Callback type for rendering patches
 */
typealias RenderCallback = (List<Patch>) -> Unit

/**
 * Callback type for engine-level action dispatch.
 *
 * Registered via [IEngine.onAction]. The engine fires this callback when an
 * action arrives at the WASM/native layer. Module-level handlers
 * (see [ActionHandler]) wrap this with destruction-checks, exception
 * routing, and (for suspend variants) coroutine launching.
 */
typealias EngineActionCallback = (Action) -> Unit

/**
 * Lifecycle handler for module creation/destruction
 */
typealias LifecycleHandler<T> = (state: ObservableState<T>, context: GlobalContext?) -> Unit

/**
 * Action handler context (map-based, used internally by the engine)
 */
data class ActionHandlerContext<T : Any>(
    val action: Action,
    val state: ObservableState<T>,
    val context: GlobalContext?,
    val router: HypenRouter? = null
)

/**
 * Module action handler type
 */
typealias ModuleActionHandler<T> = (ActionHandlerContext<T>) -> Unit

/**
 * A registered module-level action handler — either synchronous or
 * suspending. Stored on [ModuleDefinition.actionHandlers] under the
 * action name.
 *
 * [BaseModuleInstance] dispatches each variant on the appropriate path:
 * sync handlers run on the calling thread, suspend handlers launch in the
 * module's coroutine scope (or a shared fallback scope when none is
 * provided).
 *
 * Mirrors the Rust SDK's `ActionHandler<S>` enum at
 * `hypen-sdk-rs/src/module.rs:56`.
 */
sealed class ActionHandler<T : Any> {
    class Sync<T : Any>(val handler: ModuleActionHandler<T>) : ActionHandler<T>()
    class Suspend<T : Any>(val handler: SuspendModuleActionHandler<T>) : ActionHandler<T>()
}

/**
 * Error context passed to error handlers
 */
data class ErrorContext<T : Any>(
    /** The error that occurred */
    val error: Throwable,
    /** Current state (for inspection) */
    val state: ObservableState<T>,
    /** The action name if error occurred in an action handler */
    val actionName: String? = null,
    /** The lifecycle phase if error occurred in a lifecycle handler ("created" or "destroyed") */
    val lifecycle: String? = null
)

/**
 * Error handler result - controls error propagation
 */
sealed class ErrorHandlerResult {
    /** Error was handled, skip default behavior */
    object Handled : ErrorHandlerResult()
    /** Re-throw the error */
    object Rethrow : ErrorHandlerResult()
}

/**
 * Error handler for module errors
 */
typealias ModuleErrorHandler<T> = (ErrorContext<T>) -> ErrorHandlerResult?

/**
 * Context passed to onDisconnect handlers.
 */
data class DisconnectContext<T : Any>(
    val state: ObservableState<T>,
    val session: SessionInfo
)

/**
 * Context passed to onReconnect handlers.
 */
data class ReconnectContext<T : Any>(
    val session: SessionInfo,
    /** Call this with saved state to restore session state. */
    val restore: (Map<String, Any?>) -> Unit
)

/**
 * Context passed to onExpire handlers.
 */
data class ExpireContext(
    val session: SessionInfo
)

/**
 * Session information passed to lifecycle handlers.
 */
data class SessionInfo(
    val id: String,
    val createdAt: Long = System.currentTimeMillis(),
    val lastConnectedAt: Long = System.currentTimeMillis(),
    val props: Map<String, Any?> = emptyMap()
)

/**
 * Disconnect handler type
 */
typealias DisconnectHandler<T> = (DisconnectContext<T>) -> Unit

/**
 * Reconnect handler type
 */
typealias ReconnectHandler<T> = (ReconnectContext<T>) -> Unit

/**
 * Expire handler type
 */
typealias ExpireHandler = (ExpireContext) -> Unit

/**
 * Suspend variants for async handlers
 */
typealias SuspendModuleActionHandler<T> = suspend (ActionHandlerContext<T>) -> Unit
typealias SuspendLifecycleHandler<T> = suspend (ObservableState<T>, GlobalContext?) -> Unit
typealias SuspendDisconnectHandler<T> = suspend (DisconnectContext<T>) -> Unit
typealias SuspendReconnectHandler<T> = suspend (ReconnectContext<T>) -> Unit
typealias SuspendExpireHandler = suspend (ExpireContext) -> Unit
