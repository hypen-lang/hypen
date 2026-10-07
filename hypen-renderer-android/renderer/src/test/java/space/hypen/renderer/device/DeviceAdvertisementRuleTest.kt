@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device

import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one advertisement rule (RFC 001 §2.2 "advertise only implementable
 * capabilities"): a capability is offered iff (1) the hardware exists, (2)
 * the manifest declares what the OS requires for it on this API level, and
 * (3) for `bluetooth.scan` / `mic.record` the host indicator is ready. Grants
 * and permission history never matter; a change of (1)–(3) while connected
 * sends a fresh `core.capabilities` snapshot.
 */
class DeviceAdvertisementRuleTest {
    private class Audio(var present: Boolean = true) : AudioCapturePlatform {
        override fun hasMicrophone() = present

        override fun start(format: AudioCaptureFormat, sink: AudioSink): CaptureHandle = CaptureHandle { }
    }

    private class Camera(var present: Boolean = true) : CameraPlatform {
        override fun hasCamera() = present

        override fun canPresent() = true

        override suspend fun capture(request: CameraCaptureRequest, maxItemBytes: Long, presenterGone: () -> Unit): CapturedMedia? = null
    }

    private val chooser = BluetoothChooser { _: String, _: StateFlow<List<BluetoothChooserEntry>> -> BluetoothChoice.Dismissed }

    /**
     * Declarations only: every grant / history / presentation query fails the
     * test, so an advertisement that consulted one could not pass.
     */
    private class DeclarationsOnly(override val sdkInt: Int, vararg declared: String) : PermissionPlatform {
        private val declared = declared.map { "android.permission.$it" }.toSet()

        override fun isDeclared(permission: String) = permission in declared

        override fun isGranted(permission: String): Boolean = throw AssertionError("advertisement consulted a grant ($permission)")

        override fun wasRequested(permission: String): Boolean = throw AssertionError("advertisement consulted request history")

        override fun markRequested(permissions: Collection<String>) = throw AssertionError("advertisement recorded history")

        override fun wasDenied(permission: String): Boolean = throw AssertionError("advertisement consulted denial history")

        override fun shouldShowRationale(permission: String): Boolean? = throw AssertionError("advertisement consulted the rationale")

        override fun notificationsEnabled(): Boolean = throw AssertionError("advertisement consulted notification state")

        override fun canPresent(): Boolean = throw AssertionError("advertisement consulted the foreground")

        override suspend fun request(permissions: List<String>, presenterGone: () -> Unit): Map<String, Boolean> =
            throw AssertionError("advertisement prompted")
    }

    private fun names(host: DeviceHost) = host.offers().map { it["name"] as String }

    private fun snapshots(t: FakeTransport): List<List<String>> =
        t.messages.mapNotNull { m -> ((m["event"] as? Map<*, *>)?.get("capabilities") as? List<*>)?.map { (it as Map<*, *>)["name"] as String } }

    // ---- mic.record ----------------------------------------------------------------------------

    @Test
    fun `mic record is advertised iff a microphone exists, RECORD_AUDIO is declared and the indicator is ready`() {
        for (hardware in listOf(true, false)) for (declared in listOf(true, false)) for (ready in listOf(true, false)) {
            val perms = if (declared) FakePermissions().declare("RECORD_AUDIO") else FakePermissions()
            val driver = MicRecordDriver(Audio(hardware), perms, FakeIndicator(ready))
            assertEquals("hardware=$hardware declared=$declared ready=$ready", hardware && declared && ready, driver.isAvailable())
        }
    }

    // ---- bluetooth.scan / bluetooth.select -----------------------------------------------------

    @Test
    fun `bluetooth scan is advertised iff BLE hardware, the declared scan permissions and a ready indicator`() {
        for (hardware in listOf(true, false)) for (declared in listOf(true, false)) for (ready in listOf(true, false)) {
            val perms = if (declared) FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN") else FakePermissions(sdkInt = 34)
            val driver = BluetoothScanDriver(FakeBluetooth().apply { bleHardware = hardware }, perms, FakeIndicator(ready))
            assertEquals("hardware=$hardware declared=$declared ready=$ready", hardware && declared && ready, driver.isAvailable())
        }
    }

    @Test
    fun `bluetooth select is advertised iff BLE hardware and the declared scan permissions, with no indicator involved`() {
        for (hardware in listOf(true, false)) for (declared in listOf(true, false)) {
            val perms = if (declared) FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN") else FakePermissions(sdkInt = 34)
            val driver = BluetoothSelectDriver(FakeBluetooth().apply { bleHardware = hardware }, perms, chooser)
            assertEquals("hardware=$hardware declared=$declared", hardware && declared, driver.isAvailable())
        }
    }

    @Test
    fun `the bluetooth declaration check follows the API level`() {
        data class Case(val sdk: Int, val neverForLocation: Boolean, val declared: List<String>, val offered: Boolean)
        val cases = listOf(
            // API 31+: BLUETOOTH_SCAN; with neverForLocation that is all.
            Case(34, true, listOf("BLUETOOTH_SCAN"), true),
            Case(31, true, listOf("BLUETOOTH_SCAN"), true),
            Case(34, true, emptyList(), false),
            Case(34, true, listOf("ACCESS_FINE_LOCATION"), false),
            // API 31+ without neverForLocation: also fine location.
            Case(34, false, listOf("BLUETOOTH_SCAN"), false),
            Case(34, false, listOf("ACCESS_FINE_LOCATION"), false),
            Case(34, false, listOf("BLUETOOTH_SCAN", "ACCESS_FINE_LOCATION"), true),
            // API 29..30: fine location (BLUETOOTH_SCAN does not exist there; neverForLocation is ignored).
            Case(30, true, listOf("BLUETOOTH_SCAN"), false),
            Case(30, true, listOf("ACCESS_FINE_LOCATION"), true),
            Case(30, true, listOf("ACCESS_COARSE_LOCATION"), false),
            Case(29, false, listOf("ACCESS_FINE_LOCATION"), true),
            // API ≤ 28: fine or coarse location.
            Case(28, true, listOf("ACCESS_COARSE_LOCATION"), true),
            Case(28, true, listOf("ACCESS_FINE_LOCATION"), true),
            Case(28, true, listOf("BLUETOOTH_SCAN"), false),
            Case(24, true, emptyList(), false),
        )
        for (c in cases) {
            val bt = FakeBluetooth().apply { neverForLocation = c.neverForLocation }
            val perms = FakePermissions(sdkInt = c.sdk).declare(*c.declared.toTypedArray())
            assertEquals("scan $c", c.offered, BluetoothScanDriver(bt, perms, FakeIndicator()).isAvailable())
            assertEquals("select $c", c.offered, BluetoothSelectDriver(bt, perms, chooser).isAvailable())
        }
    }

    // ---- camera.capture ------------------------------------------------------------------------

    @Test
    fun `camera capture is advertised on camera hardware alone, whatever the manifest declares`() {
        // The system capture UI records (photo and video with audio) under the capture
        // app's own permissions: nothing the OS requires is declared by this app.
        val manifests = listOf(emptyList(), listOf("CAMERA"), listOf("RECORD_AUDIO"), listOf("CAMERA", "RECORD_AUDIO"))
        for (hardware in listOf(true, false)) for (declared in manifests) {
            val driver = CameraCaptureDriver(Camera(hardware), DeclarationsOnly(34, *declared.toTypedArray()))
            assertEquals("hardware=$hardware declared=$declared", hardware, driver.isAvailable())
        }
    }

    // ---- grants never matter -------------------------------------------------------------------

    @Test
    fun `the advertisement never consults grants, request history, rationale or the foreground`() {
        val mic = MicRecordDriver(Audio(), DeclarationsOnly(34, "RECORD_AUDIO"), FakeIndicator())
        val scan = BluetoothScanDriver(FakeBluetooth(), DeclarationsOnly(34, "BLUETOOTH_SCAN"), FakeIndicator())
        val select = BluetoothSelectDriver(FakeBluetooth(), DeclarationsOnly(34, "BLUETOOTH_SCAN"), chooser)
        val camera = CameraCaptureDriver(Camera(), DeclarationsOnly(34, "CAMERA", "RECORD_AUDIO"))
        val query = PermissionQueryDriver(DeclarationsOnly(34))
        val request = PermissionRequestDriver(DeclarationsOnly(34))
        listOf(mic, scan, select, camera, query, request).forEach { assertTrue(it.capability, it.isAvailable()) }
        // Nor are undeclared ones decided by a (hypothetical) grant.
        assertFalse(MicRecordDriver(Audio(), DeclarationsOnly(34), FakeIndicator()).isAvailable())
        assertFalse(BluetoothScanDriver(FakeBluetooth(), DeclarationsOnly(34), FakeIndicator()).isAvailable())
    }

    @Test
    fun `never asked, granted, dismissed and permanently denied permissions advertise the same set`() = runTest {
        val scan = "android.permission.BLUETOOTH_SCAN"
        val mic = "android.permission.RECORD_AUDIO"
        fun perms(state: String) = FakePermissions(sdkInt = 34).declare("BLUETOOTH_SCAN", "RECORD_AUDIO").apply {
            when (state) {
                "never-asked" -> Unit
                "granted" -> granted += listOf(scan, mic)
                "dismissed" -> requested += listOf(scan, mic)
                "permanently-denied" -> {
                    requested += listOf(scan, mic)
                    denied += listOf(scan, mic)
                    rationale = false
                }
                "denied-once" -> {
                    requested += listOf(scan, mic)
                    denied += listOf(scan, mic)
                    rationale = true
                }
                "backgrounded" -> foreground = false
            }
        }
        val states = listOf("never-asked", "granted", "dismissed", "permanently-denied", "denied-once", "backgrounded")
        val offered = states.map { state ->
            val p = perms(state)
            val host = newHost(
                listOf(
                    MicRecordDriver(Audio(), p, FakeIndicator()),
                    BluetoothScanDriver(FakeBluetooth(), p, FakeIndicator()),
                    BluetoothSelectDriver(FakeBluetooth(), p, chooser),
                    PermissionQueryDriver(p),
                    PermissionRequestDriver(p),
                ),
            )
            names(host).also { host.dispose() }
        }
        val expected = listOf("core.capabilities", "mic.record", "bluetooth.scan", "bluetooth.select", "permission.query", "permission.request")
        states.zip(offered).forEach { (state, got) -> assertEquals(state, expected, got) }
    }

    // ---- permission.* --------------------------------------------------------------------------

    @Test
    fun `permission query and request stay advertised with an empty manifest and answer not-declared per name`() = runTest {
        val perms = FakePermissions(sdkInt = 34)
        val host = newHost(listOf(PermissionQueryDriver(perms), PermissionRequestDriver(perms)))
        assertEquals(listOf("core.capabilities", "permission.query", "permission.request"), names(host))
        val (c, t) = connect(host)
        var id = 2L
        for (capability in listOf("permission.query", "permission.request")) {
            for (name in listOf("microphone", "bluetooth", "camera", "location")) {
                c.handleMessage(request(id, capability, mapOf("permission" to name), timeoutMs = 30_000))
                runCurrent()
                assertEquals("$capability $name", DeviceWire.error(id, DeviceErrorCode.UNAVAILABLE, "not-declared:$name"), t.responses().last())
                id += 1
            }
        }
        assertEquals(0, perms.requests)
        host.dispose()
    }

    @Test
    fun `the declaration check resolves portable names per API level`() {
        // Notifications have no runtime permission below API 33: nothing to declare.
        assertTrue(CapabilityAdvertisement.declares("notifications", DeclarationsOnly(32)))
        assertFalse(CapabilityAdvertisement.declares("notifications", DeclarationsOnly(33)))
        assertTrue(CapabilityAdvertisement.declares("notifications", DeclarationsOnly(33, "POST_NOTIFICATIONS")))
        // Any-of groups: coarse location alone is a usable location declaration.
        assertTrue(CapabilityAdvertisement.declares("location", DeclarationsOnly(34, "ACCESS_COARSE_LOCATION")))
        assertTrue(CapabilityAdvertisement.declares("microphone", DeclarationsOnly(34, "RECORD_AUDIO")))
        assertFalse(CapabilityAdvertisement.declares("microphone", DeclarationsOnly(34, "CAMERA")))
        assertTrue(CapabilityAdvertisement.declares("bluetooth", DeclarationsOnly(31, "BLUETOOTH_SCAN")))
        assertFalse(CapabilityAdvertisement.declares("bluetooth", DeclarationsOnly(30, "BLUETOOTH_SCAN")))
        assertFalse(CapabilityAdvertisement.declares("geolocation", DeclarationsOnly(34, "ACCESS_FINE_LOCATION")))
    }

    // ---- re-advertisement ----------------------------------------------------------------------

    @Test
    fun `a readiness change re-advertises once, and an unchanged or grant-only change sends nothing`() = runTest {
        val indicator = FakeIndicator(ready = false)
        val perms = FakePermissions(sdkInt = 34).declare("RECORD_AUDIO", "BLUETOOTH_SCAN")
        val host = newHost(
            listOf(
                MicRecordDriver(Audio(), perms, indicator),
                BluetoothScanDriver(FakeBluetooth(), perms, indicator),
                BluetoothSelectDriver(FakeBluetooth(), perms, chooser),
            ),
        )
        val (c, t) = connect(host, openCore = false)
        c.handleMessage(coreRequest(1, initialCredit = 64))
        runCurrent()
        assertEquals(listOf(listOf("core.capabilities", "bluetooth.select")), snapshots(t))

        // Nothing changed: no snapshot.
        assertFalse(host.recheckCapabilities())
        runCurrent()
        assertEquals(1, snapshots(t).size)

        // The indicator became ready (overlay shown / foreground gained).
        indicator.ready = true
        assertTrue(host.recheckCapabilities())
        runCurrent()
        assertEquals(listOf("core.capabilities", "mic.record", "bluetooth.scan", "bluetooth.select"), snapshots(t).last())
        assertFalse(host.recheckCapabilities())

        // A grant (or a refusal) is not an advertisement input.
        perms.granted += listOf("android.permission.RECORD_AUDIO", "android.permission.BLUETOOTH_SCAN")
        assertFalse(host.recheckCapabilities())
        perms.denied += "android.permission.RECORD_AUDIO"
        perms.requested += "android.permission.RECORD_AUDIO"
        assertFalse(host.recheckCapabilities())
        runCurrent()
        assertEquals(2, snapshots(t).size)

        // The indicator went away (overlay hidden / foreground lost).
        indicator.ready = false
        assertTrue(host.recheckCapabilities())
        runCurrent()
        assertEquals(listOf("core.capabilities", "bluetooth.select"), snapshots(t).last())
        assertEquals(3, snapshots(t).size)
        host.dispose()
    }

    @Test
    fun `hardware appearing or disappearing re-advertises on recheck`() = runTest {
        val bt = FakeBluetooth()
        val audio = Audio()
        val perms = FakePermissions(sdkInt = 34).declare("RECORD_AUDIO", "BLUETOOTH_SCAN")
        val host = newHost(listOf(MicRecordDriver(audio, perms, FakeIndicator()), BluetoothSelectDriver(bt, perms, chooser)))
        val (c, t) = connect(host, openCore = false)
        c.handleMessage(coreRequest(1, initialCredit = 64))
        runCurrent()
        bt.bleHardware = false
        assertTrue(host.recheckCapabilities())
        runCurrent()
        assertEquals(listOf("core.capabilities", "mic.record"), snapshots(t).last())
        audio.present = false
        bt.bleHardware = true
        assertTrue(host.recheckCapabilities())
        runCurrent()
        assertEquals(listOf("core.capabilities", "bluetooth.select"), snapshots(t).last())
        assertEquals(3, snapshots(t).size)
        host.dispose()
    }

    @Test
    fun `every live stream on every connection gets the fresh snapshot`() = runTest {
        val indicator = FakeIndicator(ready = false)
        val perms = FakePermissions(sdkInt = 34).declare("RECORD_AUDIO")
        val host = newHost(listOf(MicRecordDriver(Audio(), perms, indicator)))
        val (c1, t1) = connect(host, openCore = false)
        val (c2, t2) = connect(host, openCore = false)
        c1.handleMessage(coreRequest(1, initialCredit = 64))
        c2.handleMessage(coreRequest(1, initialCredit = 64))
        runCurrent()
        indicator.ready = true
        assertTrue(host.recheckCapabilities())
        runCurrent()
        for (t in listOf(t1, t2)) assertEquals(listOf(listOf("core.capabilities"), listOf("core.capabilities", "mic.record")), snapshots(t))
        host.dispose()
        assertFalse(host.recheckCapabilities())
    }
}
