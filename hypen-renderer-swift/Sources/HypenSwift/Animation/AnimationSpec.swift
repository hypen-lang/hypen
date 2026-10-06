import Foundation
import SwiftUI

/// The `__anim.*` prop channel: vocabulary, defensive parsing, and the
/// SwiftUI timing mapping.
///
/// Source of truth for the vocabulary is `hypen-engine-rs/src/ir/anim.rs`
/// (`CURVES`, `PRESETS`, `ANIMATE_PRESETS`, `DIRECTIONS`,
/// `ANIMATABLE_PROPS`), mirrored by `@hypen-space/core/animation`
/// (`CURVE_BEZIER_POINTS`, `ANIMATABLE_PROPS`, `ANIMATE_PRESETS`). The
/// parsers below mirror `parseAnimProps` in that module verbatim in
/// tolerance: every channel validates independently and degrades to `nil`
/// (= snap) rather than throwing, so one malformed channel can never poison
/// its siblings — "snap, don't error" (ANIMATION.md, invariant 6).
public enum HypenAnim {

    // MARK: - Wire prop names

    public static let propPrefix = "__anim."
    public static let transitionProp = "__anim.transition"
    public static let enterProp = "__anim.enter"
    public static let exitProp = "__anim.exit"
    public static let layoutProp = "__anim.layout"
    public static let animateProp = "__anim.animate"
    public static let motionProp = "__anim.motion"
    public static let statesProp = "__anim.states"

    /// Action prop the `.onAnimationComplete(@actions.x)` applicator lowers
    /// to. Flattened like any other applicator arg, so it arrives as
    /// `onAnimationComplete.0` (fixture `onanimationcomplete-passthrough`).
    public static let completeProp = "onAnimationComplete.0"

    // MARK: - Pinned constants

    /// How far `slide` offsets a node in its hidden pose (web parity: a
    /// fixed 24px nudge, not a full-width move).
    public static let slideOffset: CGFloat = 24
    /// The `scale` preset's hidden factor.
    public static let scaleHiddenFactor: CGFloat = 0.95
    /// Grace added to `duration + delay` before the timeout backbone
    /// finalizes a playback whose natural settle was never observed
    /// (`SETTLE_GRACE_MS`, `dom/anim.ts:158`).
    public static let settleGraceMs: Double = 80

    /// The normative animatable-prop whitelist (`ir/anim.rs:36`), in the
    /// TS map's declaration order. Only these props glide; everything else
    /// snaps even on a node carrying a `.transition` spec.
    public static let animatableProps: [String] = [
        "opacity",
        "translateX",
        "translateY",
        "scale",
        "rotate",
        "color",
        "backgroundColor",
        "borderColor",
        "cornerRadius",
        "padding",
        "paddingTop",
        "paddingBottom",
        "paddingLeft",
        "paddingRight",
        "paddingHorizontal",
        "paddingVertical",
        "margin",
        "marginTop",
        "marginBottom",
        "marginLeft",
        "marginRight",
        "marginHorizontal",
        "marginVertical",
        "width",
        "height",
        "gap",
        "fontSize",
    ]

    private static let animatablePropSet: Set<String> = Set(animatableProps)

    public static func isAnimatable(prop: String) -> Bool {
        animatablePropSet.contains(prop)
    }
}

// MARK: - Vocabulary

public enum AnimCurve: String, Sendable, CaseIterable {
    case linear
    case easeIn
    case easeOut
    case easeInOut
    case spring
}

public enum AnimPreset: String, Sendable, CaseIterable {
    case fade
    case slide
    case scale
}

public enum AnimDirection: String, Sendable, CaseIterable {
    case top
    case bottom
    case leading
    case trailing
}

/// Iteration count for `.animate`: `loop` (forever) or a positive integer.
public enum AnimRepeat: Equatable, Sendable {
    case loop
    case count(Int)

    public var isLoop: Bool {
        if case .loop = self { return true }
        return false
    }
}

public enum AnimatePreset: String, Sendable, CaseIterable {
    case pulse
    case spin
    case shimmer
    case shake

    /// Per-preset normative defaults (`ANIMATE_PRESETS`,
    /// `core/animation.ts:433`). Only names + timing are shared across
    /// renderers; keyframe shapes are renderer-owned.
    public var defaults: (duration: Double, repeatCount: AnimRepeat, curve: AnimCurve) {
        switch self {
        case .pulse: return (1200, .loop, .easeInOut)
        case .spin: return (800, .loop, .linear)
        case .shimmer: return (1500, .loop, .linear)
        case .shake: return (400, .count(1), .easeInOut)
        }
    }
}

// MARK: - Timing

/// The duration/curve/delay core every channel spec shares. Durations are
/// milliseconds on the wire.
public struct AnimTiming: Equatable, Sendable {
    public let durationMs: Double
    public let curve: AnimCurve
    public let delayMs: Double

    public init(durationMs: Double, curve: AnimCurve, delayMs: Double = 0) {
        self.durationMs = durationMs
        self.curve = curve
        self.delayMs = delayMs
    }

    /// Wall-clock length of one playback, in seconds.
    public var totalSeconds: TimeInterval { (durationMs + delayMs) / 1000 }

    /// The timeout backbone every renderer finalizes on:
    /// `duration + delay + 80ms`.
    public var settleTimeoutSeconds: TimeInterval {
        (durationMs + delayMs + HypenAnim.settleGraceMs) / 1000
    }

    /// SwiftUI animation for this timing.
    ///
    /// Curves are the PINNED CSS beziers (`CURVE_BEZIER_POINTS`): the
    /// `linear`/`easeIn`/`easeOut`/`easeInOut` keywords are defined by the
    /// CSS Easing spec as the same conventional control points SwiftUI's
    /// named curves use, so the named curves are the faithful mapping.
    /// `spring` is NOT SwiftUI's physics spring — the wire contract is the
    /// fixed overshoot bezier `cubic-bezier(0.34, 1.56, 0.64, 1)`.
    public var animation: Animation {
        var base: Animation
        let seconds = durationMs / 1000
        switch curve {
        case .spring:
            base = .timingCurve(0.34, 1.56, 0.64, 1, duration: seconds)
        case .linear:
            base = .linear(duration: seconds)
        case .easeIn:
            base = .easeIn(duration: seconds)
        case .easeInOut:
            base = .easeInOut(duration: seconds)
        case .easeOut:
            base = .easeOut(duration: seconds)
        }
        if delayMs > 0 {
            base = base.delay(delayMs / 1000)
        }
        return base
    }
}

// MARK: - Channel specs

/// `__anim.transition` — implicit prop-change animation.
public struct AnimTransitionSpec: Equatable, Sendable {
    public let timing: AnimTiming
    /// Scoped, whitelist-filtered Hypen prop list. `nil` = every animatable
    /// prop transitions.
    public let props: [String]?
}

/// `__anim.enter` — played when the node is created-and-inserted.
public struct AnimEnterSpec: Equatable, Sendable {
    public let timing: AnimTiming
    public let presets: [AnimPreset]
    public let from: AnimDirection?
}

/// `__anim.exit` — played before the deferred remove finalizes.
public struct AnimExitSpec: Equatable, Sendable {
    public let timing: AnimTiming
    public let presets: [AnimPreset]
    public let to: AnimDirection?
}

/// `__anim.animate` — ambient preset timeline playback.
public struct AnimAnimateSpec: Equatable, Sendable {
    public let preset: AnimatePreset
    public let timing: AnimTiming
    public let repeatCount: AnimRepeat
}

/// All channels for one node, parsed from its props. A `nil` channel means
/// "absent or malformed" — either way the renderer snaps.
public struct NodeAnimSpecs: Equatable, Sendable {
    public var transition: AnimTransitionSpec?
    public var enter: AnimEnterSpec?
    public var exit: AnimExitSpec?
    public var animate: AnimAnimateSpec?
    /// `__anim.states` active pose label (`nil` = base pose). A label feed
    /// for completion timing, not a playback channel.
    public var statesLabel: String?
    /// `__anim.motion` `{essential: true}` — exempts this node from every
    /// reduced-motion shortcut.
    public var motionEssential: Bool

    public static let empty = NodeAnimSpecs(
        transition: nil, enter: nil, exit: nil, animate: nil,
        statesLabel: nil, motionEssential: false
    )

    /// True when the node carries any animation channel at all — the cheap
    /// gate the view layer uses to skip animation work entirely.
    public var isEmpty: Bool {
        transition == nil && enter == nil && exit == nil && animate == nil
            && statesLabel == nil && !motionEssential
    }
}

// MARK: - Defensive parsing

extension HypenAnim {

    /// A channel value normally arrives as a dictionary, but a stringified
    /// JSON object is tolerated for hosts that pass raw JSON through
    /// (`channelObject`, core/animation.ts:522).
    static func channelObject(_ value: Any?) -> [String: Any]? {
        guard let value = value else { return nil }
        if let dict = value as? [String: Any] { return dict }
        if let string = value as? String {
            guard let data = string.data(using: .utf8) else { return nil }
            let parsed = try? JSONSerialization.jsonObject(with: data)
            return parsed as? [String: Any]
        }
        return nil
    }

    /// A finite, non-negative number. Bools bridge to `NSNumber` on Apple
    /// platforms, so they are rejected explicitly.
    static func duration(_ value: Any?) -> Double? {
        if value is Bool { return nil }
        guard let number = value as? NSNumber else { return nil }
        let doubleValue = number.doubleValue
        guard doubleValue.isFinite, doubleValue >= 0 else { return nil }
        return doubleValue
    }

    static func curve(_ value: Any?) -> AnimCurve? {
        guard let raw = value as? String else { return nil }
        return AnimCurve(rawValue: raw)
    }

    static func direction(_ value: Any?) -> AnimDirection? {
        guard let raw = value as? String else { return nil }
        return AnimDirection(rawValue: raw)
    }

    /// The engine always emits duration + curve (defaults filled at
    /// lowering), so a missing or invalid one marks the whole channel
    /// malformed.
    static func timing(_ obj: [String: Any]) -> AnimTiming? {
        guard let durationMs = duration(obj["duration"]),
              let curveToken = curve(obj["curve"]) else { return nil }
        return AnimTiming(
            durationMs: durationMs,
            curve: curveToken,
            delayMs: duration(obj["delay"]) ?? 0
        )
    }

    /// Filter a presets array to the known vocabulary; a non-array, or
    /// nothing recognizable, voids the channel.
    static func presets(_ value: Any?) -> [AnimPreset]? {
        guard let array = value as? [Any] else { return nil }
        let parsed = array.compactMap { item -> AnimPreset? in
            guard let raw = item as? String else { return nil }
            return AnimPreset(rawValue: raw)
        }
        return parsed.isEmpty ? nil : parsed
    }

    public static func parseTransition(_ value: Any?) -> AnimTransitionSpec? {
        guard let obj = channelObject(value), let timing = timing(obj) else { return nil }
        guard let rawProps = obj["props"] else {
            return AnimTransitionSpec(timing: timing, props: nil)
        }
        guard let array = rawProps as? [Any] else { return nil }
        let scoped = array.compactMap { item -> String? in
            guard let name = item as? String, isAnimatable(prop: name) else { return nil }
            return name
        }
        // A scope that filters to nothing animates nothing — same as no channel.
        if scoped.isEmpty { return nil }
        return AnimTransitionSpec(timing: timing, props: scoped)
    }

    public static func parseEnter(_ value: Any?) -> AnimEnterSpec? {
        guard let obj = channelObject(value),
              let timing = timing(obj),
              let presets = presets(obj["presets"]) else { return nil }
        // An invalid direction is dropped, not channel-voiding — the
        // presets still play without an axis override.
        return AnimEnterSpec(timing: timing, presets: presets, from: direction(obj["from"]))
    }

    public static func parseExit(_ value: Any?) -> AnimExitSpec? {
        guard let obj = channelObject(value),
              let timing = timing(obj),
              let presets = presets(obj["presets"]) else { return nil }
        return AnimExitSpec(timing: timing, presets: presets, to: direction(obj["to"]))
    }

    public static func parseAnimate(_ value: Any?) -> AnimAnimateSpec? {
        guard let obj = channelObject(value),
              let rawPreset = obj["preset"] as? String,
              let preset = AnimatePreset(rawValue: rawPreset),
              let timing = timing(obj),
              let repeatCount = repeatValue(obj["repeat"]) else { return nil }
        return AnimAnimateSpec(preset: preset, timing: timing, repeatCount: repeatCount)
    }

    static func repeatValue(_ value: Any?) -> AnimRepeat? {
        if let raw = value as? String { return raw == "loop" ? .loop : nil }
        if value is Bool { return nil }
        guard let number = value as? NSNumber else { return nil }
        let doubleValue = number.doubleValue
        guard doubleValue.isFinite,
              doubleValue >= 1,
              doubleValue == doubleValue.rounded() else { return nil }
        return .count(Int(doubleValue))
    }

    /// Parse `__anim.states` to its active pose label.
    ///
    /// The engine emits the OBJECT form `{"label": "..."}`. A bare string
    /// is tolerated defensively (the desktop renderer shipped a real bug
    /// reading only the bare form); anything else degrades to `nil`, i.e.
    /// "no matched label" — the same as base-pose resolution.
    public static func parseStatesLabel(_ value: Any?) -> String? {
        if let obj = channelObject(value) {
            return obj["label"] as? String
        }
        if let raw = value as? String { return raw }
        return nil
    }

    /// Parse `__anim.motion` to its essential flag. Only `{essential: true}`
    /// opts a node out of reduced motion; anything else is `false`.
    public static func parseMotionEssential(_ value: Any?) -> Bool {
        guard let obj = channelObject(value) else { return false }
        return (obj["essential"] as? Bool) == true
    }

    /// Parse a node's whole `__anim.*` surface. Never throws; each channel
    /// degrades independently.
    public static func parseSpecs(_ props: [String: Any]) -> NodeAnimSpecs {
        NodeAnimSpecs(
            transition: parseTransition(props[transitionProp]),
            enter: parseEnter(props[enterProp]),
            exit: parseExit(props[exitProp]),
            animate: parseAnimate(props[animateProp]),
            statesLabel: parseStatesLabel(props[statesProp]),
            motionEssential: parseMotionEssential(props[motionProp])
        )
    }
}

// MARK: - Poses

/// The displaced pose an entering node starts from / an exiting node ends
/// at, expressed in the three channels SwiftUI can honestly animate on any
/// view: opacity, translation, and scale.
///
/// `nil` on an element means "base pose" (no displacement at all), which is
/// distinct from a pose whose fields happen to be neutral.
public struct HypenAnimPose: Equatable, Sendable {
    public var opacity: Double?
    public var offsetX: CGFloat
    public var offsetY: CGFloat
    public var scale: CGFloat?

    public init(
        opacity: Double? = nil,
        offsetX: CGFloat = 0,
        offsetY: CGFloat = 0,
        scale: CGFloat? = nil
    ) {
        self.opacity = opacity
        self.offsetX = offsetX
        self.offsetY = offsetY
        self.scale = scale
    }
}

extension HypenAnim {
    /// Combine composed presets into one hidden pose. `direction` is the
    /// spec's `from` (enter) / `to` (exit); an absent direction defaults to
    /// `leading`, and `leading`/`trailing` resolve against `rtl`.
    /// Transforms compose; only `fade` writes opacity.
    public static func hiddenPose(
        presets: [AnimPreset],
        direction: AnimDirection?,
        rtl: Bool = false
    ) -> HypenAnimPose {
        var pose = HypenAnimPose()
        for preset in presets {
            switch preset {
            case .fade:
                pose.opacity = 0
            case .slide:
                switch direction ?? .leading {
                case .top: pose.offsetY = -slideOffset
                case .bottom: pose.offsetY = slideOffset
                case .leading: pose.offsetX = rtl ? slideOffset : -slideOffset
                case .trailing: pose.offsetX = rtl ? -slideOffset : slideOffset
                }
            case .scale:
                pose.scale = scaleHiddenFactor
            }
        }
        return pose
    }
}

// MARK: - Animatable prop snapshot

/// An `Equatable` snapshot of an element's whitelisted (and, when the
/// node's `.transition` spec is scoped, filtered) prop values — the `value:`
/// key of the per-element implicit `.animation(_:value:)`.
///
/// Props arrive flattened with a `.0` suffix (`opacity.0`), with the bare
/// name tolerated as a fallback.
public struct HypenAnimSnapshot: Equatable, Sendable {
    let key: String

    public static let empty = HypenAnimSnapshot(key: "")

    static func build(props: [String: Any], scope: [String]?) -> HypenAnimSnapshot {
        var out = ""
        for name in scope ?? HypenAnim.animatableProps {
            let value = props["\(name).0"] ?? props[name]
            out += name
            out += "="
            if let value = value {
                out += String(describing: value)
            }
            out += ";"
        }
        return HypenAnimSnapshot(key: out)
    }
}
