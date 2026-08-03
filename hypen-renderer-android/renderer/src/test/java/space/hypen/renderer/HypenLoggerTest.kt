package space.hypen.renderer

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Routing + filtering conformance for the pluggable [HypenLogHandler].
 *
 * A recording handler replaces `android.util.Log` entirely, which is what makes
 * this path unit-testable on the JVM at all: with no handler installed every
 * `TaggedLogger` call bottoms out in `android.util.Log`, which is unimplemented
 * off-device.
 */
class HypenLoggerTest {

    private data class Record(
        val level: HypenLogLevel,
        val tag: String,
        val message: String,
        val throwable: Throwable?,
    )

    private val records = mutableListOf<Record>()
    private val recorder = HypenLogHandler { level, tag, message, throwable ->
        records += Record(level, tag, message, throwable)
    }

    @Before
    fun installRecorder() {
        HypenLogger.setLogHandler(recorder)
        HypenLogger.setLogLevel(HypenLogLevel.DEBUG)
    }

    @After
    fun restoreDefaults() {
        HypenLogger.setLogHandler(null)
        HypenLogger.setLogLevel(HypenLogLevel.ERROR)
        records.clear()
    }

    // ------------------------------------------------------------- installing

    @Test
    fun `handler defaults to null and round-trips through setLogHandler`() {
        HypenLogger.setLogHandler(null)
        assertNull(HypenLogger.handler)

        HypenLogger.setLogHandler(recorder)
        assertSame(recorder, HypenLogger.handler)
    }

    // --------------------------------------------------------------- routing

    @Test
    fun `every level routes to the handler with its tag`() {
        val log = TaggedLogger("Routing")
        log.debug("d")
        log.info("i")
        log.warn("w")
        log.error("e")

        assertEquals(
            listOf(
                HypenLogLevel.DEBUG,
                HypenLogLevel.INFO,
                HypenLogLevel.WARN,
                HypenLogLevel.ERROR,
            ),
            records.map { it.level },
        )
        assertTrue(records.all { it.tag == "Routing" })
        assertEquals(listOf("d", "i", "w", "e"), records.map { it.message })
        assertTrue(records.all { it.throwable == null })
    }

    @Test
    fun `varargs are formatted before reaching the handler`() {
        TaggedLogger("Fmt").info("patched %s in %dms", "root", 12)

        assertEquals("patched root in 12ms", records.single().message)
    }

    @Test
    fun `lazy overloads route their built message`() {
        val log = TaggedLogger("Lazy")
        log.debug { "lazy debug" }
        log.warn { "lazy warn" }

        assertEquals(listOf("lazy debug", "lazy warn"), records.map { it.message })
        assertEquals(
            listOf(HypenLogLevel.DEBUG, HypenLogLevel.WARN),
            records.map { it.level },
        )
    }

    @Test
    fun `throwable overload carries the throwable through`() {
        val boom = IllegalStateException("boom")
        TaggedLogger("Err").error("failed to apply patch", boom)

        val record = records.single()
        assertEquals(HypenLogLevel.ERROR, record.level)
        assertEquals("failed to apply patch", record.message)
        assertSame(boom, record.throwable)
    }

    @Test
    fun `child loggers keep the parent tag prefix`() {
        TaggedLogger("Parent").child("Child").error("nested")

        assertEquals("Parent:Child", records.single().tag)
    }

    // -------------------------------------------------------------- filtering

    @Test
    fun `level filtering still applies with a handler installed`() {
        HypenLogger.setLogLevel(HypenLogLevel.WARN)

        val log = TaggedLogger("Filtered")
        log.debug("dropped")
        log.info("dropped")
        log.warn("kept")
        log.error("kept")

        assertEquals(listOf("kept", "kept"), records.map { it.message })
    }

    @Test
    fun `NONE silences the handler entirely`() {
        HypenLogger.setLogLevel(HypenLogLevel.NONE)

        val log = TaggedLogger("Silent")
        log.debug("nope")
        log.info("nope")
        log.warn("nope")
        log.error("nope")
        log.error("nope", RuntimeException("nope"))

        assertTrue(records.isEmpty())
    }

    @Test
    fun `filtered lazy messages are never built`() {
        HypenLogger.setLogLevel(HypenLogLevel.ERROR)
        var built = 0

        val log = TaggedLogger("Lazy")
        log.debug { built++; "expensive" }
        log.warn { built++; "expensive" }

        assertEquals(0, built)
        assertTrue(records.isEmpty())
    }

    @Test
    fun `setDebugMode toggles what the handler receives`() {
        val log = TaggedLogger("Toggle")

        HypenLogger.setDebugMode(false)
        log.debug("hidden")
        assertTrue(records.isEmpty())

        HypenLogger.setDebugMode(true)
        log.debug("shown")
        assertEquals("shown", records.single().message)
    }

    @Test
    fun `clearing the handler stops delivery`() {
        val log = TaggedLogger("Cleared")
        log.error("first")
        HypenLogger.setLogHandler(null)

        // Nothing further may reach the recorder; the call itself falls back to
        // android.util.Log, which is a no-op under unitTests.isReturnDefaultValues.
        log.error("second")

        assertEquals(listOf("first"), records.map { it.message })
    }
}
