@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package space.hypen.renderer

import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import space.hypen.renderer.device.DeviceHost
import space.hypen.renderer.device.DeviceHostConfig
import space.hypen.renderer.device.DeviceTransport
import space.hypen.renderer.model.DeviceWireMessage
import space.hypen.renderer.model.HelloMessage
import space.hypen.renderer.model.SessionAckMessage
import space.hypen.renderer.remote.MoshiMessageParser
import space.hypen.renderer.remote.SessionInfo
import space.hypen.renderer.remote.SessionOptions

/** Device-plane messages through the renderer's real Moshi parser (RFC 001 §2.1/§2.2). */
class DeviceMessageParserTest {
    private val parser = MoshiMessageParser()

    @Test
    fun `legacy hello is unchanged when no device host is attached`() {
        val json = parser.serializeMessage(HelloMessage(sessionId = "s1"))
        assertFalse(json.contains("device"))
    }

    @Test
    fun `hello carries the device advertisement`() {
        val host = DeviceHost(DeviceHostConfig("wss://a:443"), emptyList(), StandardTestDispatcher())
        val json = parser.serializeMessage(HelloMessage(device = host.advertisement()!!))
        assertTrue(
            json,
            json.contains(
                "\"device\":{\"protocolVersions\":[1],\"binary\":true," +
                    "\"capabilities\":[{\"name\":\"core.capabilities\",\"versions\":[1]}]}",
            ),
        )
        host.dispose()
    }

    @Test
    fun `sessionAck device and device messages parse, and replies serialize`() = runTest {
        val ack = parser.parseMessage(
            """{"type":"sessionAck","sessionId":"x","isNew":true,"isRestored":false,
               "device":{"protocolVersion":1,"binary":true,"capabilities":[{"name":"core.capabilities","version":1}]}}""",
        ) as SessionAckMessage
        val req = parser.parseMessage(
            """{"type":"deviceRequest","id":6,"capability":"core.capabilities","version":1,"owner":{"connection":true},
               "lifetime":"connection","timeoutMs":86400000,"initialCredit":8,"params":{}}""",
        ) as DeviceWireMessage
        assertEquals("deviceRequest", req.type)

        val sent = mutableListOf<String>()
        val host = DeviceHost(DeviceHostConfig("wss://a:443"), emptyList(), StandardTestDispatcher(testScheduler))
        val connection = host.openConnection(object : DeviceTransport {
            override fun sendMessage(message: Map<String, Any?>) {
                sent += parser.serializeMessage(DeviceWireMessage(message["type"] as String, message))
            }

            override fun sendBinary(frame: ByteArray) = Unit

            override fun close(code: Int, reason: String) = Unit
        })!!
        connection.helloAdvertisement()
        connection.onAck(ack.device)
        connection.handleMessage(req.body)
        connection.handleMessage(
            (parser.parseMessage("""{"type":"deviceEvent","id":6,"control":{"renewLease":1}}""") as DeviceWireMessage).body,
        )
        runCurrent()
        assertTrue(connection.isEnabled)
        assertEquals(
            listOf(
                """{"type":"deviceEvent","id":6,"event":{"capabilities":[{"name":"core.capabilities","versions":[1]}]}}""",
                """{"type":"deviceEvent","id":6,"control":{"leaseAck":1}}""",
            ),
            sent,
        )
        host.dispose()
    }

    @Test
    fun `sessionAck keeps a string resumeToken and decodes device strictly`() {
        val ack = parser.parseMessage(
            """{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false,"resumeToken":"tok-1",
               "device":{"protocolVersion":1,"binary":true,"capabilities":[{"name":"core.capabilities","version":1}]}}""",
        ) as SessionAckMessage
        assertEquals("tok-1", ack.resumeToken)
        assertEquals(null, ack.deviceMalformed)
        // Integers stay integral tokens (Long), not Moshi doubles.
        assertEquals(1L, ack.device!!["protocolVersion"])
        assertFalse(ack.toString().contains("tok-1"))

        val noToken = parser.parseMessage("""{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false,"resumeToken":7}""") as SessionAckMessage
        assertEquals(null, noToken.resumeToken)
        val empty = parser.parseMessage("""{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false,"resumeToken":""}""") as SessionAckMessage
        assertEquals(null, empty.resumeToken)
    }

    @Test
    fun `a duplicate key in sessionAck device disables the plane without failing the session`() {
        val ack = parser.parseMessage(
            """{"type":"sessionAck","sessionId":"s1","isNew":false,"isRestored":true,
               "device":{"protocolVersion":1,"binary":true,"binary":false,"capabilities":[]}}""",
        ) as SessionAckMessage
        assertEquals("s1", ack.sessionId)
        assertTrue(ack.isRestored)
        assertEquals(null, ack.device)
        assertTrue(ack.deviceMalformed!!.contains("duplicate key 'binary'"))

        val twice = parser.parseMessage(
            """{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false,"device":{},"device":{}}""",
        ) as SessionAckMessage
        assertTrue(twice.deviceMalformed!!, twice.deviceMalformed!!.contains("duplicate key 'device'"))
        // Any JSON-limit breach in the ack text disables device (the session itself is fine).
        val float = parser.parseMessage(
            """{"type":"sessionAck","sessionId":"s1","isNew":true,"isRestored":false,"device":{"protocolVersion":1.0,"binary":true,"capabilities":[]}}""",
        ) as SessionAckMessage
        assertEquals("s1", float.sessionId)
        assertEquals(null, float.device)
        assertTrue(float.deviceMalformed!!, float.deviceMalformed!!.contains("not an integer token"))
    }

    @Test
    fun `hello carries the resume token only when set, and never prints it`() {
        val json = parser.serializeMessage(HelloMessage(sessionId = "s1", resumeToken = "secret-token"))
        assertTrue(json, json.contains("\"resumeToken\":\"secret-token\""))
        assertFalse(parser.serializeMessage(HelloMessage(sessionId = "s1")).contains("resumeToken"))
        assertFalse(HelloMessage(sessionId = "s1", resumeToken = "secret-token").toString().contains("secret-token"))
        assertFalse(SessionInfo("s1", true, false, resumeToken = "secret-token").toString().contains("secret-token"))
        assertFalse(SessionOptions(id = "s1", resumeToken = "secret-token").toString().contains("secret-token"))
    }
}
