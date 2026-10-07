@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import java.security.MessageDigest

/** Everything a connection sent, in order. */
sealed class Sent {
    data class Msg(val message: Map<String, Any?>) : Sent()

    class Frame(val bytes: ByteArray) : Sent() {
        val decoded: FrameDecode.Ok get() = DeviceFrames.decode(bytes) as FrameDecode.Ok
    }
}

class FakeTransport : DeviceTransport {
    val sent = mutableListOf<Sent>()
    var pending = 0L
    var closedWith: Int? = null
    var closeReason: String? = null

    val messages: List<Map<String, Any?>> get() = sent.filterIsInstance<Sent.Msg>().map { it.message }
    val frames: List<Sent.Frame> get() = sent.filterIsInstance<Sent.Frame>()

    fun responses(): List<Map<String, Any?>> = messages.filter { it["type"] == "deviceResponse" }

    fun errorCode(m: Map<String, Any?>): String? = (m["error"] as? Map<*, *>)?.get("code") as? String

    override fun sendMessage(message: Map<String, Any?>) {
        sent += Sent.Msg(message)
    }

    override fun sendBinary(frame: ByteArray) {
        sent += Sent.Frame(frame)
    }

    override fun pendingBytes(): Long = pending

    override fun close(code: Int, reason: String) {
        closedWith = code
        closeReason = reason
    }
}

class TestClock(private val scope: TestScope) : DeviceClock {
    var wallOffset = 1_700_000_000_000L

    override fun monotonicMs(): Long = scope.testScheduler.currentTime

    override fun wallMs(): Long = wallOffset + scope.testScheduler.currentTime
}

fun TestScope.newHost(
    drivers: List<DeviceDriver> = emptyList(),
    config: DeviceHostConfig = DeviceHostConfig(origin = "wss://app.example:443"),
    consent: ConsentPresenter = ConsentPresenter.HEADLESS,
    clock: TestClock = TestClock(this),
): DeviceHost {
    val dispatcher = StandardTestDispatcher(testScheduler)
    return DeviceHost(config, drivers, dispatcher, dispatcher, clock, InMemoryCooldownStore(), consent)
}

/** A sessionAck.device selecting every capability the host offers. */
fun ackFor(host: DeviceHost, binary: Boolean = true): Map<String, Any?> = mapOf(
    "protocolVersion" to 1,
    "binary" to binary,
    "capabilities" to host.offers().map { mapOf("name" to it["name"], "version" to 1) },
)

/** Open a connection and snapshot its hello advertisement (what RemoteEngine does on open). */
fun DeviceHost.openWithHello(transport: DeviceTransport = FakeTransport(), origin: String = config.origin): DeviceConnection {
    val c = openConnection(transport, origin)!!
    checkNotNull(c.helloAdvertisement()) { "no advertisement" }
    return c
}

val CONNECTION_OWNER = mapOf("connection" to true)

/** The connection-owned core.capabilities stream request (RFC 001 §2.2). */
fun coreRequest(id: Long, initialCredit: Long = 8): Map<String, Any?> =
    request(id, "core.capabilities", owner = CONNECTION_OWNER, lifetime = "connection", timeoutMs = 86_400_000, initialCredit = initialCredit)

/**
 * Open, hello, ack every offer, and (by default) open the mandatory
 * core.capabilities stream as request id 1 — app requests then use ids ≥ 2.
 * The transport's recorded traffic is cleared afterwards.
 */
fun TestScope.connect(
    host: DeviceHost,
    transport: FakeTransport = FakeTransport(),
    binary: Boolean = true,
    openCore: Boolean = true,
    origin: String = host.config.origin,
): Pair<DeviceConnection, FakeTransport> {
    val c = host.openWithHello(transport, origin)
    c.onAck(ackFor(host, binary))
    runCurrent()
    check(c.isEnabled) { "plane not enabled" }
    if (openCore) {
        c.handleMessage(coreRequest(1))
        runCurrent()
        transport.sent.clear()
    }
    return c to transport
}

val ACTIVATION_OWNER = mapOf("moduleInstanceId" to "profile-7", "activationId" to 3)

fun request(
    id: Long,
    capability: String,
    params: Map<String, Any?> = emptyMap(),
    timeoutMs: Long = 300_000,
    initialCredit: Long = 0,
    owner: Map<String, Any?> = ACTIVATION_OWNER,
    lifetime: String = "activation",
    version: Long = 1,
): Map<String, Any?> = mapOf(
    "type" to "deviceRequest",
    "id" to id,
    "capability" to capability,
    "version" to version,
    "owner" to owner,
    "lifetime" to lifetime,
    "timeoutMs" to timeoutMs,
    "initialCredit" to initialCredit,
    "params" to params,
)

fun control(id: Long, key: String, value: Any): Map<String, Any?> =
    mapOf("type" to "deviceEvent", "id" to id, "control" to mapOf(key to value))

val GALLERY_PARAMS = mapOf("mediaTypes" to listOf("photo"), "maxCount" to 1)

fun sha256Hex(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

/** A gallery platform whose picker stays open until the test completes [result]. */
class FakeGallery(var foreground: Boolean = true) : GalleryPlatform {
    var result = CompletableDeferred<List<PickedMedia>>()
    var picks = 0
    var cancelledPicks = 0

    override fun canPresent(): Boolean = foreground

    var presenterGone: (() -> Unit)? = null

    override suspend fun pick(request: GalleryPickRequest, maxItemBytes: Long, presenterGone: () -> Unit): List<PickedMedia> {
        picks += 1
        this.presenterGone = presenterGone
        try {
            return result.await()
        } catch (e: kotlinx.coroutines.CancellationException) {
            cancelledPicks += 1
            throw e
        }
    }
}

/**
 * [foreground] models a resumed Activity: without one, the rationale is
 * unknown (null) and nothing can be presented.
 */
class FakePermissions(override val sdkInt: Int = 34) : PermissionPlatform {
    val declared = mutableSetOf<String>()
    val granted = mutableSetOf<String>()
    val requested = mutableSetOf<String>()
    val denied = mutableSetOf<String>()
    var rationale = false
    var foreground = true
    var notifications = true
    var userGrants = false

    /** The dialog is dismissed without an answer (empty result map). */
    var dismisses = false

    /** Rationale reported after the next request (null: unchanged). */
    var rationaleAfterRequest: Boolean? = null
    var requests = 0
    var pendingRequest: CompletableDeferred<Unit>? = null

    fun declare(vararg p: String) = apply { declared += p.map { "android.permission.$it" } }

    override fun isDeclared(permission: String) = permission in declared

    override fun isGranted(permission: String) = permission in granted

    override fun wasRequested(permission: String) = permission in requested

    override fun markRequested(permissions: Collection<String>) {
        requested += permissions
    }

    override fun wasDenied(permission: String) = permission in denied && permission !in granted

    override fun recordResults(results: Map<String, Boolean>) {
        results.forEach { (p, ok) -> if (ok) denied -= p else denied += p }
    }

    override fun shouldShowRationale(permission: String): Boolean? = if (foreground) rationale else null

    override fun notificationsEnabled() = notifications

    override fun canPresent() = foreground

    override suspend fun request(permissions: List<String>, presenterGone: () -> Unit): Map<String, Boolean> {
        requests += 1
        pendingRequest?.await()
        rationaleAfterRequest?.let { rationale = it }
        if (dismisses) return emptyMap()
        if (userGrants) granted += permissions
        return permissions.associateWith { it in granted }
    }
}

class FakeBluetooth(var state: AdapterState = AdapterState.ON) : BluetoothPlatform {
    var listener: BluetoothScanListener? = null
    var stopped = 0
    var starts = 0
    var locationOn = true
    var neverForLocation = true

    /** BLE hardware present (the advertisement's hardware input). */
    var bleHardware = true

    override fun hasBle() = bleHardware

    override fun adapterState() = state

    override fun locationServicesEnabled() = locationOn

    override fun scanDisavowsLocation() = neverForLocation

    override fun startScan(listener: BluetoothScanListener): ScanHandle {
        starts += 1
        this.listener = listener
        return ScanHandle { stopped += 1 }
    }
}

/** A host indicator that records what is visible; [stopAll] is the user's Stop tap. */
class FakeIndicator(var ready: Boolean = true) : DeviceActivityIndicator {
    class Shown(val origin: String, val activity: String, val stop: (IndicatorStopReason) -> Unit) {
        var hidden = false
    }

    val shown = mutableListOf<Shown>()
    val visible: List<Shown> get() = shown.filterNot { it.hidden }

    override val isReady: Boolean get() = ready

    override fun show(origin: String, activity: String, stop: (IndicatorStopReason) -> Unit): IndicatorHandle? {
        if (!ready) return null
        val s = Shown(origin, activity, stop)
        shown += s
        return IndicatorHandle { s.hidden = true }
    }

    fun stopAll(reason: IndicatorStopReason = IndicatorStopReason.USER) = visible.forEach { it.stop(reason) }
}
