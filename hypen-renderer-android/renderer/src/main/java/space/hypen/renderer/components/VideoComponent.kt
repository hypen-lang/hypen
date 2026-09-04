package space.hypen.renderer.components

import android.os.SystemClock
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import space.hypen.renderer.HypenElement
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement as HypenElementModel
import space.hypen.renderer.render.ComposeRenderer
import space.hypen.renderer.render.LocalActionDispatcher
import space.hypen.renderer.render.LocalComposeRenderer

/**
 * Handler for Video components — implements the cross-platform Video contract
 * (see hypen-docs/content/docs/guide/components.mdx). Uses Media3 ExoPlayer.
 *
 * Sources (only resolved streamable URLs ever cross the wire):
 *   Video(src: "https://.../movie.mp4", controls: true)
 *   Video(playlist: ["https://cdn/ep1.mp4", "https://cdn/ep2.mp4"], startIndex: 1)
 *   Video(src: "@{state.streamUrl}", headers: {"Authorization": "Bearer ..."})
 *
 * A non-empty `playlist` supersedes `src` and auto-advances between tracks.
 * `headers` are applied to media fetches via DefaultHttpDataSource.
 *
 * Events (optional action props): onPlay / onPause / onEnded / onTrackChange /
 * onError, dispatched through the ActionDispatcher with the contract payloads.
 *
 * ## v2 (docs §"Playback control & composition slots")
 *
 * - A contract player state (idle/loading/playing/paused/ended/error) is
 *   derived from the ExoPlayer callbacks by [derivePlayerState].
 * - `.bind(@state.playback)` two-way binds the `{playing, position, duration,
 *   state}` struct: reports go out on the `__hypen_bind` channel (position
 *   throttled to [PLAYBACK_REPORT_INTERVAL_MS], transitions immediate),
 *   inbound writes play/pause and seek through [resolvePlaybackCommands]
 *   (echo + stale-struct guards, first-application positive intent, the
 *   [PLAYBACK_SEEK_EPSILON_S] seek epsilon).
 * - `startPosition: n` seeks once when the source first becomes ready.
 * - Children tagged `.slot("controls"|"loading"|"error"|"poster")` are
 *   overlaid full-bleed on the video surface, shown/hidden strictly per the
 *   [isVideoSlotVisible] table. A present slot replaces the built-in for that
 *   concern; slot subtrees stay composed across transitions so their state
 *   survives.
 */
class VideoComponent : ComponentHandler {
    override val typeName: String = "video"

    @OptIn(UnstableApi::class)
    @Composable
    override fun Render(
        element: HypenElementModel,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val context = LocalContext.current
        val dispatcher = LocalActionDispatcher.current
        val renderer = LocalComposeRenderer.current

        // ── Sources ────────────────────────────────────────────────────────
        val src = element.getStringProp("0")
            ?: element.getStringProp("src")
            ?: element.getStringProp("source")

        // Non-empty playlist supersedes src (contract).
        val playlist = element.getStringListProp("playlist") ?: emptyList()
        val sources = if (playlist.isNotEmpty()) playlist else src?.let { listOf(it) } ?: emptyList()

        val startIndex = element.getIntProp("startIndex")
            ?: element.getIntProp("startIndex.0")
            ?: 0

        // Extra HTTP request headers for media fetches (auth-protected streams).
        val headers = element.getStringMapProp("headers")

        // ── Flags ──────────────────────────────────────────────────────────
        val showControls = element.getBoolProp("controls")
            ?: element.getBoolProp("controls.0")
            ?: false

        val autoplay = element.getBoolProp("autoplay")
            ?: element.getBoolProp("autoplay.0")
            ?: false

        val loop = element.getBoolProp("loop")
            ?: element.getBoolProp("loop.0")
            ?: false

        val muted = element.getBoolProp("muted")
            ?: element.getBoolProp("muted.0")
            ?: false

        val poster = element.getStringProp("poster")
            ?: element.getStringProp("poster.0")

        // ── v2 playback control ────────────────────────────────────────────
        // `.bind(@state.playback)` lowers to two props: the resolved struct
        // under `playback`, and the state path under `bind`.
        val bindPath = element.getStringProp("bind")
        val playbackProp = element.props["playback"] ?: element.props["playback.0"]

        // One-way controlled subset: `playing: @{state.isPlaying}` as a plain
        // prop, used only when no `playback` struct is bound.
        val playingProp = element.getBoolProp("playing") ?: element.getBoolProp("playing.0")

        // Create-time resume point, applied once when the source is seekable.
        val startPositionSeconds = element.getDoubleProp("startPosition")
            ?: element.getDoubleProp("startPosition.0")

        // ── Composition slots ──────────────────────────────────────────────
        // Looked up at call time (like HypenAppComponent's HostSlot) so a slot
        // subtree that appears reactively is picked up. Untagged children stay
        // invalid — Video is a leaf for ordinary children.
        val slotChildren: List<Pair<VideoSlot, HypenElementModel>> = renderer
            ?.getChildren(element.id)
            ?.mapNotNull { child ->
                val name = child.getStringProp("slot.0") ?: child.getStringProp("slot")
                videoSlotOf(name)?.let { it to child }
            }
            .orEmpty()
        val hasControlsSlot = slotChildren.any { it.first == VideoSlot.CONTROLS }
        val hasErrorSlot = slotChildren.any { it.first == VideoSlot.ERROR }
        val hasPosterSlot = slotChildren.any { it.first == VideoSlot.POSTER }

        // ── Event action props ─────────────────────────────────────────────
        val onPlayAction by rememberUpdatedState(parseActionProp(element, "onPlay"))
        val onPauseAction by rememberUpdatedState(parseActionProp(element, "onPause"))
        val onEndedAction by rememberUpdatedState(parseActionProp(element, "onEnded"))
        val onTrackChangeAction by rememberUpdatedState(parseActionProp(element, "onTrackChange"))
        val onErrorAction by rememberUpdatedState(parseActionProp(element, "onError"))

        if (sources.isEmpty()) {
            // No src and no playlist — empty placeholder box, no crash, no dispatch.
            Box(modifier = modifier)
            return
        }

        val clampedStart = startIndex.coerceIn(0, sources.size - 1)

        // Stable keys: the player must rebuild when the sources or headers
        // change, but NOT on unrelated recompositions of this element.
        // Separators are control characters that cannot occur in a URL or a
        // header value, so no two distinct source/header sets collide on one
        // key (written as escapes so the file stays plain text).
        val playlistKey = sources.joinToString("\u0000")
        val headersKey = headers?.entries
            ?.joinToString("\u0000") { "${it.key}\u0001${it.value}" }
            ?: ""

        // Quiet error state: once playback fails we show poster/black (or the
        // `error` slot) instead of a broken surface. It is the sticky `error`
        // player state, and resets when the sources/headers change.
        var hadError by remember(playlistKey, headersKey) { mutableStateOf(false) }

        // Pre-playback poster: ExoPlayer shows a black surface until the first
        // frame is rendered, so the poster (when provided) is overlaid from
        // composition until onRenderedFirstFrame. Initial load only — a
        // playlist advancing to a new track does NOT re-show the poster
        // (matching web <video poster> semantics). Resets when the
        // sources/headers change, same keying as the error state.
        var firstFrameRendered by remember(playlistKey, headersKey) { mutableStateOf(false) }

        // `startPosition` is a create-time seek: applied on the first READY
        // for this source list, never again.
        var startSeekApplied by remember(playlistKey, headersKey) { mutableStateOf(false) }

        // "Playback has begun" latch for this source list: a READY player that
        // never played (and holds no play intent) is `idle`, not `paused` —
        // ready-but-never-played shows the poster, and `paused` requires
        // playback to have begun (contract).
        var playbackBegun by remember(playlistKey, headersKey) { mutableStateOf(false) }

        // The contract player state, derived from the player callbacks below.
        val playerStateHolder = remember(playlistKey, headersKey) {
            mutableStateOf(VideoPlayerState.IDLE)
        }
        var playerState by playerStateHolder

        // Bumped by events that must report immediately even though the state
        // name did not change (seek completion, track change) — it is a key of
        // the reporting effect, so the bump forces a transition report.
        var transitionEpoch by remember(playlistKey, headersKey) { mutableIntStateOf(0) }

        val dispatchEvent: (ActionValue?, Map<String, Any?>) -> Unit = { action, payload ->
            if (action != null && dispatcher != null) {
                dispatcher.dispatch(action.actionName, payload + action.payload)
            }
        }

        val exoPlayer = remember(playlistKey, headersKey) {
            val builder = ExoPlayer.Builder(context)
            if (!headers.isNullOrEmpty()) {
                // Contract: headers applied via
                // DefaultHttpDataSource.Factory().setDefaultRequestProperties(headers).
                // Only build a custom factory when headers are present.
                val dataSourceFactory = DefaultHttpDataSource.Factory()
                    .setDefaultRequestProperties(headers)
                builder.setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            }
            builder.build().apply {
                setMediaItems(sources.map { MediaItem.fromUri(it) }, clampedStart, 0L)
                repeatMode = repeatModeFor(loop, sources.size)
                volume = if (muted) 0f else 1f
                playWhenReady = autoplay
                prepare()
            }
        }

        // `muted` / `loop` are live: v2 makes `playing`/`position` live through
        // the bind, so leaving these create-time-only would be inconsistent.
        LaunchedEffect(exoPlayer, muted) {
            exoPlayer.volume = if (muted) 0f else 1f
        }
        LaunchedEffect(exoPlayer, loop, sources.size) {
            exoPlayer.repeatMode = repeatModeFor(loop, sources.size)
        }

        // Wire contract events + clean up player when composable is disposed.
        DisposableEffect(exoPlayer) {
            fun syncState() {
                if (exoPlayer.isPlaying) playbackBegun = true
                playerStateHolder.value = derivePlayerState(
                    playbackState = exoPlayer.playbackState,
                    isPlaying = exoPlayer.isPlaying,
                    playWhenReady = exoPlayer.playWhenReady,
                    hasError = hadError,
                    hasSource = true,
                    playbackBegun = playbackBegun,
                )
            }

            val listener = object : Player.Listener {
                // Playlist index of the track currently loaded, tracked so a
                // transition can report the *finished* track in its onEnded.
                var lastIndex: Int = exoPlayer.currentMediaItemIndex

                // Whether an onPlay was dispatched with no closing onPause /
                // queue end yet — the intent-flip pause below only ever
                // closes a play that was actually reported.
                var playDispatched: Boolean = false

                fun srcAt(index: Int): String? = sources.getOrNull(index)

                fun dispatchPause() {
                    playDispatched = false
                    val index = exoPlayer.currentMediaItemIndex
                    dispatchEvent(
                        onPauseAction,
                        mapOf("type" to "pause", "src" to srcAt(index), "index" to index),
                    )
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    syncState()
                    if (isPlaying) {
                        playDispatched = true
                        val index = exoPlayer.currentMediaItemIndex
                        dispatchEvent(
                            onPlayAction,
                            mapOf("type" to "play", "src" to srcAt(index), "index" to index),
                        )
                    } else {
                        // Not-playing due to end-of-queue is reported via
                        // onEnded, and a transient rebuffer (playWhenReady
                        // still true) is not a pause — skip both. The state
                        // machine still moves to `loading` for the rebuffer;
                        // only the event is suppressed (contract: "Rebuffer
                        // re-enters loading without emitting onPause").
                        val state = exoPlayer.playbackState
                        val isRebuffer = state == Player.STATE_BUFFERING && exoPlayer.playWhenReady
                        if (state != Player.STATE_ENDED && !isRebuffer) {
                            dispatchPause()
                        }
                    }
                }

                override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                    syncState()
                    // A pause landing while the player is rebuffering never
                    // flips isPlaying (already false in STATE_BUFFERING), so
                    // onIsPlayingChanged cannot report it — the intent flip
                    // itself must dispatch onPause. Guarded so it only closes
                    // a play that was actually reported, and never doubles a
                    // pause onIsPlayingChanged will report (READY flips
                    // isPlaying, BUFFERING does not).
                    if (rebufferPauseOnIntentDrop(
                            playWhenReady = playWhenReady,
                            playbackState = exoPlayer.playbackState,
                            playDispatched = playDispatched,
                        )
                    ) {
                        dispatchPause()
                    }
                    // Play intent is a reported field (`playing`), and it can
                    // flip without the state name changing — a pause landing
                    // mid-rebuffer keeps `state` at `loading` while `playing`
                    // must go false immediately. Bump the epoch so the report
                    // effect re-runs even when the derived state is unchanged.
                    transitionEpoch++
                }

                override fun onPositionDiscontinuity(
                    oldPosition: Player.PositionInfo,
                    newPosition: Player.PositionInfo,
                    reason: Int,
                ) {
                    // Seek completion / track boundary: report position now
                    // rather than at the next throttle tick.
                    transitionEpoch++
                }

                override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                    val newIndex = exoPlayer.currentMediaItemIndex
                    val previousIndex = lastIndex
                    lastIndex = newIndex
                    transitionEpoch++
                    if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) return

                    // An AUTO transition means the previous track played to
                    // completion — per contract, its onEnded (completed:false,
                    // the queue isn't done) fires before the trackchange.
                    dispatchEvent(
                        onEndedAction,
                        mapOf(
                            "type" to "ended",
                            "src" to srcAt(previousIndex),
                            "index" to previousIndex,
                            "completed" to false,
                        ),
                    )
                    dispatchEvent(
                        onTrackChangeAction,
                        mapOf("type" to "trackchange", "src" to srcAt(newIndex), "index" to newIndex),
                    )
                }

                override fun onPlaybackStateChanged(playbackState: Int) {
                    syncState()

                    if (playbackState == Player.STATE_READY && !startSeekApplied) {
                        startSeekApplied = true
                        val startMs = startPositionSeconds
                            ?.takeIf { it > 0.0 }
                            ?.let { (it * 1000.0).toLong() }
                        if (startMs != null) exoPlayer.seekTo(startMs)
                    }

                    if (playbackState != Player.STATE_ENDED) return
                    // Ended closes the reported play — a later intent flip in
                    // `ended` must not dispatch a pause after the onEnded.
                    playDispatched = false
                    // Whole queue finished (single src without loop included).
                    val index = exoPlayer.currentMediaItemIndex
                    dispatchEvent(
                        onEndedAction,
                        mapOf(
                            "type" to "ended",
                            "src" to srcAt(index),
                            "index" to index,
                            "completed" to true,
                        ),
                    )
                }

                override fun onRenderedFirstFrame() {
                    // First frame is on the surface — drop the poster overlay.
                    // Never reset here (poster is for initial load only).
                    firstFrameRendered = true
                }

                override fun onPlayerError(error: PlaybackException) {
                    val index = exoPlayer.currentMediaItemIndex
                    val status = findHttpStatus(error)
                    val payload = buildMap<String, Any?> {
                        put("type", "error")
                        put("src", srcAt(index))
                        put("index", index)
                        // `status` only when the platform could determine the
                        // HTTP status code (contract: omitted when unknown).
                        if (status != null) put("status", status)
                        put("code", error.errorCode)
                        put("message", error.message ?: error.errorCodeName)
                    }
                    dispatchEvent(onErrorAction, payload)
                    hadError = true
                    syncState()
                }
            }
            exoPlayer.addListener(listener)
            syncState()

            onDispose {
                exoPlayer.removeListener(listener)
                exoPlayer.release()
            }
        }

        // ── Report: renderer → @state.playback ─────────────────────────────
        val reporter = remember(playlistKey, headersKey, bindPath) { PlaybackReporter() }
        LaunchedEffect(exoPlayer, bindPath, playerState, transitionEpoch) {
            if (bindPath == null || dispatcher == null) return@LaunchedEffect

            fun flush(transition: Boolean) {
                val report = PlaybackReport(
                    // Play INTENT, not the state name: stays true through a
                    // rebuffer while `state` reports `loading` (contract).
                    playing = playbackIntent(exoPlayer.playWhenReady, playerStateHolder.value),
                    positionSeconds = mediaMsToSeconds(exoPlayer.currentPosition),
                    durationSeconds = mediaMsToSeconds(exoPlayer.duration),
                    state = playerStateHolder.value,
                )
                for (write in reporter.report(report, SystemClock.elapsedRealtime(), transition)) {
                    dispatcher.dispatch(
                        HYPEN_BIND_ACTION,
                        mapOf("path" to "$bindPath.${write.key}", "value" to write.value),
                    )
                }
            }

            // A state change (or a seek/track-change epoch bump) is a
            // transition: report immediately, throttle-free.
            flush(transition = true)
            while (playerStateHolder.value == VideoPlayerState.PLAYING) {
                delay(PLAYBACK_REPORT_INTERVAL_MS)
                flush(transition = false)
            }
        }

        // ── Write: @state.playback → renderer ──────────────────────────────
        // First application of a freshly-bound struct carries positive intent
        // only (contract) — re-arms with the source configuration, where the
        // player (and the bind against it) is rebuilt.
        var firstWriteApplied by remember(playlistKey, headersKey, bindPath) {
            mutableStateOf(false)
        }
        LaunchedEffect(exoPlayer, playbackProp, playingProp) {
            val write = playbackWriteFrom(playbackProp, playingProp) ?: return@LaunchedEffect
            val isFirstApplication = !firstWriteApplied
            firstWriteApplied = true

            // All write semantics — echo guards (the renderer's own reports
            // must never re-apply as authoritative writes), the stale-struct
            // causality guard, first-application positive intent, seek epsilon
            // + clamp, and restart-from-ended yielding to an accompanying
            // explicit seek — live in resolvePlaybackCommands (unit-tested).
            val commands = resolvePlaybackCommands(
                write = write,
                stateEcho = playbackWriteStateEcho(playbackProp),
                isFirstApplication = isFirstApplication,
                currentState = playerStateHolder.value,
                playWhenReady = exoPlayer.playWhenReady,
                actualPositionMs = exoPlayer.currentPosition,
                durationMs = exoPlayer.duration,
                lastReportedPlaying = reporter.lastPlaying,
                lastReportedPositionSeconds = reporter.lastPositionSeconds,
                lastReportedState = reporter.lastState,
            )
            for (command in commands) {
                when (command) {
                    is PlaybackCommand.Seek -> exoPlayer.seekTo(command.targetMs)
                    PlaybackCommand.Play -> exoPlayer.play()
                    PlaybackCommand.Restart -> {
                        exoPlayer.seekTo(0, 0L)
                        exoPlayer.play()
                    }
                    PlaybackCommand.Pause -> exoPlayer.pause()
                }
            }
        }

        // Renderer-local fullscreen (`.videoIntent("fullscreen")`), a
        // presentation flag on the container — see VideoFullscreen.kt. Kept
        // outside the source keying so a live `src` swap does not drop the
        // viewer out of fullscreen.
        val fullscreenHolder = remember { mutableStateOf(false) }

        // The surface slot content wires itself to (Scrubber reads position
        // and seeks through this without touching module state; a
        // `videoIntent` node toggles the container's fullscreen through it).
        val controller = remember(exoPlayer, bindPath) {
            object : VideoPlaybackController {
                override val bindPath: String? = bindPath
                override val playerState: VideoPlayerState get() = playerStateHolder.value
                override val positionMs: Long get() = exoPlayer.currentPosition
                override val durationMs: Long
                    get() = exoPlayer.duration.let { if (it <= 0L) 0L else it }

                override fun seekTo(positionMs: Long) {
                    exoPlayer.seekTo(positionMs.coerceAtLeast(0L))
                }

                override val isFullscreen: Boolean get() = fullscreenHolder.value

                override fun handleVideoIntent(intent: VideoIntent) {
                    fullscreenHolder.value = applyVideoIntent(
                        current = fullscreenHolder.value,
                        intent = intent,
                        // Reached through this Video's own controller, so by
                        // construction the node is inside a Video subtree.
                        insideVideo = true,
                    )
                }
            }
        }

        // ONE PlayerView for the life of the player, re-parented between the
        // in-page host and the fullscreen window instead of being rebuilt
        // there. A second view bound to the same ExoPlayer would fight over
        // the video surface; a rebuilt one would re-attach a fresh surface
        // mid-playback. The player itself is never touched by fullscreen, so
        // position, buffer and play intent all survive the transition.
        val playerView = remember(exoPlayer) {
            PlayerView(context).apply {
                player = exoPlayer
                // Initial value; the AndroidView `update` block owns it from
                // then on (PlayerView defaults to true, which would flash
                // native chrome under a `controls` slot for one frame).
                useController = showControls && !hasControlsSlot
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
            }
        }

        val containerContent: @Composable BoxScope.() -> Unit = {
            if (hadError) {
                // Quiet error state: poster (when provided) over a black
                // surface — never a spinner, never a crash. The module
                // decides what to do next in its onError handler. An `error`
                // slot replaces this built-in surface entirely.
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black),
                ) {
                    if (poster != null && !hasErrorSlot && !hasPosterSlot) {
                        AsyncImage(
                            model = poster,
                            contentDescription = null,
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Fit,
                        )
                    }
                }
            } else {
                AndroidView(
                    factory = {
                        // Re-parenting host: the previous host may not have
                        // been torn down yet when fullscreen swaps the two,
                        // and a View may only have one parent.
                        (playerView.parent as? ViewGroup)?.removeView(playerView)
                        playerView
                    },
                    update = { view ->
                        view.player = exoPlayer
                        // A `controls` slot suppresses native chrome
                        // regardless of the `controls` prop (contract). The
                        // built-in fullscreen button is deliberately never
                        // used — `.videoIntent("fullscreen")` targets the
                        // container, native chrome would replace the slots.
                        view.useController = showControls && !hasControlsSlot
                    },
                    modifier = Modifier.fillMaxSize(),
                )
                if (poster != null && !hasPosterSlot && !firstFrameRendered) {
                    // Poster overlay until the first rendered frame. It leaves
                    // composition entirely once the frame lands, so it can
                    // never block PlayerView's tap-to-show-controls afterwards.
                    // While shown it carries no pointer-input modifiers, so
                    // Compose does not hit-test it and touches fall through to
                    // the PlayerView underneath. A `poster` slot replaces it.
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(Color.Black),
                    ) {
                        AsyncImage(
                            model = poster,
                            contentDescription = null,
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop,
                        )
                    }
                }
            }

            if (slotChildren.isNotEmpty() && renderer != null) {
                CompositionLocalProvider(LocalVideoPlaybackController provides controller) {
                    VideoSlotOverlay(
                        slotChildren = slotChildren,
                        state = playerState,
                        renderer = renderer,
                    )
                }
            }
        }

        // In page, or filling the window with the same container content
        // (surface + slots) — see VideoFullscreen.kt.
        VideoFullscreenContainer(
            fullscreen = fullscreenHolder.value,
            modifier = modifier,
            onExitRequest = { fullscreenHolder.value = false },
            content = containerContent,
        )
    }

    /**
     * Reads an optional action prop (`@actions.name` string or object form),
     * accepting both the bare name and the `.0` wire-suffix variant.
     */
    private fun parseActionProp(element: HypenElementModel, name: String): ActionValue? {
        val raw = element.props[name] ?: element.props["$name.0"] ?: return null
        return ActionValue.parse(raw)
    }

    /**
     * Walks the cause chain of a playback error looking for an HTTP response
     * code (contract: Media3 `HttpDataSource.InvalidResponseCodeException.responseCode`).
     */
    @OptIn(UnstableApi::class)
    private fun findHttpStatus(error: Throwable?): Int? {
        var cause: Throwable? = error
        while (cause != null) {
            if (cause is HttpDataSource.InvalidResponseCodeException) {
                return cause.responseCode
            }
            cause = cause.cause
        }
        return null
    }
}

/**
 * The slot stack painted over the video surface, bottom to top in
 * [VideoSlot] order. Every present slot is composed for the whole life of the
 * player and only shown or hidden — mount/unmount would throw away the slot
 * subtree's state on every transition, which the contract forbids.
 */
@Composable
private fun VideoSlotOverlay(
    slotChildren: List<Pair<VideoSlot, HypenElementModel>>,
    state: VideoPlayerState,
    renderer: ComposeRenderer,
) {
    for (slot in VideoSlot.entries) {
        val children = slotChildren.filter { it.first == slot }
        if (children.isEmpty()) continue
        val visible = isVideoSlotVisible(slot, state)
        Box(
            modifier = Modifier
                .fillMaxSize()
                .slotVisibility(visible),
        ) {
            // Hidden slots stay composed (state survives) but must not keep
            // animating invisibly — LocalContentVisible lets indefinite
            // animations (Spinner) park while the slot is hidden.
            CompositionLocalProvider(LocalContentVisible provides visible) {
                for ((_, child) in children) {
                    key(child.id) {
                        HypenElement(element = child, renderer = renderer)
                    }
                }
            }
        }
    }
}

/**
 * Show/hide that keeps the subtree composed: a hidden slot is measured but
 * never placed, so it is not drawn, not hit-tested and (via
 * `clearAndSetSemantics`) not in the accessibility tree — while every
 * `remember` inside it survives, ready for the next transition.
 */
private fun Modifier.slotVisibility(visible: Boolean): Modifier =
    if (visible) {
        this
    } else {
        this
            .alpha(0f)
            .clearAndSetSemantics {}
            .layout { measurable, constraints ->
                val placeable = measurable.measure(constraints)
                layout(placeable.width, placeable.height) { /* deliberately unplaced */ }
            }
    }
