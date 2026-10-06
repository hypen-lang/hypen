package space.hypen.renderer.anim

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * The platform's "reduce motion" preference, behind an interface so the
 * animation coordinator is testable on the JVM without Android framework
 * stubs (which return 0f for every `Settings.Global` read and would look
 * like reduced motion is permanently on).
 */
fun interface MotionPreference {
    /** True when the platform asks for animations to be suppressed. */
    fun reducedMotion(): Boolean
}

/** Motion preference for hosts that never reduce motion (the test default). */
val AlwaysAnimate = MotionPreference { false }

/** Motion preference that always reduces (used by tests). */
val NeverAnimate = MotionPreference { true }

/**
 * Android's "Remove animations" accessibility switch, read through
 * `Settings.Global.ANIMATOR_DURATION_SCALE` (0 = animations off) and kept
 * live with a `ContentObserver`, so a mid-session toggle takes effect without
 * a reconnect — the parity bar the web renderers set with their `matchMedia`
 * change listener.
 *
 * Deliberately NOT relying on Compose scaling durations for us: the
 * protocol's reduced-motion contract is stronger than duration-0 (skip
 * enters, finalize exits immediately, fire no completions).
 *
 * Developer-setting scales other than 0 (0.5x, 5x) are reported as "motion
 * allowed" and are NOT applied to our durations: the renderer times its own
 * playbacks and its `duration + delay + 80ms` finalize backbone off the same
 * unscaled numbers, so the two can never disagree.
 */
class SettingsMotionPreference(context: Context) : MotionPreference {
    private val appContext = context.applicationContext
    private val resolver = appContext.contentResolver

    // Snapshot-backed so composables reading through the coordinator
    // recompose when the preference flips mid-session.
    private var reduced by mutableStateOf(readScale() == 0f)

    private val observer =
        object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                reduced = readScale() == 0f
            }
        }

    init {
        try {
            resolver.registerContentObserver(
                Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
                false,
                observer,
            )
        } catch (_: Exception) {
            // Registration can fail on restricted/instrumented hosts; the
            // initial read still holds, which is the sanctioned degradation.
        }
    }

    override fun reducedMotion(): Boolean = reduced

    /** Detach the observer. Safe to call more than once. */
    fun dispose() {
        try {
            resolver.unregisterContentObserver(observer)
        } catch (_: Exception) {
            // Already unregistered.
        }
    }

    private fun readScale(): Float =
        try {
            Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        } catch (_: Exception) {
            1f
        }
}
