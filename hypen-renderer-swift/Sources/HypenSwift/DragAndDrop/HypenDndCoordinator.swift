import Foundation
import SwiftUI

private let log = HypenLoggers.renderer

/// The renderer-resident drag-and-drop runtime — the iOS consumer of the
/// engine's `__dnd.*` wire (`hypen-web/docs/dnd.md` /
/// §6), structured after `HypenAnimator` and ported from the DOM reference
/// (`hypen-web/packages/web/src/dom/dnd.ts`, `DomDnd`).
///
/// Division of labour mirrors the animation runtime: this type owns
/// everything that is *state* — which node is lifted, what the pointer is
/// over, the cached list geometry and sibling shifts, the runtime `.states`
/// labels, the post-drop hold, the deferred engine writes — and drives it
/// onto per-element fields (`dndGhostOffset`, `dndShift`, `dndRaised`,
/// `dndPoseLabel`) that the view layer (`DndModifiers.swift`) turns into
/// pixels. One coordinator per `HypenRenderer` (= per host view).
///
/// Invariants (non-negotiable, §6):
///
/// * **Zero engine traffic during the drag.** The gesture, the ghost, the
///   gap-opening shifts, the zone highlight and the pin snap are all
///   local. Only the opted-in `.onDragStart` / `.onDragOver` and the drop
///   outcome cross the boundary, through `actionDispatcher`.
/// * **A tap is a total no-op.** Below-slop travel (or a release before the
///   press fires) never claims the node and dispatches nothing.
/// * **Drop ordering (§4.2):** the reserved write (`__hypen_reorder` /
///   `__hypen_pin`) when a write target exists, then `.onSort` / `.onPin` /
///   `.onDrop`, then `.onDragEnd {dropped: true}`. A cancel fires only
///   `.onDragEnd {dropped: false}`; a `Remove` / `Detach` mid-drag cancels
///   with NO dispatch — a dead interaction must never write state. Any
///   other structural change under a cached list (the origin included)
///   rebuilds its slots so the write's `from` / `to` track the engine's
///   array.
/// * **Hold until `Move`.** After a drop the local transforms are kept until
///   the engine's re-render lands on the dragged node (a `Move` / insert
///   under the origin or destination, a `Remove` of the item, a translate
///   `SetProp` on it) or the 500ms fallback — no flash (§6.3).
/// * **dnd > everything else.** Engine `SetProp`s to `translateX` /
///   `translateY` on the lifted node are deferred until release (§6.6).
///
/// Recorded narrowings (capability matrix): the platform decides "touch"
/// (SwiftUI exposes no pointer type — every non-macOS build is touch, so an
/// iPad trackpad drag follows the touch rules); one drag at a time (a
/// second finger on another source is ignored until release); the keyboard
/// path (§6.8) is omitted — VoiceOver users reorder through the author's
/// own controls; no Esc cancel (a drop outside any zone cancels); no
/// autoscroll while dragging near a scroll edge; a `RemoveProp` of a
/// translate key on the lifted node is not deferred (the injected binding
/// never emits one); extra named args on an event applicator (including
/// `animate:`) merge under the payload exactly like clicks do on iOS.
@MainActor
public final class HypenDndCoordinator {

    // MARK: - Collaborators

    /// Internal (not private) so the OS-file-drag half in
    /// `FileDropZones.swift` can reach the element tree.
    unowned let renderer: HypenRenderer

    /// Where every DnD dispatch goes — the reserved outcome actions and the
    /// six event applicators. Set by the host that owns both the renderer
    /// and the engine handle (`HypenViewModel`), like the animator's.
    public var actionDispatcher: ActionDispatcher?

    /// The clock the dwell and the post-drop hold ride. Swap for
    /// `HypenManualAnimationScheduler` in tests.
    public var scheduler: HypenAnimationScheduler

    /// Per-instance reduce-motion override (tests, host policy). `nil`
    /// falls through to the platform preference.
    public var reducedMotionOverride: Bool?

    /// Hold window after a drop before local transforms are released when no
    /// engine re-render lands.
    public var cleanupTimeoutSeconds: TimeInterval = HypenDnd.cleanupTimeoutSeconds
    /// Long-press activation delay.
    public var pressSeconds: TimeInterval = HypenDnd.pressSeconds
    /// Slop threshold for slop-style activations.
    public var slopPoints: CGFloat = HypenDnd.slopPoints

    /// Whether pointer input is a finger. SwiftUI exposes no pointer type,
    /// so this is platform-derived: touch everywhere but macOS. Tests set
    /// it explicitly.
    public var isTouchInput: Bool = {
        #if os(macOS)
        return false
        #else
        return true
        #endif
    }()

    public var reducedMotion: Bool {
        reducedMotionOverride ?? HypenReducedMotion.isEnabled
    }

    /// The named coordinate space this coordinator's host declares, and
    /// the one its sources' gestures report in. Unique per coordinator
    /// (`HypenDnd.coordinateSpaceName` plus the object identity) so an
    /// embedded `HypenApp` host nested inside a `HypenView` host never
    /// aliases its parent's space.
    public var coordinateSpaceName: String {
        "\(HypenDnd.coordinateSpaceName).\(UInt(bitPattern: ObjectIdentifier(self).hashValue))"
    }

    // MARK: - State

    /// Layout frames of every DnD-relevant node in the host coordinate
    /// space (`coordinateSpaceName`), fed by the view layer's anchor
    /// preferences as layout settles. These are LAYOUT rects: the anchor
    /// sits outside the element's own transforms, and SwiftUI's `offset` is
    /// invisible to modifiers applied after it, so a node's own engine
    /// translate and its runtime ghost / shift offsets are NOT in its entry
    /// (an ancestor's offsets are — anchors resolve through them). Read
    /// through `frame(of:)`, which adds the node's own engine translate to
    /// give the rendered rect the DOM gets from `getBoundingClientRect`
    /// (§6.11: a re-pin starts from the rendered top-left).
    private(set) public var frames: [String: CGRect] = [:]

    /// Ids carrying any `__dnd.*` role — the candidate set zone resolution
    /// scans, so a move never walks the whole element map.
    private var roleIds: Set<String> = []

    private var drag: ActiveDrag?

    /// The OS-file-drag hover state (`files: true` zones) — independent of
    /// `drag`, which only ever holds a renderer-local gesture drag. Driven
    /// by `FileDropZones.swift`.
    let fileHover = FileHoverState()

    private var warnedMixedBind = false
    private var warnedNoDispatcher = false
    private var warnedVariantPose: Set<String> = []

    // MARK: - Init

    init(renderer: HypenRenderer, scheduler: HypenAnimationScheduler = HypenAnimationScheduler()) {
        self.renderer = renderer
        self.scheduler = scheduler
    }

    // MARK: - Queries

    /// Where the interaction stands, for hosts and tests.
    public enum Phase: Equatable, Sendable {
        case idle
        /// A gesture began on a source but has not met its activation yet.
        case pending
        /// The node is lifted and following the pointer.
        case dragging
        /// Dropped; local transforms held until the engine's re-render lands.
        case holding
    }

    public var phase: Phase {
        guard let drag = drag else { return .idle }
        switch drag.phase {
        case .pending, .abandoned: return .pending
        case .dragging: return .dragging
        case .holding: return .holding
        }
    }

    /// The source element currently lifted (or held), if any.
    public var activeSourceId: String? {
        guard let drag = drag, drag.phase == .dragging || drag.phase == .holding else { return nil }
        return drag.sourceId
    }

    /// True while a claimed drag or its post-drop hold owns `id` (the
    /// source or the moving item): the node's translates are the runtime's.
    public func ownsNode(_ id: String) -> Bool {
        guard let drag = drag, drag.phase == .dragging || drag.phase == .holding else { return false }
        return id == drag.sourceId || id == drag.itemId
    }

    /// Whether the view layer must attach the DnD modifiers to `element`:
    /// it plays a role, carries runtime poses, or is a direct (host) child
    /// of a sortable / pinboard — the row the ghost and the shifts move.
    func isRelevant(_ element: HypenElement) -> Bool {
        if !element.dndSpecs.isEmpty { return true }
        return hostParent(of: element)?.dndSpecs.isContainer ?? false
    }

    // MARK: - Gesture selection (view layer)

    /// How the view layer should recognize a lift on `element`.
    public enum ActivationMode: Equatable, Sendable {
        /// A `DragGesture` with this minimum distance (0 = immediate).
        case drag(minimumDistance: CGFloat)
        /// Long-press, then drag.
        case press
    }

    /// §6.1: `auto` ⇒ mouse: slop; touch in an axis-constrained sortable:
    /// slop (the cross-axis rule is applied to the first sample in
    /// `dragChanged`); touch elsewhere: press. Explicit activations map
    /// directly.
    public func activationMode(for element: HypenElement) -> ActivationMode {
        guard let spec = element.dndSpecs.source else { return .drag(minimumDistance: slopPoints) }
        switch spec.activation {
        case .immediate:
            return .drag(minimumDistance: 0)
        case .slop:
            return .drag(minimumDistance: slopPoints)
        case .press:
            return .press
        case .auto:
            if !isTouchInput { return .drag(minimumDistance: slopPoints) }
            if findOrigin(element)?.dndSpecs.sort != nil { return .drag(minimumDistance: slopPoints) }
            return .press
        }
    }

    // MARK: - Pointer input (view layer)

    /// A `DragGesture` sample on `sourceId`. The first sample of a gesture
    /// opens the drag (pending) and resolves its activation against the
    /// travel so far; later samples move the ghost and re-resolve the
    /// target. Locations are in the host coordinate space.
    public func dragChanged(sourceId: String, location: CGPoint, translation: CGSize) {
        if let drag = drag {
            guard drag.sourceId == sourceId else { return }
            switch drag.phase {
            case .abandoned, .holding:
                return
            case .pending:
                resolvePending(drag, translation: translation)
                guard self.drag === drag, drag.phase == .dragging else { return }
            case .dragging:
                break
            }
            drag.translation = translation
            drag.lastLocation = location
            updateGhost(drag)
            resolveTarget(drag, at: location)
            return
        }

        guard let opened = openDrag(sourceId: sourceId) else { return }
        resolvePending(opened, translation: translation)
        guard self.drag === opened, opened.phase == .dragging else { return }
        opened.translation = translation
        opened.lastLocation = location
        updateGhost(opened)
        resolveTarget(opened, at: location)
    }

    /// The long press completed on `sourceId` (press activation): lift now,
    /// before the finger moves. Subsequent samples arrive via
    /// `dragChanged`.
    public func pressActivated(sourceId: String) {
        guard drag == nil, let opened = openDrag(sourceId: sourceId) else { return }
        claim(opened)
    }

    /// The gesture on `sourceId` ended normally: a pending gesture is a tap
    /// (total no-op), a claimed one drops.
    public func dragEnded(sourceId: String) {
        guard let drag = drag, drag.sourceId == sourceId else { return }
        switch drag.phase {
        case .pending, .abandoned:
            abandon()
        case .dragging:
            drop(drag)
        case .holding:
            break
        }
    }

    /// SwiftUI reset the gesture's `@GestureState`. After a normal end that
    /// is bookkeeping (`dragEnded` already dropped); without one it means
    /// the system cancelled the gesture — an incoming call, the app
    /// backgrounding — the `pointercancel` equivalent. The check is
    /// deferred one turn so it can never race the `onEnded` callback: a
    /// drag still `.dragging` then cancels with `.onDragEnd {dropped:
    /// false}`, a pending one is silently abandoned.
    public func gestureReset(sourceId: String) {
        guard let drag = drag, drag.sourceId == sourceId else { return }
        _ = scheduler.schedule(after: 0) { [weak self] in
            guard let self, self.drag === drag else { return }
            switch drag.phase {
            case .pending, .abandoned:
                self.abandon()
            case .dragging:
                self.cancelDrag(drag, dispatchEnd: true)
            case .holding:
                break
            }
        }
    }

    // MARK: - Renderer hooks

    /// A node was created, or one of its `__dnd.*` props changed: keep the
    /// role registry current. §6.11: `__dnd.sourceEnabled` flipping to
    /// `false` on the lifted source mid-drag (the item got locked under the
    /// finger) — or the source role vanishing altogether — cancels
    /// silently: no `.onDragEnd`, no write, exactly like a `Remove` /
    /// `Detach`. A hold is left alone: the drop already happened and the
    /// engine's re-render is what ends it.
    func noteNode(_ element: HypenElement) {
        let specs = element.dndSpecs
        if specs.hasRole {
            roleIds.insert(element.id)
        } else {
            roleIds.remove(element.id)
        }
        projectPins()
        fileZoneChanged(element.id)
        guard let drag = drag, drag.sourceId == element.id else { return }
        guard specs.source == nil || !specs.sourceEnabled else { return }
        switch drag.phase {
        case .dragging:
            cancelDrag(drag, dispatchEnd: false)
        case .pending, .abandoned:
            abandon()
        case .holding:
            break
        }
    }

    /// Deferral gate (drag wins, §6.6): while a drag or its post-drop hold
    /// owns a node, engine `SetProp`s to its `translateX` / `translateY`
    /// keys are swallowed — latest value stored, applied at release. A
    /// translate write landing on the dragged node DURING the hold is the
    /// engine's re-render (a pin position): it releases the hold and flows
    /// through the flush. Returns `true` when deferred.
    func deferEngineProp(id: String, name: String, value: Any?) -> Bool {
        guard let drag = drag, drag.phase == .dragging || drag.phase == .holding else { return false }
        guard HypenDnd.translateBaseNames.contains(HypenDnd.baseName(name)) || name == "__dnd.pinX" || name == "__dnd.pinY" else { return false }
        guard id == drag.sourceId || id == drag.itemId else { return false }
        // A RemoveProp is not deferred (the injected binding never emits one).
        guard let value = value else { return false }
        drag.deferWrite(id: id, name: name, value: value)
        if drag.phase == .holding {
            release()
        }
        return true
    }

    /// A structural change (insert / move) put `id` under `parentId`.
    /// During a hold under the origin or destination container this is the
    /// re-render landing; during a live drag it rebuilds the cached
    /// geometry of the list that changed shape — the ORIGIN included, so a
    /// spring-loaded folder inserting rows under the origin mid-drag keeps
    /// the reserved write's `from` and the preview slots tracking the
    /// engine's array (DOM `rebuildList` parity).
    func noteStructural(parentId: String, id: String) {
        structuralChange(parentId: parentId, id: id, removed: nil)
    }

    private func structuralChange(parentId: String, id: String, removed: String?) {
        guard let drag = drag, drag.phase == .dragging || drag.phase == .holding else { return }
        let container = hostContainerId(parentId)
        if drag.phase == .holding {
            if id == drag.itemId || id == drag.sourceId {
                release()
                return
            }
            if container == drag.originId || container == drag.target?.nodeId {
                release()
            }
            return
        }
        // The changed list: the parent itself, or — for a draggable inserted
        // under an already-inserted row (the engine inserts top-down) — the
        // cached container the node now lives in.
        var list = drag.lists[container]
        if list == nil {
            list = drag.lists.values.first { isDescendant(id, of: $0.containerId) }
        }
        guard let stale = list else { return }
        rebuildList(drag, stale, removed: removed)
        if let location = drag.lastLocation {
            resolveTarget(drag, at: location)
        }
    }

    /// A `Remove` is about to tear down `id` (call BEFORE the teardown, while
    /// the parent chain is intact). If the dragged source or item sits
    /// at-or-under it: a live drag cancels with NO dispatch, a hold
    /// releases. Otherwise it is a structural change under `parentId`.
    func noteRemove(id: String, parentId: String?) {
        guard let drag = drag else { return }
        if involves(drag, subtreeRoot: id) {
            switch drag.phase {
            case .holding:
                release()
            case .dragging:
                cancelDrag(drag, dispatchEnd: false)
            case .pending, .abandoned:
                abandon()
            }
            return
        }
        if let parentId = parentId {
            // The subtree is still linked (the hook runs before the
            // teardown), so the rebuild has to leave it out explicitly.
            structuralChange(parentId: parentId, id: id, removed: id)
        }
    }

    /// A Router `Detach` of the subtree at `id`: same rule as a remove for
    /// a drag it participates in, and nothing otherwise (the entry survives
    /// — the subtree may come back via `Attach`).
    func noteDetach(id: String) {
        fileZoneDetached(id)
        guard let drag = drag, involves(drag, subtreeRoot: id) else { return }
        switch drag.phase {
        case .holding:
            release()
        case .dragging:
            cancelDrag(drag, dispatchEnd: false)
        case .pending, .abandoned:
            abandon()
        }
    }

    /// Drop every trace of `id` — the element is being purged.
    func forget(id: String) {
        roleIds.remove(id)
        frames.removeValue(forKey: id)
        forgetFileZone(id)
    }

    /// Cancel any in-flight drag silently and drop all caches (renderer
    /// `clear()`).
    func reset() {
        if drag != nil {
            release()
        }
        roleIds.removeAll()
        frames.removeAll()
        resetFileHover()
    }

    // MARK: - Frames (view layer)

    /// The view layer's latest measurement of every relevant node. Layout
    /// settles a frame AFTER a structural patch, so a list rebuilt from the
    /// structural hook carries estimated slots for rows it could not
    /// measure; during a live drag any cached list whose rows moved (or
    /// were just measured for the first time) is rebuilt from the real
    /// rects here and the target re-resolved at the last pointer location.
    public func updateFrames(_ newFrames: [String: CGRect]) {
        frames = newFrames
        projectPins()
        guard let drag = drag, drag.phase == .dragging, !drag.lists.isEmpty else { return }
        var changed = false
        for list in Array(drag.lists.values) where listGeometryChanged(drag, list) {
            rebuildList(drag, list, removed: nil)
            changed = true
        }
        if changed, let location = drag.lastLocation {
            resolveTarget(drag, at: location)
        }
    }

    // MARK: - Poses (§2.1)

    /// Overlay the node's live runtime label (`lifted` / `over`) onto its
    /// resolved applicator result: `statePoses[label]` is run through the
    /// ordinary per-prop applicator path and merged over the base, so the
    /// node's own props stay untouched and clearing the label restores the
    /// base (or absence) by construction. An engine `SetProp` to an
    /// overridden key while the label is live lands in the base and shows
    /// at clear. Variant-qualified pose keys (`padding@md.0`) are skipped
    /// with a one-time warning (DOM / desktop parity).
    func overlayingPose(
        onto result: ApplicatorResult,
        element: HypenElement,
        registry: ApplicatorRegistry,
        context: ApplicatorContext
    ) -> ApplicatorResult {
        guard let label = element.dndPoseLabel, let pose = element.dndSpecs.poses?[label] else {
            return result
        }
        var lowered: [String: Any] = [:]
        for (key, value) in pose {
            if HypenDnd.isVariantQualified(key) {
                if warnedVariantPose.insert(element.id).inserted {
                    log.warn("dnd: variant-qualified pose key \"%@\" on %@ is not supported; skipped", key, element.id)
                }
                continue
            }
            lowered[key] = value
        }
        guard !lowered.isEmpty else { return result }
        let override = registry.buildModifier(loweredProps: lowered, context: context)
        var out = result
        out.baseModifier = HypenModifier.mergeOverride(base: result.baseModifier, override: override)
        return out
    }

    /// The animation a runtime label switch rides: the synthesized
    /// `__anim.transition` (§2.1), unless motion is reduced.
    func poseAnimation(for element: HypenElement) -> Animation? {
        guard element.dndSpecs.poses != nil, !reducedMotion else { return nil }
        return element.animSpecs.transition?.timing.animation
    }

    private var shiftAnimation: Animation? {
        reducedMotion ? nil : .easeOut(duration: HypenDnd.shiftSeconds)
    }

    private func applyPose(_ id: String, _ label: String) {
        guard let element = renderer.getElement(id), element.dndSpecs.poses?[label] != nil else { return }
        element.dndPoseLabel = label
    }

    private func clearPose(_ id: String) {
        guard let element = renderer.getElement(id), element.dndPoseLabel != nil else { return }
        element.dndPoseLabel = nil
    }

    // MARK: - Lift

    /// Open a pending drag on `sourceId`, or `nil` when the node cannot lift
    /// (another drag in flight, no source role, disabled, exiting).
    private func openDrag(sourceId: String) -> ActiveDrag? {
        guard drag == nil, let source = renderer.getElement(sourceId) else { return nil }
        let specs = source.dndSpecs
        guard let spec = specs.source, specs.sourceEnabled else { return nil }
        guard !source.isAnimationExcluded, !renderer.animator.isExiting(sourceId) else { return nil }

        let origin = findOrigin(source)
        // Inside a sortable the moving element is the sortable's direct child
        // that contains the source (`ForEach { Row { Text().draggable() } }`
        // moves the Row as one); elsewhere it is the source itself.
        let itemId: String
        if let origin = origin, origin.dndSpecs.sort != nil {
            itemId = itemOf(container: origin, elementId: sourceId) ?? sourceId
        } else {
            itemId = sourceId
        }
        let originIndex = origin.flatMap { indexOf(container: $0, itemId: itemId) }
        let from: DndLocation
        if let origin = origin {
            from = DndLocation(zone: containerLabel(origin) ?? origin.id, index: originIndex)
        } else {
            from = DndLocation(zone: looseZoneLabel(source), index: nil)
        }

        let activation: ActiveDrag.Activation
        switch spec.activation {
        case .immediate:
            activation = .immediate
        case .slop:
            activation = .slop
        case .press:
            activation = .press
        case .auto:
            if !isTouchInput {
                activation = .slop
            } else if let axis = origin?.dndSpecs.sort?.axis {
                activation = .crossAxis(axis == .x ? .y : .x)
            } else {
                activation = .press
            }
        }

        let opened = ActiveDrag(
            sourceId: sourceId,
            itemId: itemId,
            originId: origin?.id,
            originIndex: originIndex,
            from: from,
            activation: activation,
            itemRect: frame(of: itemId)
        )
        drag = opened
        return opened
    }

    /// Apply the activation rule to the travel so far.
    private func resolvePending(_ drag: ActiveDrag, translation: CGSize) {
        let dx = translation.width
        let dy = translation.height
        switch drag.activation {
        case .immediate, .press:
            // Immediate claims on the first sample; a press reaching here
            // has already satisfied its long press in the view layer.
            claim(drag)
        case .slop:
            if max(abs(dx), abs(dy)) >= slopPoints { claim(drag) }
        case .crossAxis(let cross):
            let crossTravel = cross == .x ? dx : dy
            let mainTravel = cross == .x ? dy : dx
            if abs(crossTravel) >= slopPoints {
                claim(drag)
            } else if abs(mainTravel) >= slopPoints {
                // Main-axis travel scrolls: abandon silently for the rest of
                // this gesture.
                drag.phase = .abandoned
            }
        }
    }

    /// Activation threshold met: the gesture claims the node.
    private func claim(_ drag: ActiveDrag) {
        guard drag.phase == .pending else { return }
        drag.phase = .dragging
        engageGhost(drag)
        // Cache the origin list's geometry BEFORE any shift.
        if let originId = drag.originId, let origin = renderer.getElement(originId), origin.dndSpecs.sort != nil {
            _ = listFor(drag, container: origin)
        }
        dispatchEvent([drag.sourceId, drag.originId], "onDragStart", payload(drag, to: drag.from))
    }

    /// Raise the moving item above its siblings and land the `lifted` pose
    /// on the source (the node carrying `__anim.statePoses`).
    private func engageGhost(_ drag: ActiveDrag) {
        guard let item = renderer.getElement(drag.itemId) else { return }
        item.dndRaised = true
        item.dndGhostOffset = .zero
        drag.ghostEngaged = true
        applyPose(drag.sourceId, HypenDnd.labelLifted)
    }

    private func updateGhost(_ drag: ActiveDrag, offset: CGSize? = nil) {
        guard drag.ghostEngaged, let item = renderer.getElement(drag.itemId) else { return }
        item.dndGhostOffset = offset ?? drag.translation
    }

    /// A pending drag that never claimed: forget it, keep silent.
    private func abandon() {
        drag = nil
    }

    // MARK: - Sortable preview (§6.3)

    private func listFor(_ drag: ActiveDrag, container: HypenElement) -> ListPreview {
        if let cached = drag.lists[container.id] { return cached }
        let axis = container.dndSpecs.sort?.axis ?? .y
        let itemIds = draggableItems(container)
        let (rects, unmeasured) = listRects(drag, itemIds: itemIds, axis: axis, previousGap: nil)
        let list = ListPreview(
            containerId: container.id,
            axis: axis,
            itemIds: itemIds,
            rects: rects,
            unmeasured: unmeasured,
            gap: DndGeometry.estimatedGap(rects: rects, axis: axis),
            shifts: Array(repeating: 0, count: itemIds.count)
        )
        drag.lists[container.id] = list
        return list
    }

    /// The slot rects of `itemIds`: the dragged item keeps its lift rect,
    /// every measured item its rendered rect, and rows the view layer has
    /// not measured yet (inserted this patch batch) an estimate — see
    /// `DndGeometry.fillUnmeasured`. Returns the unmeasured ids so the next
    /// `updateFrames` knows to replace the estimate.
    private func listRects(
        _ drag: ActiveDrag,
        itemIds: [String],
        axis: DndAxis,
        previousGap: CGFloat?
    ) -> (rects: [CGRect], unmeasured: Set<String>) {
        var measured: [CGRect?] = []
        var unmeasured: Set<String> = []
        for id in itemIds {
            if id == drag.itemId {
                measured.append(drag.itemRect)
            } else if frames[id] != nil {
                measured.append(frame(of: id))
            } else {
                measured.append(nil)
                unmeasured.insert(id)
            }
        }
        if unmeasured.isEmpty {
            return (measured.map { $0 ?? .zero }, unmeasured)
        }
        let known = measured.compactMap { $0 }
        let gap = previousGap ?? DndGeometry.estimatedGap(rects: known, axis: axis)
        return (DndGeometry.fillUnmeasured(measured, axis: axis, gap: gap), unmeasured)
    }

    /// Re-derive a cached list from the container's live children after an
    /// engine insert / move / remove mid-drag (DOM `rebuildList` parity).
    /// Shifts follow their items to the new indices (measured frames are
    /// layout rects, so no shift has to be subtracted from them); items
    /// that left the list snap back; the dragged item keeps its lift rect;
    /// for the origin list the dragged item's live slot becomes the
    /// reserved write's `from`. `removed` is a subtree the renderer is
    /// about to tear down but has not unlinked yet.
    private func rebuildList(_ drag: ActiveDrag, _ stale: ListPreview, removed: String?) {
        guard let container = renderer.getElement(stale.containerId) else {
            restoreList(stale)
            drag.lists.removeValue(forKey: stale.containerId)
            return
        }
        let itemIds = draggableItems(container, excluding: removed)
        var shifts: [CGFloat] = []
        for id in itemIds {
            let previous = stale.itemIds.firstIndex(of: id)
            shifts.append(previous.map { stale.shifts[$0] } ?? 0)
        }
        for (i, id) in stale.itemIds.enumerated() where !itemIds.contains(id) && stale.shifts[i] != 0 {
            guard let element = renderer.getElement(id) else { continue }
            element.dndShiftAnimation = nil
            element.dndShift = .zero
        }
        let (rects, unmeasured) = listRects(drag, itemIds: itemIds, axis: stale.axis, previousGap: stale.gap)
        var list = stale
        list.itemIds = itemIds
        list.rects = rects
        list.unmeasured = unmeasured
        list.shifts = shifts
        list.gap = unmeasured.isEmpty ? DndGeometry.estimatedGap(rects: rects, axis: list.axis) : stale.gap
        drag.lists[list.containerId] = list
        if list.containerId == drag.originId, let live = itemIds.firstIndex(of: drag.itemId) {
            drag.originIndex = live
        }
    }

    /// True when the view layer's frames no longer match a cached list: a
    /// row moved, a previously unmeasured row now has a frame, or the
    /// container's draggable children changed.
    private func listGeometryChanged(_ drag: ActiveDrag, _ list: ListPreview) -> Bool {
        for (i, id) in list.itemIds.enumerated() where id != drag.itemId {
            guard frames[id] != nil else { continue }
            if list.unmeasured.contains(id) || frame(of: id) != list.rects[i] { return true }
        }
        guard let container = renderer.getElement(list.containerId) else { return true }
        return draggableItems(container) != list.itemIds
    }

    private func insertionIndex(_ drag: ActiveDrag, list: ListPreview, at point: CGPoint) -> Int {
        DndGeometry.insertionIndex(
            rects: list.rects,
            axis: list.axis,
            draggedIndex: list.itemIds.firstIndex(of: drag.itemId),
            position: DndGeometry.axisPosition(point, list.axis)
        )
    }

    /// Shift siblings to open the gap for the dragged item at final index
    /// `to` (`Int.max` closes every gap).
    private func previewList(_ drag: ActiveDrag, containerId: String, to: Int) {
        guard var list = drag.lists[containerId] else { return }
        let size = DndGeometry.axisLength(drag.itemRect, list.axis) + list.gap
        let shifts = DndGeometry.gapShifts(
            count: list.itemIds.count,
            draggedIndex: list.itemIds.firstIndex(of: drag.itemId),
            to: to,
            size: size
        )
        for (i, shift) in shifts.enumerated() where list.shifts[i] != shift {
            list.shifts[i] = shift
            guard let element = renderer.getElement(list.itemIds[i]) else { continue }
            element.dndShiftAnimation = shiftAnimation
            element.dndShift = list.axis == .x
                ? CGSize(width: shift, height: 0)
                : CGSize(width: 0, height: shift)
        }
        drag.lists[containerId] = list
    }

    /// Snap every shifted sibling back (the engine's re-render now carries
    /// the order, so releasing and reordering in the same frame nets zero
    /// motion).
    private func restoreList(_ list: ListPreview) {
        for id in list.itemIds {
            guard let element = renderer.getElement(id) else { continue }
            if element.dndShiftAnimation != nil { element.dndShiftAnimation = nil }
            if element.dndShift != .zero { element.dndShift = .zero }
        }
    }

    // MARK: - Zone resolution (§6.4)

    /// A bare `.draggable()` inside a `.sortable` / `.pinboard` inherits the
    /// container's group (design §4.2): the source's own group wins when set.
    private func effectiveGroup(_ drag: ActiveDrag, source: HypenElement) -> String? {
        if let own = source.dndSpecs.source?.group { return own }
        guard let originId = drag.originId, let origin = renderer.getElement(originId) else { return nil }
        return origin.dndSpecs.sort?.group ?? origin.dndSpecs.pin?.group
    }

    /// Group compatibility. A sortable / pinboard always accepts its own
    /// descendants and, with a group, any source of that group. A drop zone
    /// with a group accepts that group; an ungrouped zone accepts ungrouped
    /// sources and its own descendants. A disabled zone accepts nothing.
    private func accepts(_ drag: ActiveDrag, zone: HypenElement, source: HypenElement) -> Bool {
        let isDescendant = isDescendant(source.id, of: zone.id)
        let sourceGroup = effectiveGroup(drag, source: source)
        let specs = zone.dndSpecs
        if specs.isContainer {
            let group = specs.sort?.group ?? specs.pin?.group
            return isDescendant || (group != nil && sourceGroup == group)
        }
        guard specs.zoneEnabled, let zoneSpec = specs.zone else { return false }
        if let group = zoneSpec.group { return sourceGroup == group }
        return sourceGroup == nil || isDescendant
    }

    /// Innermost enabled, group-compatible zone under the pointer wins. A
    /// source is never a zone for itself — nor is anything under the
    /// dragged item.
    private func resolveTarget(_ drag: ActiveDrag, at point: CGPoint) {
        guard let source = renderer.getElement(drag.sourceId) else { return }
        var innermost: HypenElement?
        var bestDepth = -1
        for id in roleIds {
            guard let node = renderer.getElement(id) else { continue }
            let specs = node.dndSpecs
            guard specs.zone != nil || specs.isContainer else { continue }
            if id == drag.sourceId || id == drag.itemId || isDescendant(id, of: drag.itemId) { continue }
            guard frames[id] != nil, DndGeometry.contains(frame(of: id), point) else { continue }
            guard accepts(drag, zone: node, source: source) else { continue }
            let nodeDepth = depth(of: id)
            if nodeDepth > bestDepth {
                innermost = node
                bestDepth = nodeDepth
            }
        }

        var target: DropTarget?
        if let zone = innermost {
            if zone.dndSpecs.sort != nil {
                let list = listFor(drag, container: zone)
                target = .sort(containerId: zone.id, index: insertionIndex(drag, list: list, at: point))
            } else if zone.dndSpecs.pin != nil {
                // Only the origin board pins; a foreign compatible pinboard is
                // a plain "into" zone.
                target = zone.id == drag.originId ? .pin(containerId: zone.id) : .zone(id: zone.id)
            } else {
                target = resolveBandTarget(drag, zone: zone, source: source, at: point)
            }
        }
        setTarget(drag, target)
    }

    /// A `.dropZone` on a sortable item uses the band rule; elsewhere it is
    /// a plain "into".
    private func resolveBandTarget(
        _ drag: ActiveDrag,
        zone: HypenElement,
        source: HypenElement,
        at point: CGPoint
    ) -> DropTarget {
        // The nearest enclosing sortable that would accept this source.
        var sortable: HypenElement?
        var cursor = hostParent(of: zone)
        while let candidate = cursor {
            if candidate.dndSpecs.sort != nil, accepts(drag, zone: candidate, source: source) {
                sortable = candidate
                break
            }
            cursor = hostParent(of: candidate)
        }
        guard let sortable = sortable, let band = zone.dndSpecs.zone?.band else { return .zone(id: zone.id) }
        let list = listFor(drag, container: sortable)
        guard let itemId = itemOf(container: sortable, elementId: zone.id),
              let i = list.itemIds.firstIndex(of: itemId) else {
            return .zone(id: zone.id)
        }
        let rect = list.rects[i]
        let side = DndGeometry.resolveBand(
            pointer: DndGeometry.axisPosition(point, list.axis),
            itemStart: DndGeometry.axisStart(rect, list.axis),
            itemLength: DndGeometry.axisLength(rect, list.axis),
            band: band
        )
        if side == .into { return .zone(id: zone.id) }
        var others = 0
        for k in 0..<i where list.itemIds[k] != drag.itemId {
            others += 1
        }
        return .sort(containerId: sortable.id, index: side == .before ? others : others + 1)
    }

    private func targetLocation(_ drag: ActiveDrag, _ target: DropTarget?) -> DndLocation {
        guard let target = target else { return drag.from }
        switch target {
        case .sort(let containerId, let index):
            return DndLocation(zone: containerLabel(renderer.getElement(containerId)) ?? containerId, index: index)
        case .zone(let id):
            return DndLocation(zone: intoLabel(renderer.getElement(id)) ?? id, index: nil)
        case .pin(let containerId):
            return DndLocation(
                zone: containerLabel(renderer.getElement(containerId)) ?? containerId,
                index: drag.originIndex
            )
        }
    }

    private func setTarget(_ drag: ActiveDrag, _ target: DropTarget?) {
        let previousNode = drag.target?.nodeId
        let nextNode = target?.nodeId

        // Sortable preview: shift the hovered list; reset lists no longer
        // hovered. Leaving the origin list closes its gap only when hovering
        // a foreign target; hovering nothing keeps the last preview.
        for containerId in Array(drag.lists.keys) {
            if let target = target, case .sort(let hovered, let index) = target, hovered == containerId {
                previewList(drag, containerId: containerId, to: index)
            } else if containerId == drag.originId,
                      renderer.getElement(containerId)?.dndSpecs.sort != nil {
                if target != nil {
                    previewList(drag, containerId: containerId, to: drag.originIndex ?? 0)
                }
            } else {
                previewList(drag, containerId: containerId, to: Int.max)
            }
        }

        if nextNode != previousNode {
            if let previous = previousNode,
               renderer.getElement(previous)?.dndPoseLabel == HypenDnd.labelOver {
                clearPose(previous)
            }
            clearDwell(drag)
            if let next = nextNode {
                applyPose(next, HypenDnd.labelOver)
                armDwell(drag, zoneId: next)
            }
        }
        drag.target = target
        drag.overId = nextNode
    }

    /// `.onDragOver` fires once per zone entry, after the dwell — never per
    /// frame — and only if the zone attached it.
    private func armDwell(_ drag: ActiveDrag, zoneId: String) {
        guard let zone = renderer.getElement(zoneId),
              let binding = DndEventBinding.from(props: zone.props, name: "onDragOver") else { return }
        let dwellMs = binding.dwellMs ?? HypenDnd.defaultDwellMs
        drag.dwellWork = scheduler.schedule(after: dwellMs / 1000) { [weak self] in
            guard let self, self.drag === drag else { return }
            drag.dwellWork = nil
            guard drag.phase == .dragging, drag.overId == zoneId else { return }
            self.dispatchEvent([zoneId], "onDragOver", self.payload(drag, to: self.targetLocation(drag, drag.target)))
        }
    }

    private func clearDwell(_ drag: ActiveDrag) {
        drag.dwellWork?.cancel()
        drag.dwellWork = nil
    }

    // MARK: - Drop / cancel / release

    private func itemKey(_ drag: ActiveDrag) -> String {
        renderer.getElement(drag.sourceId)?.dndSpecs.key ?? drag.sourceId
    }

    private func payload(_ drag: ActiveDrag, to: DndLocation) -> DndEventPayload {
        let specs = renderer.getElement(drag.sourceId)?.dndSpecs ?? .empty
        return DndEventPayload(
            item: specs.key ?? drag.sourceId,
            hasPayload: specs.hasPayload,
            payload: specs.payload,
            from: drag.from,
            to: to
        )
    }

    /// Dispatch `name` to the first candidate node carrying that binding.
    private func dispatchEvent(_ candidates: [String?], _ name: String, _ payload: DndEventPayload) {
        for case let id? in candidates {
            guard let element = renderer.getElement(id),
                  let binding = DndEventBinding.from(props: element.props, name: name) else { continue }
            dispatch(action: binding.actionName, payload: binding.dispatchPayload(payload), node: id)
            return
        }
    }

    private func dispatch(action: String, payload: [String: Any], node: String? = nil) {
        guard let dispatcher = actionDispatcher else {
            if !warnedNoDispatcher {
                warnedNoDispatcher = true
                log.warn("dnd: no action dispatcher attached; %@ dropped", action)
            }
            return
        }
        var owner = node ?? drag?.originId
        if node == nil, action == HypenDnd.pinAction, let origin = drag?.originId, bindPath(of: origin) == nil { owner = drag?.sourceId }
        if node == nil, case .sort(let destination, _)? = drag?.target { owner = destination }
        guard let owner = owner else { return }
        var envelope: [String: Any] = ["node": owner, "action": action, "payload": payload]
        if let origin = drag?.originId { envelope["fromNode"] = origin }
        dispatcher.dispatch(action: "__hypen_dispatch", payload: envelope)
    }

    /// Pointer released over the current target (or nowhere).
    private func drop(_ drag: ActiveDrag) {
        guard drag.phase == .dragging else { return }
        guard let target = drag.target else {
            cancelDrag(drag, dispatchEnd: true)
            return
        }
        commit(drag, target)
    }

    /// Resolve a drop (§4.2 ordering): (1) the reserved write when a write
    /// target exists, (2) `.onSort` / `.onPin` / `.onDrop`, (3) `.onDragEnd
    /// {dropped: true}`; then hold the local transforms until the engine's
    /// re-render lands (or the timeout).
    private func commit(_ drag: ActiveDrag, _ target: DropTarget) {
        clearDwell(drag)
        let to = targetLocation(drag, target)
        let base = payload(drag, to: to)
        // Enter the hold BEFORE dispatching: a synchronous host may re-render
        // inside the dispatch, and its Move / SetProp must find the hold.
        drag.phase = .holding
        drag.target = target
        var wroteOrChanged = true

        switch target {
        case .sort(let destinationId, let index):
            let sameList = destinationId == drag.originId
            if sameList && drag.originIndex == index {
                // Dropped back on the origin slot: nothing to write, only
                // `.onDragEnd {dropped: true}`.
                wroteOrChanged = false
                break
            }
            let fromPath = drag.originId.flatMap { bindPath(of: $0) }
            let toPath = bindPath(of: destinationId)
            if sameList, let toPath = toPath, let fromIndex = drag.originIndex {
                dispatch(action: HypenDnd.reorderAction, payload: [
                    "path": toPath, "from": fromIndex, "to": index,
                ])
            } else if !sameList, let fromPath = fromPath, let toPath = toPath, let fromIndex = drag.originIndex {
                dispatch(action: HypenDnd.reorderAction, payload: [
                    "fromPath": fromPath, "from": fromIndex, "toPath": toPath, "to": index,
                ])
            } else if !sameList, (fromPath != nil) != (toPath != nil), !warnedMixedBind {
                warnedMixedBind = true
                log.warn("dnd: cross-list reorder between a bound and an unbound sortable; no reserved write dispatched")
            }
            dispatchEvent([destinationId], "onSort", base)

        case .zone(let zoneId):
            dispatchEvent([zoneId], "onDrop", base)

        case .pin(let boardId):
            guard let board = renderer.getElement(boardId), let spec = board.dndSpecs.pin else { break }
            let result = DndGeometry.pinPosition(
                itemRect: drag.itemRect,
                translation: drag.translation,
                contentBox: contentBox(of: board),
                spec: spec
            )
            // Snap the ghost to the resolved position so the hold shows it.
            updateGhost(drag, offset: result.ghostOffset)
            var path: String?
            if let bind = bindPath(of: boardId) {
                if let index = drag.originIndex {
                    path = DndGeometry.userPinPath(bindPath: bind, index: index)
                }
            } else if let group = spec.group {
                path = DndGeometry.reservedPinPath(group: group, key: itemKey(drag))
            }
            if let path = path {
                dispatch(action: HypenDnd.pinAction, payload: [
                    "path": path, "x": result.x, "y": result.y, "xKey": spec.xKey, "yKey": spec.yKey,
                ])
            }
            dispatchEvent([boardId], "onPin", base.pinned(x: result.x, y: result.y))
        }

        if self.drag === drag {
            if wroteOrChanged {
                drag.holdWork = scheduler.schedule(after: cleanupTimeoutSeconds) { [weak self] in
                    guard let self, self.drag === drag else { return }
                    drag.holdWork = nil
                    self.release()
                }
            } else {
                release()
            }
        }
        dispatchEvent([drag.sourceId, drag.originId], "onDragEnd", base.ended(dropped: true))
    }

    /// Abandon a claimed drag: restore everything. With `dispatchEnd` (a
    /// system cancel, a drop outside every zone) only `.onDragEnd
    /// {dropped: false}` fires; without it (`Remove` / `Detach`) nothing.
    private func cancelDrag(_ drag: ActiveDrag, dispatchEnd: Bool) {
        if drag.phase == .pending || drag.phase == .abandoned {
            abandon()
            return
        }
        let end: DndEventPayload? = dispatchEnd && drag.phase == .dragging
            ? payload(drag, to: targetLocation(drag, drag.target)).ended(dropped: false)
            : nil
        release()
        if let end = end {
            dispatchEvent([drag.sourceId, drag.originId], "onDragEnd", end)
        }
    }

    /// Hand every touched node back to the engine and forget the drag.
    private func release() {
        guard let drag = drag else { return }
        self.drag = nil
        clearDwell(drag)
        drag.holdWork?.cancel()
        drag.holdWork = nil
        for list in drag.lists.values {
            restoreList(list)
        }
        if let over = drag.overId, renderer.getElement(over)?.dndPoseLabel == HypenDnd.labelOver {
            clearPose(over)
        }
        if drag.ghostEngaged {
            if let item = renderer.getElement(drag.itemId) {
                item.dndGhostOffset = .zero
                item.dndRaised = false
            }
            clearPose(drag.sourceId)
        }
        // Deferred translate writes flow through the renderer's path now
        // that the node is released.
        for entry in drag.deferred {
            renderer.applyReleasedProp(id: entry.id, name: entry.name, value: entry.value)
        }
        drag.deferred.removeAll()
    }

    // MARK: - Tree helpers

    /// The rendered rect of `id`: its measured layout rect plus its own
    /// engine `translateX` / `translateY`. The view layer's anchor sits
    /// outside the element's transforms, so the measurement excludes the
    /// node's own `offset` (ancestors' offsets are already resolved into
    /// it); adding the node's own translate gives the position the DOM
    /// reads from `getBoundingClientRect`. Every geometry read — the item
    /// rect at lift, sortable row snapshots, zone hit-tests, content boxes
    /// — goes through here, so a positioned pinboard note re-pins from
    /// where it is displayed (§6.11), and a translated zone is hit where
    /// it is drawn.
    private func frame(of id: String) -> CGRect {
        guard let layout = frames[id] else { return .zero }
        let translate = engineTranslate(of: id)
        return layout.offsetBy(dx: translate.width, dy: translate.height)
    }

    /// The node's current engine translate: the rendered (memoized)
    /// applicator result when the node has been rendered since its props
    /// last changed, else the lowered props directly (`translateX.0`,
    /// explicit null = 0 per §3). A translate write deferred by the drag
    /// has not reached the props, so it is — correctly — not in here.
    private func projectPins() {
        for id in roleIds {
            guard let element = renderer.getElement(id) else { continue }
            guard element.props["__dnd.pinX"] != nil || element.props["__dnd.pinY"] != nil else {
                element.dndPinOffset = .zero
                continue
            }
            var board = hostParent(of: element)
            while let parent = board, parent.dndSpecs.pin == nil { board = hostParent(of: parent) }
            guard let board = board, frames[board.id] != nil else { continue }
            let box = contentBox(of: board)
            element.dndPinOffset = CGSize(
                width: CGFloat(element.getDoubleProp("__dnd.pinX") ?? 0) * box.width,
                height: CGFloat(element.getDoubleProp("__dnd.pinY") ?? 0) * box.height
            )
        }
    }

    private func engineTranslate(of id: String) -> CGSize {
        guard let element = renderer.getElement(id) else { return .zero }
        if let cached = element.cachedApplicatorResult {
            return CGSize(width: cached.baseModifier.translateX + element.dndPinOffset.width, height: cached.baseModifier.translateY + element.dndPinOffset.height)
        }
        return CGSize(
            width: translateProp(element, "translateX") + element.dndPinOffset.width,
            height: translateProp(element, "translateY") + element.dndPinOffset.height
        )
    }

    private func translateProp(_ element: HypenElement, _ base: String) -> CGFloat {
        let value = element.props["\(base).0"] ?? element.props[base]
        return parseCGFloat(value) ?? 0
    }

    /// Walk up from `element`, skipping control-flow wrappers, to the first
    /// element rendered as its own view.
    private func hostParent(of element: HypenElement) -> HypenElement? {
        var currentId = element.parentId
        while let id = currentId, let parent = renderer.getElement(id) {
            if ControlFlowUtils.controlFlowTypes.contains(parent.elementType) {
                currentId = parent.parentId
            } else {
                return parent
            }
        }
        return nil
    }

    /// `id` itself when it is rendered as its own view, else its nearest
    /// non-control-flow ancestor — so an `Insert` under a `__ForEach`
    /// wrapper compares equal to the sortable that hosts it.
    private func hostContainerId(_ id: String) -> String {
        guard let element = renderer.getElement(id),
              ControlFlowUtils.controlFlowTypes.contains(element.elementType) else { return id }
        return hostParent(of: element)?.id ?? id
    }

    private func hostChildren(of container: HypenElement) -> [HypenElement] {
        ControlFlowUtils.flattenControlFlowChildren(
            renderer.getChildren(of: container.id), renderer: renderer
        )
    }

    /// True when `id` sits strictly below `rootId`.
    private func isDescendant(_ id: String, of rootId: String) -> Bool {
        var current = renderer.getElement(id)?.parentId
        var hops = 0
        while let currentId = current, hops < 4096 {
            if currentId == rootId { return true }
            current = renderer.getElement(currentId)?.parentId
            hops += 1
        }
        return false
    }

    private func involves(_ drag: ActiveDrag, subtreeRoot id: String) -> Bool {
        id == drag.sourceId || id == drag.itemId
            || isDescendant(drag.sourceId, of: id) || isDescendant(drag.itemId, of: id)
    }

    private func depth(of id: String) -> Int {
        var count = 0
        var current = renderer.getElement(id)?.parentId
        while let currentId = current, count < 4096 {
            count += 1
            current = renderer.getElement(currentId)?.parentId
        }
        return count
    }

    /// The nearest enclosing sortable / pinboard.
    private func findOrigin(_ source: HypenElement) -> HypenElement? {
        var cursor = hostParent(of: source)
        while let candidate = cursor {
            if candidate.dndSpecs.isContainer { return candidate }
            cursor = hostParent(of: candidate)
        }
        return nil
    }

    /// The container's direct (host) child that is, or contains, `elementId`.
    private func itemOf(container: HypenElement, elementId: String) -> String? {
        guard var current = renderer.getElement(elementId) else { return nil }
        var hops = 0
        while let parent = hostParent(of: current), hops < 4096 {
            if parent.id == container.id { return current.id }
            current = parent
            hops += 1
        }
        return nil
    }

    /// Direct children of a container that carry (or contain) a source, in
    /// layout order. A source playing its exit (still linked while the
    /// animator holds it) is no longer a slot — the engine's array has
    /// already dropped it; `excluding` leaves out a subtree the renderer is
    /// about to remove but has not unlinked yet.
    private func draggableItems(_ container: HypenElement, excluding removed: String? = nil) -> [String] {
        var items: Set<String> = []
        for id in roleIds {
            guard id != container.id, let node = renderer.getElement(id), node.dndSpecs.source != nil else { continue }
            if renderer.animator.isExiting(id) { continue }
            if let removed = removed, id == removed || isDescendant(id, of: removed) { continue }
            if let item = itemOf(container: container, elementId: id) {
                items.insert(item)
            }
        }
        return hostChildren(of: container).map(\.id).filter { items.contains($0) }
    }

    private func indexOf(container: HypenElement, itemId: String) -> Int? {
        draggableItems(container).firstIndex(of: itemId)
    }

    // MARK: - Labels (§4.2)

    private func idProp(_ element: HypenElement) -> String? {
        HypenDnd.parseString(element.props["id.0"] ?? element.props["id"])
    }

    private func bindPath(of id: String) -> String? {
        guard let raw = renderer.getElement(id)?.props[HypenDnd.bindProp] as? String, !raw.isEmpty else { return nil }
        return raw
    }

    /// `zone` for a sortable / pinboard: its `group` if set, else its
    /// resolved `id` prop, else the node id.
    private func containerLabel(_ element: HypenElement?) -> String? {
        guard let element = element else { return nil }
        return element.dndSpecs.sort?.group ?? element.dndSpecs.pin?.group ?? idProp(element) ?? element.id
    }

    /// `zone` for a drop zone: `__dnd.zoneId`, else the resolved `id` prop,
    /// else the node id.
    private func zoneLabel(_ element: HypenElement?) -> String? {
        guard let element = element else { return nil }
        return element.dndSpecs.zoneId ?? idProp(element) ?? element.id
    }

    /// `to.zone` for a plain "into" target (§6.11): a sortable / pinboard
    /// hit as a zone (a foreign compatible pinboard) reports its group /
    /// resolved `id` / node id like every other renderer, a `.dropZone` its
    /// `zoneId` / `id` / node id.
    private func intoLabel(_ element: HypenElement?) -> String? {
        guard let element = element else { return nil }
        return element.dndSpecs.isContainer ? containerLabel(element) : zoneLabel(element)
    }

    /// `from.zone` for a source outside any sortable / pinboard: the nearest
    /// enclosing zone, else the parent, else the source itself.
    private func looseZoneLabel(_ source: HypenElement) -> String {
        var cursor = hostParent(of: source)
        while let candidate = cursor {
            if candidate.dndSpecs.zone != nil, let label = zoneLabel(candidate) { return label }
            cursor = hostParent(of: candidate)
        }
        return hostParent(of: source)?.id ?? source.id
    }

    /// The container's content box: its measured frame (which includes the
    /// margin `hypenModifier` applies as outer padding, and the padding)
    /// inset by both.
    private func contentBox(of container: HypenElement) -> CGRect {
        DndGeometry.contentBox(
            frame: frame(of: container.id),
            modifier: container.cachedApplicatorResult?.baseModifier
        )
    }
}

// MARK: - Private state

/// Cached geometry + live shifts of one sortable list during a drag.
/// Rebuilt (not just invalidated) when the engine changes the list's
/// shape mid-drag — see `HypenDndCoordinator.rebuildList`.
private struct ListPreview {
    let containerId: String
    let axis: DndAxis
    var itemIds: [String]
    /// Slot rects at lift or at the last rebuild (the dragged item's is its
    /// pre-ghost lift rect; an unmeasured row's is an estimate).
    var rects: [CGRect]
    /// Rows whose rect is an estimate because the view layer had not
    /// measured them yet when the list was (re)built.
    var unmeasured: Set<String>
    /// Estimated inter-item gap along the axis.
    var gap: CGFloat
    var shifts: [CGFloat]
}

private enum DropTarget {
    case sort(containerId: String, index: Int)
    case zone(id: String)
    case pin(containerId: String)

    /// The node hovered: the zone, or the sortable / pinboard container.
    var nodeId: String {
        switch self {
        case .sort(let containerId, _): return containerId
        case .zone(let id): return id
        case .pin(let containerId): return containerId
        }
    }
}

/// The one interaction in flight. A class so the coordinator's helpers can
/// mutate it through a shared reference (and identity-compare it from
/// scheduled work).
private final class ActiveDrag {
    enum Phase {
        case pending
        /// Main-axis travel in an axis-constrained sortable: the rest of
        /// this gesture scrolls and is ignored.
        case abandoned
        case dragging
        case holding
    }

    enum Activation {
        case immediate
        case slop
        case press
        /// Slop on this (cross) axis lifts; slop on the other axis abandons.
        case crossAxis(DndAxis)
    }

    var phase: Phase = .pending
    let sourceId: String
    /// The element that moves (sortable row, or the source itself).
    let itemId: String
    /// Enclosing sortable / pinboard, if any.
    let originId: String?
    /// The dragged item's slot in the origin list — live: a structural
    /// change under the origin mid-drag moves it (the reserved write's
    /// `from`); `from` below keeps the lift-time location for the payload.
    var originIndex: Int?
    let from: DndLocation
    let activation: Activation
    var translation: CGSize = .zero
    /// Last pointer sample (host space), so a structural change or a
    /// layout settle can re-resolve the target without a new sample.
    var lastLocation: CGPoint?
    /// Item rect at lift: the rendered rect (layout rect plus the node's
    /// own engine translate), before the ghost offset.
    let itemRect: CGRect
    var ghostEngaged = false
    var target: DropTarget?
    var overId: String?
    var dwellWork: HypenScheduledWork?
    var lists: [String: ListPreview] = [:]
    var holdWork: HypenScheduledWork?
    /// Deferred engine writes to the dragged node's translate keys, in
    /// arrival order with the latest value per key.
    var deferred: [(id: String, name: String, value: Any)] = []

    init(
        sourceId: String,
        itemId: String,
        originId: String?,
        originIndex: Int?,
        from: DndLocation,
        activation: Activation,
        itemRect: CGRect
    ) {
        self.sourceId = sourceId
        self.itemId = itemId
        self.originId = originId
        self.originIndex = originIndex
        self.from = from
        self.activation = activation
        self.itemRect = itemRect
    }

    func deferWrite(id: String, name: String, value: Any) {
        deferred.removeAll { $0.id == id && $0.name == name }
        deferred.append((id: id, name: name, value: value))
    }
}
