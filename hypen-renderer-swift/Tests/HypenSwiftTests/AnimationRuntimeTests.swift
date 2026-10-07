import Testing
import SwiftUI
@testable import HypenSwift

// MARK: - Harness

/// A renderer wired to a virtual clock and a recording dispatcher, so the
/// `duration + delay + 80ms` finalize backbone and the completion contract
/// can be asserted without sleeping.
@MainActor
private struct AnimHarness {
    let renderer = HypenRenderer()
    let clock = HypenManualAnimationScheduler()
    let dispatcher = MockActionDispatcher()

    init(reducedMotion: Bool = false) {
        renderer.animator.scheduler = clock
        renderer.animator.actionDispatcher = dispatcher
        renderer.animator.reducedMotionOverride = reducedMotion
    }

    /// Apply a batch that is NOT the first — the first-ever batch is
    /// suppressed by contract (initial render must not cascade enters), so
    /// most tests need a prior batch to be meaningful.
    func settleFirstBatch() {
        renderer.applyPatches([Patch(type: .create, id: "__seed", elementType: "column")])
    }

    /// Completions unwrapped from their wire form. Every completion must be
    /// a node-addressed `__hypen_dispatch` envelope; a bare dispatch shows
    /// up with `wire` = the bare action and `node` = nil so tests fail.
    var completions: [(wire: String, node: String?, action: String, payload: [String: Any]?)] {
        dispatcher.dispatchedActions.map { d in
            guard d.action == "__hypen_dispatch", let env = d.payload else {
                return (d.action, nil, d.action, d.payload)
            }
            return (d.action, env["node"] as? String, env["action"] as? String ?? "",
                    env["payload"] as? [String: Any])
        }
    }
}

/// `{150, easeIn, [fade]}` — the `.exit` defaults.
private var exitFadeSpec: [String: Any] {
    ["curve": "easeIn", "duration": 150, "presets": ["fade"]]
}
/// `{200, easeOut, [fade]}` — the `.enter` defaults.
private var enterFadeSpec: [String: Any] {
    ["curve": "easeOut", "duration": 200, "presets": ["fade"]]
}

// MARK: - Deferred remove: the renderer owns the corpse

@Test func testFlaggedRemoveKeepsTheSubtreeAliveAndExcludesIt() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column",
                  props: [HypenAnim.exitProp: exitFadeSpec]),
            Patch(type: .create, id: "label", elementType: "text"),
            Patch(type: .insert, id: "label", parentId: "card"),
        ])

        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])

        // Not torn down: the engine-side id is dead, but the renderer owns
        // the corpse until its exit settles.
        #expect(h.renderer.getElement("card") != nil)
        #expect(h.renderer.getElement("label") != nil)
        #expect(h.renderer.animator.isExiting("card"))
        // Exclusion covers the whole subtree, immediately.
        #expect(h.renderer.getElement("card")?.isAnimationExcluded == true)
        #expect(h.renderer.getElement("label")?.isAnimationExcluded == true)
        // Playing the exit: the root glides to its hidden pose.
        #expect(h.renderer.getElement("card")?.animPose?.opacity == 0)
        #expect(h.renderer.getElement("card")?.animPoseAnimation
                == Animation.easeIn(duration: 0.15))
        // An exiting node snaps its prop changes.
        #expect(h.renderer.getElement("card")?.animTransitionAnimation == nil)
    }
}

@Test func testExitFinalizesOnTheTimeoutBackbone() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column",
                  props: [HypenAnim.exitProp: exitFadeSpec]),
            Patch(type: .create, id: "label", elementType: "text"),
            Patch(type: .insert, id: "label", parentId: "card"),
        ])
        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])

        // 150ms duration + 0 delay + 80ms grace = 230ms. Still alive at 229.
        h.clock.advance(by: 0.229)
        #expect(h.renderer.getElement("card") != nil)

        h.clock.advance(by: 0.002)
        #expect(h.renderer.getElement("card") == nil)
        #expect(h.renderer.getElement("label") == nil)
        #expect(!h.renderer.animator.isExiting("card"))
    }
}

@Test func testPlainRemovesInsideAnExitingSubtreeDeferToTheRootFinalize() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column",
                  props: [HypenAnim.exitProp: exitFadeSpec]),
            Patch(type: .create, id: "label", elementType: "text"),
            Patch(type: .insert, id: "label", parentId: "card"),
        ])

        // Root-first ordering: the flagged root arrives before its
        // descendants' plain Removes.
        h.renderer.applyPatches([
            Patch(type: .remove, id: "card", transition: true),
            Patch(type: .remove, id: "label"),
        ])

        // The descendant must NOT be torn out from under a playing exit.
        #expect(h.renderer.getElement("label") != nil)
        #expect(h.renderer.getChildren(of: "card").count == 1)

        h.clock.advance(by: 0.3)
        #expect(h.renderer.getElement("label") == nil)
        #expect(h.renderer.getElement("card") == nil)
    }
}

@Test func testFlaggedRemoveWithoutAnExitSpecSnaps() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([Patch(type: .create, id: "card", elementType: "column")])
        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])
        // No spec to play: snap, don't error.
        #expect(h.renderer.getElement("card") == nil)
        #expect(!h.renderer.animator.isExiting("card"))
    }
}

@Test func testUnflaggedRemoveOfAnExitCapableNodeStillSnaps() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column",
                  props: [HypenAnim.exitProp: exitFadeSpec]),
        ])
        // Non-animated removals keep the old wire and the old behavior.
        h.renderer.applyPatches([Patch(type: .remove, id: "card")])
        #expect(h.renderer.getElement("card") == nil)
    }
}

@Test func testReducedMotionFinalizesFlaggedRemovesImmediately() async {
    await MainActor.run {
        let h = AnimHarness(reducedMotion: true)
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column",
                  props: [HypenAnim.exitProp: exitFadeSpec]),
        ])
        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])
        #expect(h.renderer.getElement("card") == nil)
        // ...and no completion, because nothing played.
        #expect(h.completions.isEmpty)
    }
}

@Test func testMotionEssentialExemptsANodeFromTheReducedMotionExitSnap() async {
    await MainActor.run {
        let h = AnimHarness(reducedMotion: true)
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column",
                  props: [
                    HypenAnim.exitProp: exitFadeSpec,
                    HypenAnim.motionProp: ["essential": true],
                  ]),
        ])
        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])
        // Essential nodes exit as if the preference were off.
        #expect(h.renderer.getElement("card") != nil)
        h.clock.advance(by: 0.231)
        #expect(h.renderer.getElement("card") == nil)
    }
}

@Test func testRepeatedFlaggedRemoveRestartsTheFinalizeInsteadOfDoubleFinalizing() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column",
                  props: [HypenAnim.exitProp: exitFadeSpec]),
        ])
        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])
        h.clock.advance(by: 0.2)
        // Re-flagged mid-exit: the newest finalize wins.
        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])
        h.clock.advance(by: 0.1)
        #expect(h.renderer.getElement("card") != nil)
        h.clock.advance(by: 0.14)
        #expect(h.renderer.getElement("card") == nil)
        // Exactly one exit completion, never two.
        #expect(h.completions.count == 0)
    }
}

// MARK: - Enter

@Test func testFirstEverBatchDoesNotCascadeEnters() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column",
                  props: [HypenAnim.enterProp: enterFadeSpec]),
        ])
        // Initial render never enter-animates: no hidden pose is staged.
        #expect(h.renderer.getElement("root")?.animPose == nil)
        h.clock.advance(by: 0.5)
        #expect(h.completions.isEmpty)
    }
}

@Test func testNodesCreatedInALaterBatchEnterAndSettle() async {
    await MainActor.run {
        let h = AnimHarness()
        h.settleFirstBatch()

        h.renderer.applyPatches([
            Patch(type: .create, id: "toast", elementType: "column",
                  props: [
                    HypenAnim.enterProp: [
                        "curve": "easeOut", "duration": 250,
                        "from": "bottom", "presets": ["slide", "fade"],
                    ],
                    HypenAnim.completeProp: "@animationDone",
                  ]),
            Patch(type: .insert, id: "toast", parentId: "__seed"),
        ])

        // Staged at the hidden pose, snapped there (no animation).
        let toast = h.renderer.getElement("toast")
        #expect(toast?.animPose?.opacity == 0)
        #expect(toast?.animPose?.offsetY == 24)
        #expect(toast?.animPoseAnimation == nil)

        // Next tick: animate back to base.
        h.clock.advance(by: 0)
        #expect(toast?.animPose == nil)
        #expect(toast?.animPoseAnimation == Animation.easeOut(duration: 0.25))
        #expect(h.completions.isEmpty)

        // Natural settle at duration + delay.
        h.clock.advance(by: 0.25)
        #expect(h.completions.count == 1)
        #expect(h.completions[0].wire == "__hypen_dispatch")
        #expect(h.completions[0].node == "toast")
        #expect(h.completions[0].action == "animationDone")
        #expect(h.completions[0].payload?["animation"] as? String == "enter")
    }
}

@Test func testACachedAttachNeverReplaysAnEnter() async {
    await MainActor.run {
        let h = AnimHarness()
        h.settleFirstBatch()
        h.renderer.applyPatches([
            Patch(type: .create, id: "route", elementType: "column",
                  props: [HypenAnim.enterProp: enterFadeSpec]),
            Patch(type: .insert, id: "route", parentId: "__seed"),
        ])
        h.clock.advance(by: 0.5)
        h.renderer.applyPatches([Patch(type: .detach, id: "route")])

        h.renderer.applyPatches([
            Patch(type: .attach, id: "route", parentId: "__seed"),
        ])
        // Attach is not Create — no hidden pose is staged.
        #expect(h.renderer.getElement("route")?.animPose == nil)
    }
}

@Test func testReducedMotionSkipsEnters() async {
    await MainActor.run {
        let h = AnimHarness(reducedMotion: true)
        h.settleFirstBatch()
        h.renderer.applyPatches([
            Patch(type: .create, id: "toast", elementType: "column",
                  props: [
                    HypenAnim.enterProp: enterFadeSpec,
                    HypenAnim.completeProp: "@animationDone",
                  ]),
            Patch(type: .insert, id: "toast", parentId: "__seed"),
        ])
        #expect(h.renderer.getElement("toast")?.animPose == nil)
        h.clock.advance(by: 1)
        #expect(h.completions.isEmpty)
    }
}

// MARK: - `.transition` and the transaction precedence chain

@Test func testNodeTransitionGlidesWhitelistedPropChanges() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "box", elementType: "box",
                  props: [HypenAnim.transitionProp: ["duration": 250, "curve": "spring"]]),
        ])
        // Created-in-batch: the node's first motion is structural, not a glide.
        #expect(h.renderer.getElement("box")?.animTransitionAnimation == nil)

        h.renderer.applyPatches([Patch(type: .setProp, id: "box", name: "opacity.0", value: 0.5)])
        #expect(h.renderer.getElement("box")?.animTransitionAnimation
                == Animation.timingCurve(0.34, 1.56, 0.64, 1, duration: 0.25))
    }
}

@Test func testAnUnspeccedNodeSnaps() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([Patch(type: .create, id: "box", elementType: "box")])
        h.renderer.applyPatches([Patch(type: .setProp, id: "box", name: "opacity.0", value: 0.5)])
        #expect(h.renderer.getElement("box")?.animTransitionAnimation == nil)
    }
}

@Test func testTransactionStampOutranksTheNodeTransition() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "box", elementType: "box",
                  props: [HypenAnim.transitionProp: ["duration": 250, "curve": "spring"]]),
            Patch(type: .create, id: "plain", elementType: "box"),
        ])

        // batch-animation-stamp.json: the prelude is emitted FIRST.
        h.renderer.applyPatches([
            Patch(type: .batchAnimation, spec: ["curve": "linear", "duration": 100]),
            Patch(type: .setProp, id: "box", name: "opacity.0", value: 0.5),
            Patch(type: .setProp, id: "plain", name: "opacity.0", value: 0.5),
        ])

        // The transaction overrides the node's own `.transition`...
        #expect(h.renderer.getElement("box")?.animTransitionAnimation
                == Animation.linear(duration: 0.1))
        // ...and reaches nodes with no spec of their own.
        #expect(h.renderer.getElement("plain")?.animTransitionAnimation
                == Animation.linear(duration: 0.1))
    }
}

@Test func testAPreludeAwayFromBatchIndexZeroIsNotAStamp() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([Patch(type: .create, id: "box", elementType: "box")])
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "box", name: "opacity.0", value: 0.5),
            Patch(type: .batchAnimation, spec: ["curve": "linear", "duration": 100]),
        ])
        #expect(h.renderer.getElement("box")?.animTransitionAnimation == nil)
    }
}

@Test func testTheStampIsClearedPerBatch() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([Patch(type: .create, id: "box", elementType: "box")])
        h.renderer.applyPatches([
            Patch(type: .batchAnimation, spec: ["curve": "linear", "duration": 100]),
            Patch(type: .setProp, id: "box", name: "opacity.0", value: 0.5),
        ])
        h.renderer.applyPatches([Patch(type: .setProp, id: "box", name: "opacity.0", value: 1)])
        #expect(h.renderer.getElement("box")?.animTransitionAnimation == nil)
        #expect(h.renderer.animator.transactionTiming == nil)
    }
}

@Test func testStructuralPlaybacksOutrankTheTransaction() async {
    await MainActor.run {
        let h = AnimHarness()
        h.settleFirstBatch()

        // A node created in the stamped batch is excluded — its queued
        // enter owns the first motion.
        h.renderer.applyPatches([
            Patch(type: .batchAnimation, spec: ["curve": "linear", "duration": 100]),
            Patch(type: .create, id: "fresh", elementType: "box",
                  props: [HypenAnim.enterProp: enterFadeSpec]),
            Patch(type: .insert, id: "fresh", parentId: "__seed"),
        ])
        #expect(h.renderer.getElement("fresh")?.animTransitionAnimation == nil)
        #expect(h.renderer.getElement("fresh")?.animPose?.opacity == 0)

        // An exiting node snaps even inside a stamped batch.
        h.renderer.applyPatches([
            Patch(type: .create, id: "dying", elementType: "box",
                  props: [HypenAnim.exitProp: exitFadeSpec]),
            Patch(type: .insert, id: "dying", parentId: "__seed"),
        ])
        h.renderer.applyPatches([Patch(type: .remove, id: "dying", transition: true)])
        h.renderer.applyPatches([
            Patch(type: .batchAnimation, spec: ["curve": "linear", "duration": 100]),
            Patch(type: .setProp, id: "dying", name: "opacity.0", value: 0.2),
        ])
        #expect(h.renderer.getElement("dying")?.animTransitionAnimation == nil)
    }
}

@Test func testReducedMotionIgnoresStampsExceptForEssentialNodes() async {
    await MainActor.run {
        let h = AnimHarness(reducedMotion: true)
        h.renderer.applyPatches([
            Patch(type: .create, id: "plain", elementType: "box",
                  props: [HypenAnim.transitionProp: ["duration": 250, "curve": "spring"]]),
            Patch(type: .create, id: "essential", elementType: "box",
                  props: [
                    HypenAnim.transitionProp: ["duration": 250, "curve": "spring"],
                    HypenAnim.motionProp: ["essential": true],
                  ]),
        ])
        h.renderer.applyPatches([
            Patch(type: .batchAnimation, spec: ["curve": "linear", "duration": 100]),
            Patch(type: .setProp, id: "plain", name: "opacity.0", value: 0.5),
            Patch(type: .setProp, id: "essential", name: "opacity.0", value: 0.5),
        ])
        #expect(h.renderer.getElement("plain")?.animTransitionAnimation == nil)
        #expect(h.renderer.getElement("essential")?.animTransitionAnimation
                == Animation.linear(duration: 0.1))
    }
}

// MARK: - `.states`

@Test func testStatesPoseFlipGlidesThroughTheSynthesizedTransition() async {
    await MainActor.run {
        let h = AnimHarness()
        // states-lowering.json shape.
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "box", props: [
                "cornerRadius.0": 8, "width.0": 48, "opacity.0": 0.9,
                HypenAnim.statesProp: ["label": "collapsed"],
                HypenAnim.transitionProp: [
                    "curve": "spring", "duration": 250,
                    "props": ["cornerRadius", "width", "opacity"],
                ],
                HypenAnim.completeProp: "@poseDone",
            ]),
        ])
        #expect(h.renderer.getElement("card")?.animSpecs.statesLabel == "collapsed")

        // states-switch: the pose flip is ordinary SetProps plus a label.
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "card", name: "cornerRadius.0", value: 16),
            Patch(type: .setProp, id: "card", name: "width.0", value: 240),
            Patch(type: .setProp, id: "card", name: HypenAnim.statesProp,
                  value: ["label": "expanded"] as [String: Any]),
        ])
        #expect(h.renderer.getElement("card")?.animTransitionAnimation
                == Animation.timingCurve(0.34, 1.56, 0.64, 1, duration: 0.25))

        h.clock.advance(by: 0.25)
        #expect(h.completions.count == 1)
        #expect(h.completions[0].wire == "__hypen_dispatch")
        #expect(h.completions[0].node == "card")
        #expect(h.completions[0].action == "poseDone")
        #expect(h.completions[0].payload?["animation"] as? String == "states")
        #expect(h.completions[0].payload?["state"] as? String == "expanded")
    }
}

@Test func testASupersededStatesTransitionFiresNothing() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "box", props: [
                HypenAnim.statesProp: ["label": "a"],
                HypenAnim.transitionProp: ["curve": "linear", "duration": 250],
                HypenAnim.completeProp: "@poseDone",
            ]),
        ])
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "card", name: HypenAnim.statesProp,
                  value: ["label": "b"] as [String: Any]),
        ])
        h.clock.advance(by: 0.1)
        // Retargeted before it settled: the first playback fires nothing.
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "card", name: HypenAnim.statesProp,
                  value: ["label": "c"] as [String: Any]),
        ])
        h.clock.advance(by: 0.2)
        #expect(h.completions.isEmpty)

        h.clock.advance(by: 0.06)
        #expect(h.completions.count == 1)
        #expect(h.completions[0].payload?["state"] as? String == "c")
    }
}

@Test func testAStatesLabelWithoutATransitionSpecCompletesNothing() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "box",
                  props: [HypenAnim.completeProp: "@poseDone"]),
        ])
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "card", name: HypenAnim.statesProp,
                  value: ["label": "b"] as [String: Any]),
        ])
        h.clock.advance(by: 2)
        #expect(h.completions.isEmpty)
    }
}

// MARK: - `.animate`

@Test func testAFinitePresetCompletesWithItsPresetName() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "box", elementType: "box", props: [
                HypenAnim.animateProp: [
                    "preset": "shake", "duration": 400, "repeat": 2, "curve": "easeInOut",
                ],
                HypenAnim.completeProp: "@animationDone",
            ]),
        ])
        h.clock.advance(by: 0.79)
        #expect(h.completions.isEmpty)
        h.clock.advance(by: 0.02)
        #expect(h.completions.count == 1)
        #expect(h.completions[0].wire == "__hypen_dispatch")
        #expect(h.completions[0].node == "box")
        #expect(h.completions[0].action == "animationDone")
        #expect(h.completions[0].payload?["animation"] as? String == "shake")
        #expect(h.renderer.getElement("box")?.animateFiniteExhausted == true)
    }
}

@Test func testALoopingPresetNeverCompletes() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "box", elementType: "box", props: [
                HypenAnim.animateProp: [
                    "preset": "spin", "duration": 800, "repeat": "loop", "curve": "linear",
                ],
                HypenAnim.completeProp: "@animationDone",
            ]),
        ])
        h.clock.advance(by: 30)
        #expect(h.completions.isEmpty)
    }
}

@Test func testAChangedAnimateSpecRestartsAndARemovedChannelStops() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "box", elementType: "box", props: [
                HypenAnim.animateProp: [
                    "preset": "shake", "duration": 400, "repeat": 1, "curve": "easeInOut",
                ],
                HypenAnim.completeProp: "@animationDone",
            ]),
        ])
        let generation = h.renderer.getElement("box")?.animateGeneration ?? 0

        h.clock.advance(by: 0.2)
        // Retarget: the in-flight finite playback is superseded and fires
        // nothing; the new one restarts the clock.
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "box", name: HypenAnim.animateProp,
                  value: ["preset": "shake", "duration": 400,
                          "repeat": 1, "curve": "linear"] as [String: Any]),
        ])
        #expect((h.renderer.getElement("box")?.animateGeneration ?? 0) > generation)
        h.clock.advance(by: 0.3)
        #expect(h.completions.isEmpty)
        h.clock.advance(by: 0.11)
        #expect(h.completions.count == 1)

        // Removing the channel stops it: no further completions.
        h.renderer.applyPatches([
            Patch(type: .removeProp, id: "box", name: HypenAnim.animateProp),
        ])
        #expect(h.renderer.getElement("box")?.animSpecs.animate == nil)
        h.clock.advance(by: 5)
        #expect(h.completions.count == 1)
    }
}

@Test func testReducedMotionNeverStartsAPreset() async {
    await MainActor.run {
        let h = AnimHarness(reducedMotion: true)
        h.renderer.applyPatches([
            Patch(type: .create, id: "box", elementType: "box", props: [
                HypenAnim.animateProp: [
                    "preset": "shake", "duration": 400, "repeat": 1, "curve": "easeInOut",
                ],
                HypenAnim.completeProp: "@animationDone",
            ]),
        ])
        h.clock.advance(by: 5)
        #expect(h.completions.isEmpty)
    }
}

@Test func testPresetPlaybackTimingSplitsIntoLegs() {
    // pulse autoreverses over two legs of duration/2; a finite repeat
    // multiplies the leg count.
    let loop = AnimAnimateSpec(
        preset: .pulse,
        timing: AnimTiming(durationMs: 1200, curve: .easeInOut),
        repeatCount: .loop
    )
    #expect(HypenAnimatePresetModifier.playback(for: loop)
            == Animation.easeInOut(duration: 0.6).repeatForever(autoreverses: true))

    let spin = AnimAnimateSpec(
        preset: .spin,
        timing: AnimTiming(durationMs: 800, curve: .linear),
        repeatCount: .count(3)
    )
    #expect(HypenAnimatePresetModifier.playback(for: spin)
            == Animation.linear(duration: 0.8).repeatCount(3, autoreverses: false))
}

// MARK: - `.onAnimationComplete` dispatch contract

@Test func testExitCompletionFiresOnTheRootAtFinalize() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column", props: [
                HypenAnim.exitProp: exitFadeSpec,
                HypenAnim.completeProp: "@animationDone",
            ]),
            Patch(type: .create, id: "label", elementType: "text",
                  props: [HypenAnim.completeProp: "@childDone"]),
            Patch(type: .insert, id: "label", parentId: "card"),
        ])
        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])

        // While exiting: a non-root member, and the root outside its own
        // finalize, dispatch nothing (engine-side dead / excluded).
        if let label = h.renderer.getElement("label"), let card = h.renderer.getElement("card") {
            h.renderer.animator.dispatchCompletion(element: label, animation: "shake")
            h.renderer.animator.dispatchCompletion(element: card, animation: "shake")
        } else {
            Issue.record("exiting subtree should still be alive")
        }
        #expect(h.completions.isEmpty)

        h.clock.advance(by: 0.231)

        // Exactly one: the exiting ROOT, addressed to its OWN id (the
        // engine's exit tombstone accepts it). Descendants fire nothing.
        #expect(h.completions.count == 1)
        #expect(h.completions[0].wire == "__hypen_dispatch")
        #expect(h.completions[0].node == "card")
        #expect(h.completions[0].action == "animationDone")
        #expect(h.completions[0].payload?["animation"] as? String == "exit")
    }
}

@Test func testCompletionPayloadCarriesCustomArgsButNeverShadowsTheChannel() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column", props: [
                HypenAnim.exitProp: exitFadeSpec,
                HypenAnim.completeProp: "@actions.done",
                "onAnimationComplete.source": "hero",
                // A custom arg must never shadow the completion fields.
                "onAnimationComplete.animation": "bogus",
            ]),
        ])
        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])
        h.clock.advance(by: 0.231)

        #expect(h.completions.count == 1)
        #expect(h.completions[0].action == "done")
        #expect(h.completions[0].payload?["source"] as? String == "hero")
        #expect(h.completions[0].payload?["animation"] as? String == "exit")
    }
}

@Test func testANodeWithoutTheCompletePropDispatchesNothing() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column",
                  props: [HypenAnim.exitProp: exitFadeSpec]),
        ])
        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])
        h.clock.advance(by: 0.231)
        #expect(h.completions.isEmpty)
    }
}

@Test func testCompletionsFromADetachedSubtreeAreSuppressed() async {
    await MainActor.run {
        let h = AnimHarness()
        h.settleFirstBatch()
        h.renderer.applyPatches([
            Patch(type: .create, id: "route", elementType: "column"),
            Patch(type: .insert, id: "route", parentId: "__seed"),
            Patch(type: .create, id: "card", elementType: "box", props: [
                HypenAnim.statesProp: ["label": "a"],
                HypenAnim.transitionProp: ["curve": "linear", "duration": 100],
                HypenAnim.completeProp: "@poseDone",
            ]),
            Patch(type: .insert, id: "card", parentId: "route"),
        ])
        h.clock.advance(by: 0.5)
        h.dispatcher.clear()

        // A cached Router subtree keeps reconciling engine-side, but it is
        // not on screen — its settles dispatch nothing.
        h.renderer.applyPatches([Patch(type: .detach, id: "route")])
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "card", name: HypenAnim.statesProp,
                  value: ["label": "b"] as [String: Any]),
        ])
        h.clock.advance(by: 0.2)
        #expect(h.completions.isEmpty)
    }
}

// MARK: - Reset

@Test func testClearCancelsEveryInFlightPlayback() async {
    await MainActor.run {
        let h = AnimHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "column", props: [
                HypenAnim.exitProp: exitFadeSpec,
                HypenAnim.completeProp: "@animationDone",
            ]),
        ])
        h.renderer.applyPatches([Patch(type: .remove, id: "card", transition: true)])
        h.renderer.clear()
        h.clock.advance(by: 1)
        #expect(h.completions.isEmpty)
        #expect(!h.renderer.animator.isExiting("card"))
    }
}
