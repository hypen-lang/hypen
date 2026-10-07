@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression tests for the Android DeviceHost review findings (RFC 001 §2 /
 * §5): owner/ids bounds, known-id violations, revision deadline bounds,
 * inbox and frame memory bounds, malformed-JSON routing, code-point string
 * bounds, control ranges, `sessionAck.device` validation, permission status
 * without a foreground Activity, BLE preconditions, consent dismissal and the
 * bluetooth.scan indicator.
 */
class DeviceHostHardeningTest {
    private val smile = "😀" // one code point, two UTF-16 units

    // ---- #4 owner / ids ----------------------------------------------------------------

    @Test
    fun `activationId must be 1 to u32 max and moduleInstanceId and capability non-empty`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS, owner = mapOf("moduleInstanceId" to "m", "activationId" to 0)))
        c.handleMessage(request(3, "gallery.pick", GALLERY_PARAMS, owner = mapOf("moduleInstanceId" to "", "activationId" to 1)))
        c.handleMessage(request(4, "", GALLERY_PARAMS))
        c.handleMessage(request(5, "gallery.pick", GALLERY_PARAMS, owner = mapOf("moduleInstanceId" to "m", "activationId" to 4_294_967_296L)))
        c.handleMessage(request(6, "gallery.pick", GALLERY_PARAMS, owner = mapOf("moduleInstanceId" to "m"), lifetime = "background"))
        runCurrent()
        assertEquals(listOf(2L, 3L, 4L, 5L, 6L), t.responses().map { it["id"] })
        assertTrue(t.responses().all { t.errorCode(it) == "invalidParams" })
        assertEquals(0, gallery.picks)
        // Upper bounds are inclusive and counted in code points.
        c.handleMessage(
            request(7, "gallery.pick", GALLERY_PARAMS, owner = mapOf("moduleInstanceId" to smile.repeat(256), "activationId" to 4_294_967_295L)),
        )
        runCurrent()
        assertEquals(1, gallery.picks)
        host.dispose()
    }

    // ---- #5 known-id violations (lead decision: terminate) --------------------------------

    @Test
    fun `server event on a known id and grant without a data plane terminate invalidParams`() = runTest {
        val perms = FakePermissions().declare("CAMERA").apply { pendingRequest = CompletableDeferred() }
        val host = newHost(listOf(PermissionRequestDriver(perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        c.handleMessage(mapOf("type" to "deviceEvent", "id" to 99L, "event" to mapOf("kind" to "progress"))) // unknown id: ignored
        c.handleMessage(control(2, "grant", 5))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.INVALID_PARAMS, "grant on a capability without client → server data"), t.responses().single())
        c.handleMessage(mapOf("type" to "deviceEvent", "id" to 1L, "event" to mapOf("kind" to "progress", "state" to "running")))
        runCurrent()
        assertEquals(DeviceWire.error(1, DeviceErrorCode.INVALID_PARAMS, "unexpected server → client event"), t.responses().last())
        assertEquals(2, t.responses().size)
        host.dispose()
    }

    // ---- #6 deadline against the revision ---------------------------------------------------

    @Test
    fun `timeoutMs above the revision maximum is invalidParams, the maximum itself is admitted`() = runTest {
        val perms = FakePermissions().declare("CAMERA").apply { pendingRequest = CompletableDeferred() }
        val host = newHost(listOf(PermissionRequestDriver(perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.request", mapOf("permission" to "camera"), timeoutMs = 300_001))
        c.handleMessage(request(3, "core.capabilities", owner = mapOf("connection" to true), lifetime = "connection", timeoutMs = 86_400_001))
        c.handleMessage(request(4, "permission.request", mapOf("permission" to "camera"), timeoutMs = 300_000))
        runCurrent()
        assertEquals(
            listOf(
                DeviceWire.error(2, DeviceErrorCode.INVALID_PARAMS, "timeoutMs above 300000"),
                DeviceWire.error(3, DeviceErrorCode.INVALID_PARAMS, "timeoutMs must be an integer in 1..86400000"),
            ),
            t.responses(),
        )
        assertEquals(1, perms.requests)
        host.dispose()
    }

    // ---- #9 inbox and frame bounds ----------------------------------------------------------

    @Test
    fun `a briefly busy host dispatcher does not close the socket`() = runTest {
        val host = newHost()
        val (c, t) = connect(host)
        // 1100 messages queued while the dispatcher (the main thread) is busy.
        repeat(1100) { c.handleMessage(control(1000L + it, "renewLease", 1)) }
        assertNull(t.closedWith)
        runCurrent()
        assertFalse(c.isClosed)
        assertTrue(t.sent.isEmpty()) // unknown ids: ignored
        host.dispose()
    }

    @Test
    fun `exceeding the inbox message or byte bound closes 1008`() = runTest {
        val byCount = newHost(config = DeviceHostConfig(origin = "wss://a:443", inboxCapacity = 10))
        val (c1, t1) = connect(byCount)
        repeat(10) { c1.handleMessage(control(5, "renewLease", 1)) }
        assertNull(t1.closedWith)
        c1.handleMessage(control(5, "renewLease", 1))
        assertEquals(1008, t1.closedWith)
        assertTrue(c1.isClosed)

        val byBytes = newHost(config = DeviceHostConfig(origin = "wss://a:443", inboxMaxBytes = 10_000))
        val (c2, t2) = connect(byBytes)
        c2.handleMessage(control(5, "renewLease", 1), sizeBytes = 6_000)
        assertNull(t2.closedWith)
        c2.handleMessage(control(5, "renewLease", 1), sizeBytes = 6_000)
        assertEquals(1008, t2.closedWith)
        byCount.dispose()
        byBytes.dispose()
    }

    @Test
    fun `server frames are copied only up to the header without a download plane`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)), config = DeviceHostConfig(origin = "wss://a:443", maxViolations = 1))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        val reads = mutableListOf<Pair<Int, Int>>()
        fun frame(id: Long, size: Int) {
            val header = DeviceFrames.encode(FrameHeader(channel = 0, requestId = id, seq = 0))
            c.handleFrame(size) { start, end ->
                reads += start to end
                ByteArray(end - start) { header.getOrElse(start + it) { 0 } }
            }
        }
        frame(77, DeviceProtocol.MAX_FRAME_BYTES) // unknown id, largest legal frame: header only, dropped
        frame(77, 40_000) // unknown id: header only, dropped
        runCurrent()
        assertEquals(listOf(0 to 12, 0 to 12), reads)
        assertTrue(t.sent.isEmpty())
        assertNull(t.closedWith)
        frame(2, 40_000) // known id: terminates from the header alone
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.INVALID_PARAMS, "unexpected frame on channel 0"), t.responses().single())
        assertEquals(1, gallery.cancelledPicks)
        frame(2, 5) // short: dropped
        runCurrent()
        assertNull(t.closedWith)
        assertEquals(listOf(0 to 12, 0 to 12, 0 to 12, 0 to 5), reads)
        host.dispose()
    }

    @Test
    fun `oversize frames terminate a known id and unknown ids are ignored`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())), config = DeviceHostConfig(origin = "wss://a:443", maxViolations = 1))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        val over = DeviceProtocol.MAX_FRAME_BYTES + 1
        fun header(id: Long) = DeviceFrames.encode(FrameHeader(channel = 0, requestId = id, seq = 0))
        c.handleFrame(over) { s, e -> header(2).copyOfRange(s, e) }
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.INVALID_PARAMS, "frame of 65549 bytes exceeds 65548"), t.responses().single())
        assertNull(t.closedWith)
        // Liveness first (§2.1): a frame for an unknown id is ignored, whatever its size.
        c.handleFrame(over) { s, e -> header(9).copyOfRange(s, e) }
        runCurrent()
        assertNull(t.closedWith)
        assertEquals(1, t.responses().size)
        host.dispose()
    }

    // ---- #10 / D3 / D8 malformed JSON is connection-level ------------------------------------

    @Test
    fun `JSON-limit breakers are connection-level - no id consumed, no request terminated, closed when repeated`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)), config = DeviceHostConfig(origin = "wss://a:443", maxViolations = 3))
        val (c, t) = connect(host)
        c.handleMalformed("deviceRequest", "JSON limits: duplicate key 'maxCount'")
        c.handleMessage(request(5, "gallery.pick", GALLERY_PARAMS)) // the id was not consumed
        runCurrent()
        assertTrue(t.responses().isEmpty())
        assertEquals(1, gallery.picks)
        c.handleMalformed("deviceEvent", "JSON limits: duplicate key 'grant'") // names live id 5: still live
        runCurrent()
        assertTrue(t.responses().isEmpty())
        assertEquals(0, gallery.cancelledPicks)
        assertNull(t.closedWith)
        c.handleMalformed("deviceEvent", "JSON limits: nesting deeper than 32")
        runCurrent()
        assertEquals(1002, t.closedWith) // the third violation
        host.dispose()
    }

    // ---- #12 code points --------------------------------------------------------------------

    @Test
    fun `string bounds count code points and truncation never splits a surrogate pair`() {
        assertEquals(2, smile.length)
        assertEquals(1, smile.codePointLength())
        assertEquals("a".repeat(3) + smile, ("a".repeat(3) + smile + smile).truncateCodePoints(4))

        val coalescer = BluetoothEventCoalescer()
        val longId = "a".repeat(127) + smile + smile
        val longName = "n".repeat(255) + smile + smile
        val device = coalescer.offer(longId, longName, -40, 0)!!["device"] as Map<*, *>
        val id = device["id"] as String
        val name = device["name"] as String
        assertEquals("a".repeat(127) + smile, id)
        assertEquals(128, id.codePointLength())
        assertEquals("n".repeat(255) + smile, name)
        assertFalse(Character.isHighSurrogate(id.last()) || Character.isHighSurrogate(name.last()))

        val detail = (DeviceWire.error(1, DeviceErrorCode.INTERNAL, smile.repeat(600))["error"] as Map<*, *>)["platformDetail"] as String
        assertEquals(512, detail.codePointLength())
        assertEquals(1024, detail.length)

        assertTrue(DeviceWire.parseRequest(request(1, smile.repeat(128))) is Parsed.Ok)
        assertTrue(DeviceWire.parseRequest(request(1, smile.repeat(129))) is Parsed.Invalid)
        // P1: the permission is a closed enum now; no free-form (bounded) name passes.
        assertTrue(PermissionLogic.validate(mapOf("permission" to smile.repeat(64))) != null)
        assertTrue(PermissionLogic.validate(mapOf("permission" to smile.repeat(65))) != null)
        assertNull(PermissionLogic.validate(mapOf("permission" to "camera")))
    }

    // ---- #15 control ranges ------------------------------------------------------------------

    @Test
    fun `control values are bounded - grant by the schema cap, lease sequences by u32`() {
        fun ctl(k: String, v: Any) = DeviceWire.parseControl(mapOf(k to v))
        assertEquals(Parsed.Ok(Control.Grant(8_388_608)), ctl("grant", 8_388_608L))
        assertTrue(ctl("grant", 8_388_609L) is Parsed.Invalid)
        assertTrue(ctl("grant", 4_294_967_296L) is Parsed.Invalid)
        assertEquals(Parsed.Ok(Control.RenewLease(4_294_967_295)), ctl("renewLease", 4_294_967_295L))
        assertTrue(ctl("renewLease", 4_294_967_296L) is Parsed.Invalid)
        assertTrue(ctl("leaseAck", 4_294_967_296L) is Parsed.Invalid)
        // Non-integral tokens (Double in the tree) are never integers.
        assertTrue(ctl("grant", 1.0) is Parsed.Invalid)
        assertTrue(ctl("renewLease", -0.0) is Parsed.Invalid)
        assertTrue(DeviceWire.parseRequest(request(1, "gallery.pick") + ("initialCredit" to 4_194_305L)) is Parsed.Invalid)
    }

    // ---- #16 sessionAck.device ---------------------------------------------------------------

    @Test
    fun `ack with duplicate names or out of range versions disables the plane`() = runTest {
        val host = newHost(listOf(GalleryPickDriver(FakeGallery())))
        val core = mapOf("name" to "core.capabilities", "version" to 1)
        val acks = listOf(
            mapOf("protocolVersion" to 1, "binary" to true, "capabilities" to listOf(core, core)),
            mapOf("protocolVersion" to 1, "binary" to true, "capabilities" to listOf(core, mapOf("name" to "gallery.pick", "version" to 1), mapOf("name" to "gallery.pick", "version" to 1))),
            mapOf("protocolVersion" to 0, "binary" to true, "capabilities" to listOf(core)),
            mapOf("protocolVersion" to 1, "binary" to true, "capabilities" to listOf(core, mapOf("name" to "gallery.pick", "version" to 4_294_967_296L))),
            mapOf("protocolVersion" to 1, "binary" to true, "capabilities" to listOf(core, mapOf("name" to "gallery.pick", "version" to 0))),
            mapOf("protocolVersion" to 1, "binary" to true, "capabilities" to listOf(mapOf("name" to "core.capabilities", "version" to 1.0))),
        )
        for (ack in acks) {
            val c = host.openWithHello()
            c.onAck(ack)
            runCurrent()
            assertFalse(ack.toString(), c.isEnabled)
        }
        val malformed = host.openWithHello()
        malformed.onAck(null, "duplicate key 'binary'")
        runCurrent()
        assertFalse(malformed.isEnabled)
        host.dispose()
    }

    @Test
    fun `binary revisions are dropped from a non-binary selection, the plane still enables`() = runTest {
        val gallery = FakeGallery()
        val host = newHost(listOf(GalleryPickDriver(gallery)))
        val t = FakeTransport()
        val c = host.openWithHello(t)
        c.onAck(
            mapOf(
                "protocolVersion" to 1,
                "binary" to false,
                "capabilities" to listOf(mapOf("name" to "core.capabilities", "version" to 1), mapOf("name" to "gallery.pick", "version" to 1)),
            ),
        )
        runCurrent()
        assertTrue(c.isEnabled)
        assertEquals(mapOf("core.capabilities" to 1L), c.selection!!.capabilities)
        c.handleMessage(coreRequest(1))
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        assertEquals("unsupported", t.errorCode(t.responses().single()))
        assertEquals(0, gallery.picks)
        host.dispose()
    }

    // ---- #17 permission status without a foreground Activity --------------------------------

    @Test
    fun `an unknown rationale without a foreground activity is prompt, never denied`() = runTest {
        val perms = FakePermissions().declare("CAMERA").apply {
            foreground = false
            requested += "android.permission.CAMERA"
        }
        val host = newHost(listOf(PermissionQueryDriver(perms), PermissionRequestDriver(perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "permission.query", mapOf("permission" to "camera"), timeoutMs = 30_000))
        c.handleMessage(request(3, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        assertEquals(
            listOf(
                DeviceWire.result(2, mapOf("status" to "prompt")),
                DeviceWire.error(3, DeviceErrorCode.UNAVAILABLE, "no-foreground-activity"),
            ),
            t.responses(),
        )
        // With an Activity, a definite "no rationale" and an explicit OS denial on record: denied.
        perms.foreground = true
        perms.denied += "android.permission.CAMERA"
        c.handleMessage(request(4, "permission.query", mapOf("permission" to "camera"), timeoutMs = 30_000))
        runCurrent()
        assertEquals(DeviceWire.result(4, mapOf("status" to "denied")), t.responses().last())
        host.dispose()
    }

    // ---- #7 prompts torn down with their Activity release the gate ---------------------------

    @Test
    fun `a picker or OS dialog lost with its activity settles cancelled and releases the gate`() = runTest {
        val gallery = object : GalleryPlatform {
            var calls = 0
            override fun canPresent() = true

            override suspend fun pick(request: GalleryPickRequest, maxItemBytes: Long, presenterGone: () -> Unit): List<PickedMedia> {
                calls += 1
                throw DeviceDriverException(DeviceErrorCode.CANCELLED, "activity-destroyed")
            }
        }
        val perms = object : PermissionPlatform by FakePermissions().declare("CAMERA") {
            override suspend fun request(permissions: List<String>, presenterGone: () -> Unit): Map<String, Boolean> =
                throw DeviceDriverException(DeviceErrorCode.CANCELLED, "activity-destroyed")
        }
        val host = newHost(listOf(GalleryPickDriver(gallery), PermissionRequestDriver(perms)))
        val (c, t) = connect(host)
        c.handleMessage(request(2, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        c.handleMessage(request(3, "permission.request", mapOf("permission" to "camera")))
        runCurrent()
        c.handleMessage(request(4, "gallery.pick", GALLERY_PARAMS))
        runCurrent()
        assertEquals(
            listOf(
                DeviceWire.error(2, DeviceErrorCode.CANCELLED, "activity-destroyed"),
                DeviceWire.error(3, DeviceErrorCode.CANCELLED, "activity-destroyed"),
                DeviceWire.error(4, DeviceErrorCode.CANCELLED, "activity-destroyed"),
            ),
            t.responses(),
        )
        assertEquals(2, gallery.calls) // never throttled: the gate was released each time
        assertFalse(host.gate.isPromptActive)
        host.dispose()
    }

    // ---- #18 BLE preconditions ------------------------------------------------------------------

    @Test
    fun `bluetooth needs location services on API 30 and below`() = runTest {
        val bt = FakeBluetooth().apply { locationOn = false }
        val perms = FakePermissions(sdkInt = 30).declare("ACCESS_FINE_LOCATION").apply { granted += "android.permission.ACCESS_FINE_LOCATION" }
        var prompts = 0
        val host = newHost(listOf(BluetoothScanDriver(bt, perms, FakeIndicator())), consent = { prompts += 1; ConsentDecision.CONTINUE })
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "location-services-off"), t.responses().single())
        assertEquals(0, prompts)
        assertEquals(0, bt.starts)
        bt.locationOn = true
        c.handleMessage(request(3, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(1, bt.starts)
        host.dispose()
    }

    @Test
    fun `bluetooth on API 31+ without neverForLocation also needs fine location and location services`() = runTest {
        val bt = FakeBluetooth().apply { neverForLocation = false }
        val scanOnly = FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN").apply { granted += "android.permission.BLUETOOTH_SCAN" }
        val host = newHost(listOf(BluetoothScanDriver(bt, scanOnly, FakeIndicator())), consent = { ConsentDecision.CONTINUE })
        // Fine location undeclared (and granted scan does not matter): not advertised at all.
        assertEquals(listOf("core.capabilities"), host.offers().map { it["name"] })
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(DeviceErrorCode.UNSUPPORTED.wireName, t.errorCode(t.responses().single()))
        assertEquals(0, bt.starts)

        val both = FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN", "ACCESS_FINE_LOCATION").apply {
            granted += listOf("android.permission.BLUETOOTH_SCAN", "android.permission.ACCESS_FINE_LOCATION")
        }
        bt.locationOn = false
        val host2 = newHost(listOf(BluetoothScanDriver(bt, both, FakeIndicator())), consent = { ConsentDecision.CONTINUE })
        val (c2, t2) = connect(host2)
        c2.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "location-services-off"), t2.responses().single())
        bt.locationOn = true
        c2.handleMessage(request(3, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(1, bt.starts)

        // neverForLocation: BLUETOOTH_SCAN alone, Location Services irrelevant.
        val disavowing = FakeBluetooth().apply { locationOn = false }
        val host3 = newHost(listOf(BluetoothScanDriver(disavowing, scanOnly, FakeIndicator())), consent = { ConsentDecision.CONTINUE })
        val (c3, _) = connect(host3)
        c3.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(1, disavowing.starts)
        listOf(host, host2, host3).forEach { it.dispose() }
    }

    // ---- #20 consent dismissal ----------------------------------------------------------------

    @Test
    fun `dismissing the consent prompt is cancelled without a cooldown`() = runTest {
        val bt = FakeBluetooth()
        val perms = FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN").apply { granted += "android.permission.BLUETOOTH_SCAN" }
        var prompts = 0
        val host = newHost(listOf(BluetoothScanDriver(bt, perms, FakeIndicator())), consent = { prompts += 1; ConsentDecision.DISMISSED })
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        c.handleMessage(request(3, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(
            listOf(
                DeviceWire.error(2, DeviceErrorCode.CANCELLED, "consent-dismissed"),
                DeviceWire.error(3, DeviceErrorCode.CANCELLED, "consent-dismissed"),
            ),
            t.responses(),
        )
        assertEquals(2, prompts) // no cooldown after an abandonment
        assertEquals(0, bt.starts)
        host.dispose()
    }

    @Test
    fun `ws origins are development mode in the consent prompt`() {
        assertTrue(ConsentPrompt("ws://10.0.2.2:3000", "bluetooth.scan", "scan").developmentMode)
        assertFalse(ConsentPrompt("wss://app.example:443", "bluetooth.scan", "scan").developmentMode)
    }

    // ---- #8 bluetooth.scan indicator ------------------------------------------------------------

    @Test
    fun `the scan indicator is visible for the whole scan and Stop ends it cancelled`() = runTest {
        val bt = FakeBluetooth()
        val indicator = FakeIndicator()
        val perms = FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN").apply { granted += "android.permission.BLUETOOTH_SCAN" }
        val host = newHost(listOf(BluetoothScanDriver(bt, perms, indicator)), consent = { ConsentDecision.CONTINUE })
        val (c, t) = connect(host)
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(1, bt.starts)
        val shown = indicator.visible.single()
        assertEquals("wss://app.example:443", shown.origin)
        assertEquals(BluetoothScanDriver.SCAN_ACTIVITY, shown.activity)
        indicator.stopAll()
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.CANCELLED, "user-stopped"), t.responses().single())
        assertEquals(1, bt.stopped)
        assertTrue(indicator.visible.isEmpty())

        // A server cancel also removes it.
        c.handleMessage(request(3, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(1, indicator.visible.size)
        c.handleMessage(control(3, "cancel", true))
        runCurrent()
        assertTrue(indicator.visible.isEmpty())
        assertEquals(2, bt.stopped)
        host.dispose()
    }

    @Test
    fun `bluetooth scan is advertised only while its indicator is ready, and never runs invisibly`() = runTest {
        val indicator = FakeIndicator(ready = false)
        val bt = FakeBluetooth()
        val perms = FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN").apply { granted += "android.permission.BLUETOOTH_SCAN" }
        val host = newHost(listOf(BluetoothScanDriver(bt, perms, indicator)), consent = { ConsentDecision.CONTINUE })
        assertEquals(listOf("core.capabilities"), host.offers().map { it["name"] })
        indicator.ready = true
        assertEquals(listOf("core.capabilities", "bluetooth.scan"), host.offers().map { it["name"] })

        // Advertised, but the overlay went away before the request: unsupported, nothing scans.
        val (c, t) = connect(host)
        indicator.ready = false
        c.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals("unsupported", t.errorCode(t.responses().single()))
        assertEquals(0, bt.starts)

        // Ready, but show() fails at scan time: unavailable, nothing scans.
        val refusing = object : DeviceActivityIndicator {
            override fun show(origin: String, activity: String, stop: (IndicatorStopReason) -> Unit): IndicatorHandle? = null
        }
        val host2 = newHost(listOf(BluetoothScanDriver(bt, perms, refusing)), consent = { ConsentDecision.CONTINUE })
        val (c2, t2) = connect(host2)
        c2.handleMessage(request(2, "bluetooth.scan", initialCredit = 64))
        runCurrent()
        assertEquals(DeviceWire.error(2, DeviceErrorCode.UNAVAILABLE, "no-activity-indicator"), t2.responses().single())
        assertEquals(0, bt.starts)
        host.dispose()
        host2.dispose()
    }

    @Test
    fun `a capability change re-emits the core capabilities snapshot`() = runTest {
        val indicator = FakeIndicator(ready = false)
        val perms = FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN")
        val host = newHost(listOf(BluetoothScanDriver(FakeBluetooth(), perms, indicator)))
        val (c, t) = connect(host, openCore = false)
        c.handleMessage(coreRequest(1))
        runCurrent()
        indicator.ready = true
        host.capabilitiesChanged()
        runCurrent()
        val snapshots = t.messages.map { ((it["event"] as Map<*, *>)["capabilities"] as List<*>).map { c -> (c as Map<*, *>)["name"] } }
        assertEquals(listOf(listOf("core.capabilities"), listOf("core.capabilities", "bluetooth.scan")), snapshots)
        host.dispose()
    }

    @Test
    fun `dispose is idempotent`() = runTest {
        var disposed = 0
        val dispatcher = kotlinx.coroutines.test.StandardTestDispatcher(testScheduler)
        val host = DeviceHost(DeviceHostConfig("wss://a:443"), emptyList(), dispatcher, onDispose = { disposed += 1 })
        host.dispose()
        host.dispose()
        assertEquals(1, disposed)
        assertTrue(host.isDisposed)
    }
}
