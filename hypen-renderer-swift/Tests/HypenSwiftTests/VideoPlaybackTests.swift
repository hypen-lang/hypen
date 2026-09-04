import XCTest
@testable import HypenSwift

/// Video v2 — the pure playback logic behind `VideoComponent` / `Scrubber`.
///
/// Contract: `hypen-docs/content/docs/guide/components.mdx`
/// §"Playback control & composition slots (draft spec — v2)"; shared
/// constants and the slot table live in
/// `hypen-web/packages/core/src/types.ts`.
///
/// Everything asserted here is renderer-independent by construction: the
/// AVPlayer/SwiftUI shell only feeds these types and applies their output.

// MARK: - State machine

final class VideoPlayerStateMachineTests: XCTestCase {

    /// Run a script of events and hand back the machine plus every
    /// transition it produced.
    private func run(
        _ events: [VideoPlayerEvent],
        from machine: VideoPlayerStateMachine = VideoPlayerStateMachine()
    ) -> (machine: VideoPlayerStateMachine, transitions: [VideoPlayerTransition]) {
        var machine = machine
        var transitions: [VideoPlayerTransition] = []
        for event in events {
            transitions.append(machine.handle(event))
        }
        return (machine, transitions)
    }

    func testStartsIdle() {
        XCTAssertEqual(VideoPlayerStateMachine().state, .idle)
        XCTAssertFalse(VideoPlayerStateMachine().intendsToPlay)
    }

    /// The normative time-control mapping:
    /// `.waitingToPlayAtSpecifiedRate` → loading, `.playing` → playing,
    /// `.paused` → paused.
    func testTimeControlMappingTable() {
        let cases: [(VideoTimeControl, VideoPlayerState)] = [
            (.waitingToPlay, .loading),
            (.playing, .playing),
            (.paused, .paused),
        ]
        for (control, expected) in cases {
            // Start from a playing player so `.paused` is a real pause and
            // not a pre-roll transient.
            let result = run([
                .trackLoadStarted(playWhenReady: true),
                .timeControlChanged(.playing, atEnd: false),
                .timeControlChanged(control, atEnd: false),
            ])
            XCTAssertEqual(result.machine.state, expected, "\(control) must map to \(expected)")
        }
    }

    func testAutoplayLoadsIntoLoadingAndPlainLoadStaysIdle() {
        XCTAssertEqual(run([.trackLoadStarted(playWhenReady: true)]).machine.state, .loading)
        XCTAssertEqual(run([.trackLoadStarted(playWhenReady: false)]).machine.state, .idle)
    }

    /// A non-autoplay player sits at `.paused` from the moment it is
    /// created. That is `idle` (poster shows), not `paused`, and it must not
    /// dispatch anything.
    func testPausedWhileIdleStaysIdleAndIsSilent() {
        let result = run([
            .trackLoadStarted(playWhenReady: false),
            .timeControlChanged(.paused, atEnd: false),
        ])
        XCTAssertEqual(result.machine.state, .idle)
        XCTAssertFalse(result.transitions.contains { $0.dispatchPause })
    }

    func testOnPlayFiresOnceOnTheLeadingEdge() {
        let result = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .timeControlChanged(.playing, atEnd: false),
        ])
        XCTAssertEqual(result.transitions.filter { $0.dispatchPlay }.count, 1)
    }

    func testPauseThenResumeDispatchesBothEdges() {
        let result = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .timeControlChanged(.paused, atEnd: false),
            .timeControlChanged(.playing, atEnd: false),
        ])
        XCTAssertEqual(result.transitions.filter { $0.dispatchPause }.count, 1)
        XCTAssertEqual(result.transitions.filter { $0.dispatchPlay }.count, 2)
        XCTAssertEqual(result.machine.state, .playing)
    }

    /// Rebuffering re-enters `loading` and emits NOTHING — no `onPause` on
    /// the way in, no second `onPlay` on the way out. `playing` stays true
    /// in the bind struct throughout.
    func testRebufferIsLoadingAndSilent() {
        let result = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .timeControlChanged(.waitingToPlay, atEnd: false),
        ])
        XCTAssertEqual(result.machine.state, .loading)
        XCTAssertTrue(result.machine.intendsToPlay, "a rebuffer must not read as a pause")
        XCTAssertFalse(result.transitions.contains { $0.dispatchPause })

        let resumed = run([.timeControlChanged(.playing, atEnd: false)], from: result.machine)
        XCTAssertEqual(resumed.machine.state, .playing)
        XCTAssertFalse(
            resumed.transitions.contains { $0.dispatchPlay },
            "resuming from a rebuffer is not a new play"
        )
    }

    /// The spurious-pause bug the v2 machine subsumes: the player pausing
    /// *at the end of the item* is the first half of the ended transition,
    /// whichever end signal lands first.
    func testPausedAtEndIsEndedNotAPause() {
        let result = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .timeControlChanged(.paused, atEnd: true),
        ])
        XCTAssertEqual(result.machine.state, .ended)
        XCTAssertFalse(result.transitions.contains { $0.dispatchPause })
        XCTAssertFalse(result.machine.intendsToPlay)
    }

    /// …and when the notification wins the race instead, the trailing
    /// `.paused` is swallowed too.
    func testPauseAfterEndedIsSwallowed() {
        let result = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .playedToEnd(continuation: .stop),
            .timeControlChanged(.paused, atEnd: false),
        ])
        XCTAssertEqual(result.machine.state, .ended)
        XCTAssertFalse(result.transitions.contains { $0.dispatchPause })
    }

    /// An inter-track `.paused` transient (between `replaceCurrentItem` and
    /// the first frame) is not a pause either.
    func testPausedDuringLoadingIsSwallowed() {
        let result = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.paused, atEnd: false),
        ])
        XCTAssertEqual(result.machine.state, .loading)
        XCTAssertFalse(result.transitions.contains { $0.dispatchPause })
    }

    func testPlaylistAdvanceRearmsTheOnPlayEdge() {
        var machine = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .playedToEnd(continuation: .nextTrack),
        ]).machine
        XCTAssertEqual(machine.state, .loading)

        let next = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
        ], from: machine)
        XCTAssertTrue(
            next.transitions.contains { $0.dispatchPlay },
            "each queue track reports its own onPlay"
        )
        machine = next.machine
        XCTAssertEqual(machine.state, .playing)
    }

    /// A silent single-src loop must not re-announce itself every lap —
    /// no `onEnded` (see `VideoQueueTests`) and no `onPlay` either.
    func testSilentLoopDoesNotReAnnouncePlay() {
        let lap = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .timeControlChanged(.paused, atEnd: true),
            .playedToEnd(continuation: .restartInPlace),
            .timeControlChanged(.playing, atEnd: false),
        ])
        XCTAssertEqual(lap.machine.state, .playing)
        XCTAssertEqual(
            lap.transitions.filter { $0.dispatchPlay }.count, 1,
            "the loop lap is silent: one onPlay for the whole session"
        )
        XCTAssertFalse(lap.transitions.contains { $0.dispatchPause })
    }

    func testErrorIsStickyUntilAReload() {
        let failed = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .itemFailed,
        ])
        XCTAssertEqual(failed.machine.state, .error)

        // Neither a pause, a buffer nor a play request can leave `error`.
        let stuck = run([
            .timeControlChanged(.paused, atEnd: false),
            .timeControlChanged(.waitingToPlay, atEnd: false),
            .playRequested,
        ], from: failed.machine)
        XCTAssertEqual(stuck.machine.state, .error)
        XCTAssertFalse(stuck.transitions.contains { $0.dispatchPause })

        // Loading a new track clears it.
        let reloaded = run([.trackLoadStarted(playWhenReady: true)], from: stuck.machine)
        XCTAssertEqual(reloaded.machine.state, .loading)
    }

    func testPlayRequestFromIdleGoesLoading() {
        let result = run([
            .trackLoadStarted(playWhenReady: false),
            .playRequested,
        ])
        XCTAssertEqual(result.machine.state, .loading)
        XCTAssertTrue(result.machine.intendsToPlay)
    }

    /// An explicit `playing: false` write must land even mid-pre-roll,
    /// where a bare `.paused` status is only a transient. `paused` requires
    /// playback to have begun (spec), so a pre-roll cancel returns to
    /// `idle` — poster and (visible-in-idle) controls slot show — and the
    /// status that follows dispatches nothing.
    func testExplicitPauseDuringPreRollCancelsToIdle() {
        let preRoll = run([
            .trackLoadStarted(playWhenReady: true),
            .pauseRequested,
            .timeControlChanged(.paused, atEnd: false),
        ])
        XCTAssertEqual(
            preRoll.machine.state, .idle,
            "playback never began, so this is a cancel back to idle, not a pause"
        )
        XCTAssertFalse(preRoll.machine.intendsToPlay)
        XCTAssertFalse(
            preRoll.transitions.contains { $0.dispatchPause },
            "playback never started, so there is no pause to report"
        )

        let midPlayback = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .pauseRequested,
            .timeControlChanged(.paused, atEnd: false),
        ])
        XCTAssertEqual(midPlayback.machine.state, .paused)
        XCTAssertEqual(
            midPlayback.transitions.filter { $0.dispatchPause }.count, 1,
            "the request reports the pause; the status it causes must not repeat it"
        )
    }

    /// Once the current track has played, a pause landing between frames
    /// (play → pause → play again → pause before the first new frame) IS a
    /// `paused` — playback has begun, so this is not a pre-roll cancel.
    /// The resume reports its own onPlay immediately (direct
    /// `paused → playing` edge; DOM `el.play()` parity), so the second
    /// pause reports too.
    func testPauseDuringResumeGapIsPausedOncePlaybackBegan() {
        let result = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .pauseRequested,
            .timeControlChanged(.paused, atEnd: false),
            .playRequested,
            .pauseRequested,
        ])
        XCTAssertEqual(result.machine.state, .paused)
        XCTAssertFalse(result.machine.intendsToPlay)
        XCTAssertEqual(
            result.transitions.filter { $0.dispatchPlay }.count, 2,
            "the resume reports its onPlay on the request, like the DOM's play event"
        )
        XCTAssertEqual(
            result.transitions.filter { $0.dispatchPause }.count, 2,
            "each reported play gets its pause"
        )
    }

    /// Resuming from `paused` takes the direct `paused → playing` edge —
    /// spec: `loading` covers pre-begin and rebuffer only, and
    /// `paused ⇄ playing` is a direct edge. No loading detour is reported,
    /// and the resume dispatches `onPlay` immediately, exactly like the
    /// DOM's `play` event firing on `el.play()`.
    func testResumeFromPausedTakesTheDirectEdge() {
        let resumed = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .timeControlChanged(.paused, atEnd: false),
            .playRequested,
        ])
        XCTAssertEqual(resumed.machine.state, .playing)
        XCTAssertTrue(resumed.machine.intendsToPlay)
        guard let resume = resumed.transitions.last else {
            return XCTFail("missing resume transition")
        }
        XCTAssertEqual(resume.previousState, .paused, "no loading detour on resume")
        XCTAssertEqual(resume.state, .playing)
        XCTAssertTrue(resume.dispatchPlay)

        // The `.playing` status that follows lands on an already-playing
        // machine: no state churn, no second onPlay.
        let confirmed = run(
            [.timeControlChanged(.playing, atEnd: false)], from: resumed.machine
        )
        XCTAssertEqual(confirmed.machine.state, .playing)
        XCTAssertFalse(confirmed.transitions.contains { $0.dispatchPlay })
        XCTAssertFalse(confirmed.transitions[0].changed)
    }

    /// …but a resume that genuinely has to rebuffer still re-enters
    /// `loading` (silently), because rebuffering IS loading.
    func testResumeThatRebuffersReEntersLoadingSilently() {
        let stalled = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .timeControlChanged(.paused, atEnd: false),
            .playRequested,
            .timeControlChanged(.waitingToPlay, atEnd: false),
        ])
        XCTAssertEqual(stalled.machine.state, .loading)
        XCTAssertTrue(stalled.machine.intendsToPlay)
        XCTAssertFalse(stalled.transitions.last?.dispatchPause ?? true)
    }

    /// A pause from the native chrome during initial buffering surfaces as
    /// a bare `.paused` status while `loading` — arriving AFTER the player
    /// was actively `.waitingToPlay`. It must be honored (someone set the
    /// rate to 0), not swallowed as a pre-roll transient: the play intent
    /// is cancelled and, since playback never began, the machine returns
    /// to `idle` (spec: `paused` requires playback to have begun). Silent —
    /// no onPlay was reported, so there is no pause to report.
    func testNativeChromePauseDuringInitialBufferingIsHonored() {
        let result = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.waitingToPlay, atEnd: false),
            .timeControlChanged(.paused, atEnd: false),
        ])
        XCTAssertEqual(result.machine.state, .idle)
        XCTAssertFalse(
            result.machine.intendsToPlay,
            "the bind must stop reporting playing: true — the spinner must not lie forever"
        )
        XCTAssertFalse(result.transitions.contains { $0.dispatchPause })
    }

    /// A fresh track load re-arms the transient guard: its pre-roll
    /// `.paused` (no prior `.waitingToPlay` for THIS load) is still
    /// swallowed, even right after a buffering pause was honored.
    func testPreRollTransientStillSwallowedAfterATrackChange() {
        let result = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.waitingToPlay, atEnd: false),
            .timeControlChanged(.paused, atEnd: false),
            // reload / queue advance: the last-seen status resets…
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.paused, atEnd: false),
        ])
        XCTAssertEqual(
            result.machine.state, .loading,
            "a fresh load's pre-roll transient must not read as a pause"
        )
        XCTAssertTrue(result.machine.intendsToPlay)
    }

    func testPauseRequestIsInertInTerminalStates() {
        for terminal in [VideoPlayerEvent.itemFailed, .playedToEnd(continuation: .stop)] {
            let result = run([
                .trackLoadStarted(playWhenReady: true),
                .timeControlChanged(.playing, atEnd: false),
                terminal,
                .pauseRequested,
            ])
            XCTAssertTrue(
                result.machine.state == .error || result.machine.state == .ended,
                "a pause request must not resurrect a terminal state"
            )
        }
    }

    func testSourceClearedReturnsToIdle() {
        let result = run([
            .trackLoadStarted(playWhenReady: true),
            .timeControlChanged(.playing, atEnd: false),
            .sourceCleared,
        ])
        XCTAssertEqual(result.machine.state, .idle)
        XCTAssertFalse(result.machine.intendsToPlay)
    }

    func testHasEverPlayedDrivesTheBuiltInPoster() {
        var machine = VideoPlayerStateMachine()
        XCTAssertFalse(machine.hasEverPlayed)
        _ = machine.handle(.trackLoadStarted(playWhenReady: true))
        XCTAssertFalse(machine.hasEverPlayed)
        _ = machine.handle(.timeControlChanged(.playing, atEnd: false))
        XCTAssertTrue(machine.hasEverPlayed)
    }
}

// MARK: - Queue / `completed` matrix

final class VideoQueueTests: XCTestCase {

    func testSingleSourceWithoutLoopCompletes() {
        let outcome = VideoQueue(sourceCount: 1, isPlaylist: false, loop: false).outcome(at: 0)
        XCTAssertTrue(outcome.dispatchEnded)
        XCTAssertTrue(outcome.completed)
        XCTAssertNil(outcome.nextIndex)
        XCTAssertEqual(outcome.continuation, .stop)
    }

    /// A looping single source loops *silently* — native-style seek 0 +
    /// play, no `onEnded` per lap. (DOM sets `el.loop`, which swallows the
    /// `ended` event entirely; iOS was the outlier here.)
    func testSingleSourceWithLoopIsSilent() {
        let outcome = VideoQueue(sourceCount: 1, isPlaylist: false, loop: true).outcome(at: 0)
        XCTAssertFalse(outcome.dispatchEnded)
        XCTAssertNil(outcome.nextIndex)
        XCTAssertEqual(outcome.continuation, .restartInPlace)
    }

    func testPlaylistMidQueueIsNotCompleted() {
        let outcome = VideoQueue(sourceCount: 3, isPlaylist: true, loop: false).outcome(at: 0)
        XCTAssertTrue(outcome.dispatchEnded)
        XCTAssertFalse(outcome.completed)
        XCTAssertEqual(outcome.nextIndex, 1)
        XCTAssertEqual(outcome.continuation, .nextTrack)
    }

    func testPlaylistLastTrackWithoutLoopCompletes() {
        let outcome = VideoQueue(sourceCount: 3, isPlaylist: true, loop: false).outcome(at: 2)
        XCTAssertTrue(outcome.dispatchEnded)
        XCTAssertTrue(outcome.completed)
        XCTAssertNil(outcome.nextIndex)
        XCTAssertEqual(outcome.continuation, .stop)
    }

    /// The cross-platform rule iOS used to get wrong: `completed` is
    /// `isLast && !loop`, so a wrap reports `completed: false`.
    func testPlaylistLastTrackWithLoopWrapsAndIsNotCompleted() {
        let outcome = VideoQueue(sourceCount: 3, isPlaylist: true, loop: true).outcome(at: 2)
        XCTAssertTrue(outcome.dispatchEnded)
        XCTAssertFalse(outcome.completed, "a wrapping queue is not done")
        XCTAssertEqual(outcome.nextIndex, 0)
        XCTAssertEqual(outcome.continuation, .nextTrack)
    }

    /// The full matrix, spelled out: (kind × loop × position) → completed.
    func testCompletedMatrix() {
        let cases: [(isPlaylist: Bool, count: Int, loop: Bool, index: Int, completed: Bool?)] = [
            // single src: completed unless it loops (a looping single src
            // dispatches nothing, expressed as `nil`)
            (false, 1, false, 0, true),
            (false, 1, true, 0, nil),
            // playlist, no loop
            (true, 2, false, 0, false),
            (true, 2, false, 1, true),
            // playlist, loop: never completed — the queue always continues
            (true, 2, true, 0, false),
            (true, 2, true, 1, false),
            // single-entry playlist behaves like the last track
            (true, 1, false, 0, true),
            (true, 1, true, 0, false),
        ]

        for testCase in cases {
            let outcome = VideoQueue(
                sourceCount: testCase.count,
                isPlaylist: testCase.isPlaylist,
                loop: testCase.loop
            ).outcome(at: testCase.index)

            if let expected = testCase.completed {
                XCTAssertTrue(outcome.dispatchEnded, "\(testCase) must dispatch onEnded")
                XCTAssertEqual(
                    outcome.completed, expected,
                    "completed mismatch for \(testCase)"
                )
            } else {
                XCTAssertFalse(
                    outcome.dispatchEnded,
                    "\(testCase) must loop silently"
                )
            }
        }
    }

    func testSingleEntryPlaylistWithLoopWrapsOntoItself() {
        let outcome = VideoQueue(sourceCount: 1, isPlaylist: true, loop: true).outcome(at: 0)
        XCTAssertEqual(outcome.nextIndex, 0)
        XCTAssertEqual(outcome.continuation, .nextTrack)
    }
}

// MARK: - Slot visibility

final class VideoSlotVisibilityTests: XCTestCase {

    /// The normative table, transcribed straight from the spec (and from
    /// `VIDEO_SLOT_VISIBILITY` in `@hypen-space/core`). Any renderer drift
    /// shows up here.
    private let expected: [VideoSlot: [VideoPlayerState: Bool]] = [
        .poster: [
            .idle: true, .loading: true, .playing: false,
            .paused: false, .ended: true, .error: false,
        ],
        .loading: [
            .idle: false, .loading: true, .playing: false,
            .paused: false, .ended: false, .error: false,
        ],
        // `controls` is visible in `idle` so a custom controls slot can
        // start first play, and in `loading` so a buffering stream still
        // offers its transport.
        .controls: [
            .idle: true, .loading: true, .playing: true,
            .paused: true, .ended: true, .error: false,
        ],
        .error: [
            .idle: false, .loading: false, .playing: false,
            .paused: false, .ended: false, .error: true,
        ],
    ]

    func testVisibilityTableIsExhaustive() {
        XCTAssertEqual(VideoSlot.allCases.count, 4)
        XCTAssertEqual(VideoPlayerState.allCases.count, 6)

        for slot in VideoSlot.allCases {
            guard let row = expected[slot] else {
                return XCTFail("missing expectation row for \(slot)")
            }
            XCTAssertEqual(row.count, VideoPlayerState.allCases.count)
            for state in VideoPlayerState.allCases {
                XCTAssertEqual(
                    VideoSlotVisibility.isVisible(slot, in: state),
                    row[state],
                    "slot \(slot.rawValue) in state \(state.rawValue)"
                )
            }
        }
    }

    /// Slot names are contract vocabulary shared with `VIDEO_SLOTS`.
    func testSlotNamesMatchTheContract() {
        XCTAssertEqual(VideoSlot.named("controls"), .controls)
        XCTAssertEqual(VideoSlot.named("loading"), .loading)
        XCTAssertEqual(VideoSlot.named("error"), .error)
        XCTAssertEqual(VideoSlot.named("poster"), .poster)
        XCTAssertNil(VideoSlot.named("Controls"), "slot names are case-sensitive")
        XCTAssertNil(VideoSlot.named(nil))
        XCTAssertNil(VideoSlot.named("chapters"))
    }

    /// State names are reported verbatim through the bind struct.
    func testStateNamesMatchTheContract() {
        XCTAssertEqual(
            VideoPlayerState.allCases.map(\.rawValue),
            ["idle", "loading", "playing", "paused", "ended", "error"]
        )
    }

    /// Painting order is normative: bottom-to-top
    /// `poster → loading → controls → error`, covering every slot exactly
    /// once (the co-visible pairs are poster+loading in `loading` and
    /// poster+controls in `idle`/`ended`).
    func testPaintOrderIsPosterLoadingControlsError() {
        XCTAssertEqual(
            VideoSlot.paintOrder,
            [.poster, .loading, .controls, .error]
        )
        XCTAssertEqual(Set(VideoSlot.paintOrder), Set(VideoSlot.allCases))
    }
}

// MARK: - Bind reporting (renderer → state)

final class PlaybackBindReporterTests: XCTestCase {

    private func snapshot(
        playing: Bool = false,
        position: Double = 0,
        duration: Double = 0,
        state: VideoPlayerState = .idle
    ) -> PlaybackSnapshot {
        PlaybackSnapshot(playing: playing, position: position, duration: duration, state: state)
    }

    func testFirstReportWritesEveryKeyOnItsOwnPath() {
        var reporter = PlaybackBindReporter(path: "playback")
        let writes = reporter.writes(
            for: snapshot(playing: true, position: 12.5, duration: 60, state: .playing),
            now: 0,
            immediate: true
        )

        XCTAssertEqual(writes.count, 4)
        XCTAssertEqual(
            Set(writes.map(\.path)),
            ["playback.playing", "playback.state", "playback.duration", "playback.position"]
        )
        XCTAssertTrue(writes.contains(PlaybackWrite(path: "playback.playing", value: .bool(true))))
        XCTAssertTrue(writes.contains(PlaybackWrite(path: "playback.state", value: .string("playing"))))
        XCTAssertTrue(writes.contains(PlaybackWrite(path: "playback.duration", value: .number(60))))
        XCTAssertTrue(writes.contains(PlaybackWrite(path: "playback.position", value: .number(12.5))))
    }

    func testNestedBindPathIsPreserved() {
        var reporter = PlaybackBindReporter(path: "player.playback")
        let writes = reporter.writes(for: snapshot(state: .idle), now: 0, immediate: true)
        XCTAssertTrue(writes.allSatisfy { $0.path.hasPrefix("player.playback.") })
    }

    func testUnchangedSnapshotWritesNothing() {
        var reporter = PlaybackBindReporter(path: "playback")
        let sample = snapshot(playing: true, position: 3, duration: 30, state: .playing)
        _ = reporter.writes(for: sample, now: 0, immediate: true)
        XCTAssertTrue(reporter.writes(for: sample, now: 1, immediate: true).isEmpty)
    }

    /// Position reports are throttled to PLAYBACK_REPORT_INTERVAL_MS (250 ms)
    /// while playing.
    func testPositionIsThrottledTo250ms() {
        var reporter = PlaybackBindReporter(path: "playback")
        _ = reporter.writes(
            for: snapshot(playing: true, position: 0, duration: 60, state: .playing),
            now: 10,
            immediate: true
        )

        let tooSoon = reporter.writes(
            for: snapshot(playing: true, position: 0.1, duration: 60, state: .playing),
            now: 10.1,
            immediate: false
        )
        XCTAssertTrue(tooSoon.isEmpty, "a tick inside the 250 ms window reports nothing")

        let due = reporter.writes(
            for: snapshot(playing: true, position: 0.25, duration: 60, state: .playing),
            now: 10.25,
            immediate: false
        )
        XCTAssertEqual(due, [PlaybackWrite(path: "playback.position", value: .number(0.25))])
    }

    func testTransitionsBypassTheThrottle() {
        var reporter = PlaybackBindReporter(path: "playback")
        _ = reporter.writes(
            for: snapshot(playing: true, position: 0, duration: 60, state: .playing),
            now: 10,
            immediate: true
        )
        let seeked = reporter.writes(
            for: snapshot(playing: true, position: 42, duration: 60, state: .playing),
            now: 10.01,
            immediate: true
        )
        XCTAssertEqual(seeked, [PlaybackWrite(path: "playback.position", value: .number(42))])
    }

    /// `playing`/`state`/`duration` are transition-driven: they report on
    /// change even when a throttled position write is dropped.
    func testStateKeysReportInsideTheThrottleWindow() {
        var reporter = PlaybackBindReporter(path: "playback")
        _ = reporter.writes(
            for: snapshot(playing: true, position: 0, duration: 60, state: .playing),
            now: 10,
            immediate: true
        )
        let writes = reporter.writes(
            for: snapshot(playing: false, position: 0.05, duration: 60, state: .paused),
            now: 10.05,
            immediate: false
        )
        XCTAssertEqual(
            Set(writes.map(\.path)),
            ["playback.playing", "playback.state"],
            "the position write is throttled away, the transition keys are not"
        )
    }

    /// An unknown duration is reported as 0 ("0 until known"), never NaN.
    func testNonFiniteValuesReportAsZero() {
        var reporter = PlaybackBindReporter(path: "playback")
        let writes = reporter.writes(
            for: snapshot(position: .nan, duration: .infinity, state: .loading),
            now: 0,
            immediate: true
        )
        XCTAssertTrue(writes.contains(PlaybackWrite(path: "playback.duration", value: .number(0))))
        XCTAssertTrue(writes.contains(PlaybackWrite(path: "playback.position", value: .number(0))))
    }

    /// The echo guard's memory: only values actually handed to the module
    /// are remembered.
    func testLastReportedPositionTracksOnlyActualWrites() {
        var reporter = PlaybackBindReporter(path: "playback")
        XCTAssertNil(reporter.lastReportedPosition)

        _ = reporter.writes(
            for: snapshot(playing: true, position: 5, duration: 60, state: .playing),
            now: 0,
            immediate: true
        )
        XCTAssertEqual(reporter.lastReportedPosition, 5)

        // Throttled away → the module never saw 5.1.
        _ = reporter.writes(
            for: snapshot(playing: true, position: 5.1, duration: 60, state: .playing),
            now: 0.1,
            immediate: false
        )
        XCTAssertEqual(reporter.lastReportedPosition, 5)
    }

    /// R3 (normative): the bind's `playing` reports play INTENT — it stays
    /// `true` through a rebuffer while `state` reports `loading`. This test
    /// wires the machine's `intendsToPlay` into the snapshot's `playing`
    /// exactly as `VideoPlayerManager.currentSnapshot()` does, so a
    /// regression in either half shows up here.
    func testPlayingReportsIntentThroughRebuffer() {
        var machine = VideoPlayerStateMachine()
        _ = machine.handle(.trackLoadStarted(playWhenReady: true))
        _ = machine.handle(.timeControlChanged(.playing, atEnd: false))

        var reporter = PlaybackBindReporter(path: "playback")
        _ = reporter.writes(
            for: PlaybackSnapshot(
                playing: machine.intendsToPlay,
                position: 10,
                duration: 60,
                state: machine.state
            ),
            now: 0,
            immediate: true
        )

        // Mid-playback stall: the machine re-enters `loading` but the
        // intent stays true.
        _ = machine.handle(.timeControlChanged(.waitingToPlay, atEnd: false))
        XCTAssertEqual(machine.state, .loading)
        XCTAssertTrue(machine.intendsToPlay)

        let stalled = reporter.writes(
            for: PlaybackSnapshot(
                playing: machine.intendsToPlay,
                position: 10,
                duration: 60,
                state: machine.state
            ),
            now: 0.05,
            immediate: true
        )
        XCTAssertEqual(
            stalled,
            [PlaybackWrite(path: "playback.state", value: .string("loading"))],
            "state reports loading; playing must NOT flicker false"
        )

        // Recovery: back to `playing` with no `playing` write either way.
        _ = machine.handle(.timeControlChanged(.playing, atEnd: false))
        let resumed = reporter.writes(
            for: PlaybackSnapshot(
                playing: machine.intendsToPlay,
                position: 10,
                duration: 60,
                state: machine.state
            ),
            now: 0.1,
            immediate: true
        )
        XCTAssertEqual(
            resumed,
            [PlaybackWrite(path: "playback.state", value: .string("playing"))]
        )
    }

    func testPayloadShapeIsPathAndValue() {
        let write = PlaybackWrite(path: "playback.position", value: .number(7.5))
        let payload = write.payload
        XCTAssertEqual(payload["path"] as? String, "playback.position")
        XCTAssertEqual(payload["value"] as? Double, 7.5)
        XCTAssertEqual(payload.count, 2)

        XCTAssertEqual(
            PlaybackWrite(path: "p.playing", value: .bool(true)).payload["value"] as? Bool,
            true
        )
        XCTAssertEqual(
            PlaybackWrite(path: "p.state", value: .string("ended")).payload["value"] as? String,
            "ended"
        )
    }
}

// MARK: - Inbound writes (state → renderer)

final class PlaybackCommandResolverTests: XCTestCase {

    private func current(
        playing: Bool = false,
        position: Double = 0,
        duration: Double = 120,
        state: VideoPlayerState = .paused
    ) -> PlaybackSnapshot {
        PlaybackSnapshot(playing: playing, position: position, duration: duration, state: state)
    }

    private func commands(
        _ input: VideoPlaybackInput,
        current snapshot: PlaybackSnapshot,
        lastReportedPosition: Double? = nil,
        isInitial: Bool = false
    ) -> [PlaybackCommand] {
        PlaybackCommandResolver.commands(
            input: input,
            current: snapshot,
            lastReportedPosition: lastReportedPosition,
            isInitial: isInitial
        )
    }

    /// The 1 s epsilon guard: a `position` write is applied only when it
    /// differs from the actual playhead by MORE than one second.
    func testSeekEpsilon() {
        XCTAssertEqual(VideoPlaybackConstants.seekEpsilon, 1.0)

        XCTAssertTrue(
            commands(VideoPlaybackInput(position: 10.5), current: current(position: 10)).isEmpty,
            "half a second of drift is the renderer's own progress"
        )
        XCTAssertTrue(
            commands(VideoPlaybackInput(position: 11), current: current(position: 10)).isEmpty,
            "exactly one second is not MORE than one second"
        )
        XCTAssertEqual(
            commands(VideoPlaybackInput(position: 11.5), current: current(position: 10)),
            [.seek(11.5)]
        )
        XCTAssertEqual(
            commands(VideoPlaybackInput(position: 5), current: current(position: 10)),
            [.seek(5)],
            "backwards seeks respect the same epsilon"
        )
    }

    func testSeekIsClampedToTheTimeline() {
        XCTAssertEqual(
            commands(VideoPlaybackInput(position: 500), current: current(position: 10, duration: 120)),
            [.seek(120)]
        )
        XCTAssertEqual(
            commands(VideoPlaybackInput(position: -30), current: current(position: 10, duration: 120)),
            [.seek(0)]
        )
        // Unknown duration only clamps below.
        XCTAssertEqual(
            commands(VideoPlaybackInput(position: 500), current: current(position: 0, duration: 0)),
            [.seek(500)]
        )
    }

    /// The renderer-side half of the echo guard: a write that is exactly
    /// the value the renderer last reported is its own progress bouncing
    /// back through module state, never a seek.
    func testLastReportedPositionIsNotReApplied() {
        // Contrived on purpose: far outside the epsilon, and still ignored.
        XCTAssertTrue(
            commands(
                VideoPlaybackInput(position: 30),
                current: current(position: 10),
                lastReportedPosition: 30
            ).isEmpty
        )
        // A different value from the same module IS a seek.
        XCTAssertEqual(
            commands(
                VideoPlaybackInput(position: 45),
                current: current(position: 10),
                lastReportedPosition: 30
            ),
            [.seek(45)]
        )
    }

    func testNonFinitePositionIsIgnored() {
        XCTAssertTrue(
            commands(VideoPlaybackInput(position: .nan), current: current(position: 10)).isEmpty
        )
        XCTAssertTrue(
            commands(VideoPlaybackInput(position: .infinity), current: current(position: 10)).isEmpty
        )
    }

    func testPlayingWritesDriveTheTransport() {
        XCTAssertEqual(
            commands(VideoPlaybackInput(playing: true), current: current(playing: false, state: .paused)),
            [.play]
        )
        XCTAssertEqual(
            commands(VideoPlaybackInput(playing: false), current: current(playing: true, state: .playing)),
            [.pause]
        )
    }

    /// Echo-proof by construction: re-writing what the renderer just
    /// reported resolves to nothing at all.
    func testPlayingEchoesAreNoOps() {
        XCTAssertTrue(
            commands(VideoPlaybackInput(playing: true), current: current(playing: true, state: .playing)).isEmpty
        )
        XCTAssertTrue(
            commands(VideoPlaybackInput(playing: false), current: current(playing: false, state: .paused)).isEmpty
        )
    }

    /// A rebuffer keeps `playing: true`, so a `playing: true` echo during
    /// one must not re-issue play.
    func testPlayingTrueDuringRebufferIsANoOp() {
        XCTAssertTrue(
            commands(
                VideoPlaybackInput(playing: true),
                current: current(playing: true, position: 10, state: .loading)
            ).isEmpty
        )
    }

    /// "Writing `true` in `ended` restarts from 0."
    func testPlayingTrueWhileEndedRestarts() {
        XCTAssertEqual(
            commands(
                VideoPlaybackInput(playing: true),
                current: current(playing: false, position: 120, duration: 120, state: .ended)
            ),
            [.restart]
        )
    }

    /// …unless the same write also asks for a position, in which case the
    /// explicit seek wins and playback resumes from there.
    func testPlayingTrueWithPositionWhileEndedSeeksInstead() {
        XCTAssertEqual(
            commands(
                VideoPlaybackInput(playing: true, position: 30),
                current: current(playing: false, position: 120, duration: 120, state: .ended)
            ),
            [.seek(30), .play]
        )
    }

    func testSeekIsOrderedBeforeTheTransportCommand() {
        XCTAssertEqual(
            commands(
                VideoPlaybackInput(playing: true, position: 60),
                current: current(playing: false, position: 0, duration: 120, state: .paused)
            ),
            [.seek(60), .play]
        )
    }

    /// At mount, a module's default `playing: false` is "unset", not a
    /// pause — otherwise every bound player would cancel its own
    /// `autoplay` on the first frame. Positive intent still applies.
    func testInitialApplicationNeverPauses() {
        XCTAssertTrue(
            commands(
                VideoPlaybackInput(playing: false),
                current: current(playing: true, state: .playing),
                isInitial: true
            ).isEmpty
        )
        XCTAssertEqual(
            commands(
                VideoPlaybackInput(playing: true),
                current: current(playing: false, state: .idle),
                isInitial: true
            ),
            [.play]
        )
        XCTAssertEqual(
            commands(
                VideoPlaybackInput(position: 45),
                current: current(position: 0, duration: 120),
                isInitial: true
            ),
            [.seek(45)],
            "an initial position is the bind's resume-where-you-left-off"
        )
        // Later writes are authoritative in both directions.
        XCTAssertEqual(
            commands(
                VideoPlaybackInput(playing: false),
                current: current(playing: true, state: .playing)
            ),
            [.pause]
        )
    }

    func testEmptyInputDoesNothing() {
        XCTAssertTrue(VideoPlaybackInput().isEmpty)
        XCTAssertTrue(commands(VideoPlaybackInput(), current: current()).isEmpty)
    }
}

// MARK: - Inbound parsing

final class VideoPlaybackInputTests: XCTestCase {

    func testParsesTheBoundStruct() {
        let input = VideoPlaybackInput.from(
            playbackProp: [
                "playing": true,
                "position": 42.5,
                "duration": 120.0,
                "state": "playing",
            ] as [String: Any],
            playingProp: nil
        )
        XCTAssertEqual(input.playing, true)
        XCTAssertEqual(input.position, 42.5)
    }

    /// `duration` and `state` are renderer-owned: writes to them are
    /// ignored, so they are never even parsed into a command input.
    func testDurationAndStateAreNotWritable() {
        let input = VideoPlaybackInput.from(
            playbackProp: ["duration": 999.0, "state": "error"] as [String: Any],
            playingProp: nil
        )
        XCTAssertTrue(input.isEmpty)
    }

    func testAcceptsIntegerAndStringEncodedNumbers() {
        let ints = VideoPlaybackInput.from(
            playbackProp: ["playing": 1, "position": 30] as [String: Any], playingProp: nil
        )
        XCTAssertEqual(ints.playing, true)
        XCTAssertEqual(ints.position, 30)

        let strings = VideoPlaybackInput.from(
            playbackProp: ["playing": "true", "position": "12.5"] as [String: Any], playingProp: nil
        )
        XCTAssertEqual(strings.playing, true)
        XCTAssertEqual(strings.position, 12.5)
    }

    /// The one-way controlled subset: `playing: @{state.isPlaying}` as a
    /// plain prop, with no bound struct.
    func testFallsBackToThePlainPlayingProp() {
        let input = VideoPlaybackInput.from(playbackProp: nil, playingProp: true)
        XCTAssertEqual(input.playing, true)
        XCTAssertNil(input.position)
    }

    func testBoundStructWinsOverThePlainProp() {
        let input = VideoPlaybackInput.from(
            playbackProp: ["playing": false] as [String: Any], playingProp: true
        )
        XCTAssertEqual(input.playing, false)
    }

    func testNonDictionaryPlaybackPropIsIgnored() {
        let input = VideoPlaybackInput.from(playbackProp: "nonsense", playingProp: nil)
        XCTAssertTrue(input.isEmpty)
    }
}

// MARK: - Scrubber

final class ScrubberMathTests: XCTestCase {

    func testFractionFromPlayhead() {
        XCTAssertEqual(ScrubberMath.fraction(position: 30, duration: 120), 0.25, accuracy: 1e-9)
        XCTAssertEqual(ScrubberMath.fraction(position: 0, duration: 120), 0)
        XCTAssertEqual(ScrubberMath.fraction(position: 200, duration: 120), 1, "clamped")
        XCTAssertEqual(ScrubberMath.fraction(position: -5, duration: 120), 0, "clamped")
        XCTAssertEqual(ScrubberMath.fraction(position: 10, duration: 0), 0, "unknown duration")
        XCTAssertEqual(ScrubberMath.fraction(position: .nan, duration: 120), 0)
    }

    func testFractionFromTouch() {
        XCTAssertEqual(ScrubberMath.fraction(forX: 50, width: 200), 0.25, accuracy: 1e-9)
        XCTAssertEqual(ScrubberMath.fraction(forX: -20, width: 200), 0, "drag past the left edge")
        XCTAssertEqual(ScrubberMath.fraction(forX: 500, width: 200), 1, "drag past the right edge")
        XCTAssertEqual(ScrubberMath.fraction(forX: 10, width: 0), 0, "unmeasured track")
    }

    func testPositionFromFraction() {
        XCTAssertEqual(ScrubberMath.position(forFraction: 0.5, duration: 120), 60, accuracy: 1e-9)
        XCTAssertEqual(ScrubberMath.position(forFraction: 2, duration: 120), 120, "clamped")
        XCTAssertEqual(ScrubberMath.position(forFraction: 0.5, duration: 0), 0)
    }

    /// VoiceOver's adjustable actions seek ±5 s, clamped to the timeline.
    func testAdjustableSteps() {
        XCTAssertEqual(VideoPlaybackConstants.accessibilitySeekStep, 5)
        XCTAssertEqual(ScrubberMath.adjusted(position: 30, duration: 120, by: 5), 35)
        XCTAssertEqual(ScrubberMath.adjusted(position: 30, duration: 120, by: -5), 25)
        XCTAssertEqual(ScrubberMath.adjusted(position: 2, duration: 120, by: -5), 0, "clamped")
        XCTAssertEqual(ScrubberMath.adjusted(position: 118, duration: 120, by: 5), 120, "clamped")
    }

    func testAccessibilityValueText() {
        XCTAssertEqual(ScrubberMath.accessibilityValue(position: 65, duration: 200), "1:05 of 3:20")
        XCTAssertEqual(ScrubberMath.accessibilityValue(position: 0, duration: 200), "0:00 of 3:20")
        XCTAssertEqual(
            ScrubberMath.accessibilityValue(position: 30, duration: 0), "0:30",
            "an unknown duration degrades to the elapsed time"
        )
    }

    func testTimeLabelFormatting() {
        XCTAssertEqual(ScrubberMath.timeLabel(0), "0:00")
        XCTAssertEqual(ScrubberMath.timeLabel(9), "0:09")
        XCTAssertEqual(ScrubberMath.timeLabel(59.9), "0:59")
        XCTAssertEqual(ScrubberMath.timeLabel(60), "1:00")
        XCTAssertEqual(ScrubberMath.timeLabel(3661), "1:01:01")
        XCTAssertEqual(ScrubberMath.timeLabel(.nan), "0:00")
        XCTAssertEqual(ScrubberMath.timeLabel(-5), "0:00")
    }
}

final class ScrubberCommitTests: XCTestCase {

    /// Commit precedence (normative): the Scrubber's OWN bind wins, else
    /// the enclosing Video's bind, else `onSeek`.
    func testOwnBindWinsWhenBothExist() {
        XCTAssertEqual(
            ScrubberCommit.plan(
                enclosingBindPath: "playback", ownBindPath: "scrub", hasOnSeek: true
            ),
            .ownBind(path: "scrub")
        )
    }

    func testFallsBackToTheEnclosingVideoBind() {
        XCTAssertEqual(
            ScrubberCommit.plan(
                enclosingBindPath: "playback", ownBindPath: nil, hasOnSeek: true
            ),
            .enclosingBind
        )
        XCTAssertEqual(
            ScrubberCommit.plan(
                enclosingBindPath: "playback", ownBindPath: "", hasOnSeek: true
            ),
            .enclosingBind,
            "an empty own bind path is not a bind"
        )
    }

    func testOwnBindAloneCommitsToItself() {
        XCTAssertEqual(
            ScrubberCommit.plan(
                enclosingBindPath: nil, ownBindPath: "playback", hasOnSeek: true
            ),
            .ownBind(path: "playback")
        )
    }

    func testFallsBackToOnSeekWhenBoundLess() {
        XCTAssertEqual(
            ScrubberCommit.plan(enclosingBindPath: nil, ownBindPath: nil, hasOnSeek: true),
            .seekAction
        )
    }

    func testNothingToCommitTo() {
        XCTAssertEqual(
            ScrubberCommit.plan(enclosingBindPath: nil, ownBindPath: nil, hasOnSeek: false),
            .localOnly
        )
        XCTAssertEqual(
            ScrubberCommit.plan(enclosingBindPath: "", ownBindPath: "", hasOnSeek: false),
            .localOnly,
            "an empty bind path is not a bind"
        )
    }
}

// MARK: - Registration

@MainActor
final class VideoComponentRegistrationTests: XCTestCase {

    func testVideoAndScrubberAreRegistered() {
        let registry = ComponentRegistry.withDefaults()
        XCTAssertEqual(registry.getHandler(for: "video")?.typeName, "video")
        XCTAssertEqual(registry.getHandler(for: "scrubber")?.typeName, "scrubber")
        // The engine emits primitive names as-is; lookup is case-tolerant.
        XCTAssertNotNil(registry.getHandler(for: "Scrubber"))
    }

    /// The constants the spec pins, mirrored from
    /// `hypen-web/packages/core/src/types.ts`.
    func testNormativeConstants() {
        XCTAssertEqual(VideoPlaybackConstants.reportInterval, 0.25)
        XCTAssertEqual(VideoPlaybackConstants.seekEpsilon, 1.0)
    }
}

// MARK: - Runtime config (identity-independent props)

final class VideoRuntimeConfigTests: XCTestCase {

    private func bindings(onPlay: ActionValue? = nil) -> VideoEventBindings {
        VideoEventBindings(
            onPlay: onPlay, onPause: nil, onEnded: nil,
            onTrackChange: nil, onError: nil
        )
    }

    /// `VideoRuntimeConfig` drives the view's onChange hook, so its
    /// equality must notice every identity-independent prop — including a
    /// re-bound `@actions.*` event prop and its payload.
    func testEqualityCoversEventBindings() {
        let base = VideoRuntimeConfig(
            muted: false, loop: false, autoplay: true, bindPath: "playback",
            bindings: bindings(onPlay: ActionValue(actionName: "started"))
        )
        XCTAssertEqual(base, base)

        var rebound = base
        rebound.bindings.onPlay = ActionValue(actionName: "startedV2")
        XCTAssertNotEqual(base, rebound, "a re-bound @actions prop is a config change")

        var repayloaded = base
        repayloaded.bindings.onPlay = ActionValue(
            actionName: "started", payload: ["surface": "hero"]
        )
        XCTAssertNotEqual(base, repayloaded, "payload changes count too")

        var muted = base
        muted.muted = true
        XCTAssertNotEqual(base, muted)

        var unbound = base
        unbound.bindPath = nil
        XCTAssertNotEqual(base, unbound)
    }
}

// MARK: - Manager lifecycle (suspend / resume / runtime updates)

/// `VideoPlayerManager` is the AVPlayer shell; these tests exercise the
/// pieces of it that broke in the wild: surviving a disappear/appear cycle
/// (the @StateObject outlives `onDisappear`) and applying runtime prop
/// updates to the live player. Nothing here needs playback to actually
/// start — assertions are on the synchronously observable state.
@MainActor
final class VideoPlayerManagerLifecycleTests: XCTestCase {

    private func emptyBindings() -> VideoEventBindings {
        VideoEventBindings(
            onPlay: nil, onPause: nil, onEnded: nil,
            onTrackChange: nil, onError: nil
        )
    }

    private func makeManager(
        autoplay: Bool,
        muted: Bool = false,
        loop: Bool = false,
        bindPath: String? = nil,
        dispatcher: ActionDispatcher = MockActionDispatcher()
    ) -> VideoPlayerManager {
        VideoPlayerManager(
            sources: ["https://example.com/video.mp4"],
            startIndex: 0,
            isPlaylist: false,
            headers: [:],
            runtime: VideoRuntimeConfig(
                muted: muted, loop: loop, autoplay: autoplay,
                bindPath: bindPath, bindings: emptyBindings()
            ),
            startPosition: nil,
            dispatcher: dispatcher
        )
    }

    /// The disappear/appear regression: suspending must keep the item and
    /// observers alive (no `replaceCurrentItem(nil)`), and resuming must
    /// re-arm playback with the saved intent — never a permanently dead
    /// surface, never a machine stuck in `loading`.
    func testSuspendKeepsTheItemAndResumeRearmsPlayIntent() {
        let manager = makeManager(autoplay: true)
        XCTAssertNotNil(manager.player.currentItem)
        XCTAssertEqual(manager.playerState, .loading)

        manager.suspend()
        XCTAssertNotNil(manager.player.currentItem, "suspend keeps the item alive")
        XCTAssertEqual(
            manager.playerState, .idle,
            "playback never began, so the suspension cancels to idle"
        )

        manager.resumeIfSuspended()
        XCTAssertNotNil(manager.player.currentItem)
        XCTAssertEqual(
            manager.playerState, .loading,
            "the saved play intent re-arms playback on reappear"
        )
    }

    func testResumeWithoutPlayIntentStaysPut() {
        let manager = makeManager(autoplay: false)
        XCTAssertEqual(manager.playerState, .idle)
        manager.suspend()
        manager.resumeIfSuspended()
        XCTAssertEqual(
            manager.playerState, .idle,
            "nothing was playing at suspension, so nothing resumes"
        )
        XCTAssertNotNil(manager.player.currentItem)
    }

    /// A `playing: false` bind write landing while the view is off-screen
    /// replaces the saved resume intent: reappearing must not undo the
    /// module's pause.
    func testExplicitPauseWhileSuspendedCancelsTheResume() {
        let manager = makeManager(autoplay: true)
        manager.suspend()
        manager.applyPlaybackInput(VideoPlaybackInput(playing: false))
        manager.resumeIfSuspended()
        XCTAssertEqual(manager.playerState, .idle, "the off-screen pause wins")
    }

    /// …and a `playing: true` write while off-screen must not start audio
    /// on the hidden player — it becomes the resume intent instead.
    func testExplicitPlayWhileSuspendedResumesOnlyOnReappear() {
        let manager = makeManager(autoplay: false)
        manager.suspend()
        manager.applyPlaybackInput(VideoPlaybackInput(playing: true))
        XCTAssertEqual(
            manager.playerState, .idle,
            "the hidden player is never driven while suspended"
        )
        manager.resumeIfSuspended()
        XCTAssertEqual(manager.playerState, .loading, "the intent lands on reappear")
    }

    /// Runtime updates to the identity-independent props must reach the
    /// live player: `muted` hits the AVPlayer, `loop` hits the queue's
    /// end-of-track policy, and a new `bind` path re-reports the full
    /// struct under the new prefix.
    func testApplyRuntimeConfigReachesTheLivePlayer() {
        let dispatcher = MockActionDispatcher()
        let manager = makeManager(autoplay: false, dispatcher: dispatcher)
        XCTAssertFalse(manager.player.isMuted)
        XCTAssertFalse(manager.queue.loop)
        XCTAssertNil(manager.bindPath)

        manager.applyRuntimeConfig(VideoRuntimeConfig(
            muted: true, loop: true, autoplay: false,
            bindPath: "playback", bindings: emptyBindings()
        ))

        XCTAssertTrue(manager.player.isMuted, "a muted toggle reaches the live AVPlayer")
        XCTAssertTrue(manager.queue.loop, "a loop toggle reaches the queue policy")
        XCTAssertEqual(manager.bindPath, "playback")

        let bindWrites = dispatcher.dispatchedActions.filter { $0.action == "__hypen_bind" }
        XCTAssertFalse(bindWrites.isEmpty, "a fresh bind reports the struct immediately")
        XCTAssertTrue(
            bindWrites.allSatisfy {
                ($0.payload?["path"] as? String)?.hasPrefix("playback.") == true
            },
            "reports land under the new bind path"
        )

        // Removing the bind stops the traffic.
        manager.applyRuntimeConfig(VideoRuntimeConfig(
            muted: true, loop: true, autoplay: false,
            bindPath: nil, bindings: emptyBindings()
        ))
        XCTAssertNil(manager.bindPath)
        dispatcher.clear()
        // Idempotence: re-applying the same config produces nothing.
        manager.applyRuntimeConfig(VideoRuntimeConfig(
            muted: true, loop: true, autoplay: false,
            bindPath: nil, bindings: emptyBindings()
        ))
        XCTAssertTrue(dispatcher.dispatchedActions.isEmpty)
    }
}
