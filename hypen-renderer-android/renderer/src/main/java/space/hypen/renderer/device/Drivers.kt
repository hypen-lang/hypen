/**
 * Driver contracts for the DeviceHost runtime (RFC 001 §2.6 / §5).
 *
 * A [DeviceDriver] implements one capability. It runs as a coroutine owned by
 * its operation: server cancel, deadline, lease expiry, host suspension and
 * socket loss all cancel that coroutine, and whatever it returns afterwards
 * is discarded (a late OS result never restarts or uploads cancelled work).
 */
package space.hypen.renderer.device

import kotlinx.coroutines.channels.ReceiveChannel
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * One upload item: announced with `blobStart`, streamed in 64 KiB frames
 * under credit, hashed (RFC 001 §2.4).
 */
class DriverBlob(
    val channel: Int,
    val contentType: String,
    /**
     * The exact byte count when the driver knows it (an existing file):
     * announced as `blobStart.bytes` and checked when the item ends. Null
     * when the length is unknown (a live or transcoded source): the item is
     * streamed without a declaration until its stream ends, and the
     * revision's `maxItemBytes` is enforced as bytes are read (decision D5).
     * A zero-byte item sends no frames (decision D2).
     */
    val size: Long?,
    private val opener: () -> InputStream,
    private val onRelease: () -> Unit = {},
    /** Extra per-item fields of the terminal item (e.g. `file.pick` `name`). */
    val extra: Map<String, Any?> = emptyMap(),
    /**
     * A live source (a recording) streamed instead of [open]: every read
     * returns what has been captured so far (suspending only until at least
     * one byte or the end), and those bytes are framed and sent at once under
     * credit instead of waiting for a full 64 KiB chunk ("frames as
     * captured", RFC 001 §2.4). It may throw [DeviceDriverException] to end
     * the operation with that code. Live items never declare a size.
     */
    val live: LiveBlobSource? = null,
) {
    fun open(): InputStream = opener()

    /** Release temp storage / handles. Called once the upload ends, however it ends. */
    fun release() = onRelease()

    companion object {
        fun ofBytes(channel: Int, contentType: String, bytes: ByteArray): DriverBlob =
            DriverBlob(channel, contentType, bytes.size.toLong(), { ByteArrayInputStream(bytes) })

        /** A live-capture item (undeclared size) read from [source]; [onRelease] runs when the upload ends. */
        fun live(channel: Int, contentType: String, source: LiveBlobSource, onRelease: () -> Unit = {}): DriverBlob =
            DriverBlob(channel, contentType, null, { ByteArrayInputStream(ByteArray(0)) }, onRelease, live = source)
    }
}

/** A driver's terminal outcome. */
sealed class DriverOutcome {
    /**
     * Success. With [blobs], the runtime announces and streams each item, then
     * sends the terminal result with the actual `{channel, contentType, bytes,
     * sha256}` of every item merged into [result] — as the `items` array, or
     * as the single `item` object when [itemField] is `"item"` (`mic.record`).
     * [simulated]: the result comes from a fake host (`"simulated": true`).
     */
    data class Result(
        val result: Map<String, Any?> = emptyMap(),
        val blobs: List<DriverBlob> = emptyList(),
        val itemField: String = "items",
        val simulated: Boolean = false,
        /**
         * Result fields known only once every item was streamed (e.g.
         * `mic.record` `durationMs`), merged into [result] right before the
         * terminal is sent.
         */
        val resultAfterUpload: (() -> Map<String, Any?>)? = null,
    ) : DriverOutcome()

    /** [platformDetail] is a fixed diagnostic token (never exception text, paths or URIs). */
    data class Error(val code: DeviceErrorCode, val platformDetail: String? = null, val simulated: Boolean = false) : DriverOutcome()
}

/** What a running driver can do with its operation. */
interface DriverContext {
    val request: DeviceRequest
    val revision: CapabilityRevision

    /**
     * The normalized origin of the server this operation's socket talks to
     * (derived from the connection URL, never server-supplied text): prompts
     * and indicators name it, and grants and cooldowns are keyed on it.
     */
    val origin: String

    /**
     * Emit a capability stream event (`deviceEvent.event`). JSON stream credit
     * counts events: without credit the event is buffered, and a buffered
     * event with the same [coalesceKey] is replaced by the newer one (bounded;
     * oldest dropped first).
     */
    fun emit(event: Map<String, Any?>, coalesceKey: String? = null)

    /** Monotonic milliseconds on the host clock. */
    fun nowMs(): Long

    /**
     * Acquire the host-wide prompt gate before raising any prompt (host
     * dialog, OS dialog, system picker). Refused while another prompt is up or
     * while any of [cooldownKeys] is cooling down.
     */
    fun tryAcquirePrompt(vararg cooldownKeys: String): PromptAdmit

    /** Start the refusal cooldown for [key] (after a denial). */
    fun recordDenial(key: String)

    /** Start the (shorter) cooldown after a dismissed picker. */
    fun recordDismissal(key: String)

    /** Persistable consent for [capability] at this origin (§3 / §5). */
    fun hasConsent(capability: String): Boolean

    fun grantConsent(capability: String)

    /** Host-owned consent interaction; see [ConsentPresenter]. */
    val consent: ConsentPresenter

    /**
     * Set while the driver itself has the OS presenting (system picker,
     * permission dialog). Host suspension caused by that presentation is not
     * an app suspension and does not cancel the operation (RFC 001 §2.7).
     */
    var presenting: Boolean

    /**
     * Report optional progress (`{"kind":"progress","state":…}`, RFC 001
     * §2.1). It consumes no data credit; it never goes back to
     * `pendingConsent` after `running` or after any data (such a call is
     * ignored).
     */
    fun progress(state: ProgressState)

    /**
     * Server → client data plane (`binaryDownload` revisions, e.g.
     * `file.save`): grant [bytes] more credit, after consent and destination
     * selection (RFC 001 §2.4). Clamped to the revision's outstanding-credit
     * maximum. Returns the amount
     * actually granted (0 on other revisions or once the operation ended).
     */
    fun grantDownload(bytes: Long): Long

    /**
     * The verified chunks of a download, in order. The runtime checks
     * channel, sequence, credit and the declared size before delivering a
     * chunk, and closes the channel once every declared byte arrived and its
     * SHA-256 matched. Empty and closed for other revisions.
     */
    val downloadChunks: ReceiveChannel<ByteArray>

    /**
     * Run [handler] once when the operation ends, however it ends (terminal
     * sent, cancel, deadline, lease, detach), on the host dispatcher — e.g.
     * to stop capture hardware that feeds a live blob. Runs at once when the
     * operation already ended.
     */
    fun onEnd(handler: () -> Unit)

    /**
     * End the operation now with [code] from any thread (e.g. a capture
     * buffer that filled while credit was exhausted: `throttled`). No effect
     * once it ended.
     */
    fun abort(code: DeviceErrorCode, platformDetail: String?)

    /**
     * While set, host suspension (backgrounding) calls [handler] instead of
     * cancelling the operation: a live recording then ends normally with what
     * it captured (RFC 001 §2.4 "Backgrounding/suspension stops it the same
     * way"). Called on the host dispatcher.
     */
    fun onHostSuspend(handler: (() -> Unit)?)
}

interface DeviceDriver {
    val capability: String

    val versions: List<Long> get() = listOf(1L)

    /** True when the capability needs the binary frame profile. */
    val binary: Boolean get() = false

    /**
     * Advertise only what this device can actually implement (RFC 001 §2.2):
     * hardware present, OS requirements declared, indicator ready where one
     * is required — never whether a permission is granted (see
     * [CapabilityAdvertisement]). When an input can change at run time, call
     * [DeviceHost.recheckCapabilities] so live streams get a fresh snapshot.
     */
    fun isAvailable(): Boolean = true

    /**
     * Implementable here except that the host activity indicator is not ready
     * yet (hardware present, OS requirements declared): the capability joins
     * the advertisement as soon as the indicator's overlay attaches. See
     * [DeviceHost.helloAwaitsIndicator]. Default: false.
     */
    fun awaitsIndicator(): Boolean = false

    /**
     * The capability only runs while the app is in the foreground (a
     * host-visible indicator is part of it, e.g. `bluetooth.scan`): while the
     * host is suspended (no started Activity) requests are refused
     * `unavailable` (`host-suspended`) instead of running invisibly.
     */
    val requiresForeground: Boolean get() = false

    /** Closed-schema check of `params` for [version]; returns the violation, or null. */
    fun validateParams(version: Long, params: Map<String, Any?>): String?

    suspend fun run(ctx: DriverContext): DriverOutcome
}

/**
 * A host-owned consent prompt. Labels come from the host, never the server.
 * [developmentMode]: the origin is unauthenticated (`ws://`); the prompt must
 * say so visibly, and any grant is connection-scoped (RFC 001 §5).
 */
data class ConsentPrompt(
    val origin: String,
    val capability: String,
    val operation: String,
    val developmentMode: Boolean = !isAuthenticatedOrigin(origin),
)

enum class ConsentDecision {
    /** The user chose Continue. */
    CONTINUE,

    /** The user chose Cancel: a refusal (`denied`, starts the denial cooldown). */
    CANCEL,

    /**
     * The interaction went away without a choice — back, outside tap, or the
     * Activity hosting it was destroyed. Abandonment is `cancelled`, not a
     * refusal, so no cooldown starts (RFC 001 §2.6 step 4).
     */
    DISMISSED,

    /** No foreground UI can present it (headless / backgrounded). */
    UNAVAILABLE,
}

/**
 * Presents the host-owned consent interaction (RFC 001 §2.6 step 2): names
 * the authenticated origin and the operation, with Continue and Cancel. It is
 * cancellable: coroutine cancellation must dismiss it. [ConsentDecision.UNAVAILABLE]
 * when no foreground UI can present it. It must always settle: an interaction
 * torn down with its Activity resolves [ConsentDecision.DISMISSED] so the
 * host-wide prompt gate is released.
 */
fun interface ConsentPresenter {
    suspend fun present(prompt: ConsentPrompt): ConsentDecision

    companion object {
        /** Headless: consent can never be obtained (RFC 001 §2.6 → `unavailable`). */
        val HEADLESS = ConsentPresenter { ConsentDecision.UNAVAILABLE }
    }
}

/** Hides a shown [DeviceActivityIndicator]. Idempotent. */
fun interface IndicatorHandle {
    fun hide()
}

/** Why a shown indicator asked its stream to stop. */
enum class IndicatorStopReason {
    /** The user used the Stop control: the stream ends `cancelled` (`user-stopped`). */
    USER,

    /**
     * The indicator can no longer be seen (its overlay left the started
     * screen, or the window was covered): the stream ends `cancelled`
     * (`indicator-hidden`) rather than continuing invisibly (RFC 001 §5).
     */
    HIDDEN,
}

/**
 * The host-owned, always-visible activity indicator with a Stop control that
 * RFC 001 §5 requires for audio/BLE streams ("Do not assume every OS has a BLE
 * indicator" — Android shows none for BLE scans). It lives outside the
 * server's patch tree. `bluetooth.scan` and `mic.record` are advertised only
 * while one is wired and [isReady]; a driver that cannot show it fails
 * `unavailable` instead of running invisibly.
 *
 * Called on the host dispatcher (the main thread on Android).
 */
interface DeviceActivityIndicator {
    /** An indicator can be displayed right now (e.g. its overlay is composed on a started screen). Thread-safe. */
    val isReady: Boolean get() = true

    /**
     * Show the indicator naming the authenticated [origin] and a host-defined
     * [activity] label (never server text). [stop] ends the stream (terminal
     * `cancelled`) when the user uses the Stop control, or when the indicator
     * can no longer be seen ([IndicatorStopReason.HIDDEN]). Null when it
     * cannot be shown.
     */
    fun show(origin: String, activity: String, stop: (IndicatorStopReason) -> Unit): IndicatorHandle?
}

/** Closed-object helper for params validation. */
internal fun closedKeys(params: Map<String, Any?>, required: Set<String>, optional: Set<String> = emptySet()): String? {
    (params.keys - required - optional).firstOrNull()?.let { return "unexpected property $it" }
    (required - params.keys).firstOrNull()?.let { return "missing required $it" }
    return null
}
