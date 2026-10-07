import SwiftUI

/// The pixels half of the `__dnd.*` runtime.
///
/// `HypenDndCoordinator` owns the state (what is lifted, where the pointer
/// is, which siblings are shifted, which runtime label a node wears); this
/// file reads that state off each `HypenElement` and hands it to SwiftUI,
/// and feeds the coordinator the two inputs it cannot get itself: node
/// frames (anchor preferences resolved at the host) and the gesture.
///
/// Geometry contract: the host modifier names a coordinate space
/// (`coordinator.coordinateSpaceName`, unique per host) on the Hypen root;
/// every relevant node publishes an `Anchor<CGRect>` of its bounds; the
/// host resolves them in its own `GeometryReader` (whose local space IS the
/// named space) and pushes `[id: frame]` to the coordinator. The drag
/// gesture reports locations in the same named space, so hit-testing needs
/// no conversion. The anchor is attached OUTSIDE the element's own
/// transforms, and SwiftUI's `offset` is invisible to modifiers applied
/// after it, so each entry is the node's LAYOUT rect — its own engine
/// translate and its runtime ghost / shift offsets are excluded (an
/// ancestor's offsets are included: anchors resolve through them). The
/// coordinator adds the node's own engine translate on every read
/// (`frame(of:)`) to recover the rendered rect (§6.11). Both preference
/// keys are cleared at the host boundary so an embedded `HypenApp` host
/// never leaks its (per-engine, colliding) node ids into its parent host.

// MARK: - Frame preferences

/// Anchors of every DnD-relevant node, collected up the tree.
struct HypenDndAnchorKey: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] { [:] }

    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { $1 })
    }
}

/// The same anchors resolved into the host coordinate space.
struct HypenDndFrameKey: PreferenceKey {
    static var defaultValue: [String: CGRect] { [:] }

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { $1 })
    }
}

// MARK: - Host

extension View {
    /// Make this view the drag-and-drop host for `coordinator`: the named
    /// coordinate space pointer locations and node frames resolve in, and
    /// the sink that feeds measured frames to the coordinator. Applied once,
    /// on the Hypen root (`HypenView`, and each embedded `HypenApp`).
    @MainActor
    public func hypenDndHost(_ coordinator: HypenDndCoordinator) -> some View {
        modifier(HypenDndHostModifier(
            coordinator: coordinator,
            coordinateSpaceName: coordinator.coordinateSpaceName
        ))
    }
}

struct HypenDndHostModifier: ViewModifier {
    let coordinator: HypenDndCoordinator
    /// `coordinator.coordinateSpaceName`, captured on the main actor at
    /// construction (stable for the coordinator's lifetime).
    let coordinateSpaceName: String

    func body(content: Content) -> some View {
        content
            .coordinateSpace(name: coordinateSpaceName)
            .overlayPreferenceValue(HypenDndAnchorKey.self) { anchors in
                // Sized to the host, so the proxy's local space is the named
                // space above. Transparent and inert: it measures, it never
                // intercepts.
                GeometryReader { proxy in
                    Color.clear
                        .preference(
                            key: HypenDndFrameKey.self,
                            value: anchors.mapValues { proxy[$0] }
                        )
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            .onPreferenceChange(HypenDndFrameKey.self) { frames in
                // Preference changes are delivered on the main thread; the
                // coordinator is MainActor-isolated.
                MainActor.assumeIsolated {
                    coordinator.updateFrames(frames)
                }
            }
            // Preferences are never consumed by a reader — they keep
            // propagating up. Stop both keys here: an embedded `HypenApp`
            // is its own host with its own engine, and its node ids are
            // per-engine slotmap keys that collide with the outer app's.
            // Without this the outer host would resolve the inner anchors
            // in ITS space and merge the inner frames over its own.
            .transformPreference(HypenDndFrameKey.self) { $0 = [:] }
            .transformPreference(HypenDndAnchorKey.self) { $0 = [:] }
    }
}

// MARK: - Per-node state

extension View {
    /// Apply an element's drag-and-drop state — the ghost / sibling offsets,
    /// the z-raise, the runtime-label pose transition, the frame anchor and
    /// (for a source) the lift gesture. A no-op for the overwhelmingly
    /// common node that plays no role and is not a row of a sortable /
    /// pinboard.
    @MainActor
    @ViewBuilder
    func hypenDndState(_ element: HypenElement, coordinator: HypenDndCoordinator) -> some View {
        if coordinator.isRelevant(element) {
            modifier(HypenDndNodeModifier(element: element, coordinator: coordinator))
        } else {
            self
        }
    }

    /// Attach the lift gesture when the element carries `__dnd.source`.
    @MainActor
    @ViewBuilder
    func hypenDragSource(_ element: HypenElement, coordinator: HypenDndCoordinator) -> some View {
        if element.dndSpecs.source != nil {
            modifier(HypenDragSourceModifier(element: element, coordinator: coordinator))
        } else {
            self
        }
    }
}

/// Offsets, raise, pose transition, frame anchor, gesture.
///
/// Ordering matters. The sibling shift and its implicit
/// `.animation(dndShiftAnimation, value: dndShift)` come first so the shift
/// glides (150ms ease-out, snapped at release and under reduced motion)
/// while the ghost offset outside it follows the finger un-animated. The
/// pose-label animation wraps the content so a `lifted` / `over` switch
/// rides the synthesized `__anim.transition`. The anchor sits outside every
/// offset — the runtime's here and the engine translate `hypenModifier`
/// applies deeper inside — so the measurement is the node's layout rect,
/// stable while the ghost moves; the coordinator adds the node's own engine
/// translate on read to get the rendered rect, and snapshots list geometry
/// at lift like the DOM does.
struct HypenDndNodeModifier: ViewModifier {
    @ObservedObject var element: HypenElement
    let coordinator: HypenDndCoordinator

    func body(content: Content) -> some View {
        let id = element.id
        // Keep the author's own z-order when not raised: `hypenModifier`
        // applies the inner `.zIndex`, and the outermost modifier is the one
        // the parent container reads.
        let baseZIndex = element.getDoubleProp("zIndex.0") ?? 0
        content
            .offset(x: element.dndPinOffset.width, y: element.dndPinOffset.height)
            .offset(x: element.dndShift.width, y: element.dndShift.height)
            .animation(element.dndShiftAnimation, value: element.dndShift)
            .offset(x: element.dndGhostOffset.width, y: element.dndGhostOffset.height)
            .zIndex(element.dndRaised ? HypenDnd.raisedZIndex : baseZIndex)
            .animation(coordinator.poseAnimation(for: element), value: element.dndPoseLabel)
            .anchorPreference(key: HypenDndAnchorKey.self, value: .bounds) { anchor in
                [id: anchor]
            }
            .hypenDragSource(element, coordinator: coordinator)
            .hypenFileDropZone(element, coordinator: coordinator)
    }
}

// MARK: - Lift gesture

/// The gesture that lifts a `__dnd.source`.
///
/// Two recognizers, chosen by the coordinator's `activationMode`
/// (§6.1): a `DragGesture` whose `minimumDistance` is the slop (0 for
/// `immediate`) — a tap never reaches its threshold, so a tap is a total
/// no-op and the element's own `.onClick` still fires — or a
/// `LongPressGesture` (300ms, failing on more than slop of travel, which
/// is exactly "travel before the press fires is a scroll") sequenced
/// before a zero-distance drag. Recognition IS pointer capture: once a
/// `DragGesture` begins, SwiftUI routes every update of that touch here
/// until it ends. The `auto` cross-axis rule for touch inside an
/// axis-constrained sortable is applied by the coordinator to the first
/// sample; a main-axis start abandons the gesture so the enclosing
/// `ScrollView` keeps scrolling.
///
/// `@GestureState` doubles as the `pointercancel` signal: it resets when
/// the system cancels the gesture without an `onEnded`, and the
/// coordinator's deferred check turns a still-dragging interaction into a
/// clean cancel.
struct HypenDragSourceModifier: ViewModifier {
    @ObservedObject var element: HypenElement
    let coordinator: HypenDndCoordinator

    @GestureState private var isGestureActive = false

    func body(content: Content) -> some View {
        let sourceId = element.id
        Group {
            switch coordinator.activationMode(for: element) {
            case .press:
                content.gesture(pressGesture(sourceId: sourceId))
            case .drag(let minimumDistance):
                content.gesture(dragGesture(sourceId: sourceId, minimumDistance: minimumDistance))
            }
        }
        .onChangeCompat(of: isGestureActive) { active in
            if !active {
                coordinator.gestureReset(sourceId: sourceId)
            }
        }
    }

    private var space: CoordinateSpace {
        .named(coordinator.coordinateSpaceName)
    }

    private func dragGesture(sourceId: String, minimumDistance: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: minimumDistance, coordinateSpace: space)
            .updating($isGestureActive) { _, state, _ in
                state = true
            }
            .onChanged { value in
                coordinator.dragChanged(
                    sourceId: sourceId,
                    location: value.location,
                    translation: value.translation
                )
            }
            .onEnded { _ in
                coordinator.dragEnded(sourceId: sourceId)
            }
    }

    private func pressGesture(sourceId: String) -> some Gesture {
        LongPressGesture(minimumDuration: coordinator.pressSeconds, maximumDistance: coordinator.slopPoints)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: space))
            .updating($isGestureActive) { value, state, _ in
                if case .second = value {
                    state = true
                }
            }
            .onChanged { value in
                switch value {
                case .first:
                    // Still pressing: nothing lifts until the duration passes.
                    break
                case .second(true, nil):
                    // The press fired; lift before the finger moves.
                    coordinator.pressActivated(sourceId: sourceId)
                case .second(true, let drag?):
                    coordinator.dragChanged(
                        sourceId: sourceId,
                        location: drag.location,
                        translation: drag.translation
                    )
                default:
                    break
                }
            }
            .onEnded { _ in
                coordinator.dragEnded(sourceId: sourceId)
            }
    }
}
