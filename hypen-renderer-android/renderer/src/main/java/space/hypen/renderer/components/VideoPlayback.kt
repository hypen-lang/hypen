package space.hypen.renderer.components

import androidx.media3.common.Player
import space.hypen.renderer.model.ActionValue
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * Video v2 — playback state machine, `.bind(@state.playback)` wiring and
 * composition-slot visibility.
 *
 * Everything in this file is deliberately free of Compose and of ExoPlayer
 * *instances* (only Media3's compile-time `Player.STATE_*` int constants are
 * referenced), so the whole contract is unit-testable on the JVM.
 *
 * Normative source: `hypen-docs/content/docs/guide/components.mdx`
 * §"Playback control & composition slots (draft spec — v2)". The constants
 * below mirror `hypen-web/packages/core/src/types.ts` (bottom of file:
 * `PLAYBACK_REPORT_INTERVAL_MS`, `PLAYBACK_SEEK_EPSILON_S`, `VIDEO_SLOTS`,
 * `VIDEO_SLOT_VISIBILITY`) — that file is the cross-renderer authority; keep
 * the two in sync.
 */

/**
 * Normative player states. Slot visibility keys off these and the `playback`
 * bind struct reports [wireName] verbatim.
 *
 * ```
 * idle → loading → playing ⇄ paused → ended
 *                   ↘        ↙
 *                     error
 * ```
 */
enum class VideoPlayerState(val wireName: String) {
    IDLE("idle"),
    LOADING("loading"),
    PLAYING("playing"),
    PAUSED("paused"),
    ENDED("ended"),
    ERROR("error"),
}

/**
 * Renderer → state position reports are throttled to this interval while
 * playing; transitions (play/pause/seek/track change/ended/error) report
 * immediately. Mirrors `PLAYBACK_REPORT_INTERVAL_MS` in
 * `hypen-web/packages/core/src/types.ts`.
 */
const val PLAYBACK_REPORT_INTERVAL_MS: Long = 250L

/**
 * A `position` write only seeks when it differs from the renderer's actual
 * position by more than this many seconds — the echo guard that stops our own
 * progress reports from being re-applied as seeks. Mirrors
 * `PLAYBACK_SEEK_EPSILON_S` in `hypen-web/packages/core/src/types.ts`.
 */
const val PLAYBACK_SEEK_EPSILON_S: Double = 1.0

/**
 * How often a visible [ScrubberComponent] samples the enclosing player while
 * it is playing. Android-local (no cross-platform constant): the DOM renderer
 * can use rAF, Compose polls. 50 ms ≈ 20 fps of thumb movement, cheap enough
 * to run for the lifetime of a controls slot.
 */
const val SCRUBBER_POLL_INTERVAL_MS: Long = 50L

/** The `path` prefix-free bind keys reported by [PlaybackReporter]. */
const val PLAYBACK_KEY_PLAYING = "playing"
const val PLAYBACK_KEY_POSITION = "position"
const val PLAYBACK_KEY_DURATION = "duration"
const val PLAYBACK_KEY_STATE = "state"

/** The renderer → state write channel every `.bind()`-capable component uses. */
const val HYPEN_BIND_ACTION = "__hypen_bind"

/**
 * Video composition slots (children tagged `.slot(name)`).
 *
 * Declaration order here is the **paint order**, bottom to top. `types.ts`
 * lists the names as `["controls", "loading", "error", "poster"]`, which is a
 * naming order, not a z-order: the visibility table makes `poster` and
 * `controls` both visible in `ended`, so painting poster last would bury the
 * transport controls under a full-bleed still. Poster sits at the bottom,
 * error on top (it is the only slot that is ever alone).
 */
enum class VideoSlot(val wireName: String) {
    POSTER("poster"),
    LOADING("loading"),
    CONTROLS("controls"),
    ERROR("error"),
}

/** Resolves a `.slot("…")` prop value to a slot, or null when it is not one. */
fun videoSlotOf(name: String?): VideoSlot? {
    if (name == null) return null
    return VideoSlot.entries.firstOrNull { it.wireName == name }
}

/**
 * The normative slot visibility table (hypen-docs/content/docs/guide/components.mdx):
 *
 * | Slot | idle | loading | playing | paused | ended | error |
 * |---|---|---|---|---|---|---|
 * | poster | ✅ | ✅ | — | — | ✅ | — |
 * | loading | — | ✅ | — | — | — | — |
 * | controls | ✅ | — | ✅ | ✅ | ✅ | — |
 * | error | — | — | — | — | — | ✅ |
 *
 * `controls` is visible in `idle` so a custom controls slot can start first
 * play (play-button-over-poster) — without this, playback would only be
 * reachable via autoplay or module code.
 */
fun isVideoSlotVisible(slot: VideoSlot, state: VideoPlayerState): Boolean =
    when (slot) {
        VideoSlot.POSTER ->
            state == VideoPlayerState.IDLE ||
                state == VideoPlayerState.LOADING ||
                state == VideoPlayerState.ENDED
        VideoSlot.LOADING -> state == VideoPlayerState.LOADING
        // Every state but error: idle enables first play, loading keeps a
        // buffering stream's transport reachable (mirrors core types.ts).
        VideoSlot.CONTROLS -> state != VideoPlayerState.ERROR
        VideoSlot.ERROR -> state == VideoPlayerState.ERROR
    }

/**
 * Derives the contract player state from an ExoPlayer snapshot.
 *
 * - `STATE_BUFFERING` → `loading` whether or not playback had already begun:
 *   a rebuffer re-enters `loading` (and, per contract, does NOT emit
 *   `onPause` — that suppression lives in the player listener).
 * - `STATE_READY` splits on `isPlaying`, which is Media3's own
 *   `playWhenReady && !suppressed && state == READY`, so a transient audio
 *   focus suppression reads as `paused` rather than a phantom `playing`.
 * - A READY source that has never played (and carries no play intent) is
 *   `idle`, not `paused` — the contract's "ready-but-never-played is idle
 *   (poster, not spinner); `paused` requires playback to have begun".
 *   [playbackBegun] is the per-source-list "playback has begun" latch;
 *   `playWhenReady` also counts (play was requested — a suppressed start
 *   reads as `paused`, never as a phantom `idle`).
 * - `error` is sticky (the renderer clears it only when the source list
 *   changes) and outranks everything.
 * - No source at all → `idle`, matching "no src/playlist resolved".
 */
fun derivePlayerState(
    playbackState: Int,
    isPlaying: Boolean,
    playWhenReady: Boolean,
    hasError: Boolean,
    hasSource: Boolean,
    playbackBegun: Boolean,
): VideoPlayerState {
    if (hasError) return VideoPlayerState.ERROR
    if (!hasSource) return VideoPlayerState.IDLE
    return when (playbackState) {
        Player.STATE_IDLE -> VideoPlayerState.IDLE
        Player.STATE_BUFFERING -> VideoPlayerState.LOADING
        Player.STATE_ENDED -> VideoPlayerState.ENDED
        Player.STATE_READY ->
            when {
                isPlaying -> VideoPlayerState.PLAYING
                playbackBegun || playWhenReady -> VideoPlayerState.PAUSED
                else -> VideoPlayerState.IDLE
            }
        else -> if (playWhenReady) VideoPlayerState.LOADING else VideoPlayerState.IDLE
    }
}

/**
 * The `playing` field of the `playback` bind reports play INTENT, not the
 * state name: it stays `true` through a rebuffer (while `state` reports
 * `loading`) so a play/pause toggle bound to it doesn't flicker mid-stall
 * (normative report semantics). Media3's `playWhenReady` is exactly that
 * intent, masked off in the states where playback is disengaged: `ended`
 * clears it (restart is an explicit `playing: true` write), and
 * `idle`/`paused`/`error` never report an engaged player.
 */
fun playbackIntent(playWhenReady: Boolean, state: VideoPlayerState): Boolean =
    playWhenReady &&
        (state == VideoPlayerState.PLAYING || state == VideoPlayerState.LOADING)

/**
 * `loop` → Media3 repeat mode (unchanged v1 contract, extracted so the live
 * re-application in [VideoComponent] and its test share one definition):
 * a single source loops itself (`REPEAT_MODE_ONE`, no spurious track
 * transitions), a playlist wraps to track 0 (`REPEAT_MODE_ALL`, whose wrap is
 * a normal AUTO transition i.e. a `trackchange`).
 */
fun repeatModeFor(loop: Boolean, sourceCount: Int): Int =
    when {
        !loop -> Player.REPEAT_MODE_OFF
        sourceCount > 1 -> Player.REPEAT_MODE_ALL
        else -> Player.REPEAT_MODE_ONE
    }

/** Media3 millis (incl. `C.TIME_UNSET`) → contract seconds; unknown is 0. */
fun mediaMsToSeconds(ms: Long): Double = if (ms <= 0L) 0.0 else ms / 1000.0

/** A snapshot of the four `playback` struct fields, in contract units. */
data class PlaybackReport(
    val playing: Boolean,
    val positionSeconds: Double,
    val durationSeconds: Double,
    val state: VideoPlayerState,
)

/** One `__hypen_bind` write: `path` becomes `"<bindPath>.<key>"`. */
data class BindWrite(val key: String, val value: Any)

/**
 * Decides which `playback` fields to write back to state, and when.
 *
 * - `playing` / `state` / `duration` are written the moment they change.
 * - `position` is written at most every [intervalMs] while playing, but a
 *   transition (play, pause, seek completion, track change, ended, error)
 *   bypasses the throttle.
 * - [lastPositionSeconds] is kept so the renderer can recognise its own
 *   report coming back as a write and refuse to re-apply it as a seek.
 *
 * Instances are stateful and single-threaded (Compose main thread).
 */
class PlaybackReporter(private val intervalMs: Long = PLAYBACK_REPORT_INTERVAL_MS) {
    var lastPlaying: Boolean? = null
        private set
    var lastPositionSeconds: Double? = null
        private set
    var lastDurationSeconds: Double? = null
        private set
    var lastState: VideoPlayerState? = null
        private set

    private var lastPositionAtMs: Long = 0L
    private var positionEverReported = false

    fun report(report: PlaybackReport, nowMs: Long, transition: Boolean): List<BindWrite> {
        val writes = ArrayList<BindWrite>(4)

        if (lastPlaying != report.playing) {
            lastPlaying = report.playing
            writes.add(BindWrite(PLAYBACK_KEY_PLAYING, report.playing))
        }
        if (lastState != report.state) {
            lastState = report.state
            writes.add(BindWrite(PLAYBACK_KEY_STATE, report.state.wireName))
        }
        if (lastDurationSeconds != report.durationSeconds) {
            lastDurationSeconds = report.durationSeconds
            writes.add(BindWrite(PLAYBACK_KEY_DURATION, report.durationSeconds))
        }

        val positionChanged = lastPositionSeconds != report.positionSeconds
        val throttleElapsed = !positionEverReported || nowMs - lastPositionAtMs >= intervalMs
        if (positionChanged && (transition || throttleElapsed)) {
            lastPositionSeconds = report.positionSeconds
            lastPositionAtMs = nowMs
            positionEverReported = true
            writes.add(BindWrite(PLAYBACK_KEY_POSITION, report.positionSeconds))
        }

        return writes
    }
}

/**
 * The writable half of an inbound `playback` struct. `duration`/`state`
 * writes are ignored per contract, so they are not represented.
 */
data class PlaybackWrite(val playing: Boolean?, val positionSeconds: Double?)

/**
 * Parses the inbound `playback` prop (the resolved `@state.playback` map).
 * Returns null when the prop is absent or is not a map — a scalar there is a
 * module bug, not something to guess at.
 */
fun parsePlaybackWrite(value: Any?): PlaybackWrite? {
    val map = value as? Map<*, *> ?: return null
    val playing =
        when (val raw = map[PLAYBACK_KEY_PLAYING]) {
            is Boolean -> raw
            is String -> raw.toBooleanStrictOrNull()
            else -> null
        }
    val position =
        when (val raw = map[PLAYBACK_KEY_POSITION]) {
            is Number -> raw.toDouble()
            is String -> raw.toDoubleOrNull()
            else -> null
        }
    return PlaybackWrite(playing, position?.takeIf { !it.isNaN() })
}

/**
 * The effective inbound write for a render pass: the full `playback` struct
 * when one is bound, else the one-way controlled subset (`playing:
 * @{state.isPlaying}` as a plain prop — "module drives, renderer follows",
 * with renderer-initiated changes surfacing only through events).
 */
fun playbackWriteFrom(playbackProp: Any?, playingProp: Boolean?): PlaybackWrite? =
    parsePlaybackWrite(playbackProp) ?: playingProp?.let { PlaybackWrite(it, null) }

/**
 * The read-only `state` field of an inbound `playback` struct.
 *
 * The renderer owns that field (writes to it are ignored), so its value in an
 * inbound struct is purely the reflection of the renderer's own reports — a
 * causality marker: a struct whose `state` echo does not match the state the
 * renderer last reported was resolved server-side BEFORE that report landed,
 * i.e. the whole struct is an in-flight echo of older reports, not a module
 * decision made against current reality. See [resolvePlaybackCommands].
 */
fun playbackWriteStateEcho(playbackProp: Any?): String? =
    (playbackProp as? Map<*, *>)?.get(PLAYBACK_KEY_STATE) as? String

/** A write the renderer must perform on the player, in list order. */
sealed interface PlaybackCommand {
    /** Seek to this position (an explicit `position` write). */
    data class Seek(val targetMs: Long) : PlaybackCommand

    /** Engage playback (`playing: true`). */
    data object Play : PlaybackCommand

    /** `playing: true` written while `ended` — seek to 0/track 0, then play. */
    data object Restart : PlaybackCommand

    /** Disengage playback (`playing: false`). */
    data object Pause : PlaybackCommand
}

/**
 * The normative write semantics of the playback bind (state → renderer),
 * resolved against the renderer's actual transport state and its own report
 * history (hypen-docs/content/docs/guide/components.mdx §"Playback control & composition slots").
 *
 * - **Stale-struct guard**: reports are plain state mutations and every one
 *   re-resolves the bound struct back to the renderer, so an in-flight struct
 *   can arrive carrying pre-transition values. Because the renderer owns the
 *   struct's read-only `state` field, [stateEcho] not matching
 *   [lastReportedState] proves the struct predates the renderer's last report
 *   — the whole struct is dropped. Nothing genuine is lost: that very report,
 *   landing server-side, re-resolves the struct and re-delivers any module
 *   write with a current `state` echo. This is what keeps an in-flight
 *   `{playing: true}` arriving after a local `ended` transition from
 *   restarting the video (spec: reports "MUST NOT be echoed back to the
 *   renderer as writes").
 * - **`playing` echo guard**: a value equal to the play intent the renderer
 *   last reported is its own report coming back, never a command.
 * - **Transport comparison**: `playing` equal to the actual current intent is
 *   a no-op (a `true` against a `loading` player that already intends to play
 *   must not restart anything).
 * - **Restart**: `playing: true` in `ended` restarts from 0 — but yields to
 *   an accompanying explicit seek (`{playing: true, position: n}` out of
 *   `ended` seeks to `n` and plays from there).
 * - **`position`**: ignored when it is exactly [lastReportedPositionSeconds]
 *   (echo guard #1), then held against the 1 s epsilon + clamp in
 *   [seekTargetMs] (guard #2).
 * - **First application** ([isFirstApplication]): a freshly-bound struct
 *   carries **positive intent only** — a module's initialized
 *   `playing: false` is indistinguishable from "unset" and must not cancel
 *   `autoplay`; a `true` plays and a `position` seeks. The stale-struct guard
 *   is also inert here (the initial struct is the module's init, not an echo).
 *   Every later write is authoritative in both directions.
 */
fun resolvePlaybackCommands(
    write: PlaybackWrite,
    stateEcho: String?,
    isFirstApplication: Boolean,
    currentState: VideoPlayerState,
    playWhenReady: Boolean,
    actualPositionMs: Long,
    durationMs: Long,
    lastReportedPlaying: Boolean?,
    lastReportedPositionSeconds: Double?,
    lastReportedState: VideoPlayerState?,
): List<PlaybackCommand> {
    if (!isFirstApplication &&
        stateEcho != null &&
        lastReportedState != null &&
        stateEcho != lastReportedState.wireName
    ) {
        return emptyList()
    }

    val commands = ArrayList<PlaybackCommand>(2)

    write.positionSeconds?.let { requested ->
        // Echo guard #1: the exact value we last reported is our own
        // progress coming back, never a seek. Guard #2 is the 1s epsilon
        // inside seekTargetMs.
        if (requested != lastReportedPositionSeconds) {
            seekTargetMs(
                requestedSeconds = requested,
                actualPositionMs = actualPositionMs,
                durationMs = durationMs,
            )?.let { commands.add(PlaybackCommand.Seek(it)) }
        }
    }
    val seeking = commands.isNotEmpty()

    write.playing?.let { desired ->
        // Echo guard: the intent we last reported, coming back around.
        if (lastReportedPlaying != null && desired == lastReportedPlaying) return@let
        val currentIntent = playbackIntent(playWhenReady, currentState)
        if (desired) {
            when {
                currentState == VideoPlayerState.ENDED ->
                    // Restart from 0 — unless an explicit seek accompanies
                    // the write, which then sets the resume point.
                    commands.add(if (seeking) PlaybackCommand.Play else PlaybackCommand.Restart)
                !currentIntent -> commands.add(PlaybackCommand.Play)
            }
        } else if (!isFirstApplication && currentIntent) {
            commands.add(PlaybackCommand.Pause)
        }
    }

    return commands
}

/**
 * Whether a `playWhenReady` drop must dispatch `onPause` itself.
 *
 * `isPlaying` is already false during `STATE_BUFFERING`, so a pause landing
 * mid-rebuffer never fires `onIsPlayingChanged` — the intent flip is the only
 * signal. It closes a play only when one was actually dispatched
 * ([playDispatched]): a pause during a never-reported play (pre-roll cancel,
 * seek-while-paused buffering) stays silent, so modules tracking playback
 * through events never see an unpaired `pause`.
 */
fun rebufferPauseOnIntentDrop(
    playWhenReady: Boolean,
    playbackState: Int,
    playDispatched: Boolean,
): Boolean =
    !playWhenReady && playbackState == Player.STATE_BUFFERING && playDispatched

/**
 * Resolves a `position` write to an actual seek target in millis, or null
 * when the write must be ignored.
 *
 * Clamped to `[0, duration]` (the upper clamp only once the duration is
 * known), then held against the [epsilonSeconds] guard: a difference of one
 * second or less is the echo of our own progress report and never seeks.
 */
fun seekTargetMs(
    requestedSeconds: Double,
    actualPositionMs: Long,
    durationMs: Long,
    epsilonSeconds: Double = PLAYBACK_SEEK_EPSILON_S,
): Long? {
    if (requestedSeconds.isNaN()) return null
    var clamped = requestedSeconds.coerceAtLeast(0.0)
    if (durationMs > 0L) clamped = clamped.coerceAtMost(durationMs / 1000.0)
    val targetMs = (clamped * 1000.0).roundToLong()
    if (abs(targetMs - actualPositionMs) <= (epsilonSeconds * 1000.0).roundToLong()) return null
    return targetMs
}

/** A dispatch the Scrubber makes on drag release. */
data class ScrubberCommit(val action: String, val payload: Map<String, Any?>)

/**
 * Commit-target bind path resolution (normative precedence): the Scrubber's
 * OWN `.bind(...)` wins, else the enclosing Video's bind. `onSeek` is only
 * consulted (inside [scrubberCommit]) when neither bind exists.
 */
fun scrubberBindPath(ownBindPath: String?, videoBindPath: String?): String? =
    ownBindPath ?: videoBindPath

/**
 * Where a scrubber release commits to.
 *
 * `bindPath` — the Scrubber's own `.bind(@state.playback)` if it has one,
 * else the enclosing Video's — takes precedence and writes
 * `<bindPath>.position` through the `__hypen_bind` channel. Bound-less
 * scrubbers fall back to their `onSeek` action with the contract payload.
 * Returns null when neither exists, or when the duration is still unknown
 * (a fraction of an unknown timeline is not a position).
 *
 * The local seek happens regardless — this only covers what crosses the wire.
 */
fun scrubberCommit(
    fraction: Float,
    durationMs: Long,
    bindPath: String?,
    onSeek: ActionValue?,
): ScrubberCommit? {
    if (durationMs <= 0L) return null
    val positionSeconds = scrubberPositionMs(fraction, durationMs) / 1000.0
    return when {
        bindPath != null ->
            ScrubberCommit(
                HYPEN_BIND_ACTION,
                mapOf("path" to "$bindPath.$PLAYBACK_KEY_POSITION", "value" to positionSeconds),
            )
        onSeek != null ->
            ScrubberCommit(
                onSeek.actionName,
                mapOf("type" to "seek", "position" to positionSeconds) + onSeek.payload,
            )
        else -> null
    }
}

/** Drag fraction → seek target in millis, clamped to the timeline. */
fun scrubberPositionMs(fraction: Float, durationMs: Long): Long {
    if (durationMs <= 0L) return 0L
    return (fraction.coerceIn(0f, 1f).toDouble() * durationMs).roundToLong()
}

/** Progress fraction for the scrubber track; 0 while the duration is unknown. */
fun scrubberFraction(positionMs: Long, durationMs: Long): Float {
    if (durationMs <= 0L) return 0f
    return (positionMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
}

/** `mm:ss` (or `h:mm:ss`) timecode for the scrubber's TalkBack state description. */
fun formatTimecode(ms: Long): String {
    val totalSeconds = if (ms <= 0L) 0L else ms / 1000L
    val hours = totalSeconds / 3600L
    val minutes = (totalSeconds % 3600L) / 60L
    val seconds = totalSeconds % 60L
    // Built by hand rather than String.format: no locale in play, so a
    // timecode reads the same under every default locale (and TalkBack).
    val ss = seconds.toString().padStart(2, '0')
    return if (hours > 0L) {
        "$hours:${minutes.toString().padStart(2, '0')}:$ss"
    } else {
        "$minutes:$ss"
    }
}
