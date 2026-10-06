@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer.device

import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import space.hypen.renderer.device.android.AlertDialogBluetoothChooser
import space.hypen.renderer.device.android.HypenDeviceFileProvider
import java.io.File
import java.nio.file.Files

/** Pure helpers behind the round-3 drivers, and the Android pieces that need no device. */
class DeviceCaptureSupportTest {
    @Test
    fun `server file names are made safe for the save picker`() {
        assertEquals("report.pdf", DeviceCaptureSupport.safeFileName("report.pdf"))
        assertEquals(".._.._etc_passwd", DeviceCaptureSupport.safeFileName("../../etc/passwd"))
        assertEquals("a_b_c", DeviceCaptureSupport.safeFileName("a\\b\u0000c"))
        assertEquals("evil_gpj.exe", DeviceCaptureSupport.safeFileName("evil‮gpj.exe")) // RLO is a format character
        assertEquals("download", DeviceCaptureSupport.safeFileName("   "))
        assertEquals("download", DeviceCaptureSupport.safeFileName(".."))
        val long = DeviceCaptureSupport.safeFileName("😀".repeat(300))
        assertEquals(255, long.codePointLength())
        assertEquals("pdf", DeviceCaptureSupport.fileExtension("a.PDF"))
        assertEquals("", DeviceCaptureSupport.fileExtension("noext"))
        assertEquals("", DeviceCaptureSupport.fileExtension(".hidden"))
        assertEquals("", DeviceCaptureSupport.fileExtension("a.p d f"))
        assertEquals("512 B", DeviceCaptureSupport.formatBytes(512))
        assertEquals("1.5 KB", DeviceCaptureSupport.formatBytes(1536))
        assertEquals("64 MB", DeviceCaptureSupport.formatBytes(64L * 1024 * 1024))
        assertEquals("save a file (10 B) to your device", FileSaveDriver.label("download", 10))
        assertEquals("application/octet-stream", DeviceCaptureSupport.contentType(" "))
    }

    @Test
    fun `accept entries parse into mime, wildcard and extension filters`() {
        val f = DocumentTypeFilter.parse(listOf(" Image/* ", ".PDF", "text/plain", "*/*", "", "pdf"))!!
        assertEquals(
            listOf(DocumentTypeFilter.MediaWildcard("image"), DocumentTypeFilter.Extension("pdf"), DocumentTypeFilter.MimeType("text/plain")),
            f,
        )
        for (bad in listOf("image/**", "a b", "/x", "x/", ".", "tar..gz", "text/pl ain")) assertNull(bad, DocumentTypeFilter.parse(listOf(bad)))
        assertEquals(emptyList<DocumentTypeFilter>(), DocumentTypeFilter.parse(listOf("*/*", "*", " ")))
        assertTrue(DocumentTypeFilter.MediaWildcard("image").matches("x", "IMAGE/png; q=1"))
        assertFalse(DocumentTypeFilter.MediaWildcard("image").matches("x.png", "video/mp4"))
        assertTrue(DocumentTypeFilter.Extension("tar.gz").matches("a.TAR.GZ", "application/gzip"))
        assertEquals(
            listOf("image/*", "application/pdf"),
            DocumentTypeFilter.mimeTypes(f.take(2)) { if (it == "pdf") "application/pdf" else null },
        )
        // An extension without a known type widens the picker (items are matched afterwards).
        assertEquals(listOf("*/*"), DocumentTypeFilter.mimeTypes(listOf(DocumentTypeFilter.Extension("xyz"), DocumentTypeFilter.MimeType("a/b"))) { null })
        assertEquals(listOf("*/*"), DocumentTypeFilter.mimeTypes(emptyList()) { null })
    }

    private fun ftyp(brand: String) = byteArrayOf(0, 0, 0, 0x20) + "ftyp$brand".toByteArray(Charsets.ISO_8859_1) + ByteArray(4)

    @Test
    fun `captured media is identified from its bytes and must fit the mode`() {
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xDB.toByte())
        assertEquals("image/jpeg", MediaSniffer.cameraType(jpeg, video = false))
        assertEquals("image/heic", MediaSniffer.cameraType(ftyp("heic"), video = false))
        assertEquals("image/heic", MediaSniffer.cameraType(ftyp("mif1"), video = false))
        assertNull(MediaSniffer.cameraType(ftyp("isom"), video = false))
        assertNull(MediaSniffer.cameraType("\u0089PNG\r\n\u001a\n".toByteArray(Charsets.ISO_8859_1), video = false))
        assertEquals("video/mp4", MediaSniffer.cameraType(ftyp("isom"), video = true))
        assertEquals("video/mp4", MediaSniffer.cameraType(ftyp("3gp4"), video = true))
        assertEquals("video/quicktime", MediaSniffer.cameraType(ftyp("qt  "), video = true))
        assertEquals("video/webm", MediaSniffer.cameraType(byteArrayOf(0x1A, 0x45, 0xDF.toByte(), 0xA3.toByte()), video = true))
        assertNull(MediaSniffer.cameraType(jpeg, video = true))
        assertNull(MediaSniffer.cameraType(ftyp("heic"), video = true))
        assertNull(MediaSniffer.cameraType(ByteArray(0), video = true))
        // The same rule the runtime applies to announced items.
        assertNull(DevicePayloads.blobStartViolation("camera.capture", 1, mapOf("mode" to "photo"), "image/heic"))
        assertTrue(DevicePayloads.blobStartViolation("camera.capture", 1, mapOf("mode" to "photo"), "video/mp4") != null)
        assertTrue(DevicePayloads.blobStartViolation("camera.capture", 1, mapOf("mode" to "video"), "image/jpeg") != null)
        assertNull(DevicePayloads.blobStartViolation("gallery.pick", 1, mapOf("mode" to "photo"), "video/mp4"))
    }

    @Test
    fun `capture intent hints - facing extras and whole-second duration limits`() {
        assertEquals(
            mapOf(CameraIntentHints.EXTRA_CAMERA_FACING to 1, CameraIntentHints.EXTRA_LENS_FACING_FRONT to 1, CameraIntentHints.EXTRA_USE_FRONT_CAMERA to true),
            CameraIntentHints.facingExtras("front"),
        )
        assertEquals(
            mapOf(CameraIntentHints.EXTRA_CAMERA_FACING to 0, CameraIntentHints.EXTRA_LENS_FACING_BACK to 1, CameraIntentHints.EXTRA_USE_FRONT_CAMERA to false),
            CameraIntentHints.facingExtras("back"),
        )
        assertEquals(emptyMap<String, Any>(), CameraIntentHints.facingExtras(null))
        assertEquals(1, CameraIntentHints.durationLimitSeconds(1))
        assertEquals(1, CameraIntentHints.durationLimitSeconds(1_999))
        assertEquals(15, CameraIntentHints.durationLimitSeconds(15_000))
        assertEquals(600, CameraIntentHints.durationLimitSeconds(600_000))
    }

    @Test
    fun `pcm16 helpers - little endian, remix, durations`() {
        assertArrayEquals(byteArrayOf(0x34, 0x12, 0xFF.toByte(), 0xFF.toByte(), 0, 0x80.toByte()), Pcm16.littleEndian(shortArrayOf(0x1234, -1, Short.MIN_VALUE)))
        assertArrayEquals(shortArrayOf(5, 5, -3, -3), Pcm16.remix(shortArrayOf(5, -3, 99), 2, 1, 2))
        assertArrayEquals(shortArrayOf(15, -2), Pcm16.remix(shortArrayOf(10, 20, -4, 0), 4, 2, 1))
        assertArrayEquals(shortArrayOf(1, 2), Pcm16.remix(shortArrayOf(1, 2, 3), 2, 1, 1))
        assertEquals(1000L, Pcm16.durationMs(48_000, 48_000))
        assertEquals(1L, Pcm16.durationMs(24, 48_000)) // 0.5 ms rounds up
        assertEquals(80L, Pcm16.framesFor(10, 8_000))
        assertEquals(45L, Pcm16.framesFor(1, 44_100)) // 44.1 frames, rounded up
        assertEquals(4, AudioCaptureFormat(8_000, 2).frameBytes)
    }

    @Test
    fun `the resampler is chunking-invariant, exact at identity and interpolates between frames`() {
        val input = ShortArray(4_800) { (1000 * kotlin.math.sin(it / 7.0)).toInt().toShort() }
        val whole = Pcm16Resampler(48_000, 16_000, 1).process(input)
        val parts = Pcm16Resampler(48_000, 16_000, 1).let { r ->
            listOf(0..999, 1000..1000, 1001..3332, 3333..4799).map { r.process(input.sliceArray(it)) }.reduce { a, b -> a + b }
        }
        assertArrayEquals(whole, parts)
        assertTrue(whole.size in 1598..1600)
        assertArrayEquals(input.copyOf(10), Pcm16Resampler(8_000, 8_000, 1).process(input.copyOf(10)))
        // Upsampling a ramp by 2 puts the midpoints in between.
        val up = Pcm16Resampler(8_000, 16_000, 2).process(shortArrayOf(0, 100, 10, 110, 20, 120))
        assertArrayEquals(shortArrayOf(0, 100, 5, 105, 10, 110, 15, 115), up)
    }

    @Test
    fun `the live capture buffer drains in order, finishes, truncates at its limit and fails bounded`() = runTest {
        val b = LiveCaptureBuffer(limit = 10)
        val buf = ByteArray(64)
        assertTrue(b.write(byteArrayOf(1, 2, 3)))
        assertTrue(b.write(byteArrayOf(4, 5)))
        assertEquals(4, b.read(buf, 0, 4))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), buf.copyOf(4))
        assertEquals(1, b.read(buf, 0, 64))
        // Suspends until data or the end.
        val pending = async { b.read(buf, 0, 64) }
        runCurrent()
        assertFalse(pending.isCompleted)
        b.write(byteArrayOf(9))
        runCurrent()
        assertEquals(1, pending.await())
        b.finish()
        assertEquals(-1, b.read(buf, 0, 64))
        assertTrue(b.write(byteArrayOf(1))) // after the end: dropped
        assertEquals(6L, b.capturedBytes)

        val limited = LiveCaptureBuffer(limit = 100, maxBytes = 5)
        limited.write(byteArrayOf(1, 2, 3))
        limited.write(byteArrayOf(4, 5, 6, 7))
        assertTrue(limited.reachedLimit)
        assertEquals(5, limited.read(buf, 0, 64))
        assertEquals(-1, limited.read(buf, 0, 64))

        val bounded = LiveCaptureBuffer(limit = 4)
        assertTrue(bounded.write(ByteArray(4)))
        assertFalse(bounded.write(ByteArray(1))) // overflow: throttled
        try {
            bounded.read(buf, 0, 64)
            fail("expected throttled")
        } catch (e: DeviceDriverException) {
            assertEquals(DeviceErrorCode.THROTTLED, e.code)
            assertEquals(LiveCaptureBuffer.CAPTURE_BUFFER_FULL, e.detail)
        }

        val failed = LiveCaptureBuffer(limit = 4)
        failed.write(byteArrayOf(1))
        failed.fail(DeviceDriverException(DeviceErrorCode.UNAVAILABLE, "gone"))
        assertEquals(0L, failed.pendingBytes)
        assertTrue(runCatching { failed.read(buf, 0, 1) }.exceptionOrNull() is DeviceDriverException)
    }

    @Test
    fun `capture temp files are swept only when stale`() {
        val cache = Files.createTempDirectory("hypen-cache").toFile()
        val dir = File(cache, HypenDeviceFileProvider.CAPTURE_DIR).apply { mkdirs() }
        val old = File(dir, "capture-old.jpg").apply { writeText("x"); setLastModified(1_000) }
        val fresh = File(dir, "capture-new.mp4").apply { writeText("y") }
        HypenDeviceFileProvider.sweep(cache)
        assertFalse(old.exists())
        assertTrue(fresh.exists())
        HypenDeviceFileProvider.sweep(File(cache, "missing")) // no directory: nothing to do
        cache.deleteRecursively()
    }

    @Test
    fun `the renderer manifest declares the private capture FileProvider and its paths`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android:name=\"space.hypen.renderer.device.android.HypenDeviceFileProvider\""))
        assertTrue(manifest.contains("android:authorities=\"\${applicationId}.hypen.device.files\""))
        assertTrue(manifest.contains("android:exported=\"false\""))
        assertTrue(manifest.contains("android:grantUriPermissions=\"true\""))
        val paths = File("src/main/res/xml/hypen_device_file_paths.xml").readText()
        assertTrue(paths.contains("<cache-path name=\"hypen_device_capture\" path=\"${HypenDeviceFileProvider.CAPTURE_DIR}/\""))
    }

    @Test
    fun `the bluetooth chooser names the origin and every row`() {
        assertEquals("Polar H10\nAA:BB", AlertDialogBluetoothChooser.row(BluetoothChooserEntry("AA:BB", "Polar H10", -40)))
        assertEquals("Unnamed device\nCC", AlertDialogBluetoothChooser.row(BluetoothChooserEntry("CC", " ", -40)))
        assertTrue(AlertDialogBluetoothChooser.message("wss://app.example:443").startsWith("wss://app.example:443 wants to connect"))
        assertTrue(AlertDialogBluetoothChooser.message("ws://10.0.2.2:3000").contains("Development mode"))
    }
}
