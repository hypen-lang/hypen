package space.hypen.renderer.device

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Golden bytes from engine-compatibility-tests/fixtures/device/frames.json
 * (12-byte little-endian header, u32 seq), produced by the Rust reference codec.
 */
class DeviceFramesTest {
    private fun hexToBytes(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

    private fun encodeHex(header: FrameHeader, payload: ByteArray = ByteArray(0)): String = hex(DeviceFrames.encode(header, payload))

    @Test
    fun `header golden bytes`() {
        assertEquals("010000000100000000000000", encodeHex(FrameHeader(channel = 0, requestId = 1, seq = 0)))
        assertEquals("010003001100000002000000", encodeHex(FrameHeader(channel = 3, requestId = 17, seq = 2)))
        assertEquals(
            "0100ffffffffffffffffffff",
            encodeHex(FrameHeader(channel = 65535, requestId = 4_294_967_295, seq = 4_294_967_295)),
        )
        assertEquals(12, DeviceFrames.encode(FrameHeader(channel = 0, requestId = 1, seq = 0)).size)
    }

    @Test
    fun `header plus payload golden bytes`() {
        val payload = "hello-hypen-photo".toByteArray()
        assertEquals(
            "01000000010000000000000068656c6c6f2d687970656e2d70686f746f",
            encodeHex(FrameHeader(channel = 0, requestId = 1, seq = 0), payload),
        )
    }

    @Test
    fun `decode round trips golden frames`() {
        val frame = hexToBytes("0100ffffffffffffffffffff")
        val ok = DeviceFrames.decode(frame) as FrameDecode.Ok
        assertEquals(FrameHeader(channel = 65535, requestId = 4_294_967_295, seq = 4_294_967_295), ok.header)
        assertEquals(0, ok.payload.size)

        val withPayload = DeviceFrames.decode(hexToBytes("01000000010000000000000068656c6c6f2d687970656e2d70686f746f")) as FrameDecode.Ok
        assertEquals(1L, withPayload.header.requestId)
        assertArrayEquals("hello-hypen-photo".toByteArray(), withPayload.payload)
    }

    @Test
    fun `short header is dropped, bad version and flags are violations`() {
        assertEquals(FrameDecode.Short, DeviceFrames.decode(hexToBytes("0100000001000000000000")))
        assertEquals(FrameDecode.Violation("version 9"), DeviceFrames.decode(hexToBytes("090000000100000000000000")))
        assertEquals(FrameDecode.Violation("flags 1"), DeviceFrames.decode(hexToBytes("010100000100000000000000")))
    }

    @Test
    fun `header fields are range checked`() {
        val bad = listOf(
            { FrameHeader(channel = 65536, requestId = 1, seq = 0) },
            { FrameHeader(channel = 0, requestId = 4_294_967_296, seq = 0) },
            { FrameHeader(channel = 0, requestId = 1, seq = 4_294_967_296) },
            { FrameHeader(channel = 0, requestId = 1, seq = -1) },
        )
        for (make in bad) {
            assertTrue(runCatching(make).exceptionOrNull() is IllegalArgumentException)
        }
    }
}

/**
 * Replays every case of `engine-compatibility-tests/fixtures/device/frames.json`:
 * golden header bytes both ways, the invalid-frame classification (short:
 * dropped; bad version/flags: a connection-level violation, decision D3),
 * and the receiver-side sequence rule.
 */
class DeviceFramesConformanceTest {
    @Suppress("UNCHECKED_CAST")
    private val doc = CompatFixtures.json("fixtures/device/frames.json")

    private fun bytes(hex: String) = CorpusText.hexToBytes(hex)

    @Test
    fun `golden frames encode and decode exactly`() {
        @Suppress("UNCHECKED_CAST")
        val frames = doc["frames"] as List<Map<String, Any?>>
        assertTrue(frames.size >= 4)
        for (f in frames) {
            @Suppress("UNCHECKED_CAST")
            val h = f["header"] as Map<String, Any?>
            val header = FrameHeader(
                version = (h["version"] as Long).toInt(),
                flags = (h["flags"] as Long).toInt(),
                channel = (h["channel"] as Long).toInt(),
                requestId = h["requestId"] as Long,
                seq = h["seq"] as Long,
            )
            val payload = (f["payloadHex"] as String?)?.let(::bytes) ?: ByteArray(0)
            assertEquals(f["hex"], hex(DeviceFrames.encode(header, payload)))
            val ok = DeviceFrames.decode(bytes(f["hex"] as String)) as FrameDecode.Ok
            assertEquals(header, ok.header)
            assertTrue(ok.payload.contentEquals(payload))
        }
    }

    @Test
    fun `invalid frames are classified - short dropped, bad version or flags a violation`() {
        @Suppress("UNCHECKED_CAST")
        val invalid = doc["invalid"] as List<Map<String, Any?>>
        assertTrue(invalid.size >= 9)
        for (f in invalid) {
            val decoded = DeviceFrames.decode(bytes(f["hex"] as String))
            when (val reason = f["reason"] as String) {
                "shortHeader" -> assertEquals(reason, FrameDecode.Short, decoded)
                else -> assertTrue("$reason: $decoded", reason.startsWith("violation-") && decoded is FrameDecode.Violation)
            }
        }
    }

    @Test
    fun `receiver sequence rule matches every case`() {
        @Suppress("UNCHECKED_CAST")
        val cases = (doc["sequences"] as Map<String, Any?>)["cases"] as List<Map<String, Any?>>
        assertTrue(cases.size >= 12)
        for (c in cases) {
            val tracker = FrameSequence(lossless = c["overflow"] == "pause")
            @Suppress("UNCHECKED_CAST")
            val seqs = c["seqs"] as List<Long>
            val accepted = seqs.map(tracker::accept)
            val valid = c["valid"] == true
            if (valid) {
                assertTrue("${c["name"]}: $accepted", accepted.all { it })
            } else {
                assertTrue("${c["name"]}: $accepted", accepted.dropLast(1).all { it } && !accepted.last())
            }
        }
    }
}
