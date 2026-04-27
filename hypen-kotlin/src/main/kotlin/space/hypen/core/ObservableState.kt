package space.hypen.core

import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private val portableJson = Json { ignoreUnknownKeys = true; encodeDefaults = true }

/** Round-trip an arbitrary native value through JSON for UniFFI. */
private fun toJsonElement(v: Any?): JsonElement = when (v) {
    null -> JsonNull
    is Boolean -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    is String -> JsonPrimitive(v)
    is Map<*, *> -> buildJsonObject {
        for ((k, value) in v) put(k.toString(), toJsonElement(value))
    }
    is List<*> -> JsonArray(v.map(::toJsonElement))
    is JsonElement -> v
    else -> JsonPrimitive(v.toString())
}

private fun fromJsonElement(e: JsonElement): Any? = when (e) {
    is JsonNull -> null
    is JsonPrimitive -> when {
        e.isString -> e.content
        e.booleanOrNull != null -> e.boolean
        e.content.contains('.') || e.content.contains('e') || e.content.contains('E') ->
            e.content.toDoubleOrNull() ?: e.content
        else -> {
            // Prefer Int when the value fits so equality checks with
            // `Int` literals in tests and user code succeed without a
            // manual cast. JSON only knows "number", but Kotlin does
            // distinguish Int/Long/Double and `Int(11) != Long(11)`.
            val long = e.content.toLongOrNull()
            when {
                long == null -> e.content.toDoubleOrNull() ?: e.content
                long in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong() -> long.toInt()
                else -> long
            }
        }
    }
    is JsonObject -> e.mapValues { fromJsonElement(it.value) }
    is JsonArray -> e.map { fromJsonElement(it) }
}

private val JsonPrimitive.booleanOrNull: Boolean?
    get() = runCatching { boolean }.getOrNull()

/**
 * Observable state container with change tracking.
 * Provides thread-safe access to state with automatic change notifications.
 *
 * Paths are reported verbatim (relative to this state container). The
 * owning [ModuleInstance] supplies its own scope when forwarding changes
 * to the engine.
 */
class ObservableState<T : Any>(
    initialState: T,
    private val onChange: ((StateChange) -> Unit)? = null
) {
    private val lock = ReentrantReadWriteLock()
    private var state: MutableMap<String, Any?> = when (initialState) {
        is Map<*, *> -> initialState.mapKeys { it.key.toString() }.toMutableMap()
        else -> mutableMapOf("value" to initialState)
    }

    private val changeListeners = mutableListOf<(StateChange) -> Unit>()
    private var batchingUpdates = false
    private val pendingChanges = mutableListOf<Pair<String, Any?>>()

    init {
        onChange?.let { changeListeners.add(it) }
    }

    /**
     * Get a value at the specified path
     */
    fun get(path: String): Any? = lock.read {
        getValueAtPath(state, path)
    }

    /**
     * Set a value at the specified path
     */
    fun set(path: String, value: Any?) {
        lock.write {
            if (batchingUpdates) {
                pendingChanges.add(path to value)
            } else {
                setValueAtPath(state, path, value)
                notifyChange(listOf(path), mapOf(path to value))
            }
        }
    }

    /**
     * Update multiple values at once
     */
    fun update(values: Map<String, Any?>) {
        lock.write {
            val paths = mutableListOf<String>()
            val changed = mutableMapOf<String, Any?>()
            values.forEach { (path, value) ->
                setValueAtPath(state, path, value)
                paths.add(path)
                changed[path] = value
            }
            notifyChange(paths, changed)
        }
    }

    /**
     * Get a snapshot of the entire state
     */
    @Suppress("UNCHECKED_CAST")
    fun getAll(): Map<String, Any?> = lock.read {
        deepClone(state) as Map<String, Any?>
    }

    /**
     * Get a snapshot (alias for getAll)
     */
    fun getSnapshot(): Map<String, Any?> = getAll()

    /**
     * Add a change listener
     */
    fun addChangeListener(listener: (StateChange) -> Unit) {
        lock.write {
            changeListeners.add(listener)
        }
    }

    /**
     * Remove a change listener
     */
    fun removeChangeListener(listener: (StateChange) -> Unit) {
        lock.write {
            changeListeners.remove(listener)
        }
    }

    /**
     * Batch multiple updates into a single change notification
     */
    fun batch(block: () -> Unit) {
        lock.write {
            batchingUpdates = true
            pendingChanges.clear()

            try {
                block()
            } finally {
                batchingUpdates = false
                if (pendingChanges.isNotEmpty()) {
                    val paths = pendingChanges.map { it.first }
                    val values = pendingChanges.associate { it.first to it.second }
                    pendingChanges.forEach { (path, value) ->
                        setValueAtPath(state, path, value)
                    }
                    pendingChanges.clear()
                    notifyChange(paths, values)
                }
            }
        }
    }

    private fun notifyChange(paths: List<String>, newValues: Map<String, Any?>) {
        val change = StateChange(paths, newValues)
        changeListeners.forEach { it(change) }
    }

    companion object {
        /**
         * Read the value at a dotted path. Delegates to the engine's
         * canonical `portable_path_get` via UniFFI.
         */
        fun getValueAtPath(obj: Map<String, Any?>, path: String): Any? {
            val stateJson = toJsonElement(obj).toString()
            val result = uniffi.hypen_engine.portablePathGet(stateJson, path)
            return fromJsonElement(portableJson.parseToJsonElement(result))
        }

        /**
         * Write `value` at a dotted path, mutating `obj` in place.
         * Delegates to the engine's canonical `portable_path_set`.
         */
        @Suppress("UNCHECKED_CAST")
        fun setValueAtPath(obj: MutableMap<String, Any?>, path: String, value: Any?) {
            if (path.isEmpty()) return
            val stateJson = toJsonElement(obj).toString()
            val valueJson = toJsonElement(value).toString()
            val resultJson = uniffi.hypen_engine.portablePathSet(stateJson, path, valueJson)
            val parsed = portableJson.parseToJsonElement(resultJson) as? JsonObject ?: return
            // Mirror the engine's root back into the caller's map so
            // holders of the same map reference see the mutation.
            val keysToRemove = obj.keys - parsed.keys
            for (k in keysToRemove) obj.remove(k)
            for ((k, v) in parsed) obj[k] = fromJsonElement(v)
        }

        /**
         * Deep clone a value via JSON round-trip; delegates the shape
         * transformation through the engine's path_get over the root
         * path (empty string), which returns an independent copy.
         */
        @Suppress("UNCHECKED_CAST")
        fun deepClone(value: Any?): Any? = fromJsonElement(
            portableJson.parseToJsonElement(toJsonElement(value).toString())
        )
    }
}
