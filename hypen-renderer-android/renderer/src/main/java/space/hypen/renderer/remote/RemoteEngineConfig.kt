package space.hypen.renderer.remote

import java.util.concurrent.TimeUnit

/**
 * Configuration for the remote engine connection.
 */
data class RemoteEngineConfig(
    /**
     * Whether to automatically reconnect on disconnection.
     */
    val autoReconnect: Boolean = true,
    /**
     * Interval between reconnection attempts in milliseconds.
     */
    val reconnectIntervalMs: Long = 3000,
    /**
     * Maximum number of reconnection attempts before giving up.
     */
    val maxReconnectAttempts: Int = 10,
    /**
     * Timeout for the initial connection in milliseconds.
     */
    val connectTimeoutMs: Long = TimeUnit.SECONDS.toMillis(10),
    /**
     * Timeout for reading from the connection in milliseconds.
     * `0` disables it — the default, and what a WebSocket wants.
     *
     * Liveness on a long-lived socket is proven by [pingIntervalMs]: OkHttp
     * sends pings and fails the connection itself if a pong doesn't come
     * back. A read deadline on top of that races its own keepalive — an idle
     * socket receives nothing for the whole interval, so the timeout can fire
     * before the pong that would have reset it.
     *
     * It was previously 30s against a 30s ping interval — a dead heat, and
     * a latent source of false disconnects on any idle socket.
     *
     * Honesty note: this was changed while chasing a ~2s post-idle stall, and
     * it did NOT fix that symptom (measured: the stall persists). It is kept
     * because `readTimeout <= pingInterval` is a genuine misconfiguration on
     * its own terms, not because it explains that bug.
     */
    val readTimeoutMs: Long = 0,
    /**
     * Timeout for writing to the connection in milliseconds.
     */
    val writeTimeoutMs: Long = TimeUnit.SECONDS.toMillis(10),
    /**
     * Interval for ping/pong keepalive in milliseconds.
     */
    val pingIntervalMs: Long = TimeUnit.SECONDS.toMillis(30),
    /**
     * Enable logging of WebSocket messages.
     */
    val enableLogging: Boolean = false,
) {
    companion object {
        /**
         * Default configuration.
         */
        val DEFAULT = RemoteEngineConfig()

        /**
         * Configuration optimized for development with logging enabled.
         */
        val DEBUG =
            RemoteEngineConfig(
                enableLogging = true,
                reconnectIntervalMs = 1000,
                maxReconnectAttempts = Int.MAX_VALUE,
            )
    }
}
