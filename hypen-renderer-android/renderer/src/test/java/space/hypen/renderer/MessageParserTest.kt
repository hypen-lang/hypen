package space.hypen.renderer

import space.hypen.renderer.model.*
import space.hypen.renderer.remote.MoshiMessageParser
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class MessageParserTest {
    private lateinit var parser: MoshiMessageParser

    @Before
    fun setup() {
        parser = MoshiMessageParser()
    }

    @Test
    fun `parse initialTree message`() {
        val json =
            """
            {
                "type": "initialTree",
                "module": "Counter",
                "state": {"count": 0},
                "patches": [
                    {"type": "create", "id": "1", "elementType": "column", "props": {}},
                    {"type": "create", "id": "2", "elementType": "text", "props": {"0": "Count: 0"}},
                    {"type": "insert", "parentId": "root", "id": "1"},
                    {"type": "insert", "parentId": "1", "id": "2"}
                ],
                "revision": 0
            }
            """.trimIndent()

        val message = parser.parseMessage(json) as? InitialTreeMessage
        assertNotNull(message)
        assertEquals("initialTree", message!!.type)
        assertEquals("Counter", message.module)
        assertEquals(0.0, message.state?.get("count"))
        assertEquals(4, message.patches.size)
        assertEquals(0, message.revision)
    }

    @Test
    fun `parse patch message`() {
        val json =
            """
            {
                "type": "patch",
                "module": "Counter",
                "patches": [
                    {"type": "setProp", "id": "2", "name": "0", "value": "Count: 1"}
                ],
                "revision": 1
            }
            """.trimIndent()

        val message = parser.parseMessage(json) as? PatchMessage
        assertNotNull(message)
        assertEquals("patch", message!!.type)
        assertEquals("Counter", message.module)
        assertEquals(1, message.patches.size)
        assertEquals(1, message.revision)

        val patch = message.patches[0]
        assertEquals(PatchType.SET_PROP, patch.type)
        assertEquals("2", patch.id)
        assertEquals("0", patch.name)
        assertEquals("Count: 1", patch.value)
    }

    @Test
    fun `parse stateUpdate message`() {
        val json =
            """
            {
                "type": "stateUpdate",
                "module": "Counter",
                "state": {"count": 5, "user": {"name": "John"}}
            }
            """.trimIndent()

        val message = parser.parseMessage(json) as? StateUpdateMessage
        assertNotNull(message)
        assertEquals("stateUpdate", message!!.type)
        assertEquals("Counter", message.module)
        assertEquals(5.0, message.state?.get("count")) // Moshi parses as Double
        @Suppress("UNCHECKED_CAST")
        val user = message.state?.get("user") as? Map<String, Any?>
        assertEquals("John", user?.get("name"))
    }

    @Test
    fun `serialize dispatchAction message`() {
        val message =
            DispatchActionMessage(
                module = "Counter",
                action = "increment",
                payload = mapOf("amount" to 5),
            )

        val json = parser.serializeMessage(message)
        assertTrue(json.contains("\"type\":\"dispatchAction\""))
        assertTrue(json.contains("\"module\":\"Counter\""))
        assertTrue(json.contains("\"action\":\"increment\""))
        assertTrue(json.contains("\"amount\":5"))
    }

    @Test
    fun `parse create patch with element_type`() {
        val json =
            """
            {
                "type": "patch",
                "module": "Test",
                "patches": [
                    {"type": "create", "id": "btn1", "elementType": "button", "props": {"onClick": "@actions.click"}}
                ],
                "revision": 1
            }
            """.trimIndent()

        val message = parser.parseMessage(json) as? PatchMessage
        assertNotNull(message)

        val patch = message!!.patches[0]
        assertEquals(PatchType.CREATE, patch.type)
        assertEquals("btn1", patch.id)
        assertEquals("button", patch.elementType)
        assertEquals("@actions.click", patch.props?.get("onClick"))
    }

    @Test
    fun `parse insert patch with before_id`() {
        val json =
            """
            {
                "type": "patch",
                "module": "Test",
                "patches": [
                    {"type": "insert", "parentId": "container", "id": "new-element", "beforeId": "existing-element"}
                ],
                "revision": 2
            }
            """.trimIndent()

        val message = parser.parseMessage(json) as? PatchMessage
        assertNotNull(message)

        val patch = message!!.patches[0]
        assertEquals(PatchType.INSERT, patch.type)
        assertEquals("container", patch.parentId)
        assertEquals("new-element", patch.id)
        assertEquals("existing-element", patch.beforeId)
    }

    @Test
    fun `parse unknown message type returns null`() {
        val json =
            """
            {
                "type": "unknownType",
                "data": "test"
            }
            """.trimIndent()

        val message = parser.parseMessage(json)
        assertNull(message)
    }

    @Test
    fun `parse invalid json returns null`() {
        val json = "{ invalid json }"
        val message = parser.parseMessage(json)
        assertNull(message)
    }

    // Session-related message tests

    @Test
    fun `serialize hello message without sessionId`() {
        val message = HelloMessage(
            props = mapOf("platform" to "android", "version" to "1.0")
        )

        val json = parser.serializeMessage(message)
        assertTrue(json.contains("\"type\":\"hello\""))
        assertTrue(json.contains("\"platform\":\"android\""))
        assertTrue(json.contains("\"version\":\"1.0\""))
    }

    @Test
    fun `serialize hello message with sessionId`() {
        val message = HelloMessage(
            sessionId = "session-123",
            props = mapOf("platform" to "android")
        )

        val json = parser.serializeMessage(message)
        assertTrue(json.contains("\"type\":\"hello\""))
        assertTrue(json.contains("\"sessionId\":\"session-123\""))
    }

    @Test
    fun `parse sessionAck message for new session`() {
        val json = """
            {
                "type": "sessionAck",
                "sessionId": "new-session-456",
                "isNew": true,
                "isRestored": false
            }
        """.trimIndent()

        val message = parser.parseMessage(json) as? SessionAckMessage
        assertNotNull(message)
        assertEquals("sessionAck", message!!.type)
        assertEquals("new-session-456", message.sessionId)
        assertTrue(message.isNew)
        assertFalse(message.isRestored)
    }

    @Test
    fun `parse sessionAck message for restored session`() {
        val json = """
            {
                "type": "sessionAck",
                "sessionId": "existing-session-789",
                "isNew": false,
                "isRestored": true
            }
        """.trimIndent()

        val message = parser.parseMessage(json) as? SessionAckMessage
        assertNotNull(message)
        assertEquals("existing-session-789", message!!.sessionId)
        assertFalse(message.isNew)
        assertTrue(message.isRestored)
    }

    @Test
    fun `parse sessionExpired message with ttl reason`() {
        val json = """
            {
                "type": "sessionExpired",
                "sessionId": "expired-session-000",
                "reason": "ttl"
            }
        """.trimIndent()

        val message = parser.parseMessage(json) as? SessionExpiredMessage
        assertNotNull(message)
        assertEquals("sessionExpired", message!!.type)
        assertEquals("expired-session-000", message.sessionId)
        assertEquals("ttl", message.reason)
    }

    @Test
    fun `parse sessionExpired message with kicked reason`() {
        val json = """
            {
                "type": "sessionExpired",
                "sessionId": "kicked-session",
                "reason": "kicked"
            }
        """.trimIndent()

        val message = parser.parseMessage(json) as? SessionExpiredMessage
        assertNotNull(message)
        assertEquals("kicked", message!!.reason)
    }

    @Test
    fun `parse sessionExpired message with manual reason`() {
        val json = """
            {
                "type": "sessionExpired",
                "sessionId": "manual-session",
                "reason": "manual"
            }
        """.trimIndent()

        val message = parser.parseMessage(json) as? SessionExpiredMessage
        assertNotNull(message)
        assertEquals("manual", message!!.reason)
    }
}
