package space.hypen.renderer.device.android

import android.content.ActivityNotFoundException
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContract
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import space.hypen.renderer.device.DeviceDriverException
import space.hypen.renderer.device.DeviceErrorCode
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private val keys = AtomicLong()
private val main by lazy { Handler(Looper.getMainLooper()) }

/**
 * Launch [contract] from [activity] and suspend until its result.
 *
 * Uses the non-lifecycle `ActivityResultRegistry.register` overload, which may
 * be called after `onCreate` (device requests arrive at arbitrary times). On
 * coroutine cancellation the callback is unregistered, so a late result from
 * an undismissable system UI is dropped (RFC 001 §2.1).
 *
 * Activity recreation while the system UI is up (configuration change, or
 * the system destroying the Activity behind the picker): the registry saves
 * the launched key and delivers the result to the replacement Activity's
 * registry under that same key, so the launch re-registers the key on the
 * next [ComponentActivity] of the same class created with saved state. The
 * two concerns are separate:
 * - the host-wide prompt gate is released at once ([onPresenterGone]): an
 *   Activity that may never come back cannot block every other prompt;
 * - the result itself is awaited until the operation ends (its deadline,
 *   lease, a server cancel or socket loss cancel this coroutine) — a slow
 *   pick is not lost to an arbitrary grace timer. `HypenApp` keeps the
 *   socket alive across the recreation (see `RetainedHypenSessions`).
 *
 * If the hosting Activity is finishing (the user left the app), the launch
 * fails with [DeviceErrorCode.CANCELLED] (`activity-destroyed`) right away.
 * A launch that throws (no Activity for the intent, a security or state
 * error) fails `unavailable` and unregisters everything it registered.
 */
internal suspend fun <I, O> launchForResult(
    tracker: ForegroundActivityTracker,
    activity: ComponentActivity,
    contract: ActivityResultContract<I, O>,
    input: I,
    onPresenterGone: () -> Unit = {},
): O = withContext(Dispatchers.Main.immediate) {
    suspendCancellableCoroutine { cont ->
        val key = "hypen.device.${keys.incrementAndGet()}"
        var launcher: ActivityResultLauncher<I>? = null
        var settled = false
        var presenterGone = false
        val cleanups = ArrayList<() -> Unit>()

        fun settle(outcome: () -> Unit) {
            if (settled) return
            settled = true
            cleanups.forEach { runCatching(it) }
            cleanups.clear()
            runCatching { launcher?.unregister() }
            launcher = null
            outcome()
        }

        val callback = ActivityResultCallback<O> { result -> settle { if (cont.isActive) cont.resume(result) } }

        fun lost() = settle {
            if (cont.isActive) cont.resumeWithException(DeviceDriverException(DeviceErrorCode.CANCELLED, "activity-destroyed"))
        }

        fun watch(host: ComponentActivity) {
            cleanups += tracker.onDestroyed(host) { destroyed ->
                if (settled) return@onDestroyed
                if (destroyed.isFinishing && !destroyed.isChangingConfigurations) {
                    lost()
                    return@onDestroyed
                }
                // The prompt gate is released now; the result is still awaited.
                if (!presenterGone) {
                    presenterGone = true
                    runCatching(onPresenterGone)
                }
                // Expect a replacement: re-register the same key there.
                var removeCreate: () -> Unit = {}
                removeCreate = tracker.onCreated { replacement, saved ->
                    if (settled || saved == null || replacement.javaClass != destroyed.javaClass) return@onCreated
                    removeCreate()
                    val l = replacement.activityResultRegistry.register(key, contract, callback)
                    // A pending result may already have been delivered inside register().
                    if (settled) runCatching { l.unregister() } else launcher = l
                    watch(replacement)
                }
                cleanups += { removeCreate() }
            }
        }

        cont.invokeOnCancellation { main.post { settle {} } }
        try {
            launcher = activity.activityResultRegistry.register(key, contract, callback)
            watch(activity)
            launcher?.launch(input)
        } catch (e: ActivityNotFoundException) {
            settle { if (cont.isActive) cont.resumeWithException(DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "no-activity-for-intent")) }
        } catch (t: Throwable) {
            // Any other launch failure also unregisters the launcher and the
            // lifecycle listeners (never leaked), and settles with a fixed token.
            settle { if (cont.isActive) cont.resumeWithException(DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "launch-failed")) }
        }
    }
}
