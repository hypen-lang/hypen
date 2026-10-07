/**
 * The Android DeviceHost runtime (RFC 001 §2 / §5) — the Kotlin port of the
 * TypeScript `DeviceClient` (`@hypen-space/core/remote/device/runtime.ts`)
 * plus the admission rules of `@hypen-space/device-web`.
 *
 * [DeviceHost] is application-scoped: it owns the host-wide prompt gate,
 * cooldowns and persistable consent grants, so they survive reconnects and
 * Activity recreation. Dispose it when the app no longer needs device access
 * (or let `HypenApp(disposeDeviceHost = true)` bind it to a composition).
 * Each physical socket gets its own [DeviceConnection] from
 * [DeviceHost.openConnection], bound to the origin of the server that socket
 * talks to (prompts name it; grants and cooldowns are keyed on it). Messages
 * and frames from that socket go only to that connection, so a late callback
 * from an old socket can never reach a replacement (RFC 001 §2.5).
 *
 * Threading: every piece of connection/operation state is confined to the
 * host's serial [CoroutineDispatcher] (the Android factory uses the main
 * thread). [DeviceConnection.handleMessage]/[DeviceConnection.handleFrame]/
 * [DeviceConnection.onAck]/[DeviceConnection.close] may be called from any
 * thread (e.g. OkHttp's reader); inbound traffic is queued in a FIFO inbox
 * bounded by message count and bytes, and processed in order.
 */
package space.hypen.renderer.device

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** What a connection needs from its socket. Implementations must be thread-safe. */
interface DeviceTransport {
    /** Send one client → server device message (JSON object tree). */
    fun sendMessage(message: Map<String, Any?>)

    /** Send one binary frame (12-byte header + payload). */
    fun sendBinary(frame: ByteArray)

    /** Bytes queued in the transport but not yet written (OkHttp `queueSize()`). */
    fun pendingBytes(): Long = 0

    /** Close the physical socket (protocol abuse / inbox overflow). */
    fun close(code: Int, reason: String)
}

fun interface DeviceLog {
    fun log(message: String)

    companion object {
        val NONE = DeviceLog { }
    }
}

data class DeviceHostConfig(
    /**
     * Default normalized app origin (see [normalizeOrigin]) for connections
     * opened without an explicit one. `RemoteEngine` always passes the origin
     * of the URL it connects to, so prompts, grants and cooldowns follow the
     * server a socket actually talks to.
     */
    val origin: String,
    /**
     * Local deadline maximum for activation/background work: the deadline is
     * `min(timeoutMs, this)`. A `timeoutMs` above the selected revision's
     * maximum is refused `invalidParams`, never clamped (RFC 001 §2.1).
     */
    val localMaxTimeoutMs: Long = 600_000,
    /** Cooldown after a user/OS refusal before the same key may prompt again. */
    val denialCooldownMs: Long = 30_000,
    /** Cooldown after a dismissed system picker (host-local policy, stricter than the web host). */
    val dismissalCooldownMs: Long = 3_000,
    /** Expiry of a persistable consent grant (e.g. `bluetooth.scan`). */
    val consentGrantMs: Long = 24L * 60 * 60 * 1000,
    /** Live operations per connection before new requests are `throttled`. */
    val maxLiveOperations: Int = 32,
    /** Buffered (credit-starved) JSON events per operation; oldest dropped first. */
    val maxPendingEvents: Int = 256,
    /**
     * Inbound FIFO bound per connection, in messages. Generous on purpose: a
     * busy main thread (a long Compose frame) must not close a healthy socket;
     * only a real bound violation closes it (1008).
     */
    val inboxCapacity: Int = 8192,
    /**
     * Inbound FIFO bound per connection, in bytes (JSON text length plus
     * copied frame bytes). Frames are copied only up to their 12-byte header
     * unless a live download operation exists, so a hostile server cannot
     * queue payload memory (RFC 001 §5 "Bound incoming frames before parsing").
     */
    val inboxMaxBytes: Long = 8L * 1024 * 1024,
    /**
     * Connection-level protocol violations (JSON-limit breakers, bad frame
     * headers, unattributable messages; decision D3) tolerated before the
     * socket is closed (1002). They never terminate a request.
     */
    val maxViolations: Int = 8,
    /**
     * Pace uploads and JSON stream events by the server's credit (RFC 001
     * §2.3). Leave on: a server that never grants beyond `initialCredit` will
     * stall larger uploads until the deadline, which is conforming behaviour.
     */
    val enforceCredit: Boolean = true,
    /** Poll interval while the transport's pending bytes are at the 256 KiB bound. */
    val transportPollMs: Long = 16,
    /**
     * `moduleInstanceId`s whose latest `activationId` is remembered per
     * connection (activations never go backwards, RFC 001 §2.7); least
     * recently used entries are forgotten beyond this bound.
     */
    val maxTrackedModules: Int = 1024,
)

class DeviceHost(
    val config: DeviceHostConfig,
    drivers: List<DeviceDriver>,
    /** Serial dispatcher confining all host state (Android: `Dispatchers.Main`). */
    internal val dispatcher: CoroutineDispatcher,
    /** Where blob bytes are read (Android: `Dispatchers.IO`). */
    internal val ioDispatcher: CoroutineDispatcher = dispatcher,
    internal val clock: DeviceClock = DeviceClock.SYSTEM,
    cooldowns: CooldownStore = InMemoryCooldownStore(),
    internal val consent: ConsentPresenter = ConsentPresenter.HEADLESS,
    internal val log: DeviceLog = DeviceLog.NONE,
    /** Runs once from [dispose] (e.g. unregistering lifecycle callbacks). */
    private val onDispose: () -> Unit = {},
    /** The always-visible stream indicator wired into the drivers, if any (RFC 001 §5). */
    val activityIndicator: DeviceActivityIndicator? = null,
) {
    private val disposed = AtomicBoolean(false)

    @Volatile
    private var suspended = false

    internal val job = SupervisorJob()
    private val handler = CoroutineExceptionHandler { _, t -> log.log("device host: unexpected failure: ${t.javaClass.simpleName}") }
    private val scope = CoroutineScope(job + dispatcher + handler)
    internal val exceptionHandler: CoroutineExceptionHandler get() = handler
    internal val gate = PromptGate(clock, cooldowns)
    internal val grants = ConsentGrants(clock)
    private val connections = CopyOnWriteArraySet<DeviceConnection>()
    private val drivers: Map<String, DeviceDriver>

    init {
        val all = LinkedHashMap<String, DeviceDriver>()
        all[CORE_CAPABILITIES] = CoreCapabilitiesDriver(this)
        for (d in drivers) all.putIfAbsent(d.capability, d)
        this.drivers = all
    }

    /** `[{name, versions}]` for every capability this device can implement right now. */
    fun offers(): List<Map<String, Any?>> =
        drivers.values.filter { it.isAvailable() }.map { linkedMapOf("name" to it.capability, "versions" to it.versions) }

    /** The latest `core.capabilities` snapshot computed for any stream (see [recheckCapabilities]). */
    private val lastSnapshot = java.util.concurrent.atomic.AtomicReference<List<Map<String, Any?>>?>(null)

    /** Compute the snapshot a `core.capabilities` stream emits now, remembering it as the latest. */
    internal fun snapshotOffers(): List<Map<String, Any?>> = offers().also { lastSnapshot.set(it) }

    /**
     * The complete advertisement for `hello.device` (RFC 001 §2.2), or null
     * when it would not pass handshake-v1 (e.g. a custom driver with an
     * invalid name): device access is then off rather than sending a hello
     * the server must refuse (decision D7).
     */
    fun advertisement(): Map<String, Any?>? {
        val adv = linkedMapOf<String, Any?>("protocolVersions" to DeviceProtocol.PROTOCOL_VERSIONS, "binary" to true, "capabilities" to offers())
        DeviceHandshake.validateHello(adv)?.let {
            log.log("device: advertisement is not handshake-v1 ($it); device plane off")
            return null
        }
        return adv
    }

    /**
     * A `hello.device` snapshotted now would lack a capability only because
     * the activity indicator's overlay has not attached yet, while the app is
     * in the foreground — i.e. the overlay is still being composed (the
     * socket opened before the first frame, `RemoteEngine` connected before
     * the UI was set, a reconnect racing the screen). The handshake is
     * immutable per socket and `sessionAck.device` is the client's ceiling:
     * a capability the hello lacked stays `unsupported` for the whole
     * connection even after a `core.capabilities` snapshot offers it
     * (`fixtures/device` connection model), so `RemoteEngine` waits briefly
     * for this to clear before sending the hello. Never true while
     * backgrounded (the user, not a frame, decides when the overlay returns)
     * or once disposed. Any thread.
     */
    fun helloAwaitsIndicator(): Boolean =
        !disposed.get() && !suspended && drivers.values.any { it.awaitsIndicator() }

    /** Woken whenever an input of [helloAwaitsIndicator] may have changed. */
    private val helloWaiters = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    /**
     * Suspend until [helloAwaitsIndicator] is false. Event-driven, not
     * polled: woken by what changes it — the indicator's readiness (which
     * reaches the host through [recheckCapabilities]), the app leaving or
     * regaining the foreground, and [dispose]. The caller bounds the wait.
     */
    suspend fun awaitIndicatorForHello() {
        if (!helloAwaitsIndicator()) return
        kotlinx.coroutines.suspendCancellableCoroutine<Unit> { cont ->
            val done = java.util.concurrent.atomic.AtomicBoolean(false)
            lateinit var waiter: () -> Unit
            waiter = {
                if (!helloAwaitsIndicator() && done.compareAndSet(false, true)) {
                    helloWaiters.remove(waiter)
                    cont.resumeWith(Result.success(Unit))
                }
            }
            helloWaiters += waiter
            cont.invokeOnCancellation { helloWaiters.remove(waiter) }
            waiter() // it may have cleared before the waiter was registered
        }
    }

    private fun wakeHelloWaiters() = helloWaiters.forEach { it() }

    internal fun driverFor(capability: String, version: Long): DeviceDriver? =
        drivers[capability]?.takeIf { it.isAvailable() && version in it.versions }

    /**
     * Bind a freshly opened socket talking to [origin] (normalized, see
     * [normalizeOrigin]). Returns null once the host is disposed: the caller
     * then runs UI-only (a UI-only hello, no advertisement). Call
     * [DeviceConnection.close] when the socket closes.
     */
    fun openConnection(transport: DeviceTransport, origin: String = config.origin): DeviceConnection? {
        if (disposed.get()) return null
        val connection = DeviceConnection(this, transport, origin)
        connections += connection
        if (disposed.get()) {
            connection.close()
            return null
        }
        return connection
    }

    internal fun forget(connection: DeviceConnection) {
        connections -= connection
    }

    /** No started Activity: foreground-only capabilities are refused until [onHostResumed]. */
    val isSuspended: Boolean get() = suspended

    /**
     * The app went to the background (no started Activity). Stops
     * activation-bound work and pending host prompts, except operations whose
     * own OS presentation (picker, permission dialog) caused it (RFC 001
     * §2.7), and refuses capabilities that need the foreground
     * ([DeviceDriver.requiresForeground], e.g. `bluetooth.scan`) with
     * `unavailable` until [onHostResumed].
     */
    fun onHostSuspended() {
        suspended = true
        wakeHelloWaiters()
        if (disposed.get()) return
        scope.launch { connections.forEach { it.suspendActivationWork() } }
    }

    /** An Activity of the app is started again (see [onHostSuspended]). Any thread. */
    fun onHostResumed() {
        suspended = false
        wakeHelloWaiters()
    }

    /**
     * The set of implementable capabilities changed (e.g. the stream
     * indicator overlay appeared or went away): every live
     * `core.capabilities` stream emits a fresh full snapshot, coalesced to the
     * latest when event credit is exhausted (RFC 001 §2.2). Any thread.
     */
    fun capabilitiesChanged() {
        if (disposed.get()) return
        scope.launch { connections.forEach { it.emitCapabilities() } }
    }

    /**
     * Something an advertisement input depends on may have changed (the
     * indicator became ready or went away, the app gained or lost the
     * foreground): re-evaluate [offers] and, only when it differs from the
     * latest snapshot a `core.capabilities` stream was given, emit a fresh
     * one through [capabilitiesChanged]. Returns whether it emitted. Any thread.
     */
    fun recheckCapabilities(): Boolean {
        wakeHelloWaiters()
        if (disposed.get()) return false
        val now = offers()
        val before = lastSnapshot.getAndSet(now)
        if (before == now) return false
        capabilitiesChanged()
        return true
    }

    val isDisposed: Boolean get() = disposed.get()

    /** Tear down every connection and the host itself. Idempotent. */
    fun dispose() {
        if (!disposed.compareAndSet(false, true)) return
        wakeHelloWaiters()
        connections.forEach { it.close() }
        scope.cancel()
        runCatching(onDispose)
    }

    companion object {
        const val CORE_CAPABILITIES = "core.capabilities"
    }
}

/** Minimum inbox cost of one inbound item (bookkeeping overhead). */
internal const val SMALL_COST: Long = 64

/**
 * One physical socket's device plane, bound to the [origin] of the server
 * that socket talks to.
 */
class DeviceConnection internal constructor(
    private val host: DeviceHost,
    private val transport: DeviceTransport,
    /** Normalized origin of this socket's server: named in prompts, keys grants and cooldowns. */
    val origin: String,
) {
    private sealed class Inbound(val cost: Long) {
        class Ack(val device: Any?, val malformed: String?) : Inbound(SMALL_COST)

        class Json(val message: Map<String, Any?>, size: Long) : Inbound(size)

        class Malformed(val type: String, val detail: String, size: Long) : Inbound(size)

        /** [frame] may hold only the header when no download plane is live; [size] is the wire size. */
        class Binary(val frame: ByteArray, val size: Int) : Inbound(frame.size.toLong() + SMALL_COST)
    }

    private val config = host.config
    private val job = SupervisorJob(host.job)
    private val scope = CoroutineScope(job + host.dispatcher + host.exceptionHandler)
    private val inbox = Channel<Inbound>(Channel.UNLIMITED)
    private val queuedCount = AtomicInteger(0)
    private val queuedBytes = AtomicLong(0)

    /**
     * Ids of live operations with a server → client binary data plane
     * (`file.save`): only their frames are copied past the header at the
     * socket edge. Read from the socket thread.
     */
    private val liveDownloadIds: MutableSet<Long> = ConcurrentHashMap.newKeySet()

    /** Operations whose driver has the OS presenting (picker, permission dialog). */
    private val presentingOps = AtomicInteger(0)

    @Volatile
    var isClosed: Boolean = false
        private set

    /** True once `sessionAck.device` selected a common protocol version. */
    @Volatile
    var isEnabled: Boolean = false
        private set

    /** The `hello.device` this socket sent; the ack is validated against exactly this. */
    @Volatile
    private var hello: Map<String, Any?>? = null

    /** An ack carrying `device` was processed: the handshake is immutable now (§2.2). */
    private var ackSettled = false

    /** The negotiated selection (capability → revision), or null while not (or never) selected. */
    @Volatile
    var selection: DeviceSelection? = null
        private set

    private var highWater = 0L
    private var violations = 0
    private val ops = LinkedHashMap<Long, Operation>()

    /** The live `core.capabilities` stream (at most one, §2.2). */
    private var liveCoreId: Long? = null

    /** A `core.capabilities` stream was opened: app requests may follow. */
    private var coreOpened = false

    /** Latest `activationId` per `moduleInstanceId` (never goes backwards, §2.7). */
    private val activations = object : LinkedHashMap<String, Long>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?): Boolean = size > config.maxTrackedModules
    }

    /** Connection-scoped consent grants, used for unauthenticated (`ws:`) origins. */
    internal val grants = ConsentGrants(host.clock)

    /** Some operation has the OS presenting its own UI (a picker or permission dialog). Any thread. */
    val hasPresentingOperation: Boolean get() = presentingOps.get() > 0

    init {
        scope.launch {
            for (m in inbox) {
                queuedCount.decrementAndGet()
                queuedBytes.addAndGet(-m.cost)
                try {
                    when (m) {
                        is Inbound.Ack -> onAckInternal(m.device, m.malformed)
                        is Inbound.Json -> onJson(m.message)
                        is Inbound.Malformed -> onMalformed(m.type, m.detail)
                        is Inbound.Binary -> onBinary(m.frame, m.size)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (t: Throwable) {
                    host.log.log("device: failed to process inbound message: ${t.javaClass.simpleName}")
                }
            }
        }
    }

    // ---- handshake (any thread) -----------------------------------------------

    /**
     * The `hello.device` advertisement for this socket, snapshotted: the
     * server's `sessionAck.device` is validated against exactly what was sent
     * (RFC 001 §2.2), not against what the host offers when the ack arrives.
     * Null when no valid advertisement exists (the connection closes; send a
     * UI-only hello).
     */
    fun helloAdvertisement(): Map<String, Any?>? {
        if (isClosed) return null
        val adv = host.advertisement()
        if (adv == null) {
            close()
            return null
        }
        hello = adv
        return adv
    }

    // ---- inbound (any thread) ------------------------------------------------

    /**
     * `sessionAck.device` (or `null` when the server omitted the extension).
     * [malformed]: the socket edge could not decode it strictly (a JSON-limit
     * violation); the device plane stays disabled on this connection.
     */
    fun onAck(device: Any?, malformed: String? = null) = offer(Inbound.Ack(device, malformed))

    /**
     * A server → client device message (`deviceRequest` / `deviceEvent` /
     * `deviceResponse`), decoded strictly (see the tree contract in
     * `DeviceProtocol.kt`). [sizeBytes] is its wire size, counted against the
     * inbox byte bound.
     */
    fun handleMessage(message: Map<String, Any?>, sizeBytes: Int = SMALL_COST.toInt()) =
        offer(Inbound.Json(message, maxOf(sizeBytes.toLong(), SMALL_COST)))

    /**
     * Device text the socket edge refused before trusting its JSON (it broke
     * the RFC 001 §2.1 JSON limits). Attributable to no request (decisions
     * D3/D8): discarded and counted as a connection-level violation; the
     * request its id seems to name stays live, and no id is consumed.
     */
    fun handleMalformed(type: String, detail: String, sizeBytes: Int = SMALL_COST.toInt()) =
        offer(Inbound.Malformed(type, detail, maxOf(sizeBytes.toLong(), SMALL_COST)))

    /** A server → client binary frame already copied into memory. */
    fun handleFrame(frame: ByteArray) = offer(Inbound.Binary(frame, frame.size))

    /**
     * Transport edge for a server → client binary frame of [size] bytes that
     * has not been copied yet; [read] copies bytes `[start, end)`.
     *
     * A frame whose header names a live download operation of this
     * connection (`file.save`) reaches it whole (at most
     * [DeviceProtocol.MAX_FRAME_BYTES]; the download's own credit window
     * bounds how many can be in flight). Every other frame is copied only up
     * to its 12-byte header, because no payload could be consumed; the header
     * alone still lets a known id terminate `invalidParams` and a bad
     * version/flags count as a connection-level violation (RFC 001 §2.3).
     * Frames over [DeviceProtocol.MAX_FRAME_BYTES] are never copied past the
     * header.
     */
    fun handleFrame(size: Int, read: (start: Int, end: Int) -> ByteArray) {
        if (isClosed) return
        val headerLen = minOf(size, DeviceProtocol.FRAME_HEADER_LEN)
        val head = read(0, headerLen)
        if (size in (DeviceProtocol.FRAME_HEADER_LEN + 1)..DeviceProtocol.MAX_FRAME_BYTES && liveDownloadIds.isNotEmpty()) {
            val id = (DeviceFrames.decode(head) as? FrameDecode.Ok)?.header?.requestId
            if (id != null && id in liveDownloadIds) {
                offer(Inbound.Binary(read(0, size), size))
                return
            }
        }
        offer(Inbound.Binary(head, size))
    }

    /**
     * Socket gone: every operation stops (drivers are cancelled, hardware is
     * released, prompts dismissed) and nothing more is sent (RFC 001 §2.5).
     */
    fun close() {
        if (isClosed) return
        isClosed = true
        isEnabled = false
        inbox.close()
        job.cancel()
        presentingOps.set(0)
        host.forget(this)
        // Release what live operations hold (capture hardware, indicators) on
        // the host dispatcher, even when the host itself is being disposed.
        CoroutineScope(host.dispatcher + NonCancellable).launch {
            val live = ops.values.toList()
            ops.clear()
            live.forEach { it.runEndHandlers() }
        }
    }

    private fun offer(m: Inbound) {
        if (isClosed) return
        val count = queuedCount.incrementAndGet()
        val bytes = queuedBytes.addAndGet(m.cost)
        if (count > config.inboxCapacity || bytes > config.inboxMaxBytes || inbox.trySend(m).isFailure) {
            queuedCount.decrementAndGet()
            queuedBytes.addAndGet(-m.cost)
            if (isClosed) return
            host.log.log("device: inbound queue bound exceeded ($count messages, $bytes bytes); closing socket")
            runCatching { transport.close(1008, "device inbox overflow") }
            close()
        }
    }

    // ---- handshake -----------------------------------------------------------

    /**
     * An ack without `device` means "not selected yet", never "disabled for
     * good": the first ack that carries `device` is the selection (decision
     * D6; e.g. a late hello re-acked by a server). Once one was processed —
     * valid or not — the handshake is immutable for the socket (§2.2).
     */
    private fun onAckInternal(device: Any?, malformed: String?) {
        if (ackSettled) {
            if (device != null || malformed != null) host.log.log("device: ignoring a later sessionAck.device (the selection is immutable)")
            return
        }
        if (device == null && malformed == null) {
            host.log.log("device: sessionAck without device: not selected yet")
            return
        }
        ackSettled = true
        if (malformed != null) {
            host.log.log("device: plane disabled: malformed sessionAck.device: $malformed")
            return
        }
        val sent = hello ?: run {
            host.log.log("device: plane disabled: sessionAck.device without a device hello on this socket")
            return
        }
        when (val outcome = DeviceHandshake.accept(device, sent)) {
            is AckOutcome.Disabled -> host.log.log("device: plane disabled: ${outcome.reason}")
            is AckOutcome.Selected -> {
                outcome.dropped.forEach { host.log.log("device: dropping $it from the selection") }
                selection = outcome.selection
                isEnabled = true
            }
        }
    }

    // ---- JSON ----------------------------------------------------------------

    private fun onJson(message: Map<String, Any?>) {
        if (!isEnabled) {
            host.log.log("device: dropping device message on a connection without a negotiated device plane")
            return
        }
        when (DeviceWire.typeOf(message)) {
            "deviceRequest" -> onRequest(message)
            "deviceEvent" -> onEvent(message)
            "deviceResponse" -> onServerResponse(message)
            else -> violation("unexpected server → client device message type")
        }
    }

    private fun onRequest(message: Map<String, Any?>) {
        val parsed = DeviceWire.parseRequest(message)
        val id = when (parsed) {
            is Parsed.Ok -> parsed.value.id
            is Parsed.Invalid -> parsed.id ?: return violation(parsed.reason)
        }
        // Ids are never reused: duplicates/older requests are dropped unexecuted (§2.1).
        if (id <= highWater) {
            host.log.log("device: dropping duplicate/stale request id $id")
            return
        }
        highWater = id
        val req = when (parsed) {
            is Parsed.Ok -> parsed.value
            is Parsed.Invalid -> return reply(id, DeviceErrorCode.INVALID_PARAMS, parsed.reason)
        }
        val isCore = req.capability == DeviceHost.CORE_CAPABILITIES
        // Connection model (§2.2): the connection-owned control stream opens
        // before any app request; without it the mandatory control is missing.
        if (!isCore && !coreOpened) return connectionViolation("app request $id before any core.capabilities stream")

        // 1. Revision: exactly the negotiated one, declared, and implementable now.
        val selected = selection?.capabilities?.get(req.capability)
        if (selected != req.version) return reply(id, DeviceErrorCode.UNSUPPORTED, "${req.capability}@${req.version} is not in the negotiated selection")
        val revision = DeviceRegistry.revision(req.capability, req.version)
            ?: return reply(id, DeviceErrorCode.UNSUPPORTED, "${req.capability}@${req.version} is not a registry revision")
        val driver = host.driverFor(req.capability, req.version)
            ?: return reply(id, DeviceErrorCode.UNSUPPORTED, "${req.capability}@${req.version} is not currently offered")
        if (isCore && liveCoreId != null) return connectionViolation("second live core.capabilities stream ($id while $liveCoreId is live)")

        // 2. Owner/lifetime, limits, params against the selected revision.
        if (req.lifetime !in revision.lifetimes) {
            return reply(id, DeviceErrorCode.INVALID_PARAMS, "lifetime ${req.lifetime.wireName} not allowed")
        }
        (req.owner as? Owner.Activation)?.let { owner ->
            val latest = activations[owner.moduleInstanceId]
            // An older activation would resurrect revoked authority (§2.7).
            if (latest != null && owner.activationId < latest) {
                return reply(id, DeviceErrorCode.INVALID_PARAMS, "activationId went backwards")
            }
            activations[owner.moduleInstanceId] = owner.activationId
        }
        // The deadline is validated against the revision (§2.1), never silently
        // clamped; only the host-local maximum below may shorten it.
        if (req.timeoutMs > revision.maxTimeoutMs) {
            return reply(id, DeviceErrorCode.INVALID_PARAMS, "timeoutMs above ${revision.maxTimeoutMs}")
        }
        if (req.initialCredit > revision.maxInitialCredit) {
            return reply(id, DeviceErrorCode.INVALID_PARAMS, "initialCredit above ${revision.maxInitialCredit}")
        }
        DevicePayloads.validate(req.capability, req.version, PayloadKind.PARAMS, req.params)?.let {
            return reply(id, DeviceErrorCode.INVALID_PARAMS, it)
        }
        driver.validateParams(req.version, req.params)?.let { return reply(id, DeviceErrorCode.INVALID_PARAMS, it) }

        // 3. Host state and resource admission.
        if (driver.requiresForeground && host.isSuspended) return reply(id, DeviceErrorCode.UNAVAILABLE, "host-suspended")
        if (ops.size >= config.maxLiveOperations) return reply(id, DeviceErrorCode.THROTTLED, "too-many-operations")

        if (isCore) {
            liveCoreId = id
            coreOpened = true
        }
        start(Operation(req, revision, driver))
    }

    private fun start(op: Operation) {
        ops[op.request.id] = op
        if (op.download != null) liveDownloadIds += op.request.id
        // The client lease starts at receipt, including while awaiting consent (§2.7).
        op.leaseDeadline = host.clock.monotonicMs() + DeviceProtocol.LEASE_EXPIRY_MS
        op.leaseJob = leaseTimer(op)
        // Deadline: min(timeoutMs, local maximum) from receipt (§2.1); timeoutMs
        // is already within the revision maximum.
        var deadline = op.request.timeoutMs
        if (op.request.lifetime != Lifetime.CONNECTION) deadline = minOf(deadline, config.localMaxTimeoutMs)
        op.deadlineJob = scope.launch {
            delay(deadline)
            terminate(op, DriverOutcome.Error(DeviceErrorCode.TIMEOUT))
        }
        // Undispatched: the driver runs to its first suspension while the
        // request is processed, so its immediate effects (first snapshot,
        // early errors) precede any later inbound message's replies.
        op.job = scope.launch(start = CoroutineStart.UNDISPATCHED) { runOperation(op) }
    }

    private fun leaseTimer(op: Operation): Job = scope.launch {
        delay(DeviceProtocol.LEASE_EXPIRY_MS)
        terminate(op, DriverOutcome.Error(DeviceErrorCode.CONNECTION_LOST, "lease-expired"))
    }

    private fun onEvent(message: Map<String, Any?>) {
        val ev = when (val parsed = DeviceWire.parseEvent(message)) {
            is Parsed.Ok -> parsed.value
            is Parsed.Invalid -> {
                val id = parsed.id ?: return violation(parsed.reason)
                // Liveness before validity: unknown/retired ids are ignored (§2.1).
                ops[id]?.let { terminate(it, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, parsed.reason)) }
                return
            }
        }
        // Unknown/stale ids are ignored; renewals cannot create or revive a request (§2.1/§2.7).
        val op = ops[ev.id] ?: return
        val control = ev.control
        if (control == null) {
            // No v1 revision defines server → client capability events: a
            // known-id event is a direction violation (fixture violation-event-from-server).
            terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "unexpected server → client event"))
            return
        }
        when (control) {
            is Control.RenewLease -> onRenew(op, control.seq)
            Control.Cancel -> terminate(op, DriverOutcome.Error(DeviceErrorCode.CANCELLED))
            is Control.Grant -> onGrant(op, control.amount)
            is Control.LeaseAck -> terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "leaseAck is client → server"))
            is Control.Paused -> onServerPaused(op, control.paused)
        }
    }

    /**
     * A server `deviceResponse` (decision D8): on a live id the operation
     * terminates `invalidParams`; for an unknown or retired id it is ignored,
     * never a violation.
     */
    private fun onServerResponse(message: Map<String, Any?>) {
        val id = DeviceWire.exactLong(message["id"])?.takeIf { it in 1..DeviceProtocol.U32_MAX }
            ?: return violation("deviceResponse from the server without an attributable id")
        val op = ops[id] ?: return
        terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "deviceResponse from the server"))
    }

    /**
     * Lease renewal (RFC 001 §2.7): the first renewal is sequence 1, and each
     * later one strictly increases (gaps allowed: an unsent renewal is
     * replaced by the latest). Anything else terminates `invalidParams`.
     */
    private fun onRenew(op: Operation, seq: Long) {
        val now = host.clock.monotonicMs()
        // Check expiry before processing a queued renewal: expired work cannot be revived.
        if (now >= op.leaseDeadline) {
            terminate(op, DriverOutcome.Error(DeviceErrorCode.CONNECTION_LOST, "lease-expired"))
            return
        }
        if (op.lastRenew == 0L && seq != 1L) {
            terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "first renewLease must be 1"))
            return
        }
        if (seq <= op.lastRenew) {
            terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "renewLease must strictly increase"))
            return
        }
        op.lastRenew = seq
        op.leaseDeadline = now + DeviceProtocol.LEASE_EXPIRY_MS
        op.leaseJob?.cancel()
        op.leaseJob = leaseTimer(op)
        // Echo immediately, even pending consent / paused / idle.
        send(DeviceWire.control(op.request.id, Control.LeaseAck(seq)))
    }

    private fun onGrant(op: Operation, amount: Long) {
        // Credit only flows to a client → server data plane: a grant on a
        // data-plane-none op, or from the sender of a download, is a violation.
        if (op.revision.data != DataPlane.BINARY_UPLOAD && op.revision.data != DataPlane.JSON_EVENTS) {
            terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "grant on a capability without client → server data"))
            return
        }
        val next = op.credit + amount
        if (next > op.revision.maxOutstandingCredit) {
            terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "credit overflow"))
            return
        }
        op.credit = next
        op.creditSignal.trySend(Unit)
        op.flushEvents()
    }

    /** `paused` travels data sender → receiver: from the server only on a download, and only as a transition. */
    private fun onServerPaused(op: Operation, paused: Boolean) {
        val d = op.download ?: run {
            terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "paused from the data receiver"))
            return
        }
        if (paused == d.serverPaused) {
            terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "paused repeats the current state"))
            return
        }
        d.serverPaused = paused
    }

    // ---- malformed JSON --------------------------------------------------------

    private fun onMalformed(type: String, detail: String) {
        if (!isEnabled) {
            host.log.log("device: dropping malformed device text on a connection without a negotiated device plane")
            return
        }
        // Connection-level (decisions D3/D8): never attributed to a request.
        violation("$type broke the JSON limits: $detail")
    }

    // ---- binary --------------------------------------------------------------

    private fun onBinary(frame: ByteArray, size: Int) {
        if (!isEnabled) return
        when (val decoded = DeviceFrames.decode(frame)) {
            FrameDecode.Short -> host.log.log("device: dropping short frame ($size bytes)")
            // Unknown version / nonzero flags: the header is untrusted, so this
            // is connection-level and never terminates a request (decision D3).
            is FrameDecode.Violation -> violation("frame ${decoded.detail}")
            is FrameDecode.Ok -> {
                // Liveness first: frames for unknown ids allocate nothing.
                val op = ops[decoded.header.requestId] ?: return
                if (size > DeviceProtocol.MAX_FRAME_BYTES) {
                    // Oversize frames are refused before their payload is read (§5).
                    terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "frame of $size bytes exceeds ${DeviceProtocol.MAX_FRAME_BYTES}"))
                    return
                }
                val d = op.download
                if (d == null) {
                    // Frames flow against this operation's data direction (§2.3).
                    terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "unexpected frame on channel ${decoded.header.channel}"))
                    return
                }
                onDownloadFrame(op, d, decoded.header, decoded.payload)
            }
        }
    }

    private fun onDownloadFrame(op: Operation, d: DownloadState, header: FrameHeader, payload: ByteArray) {
        val problem = when {
            header.channel != 0 -> "frame on unannounced channel ${header.channel}"
            payload.isEmpty() -> "zero-length frame"
            !d.sequence.accept(header.seq) -> "frame seq ${header.seq}, expected ${d.sequence.next}"
            d.serverPaused -> "data while paused"
            payload.size > d.credit -> "data exceeds credit"
            d.received + payload.size > d.bytes -> "bytes beyond the declared size"
            else -> null
        }
        if (problem != null) {
            terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, problem))
            return
        }
        d.credit -= payload.size
        d.received += payload.size
        d.digest.update(payload)
        d.chunks.trySend(payload)
        if (d.received == d.bytes) {
            if (hex(d.digest.digest()) != d.sha256) {
                terminate(op, DriverOutcome.Error(DeviceErrorCode.INVALID_PARAMS, "sha256 mismatch"))
                return
            }
            d.verified = true
            d.chunks.close()
        }
    }

    /** Connection-level protocol violation (decision D3): counted, diagnosed at a bounded rate, fatal only when repeated. */
    private fun violation(reason: String) {
        violations += 1
        if (violations <= 4 || violations % 64 == 0) host.log.log("device: protocol violation #$violations: ${reason.take(160)}")
        if (violations >= config.maxViolations && !isClosed) {
            runCatching { transport.close(1002, "device protocol violation") }
            close()
        }
    }

    /** The connection's mandatory control stream broke (§2.2): the device connection closes. */
    private fun connectionViolation(reason: String) {
        host.log.log("device: control stream violation: $reason; closing the device connection")
        runCatching { transport.close(1002, "device control stream violation") }
        close()
    }

    // ---- operations ------------------------------------------------------------

    internal fun emitCapabilities() {
        if (isClosed) return
        val snapshot = mapOf("capabilities" to host.snapshotOffers())
        for (op in ops.values.toList()) {
            if (op.request.capability == DeviceHost.CORE_CAPABILITIES) op.emit(snapshot, coalesceKey = CoreCapabilitiesDriver.SNAPSHOT_KEY)
        }
    }

    internal fun suspendActivationWork() {
        for (op in ops.values.toList()) {
            if (op.request.lifetime == Lifetime.ACTIVATION && !op.presenting) {
                // A live recording ends normally with what it captured (§2.4).
                val graceful = op.suspendHandler
                if (graceful != null) {
                    op.suspendHandler = null
                    runCatching(graceful)
                } else {
                    terminate(op, DriverOutcome.Error(DeviceErrorCode.CANCELLED, "host-suspended"))
                }
            }
        }
    }

    private suspend fun runOperation(op: Operation) {
        val outcome = try {
            op.driver.run(op)
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            // A fixed token: exception text can carry URIs or paths (never sent).
            host.log.log("device: driver ${op.request.capability} failed: ${t.javaClass.simpleName}")
            DriverOutcome.Error(DeviceErrorCode.INTERNAL, "driver-failure")
        }
        if (op.terminated || isClosed) {
            // Cancelled/timed out first: a late result is never uploaded (§2.1).
            (outcome as? DriverOutcome.Result)?.blobs?.forEach { runCatching { it.release() } }
            return
        }
        when {
            outcome is DriverOutcome.Result && op.revision.data == DataPlane.BINARY_UPLOAD -> upload(op, outcome)
            outcome is DriverOutcome.Result && op.download != null && !op.download.verified ->
                terminate(op, DriverOutcome.Error(DeviceErrorCode.INTERNAL, "download-incomplete"))
            else -> finish(op, outcome)
        }
    }

    /**
     * Announce every item, then stream each one under credit (RFC 001 §2.4):
     * declared items must match their size exactly; undeclared ones stream
     * until their source ends (decision D5), bounded by `maxItemBytes` as
     * bytes are read. A zero-byte item sends no frames (decision D2). Any
     * failure to open or read an item terminates the operation (fixed
     * diagnostic tokens only).
     */
    private suspend fun upload(op: Operation, outcome: DriverOutcome.Result) {
        val id = op.request.id
        val blobs = outcome.blobs
        try {
            limitViolation(op, blobs)?.let {
                host.log.log("device: driver ${op.request.capability} produced invalid items: $it")
                terminate(op, DriverOutcome.Error(DeviceErrorCode.INTERNAL, "invalid-items"))
                return
            }
            // Announcement before any bytes on the channel (§2.4 step 2).
            for (blob in blobs) {
                op.dataSent = true
                send(DeviceWire.event(id, DeviceWire.blobStart(blob.channel, blob.contentType, blob.size)))
            }
            val buffer = ByteArray(DeviceProtocol.MAX_BULK_CHUNK_BYTES)
            val items = ArrayList<Map<String, Any?>>(blobs.size)
            for (blob in blobs) {
                if (op.terminated || isClosed) return
                items += streamBlob(op, blob, buffer) ?: return
            }
            val result = LinkedHashMap(outcome.result)
            outcome.resultAfterUpload?.let { result.putAll(it()) }
            if (outcome.itemField == "item" && items.size == 1) result["item"] = items.single() else result[outcome.itemField] = items
            // Terminal success strictly after its bytes (§2.3 ordering).
            finish(op, DriverOutcome.Result(result, simulated = outcome.simulated))
        } finally {
            blobs.forEach { runCatching { it.release() } }
        }
    }

    /** Stream one item; its terminal item map, or null when the operation terminated. */
    private suspend fun streamBlob(op: Operation, blob: DriverBlob, buffer: ByteArray): Map<String, Any?>? {
        val id = op.request.id
        val live = blob.live
        val input = if (live != null) null else try {
            withContext(host.ioDispatcher) { blob.open() }
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            terminate(op, readFailure(op, t))
            return null
        }
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            val declared = if (live != null) null else blob.size
            var seq = 0L
            var sent = 0L
            while (true) {
                if (declared != null && sent == declared) {
                    if (withContext(host.ioDispatcher) { input!!.read() } != -1) {
                        terminate(op, DriverOutcome.Error(DeviceErrorCode.INTERNAL, "item longer than declared"))
                        return null
                    }
                    break
                }
                val want = if (declared != null) minOf(DeviceProtocol.MAX_BULK_CHUNK_BYTES.toLong(), declared - sent).toInt() else DeviceProtocol.MAX_BULK_CHUNK_BYTES
                // Read ahead at most one chunk (bounded), then send it under
                // credit. A live source is framed as captured (one read).
                val chunk = if (live != null) {
                    maxOf(0, live.read(buffer, 0, want))
                } else {
                    withContext(host.ioDispatcher) { readUpTo(input!!, buffer, want) }
                }
                if (declared != null && chunk < want) {
                    terminate(op, DriverOutcome.Error(DeviceErrorCode.INTERNAL, "item shorter than declared"))
                    return null
                }
                if (chunk == 0) break // undeclared: the source ended
                if (sent + chunk > op.revision.maxItemBytes) {
                    terminate(op, DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "item-exceeds-limit"))
                    return null
                }
                digest.update(buffer, 0, chunk)
                var off = 0
                while (off < chunk) {
                    val n = awaitCredit(op, chunk - off)
                    awaitTransportCapacity()
                    if (seq > DeviceProtocol.U32_MAX) {
                        // Terminate before seq would wrap (§2.3).
                        terminate(op, DriverOutcome.Error(DeviceErrorCode.INTERNAL, "frame sequence exhausted"))
                        return null
                    }
                    if (op.terminated || isClosed) return null
                    transport.sendBinary(DeviceFrames.encode(FrameHeader(channel = blob.channel, requestId = id, seq = seq), buffer, off, n))
                    if (config.enforceCredit) op.credit -= n
                    seq += 1
                    off += n
                    sent += n
                    // One chunk per scheduling turn: queued controls run first (§2.3).
                    yield()
                }
            }
            val item = linkedMapOf<String, Any?>("channel" to blob.channel)
            item.putAll(blob.extra)
            item["contentType"] = blob.contentType
            item["bytes"] = sent
            item["sha256"] = hex(digest.digest())
            return item
        } catch (e: CancellationException) {
            throw e
        } catch (t: Throwable) {
            terminate(op, readFailure(op, t))
            return null
        } finally {
            if (input != null) withContext(NonCancellable + host.ioDispatcher) { runCatching { input.close() } }
        }
    }

    /** A fixed-token error for a failed item read (never exception text: it can carry URIs/paths). */
    private fun readFailure(op: Operation, t: Throwable): DriverOutcome.Error {
        host.log.log("device: reading an item of ${op.request.capability} failed: ${t.javaClass.simpleName}")
        return when (t) {
            // A live source ending the operation itself (e.g. `throttled`).
            is DeviceDriverException -> DriverOutcome.Error(t.code, t.detail)
            is SecurityException -> DriverOutcome.Error(DeviceErrorCode.REVOKED, "read-denied")
            is IOException -> DriverOutcome.Error(DeviceErrorCode.UNAVAILABLE, "read-failed")
            else -> DriverOutcome.Error(DeviceErrorCode.INTERNAL, "read-failed")
        }
    }

    private fun limitViolation(op: Operation, blobs: List<DriverBlob>): String? {
        if (blobs.size > op.revision.maxItems) return "driver produced ${blobs.size} items (max ${op.revision.maxItems})"
        if (blobs.map { it.channel }.toSet().size != blobs.size) return "duplicate blob channel"
        for (b in blobs) {
            if (b.channel !in 0 until op.revision.maxItems) return "channel ${b.channel} out of range"
            if (b.size != null && b.size !in 0..op.revision.maxItemBytes) return "item of ${b.size} bytes exceeds ${op.revision.maxItemBytes}"
            if (b.contentType.codePointLength() > 256) return "contentType too long"
            DevicePayloads.blobStartViolation(op.request.capability, op.request.version, op.request.params, b.contentType)?.let { return it }
            DevicePayloads.validate(op.request.capability, op.request.version, PayloadKind.EVENT, DeviceWire.blobStart(b.channel, b.contentType, b.size))
                ?.let { return it }
        }
        return null
    }

    /**
     * Wait for upload credit (RFC 001 §2.3). Exhausted credit is reported
     * once as `paused:true` and resuming as `paused:false` — transitions,
     * never repeats; nothing is sent while paused.
     */
    private suspend fun awaitCredit(op: Operation, want: Int): Int {
        if (!config.enforceCredit) return want
        if (op.credit <= 0) {
            if (!op.pausedReported) {
                op.pausedReported = true
                send(DeviceWire.control(op.request.id, Control.Paused(true)))
            }
            while (op.credit <= 0) op.creditSignal.receive()
        }
        if (op.pausedReported) {
            op.pausedReported = false
            send(DeviceWire.control(op.request.id, Control.Paused(false)))
        }
        return minOf(want.toLong(), op.credit).toInt()
    }

    private suspend fun awaitTransportCapacity() {
        while (transport.pendingBytes() >= DeviceProtocol.MAX_TRANSPORT_PENDING_BYTES) delay(config.transportPollMs)
    }

    private fun readUpTo(input: InputStream, buffer: ByteArray, n: Int): Int {
        var off = 0
        while (off < n) {
            val r = input.read(buffer, off, n - off)
            if (r < 0) break
            off += r
        }
        return off
    }

    /** Settle with a driver's outcome; an outbound result that fails its revision schema is `internal`. */
    private fun finish(op: Operation, outcome: DriverOutcome) {
        if (outcome is DriverOutcome.Result) {
            DevicePayloads.validate(op.request.capability, op.request.version, PayloadKind.RESULT, outcome.result)?.let {
                host.log.log("device: driver ${op.request.capability} produced an invalid result: $it")
                terminate(op, DriverOutcome.Error(DeviceErrorCode.INTERNAL, "invalid-result"))
                return
            }
        }
        terminate(op, outcome)
    }

    /** Settle [op] exactly once: send its terminal, stop its timers and driver. */
    private fun terminate(op: Operation, outcome: DriverOutcome): Boolean {
        if (op.terminated) return false
        op.terminated = true
        ops.remove(op.request.id)
        op.download?.let {
            liveDownloadIds -= op.request.id
            it.chunks.close()
        }
        if (liveCoreId == op.request.id) liveCoreId = null
        op.presenting = false
        op.leaseJob?.cancel()
        op.deadlineJob?.cancel()
        op.pending.clear()
        when (outcome) {
            is DriverOutcome.Result -> send(DeviceWire.result(op.request.id, outcome.result, outcome.simulated))
            is DriverOutcome.Error -> send(DeviceWire.error(op.request.id, outcome.code, outcome.platformDetail, outcome.simulated))
        }
        op.job?.cancel()
        op.runEndHandlers()
        return true
    }

    private fun reply(id: Long, code: DeviceErrorCode, detail: String?) {
        send(DeviceWire.error(id, code, detail))
    }

    private fun send(message: Map<String, Any?>) {
        if (isClosed) return
        try {
            transport.sendMessage(message)
        } catch (t: Throwable) {
            host.log.log("device: send failed: ${t.javaClass.simpleName}")
        }
    }

    /** Receiver state of a server → client (`file.save`) data plane. */
    private class DownloadState(val bytes: Long, val sha256: String) {
        /** Granted and not yet consumed. */
        var credit = 0L
        var received = 0L

        /** file.save is lossless (overflow `pause`): exactly the next seq. */
        val sequence = FrameSequence(lossless = true)
        var serverPaused = false
        var verified = false
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256")

        /** Bounded by the granted credit (≤ the revision's maxOutstandingCredit). */
        val chunks = Channel<ByteArray>(Channel.UNLIMITED)
    }

    private inner class Operation(
        override val request: DeviceRequest,
        override val revision: CapabilityRevision,
        val driver: DeviceDriver,
    ) : DriverContext {
        var terminated = false
        var job: Job? = null
        var leaseJob: Job? = null
        var deadlineJob: Job? = null
        var lastRenew = 0L
        var leaseDeadline = 0L
        var credit: Long = request.initialCredit
        val creditSignal = Channel<Unit>(Channel.CONFLATED)
        val pending = LinkedHashMap<String, Map<String, Any?>>()
        private var anonymous = 0L
        var pausedReported = false
        var progressRunning = false
        var dataSent = false

        /** See [DriverContext.onHostSuspend]. */
        var suspendHandler: (() -> Unit)? = null
        private var endHandlers: MutableList<() -> Unit>? = ArrayList()

        fun runEndHandlers() {
            val handlers = endHandlers ?: return
            endHandlers = null
            suspendHandler = null
            handlers.forEach { h ->
                try {
                    h()
                } catch (t: Throwable) {
                    host.log.log("device: end handler of ${request.capability} failed: ${t.javaClass.simpleName}")
                }
            }
        }

        override fun onEnd(handler: () -> Unit) {
            val handlers = endHandlers
            if (handlers == null) runCatching(handler) else handlers += handler
        }

        override fun abort(code: DeviceErrorCode, platformDetail: String?) {
            if (terminated || isClosed) return
            scope.launch { terminate(this@Operation, DriverOutcome.Error(code, platformDetail)) }
        }

        override fun onHostSuspend(handler: (() -> Unit)?) {
            if (!terminated) suspendHandler = handler
        }

        val download: DownloadState? = if (revision.data == DataPlane.BINARY_DOWNLOAD) {
            DownloadState(DeviceWire.exactLong(request.params["bytes"]) ?: 0L, request.params["sha256"] as? String ?: "")
        } else {
            null
        }

        override val downloadChunks: ReceiveChannel<ByteArray> = download?.chunks ?: Channel<ByteArray>().also { it.close() }

        override val origin: String get() = this@DeviceConnection.origin
        override val consent: ConsentPresenter get() = host.consent

        private var presentingFlag = false
        override var presenting: Boolean
            get() = presentingFlag
            set(value) {
                if (value == presentingFlag) return
                presentingFlag = value
                if (value) presentingOps.incrementAndGet() else presentingOps.updateAndGet { maxOf(0, it - 1) }
            }

        override fun emit(event: Map<String, Any?>, coalesceKey: String?) {
            if (terminated || isClosed) return
            DevicePayloads.validate(request.capability, request.version, PayloadKind.EVENT, event)?.let {
                host.log.log("device: driver ${request.capability} emitted an invalid event: $it")
                terminate(this, DriverOutcome.Error(DeviceErrorCode.INTERNAL, "invalid-event"))
                return
            }
            dataSent = true
            if (!config.enforceCredit || (pending.isEmpty() && credit > 0)) {
                if (config.enforceCredit) credit -= 1
                send(DeviceWire.event(request.id, event))
                return
            }
            val key = if (coalesceKey != null) "k:$coalesceKey" else "a:${anonymous++}"
            pending.remove(key)
            pending[key] = event
            while (pending.size > config.maxPendingEvents) pending.remove(pending.keys.first())
        }

        fun flushEvents() {
            while (!terminated && credit > 0 && pending.isNotEmpty()) {
                val key = pending.keys.first()
                val event = pending.remove(key)!!
                credit -= 1
                send(DeviceWire.event(request.id, event))
            }
        }

        override fun progress(state: ProgressState) {
            if (terminated || isClosed) return
            if (state == ProgressState.PENDING_CONSENT && (progressRunning || dataSent)) {
                host.log.log("device: ignoring a pendingConsent progress after running/data (progress never goes back)")
                return
            }
            if (state == ProgressState.RUNNING) progressRunning = true
            send(DeviceWire.event(request.id, DeviceWire.progress(state)))
        }

        override fun grantDownload(bytes: Long): Long {
            val d = download ?: return 0
            if (terminated || isClosed || bytes <= 0) return 0
            // Never beyond the outstanding maximum (drivers also stop granting past the declaration).
            val amount = minOf(bytes, revision.maxOutstandingCredit - d.credit)
            if (amount <= 0) return 0
            d.credit += amount
            send(DeviceWire.control(request.id, Control.Grant(amount)))
            return amount
        }

        override fun nowMs(): Long = host.clock.monotonicMs()

        override fun tryAcquirePrompt(vararg cooldownKeys: String): PromptAdmit =
            host.gate.tryAcquire(origin, if (cooldownKeys.isEmpty()) listOf(request.capability) else cooldownKeys.toList())

        override fun recordDenial(key: String) = host.gate.coolDown(origin, key, config.denialCooldownMs)

        override fun recordDismissal(key: String) = host.gate.coolDown(origin, key, config.dismissalCooldownMs)

        private fun grantsForOrigin(): ConsentGrants = if (isAuthenticatedOrigin(origin)) host.grants else grants

        override fun hasConsent(capability: String): Boolean = grantsForOrigin().isGranted(origin, capability)

        override fun grantConsent(capability: String) = grantsForOrigin().grant(origin, capability, config.consentGrantMs)
    }
}

/**
 * `core.capabilities` revision 1: emit the full current advertisement, then
 * idle until cancelled. The single coalescing key keeps at most one unsent
 * (latest) snapshot when event credit is exhausted.
 */
internal class CoreCapabilitiesDriver(private val host: DeviceHost) : DeviceDriver {
    override val capability: String = DeviceHost.CORE_CAPABILITIES

    override fun validateParams(version: Long, params: Map<String, Any?>): String? = closedKeys(params, emptySet())

    override suspend fun run(ctx: DriverContext): DriverOutcome {
        ctx.emit(mapOf("capabilities" to host.snapshotOffers()), coalesceKey = SNAPSHOT_KEY)
        awaitCancellation()
    }

    companion object {
        const val SNAPSHOT_KEY = "snapshot"
    }
}
