package space.hypen.renderer.device.android

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.AssetFileDescriptor
import android.location.LocationManager
import android.net.Uri
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.location.LocationManagerCompat
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import space.hypen.renderer.device.AdapterState
import space.hypen.renderer.device.BluetoothPlatform
import space.hypen.renderer.device.BluetoothScanListener
import space.hypen.renderer.device.CooldownStore
import space.hypen.renderer.device.DeviceDriverException
import space.hypen.renderer.device.DeviceErrorCode
import space.hypen.renderer.device.GalleryMediaFilter
import space.hypen.renderer.device.GalleryPickRequest
import space.hypen.renderer.device.GalleryPlatform
import space.hypen.renderer.device.InMemoryCooldownStore
import space.hypen.renderer.device.PermissionPlatform
import space.hypen.renderer.device.PickedMedia
import space.hypen.renderer.device.ScanHandle
import space.hypen.renderer.device.isAuthenticatedOrigin
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * gallery.pick via the Android photo picker (`PickVisualMedia` /
 * `PickMultipleVisualMedia`; falls back to `ACTION_OPEN_DOCUMENT` on devices
 * without it). The picker is the per-use consent gate and needs no media
 * permission. Bytes are read through [android.content.ContentResolver].
 *
 * An item's size comes from its file descriptor (`openAssetFileDescriptor`
 * `length`, i.e. the real `fstat` size) rather than `OpenableColumns.SIZE`,
 * which some providers report stale or estimated; it is announced as
 * `blobStart.bytes` and checked when the item ends. An item without a
 * determinable length (a pipe, a streamed or transcoding provider) is
 * streamed **without** a declaration (RFC 001 §2.4, decision D5), bounded by
 * `maxItemBytes` as it is read — it is never spooled to a temp file just to
 * learn its size, so nothing is left behind on cancellation.
 */
internal class AndroidGalleryPlatform(
    private val context: Context,
    private val tracker: ForegroundActivityTracker,
    private val io: CoroutineDispatcher,
) : GalleryPlatform {
    override fun canPresent(): Boolean = tracker.foreground() != null

    override suspend fun pick(request: GalleryPickRequest, maxItemBytes: Long, presenterGone: () -> Unit): List<PickedMedia> {
        val activity = tracker.foreground() ?: throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
        val type = when (request.filter) {
            GalleryMediaFilter.IMAGES -> ActivityResultContracts.PickVisualMedia.ImageOnly
            GalleryMediaFilter.VIDEOS -> ActivityResultContracts.PickVisualMedia.VideoOnly
            GalleryMediaFilter.IMAGES_AND_VIDEOS -> ActivityResultContracts.PickVisualMedia.ImageAndVideo
        }
        val input = PickVisualMediaRequest.Builder().setMediaType(type).build()
        val uris: List<Uri> = if (request.maxCount > 1) {
            launchForResult(tracker, activity, ActivityResultContracts.PickMultipleVisualMedia(request.maxCount), input, presenterGone)
        } else {
            listOfNotNull(launchForResult(tracker, activity, ActivityResultContracts.PickVisualMedia(), input, presenterGone))
        }
        return withContext(io) {
            uris.take(request.maxCount).map { uri ->
                ensureActive() // a cancelled pick stops resolving (nothing to clean up: no temp files)
                resolve(uri, maxItemBytes)
            }
        }
    }

    private fun resolve(uri: Uri, maxItemBytes: Long): PickedMedia {
        val resolver = context.contentResolver
        val contentType = resolver.getType(uri) ?: "application/octet-stream"
        // The message never leaves the device (DeviceHost sends fixed tokens only).
        val open: () -> InputStream = { resolver.openInputStream(uri) ?: throw IOException("provider returned no stream") }
        val size = runCatching {
            resolver.openAssetFileDescriptor(uri, "r")?.use { it.length.takeIf { n -> n != AssetFileDescriptor.UNKNOWN_LENGTH } }
        }.getOrNull()?.takeIf { it >= 0 }
        if (size != null && size > maxItemBytes) throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "item-exceeds-limit")
        return PickedMedia(contentType, size, open)
    }

    companion object {
        /**
         * Delete `hypen-device-*.blob` spool files an older version left in
         * [cacheDir] (e.g. after process death mid-pick). Blocking I/O.
         */
        fun sweepStaleSpoolFiles(cacheDir: File) {
            cacheDir.listFiles { f -> f.isFile && f.name.startsWith("hypen-device-") && f.name.endsWith(".blob") }
                ?.forEach { runCatching { it.delete() } }
        }
    }
}

/**
 * Runtime permissions via ContextCompat / `RequestMultiplePermissions`.
 * Request history lives in [prefs] so a never-asked permission (`prompt`) can
 * be told apart from a permanently denied one (`denied`).
 */
internal class AndroidPermissionPlatform(
    private val context: Context,
    private val tracker: ForegroundActivityTracker,
    private val prefs: SharedPreferences,
    private val manifest: ManifestPermissions = ManifestPermissions.read(context),
) : PermissionPlatform {
    override val sdkInt: Int get() = manifest.sdkInt

    override fun isDeclared(permission: String): Boolean = manifest.isDeclared(permission)

    override fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    override fun wasRequested(permission: String): Boolean = prefs.getBoolean("requested|$permission", false)

    override fun markRequested(permissions: Collection<String>) {
        prefs.edit { permissions.forEach { putBoolean("requested|$it", true) } }
    }

    override fun wasDenied(permission: String): Boolean =
        prefs.getBoolean("denied|$permission", false) && !isGranted(permission)

    override fun recordResults(results: Map<String, Boolean>) {
        if (results.isEmpty()) return // dismissed: no evidence either way
        prefs.edit { results.forEach { (p, granted) -> putBoolean("denied|$p", !granted) } }
    }

    override fun shouldShowRationale(permission: String): Boolean? =
        tracker.foreground()?.let { ActivityCompat.shouldShowRequestPermissionRationale(it, permission) }

    override fun notificationsEnabled(): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

    override fun canPresent(): Boolean = tracker.foreground() != null

    override suspend fun request(permissions: List<String>, presenterGone: () -> Unit): Map<String, Boolean> {
        val activity = tracker.foreground() ?: throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
        return launchForResult(tracker, activity, ActivityResultContracts.RequestMultiplePermissions(), permissions.toTypedArray(), presenterGone)
    }
}

/**
 * bluetooth.scan via [android.bluetooth.le.BluetoothLeScanner]. Callers check
 * BLUETOOTH_SCAN (API 31+) / location (API ≤ 30, or 31+ without
 * `neverForLocation`) and Location Services before [startScan]. Names come
 * from the advertisement's scan record, which needs no BLUETOOTH_CONNECT.
 * Platform limit: unfiltered scans pause while the screen is off (8.1+).
 */
internal class AndroidBluetoothPlatform(
    private val context: Context,
    private val manifest: ManifestPermissions = ManifestPermissions.read(context),
) : BluetoothPlatform {
    private val manager: BluetoothManager? = context.getSystemService(BluetoothManager::class.java)

    override fun locationServicesEnabled(): Boolean {
        val lm = context.getSystemService(LocationManager::class.java) ?: return false
        return LocationManagerCompat.isLocationEnabled(lm)
    }

    override fun scanDisavowsLocation(): Boolean = manifest.neverForLocation(BLUETOOTH_SCAN)

    private companion object {
        /** `Manifest.permission.BLUETOOTH_SCAN` (API 31) as a plain name: it is only a lookup key here. */
        const val BLUETOOTH_SCAN = "android.permission.BLUETOOTH_SCAN"
    }

    override fun hasBle(): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) && manager?.adapter != null

    override fun adapterState(): AdapterState {
        val adapter = manager?.adapter ?: return AdapterState.NO_ADAPTER
        return if (adapter.isEnabled) AdapterState.ON else AdapterState.OFF
    }

    @SuppressLint("MissingPermission") // checked by BluetoothScanDriver before starting
    override fun startScan(listener: BluetoothScanListener): ScanHandle {
        val adapter = manager?.adapter ?: throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "no-adapter")
        val scanner = adapter.bluetoothLeScanner ?: throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "adapter-off")
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val services = result.scanRecord?.serviceUuids?.map { it.uuid.toString().lowercase(java.util.Locale.ROOT) }.orEmpty()
                listener.onAdvertisement(result.device.address, result.scanRecord?.deviceName, result.rssi, services)
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                results.forEach { onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, it) }
            }

            override fun onScanFailed(errorCode: Int) = listener.onScanFailed(errorCode)
        }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
                if (state == BluetoothAdapter.STATE_TURNING_OFF || state == BluetoothAdapter.STATE_OFF) listener.onAdapterOff()
            }
        }
        ContextCompat.registerReceiver(
            context,
            receiver,
            IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        try {
            val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
            scanner.startScan(null, settings, callback)
        } catch (t: Throwable) {
            runCatching { context.unregisterReceiver(receiver) }
            throw t
        }
        val stopped = AtomicBoolean(false)
        return ScanHandle {
            if (stopped.compareAndSet(false, true)) {
                runCatching { scanner.stopScan(callback) }
                runCatching { context.unregisterReceiver(receiver) }
            }
        }
    }
}

/**
 * Cooldowns persisted across restarts for authenticated (`wss:`/`https:`)
 * origins; in-memory (host lifetime) for plaintext development origins
 * (RFC 001 §5).
 */
internal class SharedPreferencesCooldownStore(private val prefs: SharedPreferences) : CooldownStore {
    private val memory = InMemoryCooldownStore()

    override fun until(origin: String, key: String): Long =
        if (isAuthenticatedOrigin(origin)) prefs.getLong("cooldown|$origin|$key", 0L) else memory.until(origin, key)

    override fun set(origin: String, key: String, untilWallMs: Long) {
        if (isAuthenticatedOrigin(origin)) prefs.edit { putLong("cooldown|$origin|$key", untilWallMs) } else memory.set(origin, key, untilWallMs)
    }
}
