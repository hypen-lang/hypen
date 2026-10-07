import Foundation
import SwiftUI

#if canImport(UIKit) && !os(watchOS)
import UIKit
#endif

private let log = HypenLoggers.renderer

/// The renderer-side animation runtime for the `__anim.*` channel.
///
/// Division of labour: this type owns everything that is *state* — which
/// nodes are entering, which subtrees are exiting corpses the renderer must
/// finalize itself, what animation a node's next whitelisted prop change
/// should glide on, and the settle timers that drive `.onAnimationComplete`.
/// The view layer (`AnimationModifiers.swift`) owns everything that is
/// *pixels*: it reads the pose/animation this type writes onto each
/// `HypenElement` and hands it to SwiftUI.
///
/// The mechanism throughout is the per-element implicit
/// `.animation(_:value:)` prescribed by `ANIMATION.md`, never an ambient
/// `withAnimation` around patch application: a batch mixes nodes with
/// different specs, unspecced nodes, and structurally-excluded nodes, and
/// SwiftUI's implicit per-node animation OUTRANKS an ambient transaction —
/// which would inverse the normative precedence chain (structural >
/// transaction > node `.transition` > snap). Resolving the effective
/// animation per node and feeding it to the implicit modifier is the form
/// that gets the precedence right; see `resolveTransitionAnimation`.
///
/// Implemented channels (stage 1): `.transition`, `.enter`, `.exit` (with
/// the deferred-remove contract), `.states` glides + completions,
/// `.animate` presets, `batchAnimation`, `.motion(essential)`,
/// `.onAnimationComplete`. NOT implemented (stage 2, sanctioned snap):
/// `.layout` FLIP, `.sharedElement`, `.scrub`/`.settle`.
@MainActor
public final class HypenAnimator {

    // MARK: - Collaborators

    private unowned let renderer: HypenRenderer

    /// Where `.onAnimationComplete` dispatches go. Set by the host that
    /// owns both the renderer and the engine handle (`HypenViewModel`).
    public var actionDispatcher: ActionDispatcher?

    /// The clock every deferred step rides. Swap for
    /// `HypenManualAnimationScheduler` in tests.
    public var scheduler: HypenAnimationScheduler

    /// Per-instance reduce-motion override (tests, host policy). `nil`
    /// falls through to the platform preference.
    public var reducedMotionOverride: Bool?

    public var reducedMotion: Bool {
        reducedMotionOverride ?? HypenReducedMotion.isEnabled
    }

    // MARK: - Batch state

    /// `batchAnimation` prelude timing for the batch being applied — a
    /// stamp at batch index 0 ONLY. Cleared at the end of every batch.
    private(set) public var transactionTiming: AnimTiming?

    private var createdInBatch: [String] = []
    private var createdInBatchSet: Set<String> = []
    /// Ids the batch wrote props to, deduped — a batch routinely lands
    /// several SetProps on one node and the batch-end resolution only ever
    /// needs to run once per node.
    private var touchedInBatch: [String] = []
    private var touchedInBatchSet: Set<String> = []

    /// The first-ever batch must not cascade enters (initial render).
    private var hasAppliedFirstBatch = false

    // MARK: - Playback bookkeeping

    /// An exiting subtree the renderer now owns. The engine-side ids are
    /// already dead — there is no ack round-trip — so teardown is ours.
    private struct ExitingRoot {
        let rootId: String
        /// Every id at-or-under the root at the moment the exit began.
        var members: Set<String>
        var finalize: HypenScheduledWork?
    }

    private var exitingRoots: [String: ExitingRoot] = [:]
    /// id → the exiting root that owns it (root maps to itself).
    private var exitingMembership: [String: String] = [:]

    private var enterWork: [String: HypenScheduledWork] = [:]
    private var enterCompletions: [String: HypenScheduledWork] = [:]
    private var animateCompletions: [String: HypenScheduledWork] = [:]
    private var statesCompletions: [String: HypenScheduledWork] = [:]

    /// Last observed `__anim.states` label / `__anim.animate` spec per id,
    /// so `endBatch` can tell a real change from a re-render.
    private var lastStatesLabel: [String: String?] = [:]
    private var lastAnimateSpec: [String: AnimAnimateSpec?] = [:]

    // MARK: - Init

    init(renderer: HypenRenderer, scheduler: HypenAnimationScheduler = HypenAnimationScheduler()) {
        self.renderer = renderer
        self.scheduler = scheduler
    }

    // MARK: - Queries

    /// True while `id` sits anywhere inside a subtree playing its exit.
    /// Such nodes are engine-side dead: excluded from hit-testing, event
    /// dispatch, focus and accessibility, and they snap rather than glide.
    public func isExiting(_ id: String) -> Bool {
        exitingMembership[id] != nil
    }

    /// The exiting root that owns `id`, if any.
    public func exitingRootId(for id: String) -> String? {
        exitingMembership[id]
    }

    /// Whether this node may animate at all: reduced motion snaps
    /// everything, but `.motion(essential)` exempts a node from every one
    /// of those shortcuts.
    public func motionAllowed(_ element: HypenElement) -> Bool {
        !reducedMotion || element.animSpecs.motionEssential
    }

    // MARK: - Batch lifecycle

    /// Read the transaction prelude and reset per-batch tracking.
    ///
    /// A `batchAnimation` is a stamp at batch index 0 ONLY. Anywhere else
    /// — including inside an accumulated or replayed initialTree — it is
    /// not a stamp; that is what stops concatenated batches from
    /// over-scoping (ANIMATION.md, invariant 3).
    func beginBatch(_ patches: [Patch]) {
        createdInBatch.removeAll(keepingCapacity: true)
        createdInBatchSet.removeAll(keepingCapacity: true)
        touchedInBatch.removeAll(keepingCapacity: true)
        touchedInBatchSet.removeAll(keepingCapacity: true)

        if let first = patches.first, first.type == .batchAnimation,
           let spec = first.spec {
            transactionTiming = HypenAnim.timing(spec)
        } else {
            transactionTiming = nil
        }
    }

    func noteCreate(_ element: HypenElement) {
        createdInBatch.append(element.id)
        createdInBatchSet.insert(element.id)
        // Seed the states label so the pose a node is BORN in is not
        // mistaken for a pose switch: `.states` completions fire on label
        // changes, never on initial resolution. `.animate` is deliberately
        // not seeded — a preset starts playing the moment the node exists,
        // so its finite settle must be armed at create.
        lastStatesLabel[element.id] = element.animSpecs.statesLabel
    }

    func noteProps(changedOn element: HypenElement) {
        guard !createdInBatchSet.contains(element.id) else { return }
        if touchedInBatchSet.insert(element.id).inserted {
            touchedInBatch.append(element.id)
        }
    }

    /// Resolve everything that depends on the batch as a whole: the
    /// effective glide animation per touched node, queued enters, and the
    /// `.states` / `.animate` re-arms.
    func endBatch() {
        for id in touchedInBatch {
            guard let element = renderer.getElement(id) else { continue }
            // The glide animation for this node's whitelisted prop changes,
            // resolved through the precedence chain.
            element.animTransitionAnimation = resolveTransitionAnimation(element)
            // `.states` and `.animate` re-arms: driven off a real change in
            // the parsed channel, not merely off a patch touching the node.
            reconcileStates(element)
            reconcileAnimate(element)
        }

        for id in createdInBatch {
            guard let element = renderer.getElement(id) else { continue }
            // The first-ever batch must not cascade enters — initial render
            // is not a structural change. Every later batch's creations are
            // real insertions and do enter-animate.
            if hasAppliedFirstBatch {
                queueEnter(element)
            }
            // A `.animate` preset starts playing the moment its node
            // exists, initial render included.
            reconcileAnimate(element)
        }

        hasAppliedFirstBatch = true
        transactionTiming = nil
    }

    /// Precedence chain (normative, spec:754–774):
    /// **structural playbacks > transaction > node `.transition` > snap.**
    func resolveTransitionAnimation(_ element: HypenElement) -> Animation? {
        // Structural: an exiting corpse snaps; a node created in this batch
        // has a queued enter that owns its first motion.
        if isExiting(element.id) { return nil }
        if createdInBatchSet.contains(element.id) { return nil }
        // Reduced motion ignores stamps and node specs alike, except for
        // `.motion(essential)` nodes.
        guard motionAllowed(element) else { return nil }
        // The transaction overrides the node's own `.transition` for the
        // props this batch writes.
        if let transaction = transactionTiming { return transaction.animation }
        if let spec = element.animSpecs.transition { return spec.timing.animation }
        return nil
    }

    // MARK: - Enter

    /// Queue a created node's enter: snap it to the hidden pose now, then
    /// animate back to base on the next tick.
    ///
    /// Enter plays ONLY for nodes created in the same patch batch — the
    /// first-ever batch is suppressed and a cached Router `Attach` never
    /// qualifies (it goes through `applyAttach`, never `applyCreate`).
    private func queueEnter(_ element: HypenElement) {
        guard let spec = element.animSpecs.enter else { return }
        guard motionAllowed(element) else { return }
        guard !isExiting(element.id) else { return }

        let id = element.id
        enterWork[id]?.cancel()
        enterCompletions[id]?.cancel()
        enterCompletions[id] = nil

        element.animPoseAnimation = nil
        element.animPose = HypenAnim.hiddenPose(presets: spec.presets, direction: spec.from)

        enterWork[id] = scheduler.schedule(after: 0) { [weak self, weak element] in
            guard let self, let element else { return }
            self.enterWork[id] = nil
            guard !self.isExiting(id) else { return }
            element.animPoseAnimation = spec.timing.animation
            element.animPose = nil
            self.enterCompletions[id] = self.scheduler.schedule(
                after: spec.timing.totalSeconds
            ) { [weak self, weak element] in
                guard let self, let element else { return }
                self.enterCompletions[id] = nil
                self.dispatchCompletion(element: element, animation: "enter")
            }
        }
    }

    // MARK: - Exit / the deferred-remove contract

    /// Hook for `HypenRenderer.applyRemove`. Returns `true` when the
    /// animator has taken ownership of the subtree and the renderer must
    /// NOT tear it down.
    ///
    /// Wire ordering is root-first: the flagged root `Remove` arrives
    /// before its descendants' plain `Remove`s (parent-remove-wins), so a
    /// plain remove landing inside an already-exiting subtree defers to
    /// that root's finalize rather than tearing children out from under a
    /// playing exit.
    func noteRemove(patch: Patch, element: HypenElement) -> Bool {
        let id = element.id

        if let rootId = exitingMembership[id] {
            if patch.transition && rootId == id {
                // A flagged remove for an already-exiting root: keep the
                // newest finalize, never double-finalize.
                restartFinalize(rootId: id, element: element)
            }
            return true
        }

        guard patch.transition else { return false }
        guard let spec = element.animSpecs.exit else { return false }
        // Reduced motion finalizes flagged removes immediately: returning
        // false hands the subtree straight back to the renderer's normal
        // synchronous teardown, which is the snap.
        guard motionAllowed(element) else { return false }

        beginExit(element: element, spec: spec)
        return true
    }

    private func beginExit(element: HypenElement, spec: AnimExitSpec) {
        let rootId = element.id
        let members = renderer.subtreeIds(of: rootId)

        // 1. Exclude the subtree from interaction IMMEDIATELY, before the
        //    playback starts — four planes: hit-testing, event dispatch,
        //    accessibility, and focus/IME. The first three are per-element
        //    flags the view layer reads; the fourth is a best-effort
        //    first-responder resign (see `resignFocusIfNeeded`).
        for memberId in members {
            exitingMembership[memberId] = rootId
            guard let member = renderer.getElement(memberId) else { continue }
            member.isAnimationExcluded = true
            member.animTransitionAnimation = nil
            cancelPlaybacks(for: memberId, keepingExit: memberId == rootId)
        }
        resignFocusIfNeeded(members: members)

        exitingRoots[rootId] = ExitingRoot(rootId: rootId, members: members, finalize: nil)

        // 2. Play the exit: glide the root to the inverse of its presets.
        element.animPoseAnimation = spec.timing.animation
        element.animPose = HypenAnim.hiddenPose(presets: spec.presets, direction: spec.to)

        // 3. Finalize on the timeout backbone.
        scheduleFinalize(rootId: rootId, timing: spec.timing)
        log.debug("EXIT: deferring teardown of \(rootId) (\(members.count) nodes)")
    }

    private func restartFinalize(rootId: String, element: HypenElement) {
        guard let spec = element.animSpecs.exit else { return }
        scheduleFinalize(rootId: rootId, timing: spec.timing)
    }

    private func scheduleFinalize(rootId: String, timing: AnimTiming) {
        exitingRoots[rootId]?.finalize?.cancel()
        exitingRoots[rootId]?.finalize = scheduler.schedule(
            after: timing.settleTimeoutSeconds
        ) { [weak self] in
            self?.finalizeExit(rootId: rootId)
        }
    }

    /// Purge an exiting subtree: dispatch the exit completion (natural
    /// settle, fired on the exiting ROOT by design), then hand the whole
    /// subtree — root and every deferred descendant — to the renderer's
    /// teardown.
    func finalizeExit(rootId: String) {
        guard let root = exitingRoots.removeValue(forKey: rootId) else { return }
        root.finalize?.cancel()

        if let element = renderer.getElement(rootId) {
            dispatchCompletion(element: element, animation: "exit", isExitRoot: true)
        }

        for memberId in root.members {
            exitingMembership.removeValue(forKey: memberId)
            cancelPlaybacks(for: memberId, keepingExit: false)
            clearNodeState(memberId)
        }

        renderer.tearDownSubtree(rootId)
        // The finalize fires on its own timer, outside any patch batch, so
        // the batch-end tree notification never runs for it.
        renderer.notifyTreeChanged()
        log.debug("EXIT: finalized \(rootId)")
    }

    /// Best-effort focus/IME plane: `allowsHitTesting(false)` does not make
    /// a focused text field resign, and SwiftUI exposes no way to ask "is
    /// the first responder inside this subtree". When an exiting subtree
    /// contains any focusable input element, resign the app's first
    /// responder so the keyboard cannot stay attached to a corpse.
    ///
    /// Recorded narrowing: this can resign a field OUTSIDE the exiting
    /// subtree in the rare case where an unrelated field held focus while
    /// an input-bearing subtree exited. Losing focus is the conservative
    /// failure; keeping a keyboard bound to a dead node is not.
    private func resignFocusIfNeeded(members: Set<String>) {
        let focusable: Set<String> = [
            "input", "textarea", "textfield", "select", "checkbox",
            "switch", "slider", "radio", "search",
        ]
        let hasInput = members.contains { memberId in
            guard let element = renderer.getElement(memberId) else { return false }
            return focusable.contains(element.elementType.lowercased())
        }
        guard hasInput else { return }
        #if canImport(UIKit) && !os(watchOS) && !os(tvOS)
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
        )
        #endif
    }

    // MARK: - `.states`

    /// Pose flips arrive as ordinary SetProps and glide through the
    /// `.transition` channel — the engine synthesizes a scoped
    /// `__anim.transition` for `.states`, so the glide is free. All this
    /// adds is the completion timing, keyed off label changes and sized by
    /// the node's transition duration + delay.
    private func reconcileStates(_ element: HypenElement) {
        let id = element.id
        let label = element.animSpecs.statesLabel
        let previous = lastStatesLabel[id] ?? nil
        guard label != previous else { return }
        lastStatesLabel[id] = label

        // Supersede: an in-flight states settle that is retargeted fires
        // NOTHING.
        statesCompletions[id]?.cancel()
        statesCompletions[id] = nil

        guard let label = label else { return }
        guard motionAllowed(element), !isExiting(id) else { return }
        guard let timing = element.animSpecs.transition?.timing else { return }

        statesCompletions[id] = scheduler.schedule(after: timing.totalSeconds) {
            [weak self, weak element] in
            guard let self, let element else { return }
            self.statesCompletions[id] = nil
            self.dispatchCompletion(element: element, animation: "states", state: label)
        }
    }

    // MARK: - `.animate`

    /// (Re)arm a node's `.animate` playback bookkeeping. The playback
    /// itself is view-local (see `HypenAnimatePresetModifier`); what lives
    /// here is the finite-repeat settle that fires the completion and
    /// latches the "never replay on a cached attach" flag.
    ///
    /// A changed spec restarts playback; a removed channel stops it;
    /// looping presets never complete.
    private func reconcileAnimate(_ element: HypenElement) {
        let id = element.id
        let spec = element.animSpecs.animate
        let previous = lastAnimateSpec[id] ?? nil
        guard spec != previous else { return }
        lastAnimateSpec[id] = spec

        animateCompletions[id]?.cancel()
        animateCompletions[id] = nil
        element.animateFiniteExhausted = false
        element.animateGeneration &+= 1

        guard let spec = spec, motionAllowed(element), !isExiting(id) else { return }
        guard case .count(let iterations) = spec.repeatCount else { return }

        let seconds = (spec.timing.delayMs + spec.timing.durationMs * Double(iterations)) / 1000
        animateCompletions[id] = scheduler.schedule(after: seconds) { [weak self, weak element] in
            guard let self, let element else { return }
            self.animateCompletions[id] = nil
            element.animateFiniteExhausted = true
            self.dispatchCompletion(element: element, animation: spec.preset.rawValue)
        }
    }

    // MARK: - Completions

    /// Fire a node's `.onAnimationComplete` action for a NATURALLY settled
    /// playback.
    ///
    /// Interrupted, superseded, and reduced-motion-skipped playbacks fire
    /// nothing; looping presets never complete. Two further suppressions:
    /// a node in a Router-detached (cached) subtree dispatches nothing, and
    /// a node inside an exiting subtree is engine-side dead — only the
    /// exiting ROOT's own `"exit"` completion fires.
    func dispatchCompletion(
        element: HypenElement,
        animation: String,
        state: String? = nil,
        isExitRoot: Bool = false
    ) {
        let id = element.id
        if !isExitRoot && isExiting(id) { return }
        if renderer.isInDetachedSubtree(id) { return }
        guard let dispatcher = actionDispatcher else { return }
        guard let action = ActionValue.from(
            element.props[HypenAnim.completeProp] ?? element.props["onAnimationComplete"]
        ) else { return }

        // Extra named args from the applicator ride under the payload; the
        // completion fields are written LAST so `animation`/`state` can
        // never be shadowed by a custom arg.
        var payload: [String: Any] = action.payload
        let prefix = "onAnimationComplete."
        for (key, value) in element.props where key.hasPrefix(prefix) {
            let suffix = String(key.dropFirst(prefix.count))
            if suffix == "0" { continue }
            payload[suffix] = value
        }
        payload["animation"] = animation
        if let state = state { payload["state"] = state }

        // Node-addressed, like every other element event: the engine resolves
        // the owning module from `node` (a bare action name is ambiguous in
        // multi-module apps). An exit completion addresses the exiting ROOT's
        // own — already engine-removed — id; the engine's exit tombstone
        // accepts it for that node's `onAnimationComplete` action.
        NodeActionDispatcher(base: dispatcher, node: id)
            .dispatch(action: action.actionName, payload: payload)
    }

    // MARK: - Teardown

    private func cancelPlaybacks(for id: String, keepingExit: Bool) {
        enterWork[id]?.cancel()
        enterWork[id] = nil
        enterCompletions[id]?.cancel()
        enterCompletions[id] = nil
        statesCompletions[id]?.cancel()
        statesCompletions[id] = nil
        if !keepingExit {
            animateCompletions[id]?.cancel()
            animateCompletions[id] = nil
        }
    }

    private func clearNodeState(_ id: String) {
        lastStatesLabel.removeValue(forKey: id)
        lastAnimateSpec.removeValue(forKey: id)
        animateCompletions[id]?.cancel()
        animateCompletions[id] = nil
    }

    /// Drop every trace of `id` — called by the renderer when an element is
    /// purged for any reason (plain remove, Router LRU eviction, clear).
    func noteElementRemoved(_ id: String) {
        cancelPlaybacks(for: id, keepingExit: false)
        clearNodeState(id)
        if let rootId = exitingMembership.removeValue(forKey: id), rootId == id {
            exitingRoots[id]?.finalize?.cancel()
            exitingRoots.removeValue(forKey: id)
        }
    }

    func reset() {
        for work in enterWork.values { work.cancel() }
        for work in enterCompletions.values { work.cancel() }
        for work in animateCompletions.values { work.cancel() }
        for work in statesCompletions.values { work.cancel() }
        for root in exitingRoots.values { root.finalize?.cancel() }
        enterWork.removeAll()
        enterCompletions.removeAll()
        animateCompletions.removeAll()
        statesCompletions.removeAll()
        exitingRoots.removeAll()
        exitingMembership.removeAll()
        lastStatesLabel.removeAll()
        lastAnimateSpec.removeAll()
        createdInBatch.removeAll()
        createdInBatchSet.removeAll()
        touchedInBatch.removeAll()
        touchedInBatchSet.removeAll()
        transactionTiming = nil
        hasAppliedFirstBatch = false
    }
}
