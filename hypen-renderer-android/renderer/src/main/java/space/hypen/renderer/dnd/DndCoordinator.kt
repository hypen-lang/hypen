package space.hypen.renderer.dnd

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.anim.AlwaysAnimate
import space.hypen.renderer.anim.MotionPreference
import kotlin.math.max

private val log = HypenLoggers.renderer.child("Dnd")

/**
 * What the drag runtime needs from the renderer. Every call arrives OUTSIDE
 * the coordinator's lock (the renderer takes its own lock in these paths and
 * the reverse order would deadlock).
 */
interface DndHost {
    /** Send an outcome action / `.on*` event through the renderer's action channel. */
    fun dispatch(sourceId: String, action: String, payload: Map<String, Any?>)

    /**
     * Re-apply a deferred engine prop write through the renderer's normal
     * SetProp path (the runtime is idle for that node first, so nothing
     * re-defers).
     */
    fun applyProp(id: String, name: String, value: Any?)

    /**
     * Overlay one `__anim.statePoses` pose (lowered prop keys → values) on an
     * element so every applicator/component sees it through the ordinary
     * props path (§2.1). Replaces any previous overlay on that element.
     */
    fun setPoseOverrides(id: String, pose: Map<String, Any?>)

    /** Drop the pose overlay; the element's own base props show through again. */
    fun clearPoseOverrides(id: String)
}

/** A rectangle in root pixels (plain Kotlin — no Compose geometry types). */
data class DndRect(
    val left: Double,
    val top: Double,
    val right: Double,
    val bottom: Double,
) {
    val width: Double get() = right - left
    val height: Double get() = bottom - top

    fun contains(x: Double, y: Double): Boolean = x >= left && x < right && y >= top && y < bottom

    fun start(axis: DndAxis): Double = if (axis == DndAxis.X) left else top

    fun length(axis: DndAxis): Double = if (axis == DndAxis.X) width else height

    companion object {
        val Zero = DndRect(0.0, 0.0, 0.0, 0.0)
    }
}

/**
 * How a pending pointer gesture on a source must claim the drag (§6.1).
 * Decided by the coordinator at pointer-down; executed by the Compose
 * gesture (`HypenDnd.kt`), which owns the pending phase.
 */
sealed class DndActivationPlan {
    /** `activation: immediate` — claim on the down itself. */
    object Immediate : DndActivationPlan()

    /** Any-axis slop (mouse/pen under `auto`, or `activation: slop`). */
    object Slop : DndActivationPlan()

    /** Long press (touch outside an axis-constrained sortable, or `activation: press`). */
    object Press : DndActivationPlan()

    /** Touch inside an axis-constrained sortable: slop on the CROSS axis; main-axis travel scrolls. */
    data class CrossAxisSlop(val crossAxis: DndAxis) : DndActivationPlan()
}

/** What the element renderer needs to know to wire one element's modifiers. */
data class DndRole(
    /** Carries an enabled-or-not `__dnd.source` (a lift surface). */
    val isSource: Boolean,
    /** Its layout bounds must be reported (a DnD node, or a child of a sortable/pinboard). */
    val needsBounds: Boolean,
    /** Non-null when the source sits in a sortable — accessibility reorder actions apply. */
    val sortAxis: DndAxis?,
    /**
     * Carries a `.dropZone(files: true)` (enabled or not): the element needs a
     * platform drag-and-drop target for drags coming from OUTSIDE the app.
     */
    val filesZone: Boolean = false,
) {
    companion object {
        val None = DndRole(isSource = false, needsBounds = false, sortAxis = null)
    }
}

/**
 * Renderer-private presentation state of one element, snapshot-backed so the
 * `graphicsLayer {}` reading the ghost offset updates per frame WITHOUT a
 * recomposition, while `lifted` / the shift target recompose only the element
 * they belong to. Ghost and shift are logical-layout offsets in pixels.
 */
@Stable
class DndNodeState internal constructor() {
    var pinX: Float by mutableFloatStateOf(0f)
        internal set
    var pinY: Float by mutableFloatStateOf(0f)
        internal set

    /** The dragged item: raised above its siblings for the drag. */
    var lifted: Boolean by mutableStateOf(false)
        internal set

    var ghostX: Float by mutableFloatStateOf(0f)
        internal set

    var ghostY: Float by mutableFloatStateOf(0f)
        internal set

    /** Sibling gap-opening shift (sortable preview), along the list axis. */
    var shiftX: Float by mutableFloatStateOf(0f)
        internal set

    var shiftY: Float by mutableFloatStateOf(0f)
        internal set
}

/**
 * The renderer-side drag-and-drop state machine for the `__dnd.*` channel
 * (plan §6). It owns everything the protocol needs to be correct and NOTHING
 * that needs a live composition: the parsed channels per node, a structural
 * mirror of the element tree (parent / ordered children / element type — fed
 * by the renderer's patch hooks so no call ever has to re-enter the
 * renderer's lock), the rendered rects the Compose layer reports, the active
 * drag with its sortable previews, zone resolution, poses, the drop commit in
 * §4.2 order, the post-drop hold, and the translate-deferral gate. The
 * Compose layer (`HypenDnd.kt`) is a thin consumer: it runs the pending
 * gesture phase, then calls [claim] / [move] / [drop] / [cancel].
 *
 * Contract points honoured here:
 *
 * - **Zero engine traffic during the drag** except an opted-in
 *   `.onDragStart` at claim and `.onDragOver(dwell:)` once per zone entry.
 * - **Drop ordering (§4.2):** reserved write → `.onSort`/`.onPin`/`.onDrop`
 *   → `.onDragEnd {dropped: true}`. Cancel: only `.onDragEnd {dropped:
 *   false}`. Remove/Detach mid-drag: nothing.
 * - **Hold-until-Move (§6.3):** local offsets stay after the drop until a
 *   Move/Insert of the item (or under the origin/destination container), a
 *   Remove of the item, a `translateX/Y` SetProp on the dragged node
 *   (pinboards), or [holdTimeoutMs] — whichever first.
 * - **Precedence (§6.6):** engine `translateX/translateY` writes to the
 *   dragged node are deferred and flushed at release.
 * - **Poses (§2.1):** `lifted` on the source, `over` on the hovered zone,
 *   overlaid through the host and restored on clear.
 *
 * Thread-safety: patch hooks run on the WebSocket thread while gestures run
 * on the main thread, so all mutable state is guarded by [lock] and every
 * host callback is collected as an effect and invoked AFTER the lock is
 * released.
 */
class DndCoordinator(
    private val motion: MotionPreference = AlwaysAnimate,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    /** Hold window after a drop before local transforms are released (no-flash fallback). */
    var holdTimeoutMs: Long = DND_HOLD_TIMEOUT_MS

    private val lock = Any()
    private var host: DndHost? = null

    // ---- structural mirror of the element tree (all ids, not just DnD nodes)
    private val parents = HashMap<String, String?>()
    private val children = HashMap<String, MutableList<String>>()
    private val types = HashMap<String, String>()

    /** Nodes carrying any `__dnd.*` channel or an `__anim.statePoses` table. */
    private val nodes = HashMap<String, DndNode>()

    /** Layout rects in root px, with this runtime's own offsets subtracted. */
    private val bounds = HashMap<String, DndRect>()
    private var density = 1f

    /** Per-element presentation state, created on first request, dropped with the node. */
    private val states = HashMap<String, DndNodeState>()

    private var drag: Drag? = null
    private var warnedMixedBind = false

    // ---- OS file drags over `.dropZone(files: true)` (renderer-local, no engine state)

    /** What the current OS drag declared at its start (MIME types, item count). */
    private var fileInfo: DndFileDragInfo? = null

    /** Files zones the platform currently reports the drag inside (deepest platform target(s)). */
    private val fileEntered = LinkedHashSet<String>()

    /** Qualifying (enabled, accepting) files zones the drag is inside — entries fire on growth. */
    private val fileContained = HashSet<String>()

    /** The single files zone wearing the `over` pose for an OS drag. */
    private var fileOver: DndNode? = null

    /** Wall clock for the `.onFileDragEnter` `timestamp` (injectable for tests). */
    var clock: () -> Long = { System.currentTimeMillis() }

    /**
     * False from a release until the next claim so sibling shifts snap back
     * to 0 (the engine's Move has already reordered the rows) instead of
     * sliding from stale positions. Read by the Compose layer.
     */
    var shiftMotion: Boolean by mutableStateOf(true)
        private set

    /** True when sibling shifts should tween rather than snap. */
    fun shiftMotionEnabled(): Boolean = shiftMotion && !motion.reducedMotion()

    fun setHost(host: DndHost?) {
        this.host = host
    }

    // ------------------------------------------------------------------
    // Renderer hooks (called under the renderer's lock)
    // ------------------------------------------------------------------

    /** A CREATE landed: mirror the node and (re)parse every `__dnd.*` channel. */
    fun noteCreate(id: String, elementType: String, props: Map<String, Any?>) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            types[id] = elementType
            val kids = children[id]
            if (kids != null) {
                for (kid in kids) parents[kid] = null
                kids.clear()
            } else {
                children[id] = mutableListOf()
            }
            if (!parents.containsKey(id)) parents[id] = null

            val existing = nodes.remove(id)
            if (existing != null) {
                // A CREATE replacing a live participant ends its drag silently.
                cancelSubtreeLocked(id, effects)
                if (existing.poseLabel != null) clearPoseLocked(existing, effects)
                if (fileOver === existing) fileOver = null
                fileContained.remove(id)
            }
            val hasDnd = props.keys.any { it.startsWith(DND_PROP_PREFIX) }
            val poses = props[ANIM_STATE_POSES_PROP]
            if (!hasDnd && poses == null) return@synchronized
            val node = DndNode(id)
            nodes[id] = node
            for ((name, value) in props) {
                when {
                    name.startsWith(DND_PROP_PREFIX) -> assignChannel(node, name, value, present = true)
                    isTrackedPlain(name) -> node.plain[name] = value
                }
            }
            node.poses = DndParse.poses(poses)
        }
        runEffects(effects)
    }

    /**
     * An INSERT / MOVE / ATTACH landed: relink the mirror. During a post-drop
     * hold this is the engine's re-render landing (release); during a live
     * drag a cached list (origin included) changing shape rebuilds its slots.
     */
    fun noteInsert(parentId: String, id: String, beforeId: String?) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            unlinkLocked(id)
            if (parentId == "root") {
                parents[id] = null
            } else {
                parents[id] = parentId
                val list = children.getOrPut(parentId) { mutableListOf() }
                val at = if (beforeId != null) list.indexOf(beforeId) else -1
                if (at >= 0) list.add(at, id) else list.add(id)
            }
            noteStructuralLocked(parentId, id, effects)
        }
        runEffects(effects)
    }

    /** A DETACH (Router cache) unlinked [id]: a drag inside it cancels with NO dispatch. */
    fun noteDetach(id: String) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            cancelSubtreeLocked(id, effects)
            unlinkLocked(id)
            parents[id] = null
        }
        runEffects(effects)
    }

    /**
     * A REMOVE evicted [id] and its subtree: cancel any drag inside, drop
     * every trace, then note the structural change against the old parent —
     * after the unlink, so a cached list rebuilt mid-drag no longer lists the
     * removed row (DOM ordering: `forget` before `noteStructural`).
     */
    fun noteRemove(id: String) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            val parentId = parents[id]
            cancelSubtreeLocked(id, effects)
            unlinkLocked(id)
            forgetSubtreeLocked(id, effects)
            noteStructuralLocked(parentId, id, effects)
        }
        runEffects(effects)
    }

    /**
     * An exit-flagged remove kept [id] alive to play its exit, but the
     * subtree is engine-side dead: a drag inside it cancels with NO dispatch.
     */
    fun cancelSubtree(id: String) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) { cancelSubtreeLocked(id, effects) }
        runEffects(effects)
    }

    /**
     * A SetProp landed. Routes `__dnd.*` channels, the `__anim.statePoses`
     * table and the plain props the runtime reads (`bind`, `id`, `on*`,
     * `padding*`). Returns true when the write was DEFERRED (an engine
     * `translateX/translateY` on the dragged node — §6.6): the renderer must
     * not apply it; it is flushed through [DndHost.applyProp] at release. A
     * translate landing during the post-drop hold is the engine's re-render
     * (a pin position): it releases the hold and flows through the flush.
     */
    fun noteSetProp(id: String, name: String, value: Any?): Boolean {
        val effects = mutableListOf<() -> Unit>()
        val deferred =
            synchronized(lock) {
                val d = drag
                if (d != null && isTranslate(name) && (id == d.source.id || id == d.itemId)) {
                    d.deferred[id to name] = value
                    if (d.phase == Phase.HOLDING) releaseLocked(effects)
                    return@synchronized true
                }
                notePropLocked(id, name, value, present = true, effects)
                false
            }
        runEffects(effects)
        return deferred
    }

    /** A RemoveProp landed. */
    fun noteRemoveProp(id: String, name: String) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) { notePropLocked(id, name, null, present = false, effects) }
        runEffects(effects)
    }

    /** Full reset (renderer clear / reconnect): cancel silently, drop every cache. */
    fun reset() {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            cancelDragLocked(dispatchEnd = false, effects)
            for (node in nodes.values) if (node.poseLabel != null) clearPoseLocked(node, effects)
            nodes.clear()
            parents.clear()
            children.clear()
            types.clear()
            bounds.clear()
            states.clear()
            fileInfo = null
            fileEntered.clear()
            fileContained.clear()
            fileOver = null
            shiftMotion = true
        }
        runEffects(effects)
    }

    // ------------------------------------------------------------------
    // Compose-layer surface (main thread)
    // ------------------------------------------------------------------

    /** Snapshot-backed presentation state for [id] (created on first request). */
    fun stateFor(id: String): DndNodeState = synchronized(lock) { states.getOrPut(id) { DndNodeState() } }

    /** What modifiers [id] needs. */
    fun roleFor(id: String): DndRole =
        synchronized(lock) {
            // Control-flow wrappers render no node of their own.
            if (isControlFlowLocked(id)) return@synchronized DndRole.None
            val node = nodes[id]
            val isSource = node?.source != null
            val container = logicalParentLocked(id)?.let { nodes[it] }
            val inContainer = container != null && (container.sort != null || container.pin != null)
            if (node == null && !inContainer) return@synchronized DndRole.None
            val originSort = if (node != null && isSource) findOriginLocked(node)?.sort else null
            DndRole(
                isSource = isSource,
                needsBounds = true,
                sortAxis = originSort?.axis,
                filesZone = node?.zone?.files == true,
            )
        }

    /**
     * Bounds report (root px) — the node's RENDERED rect: its layout rect plus
     * its own engine `translateX.0`/`translateY.0` (the Compose layer adds
     * them, see `dndTranslatePx`), so a pinned note re-pins from where it is
     * drawn (§6.11 pinboard geometry, `getBoundingClientRect` parity). This
     * runtime's own ghost/shift offsets are folded into the report by the
     * graphics layer when a relayout lands mid-drag, so they are subtracted
     * along the ancestor chain: the stored rect is the rendered rect MINUS
     * the runtime's own offsets.
     */
    fun updateBounds(id: String, left: Float, top: Float, right: Float, bottom: Float, density: Float) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            if (density > 0f) this.density = density
            var dx = 0.0
            var dy = 0.0
            var cur: String? = id
            var guard = 0
            while (cur != null && guard++ < 4096) {
                val s = states[cur]
                if (s != null) {
                    dx += s.ghostX + s.shiftX
                    dy += s.ghostY + s.shiftY
                }
                cur = parents[cur]
            }
            val rect = DndRect(left - dx, top - dy, right - dx, bottom - dy)
            bounds[id] = rect
            projectPinsLocked()
            refreshSlotLocked(id, rect, effects)
        }
        runEffects(effects)
    }

    /**
     * A rect landing mid-drag for a row of a list that was rebuilt after a
     * structural change: the rebuild could not measure rows Compose had not
     * laid out yet (and siblings pushed by the insert re-report here), so
     * refresh that slot in place and re-resolve the target — the pointer may
     * never move again before the drop.
     */
    private fun refreshSlotLocked(id: String, rect: DndRect, effects: MutableList<() -> Unit>) {
        val d = drag ?: return
        if (d.phase != Phase.DRAGGING || d.mode != Mode.POINTER || id == d.itemId) return
        val list = logicalParentLocked(id)?.let { d.lists[it] } ?: return
        if (!list.rebuilt) return
        val i = list.items.indexOf(id)
        if (i == -1 || list.rects[i] == rect) return
        list.rects[i] = rect
        list.gap = gapOf(list.rects, list.axis, list.items.indexOf(d.itemId)) ?: list.gap
        resolveTargetLocked(d, effects)
    }

    /**
     * Pointer down on [sourceId]: how the gesture must claim, or null when
     * the node is not a live, enabled source or another drag (or its hold)
     * is in flight. `auto` ⇒ mouse/pen: any-axis slop; touch inside an
     * axis-constrained sortable: cross-axis slop; touch elsewhere: press.
     */
    fun activationFor(sourceId: String, touch: Boolean): DndActivationPlan? =
        synchronized(lock) {
            if (drag != null) return@synchronized null
            val node = nodes[sourceId] ?: return@synchronized null
            val spec = node.source ?: return@synchronized null
            if (!node.sourceEnabled) return@synchronized null
            when (spec.activation) {
                DndActivation.IMMEDIATE -> DndActivationPlan.Immediate
                DndActivation.SLOP -> DndActivationPlan.Slop
                DndActivation.PRESS -> DndActivationPlan.Press
                DndActivation.AUTO -> {
                    if (!touch) {
                        DndActivationPlan.Slop
                    } else {
                        val originSort = findOriginLocked(node)?.sort
                        if (originSort != null) DndActivationPlan.CrossAxisSlop(originSort.axis.cross)
                        else DndActivationPlan.Press
                    }
                }
            }
        }

    /**
     * The activation threshold was met: lift [sourceId]. [localX]/[localY]
     * is the down position relative to the source's cached (rendered) rect.
     * Engages the ghost + `lifted` pose, caches the origin list's rects, and
     * dispatches an opted-in `.onDragStart`. Returns false when nothing
     * lifted.
     */
    fun claim(sourceId: String, localX: Float, localY: Float): Boolean =
        claimWith(sourceId) { rect ->
            if (rect == null) log.debug { "dnd: no bounds for source $sourceId — zone hit-testing will miss" }
            ((rect?.left ?: 0.0) + localX) to ((rect?.top ?: 0.0) + localY)
        }

    /**
     * [claim] with the down already in ROOT px. The Compose layer maps the
     * down through the element's live transforms (`localToRoot`), so the
     * pointer lands where the finger is even when the element's own engine
     * translate or a pose scale sits between its lift surface and the root —
     * independent of the cached rect.
     */
    fun claimAt(sourceId: String, rootX: Float, rootY: Float): Boolean =
        claimWith(sourceId) { rootX.toDouble() to rootY.toDouble() }

    private inline fun claimWith(sourceId: String, pointer: (DndRect?) -> Pair<Double, Double>): Boolean {
        val effects = mutableListOf<() -> Unit>()
        val claimed =
            synchronized(lock) {
                if (drag != null) return@synchronized false
                val node = nodes[sourceId] ?: return@synchronized false
                if (node.source == null || !node.sourceEnabled) return@synchronized false
                val d = openDragLocked(node, Mode.POINTER)
                val (x, y) = pointer(bounds[sourceId])
                d.pointerX = x
                d.pointerY = y
                claimLocked(d, engageGhost = true, effects)
                true
            }
        runEffects(effects)
        return claimed
    }

    /** Pointer travel since the last call (px). Moves the ghost and re-resolves the target. */
    fun move(sourceId: String, deltaX: Float, deltaY: Float) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            val d = drag ?: return@synchronized
            if (d.source.id != sourceId || d.phase != Phase.DRAGGING || d.mode != Mode.POINTER) return@synchronized
            d.dx += deltaX
            d.dy += deltaY
            d.pointerX += deltaX
            d.pointerY += deltaY
            updateGhostLocked(d)
            resolveTargetLocked(d, effects)
        }
        runEffects(effects)
    }

    /** Pointer released: commit on the current target, or cancel with `.onDragEnd {dropped:false}`. */
    fun drop(sourceId: String) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            val d = drag ?: return@synchronized
            if (d.source.id != sourceId || d.phase != Phase.DRAGGING) return@synchronized
            val target = d.target
            if (target == null) cancelDragLocked(dispatchEnd = true, effects) else commitLocked(d, target, effects)
        }
        runEffects(effects)
    }

    /** Pointer cancelled (system took the pointer): `.onDragEnd {dropped:false}` only. */
    fun cancel(sourceId: String) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            val d = drag ?: return@synchronized
            if (d.source.id != sourceId) return@synchronized
            cancelDragLocked(dispatchEnd = true, effects)
        }
        runEffects(effects)
    }

    /**
     * Accessibility reorder (the Android face of §6.8): move the source's
     * item one slot along its sortable. Runs the exact pointer commit path —
     * `.onDragStart`, the reserved write, `.onSort`, `.onDragEnd` — with no
     * ghost. Returns false when there is nothing to do (edge of the list, not
     * in a sortable, another drag in flight).
     */
    fun accessibilityMove(sourceId: String, delta: Int): Boolean {
        val effects = mutableListOf<() -> Unit>()
        val moved =
            synchronized(lock) {
                if (drag != null) return@synchronized false
                val node = nodes[sourceId] ?: return@synchronized false
                if (node.source == null || !node.sourceEnabled) return@synchronized false
                val origin = findOriginLocked(node) ?: return@synchronized false
                if (origin.sort == null) return@synchronized false
                val d = openDragLocked(node, Mode.ACCESSIBILITY)
                val from = d.originIndex ?: return@synchronized false
                val count = draggableItemsLocked(origin).size
                val to = (from + delta).coerceIn(0, max(0, count - 1))
                if (to == from) return@synchronized false
                claimLocked(d, engageGhost = false, effects)
                commitLocked(d, DropTarget.Sort(origin, to), effects)
                true
            }
        runEffects(effects)
        return moved
    }

    // ------------------------------------------------------------------
    // OS file drags (`.dropZone(files: true)`) — the platform DnD target
    // ------------------------------------------------------------------
    //
    // Files dragged in from OUTSIDE the app (split-screen / freeform /
    // desktop-mode / ChromeOS drags from Files, Photos, another app) arrive
    // as platform drag events, never as pointer gestures — Hypen's in-app DnD
    // is a pointer gesture and never starts a platform drag, so the two can't
    // be confused. The Compose layer feeds each files zone's platform target
    // callbacks here; everything below is renderer-local (no state, no engine
    // round trip) except an opted-in `.onFileDragEnter`.
    //
    // Containment: a zone holds the drag while the platform reports the drag
    // inside it or inside any descendant target (Compose dispatches to the
    // deepest target and EXITS its ancestors; it enters the new target BEFORE
    // exiting the old one, so recomputing on every callback never sees a
    // spurious gap). Of the zones holding the drag, the ones that are enabled
    // and whose `accept:` matches qualify; the deepest wears `over`, and each
    // zone newly qualifying fires its `.onFileDragEnter` once.

    /**
     * A platform drag session started and [info] describes it (null when the
     * event didn't say). Called from the target's `shouldStartDragAndDrop`.
     */
    fun fileDragStarted(info: DndFileDragInfo?) {
        if (info == null) return
        synchronized(lock) { fileInfo = info }
    }

    /** The OS drag entered files zone [id] (as the platform's deepest target). */
    fun fileDragEntered(id: String, info: DndFileDragInfo? = null) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            if (info != null) fileInfo = info
            fileEntered.add(id)
            recomputeFileDragLocked(effects)
        }
        runEffects(effects)
    }

    /** The OS drag left files zone [id] (or moved into a descendant target). */
    fun fileDragExited(id: String) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            if (!fileEntered.remove(id)) return@synchronized
            recomputeFileDragLocked(effects)
        }
        runEffects(effects)
    }

    /** The platform drag session ended (dropped anywhere or cancelled): clear everything. */
    fun fileDragEnded() {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) { endFileDragLocked(effects) }
        runEffects(effects)
    }

    /**
     * Files released on zone [id]. They are NOT delivered: nothing is read,
     * no permission is requested, and the platform is told the drop was not
     * consumed. The hover ends here (the `ended` callback follows anyway).
     * Always false.
     */
    @Suppress("UNUSED_PARAMETER")
    fun fileDrop(id: String): Boolean {
        fileDragEnded()
        return false
    }

    /** The files zone currently wearing `over` for an OS drag, if any (diagnostics / tests). */
    fun fileOverZone(): String? = synchronized(lock) { fileOver?.id }

    private fun endFileDragLocked(effects: MutableList<() -> Unit>) {
        fileEntered.clear()
        fileContained.clear()
        fileInfo = null
        val prev = fileOver
        fileOver = null
        if (prev != null && prev.poseLabel == DND_LABEL_OVER && drag?.overNode !== prev) clearPoseLocked(prev, effects)
    }

    /** Is [node] an enabled files zone whose `accept:` matches the current drag? */
    private fun fileQualifiesLocked(node: DndNode): Boolean {
        val zone = node.zone ?: return false
        if (!zone.files || !node.zoneEnabled) return false
        return DndFileDrag.accepts(zone.accept, fileInfo?.mimeTypes)
    }

    private fun recomputeFileDragLocked(effects: MutableList<() -> Unit>) {
        // Every qualifying zone holding the drag: each entered target and its ancestors.
        val contained = LinkedHashSet<String>()
        for (id in fileEntered) {
            var cur: String? = id
            var guard = 0
            while (cur != null && guard++ < 4096) {
                val node = nodes[cur]
                if (node != null && fileQualifiesLocked(node)) contained.add(cur)
                cur = parents[cur]
            }
        }
        // Once per entry: zones newly holding the drag fire, outermost first.
        val entries = contained.filter { it !in fileContained }.sortedBy { depthLocked(it) }
        fileContained.clear()
        fileContained.addAll(contained)
        for (id in entries) nodes[id]?.let { dispatchFileDragEnterLocked(it, effects) }

        // Innermost wins; one `over` at a time.
        val winner = contained.maxByOrNull { depthLocked(it) }?.let { nodes[it] }
        val prev = fileOver
        if (prev === winner) return
        if (prev != null && prev.poseLabel == DND_LABEL_OVER && drag?.overNode !== prev) clearPoseLocked(prev, effects)
        fileOver = winner
        if (winner != null) applyPoseLocked(winner, DND_LABEL_OVER, effects)
    }

    /**
     * `.onFileDragEnter` on [zone]: `{type: "filedragenter", timestamp, items}`
     * — or the applicator's custom named arguments, which REPLACE that
     * payload (the same rule as `onClick`). Never names, paths or bytes.
     */
    private fun dispatchFileDragEnterLocked(zone: DndNode, effects: MutableList<() -> Unit>) {
        val binding = DndParse.eventBinding(zone.plain, DndEvent.FILE_DRAG_ENTER) ?: return
        val payload: Map<String, Any?> =
            if (binding.customPayload.isNotEmpty()) {
                LinkedHashMap(binding.customPayload)
            } else {
                linkedMapOf(
                    "type" to DND_FILE_DRAG_ENTER_TYPE,
                    "timestamp" to clock(),
                    "items" to (fileInfo?.items ?: 0),
                )
            }
        val sourceId = zone.id
        val envelope = mapOf("node" to sourceId, "action" to binding.actionName, "payload" to payload)
        effects.add { host?.dispatch(sourceId, "__hypen_dispatch", envelope) }
    }

    // ---- diagnostics / tests

    /** True while a claimed drag (dragging or holding) owns nodes. */
    fun isDragging(): Boolean = synchronized(lock) { drag != null }

    /** True during the post-drop hold. */
    fun isHolding(): Boolean = synchronized(lock) { drag?.phase == Phase.HOLDING }

    /** Does the drag own [id] — the source/item, or a sibling holding a preview shift? */
    fun ownsNode(id: String): Boolean =
        synchronized(lock) {
            val d = drag ?: return@synchronized false
            if (id == d.source.id || id == d.itemId) return@synchronized true
            for (list in d.lists.values) {
                for (i in list.items.indices) if (list.shifts[i] != 0.0 && list.items[i] == id) return@synchronized true
            }
            false
        }

    /** The current drop target as a §4.2 location, or null. */
    fun currentTarget(): DndLocation? =
        synchronized(lock) {
            val d = drag ?: return@synchronized null
            d.target?.let { targetLocationLocked(d, it) }
        }

    /** The runtime pose label currently overlaid on [id], if any. */
    fun poseLabelOf(id: String): String? = synchronized(lock) { nodes[id]?.poseLabel }

    // ------------------------------------------------------------------
    // Channel plumbing
    // ------------------------------------------------------------------

    private class DndNode(val id: String) {
        var source: DndSourceSpec? = null
        var hasPayload = false
        var payload: Any? = null
        var sourceEnabled = true
        var key: String? = null
        var zone: DndZoneSpec? = null
        var zoneId: String? = null
        var zoneEnabled = true
        var sort: DndSortSpec? = null
        var pin: DndPinSpec? = null
        var pinGroup: String? = null
        var poses: Map<String, Map<String, Any?>>? = null
        var poseLabel: String? = null

        /** Plain props the runtime reads: `bind`, `id`/`id.0`, `on*`, `padding*`. */
        val plain = LinkedHashMap<String, Any?>()

        val bind: String? get() = plain["bind"] as? String
        val idProp: String? get() = DndParse.string(plain["id.0"] ?: plain["id"])
        val isZoneLike: Boolean get() = zone != null || sort != null || pin != null
    }

    private fun isTrackedPlain(name: String): Boolean {
        if (name == "bind") return true
        val base = DndParse.baseOf(name)
        if (base == "id") return true
        if (base.startsWith("padding")) return true
        return DndEvent.entries.any { it.prop == base }
    }

    private fun isTranslate(name: String): Boolean {
        val base = DndParse.baseOf(name)
        return base == "translateX" || base == "translateY" || name == "__dnd.pinX" || name == "__dnd.pinY"
    }

    private fun notePropLocked(id: String, name: String, value: Any?, present: Boolean, effects: MutableList<() -> Unit>) {
        when {
            name.startsWith(DND_PROP_PREFIX) -> {
                val node = nodes[id] ?: if (present) DndNode(id).also { nodes[id] = it } else return
                assignChannel(node, name, value, present)
                reconfigureLocked(node, effects)
                // A zone enabled / disabled / re-specced under a hovering OS drag.
                if (fileEntered.isNotEmpty()) recomputeFileDragLocked(effects)
            }
            name == ANIM_STATE_POSES_PROP -> {
                val node = nodes[id] ?: if (present) DndNode(id).also { nodes[id] = it } else return
                if (node.poseLabel != null) clearPoseLocked(node, effects)
                node.poses = if (present) DndParse.poses(value) else null
            }
            isTrackedPlain(name) -> {
                val node = nodes[id] ?: return
                if (present) node.plain[name] = value else node.plain.remove(name)
            }
        }
        projectPinsLocked()
    }

    private fun assignChannel(node: DndNode, name: String, value: Any?, present: Boolean) {
        when (name) {
            "__dnd.pinX", "__dnd.pinY" -> {
                if (present) node.plain[name] = value else node.plain.remove(name)
                if (!present) states[node.id]?.let { if (name == "__dnd.pinX") it.pinX = 0f else it.pinY = 0f }
            }
            DND_SOURCE_PROP -> {
                node.source = if (!present) null else DndParse.source(value)
                if (present && node.source == null) log.warn { "dnd: malformed __dnd.source on node ${node.id}; not draggable" }
            }
            DND_SOURCE_PAYLOAD_PROP -> {
                node.hasPayload = present
                node.payload = if (present) value else null
            }
            DND_SOURCE_ENABLED_PROP -> node.sourceEnabled = !present || DndParse.enabled(value)
            DND_KEY_PROP -> node.key = if (present) DndParse.string(value) else null
            DND_ZONE_PROP -> {
                node.zone = if (!present) null else DndParse.zone(value)
                if (present && node.zone == null) log.warn { "dnd: malformed __dnd.zone on node ${node.id}; not a drop zone" }
            }
            DND_ZONE_ID_PROP -> node.zoneId = if (present) DndParse.string(value) else null
            DND_ZONE_ENABLED_PROP -> node.zoneEnabled = !present || DndParse.enabled(value)
            DND_SORT_PROP -> {
                node.sort = if (!present) null else DndParse.sort(value)
                if (present && node.sort == null) log.warn { "dnd: malformed __dnd.sort on node ${node.id}; not sortable" }
            }
            DND_PIN_PROP -> {
                node.pin = if (!present) null else DndParse.pin(value)
                if (present && node.pin == null) log.warn { "dnd: malformed __dnd.pin on node ${node.id}; not a pinboard" }
            }
            DND_PIN_GROUP_PROP -> node.pinGroup = if (present) DndParse.string(value) else null
            else -> log.debug { "dnd: unknown channel $name on ${node.id} — ignored" }
        }
    }

    /** A source going away (or disabled) mid-drag cancels cleanly, with no dispatch. */
    private fun reconfigureLocked(node: DndNode, effects: MutableList<() -> Unit>) {
        val d = drag ?: return
        if (d.source !== node || d.phase == Phase.HOLDING) return
        if (node.source == null || !node.sourceEnabled) cancelDragLocked(dispatchEnd = false, effects)
    }

    // ------------------------------------------------------------------
    // Tree mirror helpers
    // ------------------------------------------------------------------

    private fun isControlFlowLocked(id: String): Boolean {
        val type = types[id] ?: return false
        return type in CONTROL_FLOW_TYPES
    }

    private fun unlinkLocked(id: String) {
        val parentId = parents[id] ?: return
        children[parentId]?.remove(id)
    }

    private fun forgetSubtreeLocked(id: String, effects: MutableList<() -> Unit>) {
        val kids = children.remove(id)
        if (kids != null) for (kid in kids.toList()) forgetSubtreeLocked(kid, effects)
        parents.remove(id)
        types.remove(id)
        bounds.remove(id)
        states.remove(id)
        fileEntered.remove(id)
        fileContained.remove(id)
        val node = nodes.remove(id) ?: return
        if (fileOver === node) fileOver = null
        if (node.poseLabel != null) clearPoseLocked(node, effects)
    }

    /** Nearest ancestor that is not a control-flow wrapper (`ForEach` etc.). */
    private fun logicalParentLocked(id: String): String? {
        var p = parents[id]
        var guard = 0
        while (p != null && isControlFlowLocked(p) && guard++ < 4096) p = parents[p]
        return p
    }

    /** The container a patch `parentId` addresses: a wrapper resolves to its logical parent. */
    private fun containerOfLocked(parentId: String?): String? {
        if (parentId == null) return null
        return if (isControlFlowLocked(parentId)) logicalParentLocked(parentId) else parentId
    }

    /** Children with control-flow wrappers flattened away, in layout order. */
    private fun flattenedChildrenLocked(id: String, into: MutableList<String> = mutableListOf()): MutableList<String> {
        val kids = children[id] ?: return into
        for (kid in kids) {
            if (isControlFlowLocked(kid)) flattenedChildrenLocked(kid, into) else into.add(kid)
        }
        return into
    }

    /** Strict descendant test. */
    private fun isDescendantOfLocked(id: String, ancestorId: String): Boolean {
        var p = parents[id]
        var guard = 0
        while (p != null && guard++ < 4096) {
            if (p == ancestorId) return true
            p = parents[p]
        }
        return false
    }

    private fun depthLocked(id: String): Int {
        var depth = 0
        var p = parents[id]
        while (p != null && depth < 4096) {
            depth++
            p = parents[p]
        }
        return depth
    }

    /** Nearest enclosing sortable / pinboard container of a source. */
    private fun findOriginLocked(source: DndNode): DndNode? {
        var p = parents[source.id]
        var guard = 0
        while (p != null && guard++ < 4096) {
            val node = nodes[p]
            if (node != null && (node.sort != null || node.pin != null)) return node
            p = parents[p]
        }
        return null
    }

    /** The container's (flattened) direct child that contains or is [id]. */
    private fun itemOfLocked(containerId: String, id: String): String? {
        var cur: String? = id
        var guard = 0
        while (cur != null && guard++ < 4096) {
            if (!isControlFlowLocked(cur) && logicalParentLocked(cur) == containerId) return cur
            cur = parents[cur]
        }
        return null
    }

    /** Direct (flattened) children of a container that carry or contain a source. */
    private fun draggableItemsLocked(container: DndNode): List<String> {
        val items = HashSet<String>()
        for (node in nodes.values) {
            if (node.source == null || node.id == container.id) continue
            if (!isDescendantOfLocked(node.id, container.id)) continue
            itemOfLocked(container.id, node.id)?.let { items.add(it) }
        }
        return flattenedChildrenLocked(container.id).filter { it in items }
    }

    private fun indexOfLocked(container: DndNode, itemId: String): Int? {
        val idx = draggableItemsLocked(container).indexOf(itemId)
        return if (idx == -1) null else idx
    }

    // ------------------------------------------------------------------
    // Labels + group compatibility (§4.2, design §4.2)
    // ------------------------------------------------------------------

    private fun containerLabel(node: DndNode): String = node.sort?.group ?: node.pin?.group ?: node.idProp ?: node.id

    private fun zoneLabel(node: DndNode): String = node.zoneId ?: node.idProp ?: node.id

    /**
     * `to.zone` for a plain "into" target (§4.2): a sortable / pinboard hit as
     * a zone (a foreign compatible pinboard) reports its group / `id` / node
     * id, a `.dropZone` its `zoneId` / `id` / node id.
     */
    private fun intoLabel(node: DndNode): String =
        if (node.sort != null || node.pin != null) containerLabel(node) else zoneLabel(node)

    /** `from.zone` for a source outside any sortable/pinboard: the nearest zone, else the parent. */
    private fun looseZoneLabelLocked(source: DndNode): String {
        var p = parents[source.id]
        var guard = 0
        while (p != null && guard++ < 4096) {
            val node = nodes[p]
            if (node != null && node.zone != null) return zoneLabel(node)
            p = parents[p]
        }
        return logicalParentLocked(source.id) ?: source.id
    }

    /** A bare `.draggable()` inside a `.sortable`/`.pinboard` inherits the container's group. */
    private fun effectiveGroup(source: DndNode, origin: DndNode?): String? =
        source.source?.group ?: origin?.sort?.group ?: origin?.pin?.group

    /**
     * A sortable/pinboard always accepts its own children (self-only when its
     * group is null) and, with a group, any source of that group. A grouped
     * drop zone accepts that group; an ungrouped zone accepts ungrouped
     * sources and its own descendants.
     */
    private fun acceptsLocked(zone: DndNode, d: Drag): Boolean {
        val source = d.source
        val isDescendant = isDescendantOfLocked(source.id, zone.id)
        val sourceGroup = effectiveGroup(source, d.origin)
        val sort = zone.sort
        val pin = zone.pin
        if (sort != null || pin != null) {
            val group = sort?.group ?: pin?.group
            return isDescendant || (group != null && sourceGroup == group)
        }
        if (!zone.zoneEnabled) return false
        val spec = zone.zone ?: return false
        val group = spec.group
        return if (group != null) sourceGroup == group else sourceGroup == null || isDescendant
    }

    /** Every zone (dropZone / sortable / pinboard) the drag may target. */
    private fun candidateZonesLocked(d: Drag): List<DndNode> {
        val out = mutableListOf<DndNode>()
        for (node in nodes.values) {
            if (!node.isZoneLike) continue
            if (node === d.source) continue
            // A source is never a zone for itself — nor is anything under the dragged item.
            if (node.id == d.itemId || isDescendantOfLocked(node.id, d.itemId)) continue
            if (!acceptsLocked(node, d)) continue
            out.add(node)
        }
        return out
    }

    // ------------------------------------------------------------------
    // Drag lifecycle
    // ------------------------------------------------------------------

    private enum class Phase { DRAGGING, HOLDING }

    private enum class Mode { POINTER, ACCESSIBILITY }

    private sealed class DropTarget {
        data class Sort(val container: DndNode, val index: Int) : DropTarget()

        data class Zone(val node: DndNode) : DropTarget()

        data class Pin(val container: DndNode) : DropTarget()
    }

    /**
     * Cached geometry + live shifts of one sortable list during a drag. The
     * slots are snapshotted at first use so insertion indices stay stable
     * while siblings tween; a structural change under the list mid-drag
     * rebuilds them from the live children ([rebuildListLocked]).
     */
    private class ListPreview(
        val container: DndNode,
        val axis: DndAxis,
        var items: List<String>,
        var rects: MutableList<DndRect>,
        /** Estimated inter-item gap along the axis. */
        var gap: Double,
    ) {
        var shifts = DoubleArray(items.size)

        /**
         * Set once a structural change rebuilt the list mid-drag: its layout
         * is in flux, so later bounds reports refresh the slots in place
         * (rows inserted by the engine have no rect until Compose lays them
         * out — the rebuild cannot measure them synchronously the way the
         * DOM runtime does).
         */
        var rebuilt = false
    }

    private class Drag(
        val source: DndNode,
        /** The element that moves (sortable row, or the source itself). */
        val itemId: String,
        /** Enclosing sortable / pinboard, if any. */
        val origin: DndNode?,
        /**
         * The dragged item's index in [origin] — the reserved write's `from`.
         * Tracks the item's LIVE index when the origin list changes shape
         * mid-drag; the `from` in the §4.2 event payload stays the lift
         * location ([from]).
         */
        var originIndex: Int?,
        val from: DndLocation,
        /**
         * Item rect at lift: its RENDERED rect (layout + own engine translate,
         * before the ghost transform), so the pin math is base + delta.
         */
        val itemRect: DndRect,
        val mode: Mode,
    ) {
        var phase = Phase.DRAGGING
        var dx = 0.0
        var dy = 0.0
        var pointerX = 0.0
        var pointerY = 0.0
        var target: DropTarget? = null
        var overNode: DndNode? = null
        var dwellJob: Job? = null
        var holdJob: Job? = null
        var ghostEngaged = false
        val lists = LinkedHashMap<String, ListPreview>()

        /** Deferred engine writes to the dragged node's translate keys: (id, name) → value. */
        val deferred = LinkedHashMap<Pair<String, String>, Any?>()
    }

    private fun openDragLocked(source: DndNode, mode: Mode): Drag {
        val origin = findOriginLocked(source)
        val itemId = if (origin?.sort != null) itemOfLocked(origin.id, source.id) ?: source.id else source.id
        val originIndex = origin?.let { indexOfLocked(it, itemId) }
        val from =
            if (origin != null) DndLocation(containerLabel(origin), originIndex)
            else DndLocation(looseZoneLabelLocked(source), null)
        val itemRect = bounds[itemId] ?: DndRect.Zero
        return Drag(source, itemId, origin, originIndex, from, itemRect, mode)
    }

    private fun claimLocked(d: Drag, engageGhost: Boolean, effects: MutableList<() -> Unit>) {
        drag = d
        shiftMotion = true
        if (engageGhost) {
            val state = states.getOrPut(d.itemId) { DndNodeState() }
            state.lifted = true
            d.ghostEngaged = true
            applyPoseLocked(d.source, DND_LABEL_LIFTED, effects)
        }
        // Cache the origin list's rects BEFORE any shift so insertion indices are stable.
        val origin = d.origin
        if (origin?.sort != null) listForLocked(d, origin)
        dispatchEventLocked(d, listOf(d.source, origin), DndEvent.DRAG_START, payloadLocked(d, d.from), effects)
    }

    private fun updateGhostLocked(d: Drag) {
        if (!d.ghostEngaged) return
        val state = states.getOrPut(d.itemId) { DndNodeState() }
        state.ghostX = d.dx.toFloat()
        state.ghostY = d.dy.toFloat()
    }

    private fun listForLocked(d: Drag, container: DndNode): ListPreview {
        d.lists[container.id]?.let { return it }
        val axis = container.sort?.axis ?: DndAxis.Y
        val items = draggableItemsLocked(container)
        val rects = ArrayList<DndRect>(items.size)
        for (item in items) rects.add(if (item == d.itemId) d.itemRect else bounds[item] ?: DndRect.Zero)
        val list = ListPreview(container, axis, items, rects, gapOf(rects, axis) ?: 0.0)
        d.lists[container.id] = list
        return list
    }

    /**
     * Estimated inter-item gap along the axis: the space between the first
     * adjacent pair of slots, neither of which is [skip] — after a rebuild
     * the dragged item keeps its lift rect, which no longer sits next to its
     * live neighbours, so a pair through it would read the hole a removed
     * row left as the gap. Null when no such pair exists.
     */
    private fun gapOf(rects: List<DndRect>, axis: DndAxis, skip: Int = -1): Double? {
        for (i in 0 until rects.size - 1) {
            if (i == skip || i + 1 == skip) continue
            val a = rects[i]
            val b = rects[i + 1]
            return max(0.0, b.start(axis) - (a.start(axis) + a.length(axis)))
        }
        return null
    }

    /**
     * A cached list changed shape mid-drag (an engine insert / move / remove
     * under it — spring-loaded folders do this): rebuild its slots from the
     * live children. Rects come from the bounds store, which already holds
     * each row's layout rect MINUS this runtime's own shift, so a shifted
     * sibling keeps its true slot; shifts follow their items to their new
     * indices; items that left the list get their shift cleared; the dragged
     * item keeps its lift rect. For the origin list the dragged item's live
     * position becomes the reserved write's `from`.
     */
    private fun rebuildListLocked(d: Drag, list: ListPreview) {
        val items = draggableItemsLocked(list.container)
        val rects = ArrayList<DndRect>(items.size)
        val shifts = DoubleArray(items.size)
        for ((i, item) in items.withIndex()) {
            val prev = list.items.indexOf(item)
            shifts[i] = if (prev == -1) 0.0 else list.shifts[prev]
            rects.add(if (item == d.itemId) d.itemRect else bounds[item] ?: DndRect.Zero)
        }
        for ((i, item) in list.items.withIndex()) {
            if (list.shifts[i] == 0.0 || item in items) continue
            states[item]?.let {
                it.shiftX = 0f
                it.shiftY = 0f
            }
        }
        list.items = items
        list.rects = rects
        list.shifts = shifts
        list.gap = gapOf(rects, list.axis, items.indexOf(d.itemId)) ?: list.gap
        list.rebuilt = true
        if (list.container === d.origin) {
            val live = items.indexOf(d.itemId)
            if (live != -1) d.originIndex = live
        }
    }

    /**
     * The cached list a structural change under [container] belongs to: the
     * container itself, or — for a source inserted under an already-inserted
     * row (the engine inserts top-down) — the nearest cached list above it.
     */
    private fun cachedListForLocked(d: Drag, container: String?): ListPreview? {
        var cur = container
        var guard = 0
        while (cur != null && guard++ < 4096) {
            d.lists[cur]?.let { return it }
            cur = parents[cur]
        }
        return null
    }

    /** Final insertion index of the dragged item for a pointer position along the axis. */
    private fun insertionIndex(d: Drag, list: ListPreview, pos: Double): Int {
        var index = 0
        for (i in list.items.indices) {
            if (list.items[i] == d.itemId) continue
            val rect = list.rects[i]
            val mid = rect.start(list.axis) + rect.length(list.axis) / 2.0
            if (pos >= mid) index += 1
        }
        return index
    }

    /** Shift siblings to open the gap for the dragged item at [to] (FLIP-style preview). */
    private fun previewListLocked(d: Drag, list: ListPreview, to: Int) {
        val size = d.itemRect.length(list.axis) + list.gap
        val from = list.items.indexOf(d.itemId)
        var others = 0
        for (i in list.items.indices) {
            val item = list.items[i]
            if (item == d.itemId) continue
            var shift = 0.0
            if (from == -1) {
                if (others >= to) shift = size
            } else if (from < to) {
                if (i > from && others < to) shift = -size
            } else if (to < from) {
                if (i < from && others >= to) shift = size
            }
            others += 1
            shiftItemLocked(list, i, shift)
        }
    }

    private fun shiftItemLocked(list: ListPreview, i: Int, shift: Double) {
        if (list.shifts[i] == shift) return
        list.shifts[i] = shift
        val state = states.getOrPut(list.items[i]) { DndNodeState() }
        if (list.axis == DndAxis.X) state.shiftX = shift.toFloat() else state.shiftY = shift.toFloat()
    }

    private fun restoreListLocked(list: ListPreview) {
        for (i in list.items.indices) {
            if (list.shifts[i] == 0.0) continue
            list.shifts[i] = 0.0
            states[list.items[i]]?.let {
                it.shiftX = 0f
                it.shiftY = 0f
            }
        }
    }

    // ------------------------------------------------------------------
    // Zone resolution (§6.4)
    // ------------------------------------------------------------------

    private fun resolveTargetLocked(d: Drag, effects: MutableList<() -> Unit>) {
        val x = d.pointerX
        val y = d.pointerY
        var innermost: DndNode? = null
        var bestDepth = -1
        for (zone in candidateZonesLocked(d)) {
            val rect = bounds[zone.id] ?: continue
            if (!rect.contains(x, y)) continue
            val depth = depthLocked(zone.id)
            if (depth > bestDepth) {
                innermost = zone
                bestDepth = depth
            }
        }
        val target: DropTarget? =
            when {
                innermost == null -> null
                innermost.sort != null -> {
                    val list = listForLocked(d, innermost)
                    DropTarget.Sort(innermost, insertionIndex(d, list, if (list.axis == DndAxis.X) x else y))
                }
                innermost.pin != null ->
                    if (innermost === d.origin) DropTarget.Pin(innermost) else DropTarget.Zone(innermost)
                else -> resolveBandTargetLocked(d, innermost, x, y)
            }
        setTargetLocked(d, target, effects)
    }

    /** A dropZone on a sortable item: band rule; elsewhere a plain "into". */
    private fun resolveBandTargetLocked(d: Drag, zone: DndNode, x: Double, y: Double): DropTarget {
        var sortable: DndNode? = null
        var bestDepth = -1
        for (node in nodes.values) {
            if (node.sort == null || !acceptsLocked(node, d)) continue
            if (!isDescendantOfLocked(zone.id, node.id)) continue
            val depth = depthLocked(node.id)
            if (depth > bestDepth) {
                sortable = node
                bestDepth = depth
            }
        }
        if (sortable == null) return DropTarget.Zone(zone)
        val list = listForLocked(d, sortable)
        val item = itemOfLocked(sortable.id, zone.id)
        val i = if (item != null) list.items.indexOf(item) else -1
        if (i == -1) return DropTarget.Zone(zone)
        val rect = list.rects[i]
        val pos = if (list.axis == DndAxis.X) x else y
        val band = resolveBand(pos, rect.start(list.axis), rect.length(list.axis), zone.zone?.band ?: DND_DEFAULT_BAND)
        if (band == DndBand.INTO) return DropTarget.Zone(zone)
        var others = 0
        for (k in 0 until i) if (list.items[k] != d.itemId) others += 1
        return DropTarget.Sort(sortable, if (band == DndBand.BEFORE) others else others + 1)
    }

    private fun targetNode(target: DropTarget?): DndNode? =
        when (target) {
            null -> null
            is DropTarget.Sort -> target.container
            is DropTarget.Zone -> target.node
            is DropTarget.Pin -> target.container
        }

    private fun targetLocationLocked(d: Drag, target: DropTarget?): DndLocation =
        when (target) {
            null -> d.from
            is DropTarget.Sort -> DndLocation(containerLabel(target.container), target.index)
            is DropTarget.Zone -> DndLocation(intoLabel(target.node), null)
            is DropTarget.Pin -> DndLocation(containerLabel(target.container), d.originIndex)
        }

    private fun setTargetLocked(d: Drag, target: DropTarget?, effects: MutableList<() -> Unit>) {
        val prevNode = targetNode(d.target)
        val nextNode = targetNode(target)
        // Sortable preview: shift the hovered list; reset lists no longer hovered.
        for (list in d.lists.values) {
            val origin = d.origin
            if (target is DropTarget.Sort && target.container === list.container) {
                previewListLocked(d, list, target.index)
            } else if (origin != null && list.container === origin && origin.sort != null) {
                // Leaving the origin list closes its gap only when hovering a
                // foreign target; hovering nothing keeps the last preview.
                if (target != null) previewListLocked(d, list, d.originIndex ?: 0)
            } else {
                previewListLocked(d, list, Int.MAX_VALUE)
            }
        }
        if (nextNode !== prevNode) {
            if (prevNode != null && prevNode.poseLabel == DND_LABEL_OVER) clearPoseLocked(prevNode, effects)
            clearDwellLocked(d)
            if (nextNode != null) {
                applyPoseLocked(nextNode, DND_LABEL_OVER, effects)
                armDwellLocked(d, nextNode)
            }
        }
        d.target = target
        d.overNode = nextNode
    }

    /** `.onDragOver(dwell:)` fires once per zone entry after the dwell, coalesced. */
    private fun armDwellLocked(d: Drag, zone: DndNode) {
        val binding = DndParse.eventBinding(zone.plain, DndEvent.DRAG_OVER) ?: return
        val dwell = binding.dwell ?: DND_DEFAULT_DWELL_MS
        d.dwellJob =
            scope.launch {
                if (dwell > 0) delay(dwell)
                onDwellFired(d, zone)
            }
    }

    private fun onDwellFired(d: Drag, zone: DndNode) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            if (drag !== d || d.phase != Phase.DRAGGING || d.overNode !== zone) return@synchronized
            d.dwellJob = null
            dispatchEventLocked(d, listOf(zone), DndEvent.DRAG_OVER, payloadLocked(d, targetLocationLocked(d, d.target)), effects)
        }
        runEffects(effects)
    }

    private fun clearDwellLocked(d: Drag) {
        d.dwellJob?.cancel()
        d.dwellJob = null
    }

    // ------------------------------------------------------------------
    // Drop / cancel / release
    // ------------------------------------------------------------------

    /** The single §4.2 payload shape, in wire key order. */
    private fun payloadLocked(d: Drag, to: DndLocation): LinkedHashMap<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["item"] = d.source.key ?: d.source.id
        if (d.source.hasPayload) out["payload"] = d.source.payload
        out["from"] = d.from.toPayload()
        out["to"] = to.toPayload()
        return out
    }

    /**
     * Dispatch [event] to the first candidate carrying that binding. Extra
     * named arguments on the applicator merge UNDER the §4.2 payload.
     */
    private fun dispatchEventLocked(
        d: Drag,
        candidates: List<DndNode?>,
        event: DndEvent,
        payload: Map<String, Any?>,
        effects: MutableList<() -> Unit>,
    ) {
        for (node in candidates) {
            if (node == null) continue
            val binding = DndParse.eventBinding(node.plain, event) ?: continue
            val merged = LinkedHashMap<String, Any?>(binding.customPayload)
            merged.putAll(payload)
            val sourceId = node.id
            val envelope = mapOf("node" to sourceId, "fromNode" to d.origin?.id, "action" to binding.actionName, "payload" to merged)
            effects.add { host?.dispatch(sourceId, "__hypen_dispatch", envelope) }
            return
        }
    }

    private fun dispatchReservedLocked(d: Drag, action: String, payload: Map<String, Any?>, effects: MutableList<() -> Unit>) {
        val sourceId = (d.target as? DropTarget.Sort)?.container?.id ?: (if (d.origin?.bind != null) d.origin?.id else d.source.id) ?: d.source.id
        val envelope = mapOf("node" to sourceId, "fromNode" to d.origin?.id, "action" to action, "payload" to payload)
        effects.add {
            val h = host
            if (h == null) log.warn { "dnd: no host bound; $action dropped" } else h.dispatch(sourceId, "__hypen_dispatch", envelope)
        }
    }

    /**
     * Resolve a drop (§4.2 ordering): (1) the reserved write when a write
     * target exists, (2) `.onSort` / `.onPin` / `.onDrop`, (3) `.onDragEnd
     * {dropped: true}`; then hold the local transforms until the engine's
     * re-render lands (or the timeout).
     */
    private fun commitLocked(d: Drag, target: DropTarget, effects: MutableList<() -> Unit>) {
        clearDwellLocked(d)
        val to = targetLocationLocked(d, target)
        val base = payloadLocked(d, to)
        // Enter the hold BEFORE dispatching: a synchronous host may re-render
        // inside the dispatch, and its Move/SetProp must find the hold to release.
        d.phase = Phase.HOLDING
        d.target = target
        var wroteOrChanged = true
        when (target) {
            is DropTarget.Sort -> {
                val dest = target.container
                val origin = d.origin
                val sameList = dest === origin
                val originIndex = d.originIndex
                if (sameList && originIndex == target.index) {
                    wroteOrChanged = false
                } else {
                    val fromPath = origin?.bind
                    val toPath = dest.bind
                    if (sameList && toPath != null && originIndex != null) {
                        dispatchReservedLocked(
                            d,
                            DND_REORDER_ACTION,
                            linkedMapOf("path" to toPath, "from" to originIndex, "to" to target.index),
                            effects,
                        )
                    } else if (!sameList && fromPath != null && toPath != null && originIndex != null) {
                        dispatchReservedLocked(
                            d,
                            DND_REORDER_ACTION,
                            linkedMapOf("fromPath" to fromPath, "from" to originIndex, "toPath" to toPath, "to" to target.index),
                            effects,
                        )
                    } else if (!sameList && ((fromPath != null) != (toPath != null)) && !warnedMixedBind) {
                        warnedMixedBind = true
                        log.warn { "dnd: cross-list reorder between a bound and an unbound sortable; no reserved write dispatched" }
                    }
                    dispatchEventLocked(d, listOf(dest), DndEvent.SORT, base, effects)
                }
            }
            is DropTarget.Zone -> dispatchEventLocked(d, listOf(target.node), DndEvent.DROP, base, effects)
            is DropTarget.Pin -> commitPinLocked(d, target.container, base, effects)
        }
        if (wroteOrChanged) {
            d.holdJob =
                scope.launch {
                    delay(holdTimeoutMs)
                    onHoldTimeout(d)
                }
        } else {
            releaseLocked(effects)
        }
        val end = LinkedHashMap<String, Any?>(base)
        end["dropped"] = true
        dispatchEventLocked(d, listOf(d.source, d.origin), DndEvent.DRAG_END, end, effects)
    }

    /**
     * §6.5: `(x, y)` = item top-left minus the board's content-box origin, in
     * dp (the renderer's logical unit — what `translateX/translateY` read
     * back), grid-snapped, clamped under `bounds: clamp`, divided by the
     * content size under `units: fraction`. The ghost snaps to the resolved
     * position so the hold shows it.
     */
    private fun commitPinLocked(d: Drag, board: DndNode, base: LinkedHashMap<String, Any?>, effects: MutableList<() -> Unit>) {
        val spec = board.pin ?: return
        val box = contentBoxLocked(board)
        val dens = density.toDouble()
        var px = snapToGrid((d.itemRect.left + d.dx - box.left) / dens, spec.grid)
        var py = snapToGrid((d.itemRect.top + d.dy - box.top) / dens, spec.grid)
        val boxW = box.width / dens
        val boxH = box.height / dens
        if (spec.bounds == DndBounds.CLAMP) {
            px = px.coerceIn(0.0, max(0.0, boxW - d.itemRect.width / dens))
            py = py.coerceIn(0.0, max(0.0, boxH - d.itemRect.height / dens))
        }
        d.dx = px * dens + box.left - d.itemRect.left
        d.dy = py * dens + box.top - d.itemRect.top
        updateGhostLocked(d)
        val x = round3(if (spec.units == DndUnits.FRACTION) (if (boxW > 0.0) px / boxW else 0.0) else px)
        val y = round3(if (spec.units == DndUnits.FRACTION) (if (boxH > 0.0) py / boxH else 0.0) else py)
        val bind = board.bind
        val originIndex = d.originIndex
        val group = spec.group
        val path: String? =
            when {
                bind != null -> if (originIndex != null) userPinPath(bind, originIndex) else null
                group != null -> reservedPinPath(group, d.source.key ?: d.source.id)
                else -> null
            }
        if (path != null) {
            dispatchReservedLocked(
                d,
                DND_PIN_ACTION,
                linkedMapOf("path" to path, "x" to x, "y" to y, "xKey" to spec.xKey, "yKey" to spec.yKey),
                effects,
            )
        }
        val pinPayload = LinkedHashMap<String, Any?>(base)
        pinPayload["x"] = x
        pinPayload["y"] = y
        dispatchEventLocked(d, listOf(board), DndEvent.PIN, pinPayload, effects)
    }

    /** The board's content box in root px: its layout rect inset by its padding props. */
    private fun projectPinsLocked() {
        for ((id, node) in nodes) {
            if (!node.plain.containsKey("__dnd.pinX") && !node.plain.containsKey("__dnd.pinY")) continue
            var parent = logicalParentLocked(id)?.let { nodes[it] }
            while (parent != null && parent.pin == null) parent = logicalParentLocked(parent.id)?.let { nodes[it] }
            val board = parent ?: continue
            val box = contentBoxLocked(board)
            val state = states.getOrPut(id) { DndNodeState() }
            state.pinX = ((node.plain["__dnd.pinX"] as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: 0.0).times(box.width).toFloat()
            state.pinY = ((node.plain["__dnd.pinY"] as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: 0.0).times(box.height).toFloat()
        }
    }

    private fun contentBoxLocked(board: DndNode): DndRect {
        val rect = bounds[board.id] ?: DndRect.Zero
        val pad = paddingDp(board.plain)
        val dens = density.toDouble()
        val left = rect.left + pad[0] * dens
        val top = rect.top + pad[1] * dens
        val right = rect.right - pad[2] * dens
        val bottom = rect.bottom - pad[3] * dens
        return DndRect(left, top, max(left, right), max(top, bottom))
    }

    private fun onHoldTimeout(d: Drag) {
        val effects = mutableListOf<() -> Unit>()
        synchronized(lock) {
            if (drag !== d || d.phase != Phase.HOLDING) return@synchronized
            d.holdJob = null
            releaseLocked(effects)
        }
        runEffects(effects)
    }

    /**
     * A structural change touched [parentId]. During a hold under the origin
     * or destination container (or of the item itself) this is the re-render
     * landing; during a live drag a cached list (origin included) changing
     * shape rebuilds its slots from the live children and re-resolves the
     * target, so the insertion index — and the reserved write's `from` —
     * track the engine's re-render.
     */
    private fun noteStructuralLocked(parentId: String?, id: String, effects: MutableList<() -> Unit>) {
        val d = drag ?: return
        if (d.phase == Phase.HOLDING) {
            if (id == d.itemId || id == d.source.id) {
                releaseLocked(effects)
                return
            }
            val container = containerOfLocked(parentId) ?: return
            val targetId = targetNode(d.target)?.id
            if (container == d.origin?.id || container == targetId) releaseLocked(effects)
            return
        }
        val list = cachedListForLocked(d, containerOfLocked(parentId)) ?: return
        rebuildListLocked(d, list)
        if (d.mode == Mode.POINTER) resolveTargetLocked(d, effects)
    }

    /** A drag whose source or item is at-or-under [rootId] ends silently. */
    private fun cancelSubtreeLocked(rootId: String, effects: MutableList<() -> Unit>) {
        val d = drag ?: return
        if (d.source.id == rootId || d.itemId == rootId ||
            isDescendantOfLocked(d.source.id, rootId) || isDescendantOfLocked(d.itemId, rootId)
        ) {
            cancelDragLocked(dispatchEnd = false, effects)
        }
    }

    /**
     * Abandon a claimed drag: restore everything. With [dispatchEnd] (user
     * cancel) only `.onDragEnd {dropped: false}` fires; without it
     * (Remove/Detach/disable) nothing.
     */
    private fun cancelDragLocked(dispatchEnd: Boolean, effects: MutableList<() -> Unit>) {
        val d = drag ?: return
        val end: LinkedHashMap<String, Any?>? =
            if (dispatchEnd && d.phase == Phase.DRAGGING) {
                payloadLocked(d, targetLocationLocked(d, d.target)).also { it["dropped"] = false }
            } else {
                null
            }
        releaseLocked(effects)
        if (end != null) dispatchEventLocked(d, listOf(d.source, d.origin), DndEvent.DRAG_END, end, effects)
    }

    /** Hand every touched node back to the engine and forget the drag. */
    private fun releaseLocked(effects: MutableList<() -> Unit>) {
        val d = drag ?: return
        drag = null
        clearDwellLocked(d)
        d.holdJob?.cancel()
        d.holdJob = null
        shiftMotion = false
        for (list in d.lists.values) restoreListLocked(list)
        d.overNode?.let { if (it.poseLabel == DND_LABEL_OVER) clearPoseLocked(it, effects) }
        if (d.ghostEngaged) {
            states[d.itemId]?.let {
                it.ghostX = 0f
                it.ghostY = 0f
                it.lifted = false
            }
            if (d.source.poseLabel == DND_LABEL_LIFTED) clearPoseLocked(d.source, effects)
        }
        // Deferred translate writes flow through the renderer's path now that
        // the node is released.
        for ((key, value) in d.deferred) {
            val (id, name) = key
            effects.add { host?.applyProp(id, name, value) }
        }
        d.deferred.clear()
    }

    // ------------------------------------------------------------------
    // Pose overlay (§2.1 runtime labels)
    // ------------------------------------------------------------------

    private fun applyPoseLocked(node: DndNode, label: String, effects: MutableList<() -> Unit>) {
        if (node.poseLabel == label) return
        if (node.poseLabel != null) clearPoseLocked(node, effects)
        val pose = node.poses?.get(label) ?: return
        node.poseLabel = label
        val id = node.id
        effects.add { host?.setPoseOverrides(id, pose) }
    }

    private fun clearPoseLocked(node: DndNode, effects: MutableList<() -> Unit>) {
        if (node.poseLabel == null) return
        node.poseLabel = null
        val id = node.id
        effects.add { host?.clearPoseOverrides(id) }
    }

    private fun runEffects(effects: List<() -> Unit>) {
        for (effect in effects) {
            runCatching(effect).onFailure { log.warn { "dnd: host callback failed: $it" } }
        }
    }

    private companion object {
        val CONTROL_FLOW_TYPES = setOf(
            "ForEach", "__ForEach",
            "Conditional", "__Conditional",
            "When", "__When",
            "If", "__If",
        )
    }
}

/**
 * Resolve a node's padding props to `[left, top, right, bottom]` in dp, the
 * way `PaddingApplicator` does: positional `padding.0..3` with CSS shorthand
 * semantics, named keys, then the per-side / axis applicators override.
 * Unparseable values read as 0.
 */
internal fun paddingDp(props: Map<String, Any?>): DoubleArray {
    val out = DoubleArray(4)
    val positional = (0..3).mapNotNull { i -> props["padding.$i"]?.let { cssLengthDp(it) } }
    when (positional.size) {
        1 -> out.fill(positional[0])
        2 -> {
            out[1] = positional[0]; out[3] = positional[0]
            out[0] = positional[1]; out[2] = positional[1]
        }
        3 -> {
            out[1] = positional[0]
            out[0] = positional[1]; out[2] = positional[1]
            out[3] = positional[2]
        }
        4 -> {
            out[1] = positional[0]; out[2] = positional[1]; out[3] = positional[2]; out[0] = positional[3]
        }
    }
    (props["padding"] as? Number)?.let { out.fill(it.toDouble()) }
    fun side(vararg names: String): Double? = names.firstNotNullOfOrNull { n -> props[n]?.let { cssLengthDp(it) } }
    side("padding.horizontal", "paddingHorizontal.0")?.let { out[0] = it; out[2] = it }
    side("padding.vertical", "paddingVertical.0")?.let { out[1] = it; out[3] = it }
    side("padding.left", "padding.start", "padding.leading", "paddingLeft.0", "paddingStart.0")?.let { out[0] = it }
    side("padding.top", "paddingTop.0")?.let { out[1] = it }
    side("padding.right", "padding.end", "padding.trailing", "paddingRight.0", "paddingEnd.0")?.let { out[2] = it }
    side("padding.bottom", "paddingBottom.0")?.let { out[3] = it }
    return out
}

/** A CSS-ish length as dp: bare numbers and `px`/`dp` are dp, `rem`/`em` ×16, `pt` ×96/72. */
internal fun cssLengthDp(value: Any?): Double? =
    when (value) {
        is Number -> value.toDouble().takeIf { it.isFinite() }
        is String -> {
            val s = value.trim().lowercase()
            when {
                s.endsWith("rem") -> s.removeSuffix("rem").trim().toDoubleOrNull()?.times(16.0)
                s.endsWith("em") -> s.removeSuffix("em").trim().toDoubleOrNull()?.times(16.0)
                s.endsWith("pt") -> s.removeSuffix("pt").trim().toDoubleOrNull()?.times(96.0 / 72.0)
                s.endsWith("px") -> s.removeSuffix("px").trim().toDoubleOrNull()
                s.endsWith("dp") -> s.removeSuffix("dp").trim().toDoubleOrNull()
                else -> s.toDoubleOrNull()
            }
        }
        else -> null
    }
