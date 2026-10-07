/**
 * Round-3 capability drivers for the Android DeviceHost (RFC 001 §2.4, §3,
 * §5): `file.pick`, `file.save` (the server → client download plane),
 * `camera.capture`, `mic.record` and `bluetooth.select`.
 *
 * Like [CapabilityDrivers.kt], the protocol logic lives here and reaches the
 * OS only through small platform interfaces, so every driver is unit-tested
 * on the JVM through fakes; `device/android/CapturePlatforms.kt` holds the
 * Android implementations (SAF, camera intents + FileProvider, AudioRecord,
 * a BLE chooser dialog).
 *
 * Params reach a driver only after the host validated them against the
 * revision schema ([DevicePayloads]), so drivers read them without
 * re-checking their shape.
 */
package space.hypen.renderer.device

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

/** Host-owned consent (Continue / Cancel) mapped to the usual outcomes; null = Continue. */
internal suspend fun DriverContext.hostConsent(capability: String, operation: String): DriverOutcome.Error? =
    when (consent.present(ConsentPrompt(origin, capability, operation))) {
        ConsentDecision.CONTINUE -> null
        ConsentDecision.UNAVAILABLE -> DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "consent-unavailable")
        ConsentDecision.CANCEL -> {
            recordDenial(capability)
            DriverOutcome.Error(DeviceErrorCode.DENIED, "host-refused")
        }
        // Back / outside tap / Activity gone: abandonment, no cooldown.
        ConsentDecision.DISMISSED -> DriverOutcome.Error(DeviceErrorCode.CANCELLED, "consent-dismissed")
    }

private inline fun DriverContext.withPrompt(vararg keys: String, block: (PromptTicket) -> DriverOutcome?): DriverOutcome? {
    val ticket = when (val admit = tryAcquirePrompt(*keys)) {
        is PromptAdmit.Throttled -> return DriverOutcome.Error(DeviceErrorCode.THROTTLED, admit.detail)
        is PromptAdmit.Granted -> admit.ticket
    }
    return ticket.use { block(it) }
}

// ---------------------------------------------------------------------------
// file.pick v1
// ---------------------------------------------------------------------------

/**
 * One picked document and a re-openable byte stream. [size] is its exact
 * length when the provider knows it (declared as `blobStart.bytes`), or
 * null (streamed without a declaration, bounded by `maxItemBytes`, D5).
 */
class PickedDocument(
    val name: String,
    val contentType: String,
    val size: Long?,
    val open: () -> InputStream,
    val release: () -> Unit = {},
)

interface FilePickPlatform {
    /** A resumed foreground Activity can present the system picker right now. */
    fun canPresent(): Boolean

    /** The MIME type of a file extension (Android: `MimeTypeMap`), or null when unknown. */
    fun mimeForExtension(ext: String): String? = null

    /**
     * Present the system document picker (`ACTION_OPEN_DOCUMENT` with
     * `EXTRA_MIME_TYPES`, `EXTRA_ALLOW_MULTIPLE` when [multiple]) and resolve
     * the chosen documents. Empty = dismissed. Cancellation unregisters the
     * result callback. [presenterGone]: see [GalleryPlatform.pick].
     */
    suspend fun pick(mimeTypes: List<String>, multiple: Boolean, maxItemBytes: Long, presenterGone: () -> Unit = {}): List<PickedDocument>
}

/**
 * `file.pick@1`: the system document picker is the per-use consent gate
 * (reported as `pendingConsent` while open). `accept` holds MIME types,
 * `type/` wildcards or extensions; the picker is filtered by them and every
 * picked item is matched again (an item outside the filter is dropped: a
 * provider may ignore `EXTRA_MIME_TYPES`, and an unknown extension widens the
 * picker). Items carry their display `name`; sizes are declared when known.
 */
class FilePickDriver(private val platform: FilePickPlatform) : DeviceDriver {
    override val capability: String = "file.pick"
    override val binary: Boolean = true

    override fun validateParams(version: Long, params: Map<String, Any?>): String? {
        @Suppress("UNCHECKED_CAST")
        val accept = params["accept"] as? List<String> ?: return "accept must be an array"
        return if (DocumentTypeFilter.parse(accept) == null) "accept entries must be MIME types, type/ wildcards or extensions" else null
    }

    override suspend fun run(ctx: DriverContext): DriverOutcome {
        @Suppress("UNCHECKED_CAST")
        val filters = DocumentTypeFilter.parse(ctx.request.params["accept"] as List<String>)
            ?: return DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "accept")
        val maxCount = DeviceWire.exactLong(ctx.request.params["maxCount"])!!.toInt()
        var picked: List<PickedDocument> = emptyList()
        ctx.withPrompt(capability) { ticket ->
            if (!platform.canPresent()) return@withPrompt DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
            ctx.progress(ProgressState.PENDING_CONSENT)
            ctx.presenting = true
            try {
                picked = platform.pick(DocumentTypeFilter.mimeTypes(filters, platform::mimeForExtension), maxCount > 1, ctx.revision.maxItemBytes) { ticket.close() }
            } catch (e: DeviceDriverException) {
                return@withPrompt DriverOutcome.Error(e.code, e.detail)
            } finally {
                ctx.presenting = false
            }
            null
        }?.let { return it }
        if (picked.isEmpty()) {
            ctx.recordDismissal(capability)
            return DriverOutcome.Error(DeviceErrorCode.CANCELLED, "picker-dismissed")
        }
        val (fitting, outside) = picked.partition { d -> filters.isEmpty() || filters.any { it.matches(d.name, d.contentType) } }
        val chosen = fitting.take(maxCount)
        (outside + fitting.drop(maxCount)).forEach { runCatching { it.release() } }
        if (chosen.isEmpty()) return DriverOutcome.Error(DeviceErrorCode.CANCELLED, "no-matching-item")
        for (d in chosen) {
            val size = d.size
            if (size != null && (size < 0 || size > ctx.revision.maxItemBytes)) {
                chosen.forEach { runCatching { it.release() } }
                return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "item-exceeds-limit")
            }
        }
        ctx.progress(ProgressState.RUNNING)
        return DriverOutcome.Result(
            blobs = chosen.mapIndexed { i, d ->
                DriverBlob(
                    i,
                    DeviceCaptureSupport.contentType(d.contentType),
                    d.size,
                    d.open,
                    d.release,
                    extra = mapOf("name" to d.name.truncateCodePoints(FILE_NAME_MAX)),
                )
            },
        )
    }

    private companion object {
        const val FILE_NAME_MAX = 512
    }
}

// ---------------------------------------------------------------------------
// file.save v1 (server → client download plane)
// ---------------------------------------------------------------------------

/**
 * Where a download is written (Android: the `Uri` `ACTION_CREATE_DOCUMENT`
 * returned). Writes happen in order as chunks arrive — never the whole file
 * in memory beyond the credit window.
 */
interface SaveTarget {
    /** Append [bytes]. Throws [IOException] on a write failure. */
    suspend fun write(bytes: ByteArray)

    /** Every byte arrived and was verified: flush and close the destination. */
    suspend fun commit()

    /**
     * Delete the partial output (the created document). Idempotent. A
     * provider that cannot delete may keep a partial file (documented limit:
     * `ACTION_CREATE_DOCUMENT` has no atomic commit).
     */
    suspend fun discard()
}

interface FileSavePlatform {
    fun canPresent(): Boolean

    /**
     * Present the system "save as" picker (`ACTION_CREATE_DOCUMENT`,
     * suggested [name] and [contentType]). Null = dismissed.
     */
    suspend fun createDocument(name: String, contentType: String, presenterGone: () -> Unit = {}): SaveTarget?
}

/**
 * `file.save@1` over the server → client download plane (RFC 001 §2.3/§2.4,
 * C1). Order: the host consent dialog naming the origin and what is saved,
 * then the system destination picker (both reported as `pendingConsent`;
 * the lease runs meanwhile). Only once a destination is chosen does the host
 * grant credit — a window of at most [window] bytes (≤ 256 KiB, ≤ the
 * revision's outstanding bound, ≤ the declared size) — replenished only as
 * bytes are written, never past the declaration. The runtime checks every
 * frame (channel 0, contiguous seq, ≤ 64 KiB, never empty, within credit and
 * the declared size) and the SHA-256; after verification the destination is
 * committed and the driver answers `{bytesWritten}`. Cancel, deadline, lease
 * expiry, detach, a violation or a write failure delete the partial output.
 */
class FileSaveDriver(private val platform: FileSavePlatform, window: Long = MAX_WINDOW) : DeviceDriver {
    override val capability: String = "file.save"
    override val binary: Boolean = true

    /** Credit window granted after the destination is chosen. */
    val window: Long = window.coerceIn(1, MAX_WINDOW)

    override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

    override suspend fun run(ctx: DriverContext): DriverOutcome {
        val params = ctx.request.params
        val declared = DeviceWire.exactLong(params["bytes"])!!
        val name = DeviceCaptureSupport.safeFileName(params["name"] as String)
        val contentType = DeviceCaptureSupport.contentType(params["contentType"] as String)
        var target: SaveTarget? = null
        ctx.withPrompt(capability) { ticket ->
            if (!platform.canPresent()) return@withPrompt DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
            ctx.progress(ProgressState.PENDING_CONSENT)
            ctx.hostConsent(capability, label(name, declared))?.let { return@withPrompt it }
            ctx.presenting = true
            try {
                target = platform.createDocument(name, contentType) { ticket.close() }
            } catch (e: DeviceDriverException) {
                return@withPrompt DriverOutcome.Error(e.code, e.detail)
            } finally {
                ctx.presenting = false
            }
            if (target == null) {
                ctx.recordDismissal(capability)
                return@withPrompt DriverOutcome.Error(DeviceErrorCode.CANCELLED, "picker-dismissed")
            }
            null
        }?.let { return it }
        val sink = target!!
        var committed = false
        try {
            ctx.progress(ProgressState.RUNNING)
            var granted = ctx.grantDownload(minOf(window, ctx.revision.maxOutstandingCredit, declared))
            var written = 0L
            for (chunk in ctx.downloadChunks) {
                sink.write(chunk)
                written += chunk.size
                // Replenish what was written, never past the declaration.
                val amount = minOf(chunk.size.toLong(), declared - granted)
                if (amount > 0) granted += ctx.grantDownload(amount)
            }
            // The runtime closes the chunks only after every declared byte arrived and the SHA-256 matched.
            if (written != declared) return DriverOutcome.Error(DeviceErrorCode.INTERNAL, "download-incomplete")
            sink.commit()
            committed = true
            return DriverOutcome.Result(mapOf("bytesWritten" to written))
        } catch (e: IOException) {
            return DriverOutcome.Error(DeviceErrorCode.INTERNAL, "write-failed")
        } finally {
            if (!committed) withContext(NonCancellable) { runCatching { sink.discard() } }
        }
    }

    companion object {
        /** The largest download window a host grants at once (RFC 001 §2.4). */
        const val MAX_WINDOW: Long = 256 * 1024

        /** Host-defined consent label (never server text beyond a sanitized extension). */
        fun label(name: String, bytes: Long): String {
            val ext = DeviceCaptureSupport.fileExtension(name)
            val kind = if (ext.isEmpty()) "a file" else "a .$ext file"
            return "save $kind (${DeviceCaptureSupport.formatBytes(bytes)}) to your device"
        }
    }
}

// ---------------------------------------------------------------------------
// camera.capture v1
// ---------------------------------------------------------------------------

data class CameraCaptureRequest(
    val video: Boolean,
    /** `front` / `back`, a hint (the capture app may ignore it). */
    val facing: String?,
    /** Video only: recording limit. */
    val maxDurationMs: Long?,
) {
    companion object {
        fun parse(params: Map<String, Any?>): CameraCaptureRequest =
            CameraCaptureRequest(params["mode"] == "video", params["facing"] as String?, DeviceWire.exactLong(params["maxDurationMs"]))
    }
}

/** A finished capture in a temporary file; [release] deletes it. */
class CapturedMedia(
    val contentType: String,
    val size: Long,
    val open: () -> InputStream,
    val release: () -> Unit = {},
)

interface CameraPlatform {
    /** The device has a camera at all (otherwise the capability is not advertised). */
    fun hasCamera(): Boolean

    fun canPresent(): Boolean

    /**
     * Present the system capture UI (`TakePicture` / `CaptureVideo` into a
     * FileProvider temp file, facing hint, `EXTRA_DURATION_LIMIT`). Null =
     * dismissed (the temp file is deleted). The media type is sniffed from
     * the bytes, never trusted from a suffix.
     */
    suspend fun capture(request: CameraCaptureRequest, maxItemBytes: Long, presenterGone: () -> Unit = {}): CapturedMedia?
}

/**
 * `camera.capture@1` (C2): the system capture UI is the per-use consent gate
 * (reported as `pendingConsent` while open). Needs the `camera` permission,
 * plus `microphone` for video, whenever the app declares them (an app that
 * declares CAMERA must hold it for the capture intent; an undeclared one is
 * the capture app's own business): a missing one is requested through the OS
 * flow first under the host-wide prompt gate, and a refusal is `denied`
 * (detail: the permission name). Dismissal is `cancelled`. Exactly one item
 * on channel 0 whose sniffed media type fits the mode.
 */
class CameraCaptureDriver(private val camera: CameraPlatform, private val permissions: PermissionPlatform) : DeviceDriver {
    override val capability: String = "camera.capture"
    override val binary: Boolean = true

    /**
     * A camera is enough ([CapabilityAdvertisement]): the system capture UI
     * records under the capture app's own CAMERA / RECORD_AUDIO, so the OS
     * requires no declaration from this app for photo or video, and nothing
     * records under the host indicator. A declared CAMERA / RECORD_AUDIO is
     * requested at run time instead ([neededGroups]).
     */
    override fun isAvailable(): Boolean = camera.hasCamera()

    override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

    /** The permission groups this request needs and the app declares. */
    internal fun neededGroups(video: Boolean): List<PermissionGroup> =
        (if (video) listOf("camera", "microphone") else listOf("camera")).mapNotNull { name ->
            PermissionNames.resolve(name, permissions.sdkInt)?.let { PermissionLogic.effective(it, permissions) }
        }

    override suspend fun run(ctx: DriverContext): DriverOutcome {
        val request = CameraCaptureRequest.parse(ctx.request.params)
        if (!camera.hasCamera()) return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-camera")
        val groups = neededGroups(request.video)
        val keys = arrayOf(capability) + groups.map { "permission:${it.name}" }
        var media: CapturedMedia? = null
        ctx.withPrompt(*keys) { ticket ->
            if (!camera.canPresent()) return@withPrompt DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
            for (g in groups) {
                if (PermissionLogic.isGranted(g, permissions)) continue
                PermissionLogic.present(ctx, permissions, g, "permission:${g.name}", g.name) { ticket.close() }?.let { e ->
                    // A denial names the permission (a permanent one stays `permanently-denied`).
                    return@withPrompt e
                }
            }
            ctx.progress(ProgressState.PENDING_CONSENT)
            ctx.presenting = true
            try {
                media = camera.capture(request, ctx.revision.maxItemBytes) { ticket.close() }
            } catch (e: DeviceDriverException) {
                return@withPrompt DriverOutcome.Error(e.code, e.detail)
            } catch (_: SecurityException) {
                return@withPrompt DriverOutcome.Error(DeviceErrorCode.DENIED, "camera")
            } finally {
                ctx.presenting = false
            }
            null
        }?.let { return it }
        val m = media ?: run {
            ctx.recordDismissal(capability)
            return DriverOutcome.Error(DeviceErrorCode.CANCELLED, "capture-dismissed")
        }
        fun fail(code: DeviceErrorCode, detail: String): DriverOutcome {
            runCatching { m.release() }
            return DriverOutcome.Error(code, detail)
        }
        if (DevicePayloads.blobStartViolation(capability, ctx.request.version, ctx.request.params, m.contentType) != null) {
            return fail(DeviceErrorCode.INTERNAL, "unexpected-media-type")
        }
        if (m.size <= 0) return fail(DeviceErrorCode.UNAVAILABLE, "capture-empty")
        if (m.size > ctx.revision.maxItemBytes) return fail(DeviceErrorCode.UNAVAILABLE, "item-exceeds-limit")
        ctx.progress(ProgressState.RUNNING)
        return DriverOutcome.Result(blobs = listOf(DriverBlob(0, m.contentType, m.size, m.open, m.release)))
    }
}

// ---------------------------------------------------------------------------
// mic.record v1
// ---------------------------------------------------------------------------

/** Receives captured audio from a platform source; may be called on any thread. */
interface AudioSink {
    /** Little-endian PCM16 in the requested format, a whole number of frames. */
    fun onPcm(bytes: ByteArray, length: Int = bytes.size)

    /** Capture failed; a fixed diagnostic token. */
    fun onError(detail: String)
}

fun interface CaptureHandle {
    /** Stop capturing and release the hardware. Idempotent; no callback afterwards. */
    fun stop()
}

interface AudioCapturePlatform {
    /** The device has a microphone (otherwise the capability is not advertised). */
    fun hasMicrophone(): Boolean

    /**
     * Start capturing in [format] (Android: `AudioRecord`,
     * `ENCODING_PCM_16BIT`, resampled/remixed when the device cannot capture
     * that format natively). Throws [DeviceDriverException] when it cannot
     * start.
     */
    fun start(format: AudioCaptureFormat, sink: AudioSink): CaptureHandle
}

/**
 * `mic.record@1` (C3; stream, binary upload, undeclared size): the host
 * consent dialog naming the origin (per use), the OS microphone permission
 * when missing, then the always-visible host recording indicator with Stop
 * for the whole recording (RFC 001 §5). Advertised only with a microphone,
 * a declared `RECORD_AUDIO` and a ready indicator ([CapabilityAdvertisement]);
 * otherwise not offered (and `unavailable` if the indicator went away). One `audio/L16` item without a declared size; frames of
 * little-endian PCM16 (interleaved when stereo) are sent as captured, paced
 * by credit. Overflow `pause` is bounded: while credit is exhausted captured
 * bytes wait up to [bufferLimit], past which the recording ends `throttled`
 * (`capture-buffer-full`). Stop, the indicator becoming invisible, reaching
 * `maxDurationMs` (or the item cap) and host suspension (backgrounding) end
 * the recording normally: the microphone and indicator stop at once, and a
 * success `{durationMs, item}` follows once what was captured has uploaded
 * (however long the server takes to grant credit for it). Owner
 * cancellation, deadline, lease loss and detach discard it.
 */
class MicRecordDriver(
    private val audio: AudioCapturePlatform,
    private val permissions: PermissionPlatform,
    private val indicator: DeviceActivityIndicator,
    bufferLimit: Int = DEFAULT_BUFFER_LIMIT,
) : DeviceDriver {
    override val capability: String = "mic.record"
    override val binary: Boolean = true

    /** Captured bytes allowed to wait for credit before `throttled`. */
    val bufferLimit: Int = maxOf(DeviceProtocol.MAX_BULK_CHUNK_BYTES, bufferLimit)

    /** A microphone, a declared `RECORD_AUDIO` and a ready indicator (never whether it is granted). */
    override fun isAvailable(): Boolean =
        CapabilityAdvertisement.offer(audio.hasMicrophone(), CapabilityAdvertisement.declares("microphone", permissions), indicator.isReady)

    override fun awaitsIndicator(): Boolean =
        !indicator.isReady && CapabilityAdvertisement.offer(audio.hasMicrophone(), CapabilityAdvertisement.declares("microphone", permissions))

    /** Never while backgrounded: its indicator must be visible (RFC 001 §5). */
    override val requiresForeground: Boolean get() = true

    override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

    override suspend fun run(ctx: DriverContext): DriverOutcome {
        val params = ctx.request.params
        val format = AudioCaptureFormat(
            sampleRate = DeviceWire.exactLong(params["sampleRate"])!!.toInt(),
            channels = (DeviceWire.exactLong(params["channels"]) ?: 1L).toInt(),
        )
        // A recording never outgrows the revision's item limit: it ends normally there (whole frames).
        val itemCap = ctx.revision.maxItemBytes - ctx.revision.maxItemBytes % format.frameBytes
        val maxBytes = minOf(DeviceWire.exactLong(params["maxDurationMs"])?.let { Pcm16.framesFor(it, format.sampleRate) * format.frameBytes } ?: itemCap, itemCap)
        val group = PermissionLogic.effective(PermissionNames.resolve("microphone", permissions.sdkInt)!!, permissions)
            ?: return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "not-declared:microphone")
        if (!indicator.isReady) return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-activity-indicator")
        ctx.withPrompt(capability, "permission:microphone") { ticket ->
            ctx.progress(ProgressState.PENDING_CONSENT)
            ctx.hostConsent(capability, consentLabel(format))?.let { return@withPrompt it }
            if (!PermissionLogic.isGranted(group, permissions)) {
                if (!permissions.canPresent()) return@withPrompt DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
                PermissionLogic.present(ctx, permissions, group, "permission:microphone", "microphone") { ticket.close() }?.let { return@withPrompt it }
            }
            null
        }?.let { return it }

        // Consent and permission are done: the indicator is not a prompt.
        val buffer = LiveCaptureBuffer(bufferLimit, maxBytes)
        val stopped = AtomicBoolean(false)
        var handle: CaptureHandle? = null
        var shown: IndicatorHandle? = null
        fun stopHardware() {
            if (!stopped.compareAndSet(false, true)) return
            runCatching { handle?.stop() }
            runCatching { shown?.hide() }
        }

        // Stop is success: end the item with what was captured (§2.4).
        fun finish() {
            buffer.finish()
            stopHardware()
        }
        shown = indicator.show(ctx.origin, ACTIVITY) { finish() }
            ?: return DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-activity-indicator")
        ctx.onEnd { stopHardware() }
        ctx.onHostSuspend { finish() }
        handle = try {
            audio.start(
                format,
                object : AudioSink {
                    override fun onPcm(bytes: ByteArray, length: Int) {
                        if (stopped.get()) return
                        if (!buffer.write(bytes, length)) {
                            // Starved of credit past the bounded window (§2.4).
                            ctx.abort(DeviceErrorCode.THROTTLED, LiveCaptureBuffer.CAPTURE_BUFFER_FULL)
                        } else if (buffer.reachedLimit) {
                            // maxDurationMs / the item cap is a recording limit: the
                            // microphone (and its indicator) stop now, not when the
                            // upload drains — a server withholding credit must not
                            // keep the mic open. What was captured still uploads.
                            stopHardware()
                        }
                    }

                    override fun onError(detail: String) {
                        buffer.fail(DeviceDriverException(DeviceErrorCode.UNAVAILABLE, detail))
                        ctx.abort(DeviceErrorCode.UNAVAILABLE, detail)
                    }
                },
            )
        } catch (e: DeviceDriverException) {
            stopHardware()
            return DriverOutcome.Error(e.code, e.detail)
        } catch (_: SecurityException) {
            stopHardware()
            return DriverOutcome.Error(DeviceErrorCode.DENIED, "microphone")
        }
        if (stopped.get()) handle?.stop() // stopped while starting
        ctx.progress(ProgressState.RUNNING)
        return DriverOutcome.Result(
            blobs = listOf(DriverBlob.live(0, CONTENT_TYPE, buffer) { stopHardware() }),
            itemField = "item",
            resultAfterUpload = { mapOf("durationMs" to Pcm16.durationMs(buffer.capturedBytes / format.frameBytes, format.sampleRate)) },
        )
    }

    companion object {
        const val CONTENT_TYPE: String = "audio/L16"
        const val DEFAULT_BUFFER_LIMIT: Int = 1024 * 1024

        /** Host-defined indicator label (never server text). */
        const val ACTIVITY: String = "Recording audio from your microphone"

        fun consentLabel(format: AudioCaptureFormat): String =
            "record audio from your microphone (${if (format.channels == 2) "stereo" else "mono"}, ${format.sampleRate} Hz)"
    }
}

// ---------------------------------------------------------------------------
// bluetooth.select v1
// ---------------------------------------------------------------------------

/** One device the chooser lists. */
data class BluetoothChooserEntry(val id: String, val name: String?, val rssi: Int)

sealed class BluetoothChoice {
    data class Selected(val id: String) : BluetoothChoice()

    /** Cancel, back or the Activity going away: `cancelled`. */
    data object Dismissed : BluetoothChoice()

    /** No foreground UI can show it. */
    data object Unavailable : BluetoothChoice()
}

/**
 * The host-owned chooser (outside the patch tree) naming the origin, listing
 * [devices] live as the scan finds them, with Cancel. It is the per-use gate
 * for `bluetooth.select` and, while open, the visible UI of its scan.
 * Coroutine cancellation must dismiss it.
 */
fun interface BluetoothChooser {
    suspend fun choose(origin: String, devices: StateFlow<List<BluetoothChooserEntry>>): BluetoothChoice
}

/** What a BLE scan needs on this device (shared by `bluetooth.scan` and `bluetooth.select`). */
internal class BleRequirements(private val bluetooth: BluetoothPlatform, private val permissions: DeclaredPermissions) {
    fun requiredGroup(): PermissionGroup {
        val sdk = permissions.sdkInt
        val base = PermissionNames.resolve("bluetooth", sdk)!!
        if (sdk >= 31 && !bluetooth.scanDisavowsLocation()) {
            return base.copy(permissions = base.permissions + "android.permission.ACCESS_FINE_LOCATION", anyGrants = false)
        }
        return base
    }

    fun needsLocationServices(): Boolean = permissions.sdkInt <= 30 || !bluetooth.scanDisavowsLocation()

    /**
     * The manifest declares everything a scan needs on this API level:
     * `BLUETOOTH_SCAN` on 31+ (plus `ACCESS_FINE_LOCATION` without
     * `neverForLocation`), fine location on 29..30, fine or coarse location
     * before. Declarations only — grants never affect the advertisement.
     */
    fun declared(): Boolean = PermissionLogic.effective(requiredGroup(), permissions) != null

    /** Adapter / manifest / Location Services preconditions: the effective group, or the refusal. */
    fun check(): Pair<PermissionGroup?, DriverOutcome.Error?> {
        when (bluetooth.adapterState()) {
            AdapterState.NO_ADAPTER -> return null to DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-adapter")
            AdapterState.OFF -> return null to DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "adapter-off")
            AdapterState.ON -> Unit
        }
        val effective = PermissionLogic.effective(requiredGroup(), permissions)
            ?: return null to DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "not-declared:bluetooth")
        if (needsLocationServices() && !bluetooth.locationServicesEnabled()) {
            return null to DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "location-services-off")
        }
        return effective to null
    }
}

/**
 * `bluetooth.select@1` (C4; unary, no data plane): a host-owned chooser
 * lists a live BLE scan filtered by `services` (a device must advertise
 * every listed service, like a Web Bluetooth filter) and `namePrefix`
 * (exact code points; unnamed devices never match a prefix). The chooser is
 * the per-use gate (it holds the host-wide prompt gate while open) and the
 * visible UI with Cancel while the scan runs; the scan stops when it closes.
 * Same BLE preconditions as `bluetooth.scan`; a missing OS permission is
 * requested first. The result is identity only: `{device: {id, name?}}`.
 */
class BluetoothSelectDriver(
    private val bluetooth: BluetoothPlatform,
    private val permissions: PermissionPlatform,
    private val chooser: BluetoothChooser,
) : DeviceDriver {
    override val capability: String = "bluetooth.select"

    /** BLE hardware and the manifest entries a scan needs (the chooser is its visible UI, so no indicator). */
    override fun isAvailable(): Boolean = CapabilityAdvertisement.offer(bluetooth.hasBle(), BleRequirements(bluetooth, permissions).declared())

    /** The chooser must be visible: never while backgrounded. */
    override val requiresForeground: Boolean get() = true

    override fun validateParams(version: Long, params: Map<String, Any?>): String? = null

    private sealed class Signal {
        class Device(val id: String, val name: String?, val rssi: Int, val services: List<String>) : Signal()

        class Failed(val code: Int) : Signal()

        data object AdapterOff : Signal()
    }

    override suspend fun run(ctx: DriverContext): DriverOutcome {
        @Suppress("UNCHECKED_CAST")
        val services = (ctx.request.params["services"] as List<String>?).orEmpty()
        val prefix = ctx.request.params["namePrefix"] as String?
        val ble = BleRequirements(bluetooth, permissions)
        val (effective, refused) = ble.check()
        refused?.let { return it }
        var outcome: DriverOutcome? = null
        ctx.withPrompt(capability, "permission:bluetooth") { ticket ->
            if (!permissions.canPresent()) return@withPrompt DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
            if (!PermissionLogic.isGranted(effective!!, permissions)) {
                PermissionLogic.present(ctx, permissions, effective, "permission:bluetooth", "bluetooth") { ticket.close() }?.let { return@withPrompt it }
            }
            if (bluetooth.adapterState() != AdapterState.ON) return@withPrompt DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "adapter-off")
            ctx.progress(ProgressState.PENDING_CONSENT)
            outcome = choose(ctx, services, prefix)
            null
        }?.let { return it }
        return outcome!!
    }

    private suspend fun choose(ctx: DriverContext, services: List<String>, prefix: String?): DriverOutcome {
        val signals = Channel<Signal>(capacity = 256, onBufferOverflow = BufferOverflow.DROP_OLDEST)
        val handle = try {
            bluetooth.startScan(object : BluetoothScanListener {
                override fun onDevice(id: String, name: String?, rssi: Int) {
                    signals.trySend(Signal.Device(id, name, rssi, emptyList()))
                }

                override fun onAdvertisement(id: String, name: String?, rssi: Int, serviceUuids: List<String>) {
                    signals.trySend(Signal.Device(id, name, rssi, serviceUuids))
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
            return DriverOutcome.Error(DeviceErrorCode.DENIED, "bluetooth")
        }
        val listed = LinkedHashMap<String, BluetoothChooserEntry>()
        val devices = MutableStateFlow<List<BluetoothChooserEntry>>(emptyList())
        val failure = CompletableDeferred<DriverOutcome.Error>()
        try {
            val choice = coroutineScope {
                val chosen = async { chooser.choose(ctx.origin, devices) }
                val pump = launch {
                    for (s in signals) {
                        when (s) {
                            is Signal.Device -> {
                                val entry = accept(s, services, prefix) ?: continue
                                if (entry.id !in listed && listed.size >= MAX_LISTED) continue
                                listed[entry.id] = entry
                                devices.value = listed.values.sortedWith(compareByDescending<BluetoothChooserEntry> { it.rssi }.thenBy { it.id })
                            }
                            is Signal.Failed -> failure.complete(DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "scan-failed:${s.code}"))
                            Signal.AdapterOff -> failure.complete(DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "adapter-off"))
                        }
                        if (failure.isCompleted) {
                            chosen.cancel()
                            break
                        }
                    }
                }
                val result = try {
                    chosen.await()
                } catch (e: CancellationException) {
                    if (!failure.isCompleted) throw e
                    null
                }
                pump.cancel()
                result
            }
            return when (choice) {
                null -> failure.await()
                is BluetoothChoice.Selected -> {
                    val entry = listed[choice.id] ?: return DriverOutcome.Error(DeviceErrorCode.INTERNAL, "unknown-device")
                    val device = linkedMapOf<String, Any?>("id" to entry.id)
                    entry.name?.let { device["name"] = it }
                    DriverOutcome.Result(mapOf("device" to device))
                }
                BluetoothChoice.Dismissed -> {
                    ctx.recordDismissal(capability)
                    DriverOutcome.Error(DeviceErrorCode.CANCELLED, "chooser-dismissed")
                }
                BluetoothChoice.Unavailable -> DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "presentation-failed")
            }
        } finally {
            // Stops on selection, Cancel, deadline, server cancel, lease expiry and detach.
            runCatching { handle.stop() }
        }
    }

    /** The chooser entry for an advertisement, or null when it does not pass the filters. */
    internal fun accept(id: String, name: String?, rssi: Int, advertised: List<String>, services: List<String>, prefix: String?): BluetoothChooserEntry? {
        val cid = id.truncateCodePoints(128)
        if (cid.isEmpty()) return null
        val cname = name?.truncateCodePoints(256)
        if (prefix != null && (cname == null || !DeviceCaptureSupport.hasPrefix(cname, prefix))) return null
        if (services.isNotEmpty()) {
            val have = advertised.map { it.lowercase(java.util.Locale.ROOT) }.toSet()
            if (!services.all { it in have }) return null
        }
        return BluetoothChooserEntry(cid, cname, rssi.coerceIn(-32768, 32767))
    }

    private fun accept(s: Signal.Device, services: List<String>, prefix: String?) = accept(s.id, s.name, s.rssi, s.services, services, prefix)

    companion object {
        /** Most devices listed at once. */
        const val MAX_LISTED: Int = 64
    }
}
