package space.hypen.renderer.dnd

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.ui.draganddrop.DragAndDropTarget
import androidx.compose.ui.draganddrop.toAndroidDragEvent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.changedToUpIgnoreConsumed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import space.hypen.renderer.model.HypenElement
import kotlin.math.abs
import kotlin.math.max

/**
 * The Compose face of the drag-and-drop protocol.
 *
 * Everything that decides WHAT a gesture means lives in [DndCoordinator];
 * this file only wires one element to it, in TWO halves around the element's
 * applicator chain (see [HypenDndModifiers]):
 *
 * - **Ghost + preview (outer).** A `graphicsLayer {}` reads the coordinator's
 *   per-element ghost offset and sibling shift at layer-update time — a drag
 *   frame costs no recomposition — and moves the WHOLE element: playback
 *   pose, hit target, focus and accessibility node included. The shift
 *   tweens (150ms, DOM parity) while dragging and snaps at release, when the
 *   engine's `Move` has already reordered the rows. The lifted item is raised
 *   with `zIndex`.
 * - **Geometry (outer + inner).** `onGloballyPositioned` right below the ghost
 *   layer reports the element's LAYOUT rect in root px, plus the element's
 *   own engine `translateX.0`/`translateY.0` ([dndTranslatePx]) — the
 *   injected translate layers are the innermost modifiers, invisible to a
 *   node measured above them, and the coordinator needs the RENDERED rect
 *   (§6.11 pinboard geometry: a positioned note re-pins from where it is
 *   drawn). A translate write re-reports without a layout pass (a layer-only
 *   update never fires `onGloballyPositioned`). Zone resolution and the
 *   sortable preview hit-test those rects (the ghost is under the pointer,
 *   so hit-testing the pointer target would find the ghost itself).
 * - **Lift surface (inner).** `pointerInput` INSIDE the applicator chain, so
 *   the hit region is the element's rendered content — a pinned note lifts
 *   where it is displayed, not at its untranslated layout box. Pointer
 *   positions are mapped through the element's live transforms
 *   (`localToRoot`): the down lands in root px and every move delta is a
 *   root delta even under a scaled `lifted` pose.
 * - **Activation (§6.1).** The pending phase runs inside one
 *   `awaitEachGesture`: a down opens it, the coordinator's plan says how it
 *   claims (any-axis slop, cross-axis slop with main-axis travel abandoning
 *   to the scroll, a 300ms press, or immediately). Below the threshold the
 *   block returns without consuming anything — a tap is a TOTAL no-op, child
 *   clicks untouched. From the claim on, every change of the claiming pointer
 *   is consumed (the Compose equivalent of pointer capture) until ITS up
 *   (drop) — a second finger never inherits the drag (§6.2) — or a cancel:
 *   the pointer vanishing, an inner detector consuming a move, or the system
 *   unwinding the gesture coroutine (`ACTION_CANCEL`, the node leaving the
 *   tree), which all end in `.onDragEnd {dropped:false}`.
 * - **Files from the OS.** A `.dropZone(files: true)` gets a platform
 *   `dragAndDropTarget` (inner half) for drags from OUTSIDE the app — the
 *   in-app DnD above is a pointer gesture and never starts a platform drag.
 *   The callbacks only feed [DndCoordinator]'s `fileDrag*` surface (the
 *   `over` pose, `.onFileDragEnter`); the drop is refused, nothing is read
 *   and no drag-and-drop permission is requested. See [rememberFileDropTarget].
 * - **Accessibility.** A source inside a sortable exposes "Move up/down"
 *   (or left/right) custom actions that run the exact pointer commit path —
 *   the Android idiom for the keyboard drag of §6.8.
 */
@Composable
fun rememberHypenDnd(
    element: HypenElement,
    coordinator: DndCoordinator?,
): HypenDndModifiers {
    if (coordinator == null) return HypenDndModifiers.None
    val id = element.id
    val revision = element.propsRevision
    val role = remember(id, revision) { coordinator.roleFor(id) }
    if (!role.needsBounds) return HypenDndModifiers.None

    val state = remember(id) { coordinator.stateFor(id) }
    val geometry = remember(id) { DndGeometry() }
    val density = LocalDensity.current.density
    val haptics = LocalHapticFeedback.current

    // The element's own engine translate (null = 0), folded into every bounds
    // report. Read during composition so a `translateX.0` SetProp (a
    // propsRevision bump, hence a recomposition) refreshes it.
    val (translateX, translateY) = dndTranslatePx(element.props, density)
    geometry.translateX = translateX
    geometry.translateY = translateY
    // A translate write changes the rendered rect without a layout pass
    // (layer-only update): re-report from the last coordinates.
    LaunchedEffect(id, coordinator, translateX, translateY, state.pinX, state.pinY, density) {
        geometry.report(coordinator, id, density)
    }

    // Sibling shift: tween while dragging, snap once released.
    val animateShift = coordinator.shiftMotionEnabled()
    val shiftX by animateFloatAsState(
        targetValue = state.shiftX,
        animationSpec = if (animateShift) tween<Float>(DND_SHIFT_DURATION_MS, easing = FastOutSlowInEasing) else snap<Float>(),
    )
    val shiftY by animateFloatAsState(
        targetValue = state.shiftY,
        animationSpec = if (animateShift) tween<Float>(DND_SHIFT_DURATION_MS, easing = FastOutSlowInEasing) else snap<Float>(),
    )

    // OUTER: the layer lambda reads the ghost offset at layer-update time: a
    // drag frame moves pixels without recomposing the element.
    var outer: Modifier =
        Modifier.graphicsLayer {
            translationX = state.pinX + state.ghostX + shiftX
            translationY = state.pinY + state.ghostY + shiftY
        }
    if (state.lifted) {
        outer = outer.zIndex(DND_LIFTED_Z_INDEX)
    }
    outer =
        outer.onGloballyPositioned { coordinates ->
            geometry.outer = coordinates
            geometry.report(coordinator, id, density)
        }

    // INNER: below the applicators (and the engine's translate layers), so
    // the lift surface is the rendered content and the coordinates map the
    // pointer through every transform above it.
    var inner: Modifier = Modifier.onGloballyPositioned { coordinates -> geometry.inner = coordinates }
    if (role.isSource) {
        inner = inner.pointerInput(id, coordinator) { detectDndGesture(id, coordinator, geometry, haptics) }
        val axis = role.sortAxis
        if (axis != null) {
            val prevLabel = if (axis == DndAxis.X) "Move left" else "Move up"
            val nextLabel = if (axis == DndAxis.X) "Move right" else "Move down"
            inner =
                inner.semantics {
                    customActions =
                        listOf(
                            CustomAccessibilityAction(prevLabel) { coordinator.accessibilityMove(id, -1) },
                            CustomAccessibilityAction(nextLabel) { coordinator.accessibilityMove(id, 1) },
                        )
                }
        }
    }
    if (role.filesZone) {
        inner = inner.then(rememberFileDropTarget(id, coordinator))
    }
    return HypenDndModifiers(outer, inner)
}

/**
 * The platform drop target of one `.dropZone(files: true)`.
 *
 * - `shouldStartDragAndDrop` takes part only in drags that come from outside
 *   the app and carry content ([DndFileDrag.classify]: no local state, at
 *   least one non-Intent MIME type). Enabled / `accept:` are decided by the
 *   coordinator per callback, so a zone enabled mid-drag lights up.
 * - Only the `ClipDescription` (MIME types) is inspected. `ClipData` is not
 *   available before the drop and is never read at it.
 * - `onDrop` returns false: the platform treats the drop as not consumed
 *   (the shadow animates back) and the source keeps its data. No
 *   `requestDragAndDropPermissions`, no URI access.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun rememberFileDropTarget(id: String, coordinator: DndCoordinator): Modifier {
    val shouldStart: (DragAndDropEvent) -> Boolean =
        remember(id, coordinator) {
            { event ->
                val info = fileDragInfoOf(event)
                coordinator.fileDragStarted(info)
                info != null
            }
        }
    val target =
        remember(id, coordinator) {
            object : DragAndDropTarget {
                override fun onEntered(event: DragAndDropEvent) {
                    coordinator.fileDragEntered(id, fileDragInfoOf(event))
                }

                override fun onExited(event: DragAndDropEvent) {
                    coordinator.fileDragExited(id)
                }

                override fun onEnded(event: DragAndDropEvent) {
                    coordinator.fileDragEnded()
                }

                override fun onDrop(event: DragAndDropEvent): Boolean = coordinator.fileDrop(id)
            }
        }
    return Modifier.dragAndDropTarget(shouldStartDragAndDrop = shouldStart, target = target)
}

/**
 * Describe a platform drag from its `ClipDescription` only (MIME types) —
 * null when it is not an external content drag. `clipData` is non-null only
 * at the drop (never read there); while hovering the item count is unknown (0).
 */
private fun fileDragInfoOf(event: DragAndDropEvent): DndFileDragInfo? {
    val drag = runCatching { event.toAndroidDragEvent() }.getOrNull() ?: return null
    val description = drag.clipDescription
    val mimeTypes = description?.let { d -> (0 until d.mimeTypeCount).map { d.getMimeType(it) } }
    return DndFileDrag.classify(mimeTypes, hasLocalState = drag.localState != null)
}

/**
 * The two halves of an element's DnD modifier chain. [outer] (ghost /
 * shift layer, z-raise, layout-rect report) goes OUTERMOST — before the
 * playback pose and the applicators; [inner] (rendered-rect coordinates,
 * lift surface, accessibility actions) goes INNERMOST — after them, so it
 * sits inside the element's own `translateX`/`translateY` layers:
 * `outer.then(applicators).then(inner)`. Both are `Modifier` (no-op) for an
 * element the runtime has no role for.
 */
@Immutable
class HypenDndModifiers internal constructor(
    val outer: Modifier,
    val inner: Modifier,
) {
    companion object {
        val None = HypenDndModifiers(Modifier, Modifier)
    }
}

/**
 * Per-element geometry bridge between the composition and the coordinator
 * (plain fields, not snapshot state — nothing recomposes on it).
 */
private class DndGeometry {
    /** Coordinates of the node right below the ghost layer: the layout rect. */
    @Volatile var outer: LayoutCoordinates? = null

    /** Coordinates of the innermost node: the rendered content, for pointer mapping. */
    @Volatile var inner: LayoutCoordinates? = null

    /** The element's own engine translate, root px. */
    @Volatile var translateX: Float = 0f

    @Volatile var translateY: Float = 0f

    /**
     * Report the rendered rect: the layout rect (fresh from the coordinates —
     * they resolve through the current layers, so this is safe to call from
     * an effect as well as from the position callback) plus the engine
     * translate. The coordinator subtracts the runtime's own offsets.
     */
    fun report(coordinator: DndCoordinator, id: String, density: Float) {
        val coordinates = outer ?: return
        if (!coordinates.isAttached) return
        val rect = coordinates.boundsInRoot()
        coordinator.updateBounds(
            id,
            rect.left + translateX,
            rect.top + translateY,
            rect.right + translateX,
            rect.bottom + translateY,
            density,
        )
    }

    /** A local position of the innermost node in root px, or null when it is not attached. */
    fun toRoot(local: Offset): Offset? {
        val coordinates = inner ?: return null
        if (!coordinates.isAttached) return null
        return coordinates.localToRoot(local)
    }

    /**
     * A change's travel as a ROOT delta: both endpoints are mapped through
     * the same current transforms, so the ghost's own translation cancels
     * and a pose scale is undone. Falls back to the local delta when the
     * node is not attached.
     */
    fun rootDelta(change: PointerInputChange): Offset {
        val to = toRoot(change.position) ?: return change.positionChange()
        val from = toRoot(change.previousPosition) ?: return change.positionChange()
        return to - from
    }
}

/** Raise for the lifted item (siblings sit at 0). */
private const val DND_LIFTED_Z_INDEX = 1f

/**
 * One pointer gesture on a source. The pending phase (activation) is local to
 * this coroutine; the coordinator only learns about the gesture when it
 * claims.
 */
private suspend fun PointerInputScope.detectDndGesture(
    id: String,
    coordinator: DndCoordinator,
    geometry: DndGeometry,
    haptics: HapticFeedback,
) {
    val slopPx = DND_SLOP_DP.dp.toPx()
    awaitEachGesture {
        // `requireUnconsumed = false`: a child `clickable` consumes the down in
        // the Main pass before this node sees it; the drag still starts from
        // anywhere on the lift surface.
        val down = awaitFirstDown(requireUnconsumed = false)
        val touch = down.type == PointerType.Touch
        val plan = coordinator.activationFor(id, touch) ?: return@awaitEachGesture
        val claimed: PointerInputChange? =
            when (plan) {
                DndActivationPlan.Immediate -> down
                DndActivationPlan.Slop -> awaitDndSlop(down.id, null, slopPx)
                is DndActivationPlan.CrossAxisSlop -> awaitDndSlop(down.id, plan.crossAxis, slopPx)
                DndActivationPlan.Press -> awaitDndPress(down, slopPx)
            }
        // Below the threshold — a tap, a scroll, a release before the press —
        // is a TOTAL no-op: nothing consumed, nothing dispatched.
        if (claimed == null) return@awaitEachGesture
        // The down in root px, through the element's live transforms (its own
        // engine translate included); the local fallback resolves against the
        // cached rendered rect.
        val downRoot = geometry.toRoot(down.position)
        val lifted =
            if (downRoot != null) coordinator.claimAt(id, downRoot.x, downRoot.y)
            else coordinator.claim(id, down.position.x, down.position.y)
        if (!lifted) return@awaitEachGesture
        if (plan == DndActivationPlan.Press) {
            runCatching { haptics.performHapticFeedback(HapticFeedbackType.LongPress) }
        }
        // Travel accumulated while pending counts toward the ghost (DOM parity:
        // dx/dy are measured from the down).
        val initial =
            (geometry.toRoot(claimed.position) ?: claimed.position) - (downRoot ?: down.position)
        claimed.consume()
        // true = the claiming pointer went up (drop); false = cancelled; null =
        // the coroutine was unwound before either (system cancel).
        var outcome: Boolean? = null
        try {
            coordinator.move(id, initial.x, initial.y)
            outcome = trackClaimedPointer(claimed.id, geometry) { delta -> coordinator.move(id, delta.x, delta.y) }
        } finally {
            // Runs on the normal exits AND when the pointer-input coroutine is
            // reset under us (`ACTION_CANCEL`, the modifier leaving the tree):
            // the coordinator must never keep a drag no pointer drives.
            if (outcome == true) coordinator.drop(id) else coordinator.cancel(id)
        }
    }
}

/**
 * Pointer capture on the claiming pointer only (§6.2): every change of
 * [pointerId] is consumed and its ROOT delta handed to [onMove] until that
 * pointer goes up — true, a drop, even with other pointers still down (a
 * second finger never inherits the drag). False when the pointer vanished
 * from the event stream or an inner detector consumed a move first.
 */
private suspend fun AwaitPointerEventScope.trackClaimedPointer(
    pointerId: PointerId,
    geometry: DndGeometry,
    onMove: (Offset) -> Unit,
): Boolean {
    while (true) {
        val event = awaitPointerEvent()
        val change = event.changes.firstOrNull { it.id == pointerId } ?: return false
        if (change.changedToUpIgnoreConsumed()) {
            change.consume()
            return true
        }
        if (change.isConsumed) return false
        // Read the delta BEFORE consuming (a consumed change reports zero).
        val delta = geometry.rootDelta(change)
        change.consume()
        onMove(delta)
    }
}

/**
 * Wait for [slopPx] of travel. With a [crossAxis] (touch in an
 * axis-constrained sortable) only cross-axis travel claims; main-axis travel
 * past the slop is a scroll and abandons the gesture. Returns null when the
 * pointer went up, was consumed by another detector (a parent scroll claimed
 * it in the Final pass), or scrolled.
 */
private suspend fun AwaitPointerEventScope.awaitDndSlop(
    pointerId: PointerId,
    crossAxis: DndAxis?,
    slopPx: Float,
): PointerInputChange? {
    var total = Offset.Zero
    while (true) {
        val event = awaitPointerEvent()
        val change = event.changes.firstOrNull { it.id == pointerId } ?: return null
        if (change.isConsumed || change.changedToUpIgnoreConsumed()) return null
        total += change.positionChange()
        if (crossAxis == null) {
            if (max(abs(total.x), abs(total.y)) >= slopPx) return change
        } else {
            val cross = if (crossAxis == DndAxis.X) total.x else total.y
            val main = if (crossAxis == DndAxis.X) total.y else total.x
            if (abs(cross) >= slopPx) return change
            if (abs(main) >= slopPx) return null
        }
        // Let parents see the move in the Final pass; if a scroll container
        // claimed it, stand down.
        awaitPointerEvent(PointerEventPass.Final)
        if (change.isConsumed) return null
    }
}

/**
 * Long-press activation: the pointer must stay within [slopPx] for
 * [DND_PRESS_MS]. Movement past the slop, an up, or a consumption cancels
 * (null). Returns the latest change (or the down) when the press fires.
 */
private suspend fun AwaitPointerEventScope.awaitDndPress(
    down: PointerInputChange,
    slopPx: Float,
): PointerInputChange? {
    var last: PointerInputChange = down
    var cancelled = false
    var total = Offset.Zero
    val finished =
        withTimeoutOrNull(DND_PRESS_MS) {
            while (true) {
                val event = awaitPointerEvent()
                val change = event.changes.firstOrNull { it.id == down.id }
                if (change == null || change.isConsumed || change.changedToUpIgnoreConsumed()) {
                    cancelled = true
                    return@withTimeoutOrNull
                }
                total += change.positionChange()
                if (max(abs(total.x), abs(total.y)) >= slopPx) {
                    cancelled = true
                    return@withTimeoutOrNull
                }
                last = change
                awaitPointerEvent(PointerEventPass.Final)
                if (change.isConsumed) {
                    cancelled = true
                    return@withTimeoutOrNull
                }
            }
        }
    // A non-null result means the loop exited (only ever by cancelling); null
    // means the timeout elapsed with the pointer still down: the press fired.
    if (finished != null || cancelled) return null
    return last
}
