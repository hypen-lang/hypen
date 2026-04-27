package space.hypen.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * Backoff strategy for retry delays.
 */
enum class BackoffStrategy {
    /** Delay = delayMs * 2^(attempt-1). Example at 1000ms: 1s, 2s, 4s, 8s... */
    EXPONENTIAL,
    /** Delay = delayMs * attempt. Example at 1000ms: 1s, 2s, 3s, 4s... */
    LINEAR,
    /** Fixed delay = delayMs for every retry. */
    NONE
}

/**
 * Configuration for retry behavior.
 *
 * ```kotlin
 * retry(RetryOptions(maxAttempts = 5, backoff = BackoffStrategy.EXPONENTIAL)) {
 *     fetchRemoteData()
 * }
 * ```
 */
data class RetryOptions(
    /** Maximum number of attempts (default: 3). */
    val maxAttempts: Int = 3,
    /** Initial delay in milliseconds (default: 1000). */
    val delayMs: Long = 1000,
    /** Backoff strategy (default: EXPONENTIAL). */
    val backoff: BackoffStrategy = BackoffStrategy.EXPONENTIAL,
    /** Maximum delay cap in milliseconds (default: 30000). */
    val maxDelayMs: Long = 30000,
    /** Jitter factor 0.0-1.0 to randomize delays (default: 0.1). */
    val jitter: Double = 0.1,
    /** Callback invoked on each retry attempt. */
    val onRetry: ((attempt: Int, error: Throwable, nextDelayMs: Long) -> Unit)? = null,
    /** Predicate to determine if an error is retryable. If null, all errors are retried. */
    val shouldRetry: ((Throwable) -> Boolean)? = null
)

/**
 * Retry a suspend function with configurable backoff.
 *
 * Throws the last error if all attempts fail.
 * [CancellationException] is never retried.
 *
 * ```kotlin
 * val result = retry { fetchData() }
 *
 * val result = retry(RetryOptions(maxAttempts = 5, backoff = BackoffStrategy.LINEAR)) {
 *     connectToServer()
 * }
 *
 * val result = retry(RetryPresets.websocket) {
 *     openWebSocket(url)
 * }
 * ```
 */
suspend fun <T> retry(
    options: RetryOptions = RetryOptions(),
    block: suspend () -> T
): T {
    require(options.maxAttempts >= 1) { "maxAttempts must be >= 1" }
    require(options.delayMs >= 0) { "delayMs must be >= 0" }
    require(options.jitter in 0.0..1.0) { "jitter must be between 0.0 and 1.0" }

    var lastError: Throwable? = null

    for (attempt in 1..options.maxAttempts) {
        try {
            return block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            lastError = e

            // Check if we should retry this error
            if (options.shouldRetry != null && !options.shouldRetry.invoke(e)) {
                throw e
            }

            // If this was the last attempt, throw
            if (attempt == options.maxAttempts) {
                throw e
            }

            val nextDelay = calculateDelay(attempt, options)
            options.onRetry?.invoke(attempt, e, nextDelay)
            delay(nextDelay)
        }
    }

    // Should not reach here, but just in case
    throw lastError ?: IllegalStateException("Retry exhausted with no error")
}

/**
 * Retry a suspend function, returning a [Result] instead of throwing.
 *
 * ```kotlin
 * val result = retryResult { fetchData() }
 * result.onSuccess { data -> println("Got $data") }
 * result.onFailure { error -> println("All retries failed: $error") }
 * ```
 */
suspend fun <T> retryResult(
    options: RetryOptions = RetryOptions(),
    block: suspend () -> T
): Result<T> {
    return try {
        Result.success(retry(options, block))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        Result.failure(e)
    }
}

/**
 * Create a retryable version of a suspend function.
 *
 * ```kotlin
 * val resilientFetch = withRetry(RetryPresets.aggressive) { url: String ->
 *     httpClient.get(url)
 * }
 * val response = resilientFetch("https://api.example.com/data")
 * ```
 */
fun <A, T> withRetry(
    options: RetryOptions = RetryOptions(),
    block: suspend (A) -> T
): suspend (A) -> T = { arg ->
    retry(options) { block(arg) }
}

/**
 * Create a retryable version of a no-arg suspend function.
 */
fun <T> withRetry(
    options: RetryOptions = RetryOptions(),
    block: suspend () -> T
): suspend () -> T = {
    retry(options) { block() }
}

/**
 * Predefined retry conditions for common error categories.
 */
object RetryConditions {

    /**
     * Retries on network-related errors (connection refused, timeout, socket errors).
     */
    val networkErrors: (Throwable) -> Boolean = { error ->
        val message = error.message?.lowercase() ?: ""
        message.contains("network") ||
            message.contains("timeout") ||
            message.contains("connection refused") ||
            message.contains("connection reset") ||
            message.contains("socket") ||
            error is java.net.ConnectException ||
            error is java.net.SocketTimeoutException ||
            error is java.net.SocketException
    }

    /**
     * Retries on WebSocket-related errors.
     */
    val websocketErrors: (Throwable) -> Boolean = { error ->
        val message = error.message?.lowercase() ?: ""
        message.contains("websocket") ||
            message.contains("connection") ||
            message.contains("close")
    }

    /**
     * Retries on I/O errors.
     */
    val ioErrors: (Throwable) -> Boolean = { error ->
        error is java.io.IOException
    }

    /**
     * Combine conditions with OR — retries if any condition matches.
     */
    fun any(vararg conditions: (Throwable) -> Boolean): (Throwable) -> Boolean = { error ->
        conditions.any { it(error) }
    }

    /**
     * Combine conditions with AND — retries only if all conditions match.
     */
    fun all(vararg conditions: (Throwable) -> Boolean): (Throwable) -> Boolean = { error ->
        conditions.all { it(error) }
    }
}

/**
 * Predefined retry configurations for common use cases.
 */
object RetryPresets {

    /**
     * Aggressive: many attempts, fast initial retry, higher jitter.
     * For critical operations that must succeed.
     */
    val aggressive = RetryOptions(
        maxAttempts = 10,
        delayMs = 500,
        backoff = BackoffStrategy.EXPONENTIAL,
        maxDelayMs = 60000,
        jitter = 0.2
    )

    /**
     * Conservative: fewer attempts, slower initial retry, linear backoff.
     * For non-critical operations.
     */
    val conservative = RetryOptions(
        maxAttempts = 3,
        delayMs = 2000,
        backoff = BackoffStrategy.LINEAR,
        maxDelayMs = 10000,
        jitter = 0.1
    )

    /**
     * Fast: quick retries with short delays, no jitter.
     * For local operations.
     */
    val fast = RetryOptions(
        maxAttempts = 5,
        delayMs = 100,
        backoff = BackoffStrategy.EXPONENTIAL,
        maxDelayMs = 2000,
        jitter = 0.0
    )

    /**
     * WebSocket: tuned for WebSocket reconnection with built-in error detection.
     */
    val websocket = RetryOptions(
        maxAttempts = 10,
        delayMs = 1000,
        backoff = BackoffStrategy.EXPONENTIAL,
        maxDelayMs = 30000,
        jitter = 0.1,
        shouldRetry = RetryConditions.websocketErrors
    )
}

// ---- Internal ----

internal fun calculateDelay(attempt: Int, options: RetryOptions): Long {
    val baseDelay = when (options.backoff) {
        BackoffStrategy.EXPONENTIAL -> (options.delayMs * 2.0.pow(attempt - 1)).toLong()
        BackoffStrategy.LINEAR -> options.delayMs * attempt
        BackoffStrategy.NONE -> options.delayMs
    }

    val capped = min(baseDelay, options.maxDelayMs)

    if (options.jitter <= 0.0) return capped

    val jitterRange = (capped * options.jitter).toLong()
    val jitterOffset = Random.nextLong(-jitterRange, jitterRange + 1)
    return maxOf(0L, capped + jitterOffset)
}
