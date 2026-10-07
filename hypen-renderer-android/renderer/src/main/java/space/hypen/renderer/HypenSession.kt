package space.hypen.renderer

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import space.hypen.renderer.anim.AnimationCoordinator
import space.hypen.renderer.anim.SettingsMotionPreference
import space.hypen.renderer.device.DeviceHost
import space.hypen.renderer.dnd.DndCoordinator
import space.hypen.renderer.remote.RemoteEngine
import space.hypen.renderer.remote.RemoteEngineConfig
import space.hypen.renderer.render.ComposeRenderer

/**
 * Everything one `HypenApp` connection owns — the socket ([engine]), the
 * rendered tree ([renderer]) and the patch/error collection — held outside
 * the composition so it can outlive an Activity that is recreated
 * (configuration change) or destroyed behind a system picker and recreated
 * when the user returns. Without this, recreation closed the socket, which
 * cancelled in-flight device work before the replacement Activity could
 * receive its result, and started a new server session (RFC 001 §2.7).
 */
internal class HypenSession(
    url: String,
    config: RemoteEngineConfig,
    private val deviceHost: DeviceHost?,
    appContext: Context,
) {
    private val motion = SettingsMotionPreference(appContext)
    val renderer = ComposeRenderer(animation = AnimationCoordinator(motion), dnd = DndCoordinator(motion))
    val engine = RemoteEngine(url, config, deviceHost = deviceHost)

    /** Latest engine error, snapshot-backed for the error UI. */
    var lastError by mutableStateOf<Throwable?>(null)

    /** Dispose [deviceHost] when this session is finally destroyed (`HypenApp(disposeDeviceHost = true)`). */
    @Volatile
    var disposeDeviceHost: Boolean = false

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    init {
        scope.launch {
            try {
                engine.connect()
            } catch (e: Exception) {
                HypenLoggers.app.error("Connection failed", e)
                lastError = e
            }
            // Every batch, in order (collect, never collectLatest), also while
            // no composition is attached (between Activity instances). A batch
            // the renderer cannot apply is logged and skipped: letting it
            // escape would end this collection (no UI update ever again) or
            // crash the app from the main-thread exception handler.
            engine.patches.collect { patches ->
                try {
                    renderer.applyPatches(patches)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    HypenLoggers.app.error("Failed to apply a patch batch (${patches.size} patches)", e)
                }
            }
        }
        scope.launch {
            engine.errors.collect { error ->
                HypenLoggers.app.error("Remote engine error", error)
                lastError = error
            }
        }
    }

    fun destroy() {
        scope.cancel()
        engine.destroy()
        motion.dispose()
        if (disposeDeviceHost) deviceHost?.dispose()
    }
}

/**
 * Process-wide registry of [HypenSession]s, main thread only. A session
 * released while its Activity is being recreated is retained for a short
 * window (extended while a device operation has the OS presenting, bounded)
 * so the replacement Activity's `HypenApp` re-acquires the same socket and
 * tree; any other release destroys it at once.
 */
internal object HypenSessions {
    private data class Key(val url: String, val deviceHost: DeviceHost?)

    private const val RETAIN_MS = 60_000L
    private const val MAX_RETAIN_MS = 10 * 60_000L
    private const val POLL_MS = 5_000L

    private val main by lazy { Handler(Looper.getMainLooper()) }

    private val registry = RetainedSessions<Key, HypenSession>(
        retainMs = RETAIN_MS,
        maxRetainMs = MAX_RETAIN_MS,
        pollMs = POLL_MS,
        clock = SystemClock::uptimeMillis,
        schedule = { delayMs, action ->
            val r = Runnable { action() }
            main.postDelayed(r, delayMs)
            ({ main.removeCallbacks(r) })
        },
        isBusy = { it.engine.hasPresentingDeviceWork() },
        destroy = { it.destroy() },
    )

    fun acquire(url: String, config: RemoteEngineConfig, deviceHost: DeviceHost?, context: Context): HypenSession =
        registry.acquire(Key(url, deviceHost)) { HypenSession(url, config, deviceHost, context.applicationContext) }

    /**
     * Release [session] when its composition leaves. Retained only when the
     * hosting [activity] is going away without finishing (recreation);
     * destroyed otherwise (the app screen removed it, or the user left).
     */
    fun release(session: HypenSession, activity: Activity?) {
        val recreating = activity != null && !activity.isFinishing && (activity.isChangingConfigurations || activity.isDestroyed)
        registry.release(session, retain = recreating)
    }
}

/**
 * Keyed values that can be kept alive across a release for later
 * re-acquisition, JVM-testable (main thread only in production).
 *
 * - [acquire] reuses a released-but-retained value for the key, never one in
 *   use (two live compositions never share a value), else creates one;
 * - [release] with `retain = false` destroys at once; with `retain = true`
 *   the value is destroyed after [retainMs] unless re-acquired, re-checked
 *   every [pollMs] while [isBusy], and in any case after [maxRetainMs].
 */
internal class RetainedSessions<K : Any, V : Any>(
    private val retainMs: Long,
    private val maxRetainMs: Long,
    private val pollMs: Long,
    private val clock: () -> Long,
    private val schedule: (delayMs: Long, action: () -> Unit) -> () -> Unit,
    private val isBusy: (V) -> Boolean,
    private val destroy: (V) -> Unit,
) {
    private inner class Entry(val key: K, val value: V) {
        var inUse = true
        var releasedAt = 0L
        var cancelTimer: (() -> Unit)? = null
    }

    private val entries = ArrayList<Entry>()

    /** Values alive (in use or retained). */
    val size: Int get() = entries.size

    fun acquire(key: K, create: () -> V): V {
        entries.firstOrNull { it.key == key && !it.inUse }?.let { e ->
            e.inUse = true
            e.cancelTimer?.invoke()
            e.cancelTimer = null
            return e.value
        }
        val e = Entry(key, create())
        entries += e
        return e.value
    }

    fun release(value: V, retain: Boolean) {
        val e = entries.firstOrNull { it.value === value } ?: return
        if (!e.inUse) return
        if (!retain) {
            entries.remove(e)
            runCatching { destroy(value) }
            return
        }
        e.inUse = false
        e.releasedAt = clock()
        arm(e, retainMs)
    }

    private fun arm(e: Entry, delayMs: Long) {
        e.cancelTimer = schedule(delayMs) { check(e) }
    }

    private fun check(e: Entry) {
        e.cancelTimer = null
        if (e.inUse || e !in entries) return
        val age = clock() - e.releasedAt
        if (age < maxRetainMs && isBusy(e.value)) {
            arm(e, minOf(pollMs, maxRetainMs - age))
            return
        }
        entries.remove(e)
        runCatching { destroy(e.value) }
    }
}

/** The Activity behind a (possibly wrapped) Compose context, or null. */
internal fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}
