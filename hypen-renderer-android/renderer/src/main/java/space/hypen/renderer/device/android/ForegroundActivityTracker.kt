package space.hypen.renderer.device.android

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import java.lang.ref.WeakReference
import java.util.Collections
import java.util.WeakHashMap

/**
 * Tracks the resumed [ComponentActivity] that device drivers may present
 * from (pickers, permission dialogs, the consent dialog), reports when the
 * app leaves the foreground (no started Activity) so activation-bound work
 * stops (RFC 001 §2.7 host-local suspension), and tells presenters when the
 * Activity hosting their UI is destroyed so a pending prompt always settles
 * and the host-wide prompt gate is released (see [launchForResult] and
 * [AlertDialogConsentPresenter]).
 *
 * Foreground accounting is per Activity identity, not a bare counter: an
 * Activity that was started before [register] is learned from its first
 * resume/pause callback, a stop of an Activity never seen started does not
 * drive the count negative, configuration changes never count as
 * backgrounding, and the background report is confirmed after a short
 * settle delay (like `ProcessLifecycleOwner`'s) so a transition between two
 * Activities is not mistaken for leaving the app.
 *
 * Main-thread only, like the lifecycle callbacks that feed it.
 */
class ForegroundActivityTracker(private val application: Application) : Application.ActivityLifecycleCallbacks {
    private var resumed: WeakReference<ComponentActivity>? = null
    private val started: MutableSet<Activity> = Collections.newSetFromMap(WeakHashMap())
    private val destroyListeners = ArrayList<Pair<WeakReference<Activity>, (Activity) -> Unit>>()
    private val createListeners = ArrayList<(ComponentActivity, Bundle?) -> Unit>()
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private var backgroundCheck: Runnable? = null

    /** Invoked when the app has no started Activity left (not for configuration changes). */
    var onBackground: (() -> Unit)? = null

    /** Invoked when an Activity starts again after [onBackground] was reported. */
    var onForeground: (() -> Unit)? = null

    private var backgrounded = false

    /** Registered destroy listeners (diagnostics/tests: a settled launch leaves none behind). */
    internal val destroyListenerCount: Int get() = destroyListeners.size

    /** Registered create listeners (diagnostics/tests). */
    internal val createListenerCount: Int get() = createListeners.size

    /** Seed with an Activity that was already started/resumed before registration. */
    fun seed(activity: ComponentActivity) {
        val state = activity.lifecycle.currentState
        if (state.isAtLeast(Lifecycle.State.STARTED)) started += activity
        if (state.isAtLeast(Lifecycle.State.RESUMED)) resumed = WeakReference(activity)
    }

    fun register() = application.registerActivityLifecycleCallbacks(this)

    fun unregister() {
        application.unregisterActivityLifecycleCallbacks(this)
        backgroundCheck?.let { main.removeCallbacks(it) }
        backgroundCheck = null
    }

    /**
     * The resumed Activity, or null. Background activity starts are
     * restricted on Android 10+, so drivers only present from a resumed one.
     */
    fun foreground(): ComponentActivity? = resumed?.get()?.takeIf {
        !it.isFinishing && !it.isDestroyed && it.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
    }

    /**
     * Call [listener] once when [activity] is destroyed. Returns a remover.
     * An already-destroyed Activity is reported on the next main-loop turn.
     */
    fun onDestroyed(activity: Activity, listener: (Activity) -> Unit): () -> Unit {
        val entry = WeakReference(activity) to listener
        if (activity.isDestroyed) {
            main.post { listener(activity) }
            return {}
        }
        destroyListeners += entry
        return { destroyListeners.remove(entry) }
    }

    /** Call [listener] for every [ComponentActivity] created from now on, until removed. */
    fun onCreated(listener: (ComponentActivity, Bundle?) -> Unit): () -> Unit {
        createListeners += listener
        return { createListeners.remove(listener) }
    }

    override fun onActivityResumed(activity: Activity) {
        started += activity // learn Activities started before registration
        cancelBackgroundCheck()
        if (activity is ComponentActivity) resumed = WeakReference(activity)
    }

    override fun onActivityPaused(activity: Activity) {
        started += activity
        if (resumed?.get() === activity) resumed = null
    }

    override fun onActivityStarted(activity: Activity) {
        started += activity
        cancelBackgroundCheck()
        if (backgrounded) {
            backgrounded = false
            onForeground?.invoke()
        }
    }

    override fun onActivityStopped(activity: Activity) {
        val known = started.remove(activity)
        if (!known || started.isNotEmpty() || activity.isChangingConfigurations) return
        // Confirm after a settle delay: a new Activity starting in between
        // (transition, recreation) cancels the report.
        cancelBackgroundCheck()
        val check = Runnable {
            backgroundCheck = null
            if (started.isEmpty()) {
                backgrounded = true
                onBackground?.invoke()
            }
        }
        backgroundCheck = check
        main.postDelayed(check, BACKGROUND_SETTLE_MS)
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (activity !is ComponentActivity) return
        for (l in createListeners.toList()) l(activity, savedInstanceState)
    }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) {
        if (resumed?.get() === activity) resumed = null
        started.remove(activity)
        val fire = destroyListeners.filter { it.first.get() === activity }
        destroyListeners.removeAll { it.first.get() === activity || it.first.get() == null }
        for ((_, l) in fire) l(activity)
    }

    private fun cancelBackgroundCheck() {
        backgroundCheck?.let { main.removeCallbacks(it) }
        backgroundCheck = null
    }

    private companion object {
        const val BACKGROUND_SETTLE_MS = 700L
    }
}
