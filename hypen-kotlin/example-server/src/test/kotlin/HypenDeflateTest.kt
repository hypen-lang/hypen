package space.hypen

import io.ktor.server.application.install
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.netty.NettyApplicationEngine
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketDeflateExtension
import io.ktor.websocket.extensionOrNull
import kotlinx.coroutines.runBlocking
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.net.Socket
import java.util.Base64
import java.util.zip.Inflater
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The example server's permessage-deflate setup against a real Ktor/Netty
 * server and raw client handshakes (what browsers and OkHttp offer):
 * [HypenDeflate] always answers `server_no_context_takeover;
 * client_no_context_takeover` and really compresses each message on its
 * own, while Ktor's plain `WebSocketDeflateExtension` — even with both
 * no-context-takeover settings on — echoes only what the client offered.
 */
class HypenDeflateTest {
    private val payload = "{\"type\":\"patch\",\"patches\":[" + (1..60).joinToString(",") { "{\"op\":\"setProp\",\"id\":$it}" } + "]}"
    private var server: EmbeddedServer<NettyApplicationEngine, NettyApplicationEngine.Configuration>? = null
    @Volatile private var negotiatedSeen: String? = null

    @AfterTest
    fun stop() {
        server?.stop(0, 0)
    }

    private fun start(hypen: Boolean): Int {
        val s = embeddedServer(Netty, port = 0, host = "127.0.0.1") {
            install(WebSockets) {
                extensions {
                    if (hypen) {
                        install(HypenDeflate)
                    } else {
                        install(WebSocketDeflateExtension) {
                            clientNoContextTakeOver = true
                            serverNoContextTakeOver = true
                        }
                    }
                }
            }
            routing {
                webSocket("/ws") {
                    negotiatedSeen = extensionOrNull(HypenDeflate)?.negotiated
                    // The same message twice: with context takeover the second
                    // would be encoded against the first's history.
                    send(Frame.Text(payload))
                    send(Frame.Text(payload))
                    for (frame in incoming) { /* drain until the client goes away */ }
                }
            }
        }.start(wait = false)
        server = s
        return runBlocking { s.engine.resolvedConnectors().first().port }
    }

    private class Handshake(val status: String, val extensions: String?, val input: DataInputStream, val socket: Socket)

    private fun handshake(port: Int, offer: String): Handshake {
        val socket = Socket("127.0.0.1", port)
        socket.soTimeout = 10_000
        val key = Base64.getEncoder().encodeToString(ByteArray(16) { it.toByte() })
        socket.getOutputStream().write(
            ("GET /ws HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: $offer\r\n\r\n").toByteArray(),
        )
        val input = DataInputStream(socket.getInputStream())
        val lines = mutableListOf<String>()
        val line = StringBuilder()
        while (true) {
            val c = input.readUnsignedByte()
            if (c == '\n'.code) {
                val l = line.toString().trimEnd('\r')
                line.clear()
                if (l.isEmpty()) break
                lines += l
            } else {
                line.append(c.toChar())
            }
        }
        val ext = lines.drop(1).firstOrNull { it.startsWith("Sec-WebSocket-Extensions:", ignoreCase = true) }
            ?.substringAfter(':')?.trim()
        return Handshake(lines.first(), ext, input, socket)
    }

    /** One unmasked server frame: (rsv1, payload). */
    private fun readFrame(input: DataInputStream): Pair<Boolean, ByteArray> {
        val b0 = input.readUnsignedByte()
        val b1 = input.readUnsignedByte()
        var len = (b1 and 0x7f).toLong()
        if (len == 126L) len = input.readUnsignedShort().toLong() else if (len == 127L) len = input.readLong()
        val data = ByteArray(len.toInt())
        input.readFully(data)
        return ((b0 and 0x40) != 0) to data
    }

    /** Inflate one message with a FRESH inflater (no shared history). */
    private fun inflateAlone(data: ByteArray): String {
        val inflater = Inflater(true)
        inflater.setInput(data + byteArrayOf(0, 0, 0xff.toByte(), 0xff.toByte()))
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (!inflater.needsInput()) {
            val n = inflater.inflate(buf)
            if (n == 0) break
            out.write(buf, 0, n)
        }
        inflater.end()
        return out.toString(Charsets.UTF_8)
    }

    private fun params(ext: String?): Set<String> =
        ext.orEmpty().split(';').map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()

    @Test
    fun `HypenDeflate answers both no-context-takeover params to browser and OkHttp offers`() {
        val port = start(hypen = true)
        for (offer in listOf("permessage-deflate; client_max_window_bits", "permessage-deflate")) {
            val hs = handshake(port, offer)
            try {
                assertTrue(hs.status.contains("101"), hs.status)
                val p = params(hs.extensions)
                assertTrue("permessage-deflate" in p, "$offer -> ${hs.extensions}")
                assertTrue("server_no_context_takeover" in p, "$offer -> ${hs.extensions}")
                assertTrue("client_no_context_takeover" in p, "$offer -> ${hs.extensions}")
                // One well-formed element: no duplicate parameters, no stray
                // comma-separated "extensions" (Ktor's own serialization).
                assertEquals(p.size, hs.extensions!!.split(';').size, "no duplicate parameters: ${hs.extensions}")
                assertFalse(hs.extensions.contains(','), "one extension element: ${hs.extensions}")
                // Each message is compressed on its own: a fresh inflater
                // decodes both, including the repeat.
                repeat(2) {
                    val (rsv1, data) = readFrame(hs.input)
                    assertTrue(rsv1, "expected a compressed frame")
                    assertEquals(payload, inflateAlone(data))
                }
                // What the route hands HypenServer.openConnection.
                assertEquals(
                    setOf("permessage-deflate", "server_no_context_takeover", "client_no_context_takeover"),
                    params(negotiatedSeen),
                )
            } finally {
                hs.socket.close()
            }
        }
    }

    @Test
    fun `plain WebSocketDeflateExtension echoes only the client's params (why HypenDeflate exists)`() {
        val port = start(hypen = false)
        val hs = handshake(port, "permessage-deflate; client_max_window_bits")
        try {
            assertTrue(hs.status.contains("101"), hs.status)
            val p = params(hs.extensions)
            assertTrue("permessage-deflate" in p, "${hs.extensions}")
            assertFalse(
                "server_no_context_takeover" in p && "client_no_context_takeover" in p,
                "Ktor now negotiates no context takeover itself (${hs.extensions}) — HypenDeflate may be unnecessary",
            )
        } finally {
            hs.socket.close()
        }
        // Even when the client asks for both, Ktor writes the parameters as
        // comma-separated "extensions" (`permessage-deflate , a,b`).
        val asked = handshake(port, "permessage-deflate; server_no_context_takeover; client_no_context_takeover")
        try {
            assertTrue(asked.status.contains("101"), asked.status)
            assertTrue(
                asked.extensions.orEmpty().contains(','),
                "Ktor now writes extension parameters correctly (${asked.extensions}) — HypenDeflate's name workaround may be unnecessary",
            )
        } finally {
            asked.socket.close()
        }
    }
}
