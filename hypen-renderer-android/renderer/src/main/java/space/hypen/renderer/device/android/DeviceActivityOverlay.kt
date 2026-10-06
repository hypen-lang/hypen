package space.hypen.renderer.device.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import android.view.ViewTreeObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import space.hypen.renderer.device.DeviceActivityIndicator
import space.hypen.renderer.device.IndicatorHandle
import space.hypen.renderer.device.IndicatorStopReason
import space.hypen.renderer.device.isAuthenticatedOrigin
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * The default host-owned stream indicator (RFC 001 §5): each running
 * `bluetooth.scan` or `mic.record` shows a pill naming the origin and the
 * activity, with a Stop button (a scan ends `cancelled`; a recording ends
 * normally with what it captured). It is ready — and `bluetooth.scan` /
 * `mic.record` are advertised — only while a [DeviceActivityOverlay] for it
 * is composed on a **started** screen (its lifecycle is at least STARTED), so
 * a scan can never start without a visible indicator. When the last overlay
 * stops being visible (its screen stopped or left composition) or its window
 * stays covered (another window holds focus, e.g. an app dialog), every
 * running stream is stopped with [IndicatorStopReason.HIDDEN] instead of
 * continuing invisibly. "Stays covered" is checked both when focus is lost
 * during a scan and when a scan **starts** while the window is already
 * covered (see [CoverWatch]).
 *
 * [show]/hide run on the main thread (the DeviceHost dispatcher).
 */
class ComposeDeviceActivityIndicator : DeviceActivityIndicator {
    internal class Entry(val origin: String, val activity: String, val stop: (IndicatorStopReason) -> Unit)

    internal val entries = mutableStateListOf<Entry>()
    private val attached = AtomicInteger(0)

    /**
     * Called when [isReady] flips (first overlay attached / last detached);
     * `AndroidDeviceHost.create` points it at `DeviceHost.recheckCapabilities`
     * so `bluetooth.scan` / `mic.record` join or leave the live advertisement.
     */
    @Volatile
    var onReadyChanged: (() -> Unit)? = null

    override val isReady: Boolean get() = attached.get() > 0

    /** Notified (main thread) after every successful [show]: a stream just started. */
    private val startListeners = CopyOnWriteArrayList<() -> Unit>()

    override fun show(origin: String, activity: String, stop: (IndicatorStopReason) -> Unit): IndicatorHandle? {
        if (!isReady) return null
        val entry = Entry(origin, activity, stop)
        entries += entry
        // A stream may start while the overlay's window is already covered
        // (e.g. a fullscreen-video Dialog is up and consent was granted
        // earlier, so nothing prompted): no focus change will ever arm the
        // covered check, so each overlay re-checks its window now.
        startListeners.forEach { runCatching { it() } }
        return IndicatorHandle { entries.remove(entry) }
    }

    /** Register [listener] for stream starts; returns its removal. */
    internal fun onStreamStarted(listener: () -> Unit): () -> Unit {
        startListeners += listener
        return { startListeners -= listener }
    }

    /** A visible overlay appeared. Returns its detach; the last detach stops every running stream. */
    internal fun attach(): () -> Unit {
        if (attached.incrementAndGet() == 1) onReadyChanged?.invoke()
        var detached = false
        return {
            if (!detached) {
                detached = true
                if (attached.decrementAndGet() == 0) {
                    onReadyChanged?.invoke()
                    stopAll(IndicatorStopReason.HIDDEN)
                }
            }
        }
    }

    /** Ask every running stream to stop (e.g. the overlay's window stayed covered). */
    internal fun stopAll(reason: IndicatorStopReason) {
        entries.toList().forEach { runCatching { it.stop(reason) } }
    }

    internal companion object {
        /** How long the overlay's window may lack focus while streams run before they stop. */
        const val COVERED_GRACE_MS: Long = 1_500
    }
}

/**
 * The covered-window check of one overlay (RFC 001 §5: a stream never runs
 * without a visible indicator). While at least one stream runs and the
 * overlay's window lacks focus — because focus was lost during a scan
 * ([onFocusChanged]) **or** because a scan started while the window was
 * already covered ([onStreamStarted]) — a check is armed; if the window still
 * lacks focus after [ComposeDeviceActivityIndicator.COVERED_GRACE_MS], every
 * running stream stops with [IndicatorStopReason.HIDDEN]. Regaining focus
 * disarms it.
 *
 * Why a grace instead of refusing [ComposeDeviceActivityIndicator.show] on an
 * unfocused window: a scan normally starts right after the host's own consent
 * dialog (or the OS permission screen) closes, and the window gets its focus
 * back asynchronously a few frames later. A hard focus requirement would
 * refuse that ordinary flow; the grace lets it through while a window that
 * really stays covered (an app Dialog, the notification shade) stops the scan.
 *
 * Main thread only. [schedule]/[unschedule] are `View.postDelayed` /
 * `View.removeCallbacks` in production.
 */
internal class CoverWatch(
    private val indicator: ComposeDeviceActivityIndicator,
    private val hasWindowFocus: () -> Boolean,
    private val schedule: (Runnable, Long) -> Unit,
    private val unschedule: (Runnable) -> Unit,
) {
    private var pending: Runnable? = null

    /** The overlay's window gained or lost focus. */
    fun onFocusChanged(hasFocus: Boolean) {
        disarm()
        if (!hasFocus && indicator.entries.isNotEmpty()) arm()
    }

    /** A stream just started: if the window is already covered, arm the check. */
    fun onStreamStarted() {
        if (pending == null && indicator.entries.isNotEmpty() && !hasWindowFocus()) arm()
    }

    fun dispose() = disarm()

    internal val isArmed: Boolean get() = pending != null

    private fun arm() {
        val check = Runnable {
            pending = null
            if (!hasWindowFocus()) indicator.stopAll(IndicatorStopReason.HIDDEN)
        }
        pending = check
        schedule(check, ComposeDeviceActivityIndicator.COVERED_GRACE_MS)
    }

    private fun disarm() {
        pending?.let(unschedule)
        pending = null
    }
}

/**
 * Host-owned overlay, drawn outside the server's patch tree: the stream
 * indicators of [indicator] (each with a Stop control) and, for an
 * unauthenticated `ws://` [origin], a persistent development-mode notice
 * (RFC 001 §5: `ws://` grants are connection-scoped "with an explicit,
 * visible development mode"). `HypenApp` places it automatically; apps that
 * render with their own tree place it above their content.
 */
@Composable
fun DeviceActivityOverlay(
    indicator: ComposeDeviceActivityIndicator?,
    origin: String?,
    modifier: Modifier = Modifier,
) {
    if (indicator != null) {
        // Ready only while this screen is started: a stopped Activity keeps
        // its composition, but nothing on it can be seen (RFC 001 §5).
        val lifecycleOwner = LocalLifecycleOwner.current
        DisposableEffect(indicator, lifecycleOwner) {
            var detach: (() -> Unit)? = null
            fun sync() {
                val started = lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
                if (started && detach == null) detach = indicator.attach()
                if (!started) {
                    detach?.invoke()
                    detach = null
                }
            }
            val observer = LifecycleEventObserver { _, _ -> sync() }
            lifecycleOwner.lifecycle.addObserver(observer)
            sync()
            onDispose {
                lifecycleOwner.lifecycle.removeObserver(observer)
                detach?.invoke()
                detach = null
            }
        }
        // Covered: another window (an app dialog such as a fullscreen video,
        // the notification shade) holds focus for longer than a short grace,
        // whether it appeared during a scan or was already up when one started.
        val view = LocalView.current
        DisposableEffect(indicator, view) {
            val watch = CoverWatch(
                indicator = indicator,
                hasWindowFocus = view::hasWindowFocus,
                schedule = { r, ms -> view.postDelayed(r, ms) },
                unschedule = { r -> view.removeCallbacks(r) },
            )
            val listener = ViewTreeObserver.OnWindowFocusChangeListener(watch::onFocusChanged)
            val observer = view.viewTreeObserver
            observer.addOnWindowFocusChangeListener(listener)
            val removeStart = indicator.onStreamStarted(watch::onStreamStarted)
            // Streams already running when this overlay appeared.
            watch.onStreamStarted()
            onDispose {
                removeStart()
                if (observer.isAlive) observer.removeOnWindowFocusChangeListener(listener)
                watch.dispose()
            }
        }
    }
    val devMode = origin != null && !isAuthenticatedOrigin(origin)
    val running = indicator?.entries.orEmpty()
    if (!devMode && running.isEmpty()) return
    Column(
        modifier = modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (devMode) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.tertiaryContainer,
                contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
            ) {
                Text(
                    text = "Development mode: device access over unencrypted ws:// ($origin)",
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
        for (entry in running) {
            Surface(
                shape = RoundedCornerShape(24.dp),
                color = MaterialTheme.colorScheme.inverseSurface,
                contentColor = MaterialTheme.colorScheme.inverseOnSurface,
                shadowElevation = 6.dp,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(start = 16.dp, end = 4.dp),
                ) {
                    Text(
                        text = "${entry.activity} for ${entry.origin}",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    TextButton(onClick = { entry.stop(IndicatorStopReason.USER) }) {
                        Text("Stop", color = MaterialTheme.colorScheme.inversePrimary)
                    }
                }
            }
        }
    }
}
