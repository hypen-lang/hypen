package space.hypen.renderer.components

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import space.hypen.renderer.model.HypenElement

/**
 * Handler for Video components.
 * Uses Media3 ExoPlayer for video playback.
 *
 * Video source is passed as an argument: Video(src: "url")
 * Controls can be enabled: Video(src: "url", controls: true)
 * All styling is done via applicators: Video(src: "url").cornerRadius(12)
 */
class VideoComponent : ComponentHandler {
    override val typeName: String = "video"

    @OptIn(UnstableApi::class)
    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val context = LocalContext.current

        // Video source from props
        val src = element.getStringProp("0")
            ?: element.getStringProp("src")
            ?: element.getStringProp("source")

        // Controls visibility
        val showControls = element.getBoolProp("controls")
            ?: element.getBoolProp("controls.0")
            ?: false

        // Autoplay
        val autoplay = element.getBoolProp("autoplay")
            ?: element.getBoolProp("autoplay.0")
            ?: false

        // Loop
        val loop = element.getBoolProp("loop")
            ?: element.getBoolProp("loop.0")
            ?: false

        // Muted
        val muted = element.getBoolProp("muted")
            ?: element.getBoolProp("muted.0")
            ?: false

        if (src == null) {
            // No source - render empty box
            Box(modifier = modifier)
            return
        }

        // Create and remember ExoPlayer instance
        val exoPlayer = remember(src) {
            ExoPlayer.Builder(context).build().apply {
                val mediaItem = MediaItem.fromUri(src)
                setMediaItem(mediaItem)
                repeatMode = if (loop) ExoPlayer.REPEAT_MODE_ALL else ExoPlayer.REPEAT_MODE_OFF
                volume = if (muted) 0f else 1f
                playWhenReady = autoplay
                prepare()
            }
        }

        // Clean up player when composable is disposed
        DisposableEffect(exoPlayer) {
            onDispose {
                exoPlayer.release()
            }
        }

        // Render the player view
        Box(modifier = modifier) {
            AndroidView(
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        player = exoPlayer
                        useController = showControls
                        layoutParams = FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                    }
                },
                update = { playerView ->
                    playerView.player = exoPlayer
                    playerView.useController = showControls
                },
                modifier = Modifier.fillMaxSize()
            )
        }
    }
}
