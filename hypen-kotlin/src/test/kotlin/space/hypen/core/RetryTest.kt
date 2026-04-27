package space.hypen.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class RetryTest {

    @Test
    fun `retry succeeds on first attempt`() = runBlocking {
        var calls = 0
        val result = retry { calls++; "ok" }
        assertEquals("ok", result)
        assertEquals(1, calls)
    }

    @Test
    fun `retry succeeds after transient failures`() = runBlocking {
        var calls = 0
        val result = retry(RetryOptions(maxAttempts = 3, delayMs = 10)) {
            calls++
            if (calls < 3) throw RuntimeException("fail #$calls")
            "recovered"
        }
        assertEquals("recovered", result)
        assertEquals(3, calls)
    }

    @Test
    fun `retry throws after exhausting attempts`() = runBlocking {
        var calls = 0
        val ex = assertThrows<RuntimeException> {
            retry(RetryOptions(maxAttempts = 3, delayMs = 10)) {
                calls++
                throw RuntimeException("always fails")
            }
        }
        assertEquals(3, calls)
        assertEquals("always fails", ex.message)
    }

    @Test
    fun `retry respects shouldRetry predicate`() = runBlocking {
        var calls = 0
        val ex = assertThrows<java.io.IOException> {
            retry(RetryOptions(
                maxAttempts = 5,
                delayMs = 10,
                shouldRetry = { it is RuntimeException }
            )) {
                calls++
                throw java.io.IOException("not retryable")
            }
        }
        assertEquals(1, calls)
        assertEquals("not retryable", ex.message)
    }

    @Test
    fun `retry calls onRetry callback`() = runBlocking {
        val retryAttempts = mutableListOf<Int>()
        retry(RetryOptions(
            maxAttempts = 3,
            delayMs = 10,
            onRetry = { attempt, _, _ -> retryAttempts.add(attempt) }
        )) {
            if (retryAttempts.size < 2) throw RuntimeException("fail")
            "ok"
        }
        assertEquals(listOf(1, 2), retryAttempts)
    }

    @Test
    fun `retry does not catch CancellationException`() {
        assertThrows<CancellationException> {
            runBlocking {
                retry(RetryOptions(maxAttempts = 3, delayMs = 10)) {
                    throw CancellationException("cancelled")
                }
            }
        }
    }

    // -- retryResult --

    @Test
    fun `retryResult returns success`() = runBlocking {
        val result = retryResult { 42 }
        assertTrue(result.isSuccess)
        assertEquals(42, result.getOrNull())
    }

    @Test
    fun `retryResult returns failure after exhaustion`() = runBlocking {
        val result = retryResult(RetryOptions(maxAttempts = 2, delayMs = 10)) {
            throw RuntimeException("boom")
        }
        assertTrue(result.isFailure)
        assertEquals("boom", result.exceptionOrNull()?.message)
    }

    // -- withRetry --

    @Test
    fun `withRetry wraps function with retry logic`() = runBlocking {
        var calls = 0
        val resilient = withRetry(RetryOptions(maxAttempts = 3, delayMs = 10)) { input: String ->
            calls++
            if (calls < 2) throw RuntimeException("fail")
            input.uppercase()
        }
        val result = resilient("hello")
        assertEquals("HELLO", result)
        assertEquals(2, calls)
    }

    // -- Backoff calculation --

    @Test
    fun `exponential backoff doubles each attempt`() {
        val options = RetryOptions(delayMs = 1000, backoff = BackoffStrategy.EXPONENTIAL, jitter = 0.0)
        assertEquals(1000, calculateDelay(1, options))
        assertEquals(2000, calculateDelay(2, options))
        assertEquals(4000, calculateDelay(3, options))
        assertEquals(8000, calculateDelay(4, options))
    }

    @Test
    fun `linear backoff increases linearly`() {
        val options = RetryOptions(delayMs = 1000, backoff = BackoffStrategy.LINEAR, jitter = 0.0)
        assertEquals(1000, calculateDelay(1, options))
        assertEquals(2000, calculateDelay(2, options))
        assertEquals(3000, calculateDelay(3, options))
    }

    @Test
    fun `no backoff uses fixed delay`() {
        val options = RetryOptions(delayMs = 500, backoff = BackoffStrategy.NONE, jitter = 0.0)
        assertEquals(500, calculateDelay(1, options))
        assertEquals(500, calculateDelay(2, options))
        assertEquals(500, calculateDelay(5, options))
    }

    @Test
    fun `delay is capped at maxDelayMs`() {
        val options = RetryOptions(
            delayMs = 1000,
            backoff = BackoffStrategy.EXPONENTIAL,
            maxDelayMs = 5000,
            jitter = 0.0
        )
        // 2^9 * 1000 = 512000, but capped at 5000
        assertEquals(5000, calculateDelay(10, options))
    }

    @Test
    fun `jitter adds randomization within range`() {
        val options = RetryOptions(delayMs = 1000, backoff = BackoffStrategy.NONE, jitter = 0.5, maxDelayMs = 10000)
        // With 50% jitter on 1000ms, delay should be in [500, 1500]
        repeat(50) {
            val d = calculateDelay(1, options)
            assertTrue(d in 500..1500, "delay $d out of expected jitter range [500, 1500]")
        }
    }

    // -- RetryConditions --

    @Test
    fun `networkErrors matches connection exceptions`() {
        assertTrue(RetryConditions.networkErrors(java.net.ConnectException("Connection refused")))
        assertTrue(RetryConditions.networkErrors(java.net.SocketTimeoutException("timed out")))
        assertTrue(RetryConditions.networkErrors(RuntimeException("network unreachable")))
    }

    @Test
    fun `any combines conditions with OR`() {
        val combined = RetryConditions.any(
            { it is IllegalStateException },
            { it is IllegalArgumentException }
        )
        assertTrue(combined(IllegalStateException("a")))
        assertTrue(combined(IllegalArgumentException("b")))
        assertTrue(!combined(RuntimeException("c")))
    }

    @Test
    fun `all combines conditions with AND`() {
        val combined = RetryConditions.all(
            { it.message?.contains("retry") == true },
            { it is RuntimeException }
        )
        assertTrue(combined(RuntimeException("please retry")))
        assertTrue(!combined(RuntimeException("nope")))
        assertTrue(!combined(Exception("please retry")))
    }

    // -- Presets --

    @Test
    fun `presets have expected values`() {
        assertEquals(10, RetryPresets.aggressive.maxAttempts)
        assertEquals(3, RetryPresets.conservative.maxAttempts)
        assertEquals(5, RetryPresets.fast.maxAttempts)
        assertEquals(10, RetryPresets.websocket.maxAttempts)
        assertEquals(BackoffStrategy.LINEAR, RetryPresets.conservative.backoff)
        assertEquals(0.0, RetryPresets.fast.jitter)
    }
}
