package space.hypen.renderer.device.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.DialogInterface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import space.hypen.renderer.device.ConsentDecision
import space.hypen.renderer.device.ConsentPresenter
import space.hypen.renderer.device.ConsentPrompt
import kotlin.coroutines.resume

/**
 * The host-owned consent interaction (RFC 001 §2.6 step 2) as a platform
 * [AlertDialog] on the foreground Activity: outside the patch tree, accessible
 * and keyboard/D-pad operable, naming the authenticated origin and a
 * host-defined operation label (never server text).
 *
 * - Continue settles once ([ConsentDecision.CONTINUE]); Cancel is a refusal
 *   ([ConsentDecision.CANCEL] → `denied` + cooldown).
 * - Back, an outside tap, or the hosting Activity being destroyed are
 *   abandonment ([ConsentDecision.DISMISSED] → `cancelled`, no cooldown), so
 *   an accidental tap does not lock the capability out. Destruction always
 *   settles the prompt, releasing the host-wide prompt gate.
 * - Tapjacking: both buttons filter touches while the window is obscured
 *   (`filterTouchesWhenObscured`) and, on API 29+, also while it is partially
 *   obscured (`FLAG_WINDOW_IS_PARTIALLY_OBSCURED`, which the view flag does not
 *   filter). Keyboard/D-pad activation is unaffected.
 * - Input arming: the server decides *when* the dialog appears, so it could
 *   time it under a finger that is already tapping the app. Both buttons
 *   ignore input until the dialog window has held focus for
 *   [ARMING_DELAY_MS] (and re-arm after losing focus); they are shown
 *   disabled until then ([ConsentInputArming]).
 * - Unauthenticated `ws://` origins show an explicit development-mode notice;
 *   their grants are connection-scoped (RFC 001 §5).
 *
 * Coroutine cancellation (server cancel, deadline, lease, socket loss)
 * dismisses it.
 */
class AlertDialogConsentPresenter(private val tracker: ForegroundActivityTracker) : ConsentPresenter {
    private val main = Handler(Looper.getMainLooper())

    override suspend fun present(prompt: ConsentPrompt): ConsentDecision = withContext(Dispatchers.Main.immediate) {
        val activity = tracker.foreground() ?: return@withContext ConsentDecision.UNAVAILABLE
        suspendCancellableCoroutine { cont ->
            var settled = false
            var removeDestroyWatch: () -> Unit = {}
            fun finish(decision: ConsentDecision) {
                if (settled) return
                settled = true
                removeDestroyWatch()
                if (cont.isActive) cont.resume(decision)
            }
            val arming = ConsentInputArming(ARMING_DELAY_MS) { SystemClock.uptimeMillis() }
            val dialog = AlertDialog.Builder(activity)
                .setTitle("Device access")
                .setMessage(message(prompt))
                // Listeners are replaced after show() so unarmed input is ignored.
                .setPositiveButton("Continue", null)
                .setNegativeButton("Cancel", null)
                .setOnCancelListener { finish(ConsentDecision.DISMISSED) }
                .create()
            dialog.setOnDismissListener { finish(ConsentDecision.DISMISSED) }
            removeDestroyWatch = tracker.onDestroyed(activity) {
                finish(ConsentDecision.DISMISSED)
                runCatching { dialog.dismiss() }
            }
            dialog.show()
            val buttons = listOfNotNull(dialog.getButton(DialogInterface.BUTTON_POSITIVE), dialog.getButton(DialogInterface.BUTTON_NEGATIVE))
            fun refreshArming() {
                val armed = arming.accepts()
                buttons.forEach { it.isEnabled = armed }
                if (!armed && arming.isFocused) main.postDelayed({ if (!settled) refreshArming() }, arming.remainingMs() + 16)
            }
            dialog.getButton(DialogInterface.BUTTON_POSITIVE)?.setOnClickListener {
                if (!arming.accepts()) return@setOnClickListener
                finish(ConsentDecision.CONTINUE)
                runCatching { dialog.dismiss() }
            }
            dialog.getButton(DialogInterface.BUTTON_NEGATIVE)?.setOnClickListener {
                if (!arming.accepts()) return@setOnClickListener
                finish(ConsentDecision.CANCEL)
                runCatching { dialog.dismiss() }
            }
            buttons.forEach(::guardAgainstOverlays)
            val decor = dialog.window?.decorView
            arming.onFocusChanged(decor?.hasWindowFocus() == true)
            decor?.viewTreeObserver?.addOnWindowFocusChangeListener { hasFocus ->
                arming.onFocusChanged(hasFocus)
                if (!settled) refreshArming()
            }
            refreshArming()
            cont.invokeOnCancellation {
                main.post {
                    settled = true
                    removeDestroyWatch()
                    runCatching { dialog.dismiss() }
                }
            }
        }
    }

    @SuppressLint("ClickableViewAccessibility") // only drops obscured touches; clicks/keys are unchanged
    private fun guardAgainstOverlays(button: View) {
        button.filterTouchesWhenObscured = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            button.setOnTouchListener { _, event ->
                // Consume (drop) touches delivered through a partially obscuring window.
                (event.flags and MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED) != 0
            }
        }
    }

    internal companion object {
        /** Input is ignored until the dialog window has held focus this long. */
        const val ARMING_DELAY_MS: Long = 600

        fun message(prompt: ConsentPrompt): String = buildString {
            append(prompt.origin).append(" wants to ").append(prompt.operation).append('.')
            if (prompt.developmentMode) {
                append("\n\nDevelopment mode: this connection is not encrypted (ws://). ")
                append("Access granted here lasts only for this connection.")
            }
        }
    }
}

/**
 * Input arming for host consent (RFC 001 §5, tapjacking by timing): a choice
 * counts only after the dialog window has held focus for [delayMs]
 * continuously; losing focus disarms it again. Main thread only.
 */
internal class ConsentInputArming(private val delayMs: Long, private val now: () -> Long) {
    private var focusedAt: Long? = null

    val isFocused: Boolean get() = focusedAt != null

    fun onFocusChanged(hasFocus: Boolean) {
        focusedAt = if (hasFocus) focusedAt ?: now() else null
    }

    fun accepts(): Boolean = focusedAt?.let { now() - it >= delayMs } ?: false

    /** Milliseconds until armed (0 when armed; [delayMs] while unfocused). */
    fun remainingMs(): Long = focusedAt?.let { maxOf(0, delayMs - (now() - it)) } ?: delayMs
}
