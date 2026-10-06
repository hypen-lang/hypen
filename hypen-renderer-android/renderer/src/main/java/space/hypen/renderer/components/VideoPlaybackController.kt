package space.hypen.renderer.components

import androidx.compose.runtime.compositionLocalOf

/**
 * The enclosing Video's playback surface, published to its composition slots.
 *
 * A `Scrubber` in a `controls` slot wires itself to *this* renderer-side
 * instead of round-tripping through module state: it reads [positionMs] /
 * [durationMs] on a ticker, previews a drag locally, and on release seeks the
 * real player through [seekTo] before (separately) committing the write to
 * state. Outside a Video the composition local is null and slot-aware
 * components render inert.
 */
interface VideoPlaybackController {
    /** The enclosing Video's `.bind(@state.playback)` path, when it has one. */
    val bindPath: String?

    /** The enclosing Video's current contract state. Snapshot-backed. */
    val playerState: VideoPlayerState

    /** Live playback position in millis. */
    val positionMs: Long

    /** Media duration in millis, or 0 while unknown. */
    val durationMs: Long

    /** Seeks the underlying player immediately (renderer-local, no round trip). */
    fun seekTo(positionMs: Long)

    /**
     * Whether the enclosing Video's **container** is currently presented
     * fullscreen (see `VideoFullscreen.kt`). Presentation only — player
     * state and events are unaffected by it.
     */
    val isFullscreen: Boolean get() = false

    /**
     * Delivers a renderer-local intent (`.videoIntent("fullscreen")`) raised
     * by a node inside this Video's subtree. Default no-op so the interface
     * stays source-compatible for anything else implementing it.
     */
    fun handleVideoIntent(intent: VideoIntent) {}
}

/** Null outside a Video — see [VideoPlaybackController]. */
val LocalVideoPlaybackController = compositionLocalOf<VideoPlaybackController?> { null }

/**
 * Whether renderer-managed show/hide currently keeps this subtree visible.
 *
 * Video composition slots are hidden (alpha 0, unplaced, no semantics) but
 * stay **composed** so their state survives transitions — which means an
 * infinite animation inside a hidden slot would keep invalidating every
 * frame for the life of the player (a `loading` slot's Spinner during a
 * feature-length playback, per the doc's own example). Components that run
 * indefinite animations (e.g. [SpinnerComponent]) read this and park the
 * animation while `false`, keeping their layout slot so show/hide never
 * reflows. Defaults to `true` everywhere outside a managed show/hide scope.
 */
val LocalContentVisible = compositionLocalOf { true }
