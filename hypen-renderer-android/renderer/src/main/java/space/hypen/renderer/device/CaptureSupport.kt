/**
 * Pure helpers shared by the round-3 capture drivers (`file.pick`,
 * `file.save`, `camera.capture`, `mic.record`, `bluetooth.select`): file
 * names and labels, `accept` filters, media sniffing, PCM16 conversion and
 * the bounded live-capture buffer. No Android imports: everything here is
 * unit-tested on the JVM.
 */
package space.hypen.renderer.device

import kotlinx.coroutines.channels.Channel
import java.util.ArrayDeque
import java.util.Locale
import kotlin.math.roundToLong

object DeviceCaptureSupport {
    /**
     * A server-supplied file name made safe to hand to a platform save API
     * and to show: path separators, controls, format characters and line/
     * paragraph separators become `_`, the result is trimmed and bounded to
     * 255 code points; an empty, `.` or `..` name becomes `download`.
     * (Mirrors the web and iOS hosts.)
     */
    fun safeFileName(name: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < name.length) {
            val cp = name.codePointAt(i)
            val unsafe = cp == '/'.code || cp == '\\'.code || cp < 0x20 || cp in 0x7F..0x9F || cp == 0x2028 || cp == 0x2029 ||
                Character.getType(cp) == Character.FORMAT.toInt()
            if (unsafe) sb.append('_') else sb.appendCodePoint(cp)
            i += Character.charCount(cp)
        }
        val bounded = sb.toString().trim().truncateCodePoints(255)
        return if (bounded.isEmpty() || bounded == "." || bounded == "..") "download" else bounded
    }

    /** The extension of a (sanitized) name, lowercased, `[a-z0-9]{1,16}`, or `""`. */
    fun fileExtension(name: String): String {
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return ""
        val ext = name.substring(dot + 1).lowercase(Locale.ROOT)
        return if (ext.length <= 16 && ext.all { it in 'a'..'z' || it in '0'..'9' }) ext else ""
    }

    /** `1.5 MB`-style size for host-owned labels. */
    fun formatBytes(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val units = listOf("KB", "MB", "GB")
        var value = bytes / 1024.0
        var unit = 0
        while (value >= 1024 && unit < units.size - 1) {
            value /= 1024
            unit += 1
        }
        return String.format(Locale.ROOT, if (value < 10) "%.1f" else "%.0f", value) + " " + units[unit]
    }

    /** [name] starts with [prefix] by exact code points (never canonical equivalence). */
    fun hasPrefix(name: String, prefix: String): Boolean = name.startsWith(prefix)

    /** A content type bounded for the wire, or `application/octet-stream` when blank. */
    fun contentType(raw: String?): String = raw?.trim()?.takeIf { it.isNotEmpty() }?.truncateCodePoints(256) ?: "application/octet-stream"
}

/**
 * One `file.pick` `accept` entry: a MIME type, a `type/` wildcard (any subtype), or a file
 * extension (`.pdf` or `pdf`).
 */
sealed class DocumentTypeFilter {
    data class MimeType(val type: String) : DocumentTypeFilter()

    /** An `image/` wildcard (any subtype) → `image`. */
    data class MediaWildcard(val type: String) : DocumentTypeFilter()

    /** `.pdf` / `pdf` → `pdf`. */
    data class Extension(val ext: String) : DocumentTypeFilter()

    /** Whether a picked item ([name], [contentType]) fits this filter. */
    fun matches(name: String, contentType: String): Boolean {
        val ct = contentType.substringBefore(';').trim().lowercase(Locale.ROOT)
        return when (this) {
            is MimeType -> ct == type
            is MediaWildcard -> ct.substringBefore('/') == type
            is Extension -> name.lowercase(Locale.ROOT).endsWith(".$ext")
        }
    }

    companion object {
        private fun token(s: String) = s.isNotEmpty() && s.all { it in 'a'..'z' || it in '0'..'9' || it in "!#$&^_.+-" }

        /**
         * Parse `accept`. Entries are trimmed and lowercased; blanks, `*` and
         * the any-type wildcard impose no filter. Null when an entry is none of the three
         * forms (refused `invalidParams` rather than widening the server's
         * filter to every file). Empty = any file.
         */
        fun parse(accept: List<String>): List<DocumentTypeFilter>? {
            val out = LinkedHashSet<DocumentTypeFilter>()
            for (raw in accept) {
                val entry = raw.trim().lowercase(Locale.ROOT)
                if (entry.isEmpty() || entry == "*/*" || entry == "*") continue
                val slash = entry.indexOf('/')
                val filter = if (slash >= 0) {
                    val type = entry.substring(0, slash)
                    val sub = entry.substring(slash + 1)
                    if (!token(type)) return null
                    if (sub == "*") MediaWildcard(type) else if (token(sub)) MimeType(entry) else return null
                } else {
                    val ext = entry.removePrefix(".")
                    if (!token(ext) || ext.split('.').any { it.isEmpty() }) return null
                    Extension(ext)
                }
                out += filter
            }
            return out.toList()
        }

        /**
         * The MIME types to hand to `ACTION_OPEN_DOCUMENT` (`EXTRA_MIME_TYPES`):
         * each filter's type, an extension via [mimeForExtension] (an unknown
         * extension widens that entry to every file; the picked items are
         * still matched against [filters] afterwards). The any-type wildcard
         * alone when there is no filter.
         */
        fun mimeTypes(filters: List<DocumentTypeFilter>, mimeForExtension: (String) -> String?): List<String> {
            if (filters.isEmpty()) return listOf("*/*")
            val out = LinkedHashSet<String>()
            for (f in filters) {
                out += when (f) {
                    is MimeType -> f.type
                    is MediaWildcard -> "${f.type}/*"
                    is Extension -> mimeForExtension(f.ext) ?: "*/*"
                }
            }
            return if ("*/*" in out) listOf("*/*") else out.toList()
        }
    }
}

/** Identifies captured media from its first bytes (never trusts a file suffix). */
object MediaSniffer {
    private val HEIF_BRANDS = setOf("heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1")

    /**
     * The `camera.capture` media type of [head] (the first ≥ 12 bytes) for
     * the requested mode, or null when it is not one this mode allows:
     * photo → JPEG (`FF D8 FF`) or HEIF brands → `image/heic`; video → WebM
     * (EBML `1A 45 DF A3`) or ISO-BMFF (`ftyp`): brand `qt  ` →
     * `video/quicktime`, any other (mp4/3gp family) → `video/mp4`.
     */
    fun cameraType(head: ByteArray, video: Boolean): String? {
        fun u(i: Int) = head[i].toInt() and 0xFF
        val ftyp = head.size >= 12 && String(head, 4, 4, Charsets.ISO_8859_1) == "ftyp"
        val brand = if (ftyp) String(head, 8, 4, Charsets.ISO_8859_1) else ""
        return if (!video) {
            when {
                head.size >= 3 && u(0) == 0xFF && u(1) == 0xD8 && u(2) == 0xFF -> "image/jpeg"
                ftyp && brand in HEIF_BRANDS -> "image/heic"
                else -> null
            }
        } else {
            when {
                head.size >= 4 && u(0) == 0x1A && u(1) == 0x45 && u(2) == 0xDF && u(3) == 0xA3 -> "video/webm"
                ftyp && brand == "qt  " -> "video/quicktime"
                ftyp && brand !in HEIF_BRANDS -> "video/mp4"
                else -> null
            }
        }
    }
}

/** A PCM16 capture format: little-endian samples, interleaved when [channels] is 2. */
data class AudioCaptureFormat(val sampleRate: Int, val channels: Int) {
    /** Bytes per frame (one sample per channel). */
    val frameBytes: Int get() = 2 * channels
}

/** PCM16 conversion helpers used by the Android `AudioRecord` source. */
object Pcm16 {
    /** Whole-millisecond duration of [frames] at [sampleRate] (rounded, like the web and iOS hosts). */
    fun durationMs(frames: Long, sampleRate: Int): Long = if (sampleRate <= 0) 0 else (frames * 1000.0 / sampleRate).roundToLong()

    /** Frames a `maxDurationMs` limit allows at [sampleRate] (rounded up). */
    fun framesFor(durationMs: Long, sampleRate: Int): Long = (durationMs * sampleRate + 999) / 1000

    /** [n] samples as little-endian bytes. */
    fun littleEndian(samples: ShortArray, n: Int = samples.size): ByteArray {
        val out = ByteArray(2 * n)
        for (i in 0 until n) {
            val v = samples[i].toInt()
            out[2 * i] = (v and 0xFF).toByte()
            out[2 * i + 1] = ((v shr 8) and 0xFF).toByte()
        }
        return out
    }

    /** Interleaved [fromChannels] → [toChannels] (1 ↔ 2): mono is duplicated, stereo averaged. */
    fun remix(samples: ShortArray, n: Int, fromChannels: Int, toChannels: Int): ShortArray {
        if (fromChannels == toChannels) return samples.copyOf(n)
        return if (fromChannels == 1) {
            ShortArray(2 * n) { samples[it / 2] }
        } else {
            val frames = n / 2
            ShortArray(frames) { ((samples[2 * it] + samples[2 * it + 1]) / 2).toShort() }
        }
    }
}

/**
 * Streaming linear-interpolation resampler for interleaved PCM16 (no
 * low-pass: meant for the small ratios between a device's native capture
 * rate and the requested one). Stateful across chunks: feeding a signal in
 * any chunking yields the same output.
 */
class Pcm16Resampler(private val inRate: Int, private val outRate: Int, private val channels: Int) {
    private var produced = 0L // output frames emitted so far
    private var consumed = 0L // input frames received so far
    private var last: ShortArray? = null // the previous chunk's last frame

    val isIdentity: Boolean get() = inRate == outRate

    fun process(samples: ShortArray, n: Int = samples.size): ShortArray {
        val frames = n / channels
        if (isIdentity) return samples.copyOf(frames * channels)
        if (frames == 0) return ShortArray(0)
        val base = consumed - (if (last != null) 1 else 0) // input index of the first available frame
        val prev = last
        fun sample(idx: Long, ch: Int): Int {
            val local = idx - consumed
            return if (local < 0) prev!![ch].toInt() else samples[(local * channels + ch).toInt()].toInt()
        }
        val end = consumed + frames - 1 // last available input index
        var out = ShortArray(((frames.toLong() * outRate / inRate + 2) * channels).toInt())
        var size = 0
        while (true) {
            val num = produced * inRate
            val i = num / outRate
            if (i < base) {
                produced += 1
                continue
            }
            if (i + 1 > end) break
            val frac = (num % outRate).toDouble() / outRate
            if (size + channels > out.size) out = out.copyOf(out.size * 2 + channels)
            for (ch in 0 until channels) {
                val a = sample(i, ch)
                val b = sample(i + 1, ch)
                out[size++] = (a + (b - a) * frac).roundToLong().coerceIn(-32768, 32767).toInt().toShort()
            }
            produced += 1
        }
        last = ShortArray(channels) { samples[((frames - 1) * channels + it)] }
        consumed += frames
        return out.copyOf(size)
    }
}

/**
 * A byte source a live-capture [DriverBlob] streams from (RFC 001 §2.4
 * "frames as captured"). [read] suspends until at least one byte, the end
 * (-1) or a failure ([DeviceDriverException]).
 */
interface LiveBlobSource {
    suspend fun read(buffer: ByteArray, offset: Int, length: Int): Int
}

/**
 * The bounded window between a capture thread and the credit-paced upload
 * (RFC 001 §2.4 "Overflow `pause` is bounded"). The capture side [write]s
 * whole frames from any thread; bytes wait here while credit is exhausted.
 * When more than [limit] bytes wait, [write] returns false and the buffer
 * fails with `throttled` (`capture-buffer-full`) — never an unbounded
 * buffer. [maxBytes] (a `maxDurationMs` limit) truncates the capture and
 * ends it. [finish] ends it normally after the waiting bytes drain.
 */
class LiveCaptureBuffer(private val limit: Int, private val maxBytes: Long? = null) : LiveBlobSource {
    private val lock = Any()
    private val chunks = ArrayDeque<ByteArray>()
    private var head = 0
    private var waiting = 0L
    private var finished = false
    private var failure: DeviceDriverException? = null
    private val signal = Channel<Unit>(Channel.CONFLATED)

    /** Every byte accepted from the capture side. */
    @Volatile
    var capturedBytes: Long = 0
        private set

    /** Bytes waiting for credit right now. */
    val pendingBytes: Long get() = synchronized(lock) { waiting }

    val isEnded: Boolean get() = synchronized(lock) { finished || failure != null }

    /**
     * Accept captured bytes. Returns false when the buffer overflowed (it is
     * failed `throttled` now) — the caller stops capturing. After the end,
     * bytes are dropped (true). Reaching [maxBytes] truncates and finishes.
     */
    fun write(bytes: ByteArray, length: Int = bytes.size): Boolean {
        synchronized(lock) {
            if (finished || failure != null) return failure == null
            var n = length.toLong()
            maxBytes?.let { n = minOf(n, it - capturedBytes) }
            if (n > 0) {
                if (waiting + n > limit) {
                    failure = DeviceDriverException(DeviceErrorCode.THROTTLED, CAPTURE_BUFFER_FULL)
                    chunks.clear()
                    head = 0
                    waiting = 0
                    signal.trySend(Unit)
                    return false
                }
                chunks.addLast(bytes.copyOf(n.toInt()))
                waiting += n
                capturedBytes += n
            }
            if (maxBytes != null && capturedBytes >= maxBytes) finished = true
        }
        signal.trySend(Unit)
        return true
    }

    /** The capture reached its limit ([maxBytes]). */
    val reachedLimit: Boolean get() = maxBytes != null && capturedBytes >= maxBytes

    /** End normally: readers drain what waits, then see the end. */
    fun finish() {
        synchronized(lock) { finished = true }
        signal.trySend(Unit)
    }

    /** End with [error] (waiting bytes are discarded). No effect after a failure. */
    fun fail(error: DeviceDriverException) {
        synchronized(lock) {
            if (failure != null) return
            failure = error
            chunks.clear()
            head = 0
            waiting = 0
        }
        signal.trySend(Unit)
    }

    override suspend fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        while (true) {
            synchronized(lock) {
                failure?.let { throw it }
                if (waiting > 0) {
                    var copied = 0
                    while (copied < length && chunks.isNotEmpty()) {
                        val c: ByteArray = chunks.first()
                        val n = minOf(length - copied, c.size - head)
                        System.arraycopy(c, head, buffer, offset + copied, n)
                        copied += n
                        head += n
                        if (head == c.size) {
                            chunks.removeFirst()
                            head = 0
                        }
                    }
                    waiting -= copied
                    return copied
                }
                if (finished) return -1
            }
            signal.receive()
        }
    }

    companion object {
        const val CAPTURE_BUFFER_FULL = "capture-buffer-full"
    }
}

/**
 * Hints for the system capture intents (`camera.capture`). Android has no
 * official "facing" extra: these are the de-facto extras camera apps honour
 * (a hint — an app may ignore it and the user can still switch).
 */
object CameraIntentHints {
    const val EXTRA_CAMERA_FACING = "android.intent.extras.CAMERA_FACING"
    const val EXTRA_LENS_FACING_FRONT = "android.intent.extras.LENS_FACING_FRONT"
    const val EXTRA_LENS_FACING_BACK = "android.intent.extras.LENS_FACING_BACK"
    const val EXTRA_USE_FRONT_CAMERA = "android.intent.extra.USE_FRONT_CAMERA"

    /** Extras for a `front` / `back` hint (legacy `CAMERA_FACING`: front = 1, back = 0). */
    fun facingExtras(facing: String?): Map<String, Any> = when (facing) {
        "front" -> linkedMapOf(EXTRA_CAMERA_FACING to 1, EXTRA_LENS_FACING_FRONT to 1, EXTRA_USE_FRONT_CAMERA to true)
        "back" -> linkedMapOf(EXTRA_CAMERA_FACING to 0, EXTRA_LENS_FACING_BACK to 1, EXTRA_USE_FRONT_CAMERA to false)
        else -> emptyMap()
    }

    /**
     * `MediaStore.EXTRA_DURATION_LIMIT` (whole seconds) for a `maxDurationMs`
     * limit: rounded down so the recording never exceeds the request, but at
     * least 1 s (0 would mean "no limit").
     */
    fun durationLimitSeconds(maxDurationMs: Long): Int = maxOf(1L, maxDurationMs / 1000).toInt()
}
