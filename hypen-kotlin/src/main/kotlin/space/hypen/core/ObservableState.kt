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
     * Move element [from] of the array at [fromPath] so it becomes index [to]
     * of the array at [toPath] (the two paths may be equal). This is the
     * `__hypen_reorder` primitive (hypen-web/docs/dnd.md) and
     * delegates to the engine's canonical `portable_path_move`, so the
     * semantics — `to` is the FINAL index clamped to `[0, len]` after
     * removal, `from == to` on one array is a no-op that still succeeds,
     * a destination re-addressed when it lives under a later sibling of
     * the source array, a destination inside the moved element refused —
     * match every other SDK byte for byte.
     *
     * Returns `false` and leaves the state untouched unless both paths
     * resolve to arrays and [from] is in range. On success a change is
     * notified for both paths (collapsed to the common ancestor when one
     * path contains the other) carrying the updated arrays, so the engine
     * re-renders the affected `ForEach`es and persistence sees the write.
     *
     * Inside [batch]: the move lands in `state` immediately (later reads in
     * the block see it) and is notified with the batch flush. Earlier
     * pending sets in the same batch that touch either array — the array
     * itself, one of its elements/sub-paths, or an ancestor object — are
     * applied to `state` FIRST so the move operates on the array the block
     * has built up so far (`set("tasks.0", x); move("tasks", 0, "tasks", 2)`
     * moves `x`). Their pending entries are then reconciled with the move:
     * sub-path entries are subsumed by the whole-array notification and
     * dropped, equal/ancestor entries are refreshed to their post-move
     * value, so the flush replay is idempotent and every notified value
     * matches the final state. A set to a sub-path issued AFTER the move in
     * the same batch still wins (flush order). Pending sets to unrelated
     * paths are untouched and stay deferred as usual.
     */
    fun move(fromPath: String, from: Int, toPath: String, to: Int): Boolean {
        if (from < 0 || to < 0) return false
        lock.write {
            if (batchingUpdates) {
                // Materialise the pending sets the move depends on, in
                // insertion order, so the move sees the batch's writes.
                pendingChanges
                    .filter { (path, _) -> overlapsMove(path, fromPath, toPath) }
                    .forEach { (path, value) -> setValueAtPath(state, path, value) }
            }
            val moved = moveValueAtPath(state, fromPath, from, toPath, to)
            if (!moved) return false
            val paths = changedPathsForMove(fromPath, toPath)
            val values = paths.associateWith { getValueAtPath(state, it) }
            if (batchingUpdates) {
                // Reconcile the pending list with the move so the flush
                // replay (insertion order, whole values) cannot undo it:
                //  - strict sub-paths of either array (`tasks.0`) are covered
                //    by the whole-array entry and may not even exist any
                //    more (cross-array moves shrink the source), so drop them;
                //  - the arrays themselves / ancestor objects are refreshed
                //    to their post-move value (idempotent on replay).
                val reconciled = pendingChanges.mapNotNull { (path, value) ->
                    when {
                        isStrictSubPath(path, fromPath) || isStrictSubPath(path, toPath) -> null
                        overlapsMove(path, fromPath, toPath) -> path to getValueAtPath(state, path)
                        else -> path to value
                    }
                }
                pendingChanges.clear()
                pendingChanges.addAll(reconciled)
                val queued = pendingChanges.mapTo(HashSet()) { it.first }
                paths.forEach { if (it !in queued) pendingChanges.add(it to values[it]) }
            } else {
                notifyChange(paths, values)
            }
            return true
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
            mirrorRoot(obj, parsed)
        }

        /**
         * Move `from` of the array at `fromPath` to index `to` of the array
         * at `toPath`, mutating `obj` in place. Delegates to the engine's
         * canonical `portable_path_move`; see [ObservableState.move] for the
         * semantics. Returns the engine's `moved` flag; `obj` is untouched
         * when it is `false`.
         */
        fun moveValueAtPath(
            obj: MutableMap<String, Any?>,
            fromPath: String,
            from: Int,
            toPath: String,
            to: Int,
        ): Boolean {
            if (from < 0 || to < 0) return false
            val stateJson = toJsonElement(obj).toString()
            val resultJson = uniffi.hypen_engine.portablePathMove(
                stateJson, fromPath, from.toUInt(), toPath, to.toUInt(),
            )
            val result = portableJson.parseToJsonElement(resultJson) as? JsonObject ?: return false
            val moved = (result["moved"] as? JsonPrimitive)?.booleanOrNull ?: false
            if (!moved) return false
            val parsed = result["json"] as? JsonObject ?: return false
            mirrorRoot(obj, parsed)
            return true
        }

        /**
         * The paths a successful move dirties: both arrays, collapsed to the
         * shorter one when it is an ancestor of the other (a destination
         * under `entries.2.children` is re-addressed by the removal, so the
         * only stable path to report is `entries` itself).
         */
        internal fun changedPathsForMove(fromPath: String, toPath: String): List<String> {
            if (fromPath == toPath) return listOf(fromPath)
            if (isAncestorPath(fromPath, toPath)) return listOf(fromPath)
            if (isAncestorPath(toPath, fromPath)) return listOf(toPath)
            return listOf(fromPath, toPath)
        }

        private fun isAncestorPath(ancestor: String, path: String): Boolean =
            ancestor.isEmpty() || path.startsWith("$ancestor.")

        /** `path` lies strictly inside the array at `arrayPath` (`tasks.0` under `tasks`). */
        private fun isStrictSubPath(path: String, arrayPath: String): Boolean =
            path != arrayPath && isAncestorPath(arrayPath, path)

        /**
         * Whether a pending set at `path` interacts with a move between
         * `fromPath` and `toPath`: it IS one of the arrays, lives inside one
         * of them, or is an ancestor object that contains one of them.
         */
        internal fun overlapsMove(path: String, fromPath: String, toPath: String): Boolean =
            path == fromPath || path == toPath ||
                isAncestorPath(fromPath, path) || isAncestorPath(toPath, path) ||
                isAncestorPath(path, fromPath) || isAncestorPath(path, toPath)

        /**
         * Mirror the engine's root back into the caller's map so holders of
         * the same map reference see the mutation.
         */
        private fun mirrorRoot(obj: MutableMap<String, Any?>, parsed: JsonObject) {
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
