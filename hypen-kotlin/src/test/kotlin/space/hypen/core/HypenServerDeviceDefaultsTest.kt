package space.hypen.core

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.Collections
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Startup behaviour of the always-on device plane: the server never refuses
 * to start because of device prerequisites; it logs ONE warning when no
 * admission is configured. Compression (on by default) never turns the
 * device plane off and logs nothing about it.
 */
class HypenServerDeviceDefaultsTest {
    private class Warnings : LogHandler {
        val all: MutableList<String> = Collections.synchronizedList(mutableListOf())
        override fun debug(tag: String, message: String, args: List<Any?>) {}
        override fun info(tag: String, message: String, args: List<Any?>) {}
        override fun warn(tag: String, message: String, args: List<Any?>) { all += message }
        override fun error(tag: String, message: String, args: List<Any?>) {}
    }

    private val previousLevel = Logger.getLogLevel()
    private val warnings = Warnings()

    @BeforeEach
    fun setup() = Logger.configure(LoggerConfig(level = LogLevel.WARN, handler = warnings))

    @AfterEach
    fun restore() = Logger.configure(LoggerConfig(level = previousLevel))

    private fun admissionWarnings() = warnings.all.count { it.contains("no allowedOrigins/authenticate configured") }
    private fun compressionWarnings() = warnings.all.count { it.contains("compression", ignoreCase = true) }

    @Test
    fun `no admission config - the server starts, admits, and warns once`() {
        val s = HypenServer {}
        try {
            assertTrue(s.deviceEnabled)
            assertEquals(1, admissionWarnings(), "${warnings.all}")
            assertTrue(
                warnings.all.single { it.contains("no allowedOrigins") }
                    .contains("any client can connect; set them in production"),
            )
            assertEquals(0, compressionWarnings())
            kotlinx.coroutines.runBlocking {
                assertTrue(s.admit(UpgradeRequest.of("Origin" to "https://anything.test")).isAdmitted)
                assertTrue(s.admit(UpgradeRequest.of()).isAdmitted)
            }
        } finally {
            s.shutdown()
        }
    }

    @Test
    fun `configured admission - no warning`() {
        val a = HypenServer { allowedOrigins("https://app.test") }
        val b = HypenServer { authenticate { true } }
        try {
            assertEquals(0, admissionWarnings(), "${warnings.all}")
        } finally {
            a.shutdown()
            b.shutdown()
        }
    }

    @Test
    fun `explicit compression = true - device stays on, no warning`() {
        val s = HypenServer {
            allowedOrigins("https://app.test")
            compression = true
        }
        try {
            assertTrue(s.deviceEnabled)
            assertTrue(s.compression)
            assertEquals(0, compressionWarnings(), "${warnings.all}")
            assertTrue(warnings.all.isEmpty(), "${warnings.all}")
        } finally {
            s.shutdown()
        }
    }

    @Test
    fun `disableDevice - no device warning, compression on by default`() {
        val s = HypenServer {
            allowedOrigins("https://app.test")
            disableDevice()
        }
        try {
            assertFalse(s.deviceEnabled)
            assertTrue(s.compression)
            assertEquals(0, compressionWarnings(), "${warnings.all}")
        } finally {
            s.shutdown()
        }
    }

    @Test
    fun `configureDevice calls accumulate on the default config`() {
        val s = HypenServer {
            allowedOrigins("https://app.test")
            configureDevice { maxBackgroundOwners = 3 }
            configureDevice { helloTimeoutMs = 1_234 }
        }
        try {
            assertTrue(s.deviceEnabled)
            assertTrue(s.compression)
            assertEquals(0, compressionWarnings())
        } finally {
            s.shutdown()
        }
    }
}
