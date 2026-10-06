package space.hypen.renderer.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import space.hypen.renderer.applicators.ColorParser
import space.hypen.renderer.model.ActionValue
import space.hypen.renderer.model.HypenElement
import space.hypen.renderer.render.LocalActionDispatcher

/**
 * Handler for the `Scrubber` primitive — the media timeline designed for a
 * Video `controls` slot (hypen-docs/content/docs/guide/components.mdx §Scrubber).
 *
 * Inside a Video it wires itself to the enclosing player renderer-side via
 * [LocalVideoPlaybackController]: the thumb tracks playback off a ticker
 * without touching module state, a drag previews locally, and only the
 * release commits — as a `position` write through the `.bind(@state.playback)`
 * struct (its own `bind` if it has one, else the Video's), or as an `onSeek`
 * action (`{type: "seek", position}`) when neither is bound. The seek itself
 * is applied to the local player immediately, so scrubbing stays responsive
 * on remote apps where a state round trip costs a network hop.
 *
 * Outside a Video the controller is null and the Scrubber renders inert.
 */
class ScrubberComponent : ComponentHandler {
    override val typeName: String = "scrubber"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val controller = LocalVideoPlaybackController.current
        val dispatcher = LocalActionDispatcher.current

        if (controller == null) {
            // Inert outside a Video: occupies its box, does nothing.
            Box(modifier = modifier)
            return
        }

        // Commit precedence (contract): its own `.bind(@state.playback)` wins,
        // else the enclosing Video's bind, else `onSeek` (in scrubberCommit).
        val bindPath = scrubberBindPath(
            ownBindPath = element.getStringProp("bind"),
            videoBindPath = controller.bindPath,
        )
        val onSeekAction = (element.props["onSeek.0"] ?: element.props["onSeek"])
            ?.let { ActionValue.parse(it) }

        val progressColor = (element.getStringProp("color") ?: element.getStringProp("color.0"))
            ?.let { ColorParser.parse(it) }
            ?: Color(0xFF3B82F6)
        val trackColor = (element.getStringProp("trackColor") ?: element.getStringProp("trackColor.0"))
            ?.let { ColorParser.parse(it) }
            ?: Color(0x33FFFFFF)
        val thumbColor = (element.getStringProp("thumbColor") ?: element.getStringProp("thumbColor.0"))
            ?.let { ColorParser.parse(it) }
            ?: Color.White

        var positionMs by remember(controller) { mutableLongStateOf(0L) }
        var durationMs by remember(controller) { mutableLongStateOf(0L) }
        // Non-null while a drag is in flight: the local preview that state
        // never sees until release.
        var dragFraction by remember(controller) { mutableStateOf<Float?>(null) }

        val playerState = controller.playerState

        // Ticker. Restarts on every state change (so a pause, a seek landing
        // or the duration becoming known refreshes once), then samples
        // continuously only while the player is actually playing.
        LaunchedEffect(controller, playerState) {
            positionMs = controller.positionMs
            durationMs = controller.durationMs
            while (playerState == VideoPlayerState.PLAYING) {
                delay(SCRUBBER_POLL_INTERVAL_MS)
                positionMs = controller.positionMs
                durationMs = controller.durationMs
            }
        }

        val fraction = dragFraction ?: scrubberFraction(positionMs, durationMs)
        val previewMs = if (dragFraction != null) {
            scrubberPositionMs(fraction, durationMs)
        } else {
            positionMs
        }

        val commit: (Float) -> Unit = { released ->
            val targetMs = scrubberPositionMs(released, durationMs)
            if (durationMs > 0L) {
                // Renderer-local first: no round trip for the thing the user
                // is looking at.
                controller.seekTo(targetMs)
                positionMs = targetMs
            }
            val commitPayload = scrubberCommit(released, durationMs, bindPath, onSeekAction)
            if (commitPayload != null && dispatcher != null) {
                dispatcher.dispatch(commitPayload.action, commitPayload.payload)
            }
        }
        // The gesture blocks below are keyed on the player identity ONLY —
        // never on live playback values like durationMs: a duration change
        // mid-drag (playlist auto-advance, duration becoming known) would
        // cancel the gesture coroutine outright, and a coroutine cancellation
        // runs neither onDragEnd nor onDragCancel, stranding the preview.
        // The latest commit closure (which reads the current duration/bind)
        // is reached through rememberUpdatedState instead.
        val currentCommit by rememberUpdatedState(commit)

        val durationSeconds = mediaMsToSeconds(durationMs).toFloat()
        val positionSeconds = mediaMsToSeconds(previewMs).toFloat()
        val label = element.getStringProp("label") ?: element.getStringProp("label.0")

        Box(
            modifier = modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = TOUCH_HEIGHT)
                .pointerInput(controller) {
                    detectHorizontalDragGestures(
                        onDragStart = { offset ->
                            dragFraction = fractionOf(offset.x, size.width)
                        },
                        // Cancelled gestures revert the local preview without
                        // committing — the thumb snaps back to real playback.
                        onDragCancel = { dragFraction = null },
                        onDragEnd = {
                            dragFraction?.let { currentCommit(it) }
                            dragFraction = null
                        },
                    ) { change, _ ->
                        dragFraction = fractionOf(change.position.x, size.width)
                    }
                }
                .pointerInput(controller) {
                    detectTapGestures { offset -> currentCommit(fractionOf(offset.x, size.width)) }
                }
                .semantics {
                    contentDescription = label ?: "Seek"
                    if (durationSeconds > 0f) {
                        progressBarRangeInfo = ProgressBarRangeInfo(
                            current = positionSeconds.coerceIn(0f, durationSeconds),
                            range = 0f..durationSeconds,
                        )
                    } else {
                        progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
                    }
                    stateDescription = "${formatTimecode(previewMs)} of ${formatTimecode(durationMs)}"
                    setProgress { target ->
                        if (durationMs <= 0L) {
                            false
                        } else {
                            commit(target / durationSeconds)
                            true
                        }
                    }
                },
        ) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val trackHeight = TRACK_HEIGHT.toPx()
                val thumbRadius = THUMB_RADIUS.toPx()
                val centerY = size.height / 2f
                val width = size.width

                drawRoundRect(
                    color = trackColor,
                    topLeft = Offset(0f, centerY - trackHeight / 2f),
                    size = Size(width, trackHeight),
                    cornerRadius = CornerRadius(trackHeight / 2f),
                )
                drawRoundRect(
                    color = progressColor,
                    topLeft = Offset(0f, centerY - trackHeight / 2f),
                    size = Size(width * fraction, trackHeight),
                    cornerRadius = CornerRadius(trackHeight / 2f),
                )
                drawCircle(
                    color = thumbColor,
                    radius = thumbRadius,
                    center = Offset(
                        (width * fraction).coerceIn(thumbRadius, (width - thumbRadius).coerceAtLeast(thumbRadius)),
                        centerY,
                    ),
                )
            }
        }
    }

    private companion object {
        val TOUCH_HEIGHT = 32.dp
        val TRACK_HEIGHT = 4.dp
        val THUMB_RADIUS = 7.dp
    }
}

/** Pointer x → track fraction, clamped; a zero-width track reads as 0. */
private fun fractionOf(x: Float, width: Int): Float {
    if (width <= 0) return 0f
    return (x / width.toFloat()).coerceIn(0f, 1f)
}
