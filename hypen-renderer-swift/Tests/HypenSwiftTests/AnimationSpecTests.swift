import Testing
import SwiftUI
@testable import HypenSwift

// MARK: - `__anim.*` channel parsing
//
// Mirrors the tolerance of `parseAnimProps` in
// `@hypen-space/core/animation`: every channel validates independently and
// degrades to nil (= snap) rather than throwing, so one malformed channel
// can never poison its siblings.

@Test func testParseTransitionFullWhitelist() {
    let spec = HypenAnim.parseTransition(["duration": 250, "curve": "spring"])
    #expect(spec?.timing.durationMs == 250)
    #expect(spec?.timing.curve == .spring)
    #expect(spec?.timing.delayMs == 0)
    // No `props` key = every animatable prop transitions.
    #expect(spec?.props == nil)
}

@Test func testParseTransitionScopedProps() {
    // The states-lowering fixture's synthesized transition.
    let spec = HypenAnim.parseTransition([
        "duration": 250,
        "curve": "spring",
        "props": ["cornerRadius", "width", "opacity"],
    ])
    #expect(spec?.props == ["cornerRadius", "width", "opacity"])
}

@Test func testParseTransitionFiltersUnknownScopedProps() {
    let spec = HypenAnim.parseTransition([
        "duration": 200,
        "curve": "easeOut",
        "props": ["opacity", "boxShadow", "zIndex"],
    ])
    #expect(spec?.props == ["opacity"])
}

@Test func testParseTransitionMalformedDegradesToNil() {
    // Not an object.
    #expect(HypenAnim.parseTransition(42) == nil)
    #expect(HypenAnim.parseTransition("not json") == nil)
    #expect(HypenAnim.parseTransition(nil) == nil)
    // Missing curve / duration — the engine always emits both.
    #expect(HypenAnim.parseTransition(["duration": 200]) == nil)
    #expect(HypenAnim.parseTransition(["curve": "easeOut"]) == nil)
    // Unknown curve token.
    #expect(HypenAnim.parseTransition(["duration": 200, "curve": "bouncy"]) == nil)
    // Negative duration.
    #expect(HypenAnim.parseTransition(["duration": -1, "curve": "easeOut"]) == nil)
    // A scope that filters to nothing animates nothing — same as no channel.
    #expect(HypenAnim.parseTransition([
        "duration": 200, "curve": "easeOut", "props": ["zIndex"],
    ]) == nil)
    // A non-array scope voids the channel.
    #expect(HypenAnim.parseTransition([
        "duration": 200, "curve": "easeOut", "props": "opacity",
    ]) == nil)
}

@Test func testParseTransitionAcceptsStringifiedObject() {
    let spec = HypenAnim.parseTransition(#"{"duration":150,"curve":"easeIn","delay":50}"#)
    #expect(spec?.timing.durationMs == 150)
    #expect(spec?.timing.curve == .easeIn)
    #expect(spec?.timing.delayMs == 50)
}

@Test func testParseEnterExitFromFixtureShapes() {
    // enter-exit-lowering.json
    let enter = HypenAnim.parseEnter([
        "curve": "easeOut", "duration": 250, "from": "bottom",
        "presets": ["slide", "fade"],
    ])
    #expect(enter?.presets == [.slide, .fade])
    #expect(enter?.from == .bottom)
    #expect(enter?.timing.durationMs == 250)

    let exit = HypenAnim.parseExit(["curve": "easeIn", "duration": 150, "presets": ["fade"]])
    #expect(exit?.presets == [.fade])
    #expect(exit?.to == nil)
    #expect(exit?.timing.curve == .easeIn)
}

@Test func testParseEnterDropsInvalidDirectionWithoutVoidingChannel() {
    let enter = HypenAnim.parseEnter([
        "curve": "easeOut", "duration": 200, "from": "sideways", "presets": ["fade"],
    ])
    #expect(enter != nil)
    #expect(enter?.from == nil)
}

@Test func testParseEnterVoidsWhenNoPresetSurvives() {
    #expect(HypenAnim.parseEnter([
        "curve": "easeOut", "duration": 200, "presets": ["dissolve"],
    ]) == nil)
    #expect(HypenAnim.parseEnter([
        "curve": "easeOut", "duration": 200, "presets": [],
    ]) == nil)
    #expect(HypenAnim.parseEnter(["curve": "easeOut", "duration": 200]) == nil)
}

@Test func testParseAnimateRepeatForms() {
    // animate-lowering.json: bare preset gets the per-preset defaults.
    let spin = HypenAnim.parseAnimate([
        "preset": "spin", "duration": 800, "repeat": "loop", "curve": "linear",
    ])
    #expect(spin?.preset == .spin)
    #expect(spin?.repeatCount == .loop)

    let pulse = HypenAnim.parseAnimate([
        "preset": "pulse", "duration": 800, "repeat": 3,
        "curve": "easeInOut", "delay": 100,
    ])
    #expect(pulse?.repeatCount == .count(3))
    #expect(pulse?.timing.delayMs == 100)

    // Invalid repeat forms void the channel.
    #expect(HypenAnim.parseAnimate([
        "preset": "spin", "duration": 800, "repeat": 0, "curve": "linear",
    ]) == nil)
    #expect(HypenAnim.parseAnimate([
        "preset": "spin", "duration": 800, "repeat": 2.5, "curve": "linear",
    ]) == nil)
    #expect(HypenAnim.parseAnimate([
        "preset": "spin", "duration": 800, "repeat": "forever", "curve": "linear",
    ]) == nil)
    // Unknown preset never reaches the wire; defensively it voids too.
    #expect(HypenAnim.parseAnimate([
        "preset": "wobble", "duration": 800, "repeat": "loop", "curve": "linear",
    ]) == nil)
}

@Test func testAnimatePresetDefaultsMatchTheNormativeMap() {
    #expect(AnimatePreset.pulse.defaults.duration == 1200)
    #expect(AnimatePreset.pulse.defaults.repeatCount == .loop)
    #expect(AnimatePreset.pulse.defaults.curve == .easeInOut)
    #expect(AnimatePreset.spin.defaults.duration == 800)
    #expect(AnimatePreset.spin.defaults.curve == .linear)
    #expect(AnimatePreset.shimmer.defaults.duration == 1500)
    #expect(AnimatePreset.shimmer.defaults.curve == .linear)
    #expect(AnimatePreset.shake.defaults.duration == 400)
    #expect(AnimatePreset.shake.defaults.repeatCount == .count(1))
    #expect(AnimatePreset.shake.defaults.curve == .easeInOut)
}

@Test func testParseStatesLabelObjectFormAndBareStringTolerance() {
    // The engine emits the OBJECT form (states-lowering.json).
    #expect(HypenAnim.parseStatesLabel(["label": "collapsed"]) == "collapsed")
    #expect(HypenAnim.parseStatesLabel(#"{"label":"expanded"}"#) == "expanded")
    // Tolerated defensively — the desktop renderer shipped a bug reading
    // only the bare form.
    #expect(HypenAnim.parseStatesLabel("collapsed") == "collapsed")
    // null / malformed = base pose, no matched label.
    #expect(HypenAnim.parseStatesLabel(nil) == nil)
    #expect(HypenAnim.parseStatesLabel(["label": 7]) == nil)
    #expect(HypenAnim.parseStatesLabel([1, 2, 3]) == nil)
}

@Test func testParseMotionEssential() {
    #expect(HypenAnim.parseMotionEssential(["essential": true]))
    #expect(!HypenAnim.parseMotionEssential(["essential": false]))
    #expect(!HypenAnim.parseMotionEssential(["essential": "true"]))
    #expect(!HypenAnim.parseMotionEssential(nil))
    #expect(!HypenAnim.parseMotionEssential("essential"))
}

@Test func testParseSpecsIsolatesMalformedChannels() {
    let specs = HypenAnim.parseSpecs([
        HypenAnim.transitionProp: ["duration": "soon", "curve": "easeOut"],  // malformed
        HypenAnim.enterProp: ["duration": 200, "curve": "easeOut", "presets": ["fade"]],
        HypenAnim.exitProp: 17,                                             // malformed
        HypenAnim.animateProp: ["preset": "spin", "duration": 800,
                                "repeat": "loop", "curve": "linear"],
        HypenAnim.motionProp: ["essential": true],
        HypenAnim.statesProp: ["label": "open"],
    ])
    #expect(specs.transition == nil)
    #expect(specs.enter?.presets == [.fade])
    #expect(specs.exit == nil)
    #expect(specs.animate?.preset == .spin)
    #expect(specs.motionEssential)
    #expect(specs.statesLabel == "open")
    #expect(!specs.isEmpty)
}

@Test func testParseSpecsEmptyForPlainNode() {
    let specs = HypenAnim.parseSpecs(["0": "Hello", "opacity.0": 0.5])
    #expect(specs.isEmpty)
}

// MARK: - Vocabulary + timing

@Test func testAnimatablePropWhitelistMatchesTheEngine() {
    // 27 entries, ir/anim.rs:36.
    #expect(HypenAnim.animatableProps.count == 27)
    #expect(HypenAnim.isAnimatable(prop: "opacity"))
    #expect(HypenAnim.isAnimatable(prop: "marginHorizontal"))
    #expect(HypenAnim.isAnimatable(prop: "fontSize"))
    #expect(!HypenAnim.isAnimatable(prop: "boxShadow"))
    #expect(!HypenAnim.isAnimatable(prop: "zIndex"))
}

@Test func testSpringIsThePinnedOvershootBezierNotSwiftUIPhysics() {
    let spring = AnimTiming(durationMs: 250, curve: .spring).animation
    #expect(spring == Animation.timingCurve(0.34, 1.56, 0.64, 1, duration: 0.25))
    #expect(spring != Animation.spring())
}

@Test func testNamedCurvesMapToTheirSwiftUIEquivalents() {
    #expect(AnimTiming(durationMs: 200, curve: .linear).animation
            == Animation.linear(duration: 0.2))
    #expect(AnimTiming(durationMs: 200, curve: .easeIn).animation
            == Animation.easeIn(duration: 0.2))
    #expect(AnimTiming(durationMs: 200, curve: .easeOut).animation
            == Animation.easeOut(duration: 0.2))
    #expect(AnimTiming(durationMs: 200, curve: .easeInOut).animation
            == Animation.easeInOut(duration: 0.2))
}

@Test func testDelayRidesTheAnimation() {
    let delayed = AnimTiming(durationMs: 200, curve: .easeOut, delayMs: 50).animation
    #expect(delayed == Animation.easeOut(duration: 0.2).delay(0.05))
    #expect(delayed != Animation.easeOut(duration: 0.2))
}

@Test func testSettleTimeoutIsDurationPlusDelayPlusGrace() {
    let timing = AnimTiming(durationMs: 150, curve: .easeIn, delayMs: 50)
    #expect(timing.totalSeconds == 0.2)
    // 150 + 50 + 80 (SETTLE_GRACE_MS)
    #expect(timing.settleTimeoutSeconds == 0.28)
}

// MARK: - Poses

@Test func testHiddenPoseComposesPresets() {
    let pose = HypenAnim.hiddenPose(presets: [.slide, .fade], direction: .bottom)
    #expect(pose.opacity == 0)
    #expect(pose.offsetY == 24)
    #expect(pose.offsetX == 0)
    #expect(pose.scale == nil)

    let scaled = HypenAnim.hiddenPose(presets: [.scale], direction: nil)
    #expect(scaled.scale == 0.95)
    #expect(scaled.opacity == nil)
}

@Test func testHiddenPoseSlideDirectionsAndRTL() {
    #expect(HypenAnim.hiddenPose(presets: [.slide], direction: .top).offsetY == -24)
    // Absent direction defaults to `leading`.
    #expect(HypenAnim.hiddenPose(presets: [.slide], direction: nil).offsetX == -24)
    #expect(HypenAnim.hiddenPose(presets: [.slide], direction: .leading, rtl: true).offsetX == 24)
    #expect(HypenAnim.hiddenPose(presets: [.slide], direction: .trailing).offsetX == 24)
    #expect(HypenAnim.hiddenPose(presets: [.slide], direction: .trailing, rtl: true).offsetX == -24)
}

// MARK: - Snapshot

@Test func testSnapshotScopesToTheTransitionPropList() {
    let base: [String: Any] = ["opacity.0": 0.5, "width.0": 100, "fontSize.0": 12]
    let scoped = HypenAnimSnapshot.build(props: base, scope: ["opacity"])
    var changedWidth = base
    changedWidth["width.0"] = 200
    // A scoped snapshot ignores out-of-scope changes: those props snap.
    #expect(HypenAnimSnapshot.build(props: changedWidth, scope: ["opacity"]) == scoped)
    // ...and the unscoped snapshot notices them.
    #expect(HypenAnimSnapshot.build(props: changedWidth, scope: nil)
            != HypenAnimSnapshot.build(props: base, scope: nil))

    var changedOpacity = base
    changedOpacity["opacity.0"] = 1.0
    #expect(HypenAnimSnapshot.build(props: changedOpacity, scope: ["opacity"]) != scoped)
}

@Test func testSnapshotIgnoresNonWhitelistedProps() {
    let a: [String: Any] = ["opacity.0": 0.5, "boxShadow.0": "none"]
    let b: [String: Any] = ["opacity.0": 0.5, "boxShadow.0": "0 2px 4px"]
    #expect(HypenAnimSnapshot.build(props: a, scope: nil)
            == HypenAnimSnapshot.build(props: b, scope: nil))
}
