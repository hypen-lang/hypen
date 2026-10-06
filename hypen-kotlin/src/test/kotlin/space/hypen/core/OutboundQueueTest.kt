package space.hypen.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Test
import java.util.Collections
import kotlin.random.Random
import kotlin.test.assertEquals

/**
 * The per-connection [OutboundQueue]'s `buffered` — what the device broker
 * paces bulk frames against (RFC 001 §2.3) — counts UTF-8 WIRE bytes of
 * every queued text (not UTF-16 chars), every queued frame, and the
 * transport's own buffer when the transport exposes it.
 */
class OutboundQueueTest {
    @Test
    fun `utf8Length is exactly the encoded size`() {
        val samples = listOf(
            "", "ascii", "é", "€", "日本語", "😀", "a😀b", "\u007f\u0080߿ࠀ￿",
            "\ud83d", "\ude00", "x\ud83dy", "\ude00\ud83d", "\ud83d😀",
        )
        for (s in samples) assertEquals(s.toByteArray(Charsets.UTF_8).size.toLong(), OutboundQueue.utf8Length(s), "'$s'")
        val rnd = Random(42)
        repeat(2_000) {
            val s = buildString { repeat(rnd.nextInt(0, 40)) { append(rnd.nextInt(0, 0x10000).toChar()) } }
            assertEquals(s.toByteArray(Charsets.UTF_8).size.toLong(), OutboundQueue.utf8Length(s), "random #$it")
        }
    }

    private class GatedTransport : HypenTransport {
        val gate = CompletableDeferred<Unit>()
        val written: MutableList<Any> = Collections.synchronizedList(mutableListOf())
        @Volatile var own = 0L

        override suspend fun sendText(text: String) {
            gate.await()
            written += text
        }

        override suspend fun sendBinary(bytes: ByteArray) {
            gate.await()
            written += bytes
        }

        override suspend fun close(code: Int, reason: String) {}

        override fun bufferedAmount(): Long = own
    }

    @Test
    fun `buffered counts UTF-8 wire bytes of everything queued plus the transport buffer`() = runBlocking {
        val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        try {
            val t = GatedTransport()
            val q = OutboundQueue(t, scope) { _, e -> throw e }
            val accented = "é".repeat(1_000) // 1 000 chars, 2 000 bytes
            val emoji = "😀".repeat(10) // 20 chars, 40 bytes
            val cjk = "日本".repeat(5) // 10 chars, 30 bytes
            q.sendText(accented)
            q.sendText(emoji)
            q.sendBinary(ByteArray(100))
            q.sendText(cjk)
            assertEquals(2_000L + 40 + 100 + 30, q.buffered, "UTF-8 bytes, not UTF-16 chars")
            t.own = 777
            assertEquals(2_000L + 40 + 100 + 30 + 777, q.buffered, "the transport's own buffer is included")
            t.gate.complete(Unit)
            withTimeout(5_000) { while (t.written.size < 4) delay(5) }
            withTimeout(5_000) { while (q.buffered != 777L) delay(5) }
            t.own = 0
            assertEquals(0L, q.buffered)
            t.own = -5
            assertEquals(0L, q.buffered, "a bogus negative transport figure never lowers the count")
        } finally {
            scope.cancel()
        }
    }
}
