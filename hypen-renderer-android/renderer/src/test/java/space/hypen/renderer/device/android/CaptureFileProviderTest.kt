package space.hypen.renderer.device.android

import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ProviderInfo
import android.content.res.XmlResourceParser
import android.net.Uri
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkConstructor
import io.mockk.unmockkConstructor
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.w3c.dom.Element
import org.xmlpull.v1.XmlPullParser
import space.hypen.renderer.device.DeviceDriverException
import space.hypen.renderer.device.DeviceErrorCode
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Tester report "Android: camera returns driver-failure".
 *
 * `camera.capture` builds the capture file's `content://` URI with the
 * static `FileProvider.getUriForFile(context, authority, file)`. That call
 * never sees the `HypenDeviceFileProvider(R.xml.…)` constructor argument
 * (androidx.core ≥ 1.10 parses the provider's paths lazily, per instance, and
 * `attachInfo` clears the static cache): it reads the paths from the
 * provider's `android.support.FILE_PROVIDER_PATHS` manifest `<meta-data>`.
 * Without that entry it throws `IllegalArgumentException("Missing
 * android.support.FILE_PROVIDER_PATHS meta-data")` before the camera app is
 * ever launched, which the host reported as `internal` / `driver-failure`.
 *
 * These tests run the REAL androidx `FileProvider` code against the REAL
 * library manifest and paths XML; only the Android framework objects it
 * touches are faked, with the framework's own semantics:
 * `ProviderInfo.metaData` holds exactly the provider's manifest `<meta-data>`
 * and `loadXmlMetaData(pm, name)` returns a parser only for an entry that is
 * there.
 */
class CaptureFileProviderTest {
    private val cache: File = Files.createTempDirectory("hypen-cache").toFile()

    @Before
    fun mockUriBuilder() {
        // The unit-test android.jar returns null from every builder call.
        mockkConstructor(Uri.Builder::class)
        every { anyConstructed<Uri.Builder>().scheme(any()) } answers { self as Uri.Builder }
        every { anyConstructed<Uri.Builder>().authority(any()) } answers { self as Uri.Builder }
        every { anyConstructed<Uri.Builder>().encodedPath(any()) } answers { self as Uri.Builder }
        every { anyConstructed<Uri.Builder>().build() } returns BUILT
    }

    @After
    fun tearDown() {
        unmockkConstructor(Uri.Builder::class)
        cache.deleteRecursively()
    }

    /** The library manifest's `<provider>` for [HypenDeviceFileProvider]: its `<meta-data>` name → resource. */
    private fun providerMetaData(manifest: File = File("src/main/AndroidManifest.xml")): Map<String, String> {
        val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(manifest)
        val providers = doc.getElementsByTagName("provider")
        val android = "http://schemas.android.com/apk/res/android"
        for (i in 0 until providers.length) {
            val p = providers.item(i) as Element
            if (p.getAttributeNS(android, "name") != HypenDeviceFileProvider::class.java.name) continue
            val meta = p.getElementsByTagName("meta-data")
            return (0 until meta.length).associate { j ->
                val m = meta.item(j) as Element
                m.getAttributeNS(android, "name") to m.getAttributeNS(android, "resource")
            }
        }
        fail("the library manifest declares no HypenDeviceFileProvider")
        error("unreachable")
    }

    /** A parser over the real `res/xml/<name>.xml` (the only element kind FileProvider reads). */
    private fun pathsParser(resource: String): XmlResourceParser {
        val name = resource.removePrefix("@xml/")
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File("src/main/res/xml/$name.xml"))
        val elements = doc.documentElement.childNodes.let { nodes -> (0 until nodes.length).mapNotNull { nodes.item(it) as? Element } }
        var i = -1
        val parser = mockk<XmlResourceParser>(relaxed = true)
        every { parser.next() } answers { if (++i < elements.size) XmlPullParser.START_TAG else XmlPullParser.END_DOCUMENT }
        every { parser.name } answers { elements[i].tagName }
        every { parser.getAttributeValue(null, any()) } answers { elements[i].getAttribute(secondArg<String>()).ifEmpty { null } }
        return parser
    }

    /** A Context whose package declares the provider with exactly [meta] as its `<meta-data>`. */
    private fun context(meta: Map<String, String>): Context {
        val pkg = "app.test${counter.incrementAndGet()}" // FileProvider caches strategies per authority
        val pm = mockk<PackageManager>()
        val info = mockk<ProviderInfo>()
        // Framework semantics: metaData is null when the provider has no <meta-data>.
        info.metaData = if (meta.isEmpty()) null else android.os.Bundle()
        every { info.loadXmlMetaData(pm, any()) } answers { meta[secondArg<String>()]?.let(::pathsParser) }
        every { pm.resolveContentProvider("$pkg.hypen.device.files", PackageManager.GET_META_DATA) } returns info
        return mockk {
            every { packageName } returns pkg
            every { packageManager } returns pm
            every { cacheDir } returns cache
        }
    }

    private fun captureFile(): File =
        File(cache, HypenDeviceFileProvider.CAPTURE_DIR).apply { mkdirs() }.let { File.createTempFile("capture-", ".jpg", it) }

    @Test
    fun `the library manifest gives the capture provider its paths as FILE_PROVIDER_PATHS meta-data`() {
        assertEquals(
            mapOf("android.support.FILE_PROVIDER_PATHS" to "@xml/hypen_device_file_paths"),
            providerMetaData(),
        )
    }

    @Test
    fun `the capture file's content URI resolves through the real androidx FileProvider`() {
        val uri = HypenDeviceFileProvider.uriForCapture(context(providerMetaData()), captureFile())
        assertSame(BUILT, uri)
    }

    @Test
    fun `without the meta-data the static lookup fails before any camera launch - reported as a named misconfiguration`() {
        // The pre-fix manifest: the provider with no <meta-data>.
        val e = try {
            HypenDeviceFileProvider.uriForCapture(context(emptyMap()), captureFile())
            fail("expected the provider lookup to fail")
            error("unreachable")
        } catch (e: DeviceDriverException) {
            e
        }
        assertEquals(DeviceErrorCode.INTERNAL, e.code)
        assertEquals(HypenDeviceFileProvider.MISCONFIGURED, e.detail)
        assertTrue(e.cause is IllegalArgumentException)
        assertTrue(e.cause!!.message.orEmpty().contains("FILE_PROVIDER_PATHS"))
    }

    @Test
    fun `a file outside the shared capture directory is never exposed`() {
        val outside = File.createTempFile("secret-", ".txt", cache)
        val e = runCatching { HypenDeviceFileProvider.uriForCapture(context(providerMetaData()), outside) }.exceptionOrNull()
        assertTrue("got $e", e is DeviceDriverException && e.cause is IllegalArgumentException)
    }

    private companion object {
        val counter = AtomicInteger()
        val BUILT: Uri = mockk()
    }
}
