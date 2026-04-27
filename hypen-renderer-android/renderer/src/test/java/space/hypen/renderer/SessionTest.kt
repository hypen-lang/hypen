package space.hypen.renderer

import space.hypen.renderer.remote.SessionInfo
import space.hypen.renderer.remote.SessionOptions
import org.junit.Assert.*
import org.junit.Test

/**
 * Tests for session-related data classes and functionality
 */
class SessionTest {

    @Test
    fun `SessionOptions with null values`() {
        val options = SessionOptions()

        assertNull(options.id)
        assertNull(options.props)
    }

    @Test
    fun `SessionOptions with sessionId only`() {
        val options = SessionOptions(id = "session-123")

        assertEquals("session-123", options.id)
        assertNull(options.props)
    }

    @Test
    fun `SessionOptions with props only`() {
        val props = mapOf(
            "platform" to "android",
            "version" to "1.0.0",
            "userId" to 12345
        )
        val options = SessionOptions(props = props)

        assertNull(options.id)
        assertEquals("android", options.props?.get("platform"))
        assertEquals("1.0.0", options.props?.get("version"))
        assertEquals(12345, options.props?.get("userId"))
    }

    @Test
    fun `SessionOptions with all values`() {
        val props = mapOf("platform" to "android")
        val options = SessionOptions(
            id = "resume-session",
            props = props
        )

        assertEquals("resume-session", options.id)
        assertEquals("android", options.props?.get("platform"))
    }

    @Test
    fun `SessionInfo for new session`() {
        val info = SessionInfo(
            sessionId = "new-session-456",
            isNew = true,
            isRestored = false
        )

        assertEquals("new-session-456", info.sessionId)
        assertTrue(info.isNew)
        assertFalse(info.isRestored)
    }

    @Test
    fun `SessionInfo for restored session`() {
        val info = SessionInfo(
            sessionId = "restored-session-789",
            isNew = false,
            isRestored = true
        )

        assertEquals("restored-session-789", info.sessionId)
        assertFalse(info.isNew)
        assertTrue(info.isRestored)
    }

    @Test
    fun `SessionInfo for reconnected but not restored session`() {
        // When reconnecting but state was not preserved
        val info = SessionInfo(
            sessionId = "reconnect-session",
            isNew = false,
            isRestored = false
        )

        assertFalse(info.isNew)
        assertFalse(info.isRestored)
    }

    @Test
    fun `SessionOptions data class equality`() {
        val options1 = SessionOptions(id = "test", props = mapOf("key" to "value"))
        val options2 = SessionOptions(id = "test", props = mapOf("key" to "value"))
        val options3 = SessionOptions(id = "different", props = mapOf("key" to "value"))

        assertEquals(options1, options2)
        assertNotEquals(options1, options3)
    }

    @Test
    fun `SessionInfo data class equality`() {
        val info1 = SessionInfo(sessionId = "test", isNew = true, isRestored = false)
        val info2 = SessionInfo(sessionId = "test", isNew = true, isRestored = false)
        val info3 = SessionInfo(sessionId = "test", isNew = false, isRestored = false)

        assertEquals(info1, info2)
        assertNotEquals(info1, info3)
    }

    @Test
    fun `SessionOptions copy`() {
        val original = SessionOptions(id = "original", props = mapOf("a" to 1))
        val copy = original.copy(id = "modified")

        assertEquals("modified", copy.id)
        assertEquals(original.props, copy.props)
    }

    @Test
    fun `SessionInfo copy`() {
        val original = SessionInfo(sessionId = "original", isNew = true, isRestored = false)
        val copy = original.copy(isNew = false, isRestored = true)

        assertEquals("original", copy.sessionId)
        assertFalse(copy.isNew)
        assertTrue(copy.isRestored)
    }
}
