package space.hypen.renderer.components

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The platform capability matrix (hypen-web/docs/components/video.md) claims
 * HLS support on Android. Media3's `DefaultMediaSourceFactory` discovers the
 * HLS module **reflectively at runtime** — nothing fails at compile time when
 * `media3-exoplayer-hls` is missing from the classpath; `.m3u8` sources just
 * error with "no suitable media source factory found". This test pins the
 * dependency so the capability claim stays true.
 */
class VideoHlsDependencyTest {

    @Test
    fun `the media3 HLS module is on the classpath`() {
        // Same lookup DefaultMediaSourceFactory performs (Class.forName on
        // the HlsMediaSource factory) — if this throws, .m3u8 playback is
        // broken even though everything compiles.
        val factory = Class.forName("androidx.media3.exoplayer.hls.HlsMediaSource\$Factory")
        assertTrue(
            "HlsMediaSource.Factory must implement MediaSource.Factory",
            Class.forName("androidx.media3.exoplayer.source.MediaSource\$Factory")
                .isAssignableFrom(factory),
        )
    }
}
