package space.hypen.renderer.remote

import java.util.concurrent.TimeUnit

/**
 * Configuration for the remote engine connection.
 *
 * ## Compression
 *
 * There is deliberately no `compression` option here, unlike the server-side
 * `RemoteServerConfig` in the TypeScript SDK. WebSocket `permessage-deflate` is
 * always active on Android and is negotiated entirely by OkHttp:
 *
 * - OkHttp (4.3+) hardcodes `Sec-WebSocket-Extensions: permessage-deflate` into
 *   every WebSocket upgrade and transparently inflates compressed frames from
 *   the server. Patch batches — the large, highly compressible direction — are
 *   therefore compressed with no configuration on our side.
 * - It cannot be turned off from the client. The offer is not conditional, and
 *   setting the header yourself is explicitly rejected: OkHttp fails the socket
 *   with `ProtocolException("Request header not permitted: 'Sec-WebSocket-Extensions'")`.
 * - Whether compression is actually *used* is the server's call. A server that
 *   does not accept the extension simply gets uncompressed frames, and OkHttp
 *   falls back transparently. To disable it, set `compression: false` on the
 *   server (e.g. `RemoteServerConfig`) — not here.
 *
 * A `compression = false` flag on this class could not be honoured, so it is
 * omitted rather than shipped as a knob that silently does nothing.
 *
 * The device plane (RFC 001) runs on a compressed socket only when the
 * negotiated permessage-deflate carries BOTH `server_no_context_takeover` and
 * `client_no_context_takeover` (every message compressed on its own — what the
 * Hypen servers negotiate; OkHttp honours both). With context takeover in
 * either direction the connection runs UI-only (see [RemoteEngine]).
 *
 * Outbound compression is gated separately by OkHttp's
 * `minWebSocketMessageToCompress` (1024 bytes by default), which the engine
 * leaves alone — client→server traffic is small hello/action JSON below that
 * threshold, where deflate costs more than it saves.
 *
 * ## Connection admission (RFC 001 §5, decision D1)
 *
 * A device-enabled server admits an upgrade **without** an `Origin` header
 * only when its app-supplied authenticator accepts the request, and refuses
 * it (403) when none is configured. `Origin` is a browser-only defence
 * against cross-site WebSocket hijacking; it authenticates nothing, so a
 * native client sends none by default and authenticates with app
 * credentials instead:
 *
 * ```kotlin
 * RemoteEngineConfig(headers = mapOf("Authorization" to "Bearer $token"))
 * // or, for credentials that rotate between reconnects:
 * RemoteEngineConfig(headersProvider = { mapOf("Authorization" to "Bearer ${tokens.current()}") })
 * ```
 *
 * [origin] sends an explicit `Origin` (it must then be on the server's
 * allowlist; the server's authenticator still runs). Header values are
 * secrets: they are omitted from [toString] and never logged.
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
    /**
     * Extra headers sent on every WebSocket upgrade, e.g. `Authorization`
     * (see "Connection admission" above). `Origin`, `Host`, `Upgrade`,
     * `Connection` and `Sec-WebSocket-*` are not allowed here.
     */
    val headers: Map<String, String> = emptyMap(),
    /**
     * Evaluated on every connection attempt (reconnects included) and merged
     * over [headers]: for credentials that rotate. Same restrictions.
     */
    val headersProvider: (() -> Map<String, String>)? = null,
    /**
     * An explicit `Origin` for the upgrade, or null (default) to send none.
     * Only for servers that route native clients by an allowlisted origin;
     * it is not authentication.
     */
    val origin: String? = null,
) {
    init {
        headers.keys.forEach(::requireAllowedHeader)
        origin?.let { require(it.isNotBlank()) { "origin must not be blank" } }
    }

    /** The upgrade headers for one connection attempt ([headers], then [headersProvider], then [origin]). */
    fun upgradeHeaders(): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        headers.forEach { (k, v) -> out[k] = v }
        headersProvider?.invoke()?.forEach { (k, v) ->
            requireAllowedHeader(k)
            out.keys.firstOrNull { it.equals(k, ignoreCase = true) }?.let(out::remove)
            out[k] = v
        }
        origin?.let { out["Origin"] = it }
        return out
    }

    override fun toString(): String =
        "RemoteEngineConfig(autoReconnect=$autoReconnect, reconnectIntervalMs=$reconnectIntervalMs, " +
            "maxReconnectAttempts=$maxReconnectAttempts, connectTimeoutMs=$connectTimeoutMs, readTimeoutMs=$readTimeoutMs, " +
            "writeTimeoutMs=$writeTimeoutMs, pingIntervalMs=$pingIntervalMs, enableLogging=$enableLogging, " +
            "headers=${headers.keys.map { "$it: <redacted>" }}, headersProvider=${if (headersProvider != null) "<set>" else "null"}, " +
            "origin=$origin)"

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

private val FORBIDDEN_UPGRADE_HEADERS = setOf("origin", "host", "upgrade", "connection")

private fun requireAllowedHeader(name: String) {
    val lower = name.lowercase()
    require(lower !in FORBIDDEN_UPGRADE_HEADERS && !lower.startsWith("sec-websocket-")) {
        "header '$name' is managed by the WebSocket upgrade" + if (lower == "origin") " (use RemoteEngineConfig.origin)" else ""
    }
}
