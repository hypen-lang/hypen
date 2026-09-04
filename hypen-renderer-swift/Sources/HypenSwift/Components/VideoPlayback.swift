import Foundation

// ============================================================================
// Video v2 — pure playback logic
// ============================================================================
//
// Everything in this file is deliberately free of AVFoundation, SwiftUI and
// MainActor isolation: the state machine, the queue/end decision, the bind
// report throttle, the inbound-write (seek epsilon / echo) rules, the slot
// visibility table and the Scrubber math are all value types that can be
// unit-tested without a player, a window or a run loop.
// `MediaComponents.swift` / `ScrubberComponent.swift` are the thin AVPlayer +
// SwiftUI shells that feed them.
//
// Contract: `hypen-docs/content/docs/guide/components.mdx`
//           §"Playback control & composition slots (draft spec — v2)".
// Shared vocabulary + constants: `hypen-web/packages/core/src/types.ts`
//           (VideoPlayerState, PlaybackBinding, VIDEO_SLOTS,
//            VIDEO_SLOT_VISIBILITY, PLAYBACK_REPORT_INTERVAL_MS,
//            PLAYBACK_SEEK_EPSILON_S).

// MARK: - Constants

/// The normative v2 constants, mirrored from
/// `hypen-web/packages/core/src/types.ts` (bottom of file). Keep the two in
/// sync — they are the same contract expressed twice.
enum VideoPlaybackConstants {
    /// Renderer → state `position` reports are throttled to this interval
    /// while playing; transitions (play/pause/seek/track change/ended/error)
    /// always report immediately.
    /// `PLAYBACK_REPORT_INTERVAL_MS = 250`.
    static let reportInterval: TimeInterval = 0.25

    /// A `position` write only seeks when it differs from the renderer's
    /// actual position by more than this — the echo guard that keeps the
    /// renderer's own progress reports from being re-applied as seeks.
    /// `PLAYBACK_SEEK_EPSILON_S = 1`.
    static let seekEpsilon: Double = 1.0

    /// How close to `duration` counts as "the item ran out".
    ///
    /// AVFoundation delivers the end of an item through two independent
    /// channels — `timeControlStatus` flipping to `.paused` and the
    /// `AVPlayerItemDidPlayToEndTime` notification — with no ordering
    /// guarantee. When the status arrives first, this tolerance is what
    /// tells "the item ended" apart from "the viewer paused", so the ended
    /// transition never emits a spurious `onPause`.
    static let endOfItemTolerance: Double = 0.5

    /// Values closer than this are treated as unchanged by the reporter.
    static let valueEpsilon: Double = 0.001

    /// VoiceOver adjustable step for `Scrubber`, in seconds.
    static let accessibilitySeekStep: Double = 5.0
}

// MARK: - Player state

/// The normative per-node player state. Slots key off it and the `playback`
/// bind struct reports it verbatim, so the raw values are contract
/// vocabulary — they must stay identical to the `VideoPlayerState` union in
/// `@hypen-space/core`.
public enum VideoPlayerState: String, CaseIterable, Sendable {
    /// No src/playlist resolved, or preload hasn't begun. Poster shows.
    case idle
    /// A source is resolving/buffering and playback has not begun, OR
    /// playback stalled rebuffering.
    case loading
    case playing
    case paused
    /// Final track finished, no wrap.
    case ended
    /// Sticky failure state (see the `onError` section of the contract).
    case error
}

/// Platform-independent mirror of `AVPlayer.TimeControlStatus`, so the state
/// mapping is testable without AVFoundation.
enum VideoTimeControl: Equatable, Sendable {
    case paused
    /// `.waitingToPlayAtSpecifiedRate` — buffering or rebuffering.
    case waitingToPlay
    case playing
}

/// What happens after the current item plays to its end.
enum VideoEndContinuation: Equatable, Sendable {
    /// Nothing follows: the queue is done (`ended`).
    case stop
    /// Another track is being loaded (`loading`).
    case nextTrack
    /// Single-src silent loop: seek 0 + play, no reload, no event.
    case restartInPlace
}

/// Inputs the state machine understands.
enum VideoPlayerEvent: Equatable, Sendable {
    /// No src/playlist configured (or the player was torn down).
    case sourceCleared
    /// A track was handed to the player. `playWhenReady` is the autoplay /
    /// queue-advance intent.
    case trackLoadStarted(playWhenReady: Bool)
    /// The player's time-control status changed. `atEnd` is true when the
    /// current item's playhead has reached its duration (see
    /// `endOfItemTolerance`).
    case timeControlChanged(VideoTimeControl, atEnd: Bool)
    /// Playback was requested locally (autoplay, a `playing: true` write, a
    /// tap on the surface).
    case playRequested
    /// A pause was requested locally (a `playing: false` write). Distinct
    /// from the `.paused` status it causes: an explicit request lands even
    /// during pre-roll, where a bare `.paused` status is only a transient —
    /// it cancels the play intent, and (since `paused` requires playback to
    /// have begun) a track that never played returns to `idle`.
    case pauseRequested
    /// `AVPlayerItemDidPlayToEndTime` for the live item.
    case playedToEnd(continuation: VideoEndContinuation)
    /// The current item failed to load or decode.
    case itemFailed
}

/// The result of feeding one event to the machine.
struct VideoPlayerTransition: Equatable, Sendable {
    let previousState: VideoPlayerState
    let state: VideoPlayerState
    /// The contract `onPlay` event should be dispatched.
    let dispatchPlay: Bool
    /// The contract `onPause` event should be dispatched.
    let dispatchPause: Bool

    var changed: Bool { previousState != state }
}

/// Derives the normative player state from raw player signals, and decides
/// which of `onPlay` / `onPause` a signal is worth.
///
/// Two rules carry the weight here, and both replace the shipped
/// "`.paused` → always dispatch `onPause`" behaviour (a known spurious-pause
/// bug):
///
/// 1. **Rebuffering is `loading`, not a pause.** A stall surfaces as
///    `.waitingToPlayAtSpecifiedRate`, which re-enters `loading` and emits
///    nothing — `intendsToPlay` stays true so the bind struct doesn't
///    flicker `playing: false` either.
/// 2. **Pausing at the end of an item is part of the ended transition.**
///    Whichever of the two end signals lands first, the machine goes to
///    `ended` and emits no `onPause`.
struct VideoPlayerStateMachine: Equatable, Sendable {
    private(set) var state: VideoPlayerState = .idle

    /// Mirrors the shipped `reportedPlaying` dedupe: `onPlay` fires on the
    /// leading edge of playback only, and `onPause` only after a reported
    /// play.
    private(set) var reportedPlaying = false

    /// Play *intent* — true while the player is trying to play, including
    /// while it rebuffers. This is what the bind struct reports as
    /// `playing`, so a rebuffer never reads as a pause.
    private(set) var intendsToPlay = false

    /// Whether the player ever reached `.playing`. Drives the built-in
    /// (slot-less) poster, which keeps its shipped "hide after the first
    /// frame" behaviour.
    private(set) var hasEverPlayed = false

    /// Whether the CURRENT track ever reached `.playing`. `paused` requires
    /// playback to have begun (spec), so this is what tells a pre-roll
    /// cancel (back to `idle`) apart from a pause landing between frames
    /// mid-track (a real `paused`). Reset on every track load.
    private(set) var hasPlayedCurrentTrack = false

    /// The last time-control status the machine saw, reset on every track
    /// load. This is what tells a genuine mid-buffer pause apart from the
    /// pre-roll transient: the player idles at `.paused` between
    /// `replaceCurrentItem` and the first frame (transient — no prior
    /// status, or a prior `.paused`), whereas a `.paused` arriving after
    /// `.waitingToPlay` means someone set the rate to 0 while the player
    /// was actively trying to play — the native chrome's pause button
    /// during initial buffering, which must be honored.
    private(set) var lastTimeControl: VideoTimeControl?

    init() {}

    mutating func handle(_ event: VideoPlayerEvent) -> VideoPlayerTransition {
        let previous = state
        var dispatchPlay = false
        var dispatchPause = false

        switch event {
        case .sourceCleared:
            state = .idle
            reportedPlaying = false
            intendsToPlay = false
            hasPlayedCurrentTrack = false
            lastTimeControl = nil

        case .trackLoadStarted(let playWhenReady):
            // A fresh item clears a sticky error and re-arms the onPlay
            // edge, so every queue track reports its own play.
            reportedPlaying = false
            intendsToPlay = playWhenReady
            hasPlayedCurrentTrack = false
            lastTimeControl = nil
            state = playWhenReady ? .loading : .idle

        case .playRequested:
            // A failed item can't be played back into life; only a reload
            // (trackLoadStarted) clears `error`.
            if state == .error { break }
            intendsToPlay = true
            if state == .paused {
                // Direct `paused → playing` edge (spec: `loading` covers
                // pre-begin and rebuffer only — a resume from a buffered
                // frame is neither). Playback already began, so report the
                // resume immediately, exactly like the DOM's `play` event
                // firing on `el.play()`; the `.playing` status that follows
                // lands on an already-playing machine and dispatches
                // nothing. Should the resume genuinely need to rebuffer,
                // the `.waitingToPlay` status re-enters `loading` silently,
                // as any rebuffer does.
                state = .playing
                if !reportedPlaying {
                    reportedPlaying = true
                    dispatchPlay = true
                }
            } else if state != .playing {
                state = .loading
            }

        case .pauseRequested:
            // Nothing to pause in these three, and `ended`/`error` are
            // terminal until something else moves the player.
            if state == .error || state == .ended || state == .idle { break }
            intendsToPlay = false
            if reportedPlaying {
                reportedPlaying = false
                dispatchPause = true
                // The `.paused` status this causes then lands on an already
                // paused machine and dispatches nothing — no double
                // `onPause`.
                state = .paused
                break
            }
            if state == .loading {
                if hasPlayedCurrentTrack {
                    // Between frames mid-track: playback has begun, so
                    // `paused` is reachable. Silent — no onPlay was
                    // reported for this stretch, so there is no reported
                    // play to pause.
                    state = .paused
                } else {
                    // Pre-roll cancel: playback never began, and `paused`
                    // requires playback to have begun (spec). Back to
                    // `idle`, where the poster and the controls slot show.
                    state = .idle
                }
            }
            // Already `.paused`: stays paused, nothing to dispatch.

        case .timeControlChanged(let control, let atEnd):
            let previousControl = lastTimeControl
            lastTimeControl = control
            switch control {
            case .playing:
                // Reaching `.playing` also recovers from a stale error.
                state = .playing
                intendsToPlay = true
                hasEverPlayed = true
                hasPlayedCurrentTrack = true
                if !reportedPlaying {
                    reportedPlaying = true
                    dispatchPlay = true
                }

            case .waitingToPlay:
                // Buffering / rebuffering — `loading`, never a pause.
                intendsToPlay = true
                if state != .error { state = .loading }

            case .paused:
                if state == .error { break }
                if state == .ended {
                    // Already ended: the player settling is not a pause.
                    intendsToPlay = false
                    break
                }
                if atEnd {
                    // The playhead ran out: this `.paused` is the first half
                    // of the ended transition. `reportedPlaying` is left
                    // alone so a single-src silent loop doesn't re-emit
                    // `onPlay` on the next lap; `playedToEnd` clears it for
                    // the cases that should.
                    intendsToPlay = false
                    state = .ended
                    break
                }
                if state == .idle { break }
                if reportedPlaying {
                    reportedPlaying = false
                    intendsToPlay = false
                    state = .paused
                    dispatchPause = true
                    break
                }
                if state == .loading {
                    if previousControl == .waitingToPlay {
                        // The player was actively waiting to play and the
                        // rate went to 0 anyway: someone paused it — the
                        // native chrome's pause button during initial
                        // buffering (or a system interruption). Honor it:
                        // the play intent is cancelled. Playback never
                        // began → `idle` (spec: `paused` requires playback
                        // to have begun); between frames mid-track → a
                        // real `paused`. Silent either way — no onPlay was
                        // reported, so there is no pause to report.
                        intendsToPlay = false
                        state = hasPlayedCurrentTrack ? .paused : .idle
                    }
                    // Otherwise: a pre-roll / inter-track transient — the
                    // player idles at `.paused` between `replaceCurrentItem`
                    // and the first frame. Never a user pause, so `loading`
                    // survives.
                    break
                }
                intendsToPlay = false
                state = .paused
            }

        case .playedToEnd(let continuation):
            switch continuation {
            case .stop:
                reportedPlaying = false
                intendsToPlay = false
                state = .ended
            case .nextTrack:
                // The next track reports its own `onPlay`.
                reportedPlaying = false
                intendsToPlay = true
                state = .loading
            case .restartInPlace:
                // Native-style silent loop: no `onEnded`, and no `onPlay`
                // per lap either (matches the DOM's `el.loop`), so the
                // reported-play edge is deliberately kept.
                intendsToPlay = true
                if state != .playing { state = .loading }
            }

        case .itemFailed:
            reportedPlaying = false
            intendsToPlay = false
            state = .error
        }

        return VideoPlayerTransition(
            previousState: previous,
            state: state,
            dispatchPlay: dispatchPlay,
            dispatchPause: dispatchPause
        )
    }
}

// MARK: - Queue / end-of-track decision

/// What a track ending means for the queue: whether `onEnded` fires, what
/// its `completed` flag is, and what plays next.
struct VideoEndOutcome: Equatable, Sendable {
    /// Dispatch the contract `onEnded` event.
    let dispatchEnded: Bool
    /// The `completed` field of that event — "the whole queue is done".
    let completed: Bool
    /// Index of the track to load next (playlist advance or wrap).
    let nextIndex: Int?
    let continuation: VideoEndContinuation
}

/// The resolved play queue of one Video node.
struct VideoQueue: Equatable, Sendable {
    let sourceCount: Int
    /// A non-empty `playlist` prop supersedes `src`.
    let isPlaylist: Bool
    let loop: Bool

    init(sourceCount: Int, isPlaylist: Bool, loop: Bool) {
        self.sourceCount = max(sourceCount, 0)
        self.isPlaylist = isPlaylist
        self.loop = loop
    }

    /// Cross-platform end-of-track semantics (DOM `handleEnded`, Android,
    /// desktop `pump_media_events` all agree):
    ///
    /// - Playlist: `completed = isLast && !loop` — a wrap means the queue is
    ///   *not* done, so `completed` is false on the lap boundary.
    /// - Single src without `loop`: one `onEnded { completed: true }`.
    /// - Single src with `loop`: a silent native-style loop — seek 0 + play,
    ///   **no** `onEnded` per lap (the DOM sets `el.loop`, which swallows
    ///   the `ended` event entirely).
    func outcome(at index: Int) -> VideoEndOutcome {
        if isPlaylist {
            let isLast = index >= sourceCount - 1
            let next: Int?
            if !isLast {
                next = index + 1
            } else if loop && sourceCount > 0 {
                next = 0
            } else {
                next = nil
            }
            return VideoEndOutcome(
                dispatchEnded: true,
                completed: isLast && !loop,
                nextIndex: next,
                continuation: next == nil ? .stop : .nextTrack
            )
        }

        if loop {
            return VideoEndOutcome(
                dispatchEnded: false,
                completed: false,
                nextIndex: nil,
                continuation: .restartInPlace
            )
        }

        return VideoEndOutcome(
            dispatchEnded: true,
            completed: true,
            nextIndex: nil,
            continuation: .stop
        )
    }
}

// MARK: - Playback bind: renderer → state

/// The renderer's view of the `PlaybackBinding` struct
/// (`{ playing, position, duration, state }`).
struct PlaybackSnapshot: Equatable, Sendable {
    var playing: Bool
    var position: Double
    var duration: Double
    var state: VideoPlayerState
}

/// A single `__hypen_bind` value. Modelled as an enum so writes are
/// `Equatable` (and therefore assertable) before they become `Any`.
enum PlaybackValue: Equatable, Sendable {
    case bool(Bool)
    case number(Double)
    case string(String)

    var anyValue: Any {
        switch self {
        case .bool(let value): return value
        case .number(let value): return value
        case .string(let value): return value
        }
    }
}

/// One `dispatch("__hypen_bind", ["path": …, "value": …])` write.
struct PlaybackWrite: Equatable, Sendable {
    let path: String
    let value: PlaybackValue

    var payload: [String: Any] {
        ["path": path, "value": value.anyValue]
    }
}

/// Turns playback snapshots into throttled, de-duplicated per-key bind
/// writes — one `__hypen_bind` per changed key, under `<bindPath>.<key>`.
///
/// The reporter also remembers what it last wrote: `lastReportedPosition` is
/// the renderer-side half of the echo guard (`PlaybackCommandResolver`
/// ignores an inbound `position` that is exactly the value it just
/// reported).
struct PlaybackBindReporter: Equatable, Sendable {
    /// The bound state path, e.g. `"playback"` from `.bind(@state.playback)`.
    let path: String

    private var reportedPlaying: Bool?
    private var reportedPosition: Double?
    private var reportedDuration: Double?
    private var reportedState: VideoPlayerState?
    private var lastPositionReportAt: TimeInterval?

    init(path: String) {
        self.path = path
    }

    /// The last `position` handed to the module, or nil if none was.
    var lastReportedPosition: Double? { reportedPosition }

    /// The writes this observation is worth.
    ///
    /// - `playing` / `state` / `duration` are reported immediately on every
    ///   change (spec: "update immediately on transition").
    /// - `position` is reported immediately when `immediate` is set (a
    ///   transition: play, pause, seek completion, track change, ended,
    ///   error) and otherwise at most once per `reportInterval` (250 ms).
    mutating func writes(
        for snapshot: PlaybackSnapshot,
        now: TimeInterval,
        immediate: Bool
    ) -> [PlaybackWrite] {
        var out: [PlaybackWrite] = []

        if reportedPlaying != snapshot.playing {
            reportedPlaying = snapshot.playing
            out.append(PlaybackWrite(path: "\(path).playing", value: .bool(snapshot.playing)))
        }

        if reportedState != snapshot.state {
            reportedState = snapshot.state
            out.append(PlaybackWrite(path: "\(path).state", value: .string(snapshot.state.rawValue)))
        }

        let duration = PlaybackBindReporter.sanitize(snapshot.duration)
        if !PlaybackBindReporter.isSame(reportedDuration, duration) {
            reportedDuration = duration
            out.append(PlaybackWrite(path: "\(path).duration", value: .number(duration)))
        }

        let position = PlaybackBindReporter.sanitize(snapshot.position)
        let positionChanged = !PlaybackBindReporter.isSame(reportedPosition, position)
        let due = lastPositionReportAt.map { now - $0 >= VideoPlaybackConstants.reportInterval } ?? true
        if positionChanged && (immediate || due) {
            reportedPosition = position
            lastPositionReportAt = now
            out.append(PlaybackWrite(path: "\(path).position", value: .number(position)))
        }

        return out
    }

    private static func isSame(_ lhs: Double?, _ rhs: Double) -> Bool {
        guard let lhs = lhs else { return false }
        return abs(lhs - rhs) <= VideoPlaybackConstants.valueEpsilon
    }

    /// Non-finite seconds (an unknown `duration` on a live stream, a NaN
    /// playhead before the first frame) report as 0 — the contract's
    /// "0 until known".
    private static func sanitize(_ seconds: Double) -> Double {
        guard seconds.isFinite, seconds > 0 else { return 0 }
        return seconds
    }
}

// MARK: - Playback bind: state → renderer

/// The writable half of the bound struct as it arrives on the `playback`
/// prop (plus the one-way `playing:` prop subset). `duration` and `state`
/// are renderer-owned and deliberately never parsed.
struct VideoPlaybackInput: Equatable, Sendable {
    var playing: Bool?
    var position: Double?

    var isEmpty: Bool { playing == nil && position == nil }

    init(playing: Bool? = nil, position: Double? = nil) {
        self.playing = playing
        self.position = position
    }

    /// Parse the `playback` prop (a JSON object) with the one-way
    /// `playing:` prop as a fallback for the controlled subset.
    static func from(playbackProp: Any?, playingProp: Bool?) -> VideoPlaybackInput {
        guard let dict = playbackProp as? [String: Any] else {
            return VideoPlaybackInput(playing: playingProp, position: nil)
        }
        return VideoPlaybackInput(
            playing: boolValue(dict["playing"]) ?? playingProp,
            position: doubleValue(dict["position"])
        )
    }

    private static func boolValue(_ value: Any?) -> Bool? {
        if let bool = value as? Bool { return bool }
        if let int = value as? Int { return int != 0 }
        if let string = value as? String {
            return string == "true" || string == "1"
        }
        return nil
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        if let double = value as? Double { return double }
        if let int = value as? Int { return Double(int) }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

/// A write the renderer must perform on the player.
enum PlaybackCommand: Equatable, Sendable {
    case play
    case pause
    /// `playing: true` written while `ended` — seek to 0, then play.
    case restart
    case seek(Double)
}

/// The normative write semantics of the playback bind (state → renderer).
enum PlaybackCommandResolver {
    /// Resolve an inbound `playback` write against the renderer's actual
    /// state.
    ///
    /// - `position` is clamped to `[0, duration]` and applied **only** when
    ///   it differs from the actual playhead by more than
    ///   `seekEpsilon` (1 s), and is ignored outright when it is exactly the
    ///   value the renderer last reported (that write is the renderer's own
    ///   progress echoing back through module state).
    /// - `playing` is derived against the *actual* transport state, which
    ///   makes it inherently echo-proof: re-writing what the renderer just
    ///   reported resolves to no command at all.
    /// - `duration` / `state` writes are ignored (they never reach here).
    ///
    /// A seek is emitted before the play/pause command, so
    /// `{playing: true, position: n}` out of `ended` seeks to `n` and plays
    /// from there rather than restarting at 0.
    ///
    /// `isInitial` marks the first application at mount, where a module's
    /// freshly initialized struct reads `playing: false` before anything
    /// has happened — indistinguishable from "unset", and honouring it
    /// would cancel `autoplay` on every bound player. The first pass
    /// therefore carries only positive intent (a `true` starts playback, a
    /// `position` seeks); every later write is authoritative both ways.
    static func commands(
        input: VideoPlaybackInput,
        current: PlaybackSnapshot,
        lastReportedPosition: Double?,
        isInitial: Bool = false
    ) -> [PlaybackCommand] {
        var out: [PlaybackCommand] = []

        if let requested = input.position, requested.isFinite {
            let isEcho = lastReportedPosition.map {
                abs($0 - requested) <= VideoPlaybackConstants.valueEpsilon
            } ?? false
            if !isEcho {
                let clamped = clamp(requested, duration: current.duration)
                if abs(clamped - current.position) > VideoPlaybackConstants.seekEpsilon {
                    out.append(.seek(clamped))
                }
            }
        }

        if let wantsPlaying = input.playing {
            let seeking = out.contains { command in
                if case .seek = command { return true }
                return false
            }
            if wantsPlaying {
                if current.state == .ended && !seeking {
                    out.append(.restart)
                } else if !current.playing {
                    out.append(.play)
                }
            } else if current.playing && !isInitial {
                out.append(.pause)
            }
        }

        return out
    }

    /// Clamp to `[0, duration]`; an unknown duration (0) only clamps below.
    static func clamp(_ seconds: Double, duration: Double) -> Double {
        guard seconds.isFinite else { return 0 }
        let lower = max(seconds, 0)
        guard duration.isFinite, duration > 0 else { return lower }
        return min(lower, duration)
    }
}

// MARK: - Composition slots

/// Children tagged `.slot(name)` compose into the player chrome. Mirrors
/// `VIDEO_SLOTS` in `@hypen-space/core`.
public enum VideoSlot: String, CaseIterable, Sendable {
    case controls
    case loading
    case error
    case poster

    /// Back-to-front painting order, normative per the spec: slots paint
    /// bottom-to-top as `poster → loading → controls → error`. The poster
    /// is a backdrop, the spinner sits on it (`loading` shows both), the
    /// transport chrome sits above the poster (`idle`/`ended` show poster +
    /// controls), and the error surface is topmost. `error` and `controls`
    /// are never co-visible, but the stacking is contract vocabulary and
    /// must match the other renderers exactly.
    static let paintOrder: [VideoSlot] = [.poster, .loading, .controls, .error]

    /// The slot a child element declares, from the `.slot("name")`
    /// applicator's lowered `slot.0` prop.
    static func named(_ raw: String?) -> VideoSlot? {
        guard let raw = raw else { return nil }
        return VideoSlot(rawValue: raw)
    }
}

/// The normative slot-visibility table. Mirrors `VIDEO_SLOT_VISIBILITY` in
/// `@hypen-space/core`; renderers MUST match it exactly.
///
/// `controls` is visible in `idle` so a custom controls slot can start first
/// play (play-button-over-poster) — without this, playback would only be
/// reachable via autoplay or module code.
///
/// | Slot     | idle | loading | playing | paused | ended | error |
/// |----------|------|---------|---------|--------|-------|-------|
/// | poster   |  ✅  |   ✅    |    —    |   —    |  ✅   |   —   |
/// | loading  |  —   |   ✅    |    —    |   —    |   —   |   —   |
/// | controls |  ✅  |   —     |   ✅    |  ✅    |  ✅   |   —   |
/// | error    |  —   |   —     |    —    |   —    |   —   |  ✅   |
enum VideoSlotVisibility {
    static func isVisible(_ slot: VideoSlot, in state: VideoPlayerState) -> Bool {
        switch slot {
        case .poster:
            switch state {
            case .idle, .loading, .ended: return true
            case .playing, .paused, .error: return false
            }
        case .loading:
            return state == .loading
        case .controls:
            // Visible in every state but error: idle enables first play,
            // loading keeps a buffering stream's transport reachable.
            return state != .error
        case .error:
            return state == .error
        }
    }
}

// MARK: - Scrubber

/// Timeline geometry, formatting and commit routing for `Scrubber`.
enum ScrubberMath {
    /// Progress in `[0, 1]` for a playhead, 0 while the duration is unknown.
    static func fraction(position: Double, duration: Double) -> Double {
        guard duration.isFinite, duration > 0, position.isFinite else { return 0 }
        return min(max(position / duration, 0), 1)
    }

    /// Progress in `[0, 1]` for a touch at `x` across a track of `width`.
    static func fraction(forX x: Double, width: Double) -> Double {
        guard width > 0, x.isFinite else { return 0 }
        return min(max(x / width, 0), 1)
    }

    /// The playhead a progress fraction commits to.
    static func position(forFraction fraction: Double, duration: Double) -> Double {
        guard duration.isFinite, duration > 0, fraction.isFinite else { return 0 }
        return min(max(fraction, 0), 1) * duration
    }

    /// A VoiceOver ±5 s adjustment, clamped to the timeline.
    static func adjusted(
        position: Double,
        duration: Double,
        by delta: Double
    ) -> Double {
        PlaybackCommandResolver.clamp(position + delta, duration: duration)
    }

    /// `"1:05 of 3:20"` — elapsed of total, the value text an adjustable
    /// slider reads out. An unknown duration degrades to the elapsed time.
    static func accessibilityValue(position: Double, duration: Double) -> String {
        let elapsed = timeLabel(position)
        guard duration.isFinite, duration > 0 else { return elapsed }
        return "\(elapsed) of \(timeLabel(duration))"
    }

    /// `m:ss`, or `h:mm:ss` past an hour.
    static func timeLabel(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0:00" }
        let total = Int(seconds.rounded(.down))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, secs)
        }
        return String(format: "%d:%02d", minutes, secs)
    }
}

/// Where a released scrub commits.
enum ScrubberCommitPlan: Equatable, Sendable {
    /// No own bind, but the enclosing Video binds a playback struct — its
    /// own seek reports `position` through that bind, so the Scrubber adds
    /// nothing.
    case enclosingBind
    /// The Scrubber itself was `.bind(...)`-ed: write `<path>.position`
    /// directly. Its own bind wins over the enclosing Video's.
    case ownBind(path: String)
    /// Bind-less: dispatch `onSeek` with `{type: "seek", position}`.
    case seekAction
    /// Nothing to commit to — the local seek still happens, it just isn't
    /// reported anywhere.
    case localOnly
}

enum ScrubberCommit {
    /// Commit resolution, normative per the spec: the Scrubber's OWN
    /// `.bind(...)` wins, else the enclosing Video's bind, else the
    /// Scrubber's `onSeek` action. The local seek applies in every case,
    /// so the playhead moves even with no wire commit.
    static func plan(
        enclosingBindPath: String?,
        ownBindPath: String?,
        hasOnSeek: Bool
    ) -> ScrubberCommitPlan {
        if let own = ownBindPath, !own.isEmpty {
            return .ownBind(path: own)
        }
        if let enclosing = enclosingBindPath, !enclosing.isEmpty {
            return .enclosingBind
        }
        return hasOnSeek ? .seekAction : .localOnly
    }
}
