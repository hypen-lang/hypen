package space.hypen.renderer.device.android

import android.content.Context
import androidx.activity.ComponentActivity
import kotlinx.coroutines.Dispatchers
import space.hypen.renderer.HypenLoggers
import space.hypen.renderer.device.BluetoothScanDriver
import space.hypen.renderer.device.BluetoothSelectDriver
import space.hypen.renderer.device.CameraCaptureDriver
import space.hypen.renderer.device.DeviceActivityIndicator
import space.hypen.renderer.device.DeviceClock
import space.hypen.renderer.device.DeviceDriver
import space.hypen.renderer.device.DeviceHost
import space.hypen.renderer.device.DeviceHostConfig
import space.hypen.renderer.device.DeviceLog
import space.hypen.renderer.device.FilePickDriver
import space.hypen.renderer.device.FileSaveDriver
import space.hypen.renderer.device.GalleryPickDriver
import space.hypen.renderer.device.MicRecordDriver
import space.hypen.renderer.device.PermissionQueryDriver
import space.hypen.renderer.device.PermissionRequestDriver
import space.hypen.renderer.device.normalizeOrigin

/**
 * Builds the Android DeviceHost (RFC 001) for a remote Hypen app.
 *
 * ```kotlin
 * // Application-scoped: create once (e.g. from your first Activity, keep it
 * // in the Application or a singleton) and reuse it across Activities.
 * val device = AndroidDeviceHost.create(activity, serverUrl = "wss://app.example/ws")
 * HypenApp(url, deviceHost = device)           // renders the Stop indicator overlay
 * // or: RemoteEngine(url, deviceHost = device) + DeviceActivityOverlay(...)
 * // ...
 * device.dispose()                             // when device access is no longer needed
 * ```
 *
 * ## Lifetime
 *
 * The host is **Application-scoped**: it registers
 * `Application.ActivityLifecycleCallbacks`, owns the host-wide prompt gate,
 * cooldowns and persistable grants, and follows whichever Activity is in the
 * foreground (so rotation and Activity recreation do not disturb it). The
 * [activity] argument only supplies the Application and seeds the tracker;
 * the host keeps no strong reference to it. [serverUrl] only sets the
 * default origin: every connection is bound to the origin of the URL its
 * `RemoteEngine` connects to, which prompts name and grants/cooldowns are
 * keyed on, so one host can safely serve several servers. Nothing disposes the host
 * implicitly: call [DeviceHost.dispose] yourself, or bind it to a composition
 * with `HypenApp(deviceHost = …, disposeDeviceHost = true)` when a
 * screen-scoped host is really what you want. A host created per Activity
 * and never disposed leaks its lifecycle callbacks.
 *
 * ## bluetooth.scan indicator (RFC 001 §5)
 *
 * BLE scans need an always-visible host indicator with a Stop control; Android
 * shows none of its own. [activityIndicator] supplies it — by default a
 * [ComposeDeviceActivityIndicator], displayed by `HypenApp` (or by placing
 * [DeviceActivityOverlay] yourself). `bluetooth.scan` is advertised only while
 * such an overlay is composed on a started screen
 * ([DeviceActivityIndicator.isReady]), is never started while the app is
 * backgrounded, and stops when its indicator can no longer be seen; pass
 * `activityIndicator = null` to never offer it, or your own implementation.
 *
 * ## mic.record recording indicator (RFC 001 §5)
 *
 * `mic.record` uses the same [activityIndicator] for its always-visible
 * "Recording audio" pill with Stop; it is advertised only while the
 * indicator is ready. Stop, the indicator becoming invisible and
 * backgrounding end the recording normally (a success with what was
 * captured).
 *
 * ## What is advertised (RFC 001 §2.2)
 *
 * A capability is advertised iff (1) the hardware exists, (2) the merged
 * manifest declares what the OS requires for it on this API level (read once
 * through `PackageManager`, [ManifestPermissions]), and (3) for `bluetooth.scan`
 * and `mic.record` the [activityIndicator] is ready. Whether a permission is
 * *granted* never matters (an un-asked permission is still advertised so the
 * app can prompt; a refusal never removes it). When indicator readiness or the
 * foreground changes while connected, the host re-checks and sends a fresh
 * `core.capabilities` snapshot if the set changed. Declarations are fixed for
 * an installed APK, and Android offers no signal for Bluetooth hardware
 * appearing or disappearing (adapter on/off is a run-time `unavailable`, not
 * an advertisement change).
 *
 * Manifest (the library declares only its private capture FileProvider; add
 * the permissions you enable — an undeclared one means the capability is not
 * advertised at all):
 * - `bluetooth.scan` / `bluetooth.select`: `BLUETOOTH_SCAN` (API 31+, ideally with
 *   `android:usesPermissionFlags="neverForLocation"`), and
 *   `ACCESS_FINE_LOCATION` with `android:maxSdkVersion="30"` for older devices
 *   (API ≤ 28 also accepts `ACCESS_COARSE_LOCATION`).
 *   Without `neverForLocation`, API 31+ scans also need `ACCESS_FINE_LOCATION`
 *   (declare it without `maxSdkVersion`) and Location Services on; on API ≤ 30
 *   Location Services must be on (otherwise the scan answers `unavailable`).
 * - `mic.record`: `RECORD_AUDIO`.
 * - `camera.capture`: nothing — the system capture UI records under the
 *   capture app's own permissions. If the app declares `CAMERA` it must be
 *   granted for the capture intent (the driver asks through the OS flow) —
 *   likewise `RECORD_AUDIO` for video when declared.
 * - `permission.*`: whichever runtime permissions the app may ask about;
 *   undeclared ones answer `unavailable` (`not-declared:<name>`). The names are
 *   the closed set camera, microphone, photos, location, notifications,
 *   bluetooth, contacts (anything else is `invalidParams`).
 * - `gallery.pick`, `file.pick`, `file.save` need no permission (system pickers).
 */
object AndroidDeviceHost {
    val DEFAULT_CAPABILITIES: Set<String> = setOf(
        "gallery.pick", "file.pick", "file.save", "camera.capture", "mic.record",
        "permission.query", "permission.request", "bluetooth.scan", "bluetooth.select",
    )

    fun create(
        activity: ComponentActivity,
        serverUrl: String,
        capabilities: Set<String> = DEFAULT_CAPABILITIES,
        activityIndicator: DeviceActivityIndicator? = ComposeDeviceActivityIndicator(),
        configure: (DeviceHostConfig) -> DeviceHostConfig = { it },
    ): DeviceHost {
        val app = activity.application
        val tracker = ForegroundActivityTracker(app)
        tracker.seed(activity)
        tracker.register()
        val prefs = app.getSharedPreferences("space.hypen.device", Context.MODE_PRIVATE)
        // One read of the manifest serves the advertisement rule and every driver.
        val manifest = ManifestPermissions.read(app)
        val permissions = AndroidPermissionPlatform(app, tracker, prefs, manifest)
        val drivers = buildList<DeviceDriver> {
            if ("gallery.pick" in capabilities) add(GalleryPickDriver(AndroidGalleryPlatform(app, tracker, Dispatchers.IO)))
            if ("file.pick" in capabilities) add(FilePickDriver(AndroidFilePickPlatform(app, tracker, Dispatchers.IO)))
            if ("file.save" in capabilities) add(FileSaveDriver(AndroidFileSavePlatform(app, tracker, Dispatchers.IO)))
            if ("camera.capture" in capabilities) add(CameraCaptureDriver(AndroidCameraPlatform(app, tracker, Dispatchers.IO), permissions))
            // No indicator, no recording (RFC 001 §5).
            if ("mic.record" in capabilities && activityIndicator != null) {
                add(MicRecordDriver(AndroidAudioCapturePlatform(app), permissions, activityIndicator))
            }
            if ("permission.query" in capabilities) add(PermissionQueryDriver(permissions))
            if ("permission.request" in capabilities) add(PermissionRequestDriver(permissions))
            // No indicator, no bluetooth.scan (RFC 001 §5).
            if ("bluetooth.scan" in capabilities && activityIndicator != null) {
                add(BluetoothScanDriver(AndroidBluetoothPlatform(app, manifest), permissions, activityIndicator))
            }
            if ("bluetooth.select" in capabilities) {
                add(BluetoothSelectDriver(AndroidBluetoothPlatform(app, manifest), permissions, AlertDialogBluetoothChooser(tracker)))
            }
        }
        val log = HypenLoggers.remote.child("device")
        val host = DeviceHost(
            config = configure(DeviceHostConfig(origin = normalizeOrigin(serverUrl))),
            drivers = drivers,
            dispatcher = Dispatchers.Main,
            ioDispatcher = Dispatchers.IO,
            clock = DeviceClock.SYSTEM,
            cooldowns = SharedPreferencesCooldownStore(prefs),
            consent = AlertDialogConsentPresenter(tracker),
            log = DeviceLog { message -> log.debug { message } },
            onDispose = {
                tracker.onBackground = null
                tracker.onForeground = null
                tracker.unregister()
                (activityIndicator as? ComposeDeviceActivityIndicator)?.onReadyChanged = null
            },
            activityIndicator = activityIndicator,
        )
        bindAdvertisementTriggers(host, tracker, activityIndicator)
        // Spool files from older versions (the gallery no longer spools, D5).
        // Capture temp files a dead process left behind.
        Thread {
            runCatching { AndroidGalleryPlatform.sweepStaleSpoolFiles(app.cacheDir) }
            runCatching { HypenDeviceFileProvider.sweep(app.cacheDir) }
        }.start()
        return host
    }

    /**
     * Wire what can change the advertisement while connected: the default
     * indicator's readiness (first overlay attached / last detached) and the
     * app gaining or losing the foreground — which also covers a custom
     * [DeviceActivityIndicator] whose readiness follows the foreground but
     * has no callback of its own. Each re-checks the advertisement; a fresh
     * `core.capabilities` snapshot goes out only when the set changed.
     */
    internal fun bindAdvertisementTriggers(host: DeviceHost, tracker: ForegroundActivityTracker, indicator: DeviceActivityIndicator?) {
        tracker.onBackground = {
            host.onHostSuspended()
            host.recheckCapabilities()
        }
        tracker.onForeground = {
            host.onHostResumed()
            host.recheckCapabilities()
        }
        (indicator as? ComposeDeviceActivityIndicator)?.onReadyChanged = { host.recheckCapabilities() }
    }
}
