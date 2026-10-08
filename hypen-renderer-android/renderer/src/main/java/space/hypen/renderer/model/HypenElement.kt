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
     * Prop writes of the patch batch in flight, collected into ONE copy of
     * the map and published as one snapshot write at [commitStagedProps].
     * Without staging, a batch that sets M props on a node with P props
     * copied the map M times (O(M × P)) and bumped the revision M times.
     * Readers inside the batch ([rawProps], [props]) see the staged values.
     */
    private var stagedProps: LinkedHashMap<String, Any?>? = null

    /**
     * Presented values written by an in-flight `.transition` glide, keyed by
     * the same wire prop name (`backgroundColor.0`). They SHADOW the engine
     * values in [props] for the duration of the animation, so every consumer
     * — modifier applicators and components alike — sees the interpolated
     * pose without knowing animation exists. Cleared when the glide settles
     * (at which point the shadowed value equals the engine value anyway).
     */
    private var animatedOverridesState: Map<String, Any?> by mutableStateOf(emptyMap())

    /**
     * A runtime `.states` pose overlaid by the drag-and-drop runtime
     * (`lifted` on the dragged source, `over` on the hovered zone — plan
     * §2.1), keyed by lowered prop name exactly like [animatedOverridesState]
     * and layered ABOVE it: the drag owns the node while a label is live
     * (`dnd > … > .transition`), so a glide landing on a pose-overridden key
     * keeps running underneath and shows through when the label clears.
     */
    private var poseOverridesState: Map<String, Any?> by mutableStateOf(emptyMap())

    private class MergedProps(
        val raw: Map<String, Any?>,
        val overrides: Map<String, Any?>,
        val poses: Map<String, Any?>,
        val merged: Map<String, Any?>,
    )

    // Plain (non-snapshot) memo of the last merge. Both inputs are snapshot
    // state and are read below, so observers still subscribe correctly; this
    // only avoids re-allocating the merged map on every read.
    @Volatile
    private var mergedCache: MergedProps? = null

    val props: Map<String, Any?>
        get() {
            val staged = stagedProps
            val raw = staged ?: propsState
            val overrides = animatedOverridesState
            val poses = poseOverridesState
            if (overrides.isEmpty() && poses.isEmpty()) return raw
            // A staged map is mutated in place, so identity says nothing
            // about its content: skip the memo until the batch commits.
            val cached = if (staged == null) mergedCache else null
            if (cached != null && cached.raw === raw && cached.overrides === overrides && cached.poses === poses) {
                return cached.merged
            }
            val merged = LinkedHashMap(raw)
            merged.putAll(overrides)
            merged.putAll(poses)
            if (staged == null) mergedCache = MergedProps(raw, overrides, poses, merged)
            return merged
        }

    /**
     * The engine-declared props, without any animation override. The glide
     * driver reads targets from here — reading through [props] would return
     * its own in-flight presented value instead of the new target.
     */
    val rawProps: Map<String, Any?> get() = stagedProps ?: propsState

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

    /**
     * Overlay one runtime `.states` pose (lowered prop keys → values, from
     * `__anim.statePoses[label]`). Replaces any previous overlay; every
     * consumer sees the pose through [props] with no knowledge of DnD.
     */
    fun setPoseOverrides(pose: Map<String, Any?>) {
        poseOverridesState = LinkedHashMap(pose)
        bumpPropsRevision()
    }

    /** Drop the pose overlay; the base value (or absence) shows through again. */
    fun clearPoseOverrides() {
        if (poseOverridesState.isEmpty()) return
        poseOverridesState = emptyMap()
        bumpPropsRevision()
    }

    /** True while a runtime pose is overlaid. */
    val hasPoseOverrides: Boolean get() = poseOverridesState.isNotEmpty()

    internal fun setProp(name: String, value: Any?) {
        val staged = stagedProps
        if (staged != null) {
            staged[name] = value
            return
        }
        val next = LinkedHashMap(propsState)
        next[name] = value
        propsState = next
    }

    /** Removes a prop. Returns true if the prop existed. */
    internal fun removeProp(name: String): Boolean {
        val staged = stagedProps
        if (staged != null) {
            if (!staged.containsKey(name)) return false
            staged.remove(name)
            return true
        }
        if (!propsState.containsKey(name)) return false
        val next = LinkedHashMap(propsState)
        next.remove(name)
        propsState = next
        return true
    }

    internal fun replaceProps(newProps: Map<String, Any?>) {
        stagedProps = null
        propsState = LinkedHashMap(newProps)
    }

    /**
     * Start collecting this element's prop writes for the batch in flight.
     * Idempotent; the first call copies the current map once.
     */
    internal fun beginPropStaging() {
        if (stagedProps == null) stagedProps = LinkedHashMap(propsState)
    }

    /**
     * Publish the staged writes as one snapshot write and one revision
     * bump. Returns false when nothing was staged.
     */
    internal fun commitStagedProps(): Boolean {
        val staged = stagedProps ?: return false
        stagedProps = null
        propsState = staged
        bumpPropsRevision()
        return true
    }

    /** True while prop writes are being staged for a batch. */
    internal val isStagingProps: Boolean get() = stagedProps != null

    /**
     * Composition-facing child order. Containers read it (and `items(key =
     * …)` keys off it), so every write is a snapshot write; the canonical
     * order lives in [order] and reaches this list through [commitChildren]
     * — one write per batch per parent, however many patches moved its rows.
     */
    val children: SnapshotStateList<String> = stateListOf(children)

    /**
     * Canonical child order as a linked list keyed by id: O(1) insert-before,
     * append and remove, and one O(n) materialisation per batch. Renderer
     * code that reads children while a batch is being applied must read
     * [childIds] (this order), never [children], which lags until commit.
     */
    private val order = ChildOrder(children)

    /** Child ids in order, as of the latest write (staged or committed). */
    val childIds: List<String> get() = order.toList()

    /** Structural writes staged since the last [commitChildren]. */
    private var pendingChildOps: ArrayList<ChildOp>? = null

    /** Start staging structural writes for the batch in flight. Idempotent. */
    internal fun beginChildStaging() {
        if (pendingChildOps == null) pendingChildOps = ArrayList(2)
    }

    /**
     * Mirror the staged structural writes into [children]: a lone write is
     * replayed as the same single list operation it would have been, a
     * dense batch (a reorder, a page of inserts) replaces the contents in
     * one pass instead of one scan-and-shift per patch. Returns false when
     * nothing was staged.
     */
    internal fun commitChildren(): Boolean {
        val ops = pendingChildOps ?: return false
        pendingChildOps = null
        when (ops.size) {
            0 -> return false
            1 -> applyChildOp(ops[0])
            else -> {
                children.clear()
                children.addAll(order.toList())
            }
        }
        return true
    }

    private fun applyChildOp(op: ChildOp) {
        when (op) {
            is ChildOp.Add -> {
                val before = op.beforeId
                val at = if (before != null) children.indexOf(before) else -1
                children.remove(op.id)
                if (at >= 0) children.add(at.coerceAtMost(children.size), op.id) else children.add(op.id)
            }
            is ChildOp.Remove -> children.remove(op.id)
            ChildOp.Clear -> children.clear()
        }
    }

    private fun stageOrApply(op: ChildOp) {
        val ops = pendingChildOps
        if (ops != null) ops.add(op) else applyChildOp(op)
    }

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

    internal fun addChild(childId: String, beforeId: String?) {
        if (beforeId != null) {
            order.insertBefore(childId, beforeId)
            stageOrApply(ChildOp.Add(childId, beforeId))
        } else if (!order.contains(childId)) {
            order.append(childId)
            stageOrApply(ChildOp.Add(childId, null))
        }
    }

    internal fun removeChild(childId: String) {
        if (order.remove(childId)) {
            stageOrApply(ChildOp.Remove(childId))
        }
    }

    internal fun clearChildren() {
        if (order.size == 0) return
        order.clear()
        stageOrApply(ChildOp.Clear)
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

/** One staged structural write on a parent's child list. */
internal sealed class ChildOp {
    data class Add(val id: String, val beforeId: String?) : ChildOp()
    data class Remove(val id: String) : ChildOp()
    data object Clear : ChildOp()
}

/**
 * Insertion-ordered set of child ids as a doubly linked list over two hash
 * maps: insert-before, append and remove are O(1), membership is O(1), and
 * the ordered list is materialised on demand and cached until the next
 * write. A batch of M moves under one parent of N children costs O(M + N)
 * instead of the O(M × N) scan-and-shift of a plain list.
 */
internal class ChildOrder(initial: List<String>) {
    private val next = HashMap<String, String?>()
    private val prev = HashMap<String, String?>()
    private var head: String? = null
    private var tail: String? = null
    private var cache: List<String>? = null

    init {
        for (id in initial) append(id)
    }

    val size: Int get() = next.size

    fun contains(id: String): Boolean = next.containsKey(id)

    fun append(id: String) {
        if (contains(id)) remove(id)
        val last = tail
        prev[id] = last
        next[id] = null
        if (last != null) next[last] = id else head = id
        tail = id
        cache = null
    }

    /** Insert before [beforeId]; appends when the anchor is unknown. */
    fun insertBefore(id: String, beforeId: String) {
        if (id == beforeId) return
        if (!contains(beforeId)) {
            append(id)
            return
        }
        if (contains(id)) remove(id)
        val before = prev[beforeId]
        prev[id] = before
        next[id] = beforeId
        prev[beforeId] = id
        if (before != null) next[before] = id else head = id
        cache = null
    }

    fun remove(id: String): Boolean {
        if (!contains(id)) return false
        val p = prev.remove(id)
        val n = next.remove(id)
        if (p != null) next[p] = n else head = n
        if (n != null) prev[n] = p else tail = p
        cache = null
        return true
    }

    fun clear() {
        next.clear()
        prev.clear()
        head = null
        tail = null
        cache = null
    }

    fun toList(): List<String> {
        cache?.let { return it }
        val out = ArrayList<String>(next.size)
        var cur = head
        while (cur != null) {
            out.add(cur)
            cur = next[cur]
        }
        cache = out
        return out
    }
}
