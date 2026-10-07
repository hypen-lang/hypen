package space.hypen.renderer.device.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.AssetFileDescriptor
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import space.hypen.renderer.R
import space.hypen.renderer.device.AudioCaptureFormat
import space.hypen.renderer.device.AudioCapturePlatform
import space.hypen.renderer.device.AudioSink
import space.hypen.renderer.device.CameraCaptureRequest
import space.hypen.renderer.device.CameraIntentHints
import space.hypen.renderer.device.CameraPlatform
import space.hypen.renderer.device.CaptureHandle
import space.hypen.renderer.device.CapturedMedia
import space.hypen.renderer.device.DeviceDriverException
import space.hypen.renderer.device.DeviceErrorCode
import space.hypen.renderer.device.FilePickPlatform
import space.hypen.renderer.device.FileSavePlatform
import space.hypen.renderer.device.MediaSniffer
import space.hypen.renderer.device.Pcm16
import space.hypen.renderer.device.Pcm16Resampler
import space.hypen.renderer.device.PickedDocument
import space.hypen.renderer.device.SaveTarget
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The renderer's own FileProvider (declared in the library manifest with
 * authority `${applicationId}.hypen.device.files`): it shares only the
 * capture temp directory (`cache/hypen-device-capture/`) with the system
 * camera app, write access granted per capture intent. A subclass, so it
 * never collides with an app's own `androidx.core.content.FileProvider`.
 *
 * Its paths reach androidx in two ways, and both are needed: the constructor
 * argument serves the provider instance (the camera app opening the URI),
 * while [uriForCapture] — the static `FileProvider.getUriForFile` — reads
 * only the manifest's `android.support.FILE_PROVIDER_PATHS` `<meta-data>`
 * (androidx.core ≥ 1.10 parses paths lazily per instance and never seeds the
 * static lookup). Without that meta-data every capture failed before the
 * camera app was launched.
 */
class HypenDeviceFileProvider : FileProvider(R.xml.hypen_device_file_paths) {
    companion object {
        const val CAPTURE_DIR = "hypen-device-capture"

        /** `platformDetail` of a capture whose file cannot be shared (the provider's paths are missing from the merged manifest). */
        const val MISCONFIGURED = "capture-file-provider-misconfigured"

        fun authority(context: Context): String = "${context.packageName}.hypen.device.files"

        /**
         * The `content://` URI the capture app writes [file] through. A
         * provider that cannot share it (paths meta-data missing from the
         * merged manifest, or a file outside [CAPTURE_DIR]) fails with an
         * `internal` [MISCONFIGURED] error naming the cause instead of an
         * anonymous driver failure.
         */
        fun uriForCapture(context: Context, file: File): Uri = try {
            getUriForFile(context, authority(context), file)
        } catch (e: IllegalArgumentException) {
            throw DeviceDriverException(DeviceErrorCode.INTERNAL, MISCONFIGURED).apply { initCause(e) }
        }

        /**
         * Delete capture temp files an earlier process left behind (e.g.
         * process death mid-capture): anything older than [olderThanMs]
         * (longer than any capture may last), so a capture running right now
         * is never touched. Blocking I/O.
         */
        fun sweep(cacheDir: File, olderThanMs: Long = 60 * 60 * 1000, nowMs: Long = System.currentTimeMillis()) {
            File(cacheDir, CAPTURE_DIR).listFiles()?.forEach { f ->
                if (nowMs - f.lastModified() > olderThanMs) runCatching { f.delete() }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// file.pick — ACTION_OPEN_DOCUMENT
// ---------------------------------------------------------------------------

/**
 * `file.pick` via the Storage Access Framework (`ACTION_OPEN_DOCUMENT`,
 * `EXTRA_MIME_TYPES`, `EXTRA_ALLOW_MULTIPLE` when more than one item may be
 * picked). Needs no permission: the picker grants read access to what the
 * user chose. Names come from `OpenableColumns.DISPLAY_NAME`; sizes from the
 * file descriptor (streamed without a declaration when unknown, D5).
 */
internal class AndroidFilePickPlatform(
    private val context: Context,
    private val tracker: ForegroundActivityTracker,
    private val io: CoroutineDispatcher,
) : FilePickPlatform {
    override fun canPresent(): Boolean = tracker.foreground() != null

    override fun mimeForExtension(ext: String): String? = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)

    override suspend fun pick(mimeTypes: List<String>, multiple: Boolean, maxItemBytes: Long, presenterGone: () -> Unit): List<PickedDocument> {
        val activity = tracker.foreground() ?: throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
        val input = mimeTypes.toTypedArray()
        val uris: List<Uri> = if (multiple) {
            launchForResult(tracker, activity, ActivityResultContracts.OpenMultipleDocuments(), input, presenterGone)
        } else {
            listOfNotNull(launchForResult(tracker, activity, ActivityResultContracts.OpenDocument(), input, presenterGone))
        }
        return withContext(io) {
            uris.map { uri ->
                ensureActive()
                resolve(uri, maxItemBytes)
            }
        }
    }

    private fun resolve(uri: Uri, maxItemBytes: Long): PickedDocument {
        val resolver = context.contentResolver
        val name = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
            }
        }.getOrNull()?.takeIf { it.isNotBlank() } ?: "file"
        val contentType = resolver.getType(uri) ?: "application/octet-stream"
        val size = runCatching {
            resolver.openAssetFileDescriptor(uri, "r")?.use { it.length.takeIf { n -> n != AssetFileDescriptor.UNKNOWN_LENGTH } }
        }.getOrNull()?.takeIf { it >= 0 }
        if (size != null && size > maxItemBytes) throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "item-exceeds-limit")
        val open: () -> InputStream = { resolver.openInputStream(uri) ?: throw IOException("provider returned no stream") }
        return PickedDocument(name, contentType, size, open)
    }
}

// ---------------------------------------------------------------------------
// file.save — ACTION_CREATE_DOCUMENT
// ---------------------------------------------------------------------------

/**
 * `file.save` via `ACTION_CREATE_DOCUMENT` (suggested name and MIME type):
 * bytes are written straight to the chosen document as they arrive (no temp
 * copy, never the whole file in memory). SAF has no atomic commit: the
 * document exists from the moment it is chosen, so a cancelled or failed
 * download deletes it (`DocumentsContract.deleteDocument`); a provider that
 * refuses deletion is truncated to empty instead.
 */
internal class AndroidFileSavePlatform(
    private val context: Context,
    private val tracker: ForegroundActivityTracker,
    private val io: CoroutineDispatcher,
) : FileSavePlatform {
    override fun canPresent(): Boolean = tracker.foreground() != null

    override suspend fun createDocument(name: String, contentType: String, presenterGone: () -> Unit): SaveTarget? {
        val activity = tracker.foreground() ?: throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
        val uri = launchForResult(tracker, activity, ActivityResultContracts.CreateDocument(contentType), name, presenterGone) ?: return null
        return UriSaveTarget(context, uri, io)
    }
}

internal class UriSaveTarget(private val context: Context, private val uri: Uri, private val io: CoroutineDispatcher) : SaveTarget {
    private var pfd: ParcelFileDescriptor? = null
    private var out: FileOutputStream? = null
    private var done = false

    private fun output(): FileOutputStream {
        out?.let { return it }
        val fd = context.contentResolver.openFileDescriptor(uri, "wt") ?: throw IOException("provider returned no descriptor")
        pfd = fd
        return FileOutputStream(fd.fileDescriptor).also { out = it }
    }

    override suspend fun write(bytes: ByteArray) = withContext(io) { output().write(bytes) }

    override suspend fun commit() = withContext(io) {
        val o = output()
        o.flush()
        runCatching { o.fd.sync() } // some providers' descriptors (pipes) cannot sync
        o.close()
        pfd?.close()
        done = true
    }

    override suspend fun discard() = withContext(NonCancellable + io) {
        if (done) return@withContext
        done = true
        runCatching { out?.close() }
        runCatching { pfd?.close() }
        val deleted = runCatching { DocumentsContract.deleteDocument(context.contentResolver, uri) }.getOrDefault(false)
        if (!deleted) runCatching { context.contentResolver.openFileDescriptor(uri, "wt")?.close() }
        Unit
    }
}

// ---------------------------------------------------------------------------
// camera.capture — TakePicture / CaptureVideo into a FileProvider temp file
// ---------------------------------------------------------------------------

/** `TakePicture` plus the facing hint. */
internal class TakePictureWithHints(private val request: CameraCaptureRequest) : ActivityResultContracts.TakePicture() {
    override fun createIntent(context: Context, input: Uri): Intent = super.createIntent(context, input).applyHints(request, input)
}

/** `CaptureVideo` plus the facing hint and `EXTRA_DURATION_LIMIT`. */
internal class CaptureVideoWithHints(private val request: CameraCaptureRequest) : ActivityResultContracts.CaptureVideo() {
    override fun createIntent(context: Context, input: Uri): Intent {
        val intent = super.createIntent(context, input).applyHints(request, input)
        request.maxDurationMs?.let { intent.putExtra(MediaStore.EXTRA_DURATION_LIMIT, CameraIntentHints.durationLimitSeconds(it)) }
        return intent
    }
}

private fun Intent.applyHints(request: CameraCaptureRequest, output: Uri): Intent {
    for ((k, v) in CameraIntentHints.facingExtras(request.facing)) {
        when (v) {
            is Int -> putExtra(k, v)
            is Boolean -> putExtra(k, v)
        }
    }
    // The capture app writes only this one temp file.
    clipData = android.content.ClipData.newRawUri("", output)
    addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return this
}

/**
 * `camera.capture` via the system capture UI (`ActivityResultContracts.
 * TakePicture` / `CaptureVideo`) writing into a private FileProvider temp
 * file. The media type is sniffed from the bytes; the temp file is deleted
 * on dismissal, failure, cancellation and after the upload.
 */
internal class AndroidCameraPlatform(
    private val context: Context,
    private val tracker: ForegroundActivityTracker,
    private val io: CoroutineDispatcher,
) : CameraPlatform {
    override fun hasCamera(): Boolean = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

    override fun canPresent(): Boolean = tracker.foreground() != null

    override suspend fun capture(request: CameraCaptureRequest, maxItemBytes: Long, presenterGone: () -> Unit): CapturedMedia? {
        val activity = tracker.foreground() ?: throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "no-foreground-activity")
        val file = withContext(io) {
            val dir = File(context.cacheDir, HypenDeviceFileProvider.CAPTURE_DIR).apply { mkdirs() }
            File.createTempFile("capture-", if (request.video) ".mp4" else ".jpg", dir)
        }
        var keep = false
        try {
            val uri = HypenDeviceFileProvider.uriForCapture(context, file)
            val ok = if (request.video) {
                launchForResult(tracker, activity, CaptureVideoWithHints(request), uri, presenterGone)
            } else {
                launchForResult(tracker, activity, TakePictureWithHints(request), uri, presenterGone)
            }
            if (!ok) return null
            val media = withContext(io) {
                val size = file.length()
                if (size <= 0) throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "capture-empty")
                if (size > maxItemBytes) throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "item-exceeds-limit")
                val head = ByteArray(16)
                val n = FileInputStream(file).use { input -> input.read(head) }
                val type = MediaSniffer.cameraType(head.copyOf(maxOf(0, n)), request.video)
                    ?: throw DeviceDriverException(DeviceErrorCode.INTERNAL, "unexpected-media-type")
                CapturedMedia(type, size, { FileInputStream(file) }, { file.delete() })
            }
            keep = true
            return media
        } finally {
            if (!keep) withContext(NonCancellable + io) { runCatching { file.delete() } }
        }
    }
}

// ---------------------------------------------------------------------------
// mic.record — AudioRecord PCM16
// ---------------------------------------------------------------------------

/**
 * `mic.record` via [AudioRecord] (`MediaRecorder.AudioSource.MIC`,
 * `ENCODING_PCM_16BIT`) on a dedicated thread, 20 ms reads. The requested
 * format is used natively when the device supports it; otherwise the source
 * captures at 48/44.1 kHz and/or mono and is remixed and resampled
 * ([Pcm16Resampler]). Output is little-endian PCM16, interleaved when
 * stereo. `RECORD_AUDIO` is checked by [space.hypen.renderer.device.MicRecordDriver]
 * before [start].
 */
internal class AndroidAudioCapturePlatform(private val context: Context) : AudioCapturePlatform {
    override fun hasMicrophone(): Boolean = context.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)

    private fun mask(channels: Int) = if (channels == 2) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO

    @SuppressLint("MissingPermission") // RECORD_AUDIO is checked by MicRecordDriver before starting
    private fun open(rate: Int, channels: Int): AudioRecord? {
        val min = AudioRecord.getMinBufferSize(rate, mask(channels), AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return null
        val size = maxOf(min * 2, rate * channels * 2 / 5) // ≥ 200 ms
        val record = try {
            AudioRecord(MediaRecorder.AudioSource.MIC, rate, mask(channels), AudioFormat.ENCODING_PCM_16BIT, size)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return null
        }
        return record
    }

    override fun start(format: AudioCaptureFormat, sink: AudioSink): CaptureHandle {
        val candidates = linkedSetOf(
            format.sampleRate to format.channels, 48_000 to format.channels, 44_100 to format.channels,
            format.sampleRate to 1, 48_000 to 1, 44_100 to 1, 16_000 to 1,
        )
        var record: AudioRecord? = null
        var rate = 0
        var channels = 0
        for ((r, c) in candidates) {
            record = open(r, c)
            if (record != null) {
                rate = r
                channels = c
                break
            }
        }
        val rec = record ?: throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "no-audio-format")
        try {
            rec.startRecording()
        } catch (e: IllegalStateException) {
            rec.release()
            throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "record-start-failed")
        }
        if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            rec.release()
            throw DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "record-start-failed")
        }
        val running = AtomicBoolean(true)
        val resampler = Pcm16Resampler(rate, format.sampleRate, format.channels)
        val thread = Thread({
            val buf = ShortArray(maxOf(channels, rate * channels / 50))
            try {
                while (running.get()) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n < 0) {
                        if (running.get()) sink.onError("record-read-failed:$n")
                        break
                    }
                    if (n == 0) continue
                    val remixed = Pcm16.remix(buf, n - n % channels, channels, format.channels)
                    val out = resampler.process(remixed)
                    if (out.isNotEmpty() && running.get()) sink.onPcm(Pcm16.littleEndian(out))
                }
            } finally {
                runCatching { rec.stop() }
                rec.release()
            }
        }, "hypen-mic-record")
        thread.start()
        return CaptureHandle {
            if (running.compareAndSet(true, false)) runCatching { rec.stop() } // unblocks read(); the thread releases it
        }
    }
}
