package space.hypen.renderer.anim

import androidx.compose.runtime.mutableStateMapOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import space.hypen.renderer.HypenLoggers

private val log = HypenLoggers.renderer.child("Anim")

/**
 * Where a naturally-settled playback's `.onAnimationComplete` action goes.
 * Implemented by the renderer (it owns the props and the action channel).
 */
fun interface AnimationCompletionSink {
    fun dispatch(id: String, completion: AnimationCompletion)
}

/**
 * One queued prop glide: the winning spec plus the value the prop held
 * BEFORE the write landed.
 *
 * Capturing `from` at patch time (rather than letting the Compose driver
 * reconstruct it) is what makes the very first glide on a node correct — a
 * driver that starts in the same recomposition as the write would otherwise
 * only ever see the new value on both sides and snap.
 */
data class PendingGlide(val spec: TransitionSpec, val from: Any?)

/**
 * The renderer-side animation state machine for the `__anim.*` channel.
 *
 * This class owns everything the protocol needs to be correct and NOTHING
 * that needs a live composition: channel specs per node, batch lifecycle,
 * enter eligibility, the deferred-remove (exit) contract with its timeout
 * backbone, transaction-vs-node-transition precedence, the reduced-motion
 * gate, and natural-settle completion dispatch. The Compose layer
 * (`HypenAnimation.kt`) is a thin consumer that plays what this decides — so
 * the protocol is exercised by plain JVM unit tests.
 *
 * Protocol invariants honoured here (see `hypen-renderer-android/ANIMATION.md`):
 *
 * - **2, renderers own corpses.** A `Remove{transition:true}` on a node with
 *   an `__anim.exit` spec does not evict: the id is marked exiting, the
 *   subtree is excluded from interaction immediately, and teardown runs on
 *   natural settle OR the `duration + delay + 80ms` timer, whichever fires
 *   first. The timer is unconditional so a composable that never recomposes
 *   (backgrounded, detached window) still finalizes.
 * - **3, first-patch-only preludes.** [beginBatch] takes the stamp the
 *   renderer read at batch index 0 only, and [endBatch] clears it.
 * - **4, natural-settle-only completions.** Interrupted, superseded,
 *   reduced-motion-skipped and looping playbacks dispatch nothing.
 * - **6, snap don't error.** Every malformed spec degrades to null.
 *
 * Thread-safety: patch application runs on the WebSocket thread while
 * composition reads from the main thread, so mutable state is guarded by
 * [lock]. Callbacks into the renderer (finalize, completion dispatch) are
 * always invoked OUTSIDE the lock — the renderer takes its own lock in
 * those paths and the reverse order would deadlock.
 */
class AnimationCoordinator(
    private val motion: MotionPreference = AlwaysAnimate,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val lock = Any()

    /** Parsed channel specs per node id. Dropped on finalize. */
    private val specs = mutableMapOf<String, NodeAnimSpecs>()

    /**
     * Every id created in the batch currently being applied. Serves two
     * rules: enter eligibility (filtered by "has an enter spec" at flush) and
     * the transaction exclusion — a node created this batch never glides a
     * prop write, because its create pose IS its first pose and its queued
     * enter owns the first motion.
     */
    private val createdThisBatch = mutableSetOf<String>()

    /** The first-ever batch never enter-animates (no initial-render cascade). */
    private var firstBatchDone = false

    /** Enters queued by [endBatch], drained by the element's first composition. */
    private val pendingEnters = mutableMapOf<String, EnterSpec>()

    /**
     * Transaction spec for the batch currently being applied (`batchAnimation`
     * prelude at index 0). Cleared by [endBatch] — it never outlives its batch.
     */
    private var transactionSpec: TransitionSpec? = null

    /**
     * Per-node prop writes the current batch decided should glide:
     * id → wire prop key (`backgroundColor.0`) → the glide. Drained by the
     * element's animation driver after the batch lands.
     */
    private val pendingTransitions = mutableMapOf<String, MutableMap<String, PendingGlide>>()

    /** Ids whose enter/exit/preset playback currently owns the node's pose. */
    private val playbackActive = mutableSetOf<String>()

    /** Active `.states` pose label per id — only CHANGES open a settle window. */
    private val stateLabels = mutableMapOf<String, String?>()

    /** Pending `.states` settle jobs, cancelled (firing nothing) when superseded. */
    private val stateSettles = mutableMapOf<String, Job>()

    private class ExitingRoot(
        val spec: ExitSpec?,
        val finalizeRoot: () -> Unit,
        val descendantFinalizes: MutableList<() -> Unit> = mutableListOf(),
        var timeout: Job? = null,
        /** False for the reduced-motion snap path: it fires no completion. */
        val completes: Boolean = true,
    )

    private val exitingRoots = mutableMapOf<String, ExitingRoot>()

    /** Every id inside an exiting subtree → its exiting root id. */
    private val exitingMembership = mutableMapOf<String, String>()

    /**
     * Exit playbacks the Compose layer must play, keyed by the exiting ROOT
     * id. Snapshot-backed: an already-composed element recomposes the moment
     * its remove is deferred. A null spec means "excluded from interaction,
     * nothing to play" (the reduced-motion path).
     */
    private val exitPlaybacks = mutableStateMapOf<String, ExitSpec?>()

    private var completionSink: AnimationCompletionSink? = null

    fun setCompletionSink(sink: AnimationCompletionSink?) {
        completionSink = sink
    }

    // ------------------------------------------------------------------
    // Batch lifecycle
    // ------------------------------------------------------------------

    /**
     * Open a patch batch. [stamp] is the `batchAnimation` spec the renderer
     * read from batch index 0 ONLY (protocol invariant 3) — pass null for an
     * unstamped batch. A malformed stamp degrades to unstamped.
     */
    fun beginBatch(stamp: Map<String, Any?>?) {
        synchronized(lock) {
            createdThisBatch.clear()
            transactionSpec = AnimParse.batchSpec(stamp)
        }
    }

    /**
     * Close a patch batch: queue the enters this batch earned and drop the
     * transaction stamp (strictly batch-scoped — everything it was going to
     * glide has already been recorded).
     */
    fun endBatch() {
        synchronized(lock) {
            val suppress = !firstBatchDone
            if (!suppress) {
                for (id in createdThisBatch) {
                    val enter = specs[id]?.enter ?: continue
                    // Reduced motion skips enters entirely (per node: a
                    // `.motion(essential)` node still plays).
                    if (!motionAllowedLocked(id)) continue
                    pendingEnters[id] = enter
                }
            }
            createdThisBatch.clear()
            firstBatchDone = true
            transactionSpec = null
        }
    }

    /** Test/diagnostic view of the stamp active during the current batch. */
    fun currentTransactionSpec(): TransitionSpec? = synchronized(lock) { transactionSpec }

    // ------------------------------------------------------------------
    // Patch notifications (called under the renderer's lock)
    // ------------------------------------------------------------------

    /** A CREATE landed: re-parse every channel and register enter eligibility. */
    fun noteCreate(id: String, props: Map<String, Any?>) {
        synchronized(lock) {
            val parsed = AnimParse.node(props)
            if (parsed.isEmpty) specs.remove(id) else specs[id] = parsed
            // Initial pose resolution is not a transition — record the label
            // only, so the FIRST label change is recognisable as a change.
            stateLabels[id] = parsed.statesLabel
            createdThisBatch.add(id)
            // A CREATE replacing a live node drops any queued glide for it.
            pendingTransitions.remove(id)
        }
    }

    /**
     * A SetProp/RemoveProp landed on one `__anim.*` channel: re-parse just
     * that channel. Pass null for a RemoveProp.
     *
     * Returns the completion to dispatch when a `.states` label change opens
     * a settle window — the caller does not need to act on it; the window is
     * timed internally.
     */
    fun noteAnimProp(id: String, name: String, value: Any?) {
        val labelChange: Pair<String?, TransitionSpec?>? =
            synchronized(lock) {
                val current = specs[id] ?: NodeAnimSpecs()
                val next =
                    when (name) {
                        ANIM_TRANSITION_PROP -> current.copy(transition = AnimParse.transition(value))
                        ANIM_ENTER_PROP -> current.copy(enter = AnimParse.enter(value))
                        ANIM_EXIT_PROP -> current.copy(exit = AnimParse.exit(value))
                        ANIM_LAYOUT_PROP -> current.copy(layout = AnimParse.layout(value))
                        ANIM_ANIMATE_PROP -> current.copy(animate = AnimParse.animate(value))
                        ANIM_MOTION_PROP -> current.copy(motionEssential = AnimParse.motionEssential(value))
                        ANIM_STATES_PROP -> current.copy(statesLabel = AnimParse.statesLabel(value))
                        else -> {
                            log.debug { "Unknown animation channel $name on $id — ignored" }
                            return@synchronized null
                        }
                    }
                if (next.isEmpty) specs.remove(id) else specs[id] = next

                if (name != ANIM_STATES_PROP) return@synchronized null
                val label = next.statesLabel
                val had = stateLabels.containsKey(id)
                val previous = stateLabels[id]
                stateLabels[id] = label
                // Only a CHANGE opens a settle window, and never for a node
                // that is leaving or one the platform asked to stop moving.
                if (!had || previous == label) return@synchronized null
                if (exitingMembership.containsKey(id)) return@synchronized null
                if (!motionAllowedLocked(id)) return@synchronized null
                label to next.transition
            }

        val (label, transition) = labelChange ?: return
        openStatesSettle(id, label, transition)
    }

    /**
     * An ordinary (non-`__anim.*`) prop write landed. Decides whether it
     * glides and with which spec, recording the result for the element's
     * animation driver.
     *
     * Precedence (normative): structural playbacks (enter/exit) > transaction
     * > node `.transition` > snap.
     */
    fun noteSetProp(id: String, name: String, previousValue: Any?) {
        val base = AnimParse.animatableBase(name) ?: return
        synchronized(lock) {
            // Exiting nodes snap: the exit owns the node's pose.
            if (exitingMembership.containsKey(id)) return
            // Nodes created in this batch are excluded — their queued enter
            // owns the first motion.
            if (id in createdThisBatch) return
            // An in-flight structural playback outranks both spec sources.
            if (id in playbackActive) return
            if (!motionAllowedLocked(id)) return

            val transaction = transactionSpec
            val spec =
                when {
                    transaction != null && transaction.covers(base) -> transaction
                    else -> specs[id]?.transition?.takeIf { it.covers(base) }
                } ?: return
            pendingTransitions.getOrPut(id) { mutableMapOf() }[name] = PendingGlide(spec, previousValue)
            log.debug { "Glide queued: $id.$name (${spec.duration}ms ${spec.curve.wire})" }
        }
    }

    /**
     * A cached Router subtree re-entered the tree. It never enter-animates
     * (it was not created this batch, so it is already excluded) and never
     * replays a FINITE-repeat `.animate` preset — the Compose layer consults
     * [isResumedFromCache] to decide.
     */
    fun noteAttach(id: String) {
        synchronized(lock) {
            pendingEnters.remove(id)
            resumedFromCache.add(id)
        }
    }

    private val resumedFromCache = mutableSetOf<String>()

    /**
     * True while [id] is a subtree that came back through an `attach` rather
     * than a create — finite `.animate` repeats must not replay for it.
     * Consuming clears the flag.
     */
    fun consumeResumedFromCache(id: String): Boolean = synchronized(lock) { resumedFromCache.remove(id) }

    // ------------------------------------------------------------------
    // The deferred-remove (exit) contract
    // ------------------------------------------------------------------

    /**
     * Begin a deferred remove for a flagged root.
     *
     * @param subtreeIds every id at-or-under [id], captured by the renderer
     *   BEFORE any tree mutation — they are all excluded from interaction for
     *   the duration and their own plain Removes defer to this root.
     * @param finalize the renderer's real teardown, run when the exit settles.
     * @return true when teardown was deferred (the caller must NOT evict),
     *   false for a flagged root with no usable exit spec (sanctioned snap).
     */
    fun beginExit(id: String, subtreeIds: Set<String>, finalize: () -> Unit): Boolean {
        var immediate = false
        val deferred =
            synchronized(lock) {
                val existing = exitingRoots[id]
                if (existing != null) {
                    // Duplicate flagged remove for an already-exiting id:
                    // fold it in so exactly one finalize sequence runs.
                    existing.descendantFinalizes.add(finalize)
                    return@synchronized true
                }
                val spec = specs[id]?.exit ?: return@synchronized false

                // An in-flight playback on this node is superseded and must
                // fire nothing; a pending states settle likewise.
                playbackActive.remove(id)
                stateSettles.remove(id)?.cancel()
                pendingTransitions.remove(id)
                pendingEnters.remove(id)

                val allowed = motionAllowedLocked(id)
                val record =
                    ExitingRoot(
                        spec = if (allowed) spec else null,
                        finalizeRoot = finalize,
                        completes = allowed,
                    )
                exitingRoots[id] = record
                for (member in subtreeIds) exitingMembership[member] = id
                exitingMembership[id] = id
                exitPlaybacks[id] = record.spec

                if (allowed) {
                    val budget = spec.duration.toLong() + spec.delay.toLong() + SETTLE_GRACE_MS
                    record.timeout =
                        scope.launch {
                            delay(budget)
                            finalizeExit(id, natural = true)
                        }
                } else {
                    // Reduced motion: exclude from interaction now, finalize
                    // on the next scheduler tick (the DOM's microtask), fire
                    // no completion.
                    immediate = true
                }
                true
            }
        if (immediate) {
            scope.launch { finalizeExit(id, natural = false) }
        }
        return deferred
    }

    /**
     * A plain Remove arrived for an id INSIDE an exiting subtree: its
     * teardown defers to the root's finalize so the subtree stays intact
     * while the exit plays.
     *
     * @return true when the finalize was deferred (the caller must NOT evict).
     */
    fun deferToExitingAncestor(id: String, finalize: () -> Unit): Boolean =
        synchronized(lock) {
            val rootId = exitingMembership[id] ?: return false
            if (rootId == id) return false // the root's own remove is not a descendant
            exitingRoots[rootId]?.descendantFinalizes?.add(finalize) ?: return false
            true
        }

    /** True while [id] is the root of an exit playback. */
    fun isExitingRoot(id: String): Boolean = synchronized(lock) { exitingRoots.containsKey(id) }

    /** True while [id] is anywhere inside an exiting (engine-side dead) subtree. */
    fun isInExitingSubtree(id: String): Boolean = synchronized(lock) { exitingMembership.containsKey(id) }

    /**
     * The exit playback the Compose layer should play for [id], or null.
     * Snapshot-backed read: composables recompose when an exit begins.
     */
    fun exitPlaybackFor(id: String): ExitSpec? = exitPlaybacks[id]

    /**
     * Reactive presence check — true while a deferred remove is in flight for
     * [id], including the reduced-motion path (which excludes the subtree
     * from interaction but plays nothing).
     */
    fun hasExitPlayback(id: String): Boolean = exitPlaybacks.containsKey(id)

    /** Natural settle reported by the Compose layer — fires the completion. */
    fun notifyExitSettled(id: String) {
        finalizeExit(id, natural = true)
    }

    /**
     * Tear an exit down without a settle (interruption): no completion, no
     * timer. Used when a hard Remove supersedes a deferred one.
     */
    fun finalizeExitNow(id: String) {
        finalizeExit(id, natural = false)
    }

    private fun finalizeExit(id: String, natural: Boolean) {
        val record: ExitingRoot
        synchronized(lock) {
            record = exitingRoots.remove(id) ?: return
            record.timeout?.cancel()
            exitPlaybacks.remove(id)
            val members = exitingMembership.filterValues { it == id }.keys.toList()
            for (member in members) {
                exitingMembership.remove(member)
                forgetLocked(member)
            }
        }
        // Outside the lock: the callbacks re-enter the renderer, which takes
        // its own lock (and may call back into this coordinator).
        if (natural && record.completes) {
            dispatchCompletion(id, AnimationCompletion("exit"))
        }
        for (finalizeDescendant in record.descendantFinalizes) {
            runCatching { finalizeDescendant() }
                .onFailure { log.warn { "Exit descendant finalize failed for $id: $it" } }
        }
        runCatching { record.finalizeRoot() }
            .onFailure { log.warn { "Exit finalize failed for $id: $it" } }
    }

    // ------------------------------------------------------------------
    // Compose-layer hand-off
    // ------------------------------------------------------------------

    /** Parsed channels for [id], or null when the node carries none. */
    fun specsFor(id: String): NodeAnimSpecs? = synchronized(lock) { specs[id] }

    /**
     * Take the enter this node earned, if any. One-shot: a second call (a
     * recomposition, a re-entry into composition) returns null, so an enter
     * never replays.
     */
    fun consumePendingEnter(id: String): EnterSpec? = synchronized(lock) { pendingEnters.remove(id) }

    /**
     * Take the prop glides queued for [id] by the last batch. Keys are wire
     * prop names (`backgroundColor.0`).
     */
    fun consumePendingTransitions(id: String): Map<String, PendingGlide> =
        synchronized(lock) { pendingTransitions.remove(id) ?: emptyMap() }

    /**
     * Mark/unmark a structural playback (enter, exit, preset) as owning the
     * node's pose. A node with an active playback is excluded from
     * transaction stamps and node transitions entirely.
     */
    fun setPlaybackActive(id: String, active: Boolean) {
        synchronized(lock) {
            if (active) playbackActive.add(id) else playbackActive.remove(id)
        }
    }

    fun isPlaybackActive(id: String): Boolean = synchronized(lock) { id in playbackActive }

    /**
     * True when [id] may animate: the platform allows motion, or the node
     * carries the `.motion(essential)` opt-out.
     */
    fun motionAllowed(id: String): Boolean = synchronized(lock) { motionAllowedLocked(id) }

    private fun motionAllowedLocked(id: String): Boolean =
        !motion.reducedMotion() || specs[id]?.motionEssential == true

    /** Enter settled naturally — dispatch `{ animation: "enter" }`. */
    fun notifyEnterSettled(id: String) {
        synchronized(lock) {
            // A node that started exiting mid-enter is engine-side dead: the
            // enter was superseded and fires nothing.
            if (exitingMembership.containsKey(id)) return
            if (!motionAllowedLocked(id)) return
        }
        dispatchCompletion(id, AnimationCompletion("enter"))
    }

    /**
     * A finite `.animate` preset completed naturally — dispatch
     * `{ animation: "<presetName>" }`. Looping presets never complete.
     */
    fun notifyPresetCompleted(id: String, preset: AnimatePreset) {
        synchronized(lock) {
            if (exitingMembership.containsKey(id)) return
            if (!motionAllowedLocked(id)) return
        }
        dispatchCompletion(id, AnimationCompletion(preset.wire))
    }

    /**
     * Time a `.states` pose glide and dispatch `{ animation: "states", state }`
     * when it settles. Per-prop settle signals are not reliable for a
     * multi-prop pose switch, so the window is sized off the node's
     * `.transition` timing (the same one the pose flip glides with). A node
     * without a transition settles instantly.
     */
    private fun openStatesSettle(id: String, label: String?, transition: TransitionSpec?) {
        val budget =
            if (transition == null) 0L
            else transition.duration.toLong() + transition.delay.toLong() + SETTLE_GRACE_MS
        val job =
            scope.launch {
                if (budget > 0) delay(budget)
                val stillOurs =
                    synchronized(lock) {
                        if (exitingMembership.containsKey(id)) return@synchronized false
                        stateSettles.remove(id)
                        stateLabels[id] == label
                    }
                if (stillOurs) dispatchCompletion(id, AnimationCompletion("states", label))
            }
        val superseded = synchronized(lock) { stateSettles.put(id, job) }
        // A superseding label change cancels the pending window, which then
        // fires nothing (invariant 4).
        superseded?.cancel()
    }

    private fun dispatchCompletion(id: String, completion: AnimationCompletion) {
        val sink = completionSink ?: return
        runCatching { sink.dispatch(id, completion) }
            .onFailure { log.warn { "Completion dispatch failed for $id: $it" } }
    }

    // ------------------------------------------------------------------
    // Teardown
    // ------------------------------------------------------------------

    /** Drop every trace of [id] (a plain, non-deferred removal). */
    fun forget(id: String) {
        synchronized(lock) { forgetLocked(id) }
    }

    private fun forgetLocked(id: String) {
        specs.remove(id)
        createdThisBatch.remove(id)
        pendingEnters.remove(id)
        pendingTransitions.remove(id)
        playbackActive.remove(id)
        stateLabels.remove(id)
        stateSettles.remove(id)?.cancel()
        resumedFromCache.remove(id)
    }

    /** Full reset (renderer clear / reconnect). Finalizers are NOT run. */
    fun reset() {
        val jobs = mutableListOf<Job>()
        synchronized(lock) {
            specs.clear()
            createdThisBatch.clear()
            pendingEnters.clear()
            pendingTransitions.clear()
            playbackActive.clear()
            stateLabels.clear()
            stateSettles.values.forEach { jobs.add(it) }
            stateSettles.clear()
            resumedFromCache.clear()
            exitingRoots.values.forEach { root -> root.timeout?.let { jobs.add(it) } }
            exitingRoots.clear()
            exitingMembership.clear()
            exitPlaybacks.clear()
            transactionSpec = null
            firstBatchDone = false
        }
        jobs.forEach { it.cancel() }
    }
}
