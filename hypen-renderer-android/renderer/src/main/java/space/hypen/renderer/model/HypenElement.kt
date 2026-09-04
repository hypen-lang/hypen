package space.hypen.renderer.model

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList

private fun <T> stateListOf(source: List<T>): SnapshotStateList<T> {
    val list = mutableStateListOf<T>()
    list.addAll(source)
    return list
}

/**
 * Represents a Hypen UI element in the render tree.
 * This is the internal representation used by the renderer.
 *
 * Props, children, text content, and semantics are backed by Compose
 * snapshot state so a patch touching one element invalidates only the
 * composables that read that element, not the whole tree.
 */
class HypenElement(
    val id: String,
    elementType: String,
    props: Map<String, Any?> = emptyMap(),
    children: List<String> = emptyList(),
    parentId: String? = null,
    textContent: String? = null,
    semantics: Map<String, Any?>? = null,
) {
    var elementType: String by mutableStateOf(elementType)
        internal set

    // Insertion-ordered immutable map held in a single snapshot state slot and
    // replaced wholesale on each prop patch. Iteration order must match the
    // engine-declared prop order (engine IndexMap -> JSON -> parser map): the
    // ApplicatorPriority sort in DefaultApplicatorRegistry is stable, so
    // equal-priority applicators (e.g. background vs linearGradient, or
    // non-commutative transforms) apply in declaration order. A
    // SnapshotStateMap would break this — its backing persistent hash map
    // iterates in hash order — while a single mutableStateOf keeps the same
    // per-element invalidation granularity.
    private var propsState: Map<String, Any?> by mutableStateOf(LinkedHashMap(props))

    /**
     * Presented values written by an in-flight `.transition` glide, keyed by
     * the same wire prop name (`backgroundColor.0`). They SHADOW the engine
     * values in [props] for the duration of the animation, so every consumer
     * — modifier applicators and components alike — sees the interpolated
     * pose without knowing animation exists. Cleared when the glide settles
     * (at which point the shadowed value equals the engine value anyway).
     */
    private var animatedOverridesState: Map<String, Any?> by mutableStateOf(emptyMap())

    private class MergedProps(
        val raw: Map<String, Any?>,
        val overrides: Map<String, Any?>,
        val merged: Map<String, Any?>,
    )

    // Plain (non-snapshot) memo of the last merge. Both inputs are snapshot
    // state and are read below, so observers still subscribe correctly; this
    // only avoids re-allocating the merged map on every read.
    @Volatile
    private var mergedCache: MergedProps? = null

    val props: Map<String, Any?>
        get() {
            val raw = propsState
            val overrides = animatedOverridesState
            if (overrides.isEmpty()) return raw
            val cached = mergedCache
            if (cached != null && cached.raw === raw && cached.overrides === overrides) {
                return cached.merged
            }
            val merged = LinkedHashMap(raw)
            merged.putAll(overrides)
            mergedCache = MergedProps(raw, overrides, merged)
            return merged
        }

    /**
     * The engine-declared props, without any animation override. The glide
     * driver reads targets from here — reading through [props] would return
     * its own in-flight presented value instead of the new target.
     */
    val rawProps: Map<String, Any?> get() = propsState

    /**
     * Write (or clear, with [clearAnimatedOverride]) one presented value.
     * Bumps the props revision so remembered modifier chains recompute — an
     * animating element rebuilds its chain per frame, which is the price of
     * animating every whitelisted prop through its existing applicator
     * instead of special-casing a handful in a graphics layer.
     */
    fun setAnimatedOverride(name: String, value: Any?) {
        val next = LinkedHashMap(animatedOverridesState)
        next[name] = value
        animatedOverridesState = next
        bumpPropsRevision()
    }

    /** Drop one presented value; the engine value shows through again. */
    fun clearAnimatedOverride(name: String) {
        if (!animatedOverridesState.containsKey(name)) return
        val next = LinkedHashMap(animatedOverridesState)
        next.remove(name)
        animatedOverridesState = next
        bumpPropsRevision()
    }

    /** True while [name] is shadowed by an in-flight glide. */
    fun hasAnimatedOverride(name: String): Boolean = animatedOverridesState.containsKey(name)

    internal fun setProp(name: String, value: Any?) {
        val next = LinkedHashMap(propsState)
        next[name] = value
        propsState = next
    }

    /** Removes a prop. Returns true if the prop existed. */
    internal fun removeProp(name: String): Boolean {
        if (!propsState.containsKey(name)) return false
        val next = LinkedHashMap(propsState)
        next.remove(name)
        propsState = next
        return true
    }

    internal fun replaceProps(newProps: Map<String, Any?>) {
        propsState = LinkedHashMap(newProps)
    }

    val children: SnapshotStateList<String> = stateListOf(children)

    var parentId: String? = parentId

    var textContent: String? by mutableStateOf(textContent)

    /**
     * Engine-derived accessibility semantics: set at CREATE, replaced
     * wholesale by SET_SEMANTICS reactive re-emits (null clears). Translated
     * to `Modifier.semantics {}` in [space.hypen.renderer.render.applyHypenSemantics].
     */
    var semantics: Map<String, Any?>? by mutableStateOf(semantics)

    // Bumped by the renderer whenever props change so remembered
    // modifier chains recompute only for touched elements.
    private val propsRevisionState = mutableIntStateOf(0)
    val propsRevision: Int get() = propsRevisionState.intValue

    internal fun bumpPropsRevision() {
        propsRevisionState.intValue++
    }

    // Mirrors [children] for O(1) membership checks while building
    // large child lists from INSERT/ATTACH patches.
    private val childIdSet = HashSet(children)

    internal fun addChild(childId: String, beforeId: String?) {
        if (beforeId != null) {
            val index = children.indexOf(beforeId)
            if (index >= 0) children.add(index, childId) else children.add(childId)
            childIdSet.add(childId)
        } else if (childIdSet.add(childId)) {
            children.add(childId)
        }
    }

    internal fun removeChild(childId: String) {
        if (childIdSet.remove(childId)) {
            children.remove(childId)
        }
    }

    internal fun clearChildren() {
        childIdSet.clear()
        children.clear()
    }

    /**
     * Gets a property value with type casting.
     */
    @Suppress("UNCHECKED_CAST")
    fun <T> getProp(name: String): T? = props[name] as? T

    /**
     * Gets a property value with a default.
     */
    @Suppress("UNCHECKED_CAST")
    fun <T> getProp(
        name: String,
        default: T,
    ): T = (props[name] as? T) ?: default

    /**
     * Gets a string property.
     */
    fun getStringProp(name: String): String? = props[name]?.toString()

    /**
     * Gets a string property with a default.
     */
    fun getStringProp(
        name: String,
        default: String,
    ): String = getStringProp(name) ?: default

    /**
     * Gets a numeric property as Double.
     */
    fun getDoubleProp(name: String): Double? =
        when (val value = props[name]) {
            is Number -> value.toDouble()
            is String -> {
                val str = value.trim().lowercase()
                when {
                    str.endsWith("rem") -> str.removeSuffix("rem").toDoubleOrNull()?.times(16.0)
                    str.endsWith("em") -> str.removeSuffix("em").toDoubleOrNull()?.times(16.0)
                    str.endsWith("px") -> str.removeSuffix("px").toDoubleOrNull()
                    str.endsWith("dp") -> str.removeSuffix("dp").toDoubleOrNull()
                    str.endsWith("pt") -> str.removeSuffix("pt").toDoubleOrNull()
                    else -> value.toDoubleOrNull()
                }
            }
            else -> null
        }

    /**
     * Gets a numeric property as Float.
     */
    fun getFloatProp(name: String): Float? = getDoubleProp(name)?.toFloat()

    /**
     * Gets a numeric property as Int.
     */
    fun getIntProp(name: String): Int? =
        when (val value = props[name]) {
            is Number -> value.toInt()
            is String -> value.toIntOrNull()
            else -> null
        }

    /**
     * Gets a boolean property.
     */
    fun getBoolProp(name: String): Boolean? =
        when (val value = props[name]) {
            is Boolean -> value
            is String -> value.toBooleanStrictOrNull()
            else -> null
        }

    /**
     * Gets a boolean property with a default.
     */
    fun getBoolProp(
        name: String,
        default: Boolean,
    ): Boolean = getBoolProp(name) ?: default

    /**
     * Gets a list-of-strings property (e.g. `playlist: ["a.mp4", "b.mp4"]`).
     *
     * Looks up both the bare name and the `.0` wire-suffix variant
     * (`playlist` / `playlist.0`). JSON arrays arrive from the parser as
     * `List<Any?>`; non-string entries are stringified (numbers, etc.) and
     * nulls are dropped. Returns null when the prop is absent or is not a
     * list, so callers can distinguish "not set" from "set but empty".
     */
    fun getStringListProp(name: String): List<String>? {
        val value = props[name] ?: props["$name.0"] ?: return null
        return (value as? List<*>)?.mapNotNull { it?.toString() }
    }

    /**
     * Gets a map-of-strings property (e.g. `headers: {"Authorization": "..."}`).
     *
     * Looks up both the bare name and the `.0` wire-suffix variant
     * (`headers` / `headers.0`). JSON objects arrive from the parser as
     * `Map<Any?, Any?>`; entries with null keys or null values are dropped
     * and non-string values are stringified. Returns null when the prop is
     * absent or is not a map.
     */
    fun getStringMapProp(name: String): Map<String, String>? {
        val value = props[name] ?: props["$name.0"] ?: return null
        val map = value as? Map<*, *> ?: return null
        val result = LinkedHashMap<String, String>(map.size)
        for ((k, v) in map) {
            val key = k?.toString() ?: continue
            val str = v?.toString() ?: continue
            result[key] = str
        }
        return result
    }
}

/**
 * Represents the state of an action (e.g., onClick value).
 */
data class ActionValue(
    val actionName: String,
    val payload: Map<String, Any?> = emptyMap(),
) {
    companion object {
        /**
         * Parse an action value from a property value.
         * Supports both string format "@actions.name" and object format.
         */
        fun parse(value: Any?): ActionValue? =
            when (value) {
                is String -> parseString(value)
                is Map<*, *> -> parseMap(value)
                else -> null
            }

        private fun parseString(value: String): ActionValue? {
            if (!value.startsWith("@")) return null
            var actionName = value.substring(1)
            if (actionName.startsWith("actions.")) {
                actionName = actionName.substring(8)
            }
            return ActionValue(actionName)
        }

        @Suppress("UNCHECKED_CAST")
        private fun parseMap(value: Map<*, *>): ActionValue? {
            // Support both "0" (JSON convention) and "action" (DSL-friendly) keys
            val actionValue = (value["0"] ?: value["action"]) as? String ?: return null
            val parsed = parseString(actionValue) ?: return null

            val payload =
                value
                    .filterKeys { it != "0" && it != "action" }
                    .mapKeys { it.key.toString() }
                    .mapValues { it.value } as Map<String, Any?>

            return ActionValue(parsed.actionName, payload)
        }
    }
}
