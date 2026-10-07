package space.hypen.core

import space.hypen.remote.device.DeviceContext
import space.hypen.remote.device.DevicePlane
import java.util.concurrent.ConcurrentHashMap

/**
 * Module reference for cross-module communication
 */
data class ModuleReference<T : Any>(
    private val instance: ModuleInstance<T>
) {
    /**
     * Get a snapshot of the module's state
     */
    fun getState(): Map<String, Any?> = instance.getState()

    /**
     * Update the module's state
     */
    fun setState(patch: Map<String, Any?>) = instance.updateState(patch)
}

/**
 * Global context for cross-module communication and event handling.
 */
interface GlobalContext {
    /**
     * Get a module by its ID
     */
    fun <T : Any> getModule(id: String): ModuleReference<T>?

    /**
     * Check if a module exists
     */
    fun hasModule(id: String): Boolean

    /**
     * Get all registered module IDs
     */
    fun getModuleIds(): List<String>

    /**
     * Get global state across all modules
     */
    fun getGlobalState(): Map<String, Any?>

    /**
     * Emit an event
     */
    fun emit(event: String, payload: Any? = null)

    /**
     * Router attached to this context, if any.
     *
     * Populated by the auto-wired [ManagedRouter] so per-route modules
     * can read route params (e.g. `:id`) from `onActivated`:
     *
     * ```kotlin
     * onActivated { _, ctx ->
     *     val r = ctx?.getRouter() ?: return@onActivated
     *     val id = r.matchPath("/user-profile/:id", r.getCurrentPath())?.params?.get("id")
     *     ...
     * }
     * ```
     *
     * Returns null when no router has been attached (standalone /
     * testing usage). Mirrors Swift's `GlobalContext.getRouter()`.
     */
    fun getRouter(): HypenRouter? = null

    /**
     * Device Capability Protocol access (RFC 001 §4) for the module whose
     * lifecycle callback (`onCreated` / `onActivated` / `onDeactivated` /
     * `onDestroyed`) received this context, scoped to that module's current
     * activation. Action handlers use [ActionHandlerContext.device] instead.
     * The shared per-connection context itself owns no activation, so its
     * device always answers `unavailable`.
     */
    val device: DeviceContext
        get() = DeviceContext.disabled("owner-inactive")
}

/**
 * The [GlobalContext] a module's handler receives: the shared context plus
 * the module's own activation-scoped [device].
 */
internal class DeviceScopedGlobalContext(
    private val delegate: GlobalContext,
    override val device: DeviceContext,
) : GlobalContext by delegate {
    override fun getRouter(): HypenRouter? = delegate.getRouter()

    /** The shared context this view wraps (e.g. a [HypenGlobalContext]). */
    val shared: GlobalContext get() = delegate

    /** A view equals the shared context it wraps (and every other view of it). */
    override fun equals(other: Any?): Boolean =
        other === this || other == delegate || (other is DeviceScopedGlobalContext && other.delegate == delegate)

    override fun hashCode(): Int = delegate.hashCode()
}

/**
 * Default implementation of GlobalContext with thread-safe collections.
 */
class HypenGlobalContext : GlobalContext {
    private val modules = ConcurrentHashMap<String, ModuleInstance<*>>()
    private val eventListeners = ConcurrentHashMap<String, MutableList<(Any?) -> Unit>>()
    private val typedEvents = TypedEventEmitter()
    private val log = HypenLoggers.context

    @Volatile
    private var router: HypenRouter? = null

    /**
     * The connection's device plane (RFC 001), when the client negotiated
     * one. Module instances created against this context (e.g. by the
     * auto-wired [ManagedRouter]) bind to it at construction.
     */
    @Volatile
    var devicePlane: DevicePlane? = null
        internal set

    /** Attach a router to this context. Called by the auto-wired [ManagedRouter]. */
    fun setRouter(router: HypenRouter?) {
        this.router = router
    }

    override fun getRouter(): HypenRouter? = router

    /**
     * Register a module with the context
     */
    fun registerModule(id: String, instance: ModuleInstance<*>) {
        modules[id] = instance
        emit("module:created", mapOf("moduleId" to id))
        typedEvents.emit(HypenEvents.moduleCreated, HypenEvents.ModuleCreated(id))
    }

    /**
     * Register a nested module with the context.
     * Nested modules are tracked separately but appear in the same ID namespace.
     */
    private val nestedModules = ConcurrentHashMap<String, NestedModuleInstance<*>>()

    fun registerNestedModule(id: String, instance: NestedModuleInstance<*>) {
        nestedModules[id] = instance
        emit("module:created", mapOf("moduleId" to id, "nested" to true))
        typedEvents.emit(HypenEvents.moduleCreated, HypenEvents.ModuleCreated(id))
    }

    /**
     * Unregister a nested module from the context
     */
    fun unregisterNestedModule(id: String) {
        nestedModules.remove(id)
        emit("module:destroyed", mapOf("moduleId" to id, "nested" to true))
        typedEvents.emit(HypenEvents.moduleDestroyed, HypenEvents.ModuleDestroyed(id))
    }

    /**
     * Check if a nested module exists
     */
    fun hasNestedModule(id: String): Boolean = nestedModules.containsKey(id)

    /**
     * Unregister a module from the context
     */
    fun unregisterModule(id: String) {
        modules.remove(id)
        emit("module:destroyed", mapOf("moduleId" to id))
        typedEvents.emit(HypenEvents.moduleDestroyed, HypenEvents.ModuleDestroyed(id))
    }

    @Suppress("UNCHECKED_CAST")
    override fun <T : Any> getModule(id: String): ModuleReference<T>? {
        val instance = modules[id] as? ModuleInstance<T> ?: return null
        return ModuleReference(instance)
    }

    override fun hasModule(id: String): Boolean = modules.containsKey(id) || nestedModules.containsKey(id)

    override fun getModuleIds(): List<String> = modules.keys().toList()

    override fun getGlobalState(): Map<String, Any?> {
        return modules.mapValues { it.value.getState() }
    }

    override fun emit(event: String, payload: Any?) {
        val list = eventListeners[event] ?: return
        val snapshot = synchronized(list) { list.toList() }
        for (handler in snapshot) {
            try {
                handler(payload)
            } catch (e: Exception) {
                log.error("Error in event handler for '$event'", e.message ?: "")
            }
        }
    }

    /**
     * Subscribe to an untyped event. Returns an unsubscribe function.
     */
    fun on(event: String, handler: (Any?) -> Unit): () -> Unit {
        val list = eventListeners.getOrPut(event) { mutableListOf() }
        synchronized(list) { list.add(handler) }
        return { synchronized(list) { list.remove(handler) } }
    }

    /**
     * Subscribe to a typed event. Returns an unsubscribe function.
     */
    fun <T> on(key: EventKey<T>, handler: (T) -> Unit): () -> Unit {
        return typedEvents.on(key, handler)
    }

    /**
     * Subscribe to a typed event for a single emission.
     */
    fun <T> once(key: EventKey<T>, handler: (T) -> Unit): () -> Unit {
        return typedEvents.once(key, handler)
    }

    /**
     * Unsubscribe from an untyped event
     */
    fun off(event: String, handler: (Any?) -> Unit) {
        eventListeners[event]?.let { list ->
            synchronized(list) { list.remove(handler) }
        }
    }

    /**
     * Clear all listeners for an event
     */
    fun clearEvent(event: String) {
        eventListeners.remove(event)
    }

    /**
     * Clear all event listeners
     */
    fun clearAllEvents() {
        eventListeners.clear()
        typedEvents.clearAll()
    }

    /**
     * Get the typed event emitter for direct access.
     */
    fun events(): TypedEventEmitter = typedEvents
}
