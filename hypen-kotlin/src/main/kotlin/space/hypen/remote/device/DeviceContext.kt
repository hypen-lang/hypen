/**
 * Device Capability Protocol — the handler-facing device API (RFC 001 §4/§7).
 *
 * [DeviceContext] is what `ctx.device` resolves to inside a module handler.
 * It is created per handler invocation / lifecycle callback and carries the
 * owner authority (module instance + activation) the broker needs; it
 * enforces the replay firewall (§1.7): a request issued from a replayed
 * dispatch fails with `unavailable`, and that restriction survives
 * suspension.
 *
 * Everything protocol-side — admission against the live selection and the
 * selected revision, leases, credit, deadlines, blob verification — is the
 * Rust broker's, reached through the connection's [DevicePlane]. This file is
 * the typed, Result-style Kotlin API on top of it:
 *
 * ```kotlin
 * .onActionAsync("scan") { ctx ->
 *     when (val r = ctx.device.permissions.query(Permission.CAMERA)) {
 *         is DeviceResult.Ok -> ctx.state.set("camera", r.value.status.wireName)
 *         is DeviceResult.Err -> ctx.state.set("camera", r.error.code.wireName)
 *     }
 *     val photo = ctx.device.request(Capability.GALLERY_PICK, GalleryPickParams(listOf(MediaType.PHOTO), 1))
 *     ctx.device.events(Capability.BLUETOOTH_SCAN, BluetoothScanParams).take(3).collect { println(it.device.id) }
 * }
 * ```
 *
 * - Typed per capability: [request] takes only [UnaryCapability] values,
 *   [stream] / [events] only JSON-event streams, [stream] with `onData` /
 *   [data] only binary-upload streams — pairing a capability with another's
 *   params or the wrong operation is a compile error. [Permission] is the
 *   closed P1 enum. [requestUntyped] is the explicit escape hatch.
 * - Errors are values ([DeviceResult.Err]); only coroutine cancellation
 *   throws. Cancelling the calling coroutine (or a `withTimeout`) cancels the
 *   device request: the client is told `cancel`.
 * - A suspend action handler is a handler scope (§2.4): unary requests it
 *   left pending when it returns are cancelled, and the results it received
 *   keep counting toward the connection's retained-bytes budget until then.
 */
package space.hypen.remote.device

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A device error as a handler sees it. */
data class DeviceFailure(val code: DeviceErrorCode, val platformDetail: String? = null)

/** Thrown only by [DeviceResult.getOrThrow] and a failed [DeviceContext.events] / [DeviceContext.data] flow. */
class DeviceException(val failure: DeviceFailure) :
    RuntimeException("device error ${failure.code.wireName}" + (failure.platformDetail?.let { ": $it" } ?: ""))

/** The outcome of a device call: a value or an error value, never a throw. */
sealed class DeviceResult<out T> {
    data class Ok<out T>(
        val value: T,
        /** Set when a development fake produced the result (RFC 001 §1.11). */
        val simulated: Boolean = false,
    ) : DeviceResult<T>()

    data class Err(val error: DeviceFailure) : DeviceResult<Nothing>() {
        constructor(code: DeviceErrorCode, platformDetail: String? = null) : this(DeviceFailure(code, platformDetail))
    }

    val isOk: Boolean get() = this is Ok

    fun getOrNull(): T? = (this as? Ok)?.value

    fun errorOrNull(): DeviceFailure? = (this as? Err)?.error

    fun getOrThrow(): T = when (this) {
        is Ok -> value
        is Err -> throw DeviceException(error)
    }

    inline fun <R> map(transform: (T) -> R): DeviceResult<R> = when (this) {
        is Ok -> Ok(transform(value), simulated)
        is Err -> this
    }

    inline fun onOk(block: (T) -> Unit): DeviceResult<T> = also { if (it is Ok) block(it.value) }

    inline fun onErr(block: (DeviceFailure) -> Unit): DeviceResult<T> = also { if (it is Err) block(it.error) }
}

// ---------------------------------------------------------------------------
// Typed capability surface
// ---------------------------------------------------------------------------

/** A unary capability: `request(capability, params)` resolves with one [R]. */
class UnaryCapability<P : DevicePayload, R> internal constructor(
    /** The capability name (`"gallery.pick"`). */
    val name: String,
    internal val decode: (JsonObject, List<VerifiedBlob>) -> R,
) {
    override fun toString(): String = "UnaryCapability($name)"
}

/** A JSON-event stream (`bluetooth.scan`): events [E], terminal result [R]. */
class JsonStreamCapability<P : DevicePayload, E, R> internal constructor(
    val name: String,
    /** `null` for a revision event that is not a capability event (e.g. `progress`). */
    internal val decodeEvent: (JsonObject) -> E?,
    internal val decodeResult: (JsonObject) -> R,
) {
    override fun toString(): String = "JsonStreamCapability($name)"
}

/** A binary-upload stream (`mic.record`): bytes in order, terminal result [R]. */
class BinaryStreamCapability<P : DevicePayload, R> internal constructor(
    val name: String,
    internal val decodeResult: (JsonObject) -> R,
) {
    override fun toString(): String = "BinaryStreamCapability($name)"
}

/**
 * Every capability a server handler can use, typed (the Kotlin counterpart
 * of the TS `DeviceCapabilityMap`). Results are decoded with plain kotlinx
 * from the JSON the Rust broker already validated; upload results carry the
 * broker-verified bytes in place of the declared size + hash.
 */
object Capability {
    val PERMISSION_QUERY: UnaryCapability<PermissionParams, PermissionResult> =
        UnaryCapability("permission.query") { r, _ -> DeviceJson.decode(PermissionResult.serializer(), r) }
    val PERMISSION_REQUEST: UnaryCapability<PermissionParams, PermissionResult> =
        UnaryCapability("permission.request") { r, _ -> DeviceJson.decode(PermissionResult.serializer(), r) }
    val BLUETOOTH_SELECT: UnaryCapability<BluetoothSelectParams, BluetoothSelectResult> =
        UnaryCapability("bluetooth.select") { r, _ -> DeviceJson.decode(BluetoothSelectResult.serializer(), r) }
    val GALLERY_PICK: UnaryCapability<GalleryPickParams, List<VerifiedBlob>> =
        UnaryCapability("gallery.pick") { _, blobs -> blobs }
    val FILE_PICK: UnaryCapability<FilePickParams, List<VerifiedBlob>> =
        UnaryCapability("file.pick") { _, blobs -> blobs }
    val CAMERA_CAPTURE: UnaryCapability<CameraCaptureParams, VerifiedBlob> =
        UnaryCapability("camera.capture") { _, blobs -> blobs.single() }

    val BLUETOOTH_SCAN: JsonStreamCapability<BluetoothScanParams, BluetoothScanEvent, BluetoothScanResult> =
        JsonStreamCapability(
            "bluetooth.scan",
            decodeEvent = { e -> if ("device" in e) DeviceJson.decode(BluetoothScanEvent.serializer(), e) else null },
            decodeResult = { _ -> BluetoothScanResult },
        )

    val MIC_RECORD: BinaryStreamCapability<MicRecordParams, MicRecordResult> =
        BinaryStreamCapability("mic.record") { r -> DeviceJson.decode(MicRecordResult.serializer(), r) }
}

/** Options every device call takes. */
data class DeviceRequestOptions(
    /**
     * Request lifetime (RFC 001 §2.7); `null` = the revision's default
     * (`activation`). [Lifetime.BACKGROUND] is allowed only when the selected
     * revision lists it: its owner is the module instance (survives
     * deactivation, swept on destruction) and it counts toward the
     * connection's pin cap. [Lifetime.CONNECTION] is protocol-internal.
     */
    val lifetime: Lifetime? = null,
    /** Overall deadline; clamped to the revision's `maxTimeoutMs`. */
    val timeoutMs: Long? = null,
    /**
     * Initial client → server data credit (upload bytes / JSON events),
     * clamped to the revision. An explicit value below 1 is refused
     * `invalidParams` (the client could never send anything).
     */
    val initialCredit: Long? = null,
)

/** Provenance of the dispatch a device call is made from. */
enum class DeviceProvenance { ORIGIN, REPLAY }

/** The owner authority captured by a handler context (RFC 001 §2.7). */
data class DeviceOwner(val moduleInstanceId: String, val activationId: UInt)

/** A live stream opened by [DeviceContext.stream]. */
class DeviceStream<R> internal constructor(
    /** Wire request id, or `null` when the stream was refused locally. */
    val id: UInt?,
    private val outcome: CompletableDeferred<DeviceResult<R>>,
    private val onCancel: () -> Unit,
) {
    /**
     * The terminal outcome, exactly once: the client's result (after every
     * event / chunk was delivered to the consumer) or an error value
     * (`cancelled` after [cancel], `timeout`, `revoked`, …). Cancelling the
     * awaiting coroutine cancels the stream.
     */
    suspend fun await(): DeviceResult<R> = try {
        outcome.await()
    } catch (e: CancellationException) {
        cancel()
        throw e
    }

    /** Whether the stream has settled. */
    val isSettled: Boolean get() = outcome.isCompleted

    /** Abandon the stream (server-side cancellation; idempotent). */
    fun cancel() = onCancel()
}

/**
 * The per-invocation device surface. [owner] and [provenance] are fixed at
 * construction; a handler cannot forge another owner's authority or launder
 * a replayed dispatch into a live request.
 */
class DeviceContext(
    /** The connection's device plane, or `null` when there is none. */
    private val plane: DevicePlane?,
    private val owner: DeviceOwner?,
    private val provenance: DeviceProvenance = DeviceProvenance.ORIGIN,
    /**
     * Why requests fail `unavailable` although a plane exists (e.g.
     * `owner-inactive` for a callback outside an activation); `null` when the
     * owner may issue requests.
     */
    private val blockedDetail: String? = null,
    /**
     * Whether the captured activation is still live — re-checked after any
     * suspension so a continuation resuming after deactivation cannot start
     * new device work (RFC 001 §2.7).
     */
    private val ownerLive: () -> Boolean = { true },
) {
    private class HandlerScope {
        var open = true
        val unary = LinkedHashSet<DeviceRequestHandle>()
        val releases = ArrayList<() -> Unit>()
    }

    private val scopeLock = Any()
    private var scope: HandlerScope? = null

    /**
     * Open the invoking handler's scope (RFC 001 §2.4). Called by the module
     * instance right before it runs a suspend action handler with this
     * context; not for application code.
     */
    fun beginHandlerScope() = synchronized(scopeLock) {
        if (scope == null) scope = HandlerScope()
    }

    /**
     * The invoking handler returned: cancel every unary request it left
     * pending and release the retained-bytes charge of results it received.
     * Requests issued later through this context are unscoped.
     */
    fun endHandlerScope() {
        val (pendingUnary, releases) = synchronized(scopeLock) {
            val s = scope ?: return
            if (!s.open) return
            s.open = false
            val u = s.unary.toList()
            s.unary.clear()
            val r = s.releases.toList()
            s.releases.clear()
            u to r
        }
        pendingUnary.forEach { it.cancel() }
        releases.forEach { it() }
    }

    // ---- convenience wrappers ------------------------------------------------

    /** `permission.query` / `permission.request` over the closed [Permission] enum (P1). */
    val permissions: Permissions = Permissions()

    inner class Permissions internal constructor() {
        suspend fun query(permission: Permission, options: DeviceRequestOptions = DeviceRequestOptions()): DeviceResult<PermissionStatus> =
            request(Capability.PERMISSION_QUERY, PermissionParams(permission), options).map { it.status }

        suspend fun request(permission: Permission, options: DeviceRequestOptions = DeviceRequestOptions()): DeviceResult<PermissionStatus> =
            this@DeviceContext.request(Capability.PERMISSION_REQUEST, PermissionParams(permission), options).map { it.status }
    }

    /** `camera.capture`: one photo or video through the host's own capture UI. */
    val camera: Camera = Camera()

    inner class Camera internal constructor() {
        suspend fun capture(params: CameraCaptureParams, options: DeviceRequestOptions = DeviceRequestOptions()): DeviceResult<VerifiedBlob> =
            request(Capability.CAMERA_CAPTURE, params, options)
    }

    /** `mic.record`: PCM16 streamed to `onData` in order; the result's sha256 is verified over everything delivered. */
    val mic: Mic = Mic()

    inner class Mic internal constructor() {
        fun record(
            params: MicRecordParams,
            options: DeviceRequestOptions = DeviceRequestOptions(),
            onData: suspend (ByteArray) -> Unit,
        ): DeviceStream<MicRecordResult> = stream(Capability.MIC_RECORD, params, options, onData)
    }

    /** `bluetooth.select` (one chooser pick) and `bluetooth.scan` (live advertisements). */
    val bluetooth: Bluetooth = Bluetooth()

    inner class Bluetooth internal constructor() {
        suspend fun select(
            params: BluetoothSelectParams = BluetoothSelectParams(),
            options: DeviceRequestOptions = DeviceRequestOptions(),
        ): DeviceResult<SelectedBluetoothDevice> = request(Capability.BLUETOOTH_SELECT, params, options).map { it.device }

        fun scan(
            options: DeviceRequestOptions = DeviceRequestOptions(),
            onDevice: suspend (BluetoothDevice) -> Unit,
        ): DeviceStream<BluetoothScanResult> = stream(Capability.BLUETOOTH_SCAN, BluetoothScanParams, options) { onDevice(it.device) }
    }

    /** `gallery.pick`: photos/videos from the device library, bytes verified. */
    val gallery: Gallery = Gallery()

    inner class Gallery internal constructor() {
        suspend fun pick(params: GalleryPickParams, options: DeviceRequestOptions = DeviceRequestOptions()): DeviceResult<List<VerifiedBlob>> =
            request(Capability.GALLERY_PICK, params, options)
    }

    /** `file.pick` / `file.save`. */
    val files: Files = Files()

    inner class Files internal constructor() {
        suspend fun pick(params: FilePickParams, options: DeviceRequestOptions = DeviceRequestOptions()): DeviceResult<List<VerifiedBlob>> =
            request(Capability.FILE_PICK, params, options)

        suspend fun save(bytes: ByteArray, name: String, contentType: String, timeoutMs: Long? = null): DeviceResult<FileSaveResult> =
            this@DeviceContext.save(bytes, name, contentType, timeoutMs)
    }

    // ---- core API ----------------------------------------------------------------

    /** Negotiated live support — not a permission grant (RFC 001 §4). */
    fun supports(capability: String): Boolean = plane?.supports(capability) ?: false

    fun supports(capability: UnaryCapability<*, *>): Boolean = supports(capability.name)

    fun supports(capability: JsonStreamCapability<*, *, *>): Boolean = supports(capability.name)

    fun supports(capability: BinaryStreamCapability<*, *>): Boolean = supports(capability.name)

    private fun guard(): DeviceFailure? {
        if (provenance == DeviceProvenance.REPLAY) return DeviceFailure(DeviceErrorCode.UNAVAILABLE, "syncActions.replay")
        val p = plane ?: return DeviceFailure(DeviceErrorCode.UNAVAILABLE, blockedDetail ?: "device-disabled")
        if (p.isClosed) return DeviceFailure(DeviceErrorCode.CONNECTION_LOST)
        if (blockedDetail != null || owner == null) return DeviceFailure(DeviceErrorCode.UNAVAILABLE, blockedDetail ?: "owner-inactive")
        if (!ownerLive()) return DeviceFailure(DeviceErrorCode.UNAVAILABLE, "owner-inactive")
        return null
    }

    private fun wireCredit(capability: String, data: String?, options: DeviceRequestOptions): DeviceFailure? {
        val credit = options.initialCredit ?: return null
        if (data != "binaryUpload" && data != "jsonEvents") return null
        if (credit < 1) {
            return DeviceFailure(
                DeviceErrorCode.INVALID_PARAMS,
                "initialCredit must be ≥ 1 for $capability (a zero budget can never make progress)",
            )
        }
        return null
    }

    /**
     * Issue a unary request and await its terminal settlement as a value.
     * Typed per capability: [capability] must be a [UnaryCapability] and
     * [params] its params type. Upload items resolve with their verified
     * bytes. Cancelling the calling coroutine cancels the request.
     */
    suspend fun <P : DevicePayload, R> request(
        capability: UnaryCapability<P, R>,
        params: P,
        options: DeviceRequestOptions = DeviceRequestOptions(),
    ): DeviceResult<R> = when (val raw = requestRaw(capability.name, params.toJson(), options)) {
        is DeviceResult.Err -> raw
        is DeviceResult.Ok -> try {
            DeviceResult.Ok(capability.decode(raw.value.result, raw.value.blobs), raw.simulated)
        } catch (e: IllegalArgumentException) {
            DeviceResult.Err(DeviceErrorCode.INVALID_PARAMS, e.message?.take(512))
        }
    }

    /** A unary result for names only known at runtime: the result JSON and verified upload items. */
    class UntypedResult(val result: JsonObject, val blobs: List<VerifiedBlob>)

    /**
     * Untyped unary request for names only known at runtime (the explicit
     * opt-out of [request]'s compile-time checks). Names and params are still
     * validated against the selected revision before anything is sent.
     */
    suspend fun requestUntyped(
        capability: String,
        params: JsonObject,
        options: DeviceRequestOptions = DeviceRequestOptions(),
    ): DeviceResult<UntypedResult> = requestRaw(capability, params, options)

    private suspend fun requestRaw(capability: String, params: JsonObject, options: DeviceRequestOptions): DeviceResult<UntypedResult> {
        guard()?.let { return DeviceResult.Err(it) }
        val plane = plane!!
        val owner = owner!!
        val version = plane.selectedVersion(capability) ?: return DeviceResult.Err(DeviceErrorCode.UNSUPPORTED)
        val rev = plane.revision(capability, version)
        wireCredit(capability, rev?.data, options)?.let { return DeviceResult.Err(it) }
        val lifetime = options.lifetime ?: rev?.lifetimes?.firstOrNull()?.let(Lifetime::fromWireName) ?: Lifetime.ACTIVATION
        val scoped = synchronized(scopeLock) { scope?.takeIf { it.open && lifetime != Lifetime.BACKGROUND } }
        val handle = plane.open(
            DevicePlaneOpen(
                capability = capability,
                params = params,
                moduleInstanceId = owner.moduleInstanceId,
                activationId = owner.activationId,
                version = version,
                lifetime = options.lifetime,
                timeoutMs = options.timeoutMs,
                initialCredit = options.initialCredit,
                mode = "unary",
                // Completed-but-unconsumed results keep counting toward the
                // quota until the handler scope ends.
                holdResult = scoped != null,
            ),
        )
        if (handle.id == null) return DeviceResult.Err(refusal(handle))
        scoped?.let { s -> synchronized(scopeLock) { if (s.open) s.unary.add(handle) } }
        val settlement = try {
            handle.settled.await()
        } catch (e: CancellationException) {
            handle.cancel()
            throw e
        } finally {
            scoped?.let { s -> synchronized(scopeLock) { s.unary.remove(handle) } }
        }
        return when (settlement) {
            is DeviceSettlement.Failure -> DeviceResult.Err(settlement.code, settlement.detail)
            is DeviceSettlement.Success -> {
                settlement.release?.let { release ->
                    val deferred = scoped?.let { s -> synchronized(scopeLock) { if (s.open) s.releases.add(release) else null } }
                    if (deferred == null) release()
                }
                DeviceResult.Ok(UntypedResult(settlement.result, settlement.blobs), settlement.simulated)
            }
        }
    }

    /**
     * Open a JSON-event stream (`bluetooth.scan`). Each event was validated
     * by the broker before [onEvent] sees it; event credit is returned as
     * [onEvent] returns, so a slow consumer backpressures the device.
     */
    fun <P : DevicePayload, E, R> stream(
        capability: JsonStreamCapability<P, E, R>,
        params: P,
        options: DeviceRequestOptions = DeviceRequestOptions(),
        onEvent: suspend (E) -> Unit,
    ): DeviceStream<R> = openStream(
        capability.name,
        params.toJson(),
        options,
        onEvent = { raw ->
            val event = try {
                capability.decodeEvent(raw)
            } catch (_: IllegalArgumentException) {
                null
            }
            if (event != null) onEvent(event)
        },
        onData = null,
        decodeResult = capability.decodeResult,
    )

    /**
     * Open a binary-upload stream (`mic.record`): bytes arrive in order and
     * are never buffered server-side; credit is replenished as [onData]
     * returns; [DeviceStream.await] resolves after the last chunk was
     * delivered, with the result whose sha256 the broker verified over
     * everything delivered.
     */
    fun <P : DevicePayload, R> stream(
        capability: BinaryStreamCapability<P, R>,
        params: P,
        options: DeviceRequestOptions = DeviceRequestOptions(),
        onData: suspend (ByteArray) -> Unit,
    ): DeviceStream<R> = openStream(capability.name, params.toJson(), options, onEvent = null, onData = { b, _ -> onData(b) }, decodeResult = capability.decodeResult)

    /**
     * A cold [Flow] over a JSON-event stream: collecting opens the stream,
     * each event is emitted with backpressure (credit returns after the
     * collector processed it), the flow completes when the stream succeeds
     * and fails with [DeviceException] when it ends with an error. Stopping
     * collection early (`take`, `first`, cancellation) cancels the stream.
     */
    fun <P : DevicePayload, E, R> events(
        capability: JsonStreamCapability<P, E, R>,
        params: P,
        options: DeviceRequestOptions = DeviceRequestOptions(),
    ): Flow<E> = relay { consumer -> stream(capability, params, options) { consumer(it) } }

    /** A cold [Flow] over a binary-upload stream's chunks (see [events]). */
    fun <P : DevicePayload, R> data(
        capability: BinaryStreamCapability<P, R>,
        params: P,
        options: DeviceRequestOptions = DeviceRequestOptions(),
    ): Flow<ByteArray> = relay { consumer -> stream(capability, params, options) { consumer(it) } }

    private fun <T> relay(open: (suspend (T) -> Unit) -> DeviceStream<*>): Flow<T> = flow {
        val inbox = Channel<Pair<T, CompletableDeferred<Unit>>>(Channel.RENDEZVOUS)
        val stream = open { item ->
            val processed = CompletableDeferred<Unit>()
            inbox.send(item to processed)
            processed.await()
        }
        coroutineScope {
            val watcher = launch {
                when (val r = stream.await()) {
                    is DeviceResult.Ok -> inbox.close()
                    is DeviceResult.Err -> inbox.close(DeviceException(r.error))
                }
            }
            try {
                for ((item, processed) in inbox) {
                    emit(item)
                    processed.complete(Unit)
                }
            } finally {
                watcher.cancel()
                stream.cancel()
            }
        }
    }

    private fun <R> openStream(
        capability: String,
        params: JsonObject,
        options: DeviceRequestOptions,
        onEvent: (suspend (JsonObject) -> Unit)?,
        onData: (suspend (ByteArray, Int) -> Unit)?,
        decodeResult: (JsonObject) -> R,
    ): DeviceStream<R> {
        fun refused(f: DeviceFailure) = DeviceStream<R>(null, CompletableDeferred(DeviceResult.Err(f))) {}
        guard()?.let { return refused(it) }
        val plane = plane!!
        val owner = owner!!
        val version = plane.selectedVersion(capability) ?: return refused(DeviceFailure(DeviceErrorCode.UNSUPPORTED))
        val rev = plane.revision(capability, version)
        val data = if (rev?.mode == "stream") rev.data else null
        if (data != "jsonEvents" && data != "binaryUpload") {
            return refused(DeviceFailure(DeviceErrorCode.INVALID_PARAMS, "$capability is not a stream; use request()"))
        }
        if (data == "binaryUpload" && onData == null) {
            return refused(DeviceFailure(DeviceErrorCode.INVALID_PARAMS, "$capability streams bytes; pass onData"))
        }
        if (data == "jsonEvents" && onEvent == null) {
            return refused(DeviceFailure(DeviceErrorCode.INVALID_PARAMS, "$capability streams JSON events; pass onEvent"))
        }
        wireCredit(capability, data, options)?.let { return refused(it) }
        val handle = plane.open(
            DevicePlaneOpen(
                capability = capability,
                params = params,
                moduleInstanceId = owner.moduleInstanceId,
                activationId = owner.activationId,
                version = version,
                lifetime = options.lifetime,
                timeoutMs = options.timeoutMs,
                initialCredit = options.initialCredit,
                mode = "stream",
                onEvent = onEvent,
                onData = onData,
            ),
        )
        val outcome = CompletableDeferred<DeviceResult<R>>()
        if (handle.id == null) {
            val f = (handle.settled.getCompleted() as DeviceSettlement.Failure)
            outcome.complete(DeviceResult.Err(f.code, f.detail))
            return DeviceStream(null, outcome) {}
        }
        handle.settled.invokeOnCompletion {
            val s = handle.settled.getCompleted()
            outcome.complete(
                when (s) {
                    is DeviceSettlement.Failure -> DeviceResult.Err(s.code, s.detail)
                    is DeviceSettlement.Success -> try {
                        DeviceResult.Ok(decodeResult(s.result), s.simulated)
                    } catch (e: IllegalArgumentException) {
                        DeviceResult.Err(DeviceErrorCode.INVALID_PARAMS, e.message?.take(512))
                    }
                },
            )
        }
        return DeviceStream(handle.id, outcome) { handle.cancel() }
    }

    /**
     * Save [bytes] on the device (`file.save`, RFC 001 §2.4 downloads). The
     * request params are the announcement `{channel:0, name, contentType,
     * bytes, sha256}` with `initialCredit: 0`; the broker sends ≤ 64 KiB
     * frames only within credit the client grants after consent and
     * destination selection. The client verifies size and hash before
     * reporting `bytesWritten`.
     */
    suspend fun save(bytes: ByteArray, name: String, contentType: String, timeoutMs: Long? = null): DeviceResult<FileSaveResult> {
        val capability = "file.save"
        guard()?.let { return DeviceResult.Err(it) }
        val plane = plane!!
        val owner = owner!!
        val version = plane.selectedVersion(capability) ?: return DeviceResult.Err(DeviceErrorCode.UNSUPPORTED)
        if (!plane.canSendBinary) return DeviceResult.Err(DeviceErrorCode.UNSUPPORTED, "no binary route")
        if (bytes.isEmpty()) return DeviceResult.Err(DeviceErrorCode.INVALID_PARAMS, "file.save needs at least 1 byte")
        val rev = plane.revision(capability, version)
        if (rev != null && bytes.size > rev.maxItemBytes) {
            return DeviceResult.Err(DeviceErrorCode.INVALID_PARAMS, "${bytes.size} bytes exceeds max item bytes ${rev.maxItemBytes}")
        }
        // Snapshot: the caller may reuse its buffer while the transfer runs.
        val snapshot = bytes.copyOf()
        // The announcement `{channel:0, name, contentType, bytes, sha256}`,
        // built (and hashed) by the Rust engine; the broker validates it
        // against the selected revision at open.
        val params = DevicePlane.parse(uniffi.hypen_engine.deviceFileSaveParamsJson(name, contentType, snapshot)) as JsonObject
        // Authority re-checked after the hash (a long computation).
        guard()?.let { return DeviceResult.Err(it) }
        val handle = plane.open(
            DevicePlaneOpen(
                capability = capability,
                params = params,
                moduleInstanceId = owner.moduleInstanceId,
                activationId = owner.activationId,
                version = version,
                timeoutMs = timeoutMs,
                mode = "unary",
                download = snapshot,
            ),
        )
        val settlement = try {
            handle.settled.await()
        } catch (e: CancellationException) {
            handle.cancel()
            throw e
        }
        return when (settlement) {
            is DeviceSettlement.Failure -> DeviceResult.Err(settlement.code, settlement.detail)
            is DeviceSettlement.Success -> {
                val written = (settlement.result["bytesWritten"] as? JsonPrimitive)?.content?.toLongOrNull()
                if (written != snapshot.size.toLong()) {
                    DeviceResult.Err(DeviceErrorCode.INVALID_PARAMS, "client reported $written bytes written of ${snapshot.size}")
                } else {
                    DeviceResult.Ok(FileSaveResult(written), settlement.simulated)
                }
            }
        }
    }

    /**
     * A local refusal from the broker (nothing was sent). Params failing the
     * selected revision's schema are `invalidParams` with the broker's
     * diagnostic naming the failing field.
     */
    private suspend fun refusal(handle: DeviceRequestHandle): DeviceFailure {
        val f = handle.settled.await() as DeviceSettlement.Failure
        return DeviceFailure(f.code, f.detail)
    }

    companion object {
        /** A context that always refuses: hosts without a device plane. */
        fun disabled(detail: String = "device-disabled"): DeviceContext = DeviceContext(null, null, DeviceProvenance.ORIGIN, detail)

        /** A context that always refuses: replayed / broadcast dispatches (the replay firewall). */
        fun replayed(): DeviceContext = DeviceContext(null, null, DeviceProvenance.REPLAY)
    }
}
