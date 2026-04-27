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
     */
    val readTimeoutMs: Long = TimeUnit.SECONDS.toMillis(30),
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
