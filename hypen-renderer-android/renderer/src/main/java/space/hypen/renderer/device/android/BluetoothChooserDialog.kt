package space.hypen.renderer.device.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import space.hypen.renderer.device.BluetoothChoice
import space.hypen.renderer.device.BluetoothChooser
import space.hypen.renderer.device.BluetoothChooserEntry
import space.hypen.renderer.device.isAuthenticatedOrigin
import kotlin.coroutines.resume

/**
 * The host-owned `bluetooth.select` chooser (RFC 001 §5): a platform
 * [AlertDialog] on the foreground Activity — outside the patch tree, naming
 * the origin — listing the live scan (strongest first) with Cancel. It is the
 * per-use consent gate and, while open, the visible UI of its scan.
 *
 * - Choosing a row answers [BluetoothChoice.Selected]; Cancel, back, an
 *   outside tap or the Activity being destroyed answer
 *   [BluetoothChoice.Dismissed] (`cancelled`).
 * - Tapjacking: rows ignore touches while the window is (partially)
 *   obscured, and ignore input until the dialog has held focus for
 *   [AlertDialogConsentPresenter.ARMING_DELAY_MS] ([ConsentInputArming]) —
 *   the server decides when the chooser appears, and the list changes under
 *   the finger as devices are found.
 * - Coroutine cancellation (deadline, server cancel, lease, detach) dismisses it.
 */
class AlertDialogBluetoothChooser(private val tracker: ForegroundActivityTracker) : BluetoothChooser {
    private val main = Handler(Looper.getMainLooper())

    override suspend fun choose(origin: String, devices: StateFlow<List<BluetoothChooserEntry>>): BluetoothChoice =
        withContext(Dispatchers.Main.immediate) {
            val activity = tracker.foreground() ?: return@withContext BluetoothChoice.Unavailable
            coroutineScope {
                var shown: List<BluetoothChooserEntry> = emptyList()
                val adapter = ArrayAdapter<String>(activity, android.R.layout.simple_list_item_1, ArrayList())
                val status = TextView(activity)
                val list = ListView(activity).apply { this.adapter = adapter }
                val content = LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    val pad = (20 * resources.displayMetrics.density).toInt()
                    setPadding(pad, pad / 2, pad, 0)
                    addView(TextView(activity).apply { text = message(origin) })
                    addView(status)
                    addView(list, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, (280 * resources.displayMetrics.density).toInt()))
                }
                val updates = launch {
                    devices.collect { entries ->
                        shown = entries
                        adapter.clear()
                        adapter.addAll(entries.map(::row))
                        status.text = if (entries.isEmpty()) "Scanning for devices…" else "Scanning… ${entries.size} found"
                    }
                }
                try {
                    suspendCancellableCoroutine<BluetoothChoice> { cont ->
                        var settled = false
                        var removeDestroyWatch: () -> Unit = {}
                        fun finish(choice: BluetoothChoice) {
                            if (settled) return
                            settled = true
                            removeDestroyWatch()
                            if (cont.isActive) cont.resume(choice)
                        }
                        val arming = ConsentInputArming(AlertDialogConsentPresenter.ARMING_DELAY_MS) { SystemClock.uptimeMillis() }
                        val dialog = AlertDialog.Builder(activity)
                            .setTitle("Choose a Bluetooth device")
                            .setView(content)
                            .setNegativeButton("Cancel") { _, _ -> finish(BluetoothChoice.Dismissed) }
                            .setOnCancelListener { finish(BluetoothChoice.Dismissed) }
                            .create()
                        dialog.setOnDismissListener { finish(BluetoothChoice.Dismissed) }
                        list.setOnItemClickListener { _, _, position, _ ->
                            if (!arming.accepts()) return@setOnItemClickListener
                            val entry = shown.getOrNull(position) ?: return@setOnItemClickListener
                            finish(BluetoothChoice.Selected(entry.id))
                            runCatching { dialog.dismiss() }
                        }
                        guardAgainstOverlays(list)
                        removeDestroyWatch = tracker.onDestroyed(activity) {
                            finish(BluetoothChoice.Dismissed)
                            runCatching { dialog.dismiss() }
                        }
                        dialog.show()
                        val decor = dialog.window?.decorView
                        arming.onFocusChanged(decor?.hasWindowFocus() == true)
                        decor?.viewTreeObserver?.addOnWindowFocusChangeListener { arming.onFocusChanged(it) }
                        cont.invokeOnCancellation {
                            main.post {
                                settled = true
                                removeDestroyWatch()
                                runCatching { dialog.dismiss() }
                            }
                        }
                    }
                } finally {
                    updates.cancel()
                }
            }
        }

    @SuppressLint("ClickableViewAccessibility") // only drops obscured touches; clicks/keys are unchanged
    private fun guardAgainstOverlays(list: ListView) {
        list.filterTouchesWhenObscured = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            list.setOnTouchListener { _, event -> (event.flags and MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED) != 0 }
        }
    }

    internal companion object {
        fun row(entry: BluetoothChooserEntry): String = (entry.name?.takeIf { it.isNotBlank() } ?: "Unnamed device") + "\n" + entry.id

        fun message(origin: String): String = buildString {
            append(origin).append(" wants to connect to a nearby Bluetooth device. Choose one, or Cancel.")
            if (!isAuthenticatedOrigin(origin)) append("\n\nDevelopment mode: this connection is not encrypted (ws://).")
        }
    }
}
