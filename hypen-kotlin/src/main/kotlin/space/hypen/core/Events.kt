package space.hypen.core

import java.util.concurrent.ConcurrentHashMap

/**
 * Type-safe event emitter.
 *
 * Events are identified by [EventKey] instances which carry the payload type.
 *
 * ```kotlin
 * object MyEvents {
 *     val userCreated = EventKey<String>("user:created")
 *     val counterChanged = EventKey<Int>("counter:changed")
 * }
 *
 * val emitter = TypedEventEmitter()
 * val unsub = emitter.on(MyEvents.userCreated) { name -> println("Hello $name") }
 * emitter.emit(MyEvents.userCreated, "Alice")
 * unsub() // unsubscribe
 * ```
 */
class TypedEventEmitter {
    private val listeners = ConcurrentHashMap<String, MutableList<(Any?) -> Unit>>()
    private val log = HypenLoggers.events

    /**
     * Subscribe to an event. Returns an unsubscribe function.
     */
    @Suppress("UNCHECKED_CAST")
    fun <T> on(key: EventKey<T>, handler: (T) -> Unit): () -> Unit {
        val wrapper: (Any?) -> Unit = { payload -> handler(payload as T) }
        val list = listeners.getOrPut(key.name) { mutableListOf() }
        synchronized(list) { list.add(wrapper) }
        return {
            synchronized(list) { list.remove(wrapper) }
        }
    }

    /**
     * Subscribe to an event for a single emission only.
     */
    @Suppress("UNCHECKED_CAST")
    fun <T> once(key: EventKey<T>, handler: (T) -> Unit): () -> Unit {
        var unsubscribe: (() -> Unit)? = null
        val wrapper: (Any?) -> Unit = { payload ->
            unsubscribe?.invoke()
            handler(payload as T)
        }
        val list = listeners.getOrPut(key.name) { mutableListOf() }
        synchronized(list) { list.add(wrapper) }
        unsubscribe = { synchronized(list) { list.remove(wrapper) } }
        return unsubscribe
    }

    /**
     * Emit an event with a payload.
     */
    fun <T> emit(key: EventKey<T>, payload: T) {
        val list = listeners[key.name] ?: return
        val snapshot = synchronized(list) { list.toList() }
        for (handler in snapshot) {
            try {
                handler(payload)
            } catch (e: Exception) {
                log.error("Error in event handler for '${key.name}'", e.message ?: "")
            }
        }
    }

    /**
     * Remove all listeners for a specific event.
     */
    fun removeAllListeners(key: EventKey<*>) {
        listeners[key.name]?.let { list ->
            synchronized(list) { list.clear() }
        }
    }

    /**
     * Remove all listeners for all events.
     */
    fun clearAll() {
        listeners.clear()
    }

    /**
     * Get the number of listeners for an event.
     */
    fun listenerCount(key: EventKey<*>): Int {
        return listeners[key.name]?.let { synchronized(it) { it.size } } ?: 0
    }

    /**
     * Get all event names that have listeners.
     */
    fun eventNames(): List<String> {
        return listeners.keys().toList()
    }
}

/**
 * Type-safe event identifier.
 */
class EventKey<T>(val name: String) {
    override fun toString(): String = name
    override fun equals(other: Any?): Boolean = other is EventKey<*> && other.name == name
    override fun hashCode(): Int = name.hashCode()
}

/**
 * Pre-defined framework events.
 */
object HypenEvents {
    data class ModuleCreated(val moduleId: String)
    data class ModuleDestroyed(val moduleId: String)
    data class RouteChanged(val from: String?, val to: String)
    data class StateUpdated(val moduleId: String, val paths: List<String>)
    data class ActionDispatched(val moduleId: String, val actionName: String, val payload: Any? = null)
    data class FrameworkError(val message: String, val error: Throwable? = null, val context: String? = null)

    val moduleCreated = EventKey<ModuleCreated>("module:created")
    val moduleDestroyed = EventKey<ModuleDestroyed>("module:destroyed")
    val routeChanged = EventKey<RouteChanged>("route:changed")
    val stateUpdated = EventKey<StateUpdated>("state:updated")
    val actionDispatched = EventKey<ActionDispatched>("action:dispatched")
    val error = EventKey<FrameworkError>("error")
}
