package space.hypen.renderer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Activity recreation must not drop the socket or in-flight device work
 * (review finding #11): the retained-session registry behind `HypenApp`.
 */
class HypenSessionRetentionTest {
    private class Clock {
        var now = 0L
        val timers = mutableListOf<Pair<Long, () -> Unit>>()

        fun schedule(delay: Long, action: () -> Unit): () -> Unit {
            val t = (now + delay) to action
            timers += t
            return { timers.remove(t) }
        }

        fun advance(ms: Long) {
            val until = now + ms
            while (true) {
                val due = timers.filter { it.first <= until }.minByOrNull { it.first } ?: break
                timers.remove(due)
                now = due.first
                due.second()
            }
            now = until
        }
    }

    private class Session(val name: String) {
        var destroyed = false
        var busy = false
    }

    private fun registry(clock: Clock) = RetainedSessions<String, Session>(
        retainMs = 60_000,
        maxRetainMs = 600_000,
        pollMs = 5_000,
        clock = { clock.now },
        schedule = clock::schedule,
        isBusy = { it.busy },
        destroy = { it.destroyed = true },
    )

    @Test
    fun `a session released for recreation is re-acquired by the replacement`() {
        val clock = Clock()
        val r = registry(clock)
        val first = r.acquire("wss://a") { Session("1") }
        r.release(first, retain = true) // Activity destroyed for a configuration change
        clock.advance(1_000)
        val again = r.acquire("wss://a") { Session("2") }
        assertSame(first, again)
        assertTrue(!first.destroyed)
        clock.advance(120_000) // the retention timer was cancelled on re-acquire
        assertTrue(!first.destroyed)
    }

    @Test
    fun `a session is destroyed at once when not retained, and after the grace when nobody comes back`() {
        val clock = Clock()
        val r = registry(clock)
        val left = r.acquire("k") { Session("left") }
        r.release(left, retain = false) // the screen removed HypenApp, or the user finished the Activity
        assertTrue(left.destroyed)

        val orphan = r.acquire("k") { Session("orphan") }
        assertNotSame(left, orphan)
        r.release(orphan, retain = true)
        clock.advance(59_999)
        assertTrue(!orphan.destroyed)
        clock.advance(1)
        assertTrue(orphan.destroyed)
        assertEquals(0, r.size)
    }

    @Test
    fun `retention is extended while a system picker is up, but bounded`() {
        val clock = Clock()
        val r = registry(clock)
        val s = r.acquire("k") { Session("s") }
        s.busy = true // a device operation has the OS presenting
        r.release(s, retain = true)
        clock.advance(300_000)
        assertTrue(!s.destroyed)
        s.busy = false // the pick finished (or was cancelled)
        clock.advance(5_000)
        assertTrue(s.destroyed)

        val stuck = r.acquire("k") { Session("stuck") }
        stuck.busy = true
        r.release(stuck, retain = true)
        clock.advance(600_000)
        assertTrue(stuck.destroyed) // hard cap
    }

    @Test
    fun `a session in use is never shared with a second composition`() {
        val clock = Clock()
        val r = registry(clock)
        val a = r.acquire("k") { Session("a") }
        val b = r.acquire("k") { Session("b") }
        assertNotSame(a, b)
        r.release(a, retain = true)
        assertSame(a, r.acquire("k") { Session("c") })
    }
}
