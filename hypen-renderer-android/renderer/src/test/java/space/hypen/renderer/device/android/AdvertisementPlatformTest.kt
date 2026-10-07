@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device.android

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.device.AudioCaptureFormat
import space.hypen.renderer.device.AudioCapturePlatform
import space.hypen.renderer.device.AudioSink
import space.hypen.renderer.device.BluetoothScanDriver
import space.hypen.renderer.device.CaptureHandle
import space.hypen.renderer.device.CapabilityAdvertisement
import space.hypen.renderer.device.FakeBluetooth
import space.hypen.renderer.device.FakeIndicator
import space.hypen.renderer.device.FakePermissions
import space.hypen.renderer.device.FakeTransport
import space.hypen.renderer.device.MicRecordDriver
import space.hypen.renderer.device.connect
import space.hypen.renderer.device.coreRequest
import space.hypen.renderer.device.newHost

/**
 * The Android inputs of the advertisement rule: the manifest declarations read
 * through [PackageManager] ([ManifestPermissions]) and the triggers that send
 * a fresh `core.capabilities` snapshot when indicator readiness or the
 * foreground changes ([AndroidDeviceHost.bindAdvertisementTriggers]).
 */
class AdvertisementPlatformTest {
    private companion object {
        const val SCAN = "android.permission.BLUETOOTH_SCAN"
        const val FINE = "android.permission.ACCESS_FINE_LOCATION"
        const val AUDIO = "android.permission.RECORD_AUDIO"
    }

    private class Audio : AudioCapturePlatform {
        override fun hasMicrophone() = true

        override fun start(format: AudioCaptureFormat, sink: AudioSink): CaptureHandle = CaptureHandle { }
    }

    /** A Context whose PackageManager reports [requested] (with [flags]) for its own package. */
    private fun context(requested: Array<String>?, flags: IntArray? = null, failure: Exception? = null): Context {
        val pm = mockk<PackageManager>()
        if (failure != null) {
            @Suppress("DEPRECATION")
            every { pm.getPackageInfo("app.test", PackageManager.GET_PERMISSIONS) } throws failure
        } else {
            val info = PackageInfo().apply {
                requestedPermissions = requested
                requestedPermissionsFlags = flags
            }
            @Suppress("DEPRECATION")
            every { pm.getPackageInfo("app.test", PackageManager.GET_PERMISSIONS) } returns info
        }
        val ctx = mockk<Context>()
        every { ctx.packageManager } returns pm
        every { ctx.packageName } returns "app.test"
        return ctx
    }

    private fun snapshots(t: FakeTransport): List<List<String>> =
        t.messages.mapNotNull { m -> ((m["event"] as? Map<*, *>)?.get("capabilities") as? List<*>)?.map { (it as Map<*, *>)["name"] as String } }

    // ---- ManifestPermissions over PackageManager -------------------------------------------------

    @Test
    fun `declarations come from the package's requested permissions at the given API level`() {
        val manifest = ManifestPermissions.read(context(arrayOf(AUDIO, SCAN)), sdkInt = 34)
        assertEquals(34, manifest.sdkInt)
        assertTrue(manifest.isDeclared(AUDIO))
        assertTrue(manifest.isDeclared(SCAN))
        assertFalse(manifest.isDeclared(FINE))
        assertTrue(CapabilityAdvertisement.declares("microphone", manifest))
        assertTrue(CapabilityAdvertisement.declares("bluetooth", manifest))
        assertFalse(CapabilityAdvertisement.declares("camera", manifest))
        // The same manifest on API 30: BLE needs fine location, which it lacks.
        assertFalse(CapabilityAdvertisement.declares("bluetooth", ManifestPermissions.read(context(arrayOf(AUDIO, SCAN)), sdkInt = 30)))
    }

    @Test
    fun `an unreadable or permission-less package declares nothing`() {
        val missing = ManifestPermissions.read(context(null, failure = PackageManager.NameNotFoundException()), sdkInt = 34)
        val none = ManifestPermissions.read(context(null), sdkInt = 34)
        for (m in listOf(missing, none)) {
            assertFalse(m.isDeclared(AUDIO))
            assertFalse(m.neverForLocation(SCAN))
            assertFalse(CapabilityAdvertisement.declares("microphone", m))
        }
    }

    @Test
    fun `neverForLocation is read from the flags on API 31+ only`() {
        val nfl = PackageInfo.REQUESTED_PERMISSION_NEVER_FOR_LOCATION
        val requested = arrayOf(AUDIO, SCAN)
        assertTrue(ManifestPermissions.read(context(requested, intArrayOf(0, nfl)), sdkInt = 31).neverForLocation(SCAN))
        assertFalse(ManifestPermissions.read(context(requested, intArrayOf(0, nfl)), sdkInt = 30).neverForLocation(SCAN))
        assertFalse(ManifestPermissions.read(context(requested, intArrayOf(nfl, 0)), sdkInt = 34).neverForLocation(SCAN))
        assertFalse(ManifestPermissions.read(context(requested, null), sdkInt = 34).neverForLocation(SCAN))
        assertFalse(ManifestPermissions.read(context(requested, intArrayOf(0)), sdkInt = 34).neverForLocation(SCAN))
        assertFalse(ManifestPermissions.read(context(arrayOf(AUDIO), intArrayOf(nfl)), sdkInt = 34).neverForLocation(SCAN))
    }

    @Test
    fun `the Android permission platform answers declarations from the manifest seam`() {
        val manifest = ManifestPermissions.read(context(arrayOf(AUDIO)), sdkInt = 33)
        val platform = AndroidPermissionPlatform(
            mockk<Context>(relaxed = true),
            ForegroundActivityTracker(mockk<Application>(relaxed = true)),
            mockk<SharedPreferences>(relaxed = true),
            manifest,
        )
        assertEquals(33, platform.sdkInt)
        assertTrue(platform.isDeclared(AUDIO))
        assertFalse(platform.isDeclared(SCAN))
        // End to end: the mic is advertised through the real platform's declarations.
        assertTrue(MicRecordDriver(Audio(), platform, FakeIndicator()).isAvailable())
        val bare = AndroidPermissionPlatform(
            mockk<Context>(relaxed = true),
            ForegroundActivityTracker(mockk<Application>(relaxed = true)),
            mockk<SharedPreferences>(relaxed = true),
            ManifestPermissions.read(context(arrayOf(SCAN)), sdkInt = 33),
        )
        assertFalse(MicRecordDriver(Audio(), bare, FakeIndicator()).isAvailable())
    }

    @Test
    fun `the Bluetooth platform reads neverForLocation from the manifest seam`() {
        val nfl = PackageInfo.REQUESTED_PERMISSION_NEVER_FOR_LOCATION
        fun platform(flags: IntArray, sdk: Int): AndroidBluetoothPlatform {
            val ctx = mockk<Context>(relaxed = true)
            every { ctx.getSystemService(android.bluetooth.BluetoothManager::class.java) } returns null
            return AndroidBluetoothPlatform(ctx, ManifestPermissions.read(context(arrayOf(SCAN), flags), sdkInt = sdk))
        }
        assertTrue(platform(intArrayOf(nfl), 34).scanDisavowsLocation())
        assertFalse(platform(intArrayOf(0), 34).scanDisavowsLocation())
        assertFalse(platform(intArrayOf(nfl), 30).scanDisavowsLocation())
    }

    // ---- re-advertisement triggers ---------------------------------------------------------------

    @Test
    fun `the default indicator's overlay appearing and going away re-advertises`() = runTest {
        val indicator = ComposeDeviceActivityIndicator()
        val perms = FakePermissions(sdkInt = 34).declare("RECORD_AUDIO", "BLUETOOTH_SCAN")
        val host = newHost(listOf(MicRecordDriver(Audio(), perms, indicator), BluetoothScanDriver(FakeBluetooth(), perms, indicator)))
        val tracker = ForegroundActivityTracker(mockk<Application>(relaxed = true))
        AndroidDeviceHost.bindAdvertisementTriggers(host, tracker, indicator)
        val (c, t) = connect(host, openCore = false)
        c.handleMessage(coreRequest(1, initialCredit = 64))
        runCurrent()
        val detach = indicator.attach() // a DeviceActivityOverlay is composed on a started screen
        runCurrent()
        val second = indicator.attach() // another overlay: readiness unchanged, no callback
        runCurrent()
        second()
        runCurrent()
        detach() // the last overlay went away
        runCurrent()
        assertEquals(
            listOf(
                listOf("core.capabilities"),
                listOf("core.capabilities", "mic.record", "bluetooth.scan"),
                listOf("core.capabilities"),
            ),
            snapshots(t),
        )
        host.dispose()
    }

    @Test
    fun `gaining or losing the foreground re-checks the advertisement and suspends the host`() = runTest {
        // A custom indicator whose readiness follows the foreground and has no callback of its own.
        val indicator = FakeIndicator(ready = false)
        val perms = FakePermissions(sdkInt = 34).declare("RECORD_AUDIO")
        val host = newHost(listOf(MicRecordDriver(Audio(), perms, indicator)))
        val tracker = ForegroundActivityTracker(mockk<Application>(relaxed = true))
        AndroidDeviceHost.bindAdvertisementTriggers(host, tracker, indicator)
        val (c, t) = connect(host, openCore = false)
        c.handleMessage(coreRequest(1, initialCredit = 64))
        runCurrent()

        tracker.onBackground!!.invoke() // nothing changed: suspended, no snapshot
        runCurrent()
        assertTrue(host.isSuspended)
        assertEquals(1, snapshots(t).size)

        indicator.ready = true
        tracker.onForeground!!.invoke()
        runCurrent()
        assertFalse(host.isSuspended)
        assertEquals(listOf("core.capabilities", "mic.record"), snapshots(t).last())

        indicator.ready = false
        tracker.onBackground!!.invoke()
        runCurrent()
        assertTrue(host.isSuspended)
        assertEquals(listOf("core.capabilities"), snapshots(t).last())
        assertEquals(3, snapshots(t).size)
        host.dispose()
    }
}
