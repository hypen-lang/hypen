package space.hypen.renderer.components

import androidx.media3.common.Player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.model.ActionValue

/**
 * Video v2 contract (hypen-docs/content/docs/guide/components.mdx §"Playback control & composition
 * slots"), pinned against the normative constants and tables in
 * `hypen-web/packages/core/src/types.ts`.
 *
 * Everything under test is the pure half of [VideoComponent] /
 * [ScrubberComponent]: the state machine fed by the ExoPlayer callbacks, the
 * bind report/write rules, the slot visibility table and the scrubber's
 * commit payload.
 */
class VideoPlaybackTest {

    // ── State machine ──────────────────────────────────────────────────────

    private fun state(
        playbackState: Int,
        isPlaying: Boolean = false,
        playWhenReady: Boolean = false,
        hasError: Boolean = false,
        hasSource: Boolean = true,
        playbackBegun: Boolean = false,
    ) = derivePlayerState(playbackState, isPlaying, playWhenReady, hasError, hasSource, playbackBegun)

    @Test
    fun `buffering is loading`() {
        assertEquals(VideoPlayerState.LOADING, state(Player.STATE_BUFFERING, playWhenReady = true))
    }

    @Test
    fun `a rebuffer mid-playback re-enters loading rather than pausing`() {
        // playWhenReady stays true across a stall — the contract calls this
        // loading, and the event side deliberately emits no onPause.
        assertEquals(
            VideoPlayerState.LOADING,
            state(Player.STATE_BUFFERING, isPlaying = false, playWhenReady = true),
        )
    }

    @Test
    fun `ready plus isPlaying is playing`() {
        assertEquals(
            VideoPlayerState.PLAYING,
            state(Player.STATE_READY, isPlaying = true, playWhenReady = true),
        )
    }

    @Test
    fun `ready but never played is idle, not paused`() {
        // "A ready-but-never-played source is idle (poster, not spinner);
        // paused requires playback to have begun" (amended contract).
        assertEquals(
            VideoPlayerState.IDLE,
            state(Player.STATE_READY, playWhenReady = false, playbackBegun = false),
        )
    }

    @Test
    fun `ready after playback has begun is paused`() {
        assertEquals(
            VideoPlayerState.PAUSED,
            state(Player.STATE_READY, playWhenReady = false, playbackBegun = true),
        )
    }

    @Test
    fun `ready but suppressed reads as paused, never as a phantom playing`() {
        // playWhenReady true, isPlaying false = audio focus / suppression.
        // Play was requested, so this is not a phantom `idle` either.
        assertEquals(
            VideoPlayerState.PAUSED,
            state(Player.STATE_READY, isPlaying = false, playWhenReady = true),
        )
    }

    @Test
    fun `ended is ended`() {
        assertEquals(VideoPlayerState.ENDED, state(Player.STATE_ENDED))
    }

    @Test
    fun `an unprepared player is idle`() {
        assertEquals(VideoPlayerState.IDLE, state(Player.STATE_IDLE))
    }

    @Test
    fun `no source at all is idle whatever the player says`() {
        assertEquals(
            VideoPlayerState.IDLE,
            state(Player.STATE_READY, isPlaying = true, hasSource = false),
        )
    }

    @Test
    fun `error outranks every other player state and is sticky`() {
        assertEquals(VideoPlayerState.ERROR, state(Player.STATE_IDLE, hasError = true))
        assertEquals(
            VideoPlayerState.ERROR,
            state(Player.STATE_READY, isPlaying = true, hasError = true),
        )
    }

    @Test
    fun `state names are the contract vocabulary`() {
        assertEquals(
            listOf("idle", "loading", "playing", "paused", "ended", "error"),
            VideoPlayerState.entries.map { it.wireName },
        )
    }

    // ── loop → repeat mode ─────────────────────────────────────────────────

    @Test
    fun `loop maps to repeat one for a single source and repeat all for a playlist`() {
        assertEquals(Player.REPEAT_MODE_OFF, repeatModeFor(loop = false, sourceCount = 1))
        assertEquals(Player.REPEAT_MODE_OFF, repeatModeFor(loop = false, sourceCount = 3))
        assertEquals(Player.REPEAT_MODE_ONE, repeatModeFor(loop = true, sourceCount = 1))
        assertEquals(Player.REPEAT_MODE_ALL, repeatModeFor(loop = true, sourceCount = 3))
    }

    // ── Slot visibility table ──────────────────────────────────────────────

    @Test
    fun `slot visibility matches the normative table`() {
        // Rows in the doc's order; columns idle/loading/playing/paused/ended/error.
        val table = mapOf(
            VideoSlot.POSTER to listOf(true, true, false, false, true, false),
            VideoSlot.LOADING to listOf(false, true, false, false, false, false),
            VideoSlot.CONTROLS to listOf(true, true, true, true, true, false),
            VideoSlot.ERROR to listOf(false, false, false, false, false, true),
        )
        val states = listOf(
            VideoPlayerState.IDLE,
            VideoPlayerState.LOADING,
            VideoPlayerState.PLAYING,
            VideoPlayerState.PAUSED,
            VideoPlayerState.ENDED,
            VideoPlayerState.ERROR,
        )
        for ((slot, row) in table) {
            for ((index, expected) in row.withIndex()) {
                assertEquals(
                    "${slot.wireName} in ${states[index].wireName}",
                    expected,
                    isVideoSlotVisible(slot, states[index]),
                )
            }
        }
    }

    @Test
    fun `controls are visible in idle so a custom slot can start first play`() {
        // Amended ruling (VIDEO_SLOT_VISIBILITY in types.ts is the source of
        // truth): without this, a controls slot over a never-played source
        // could not start playback at all.
        assertTrue(isVideoSlotVisible(VideoSlot.CONTROLS, VideoPlayerState.IDLE))
        // Co-visible with the poster in idle; controls paint above the poster.
        assertTrue(isVideoSlotVisible(VideoSlot.POSTER, VideoPlayerState.IDLE))
        assertTrue(VideoSlot.POSTER.ordinal < VideoSlot.CONTROLS.ordinal)
    }

    @Test
    fun `ended shows poster and controls together, so controls paint on top`() {
        assertTrue(isVideoSlotVisible(VideoSlot.POSTER, VideoPlayerState.ENDED))
        assertTrue(isVideoSlotVisible(VideoSlot.CONTROLS, VideoPlayerState.ENDED))
        // Enum declaration order is the paint order, bottom to top.
        assertTrue(VideoSlot.POSTER.ordinal < VideoSlot.CONTROLS.ordinal)
        assertEquals(VideoSlot.ERROR, VideoSlot.entries.last())
    }

    @Test
    fun `only the four contract slot names resolve`() {
        assertEquals(VideoSlot.CONTROLS, videoSlotOf("controls"))
        assertEquals(VideoSlot.LOADING, videoSlotOf("loading"))
        assertEquals(VideoSlot.ERROR, videoSlotOf("error"))
        assertEquals(VideoSlot.POSTER, videoSlotOf("poster"))
        assertNull(videoSlotOf("footer"))
        assertNull(videoSlotOf(null))
    }

    // ── Play intent (the reported `playing` field) ─────────────────────────

    @Test
    fun `playing reports intent - it stays true through a rebuffer`() {
        // Mid-stall: playWhenReady stays true, state reports loading —
        // `playing` must NOT flicker to false (amended report semantics).
        assertTrue(playbackIntent(playWhenReady = true, state = VideoPlayerState.LOADING))
        assertTrue(playbackIntent(playWhenReady = true, state = VideoPlayerState.PLAYING))
    }

    @Test
    fun `playing intent is false without playWhenReady`() {
        assertFalse(playbackIntent(playWhenReady = false, state = VideoPlayerState.LOADING))
        assertFalse(playbackIntent(playWhenReady = false, state = VideoPlayerState.PAUSED))
    }

    @Test
    fun `ended and error clear the play intent even while playWhenReady lingers`() {
        // Media3 keeps playWhenReady=true at STATE_ENDED; the contract's
        // restart is an explicit `playing: true` write, so the report reads
        // disengaged.
        assertFalse(playbackIntent(playWhenReady = true, state = VideoPlayerState.ENDED))
        assertFalse(playbackIntent(playWhenReady = true, state = VideoPlayerState.ERROR))
        assertFalse(playbackIntent(playWhenReady = true, state = VideoPlayerState.IDLE))
        assertFalse(playbackIntent(playWhenReady = true, state = VideoPlayerState.PAUSED))
    }

    // ── Report: renderer → @state.playback ─────────────────────────────────

    private fun report(
        playing: Boolean = false,
        position: Double = 0.0,
        duration: Double = 0.0,
        state: VideoPlayerState = VideoPlayerState.PAUSED,
    ) = PlaybackReport(playing, position, duration, state)

    @Test
    fun `the first report writes all four fields`() {
        val reporter = PlaybackReporter()
        val writes = reporter.report(
            report(playing = true, position = 1.5, duration = 90.0, state = VideoPlayerState.PLAYING),
            nowMs = 1_000L,
            transition = true,
        )
        assertEquals(
            mapOf(
                "playing" to true,
                "state" to "playing",
                "duration" to 90.0,
                "position" to 1.5,
            ),
            writes.associate { it.key to it.value },
        )
    }

    @Test
    fun `unchanged fields are not rewritten`() {
        val reporter = PlaybackReporter()
        val base = report(playing = true, position = 1.0, duration = 90.0, state = VideoPlayerState.PLAYING)
        reporter.report(base, nowMs = 0L, transition = true)
        val writes = reporter.report(base, nowMs = 5_000L, transition = true)
        assertTrue(writes.isEmpty())
    }

    @Test
    fun `position is throttled to 250ms while playing`() {
        val reporter = PlaybackReporter()
        val playing = VideoPlayerState.PLAYING
        reporter.report(report(true, 0.0, 90.0, playing), nowMs = 0L, transition = true)

        // 249ms later: too soon.
        val early = reporter.report(report(true, 0.2, 90.0, playing), nowMs = 249L, transition = false)
        assertTrue(early.isEmpty())

        // 250ms after the last *reported* position: due.
        val due = reporter.report(report(true, 0.3, 90.0, playing), nowMs = 250L, transition = false)
        assertEquals(listOf("position" to 0.3), due.map { it.key to it.value })
    }

    @Test
    fun `a transition reports position immediately, bypassing the throttle`() {
        val reporter = PlaybackReporter()
        reporter.report(
            report(true, 0.0, 90.0, VideoPlayerState.PLAYING),
            nowMs = 0L,
            transition = true,
        )
        val writes = reporter.report(
            report(false, 12.0, 90.0, VideoPlayerState.PAUSED),
            nowMs = 10L,
            transition = true,
        )
        assertEquals(
            mapOf("playing" to false, "state" to "paused", "position" to 12.0),
            writes.associate { it.key to it.value },
        )
    }

    @Test
    fun `playing state and duration are never throttled`() {
        val reporter = PlaybackReporter()
        reporter.report(report(true, 0.0, 0.0, VideoPlayerState.PLAYING), nowMs = 0L, transition = true)
        // 1ms later, no transition flag: position is held back but the
        // duration becoming known goes out at once.
        val writes = reporter.report(
            report(true, 0.05, 90.0, VideoPlayerState.PLAYING),
            nowMs = 1L,
            transition = false,
        )
        assertEquals(listOf("duration" to 90.0), writes.map { it.key to it.value })
    }

    @Test
    fun `the last reported position is retained for the echo guard`() {
        val reporter = PlaybackReporter()
        reporter.report(report(true, 3.0, 90.0, VideoPlayerState.PLAYING), nowMs = 0L, transition = true)
        assertEquals(3.0, reporter.lastPositionSeconds!!, 0.0)
        // A throttled-away sample does not move the guard.
        reporter.report(report(true, 3.1, 90.0, VideoPlayerState.PLAYING), nowMs = 10L, transition = false)
        assertEquals(3.0, reporter.lastPositionSeconds!!, 0.0)
    }

    // ── Write: @state.playback → renderer ──────────────────────────────────

    @Test
    fun `a playback struct parses playing and position and ignores the read-only half`() {
        val write = parsePlaybackWrite(
            mapOf(
                "playing" to true,
                "position" to 12.5,
                "duration" to 90.0,
                "state" to "paused",
            ),
        )
        assertEquals(PlaybackWrite(playing = true, positionSeconds = 12.5), write)
    }

    @Test
    fun `string-typed struct fields coerce`() {
        assertEquals(
            PlaybackWrite(playing = false, positionSeconds = 4.0),
            parsePlaybackWrite(mapOf("playing" to "false", "position" to "4")),
        )
    }

    @Test
    fun `a partial struct only carries what it sets`() {
        assertEquals(
            PlaybackWrite(playing = null, positionSeconds = 7.0),
            parsePlaybackWrite(mapOf("position" to 7)),
        )
    }

    @Test
    fun `a non-map playback prop is not a write`() {
        assertNull(parsePlaybackWrite(null))
        assertNull(parsePlaybackWrite("playing"))
        assertNull(parsePlaybackWrite(42))
    }

    @Test
    fun `a bound struct outranks the one-way playing prop`() {
        assertEquals(
            PlaybackWrite(playing = true, positionSeconds = 3.0),
            playbackWriteFrom(mapOf("playing" to true, "position" to 3.0), playingProp = false),
        )
    }

    @Test
    fun `a lone playing prop is the one-way controlled subset`() {
        assertEquals(
            PlaybackWrite(playing = false, positionSeconds = null),
            playbackWriteFrom(playbackProp = null, playingProp = false),
        )
        assertNull(playbackWriteFrom(playbackProp = null, playingProp = null))
    }

    @Test
    fun `a position within the one second epsilon does not seek`() {
        // The renderer's own 0.25s progress reports echo back as writes.
        assertNull(seekTargetMs(requestedSeconds = 10.5, actualPositionMs = 10_000L, durationMs = 90_000L))
        assertNull(seekTargetMs(requestedSeconds = 11.0, actualPositionMs = 10_000L, durationMs = 90_000L))
        assertNull(seekTargetMs(requestedSeconds = 9.0, actualPositionMs = 10_000L, durationMs = 90_000L))
    }

    @Test
    fun `a position beyond the epsilon seeks`() {
        assertEquals(
            30_000L,
            seekTargetMs(requestedSeconds = 30.0, actualPositionMs = 10_000L, durationMs = 90_000L),
        )
        assertEquals(
            8_900L,
            seekTargetMs(requestedSeconds = 8.9, actualPositionMs = 10_000L, durationMs = 90_000L),
        )
    }

    @Test
    fun `a seek is clamped to zero and to the duration`() {
        assertEquals(
            0L,
            seekTargetMs(requestedSeconds = -30.0, actualPositionMs = 40_000L, durationMs = 90_000L),
        )
        assertEquals(
            90_000L,
            seekTargetMs(requestedSeconds = 500.0, actualPositionMs = 10_000L, durationMs = 90_000L),
        )
    }

    @Test
    fun `an unknown duration seeks without an upper clamp`() {
        // Media3 reports C.TIME_UNSET before the manifest lands.
        assertEquals(
            500_000L,
            seekTargetMs(requestedSeconds = 500.0, actualPositionMs = 0L, durationMs = -1L),
        )
    }

    @Test
    fun `NaN is never a seek`() {
        assertNull(seekTargetMs(Double.NaN, 0L, 90_000L))
    }

    @Test
    fun `unknown media times report as zero seconds`() {
        assertEquals(0.0, mediaMsToSeconds(-9_223_372_036_854_775_807L), 0.0)
        assertEquals(0.0, mediaMsToSeconds(0L), 0.0)
        assertEquals(1.25, mediaMsToSeconds(1_250L), 0.0)
    }

    // ── Scrubber commit ────────────────────────────────────────────────────

    @Test
    fun `the scrubber's own bind wins over the enclosing video's`() {
        // Normative precedence: own bind → Video's bind → onSeek.
        assertEquals("scrub.playback", scrubberBindPath("scrub.playback", "video.playback"))
        assertEquals("video.playback", scrubberBindPath(null, "video.playback"))
        assertEquals("scrub.playback", scrubberBindPath("scrub.playback", null))
        assertNull(scrubberBindPath(null, null))
    }

    @Test
    fun `a bound scrubber commits a position write on the bind channel`() {
        val commit = scrubberCommit(
            fraction = 0.5f,
            durationMs = 90_000L,
            bindPath = "playback",
            onSeek = null,
        )!!
        assertEquals("__hypen_bind", commit.action)
        assertEquals(mapOf("path" to "playback.position", "value" to 45.0), commit.payload)
    }

    @Test
    fun `a bound scrubber prefers the bind over its own onSeek`() {
        val commit = scrubberCommit(
            fraction = 1f,
            durationMs = 10_000L,
            bindPath = "player.playback",
            onSeek = ActionValue("seeked"),
        )!!
        assertEquals("__hypen_bind", commit.action)
        assertEquals("player.playback.position", commit.payload["path"])
        assertEquals(10.0, commit.payload["value"])
    }

    @Test
    fun `a bound-less scrubber commits its onSeek action with the contract payload`() {
        val commit = scrubberCommit(
            fraction = 0.25f,
            durationMs = 80_000L,
            bindPath = null,
            onSeek = ActionValue("seeked", mapOf("id" to 7)),
        )!!
        assertEquals("seeked", commit.action)
        assertEquals(
            mapOf("type" to "seek", "position" to 20.0, "id" to 7),
            commit.payload,
        )
    }

    @Test
    fun `a scrubber with neither bind nor onSeek commits nothing`() {
        assertNull(scrubberCommit(0.5f, 90_000L, bindPath = null, onSeek = null))
    }

    @Test
    fun `nothing commits while the duration is unknown`() {
        assertNull(scrubberCommit(0.5f, 0L, bindPath = "playback", onSeek = null))
        assertNull(scrubberCommit(0.5f, -1L, bindPath = "playback", onSeek = ActionValue("seeked")))
    }

    @Test
    fun `drag fractions clamp to the timeline`() {
        assertEquals(0L, scrubberPositionMs(-2f, 90_000L))
        assertEquals(90_000L, scrubberPositionMs(4f, 90_000L))
        assertEquals(45_000L, scrubberPositionMs(0.5f, 90_000L))
        assertEquals(0L, scrubberPositionMs(0.5f, 0L))
    }

    @Test
    fun `the track fraction is zero until the duration is known`() {
        assertEquals(0f, scrubberFraction(5_000L, 0L), 0f)
        assertEquals(0.5f, scrubberFraction(45_000L, 90_000L), 0.0001f)
        assertEquals(1f, scrubberFraction(120_000L, 90_000L), 0f)
    }

    @Test
    fun `timecodes read as TalkBack expects`() {
        assertEquals("0:00", formatTimecode(0L))
        assertEquals("0:07", formatTimecode(7_400L))
        assertEquals("1:05", formatTimecode(65_000L))
        assertEquals("1:00:00", formatTimecode(3_600_000L))
        assertEquals("0:00", formatTimecode(-5L))
    }

    // ── Inbound write resolution (echo guards, first bind, ended restart) ──

    private fun resolve(
        playing: Boolean? = null,
        position: Double? = null,
        stateEcho: String? = null,
        isFirstApplication: Boolean = false,
        currentState: VideoPlayerState = VideoPlayerState.PLAYING,
        playWhenReady: Boolean = true,
        actualPositionMs: Long = 10_000L,
        durationMs: Long = 90_000L,
        lastReportedPlaying: Boolean? = null,
        lastReportedPositionSeconds: Double? = null,
        lastReportedState: VideoPlayerState? = null,
    ) = resolvePlaybackCommands(
        write = PlaybackWrite(playing, position),
        stateEcho = stateEcho,
        isFirstApplication = isFirstApplication,
        currentState = currentState,
        playWhenReady = playWhenReady,
        actualPositionMs = actualPositionMs,
        durationMs = durationMs,
        lastReportedPlaying = lastReportedPlaying,
        lastReportedPositionSeconds = lastReportedPositionSeconds,
        lastReportedState = lastReportedState,
    )

    @Test
    fun `a playing write equal to the last reported intent is an echo and applies nothing`() {
        // The renderer's own reports must never re-apply as authoritative
        // writes (contract: report/write loop converges via the renderer-side
        // "last reported" comparison).
        assertTrue(
            resolve(
                playing = true,
                currentState = VideoPlayerState.PLAYING,
                playWhenReady = true,
                lastReportedPlaying = true,
            ).isEmpty(),
        )
        assertTrue(
            resolve(
                playing = false,
                currentState = VideoPlayerState.PAUSED,
                playWhenReady = false,
                lastReportedPlaying = false,
            ).isEmpty(),
        )
    }

    @Test
    fun `an in-flight pre-ended struct arriving after ended is dropped whole - no restart`() {
        // Live-repro regression: the video plays to its end; the last 250ms
        // report re-resolves the struct server-side as
        // {playing: true, position: x, state: "playing"} and that SetProp
        // lands AFTER the local STATE_ENDED transition. The struct's
        // renderer-owned `state` echo proves it predates the ended report —
        // the whole struct is stale and the ended video must stay ended.
        val commands = resolve(
            playing = true,
            position = 84.25,
            stateEcho = "playing",
            currentState = VideoPlayerState.ENDED,
            playWhenReady = true, // Media3 keeps playWhenReady at STATE_ENDED
            actualPositionMs = 90_000L,
            durationMs = 90_000L,
            lastReportedPlaying = false, // the ended transition was reported
            lastReportedPositionSeconds = 90.0,
            lastReportedState = VideoPlayerState.ENDED,
        )
        assertTrue(commands.isEmpty())
    }

    @Test
    fun `the trailing ended echo is also inert`() {
        // The ended transition report itself echoes back — state matches,
        // playing and position match the last report: nothing to do.
        val commands = resolve(
            playing = false,
            position = 90.0,
            stateEcho = "ended",
            currentState = VideoPlayerState.ENDED,
            playWhenReady = true,
            actualPositionMs = 90_000L,
            durationMs = 90_000L,
            lastReportedPlaying = false,
            lastReportedPositionSeconds = 90.0,
            lastReportedState = VideoPlayerState.ENDED,
        )
        assertTrue(commands.isEmpty())
    }

    @Test
    fun `a genuine playing-true write in ended restarts from zero`() {
        // A module that saw `ended` and wrote playing: true — its struct
        // carries the current state echo and a changed intent.
        val commands = resolve(
            playing = true,
            stateEcho = "ended",
            currentState = VideoPlayerState.ENDED,
            playWhenReady = true,
            actualPositionMs = 90_000L,
            durationMs = 90_000L,
            lastReportedPlaying = false,
            lastReportedPositionSeconds = 90.0,
            lastReportedState = VideoPlayerState.ENDED,
        )
        assertEquals(listOf<PlaybackCommand>(PlaybackCommand.Restart), commands)
    }

    @Test
    fun `restart from ended yields to an accompanying explicit seek`() {
        // {playing: true, position: 30} out of `ended` seeks to 30 and plays
        // from there instead of restarting at 0 (spec).
        val commands = resolve(
            playing = true,
            position = 30.0,
            stateEcho = "ended",
            currentState = VideoPlayerState.ENDED,
            playWhenReady = true,
            actualPositionMs = 90_000L,
            durationMs = 90_000L,
            lastReportedPlaying = false,
            lastReportedPositionSeconds = 90.0,
            lastReportedState = VideoPlayerState.ENDED,
        )
        assertEquals(
            listOf(PlaybackCommand.Seek(30_000L), PlaybackCommand.Play),
            commands,
        )
    }

    @Test
    fun `first application carries positive intent only - playing false cannot cancel autoplay`() {
        // Video(autoplay: true).bind(@state.playback) with the module's
        // defineState holding playing: false — the freshly-bound struct's
        // first application must not clear playWhenReady (spec).
        val commands = resolve(
            playing = false,
            position = 0.0,
            stateEcho = "idle",
            isFirstApplication = true,
            currentState = VideoPlayerState.LOADING,
            playWhenReady = true,
            actualPositionMs = 0L,
            durationMs = -1L,
            lastReportedPlaying = true,
            lastReportedState = VideoPlayerState.LOADING,
        )
        assertTrue(commands.isEmpty())
    }

    @Test
    fun `first application honours positive intent - true plays and a position seeks`() {
        // playing: true on a non-autoplay player starts it…
        assertEquals(
            listOf<PlaybackCommand>(PlaybackCommand.Play),
            resolve(
                playing = true,
                isFirstApplication = true,
                currentState = VideoPlayerState.IDLE,
                playWhenReady = false,
                actualPositionMs = 0L,
                lastReportedPlaying = false,
                lastReportedState = VideoPlayerState.IDLE,
            ),
        )
        // …and an initialized resume position seeks.
        assertEquals(
            listOf<PlaybackCommand>(PlaybackCommand.Seek(300_000L)),
            resolve(
                position = 300.0,
                isFirstApplication = true,
                currentState = VideoPlayerState.IDLE,
                playWhenReady = false,
                actualPositionMs = 0L,
                durationMs = 600_000L,
            ),
        )
    }

    @Test
    fun `the stale-struct guard is inert on the first application`() {
        // The initial struct is the module's init, not an echo of any report
        // — a mismatched state echo ("idle" vs the already-reported
        // "loading") must not swallow its positive intent.
        assertEquals(
            listOf<PlaybackCommand>(PlaybackCommand.Play),
            resolve(
                playing = true,
                stateEcho = "idle",
                isFirstApplication = true,
                currentState = VideoPlayerState.LOADING,
                playWhenReady = false,
                actualPositionMs = 0L,
                lastReportedPlaying = false,
                lastReportedState = VideoPlayerState.LOADING,
            ),
        )
    }

    @Test
    fun `later writes are authoritative in both directions`() {
        // Pause after the first application, including mid-rebuffer where the
        // intent is engaged while `state` reports loading.
        assertEquals(
            listOf<PlaybackCommand>(PlaybackCommand.Pause),
            resolve(
                playing = false,
                stateEcho = "loading",
                currentState = VideoPlayerState.LOADING,
                playWhenReady = true,
                lastReportedPlaying = true,
                lastReportedState = VideoPlayerState.LOADING,
            ),
        )
        assertEquals(
            listOf<PlaybackCommand>(PlaybackCommand.Play),
            resolve(
                playing = true,
                stateEcho = "paused",
                currentState = VideoPlayerState.PAUSED,
                playWhenReady = false,
                lastReportedPlaying = false,
                lastReportedState = VideoPlayerState.PAUSED,
            ),
        )
    }

    @Test
    fun `a playing write matching the actual transport intent is a no-op`() {
        // Not an echo (nothing reported yet — e.g. the one-way `playing`
        // prop), but the transport already agrees: nothing to apply, and in
        // particular no restart of a loading player.
        assertTrue(
            resolve(
                playing = true,
                currentState = VideoPlayerState.LOADING,
                playWhenReady = true,
            ).isEmpty(),
        )
        assertTrue(
            resolve(
                playing = false,
                currentState = VideoPlayerState.PAUSED,
                playWhenReady = false,
            ).isEmpty(),
        )
    }

    @Test
    fun `a position write equal to the last report never seeks`() {
        // Echo guard #1 — even when it differs from the actual playhead by
        // more than the epsilon (the player moved on since that report).
        assertTrue(
            resolve(
                position = 5.0,
                actualPositionMs = 10_000L,
                lastReportedPositionSeconds = 5.0,
            ).isEmpty(),
        )
    }

    @Test
    fun `the state echo is read from the bound struct only`() {
        assertEquals("playing", playbackWriteStateEcho(mapOf("state" to "playing")))
        assertNull(playbackWriteStateEcho(mapOf("playing" to true)))
        assertNull(playbackWriteStateEcho(mapOf("state" to 3)))
        assertNull(playbackWriteStateEcho(null))
        assertNull(playbackWriteStateEcho("ended"))
    }

    // ── Rebuffer pause dispatch (intent flip, not onIsPlayingChanged) ──────

    @Test
    fun `a pause landing during a rebuffer dispatches onPause from the intent flip`() {
        // isPlaying is already false in STATE_BUFFERING, so
        // onIsPlayingChanged never fires for this pause — the playWhenReady
        // drop is the only dispatch site.
        assertTrue(
            rebufferPauseOnIntentDrop(
                playWhenReady = false,
                playbackState = Player.STATE_BUFFERING,
                playDispatched = true,
            ),
        )
    }

    @Test
    fun `a pause in READY is reported by onIsPlayingChanged, never doubled by the intent flip`() {
        assertFalse(
            rebufferPauseOnIntentDrop(
                playWhenReady = false,
                playbackState = Player.STATE_READY,
                playDispatched = true,
            ),
        )
        assertFalse(
            rebufferPauseOnIntentDrop(
                playWhenReady = false,
                playbackState = Player.STATE_ENDED,
                playDispatched = true,
            ),
        )
    }

    @Test
    fun `an unreported play is closed silently - no unpaired pause event`() {
        // Pre-roll cancel / pause during seek-while-paused buffering: no
        // onPlay was ever dispatched, so no onPause may be either.
        assertFalse(
            rebufferPauseOnIntentDrop(
                playWhenReady = false,
                playbackState = Player.STATE_BUFFERING,
                playDispatched = false,
            ),
        )
    }

    @Test
    fun `gaining intent never dispatches a pause`() {
        assertFalse(
            rebufferPauseOnIntentDrop(
                playWhenReady = true,
                playbackState = Player.STATE_BUFFERING,
                playDispatched = true,
            ),
        )
    }

    // ── Constants mirror types.ts ──────────────────────────────────────────

    @Test
    fun `the normative constants match hypen-web packages core src types ts`() {
        assertEquals(250L, PLAYBACK_REPORT_INTERVAL_MS)
        assertEquals(1.0, PLAYBACK_SEEK_EPSILON_S, 0.0)
        assertEquals(
            setOf("controls", "loading", "error", "poster"),
            VideoSlot.entries.map { it.wireName }.toSet(),
        )
        assertFalse(VideoSlot.entries.isEmpty())
    }
}
