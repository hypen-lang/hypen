/**
 * Capability drivers for the Android DeviceHost: gallery.pick,
 * permission.query, permission.request and bluetooth.scan.
 *
 * The protocol-facing logic (params, admission, consent, cooldowns, error
 * mapping, event coalescing) lives here and is JVM-testable. Everything that
 * touches the Android framework sits behind [GalleryPlatform],
 * [PermissionPlatform] and [BluetoothPlatform]; the real implementations are
 * in `space.hypen.renderer.device.android`.
 *
 * Activation model on Android (RFC 001 §2.6 / §7): system pickers and OS
 * runtime-permission dialogs supply their own per-use user choice and need no
 * app gesture, so gallery.pick and permission.request present them directly
 * (subject to a resumed foreground Activity — background activity starts are
 * restricted, so without one the result is `unavailable`). bluetooth.scan is
 * `persistable`: DeviceHost shows its own consent dialog naming the origin,
 * then the OS permission prompt if the permission is missing, and keeps a
 * host-owned indicator with a Stop control visible for the whole scan; it is
 * never started while the app is backgrounded ([DeviceDriver.requiresForeground])
 * and stops when its indicator can no longer be seen.
 */
package space.hypen.renderer.device

import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

/** A platform failure a driver maps directly to an error code. */
class DeviceDriverException(val code: DeviceErrorCode, val detail: String? = null) : Exception(detail ?: code.wireName)

// ---------------------------------------------------------------------------
// gallery.pick v1
// ---------------------------------------------------------------------------

enum class GalleryMediaFilter { IMAGES, VIDEOS, IMAGES_AND_VIDEOS }

data class GalleryPickRequest(val filter: GalleryMediaFilter, val maxCount: Int)

object GalleryParams {
    /**
     * gallery.pick-v1 `params`: `mediaTypes` is 1..2 unique items of
     * `photo`/`video` (`minItems: 1, uniqueItems: true`), `maxCount` 1..16.
     */
    fun validate(params: Map<String, Any?>): String? = DevicePayloads.validate("gallery.pick", 1, PayloadKind.PARAMS, params)

    /** Parse validated params (1..2 unique media types). */
    fun parse(params: Map<String, Any?>): GalleryPickRequest {
        val types = (params["mediaTypes"] as List<*>).toSet()
        val filter = when (types) {
            setOf("photo") -> GalleryMediaFilter.IMAGES
            setOf("video") -> GalleryMediaFilter.VIDEOS
            else -> GalleryMediaFilter.IMAGES_AND_VIDEOS
        }
        return GalleryPickRequest(filter, DeviceWire.exactLong(params["maxCount"])!!.toInt())
    }

    fun accepts(filter: GalleryMediaFilter, contentType: String): Boolean = when (filter) {
        GalleryMediaFilter.IMAGES -> contentType.startsWith("image/")
        GalleryMediaFilter.VIDEOS -> contentType.startsWith("video/")
        GalleryMediaFilter.IMAGES_AND_VIDEOS -> contentType.startsWith("image/") || contentType.startsWith("video/")
    }
}

/**
 * One picked item and a re-openable byte stream. [size] is its exact length
 * when the provider knows it (announced as `blobStart.bytes`), or null when
 * it does not (a streamed or transcoded item): the item is then streamed
 * without a declaration and bounded by `maxItemBytes` as it is read — never
 * spooled to a temp file just to learn its size (decision D5).
 */
class PickedMedia(
    val contentType: String,
    val size: Long?,
    val open: () -> InputStream,
    val release: () -> Unit = {},
)

interface GalleryPlatform {
    /** A resumed foreground Activity can present the system picker right now. */
    fun canPresent(): Boolean

    /**
     * Present the system photo picker and resolve the chosen items. Empty =
     * dismissed. Coroutine cancellation must unregister the result callback
     * (the system picker itself cannot be dismissed programmatically; its late
     * result is ignored). Items larger than [maxItemBytes] may be rejected by
     * throwing [DeviceDriverException]. Call [presenterGone] when the
     * Activity hosting the picker is destroyed while the picker stays up
     * (the host-wide prompt gate is released; the result is still awaited
     * until the operation ends).
     */
    suspend fun pick(request: GalleryPickRequest, maxItemBytes: Long, presenterGone: () -> Unit = {}): List<PickedMedia>
}

class GalleryPickDriver(private val platform: GalleryPlatform) : DeviceDriver {
    override val capability: String = "gallery.pick"
    override val binary: Boolean = true

    override fun validateParams(version: Long, params: Map<String, Any?>): String? = GalleryParams.validate(params)

    override suspend fun run(ctx: DriverContext): DriverOutcome {
        val req = GalleryParams.parse(ctx.request.params)
        val ticket = when (val admit = ctx.tryAcquirePrompt(capability)) {
            is PromptAdmit.Throttled -> return DriverOutcome.Error(DeviceErrorCode.THROTTLED, admit.detail)
            is PromptAdmit.Granted -> admit.ticket
        }
        val picked = ticket.use {
            if (!platform.canPresent()) return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
            // The picker is the per-use consent gate; its own presentation is not an app suspension.
            ctx.presenting = true
            try {
                platform.pick(req, ctx.revision.maxItemBytes, presenterGone = { ticket.close() })
            } catch (e: DeviceDriverException) {
                return DriverOutcome.Error(e.code, e.detail)
            } finally {
                ctx.presenting = false
            }
        }
        if (picked.isEmpty()) {
            // Dismissal is `cancelled`, never a permission denial (§2.6 step 4).
            ctx.recordDismissal(capability)
            return DriverOutcome.Error(DeviceErrorCode.CANCELLED, "picker-dismissed")
        }
        val chosen = picked.take(req.maxCount)
        picked.drop(req.maxCount).forEach { runCatching { it.release() } }
        fun fail(code: DeviceErrorCode, detail: String): DriverOutcome {
            chosen.forEach { runCatching { it.release() } }
            return DriverOutcome.Error(code, detail)
        }
        for (m in chosen) {
            val size = m.size
            if (size != null && (size < 0 || size > ctx.revision.maxItemBytes)) return fail(DeviceErrorCode.UNAVAILABLE, "item-exceeds-limit")
            if (!GalleryParams.accepts(req.filter, m.contentType)) return fail(DeviceErrorCode.INTERNAL, "unexpected-media-type")
        }
        return DriverOutcome.Result(
            blobs = chosen.mapIndexed { i, m -> DriverBlob(i, m.contentType, m.size, m.open, m.release) },
        )
    }
}

// ---------------------------------------------------------------------------
// permission.query / permission.request v1
// ---------------------------------------------------------------------------

/**
 * A portable permission name resolved to Android runtime permissions.
 * [anyGrants]: the group counts as granted when any member is (e.g. approximate
 * location, partial photo access).
 */
data class PermissionGroup(val name: String, val permissions: List<String>, val anyGrants: Boolean = false)

/**
 * The closed portable permission set ([DevicePermissions.ALL], RFC 001 §3
 * P1) → Android runtime permissions for a given API level. Exactly that set:
 * no aliases (the former `geolocation` is gone; `location` only) and no raw
 * `android.permission.*` names — the server must not need OS-specific
 * knowledge. Anything else is refused `invalidParams` at decode, before a
 * driver runs.
 */
object PermissionNames {
    private const val P = "android.permission."

    fun resolve(name: String, sdkInt: Int): PermissionGroup? = when (name) {
        "camera" -> PermissionGroup(name, listOf(P + "CAMERA"))
        "microphone" -> PermissionGroup(name, listOf(P + "RECORD_AUDIO"))
        // Below API 33 notifications have no runtime permission (empty group).
        "notifications" -> PermissionGroup(name, if (sdkInt >= 33) listOf(P + "POST_NOTIFICATIONS") else emptyList())
        "location" ->
            PermissionGroup(name, listOf(P + "ACCESS_FINE_LOCATION", P + "ACCESS_COARSE_LOCATION"), anyGrants = true)
        // What BLE scanning needs: BLUETOOTH_SCAN on 31+, location before.
        "bluetooth" -> when {
            sdkInt >= 31 -> PermissionGroup(name, listOf(P + "BLUETOOTH_SCAN"))
            sdkInt >= 29 -> PermissionGroup(name, listOf(P + "ACCESS_FINE_LOCATION"))
            else -> PermissionGroup(name, listOf(P + "ACCESS_FINE_LOCATION", P + "ACCESS_COARSE_LOCATION"), anyGrants = true)
        }
        "photos" -> when {
            sdkInt >= 34 -> PermissionGroup(
                name,
                listOf(P + "READ_MEDIA_IMAGES", P + "READ_MEDIA_VIDEO", P + "READ_MEDIA_VISUAL_USER_SELECTED"),
                anyGrants = true,
            )
            sdkInt >= 33 -> PermissionGroup(name, listOf(P + "READ_MEDIA_IMAGES", P + "READ_MEDIA_VIDEO"), anyGrants = true)
            else -> PermissionGroup(name, listOf(P + "READ_EXTERNAL_STORAGE"))
        }
        "contacts" -> PermissionGroup(name, listOf(P + "READ_CONTACTS"))
        else -> null
    }
}

/**
 * What the app's merged manifest declares on this device: the `<uses-permission>`
 * entries in effect at [sdkInt] (the OS already drops entries whose
 * `maxSdkVersion` is below it). This is the only permission input to the
 * advertisement ([CapabilityAdvertisement]): it carries no grant state and
 * no request history, so neither can influence what is offered or leak
 * through it (RFC 001 §2.2). Android: `PackageInfo.requestedPermissions`.
 */
interface DeclaredPermissions {
    val sdkInt: Int

    /** Declared in the merged app manifest (undeclared permissions are auto-denied). */
    fun isDeclared(permission: String): Boolean
}

/**
 * The advertisement rule (RFC 001 §2.2 "advertise only implementable
 * capabilities"), shared by every driver that needs an OS permission. A
 * capability is advertised iff (1) the hardware/platform feature exists,
 * (2) the app declared what the OS requires for it on this API level
 * ([declares]), and (3) for streams that must run under the host's
 * always-visible indicator (`bluetooth.scan`, `mic.record`) that indicator
 * can be shown right now. Whether the user has *granted* a permission never
 * matters: an un-asked permission is still advertised so the app can prompt,
 * and a refused one does not disappear (no permission history leaks).
 */
object CapabilityAdvertisement {
    /**
     * The manifest declares what the portable permission [name] needs at
     * [manifest]'s API level ([PermissionNames]); a name without a runtime
     * permission there (notifications below API 33) needs nothing.
     */
    fun declares(name: String, manifest: DeclaredPermissions): Boolean {
        val group = PermissionNames.resolve(name, manifest.sdkInt) ?: return false
        return group.permissions.isEmpty() || PermissionLogic.effective(group, manifest) != null
    }

    fun offer(hardware: Boolean, declared: Boolean, indicatorReady: Boolean = true): Boolean = hardware && declared && indicatorReady
}

interface PermissionPlatform : DeclaredPermissions {
    fun isGranted(permission: String): Boolean

    /** This app has asked for [permission] before (local history). */
    fun wasRequested(permission: String): Boolean

    fun markRequested(permissions: Collection<String>)

    /**
     * The latest OS dialog answered [permission] with an explicit denial
     * (not a dismissal, and not since granted). Together with a definite
     * "no rationale" it is the only evidence of a permanent denial.
     */
    fun wasDenied(permission: String): Boolean = false

    /** Record an OS dialog's result map (empty when the dialog was dismissed). */
    fun recordResults(results: Map<String, Boolean>) {}

    /**
     * `shouldShowRequestPermissionRationale`, or null without a foreground
     * Activity (unknown: the answer needs one).
     */
    fun shouldShowRationale(permission: String): Boolean?

    /** `NotificationManagerCompat.areNotificationsEnabled()` (pre-33 notifications). */
    fun notificationsEnabled(): Boolean

    fun canPresent(): Boolean

    /**
     * Show the OS runtime-permission dialog; cancellation unregisters the
     * callback. The map is empty when the dialog was dismissed without an
     * answer. [presenterGone]: see [GalleryPlatform.pick].
     */
    suspend fun request(permissions: List<String>, presenterGone: () -> Unit = {}): Map<String, Boolean>
}

internal object PermissionLogic {
    /** The members the app actually declared, or null when the group is unusable. */
    fun effective(group: PermissionGroup, platform: DeclaredPermissions): PermissionGroup? {
        val declared = group.permissions.filter(platform::isDeclared)
        return when {
            group.anyGrants && declared.isNotEmpty() -> group.copy(permissions = declared)
            !group.anyGrants && declared.size == group.permissions.size -> group
            else -> null
        }
    }

    fun isGranted(group: PermissionGroup, platform: PermissionPlatform): Boolean =
        if (group.anyGrants) group.permissions.any(platform::isGranted) else group.permissions.all(platform::isGranted)

    /**
     * `granted` / `prompt` / `denied` without prompting (`permission.query`
     * only). Android cannot tell "never asked", "dismissed", "one-time grant
     * expired" and "permanently denied" apart directly, so `denied` needs
     * positive evidence: the latest OS answer was an explicit denial and
     * `shouldShowRequestPermissionRationale` is definitely false. Anything
     * less certain — no history, a dismissed dialog, an unknown rationale
     * (no foreground Activity) — is `prompt`. `permission.request` never
     * relies on this: it always shows the OS dialog (see
     * [PermissionRequestDriver]).
     */
    fun status(group: PermissionGroup, platform: PermissionPlatform): String {
        if (group.permissions.isEmpty()) return if (platform.notificationsEnabled()) "granted" else "denied"
        if (isGranted(group, platform)) return "granted"
        val missing = group.permissions.filterNot(platform::isGranted)
        if (missing.none(platform::wasRequested)) return "prompt"
        if (missing.any { platform.shouldShowRationale(it) != false }) return "prompt"
        if (missing.none(platform::wasDenied)) return "prompt"
        return "denied"
    }

    /**
     * Show the OS dialog for the [effective] group's missing members (the
     * caller holds the prompt gate) and classify the answer: granted; a
     * dismissal (no answer: `cancelled`, short cooldown); or a denial
     * (`denied`, full cooldown), reported `permanently-denied` only when the
     * OS now says it will not show a rationale.
     */
    suspend fun present(
        ctx: DriverContext,
        platform: PermissionPlatform,
        effective: PermissionGroup,
        cooldownKey: String,
        deniedDetail: String,
        presenterGone: () -> Unit,
    ): DriverOutcome? {
        val missing = effective.permissions.filterNot(platform::isGranted)
        val answer = try {
            ctx.presenting = true
            platform.request(missing, presenterGone)
        } catch (e: DeviceDriverException) {
            // e.g. the Activity hosting the dialog was destroyed: `cancelled`, gate released.
            return DriverOutcome.Error(e.code, e.detail)
        } finally {
            ctx.presenting = false
            platform.markRequested(missing)
        }
        platform.recordResults(answer)
        if (isGranted(effective, platform)) return null
        if (missing.none { it in answer }) {
            ctx.recordDismissal(cooldownKey)
            return DriverOutcome.Error(DeviceErrorCode.CANCELLED, "dialog-dismissed")
        }
        ctx.recordDenial(cooldownKey)
        val permanent = missing.all { platform.shouldShowRationale(it) == false }
        return DriverOutcome.Error(DeviceErrorCode.DENIED, if (permanent) "permanently-denied" else deniedDetail)
    }

    /** permission.query/request-v1 `params`: `{permission}` from the closed enum. */
    fun validate(params: Map<String, Any?>): String? {
        closedKeys(params, setOf("permission"))?.let { return it }
        val name = params["permission"] as? String ?: return "permission must be a string"
        if (name !in DevicePermissions.ALL) return "permission must be one of ${DevicePermissions.ALL}"
        return null
    }

    /** A name this host cannot represent at all: `unsupported`, detail = the name (P1). */
    fun unsupported(name: String): DriverOutcome.Error = DriverOutcome.Error(DeviceErrorCode.UNSUPPORTED, name)
}

class PermissionQueryDriver(private val platform: PermissionPlatform) : DeviceDriver {
    override val capability: String = "permission.query"

    override fun validateParams(version: Long, params: Map<String, Any?>): String? = PermissionLogic.validate(params)

    override suspend fun run(ctx: DriverContext): DriverOutcome {
        val name = ctx.request.params["permission"] as String
        val group = PermissionNames.resolve(name, platform.sdkInt) ?: return PermissionLogic.unsupported(name)
        if (group.permissions.isEmpty()) return DriverOutcome.Result(mapOf("status" to PermissionLogic.status(group, platform)))
        val effective = PermissionLogic.effective(group, platform)
            ?: return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "not-declared:$name")
        // Never prompts (§3).
        return DriverOutcome.Result(mapOf("status" to PermissionLogic.status(effective, platform)))
    }
}

class PermissionRequestDriver(private val platform: PermissionPlatform) : DeviceDriver {
    override val capability: String = "permission.request"

    override fun validateParams(version: Long, params: Map<String, Any?>): String? = PermissionLogic.validate(params)

    override suspend fun run(ctx: DriverContext): DriverOutcome {
        val name = ctx.request.params["permission"] as String
        val group = PermissionNames.resolve(name, platform.sdkInt) ?: return PermissionLogic.unsupported(name)
        if (group.permissions.isEmpty()) {
            return if (platform.notificationsEnabled()) {
                DriverOutcome.Result(mapOf("status" to "granted"))
            } else {
                DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "not-promptable:$name")
            }
        }
        val effective = PermissionLogic.effective(group, platform)
            ?: return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "not-declared:$name")
        if (PermissionLogic.isGranted(effective, platform)) return DriverOutcome.Result(mapOf("status" to "granted"))
        // Never short-circuit on local history: a dismissed dialog, an expired
        // one-time grant or an auto-reset all look like "denied" locally, yet
        // the OS would ask again. Only the OS answer decides (gated, cooled down).
        val cooldownKey = "permission:$name"
        val ticket = when (val admit = ctx.tryAcquirePrompt(cooldownKey)) {
            is PromptAdmit.Throttled -> return DriverOutcome.Error(DeviceErrorCode.THROTTLED, admit.detail)
            is PromptAdmit.Granted -> admit.ticket
        }
        ticket.use {
            if (!platform.canPresent()) return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
            PermissionLogic.present(ctx, platform, effective, cooldownKey, "user-declined") { ticket.close() }?.let { return it }
        }
        return DriverOutcome.Result(mapOf("status" to "granted"))
    }
}

// ---------------------------------------------------------------------------
// bluetooth.scan v1
// ---------------------------------------------------------------------------

enum class AdapterState { NO_ADAPTER, OFF, ON }

/** Scan callbacks; may be invoked on any thread. */
interface BluetoothScanListener {
    fun onDevice(id: String, name: String?, rssi: Int)

    /**
     * An advertisement with its advertised service UUIDs (lowercase 128-bit
     * form). Platforms call this; the default forwards to [onDevice].
     */
    fun onAdvertisement(id: String, name: String?, rssi: Int, serviceUuids: List<String>) = onDevice(id, name, rssi)

    fun onScanFailed(errorCode: Int)

    fun onAdapterOff()
}

fun interface ScanHandle {
    /** Stop scanning and unregister receivers. Idempotent. */
    fun stop()
}

interface BluetoothPlatform {
    /** The device has Bluetooth LE hardware (otherwise the capability is not advertised). */
    fun hasBle(): Boolean

    fun adapterState(): AdapterState

    /** Start a BLE scan. Throws [DeviceDriverException] when it cannot start. */
    fun startScan(listener: BluetoothScanListener): ScanHandle

    /**
     * Location Services (the system location toggle) are on. Scans that are
     * location-derived (API ≤ 30, or API 31+ without `neverForLocation`)
     * silently return no results while it is off.
     */
    fun locationServicesEnabled(): Boolean = true

    /**
     * API 31+: the manifest declares `BLUETOOTH_SCAN` with
     * `android:usesPermissionFlags="neverForLocation"`. Without it, scanning
     * also needs `ACCESS_FINE_LOCATION` and Location Services. Ignored ≤ 30.
     */
    fun scanDisavowsLocation(): Boolean = true
}

/**
 * Rate-limits BLE advertisements into `{device:{id,name?,rssi}}` events: a
 * device is re-reported only after [minIntervalMs], an RSSI change of at
 * least [rssiDeltaDb], or a newly learned name. Bounded LRU of tracked ids.
 * (Credit exhaustion is coalesced separately, per device id, by the runtime.)
 */
class BluetoothEventCoalescer(
    private val minIntervalMs: Long = 1_000,
    private val rssiDeltaDb: Int = 6,
    private val maxTracked: Int = 512,
) {
    private class Seen(var atMs: Long, var rssi: Int, var name: String?)

    private val seen = object : LinkedHashMap<String, Seen>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Seen>?): Boolean = size > maxTracked
    }

    fun offer(id: String, name: String?, rssi: Int, nowMs: Long): Map<String, Any?>? {
        // Schema bounds are code points; truncation never splits a surrogate pair.
        val cid = id.truncateCodePoints(128)
        val cname = name?.truncateCodePoints(256)?.takeIf { it.isNotEmpty() }
        val r = rssi.coerceIn(-32768, 32767)
        val prev = seen[cid]
        if (prev != null) {
            val newName = cname != null && cname != prev.name
            val due = nowMs - prev.atMs >= minIntervalMs || kotlin.math.abs(r - prev.rssi) >= rssiDeltaDb
            if (!due && !newName) return null
            prev.atMs = nowMs
            prev.rssi = r
            if (cname != null) prev.name = cname
        } else {
            seen[cid] = Seen(nowMs, r, cname)
        }
        val device = linkedMapOf<String, Any?>("id" to cid)
        (cname ?: prev?.name)?.let { device["name"] = it }
        device["rssi"] = r
        return mapOf("device" to device)
    }
}

/**
 * bluetooth.scan v1. Preconditions per API level (RFC 001 §5; otherwise the
 * scan is a "healthy" stream that never emits): the adapter must be on; a
 * location-derived scan (API ≤ 30, or API 31+ without `neverForLocation`)
 * also needs Location Services on and fine location — all `unavailable` /
 * OS-prompted before any scan starts. While scanning, [indicator] shows the
 * mandatory host indicator with a Stop control; Stop ends the op `cancelled`.
 * Advertised only on BLE hardware, when the manifest declares what a scan
 * needs on this API level (see [BleRequirements]), and while that indicator
 * is ready ([CapabilityAdvertisement]).
 */
class BluetoothScanDriver(
    private val bluetooth: BluetoothPlatform,
    private val permissions: PermissionPlatform,
    private val indicator: DeviceActivityIndicator,
    private val coalesceIntervalMs: Long = 1_000,
) : DeviceDriver {
    override val capability: String = "bluetooth.scan"

    /** BLE hardware, the manifest entries a scan needs on this API level, and a ready indicator (never grants). */
    override fun isAvailable(): Boolean =
        CapabilityAdvertisement.offer(bluetooth.hasBle(), BleRequirements(bluetooth, permissions).declared(), indicator.isReady)

    override fun awaitsIndicator(): Boolean =
        !indicator.isReady && CapabilityAdvertisement.offer(bluetooth.hasBle(), BleRequirements(bluetooth, permissions).declared())

    /** Never while backgrounded: its indicator must be visible (RFC 001 §5). */
    override val requiresForeground: Boolean get() = true

    override fun validateParams(version: Long, params: Map<String, Any?>): String? = closedKeys(params, emptySet())

    private sealed class Signal {
        class Device(val id: String, val name: String?, val rssi: Int) : Signal()

        class Failed(val code: Int) : Signal()

        data object AdapterOff : Signal()

        data object UserStopped : Signal()

        data object IndicatorHidden : Signal()
    }

    /** The permissions a scan needs on this device (see the class doc). */
    internal fun requiredGroup(): PermissionGroup = BleRequirements(bluetooth, permissions).requiredGroup()

    private fun needsLocationServices(): Boolean = BleRequirements(bluetooth, permissions).needsLocationServices()

    override suspend fun run(ctx: DriverContext): DriverOutcome {
        when (bluetooth.adapterState()) {
            AdapterState.NO_ADAPTER -> return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-adapter")
            AdapterState.OFF -> return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "adapter-off")
            AdapterState.ON -> Unit
        }
        val effective = PermissionLogic.effective(requiredGroup(), permissions)
            ?: return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "not-declared:bluetooth")
        if (needsLocationServices() && !bluetooth.locationServicesEnabled()) {
            return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "location-services-off")
        }
        if (!indicator.isReady) return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-activity-indicator")
        val needConsent = !ctx.hasConsent(capability)
        // A missing OS permission is always asked for (gated, cooled down):
        // local history cannot tell a dismissal from a permanent denial.
        val needOs = !PermissionLogic.isGranted(effective, permissions)
        if (needConsent || needOs) {
            val ticket = when (val admit = ctx.tryAcquirePrompt(capability, "permission:bluetooth")) {
                is PromptAdmit.Throttled -> return DriverOutcome.Error(DeviceErrorCode.THROTTLED, admit.detail)
                is PromptAdmit.Granted -> admit.ticket
            }
            ticket.use {
                if (needConsent) {
                    val prompt = ConsentPrompt(ctx.origin, capability, "scan for nearby Bluetooth devices")
                    when (ctx.consent.present(prompt)) {
                        ConsentDecision.UNAVAILABLE -> return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "consent-unavailable")
                        ConsentDecision.CANCEL -> {
                            ctx.recordDenial(capability)
                            return DriverOutcome.Error(DeviceErrorCode.DENIED, "host-refused")
                        }
                        // Back / outside tap / Activity gone: abandonment, no cooldown.
                        ConsentDecision.DISMISSED -> return DriverOutcome.Error(DeviceErrorCode.CANCELLED, "consent-dismissed")
                        ConsentDecision.CONTINUE -> ctx.grantConsent(capability)
                    }
                }
                if (needOs) {
                    if (!permissions.canPresent()) return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
                    PermissionLogic.present(ctx, permissions, effective, "permission:bluetooth", "permission-denied") { ticket.close() }
                        ?.let { return it }
                }
            }
        }
        if (bluetooth.adapterState() != AdapterState.ON) return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "adapter-off")

        val signals = Channel<Signal>(capacity = 256, onBufferOverflow = BufferOverflow.DROP_OLDEST)
        // The Stop flag survives a flood of device signals (DROP_OLDEST keeps
        // the newest, and any later signal re-checks the flag).
        val stopRequested = AtomicBoolean(false)
        val stopReason = java.util.concurrent.atomic.AtomicReference<IndicatorStopReason?>(null)
        val shown = indicator.show(ctx.origin, SCAN_ACTIVITY) { reason ->
            stopReason.compareAndSet(null, reason)
            stopRequested.set(true)
            signals.trySend(if (reason == IndicatorStopReason.HIDDEN) Signal.IndicatorHidden else Signal.UserStopped)
        } ?: return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-activity-indicator")
        try {
            return scan(ctx, signals, stopRequested) { stopReason.get() }
        } finally {
            runCatching { shown.hide() }
        }
    }

    private suspend fun scan(
        ctx: DriverContext,
        signals: Channel<Signal>,
        stopRequested: AtomicBoolean,
        stopReason: () -> IndicatorStopReason?,
    ): DriverOutcome {
        fun stopped() = DriverOutcome.Error(
            DeviceErrorCode.CANCELLED,
            if (stopReason() == IndicatorStopReason.HIDDEN) INDICATOR_HIDDEN else USER_STOPPED,
        )
        val handle = try {
            bluetooth.startScan(object : BluetoothScanListener {
                override fun onDevice(id: String, name: String?, rssi: Int) {
                    signals.trySend(Signal.Device(id, name, rssi))
                }

                override fun onScanFailed(errorCode: Int) {
                    signals.trySend(Signal.Failed(errorCode))
                }

                override fun onAdapterOff() {
                    signals.trySend(Signal.AdapterOff)
                }
            })
        } catch (e: DeviceDriverException) {
            return DriverOutcome.Error(e.code, e.detail)
        } catch (_: SecurityException) {
            return DriverOutcome.Error(DeviceErrorCode.REVOKED, "security-exception")
        }
        val coalescer = BluetoothEventCoalescer(coalesceIntervalMs)
        try {
            for (s in signals) {
                if (stopRequested.get()) return stopped()
                when (s) {
                    is Signal.Device -> coalescer.offer(s.id, s.name, s.rssi, ctx.nowMs())?.let { ctx.emit(it, coalesceKey = s.id) }
                    is Signal.Failed -> return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "scan-failed:${s.code}")
                    Signal.AdapterOff -> return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "adapter-off")
                    Signal.UserStopped, Signal.IndicatorHidden -> return stopped()
                }
            }
        } finally {
            // Stops on cancel, deadline, lease expiry, host suspension and detach.
            runCatching { handle.stop() }
        }
        awaitCancellation()
    }

    companion object {
        /** Host-defined indicator label (never server text). */
        const val SCAN_ACTIVITY: String = "Scanning for nearby Bluetooth devices"
        const val USER_STOPPED: String = "user-stopped"
        const val INDICATOR_HIDDEN: String = "indicator-hidden"
    }
}
