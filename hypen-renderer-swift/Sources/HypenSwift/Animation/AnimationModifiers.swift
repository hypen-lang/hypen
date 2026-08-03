import SwiftUI

private let log = HypenLoggers.renderer

/// The pixels half of the `__anim.*` runtime.
///
/// `HypenAnimator` owns the state (what pose a node is in, what animation
/// its next prop change rides, which subtrees are exiting corpses); this
/// file reads that state off each `HypenElement` and hands it to SwiftUI.
/// Everything here is per element, driven by the implicit
/// `.animation(_:value:)` form — see the precedence note in
/// `HypenAnimator`.

// MARK: - Exiting-subtree dispatch guard

/// Swallows every action dispatched from inside an exiting subtree.
///
/// `allowsHitTesting(false)` stops touches, but not a programmatic
/// dispatch from a component that is still mounted while its exit plays.
/// The engine-side ids in an exiting subtree are already dead, so
/// dispatching from one fires a ghost — the DOM renderer drops these at its
/// single dispatch chokepoint (`dom/applicators/events.ts:278`) and this is
/// the SwiftUI equivalent: the element view hands its component and
/// applicator contexts this dispatcher instead of the live one.
public final class HypenSuppressedActionDispatcher: ActionDispatcher, @unchecked Sendable {
    public static let shared = HypenSuppressedActionDispatcher()

    private init() {}

    public func dispatch(action: String, payload: [String: Any]?) {
        log.debug("Dropped action \"\(action)\" from an exiting subtree")
    }
}

// MARK: - Pose, glide and exclusion

extension View {
    /// Apply an element's animation state: the enter/exit pose, the
    /// resolved glide animation for whitelisted prop changes, and — while
    /// the node sits in an exiting subtree — exclusion from hit-testing and
    /// accessibility.
    ///
    /// Ordering matters. The pose modifiers come first so the implicit
    /// `.animation(animPoseAnimation, value: animPose)` immediately above
    /// them owns exactly the pose channel; the `.transition` glide sits
    /// outside it so a prop change and a pose change never share a
    /// transaction's animation.
    @ViewBuilder
    func hypenAnimationState(_ element: HypenElement) -> some View {
        let pose = element.animPose
        let excluded = element.isAnimationExcluded
        // Building the whitelist snapshot costs a lookup per animatable
        // prop, so skip it entirely for the overwhelmingly common node with
        // no resolved glide animation.
        let snapshot: HypenAnimSnapshot = element.animTransitionAnimation == nil
            ? .empty
            : HypenAnimSnapshot.build(
                props: element.props,
                scope: element.animSpecs.transition?.props
            )

        self
            .opacity(pose?.opacity ?? 1)
            .scaleEffect(pose?.scale ?? 1)
            .offset(x: pose?.offsetX ?? 0, y: pose?.offsetY ?? 0)
            .animation(element.animPoseAnimation, value: pose)
            .animation(element.animTransitionAnimation, value: snapshot)
            .allowsHitTesting(!excluded)
            .accessibilityHidden(excluded)
    }
}

// MARK: - `.animate` presets

extension View {
    /// Play the node's `.animate` preset, if it has one and motion is
    /// allowed.
    @ViewBuilder
    func hypenAnimatePreset(_ element: HypenElement, animator: HypenAnimator) -> some View {
        if element.animSpecs.animate != nil {
            modifier(HypenAnimatePresetModifier(element: element, animator: animator))
        } else {
            self
        }
    }
}

/// View-local playback of the four built-in `.animate` presets.
///
/// Keyframe *shapes* are renderer-owned; only the names and the timing
/// defaults (`ANIMATE_PRESETS`) are normative. Contracts honored here:
/// a changed spec restarts playback (the animator bumps
/// `animateGeneration`), a removed channel stops it, looping presets run
/// forever, finite ones run their count, a cached Router `Attach` resumes
/// loops but never replays an exhausted finite preset
/// (`animateFiniteExhausted`), and exiting nodes keep playing.
struct HypenAnimatePresetModifier: ViewModifier {
    @ObservedObject var element: HypenElement
    let animator: HypenAnimator

    @Environment(\.accessibilityReduceMotion) private var environmentReduceMotion

    /// 0 = playback start pose, 1 = playback end pose. Animated by a
    /// repeating SwiftUI animation; each preset maps it to its own channel.
    @State private var phase: CGFloat = 0
    @State private var playingGeneration: Int = -1

    private var reduceMotion: Bool {
        animator.reducedMotionOverride ?? environmentReduceMotion
    }

    /// Reduced motion never starts a preset; `.motion(essential)` exempts
    /// the node from that.
    private var spec: AnimAnimateSpec? {
        guard !reduceMotion || element.animSpecs.motionEssential else { return nil }
        return element.animSpecs.animate
    }

    func body(content: Content) -> some View {
        Group {
            if let spec = spec {
                decorate(content, spec: spec)
            } else {
                content
            }
        }
        .onAppear { start(force: false) }
        .onChangeCompat(of: element.animateGeneration) { _ in start(force: true) }
    }

    @ViewBuilder
    private func decorate(_ content: Content, spec: AnimAnimateSpec) -> some View {
        switch spec.preset {
        case .pulse:
            // opacity 1 → 0.5 → 1 (DOM `hypen-pulse`).
            content.opacity(1 - 0.5 * Double(phase))
        case .spin:
            content.rotationEffect(.degrees(360 * Double(phase)))
        case .shake:
            // NARROWING: SwiftUI's autoreversing repeat bounces between two
            // endpoints only, so the DOM's ±6/±4px three-point oscillation
            // collapses to a one-sided 0 → 6px shake of the same amplitude,
            // duration and repeat count. Recorded, not silently different
            // in timing.
            content.offset(x: 6 * phase)
        case .shimmer:
            content.overlay(shimmerSweep)
        }
    }

    private var shimmerSweep: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            LinearGradient(
                colors: [.clear, Color.white.opacity(0.35), .clear],
                startPoint: .leading,
                endPoint: .trailing
            )
            .frame(width: max(width * 0.6, 1))
            .offset(x: -width * 0.6 + phase * width * 1.6)
        }
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// (Re)start the repeating animation. A restart snaps the phase back
    /// with animations disabled, then plays forward on the next runloop
    /// turn — SwiftUI will not restart a repeating animation whose value
    /// is already at its destination.
    private func start(force: Bool) {
        guard let spec = spec else { return }
        if !force && playingGeneration == element.animateGeneration { return }
        // A cached Attach re-mounts the view; a finite preset that already
        // ran must not replay.
        if element.animateFiniteExhausted && !spec.repeatCount.isLoop { return }
        playingGeneration = element.animateGeneration

        var snap = Transaction()
        snap.disablesAnimations = true
        withTransaction(snap) { phase = 0 }

        DispatchQueue.main.async {
            withAnimation(Self.playback(for: spec)) { phase = 1 }
        }
    }

    /// Build the repeating animation for a preset. `pulse` and `shake`
    /// autoreverse (they return to their base pose); `spin` and `shimmer`
    /// sweep one way and restart.
    static func playback(for spec: AnimAnimateSpec) -> Animation {
        let autoreverses: Bool
        let legs: Double
        switch spec.preset {
        case .pulse:
            autoreverses = true
            legs = 2
        case .shake:
            autoreverses = true
            legs = 4
        case .spin, .shimmer:
            autoreverses = false
            legs = 1
        }

        let legTiming = AnimTiming(
            durationMs: spec.timing.durationMs / legs,
            curve: spec.timing.curve,
            delayMs: 0
        )
        var animation: Animation
        switch spec.repeatCount {
        case .loop:
            animation = legTiming.animation.repeatForever(autoreverses: autoreverses)
        case .count(let iterations):
            animation = legTiming.animation.repeatCount(
                Int(legs) * iterations,
                autoreverses: autoreverses
            )
        }
        if spec.timing.delayMs > 0 {
            animation = animation.delay(spec.timing.delayMs / 1000)
        }
        return animation
    }
}
