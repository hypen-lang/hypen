package space.hypen.renderer.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import space.hypen.renderer.model.HypenElement
import kotlinx.coroutines.delay

/**
 * Handler for Audio components.
 * Uses Media3 ExoPlayer for audio playback.
 *
 * Audio source is passed as an argument: Audio(src: "url")
 * Controls are shown by default for audio.
 */
class AudioComponent : ComponentHandler {
    override val typeName: String = "audio"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val context = LocalContext.current

        // Audio source from props
        val src = element.getStringProp("0")
            ?: element.getStringProp("src")
            ?: element.getStringProp("source")

        // Autoplay
        val autoplay = element.getBoolProp("autoplay")
            ?: element.getBoolProp("autoplay.0")
            ?: false

        // Loop
        val loop = element.getBoolProp("loop")
            ?: element.getBoolProp("loop.0")
            ?: false
        val showsControls = audioControlsVisible(element)

        if (src == null) {
            // No source - render children (for playlist UI, etc.)
            Box(modifier = modifier) {
                renderChildren()
            }
            return
        }

        // Create and remember ExoPlayer instance
        val exoPlayer = remember(src) {
            ExoPlayer.Builder(context).build().apply {
                val mediaItem = MediaItem.fromUri(src)
                setMediaItem(mediaItem)
                repeatMode = if (loop) ExoPlayer.REPEAT_MODE_ALL else ExoPlayer.REPEAT_MODE_OFF
                playWhenReady = autoplay
                prepare()
            }
        }

        // Track playback state
        var isPlaying by remember { mutableStateOf(autoplay) }
        var progress by remember { mutableFloatStateOf(0f) }
        var duration by remember { mutableFloatStateOf(0f) }

        // Listen to player state changes
        DisposableEffect(exoPlayer) {
            val listener = object : Player.Listener {
                override fun onIsPlayingChanged(playing: Boolean) {
                    isPlaying = playing
                }
            }
            exoPlayer.addListener(listener)

            onDispose {
                exoPlayer.removeListener(listener)
                exoPlayer.release()
            }
        }

        // Update progress periodically
        LaunchedEffect(isPlaying) {
            while (isPlaying) {
                val currentPosition = exoPlayer.currentPosition.toFloat()
                val totalDuration = exoPlayer.duration.toFloat()
                if (totalDuration > 0) {
                    progress = currentPosition / totalDuration
                    duration = totalDuration
                }
                delay(500)
            }
        }

        // Keep the player alive for headless/autoplay use, but match the DOM
        // contract: explicit `controls: false` contributes no transport UI or
        // layout footprint.
        if (!showsControls) return

        // Simple audio player UI
        Box(modifier = modifier) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFF3F4F6))
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                // Play/Pause button
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(Color(0xFF3B82F6))
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null
                        ) {
                            if (isPlaying) {
                                exoPlayer.pause()
                            } else {
                                exoPlayer.play()
                            }
                        },
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = if (isPlaying) "⏸" else "▶",
                        color = Color.White,
                        fontSize = 16.sp
                    )
                }

                // Progress bar
                LinearProgressIndicator(
                    progress = { progress },
                    modifier = Modifier.weight(1f),
                    color = Color(0xFF3B82F6),
                    trackColor = Color(0xFFE5E7EB),
                )

                // Duration text
                Text(
                    text = formatDuration(exoPlayer.currentPosition) + " / " + formatDuration(exoPlayer.duration),
                    fontSize = 12.sp,
                    color = Color(0xFF6B7280)
                )
            }
        }
    }

    private fun formatDuration(ms: Long): String {
        if (ms <= 0) return "0:00"
        val seconds = (ms / 1000) % 60
        val minutes = (ms / 1000) / 60
        return "$minutes:${seconds.toString().padStart(2, '0')}"
    }
}

internal fun audioControlsVisible(element: HypenElement): Boolean =
    element.getBoolProp("controls") ?: element.getBoolProp("controls.0") ?: true
