package space.hypen

import io.ktor.util.AttributeKey
import io.ktor.websocket.WebSocketDeflateExtension
import io.ktor.websocket.WebSocketExtension
import io.ktor.websocket.WebSocketExtensionFactory
import io.ktor.websocket.WebSocketExtensionHeader

/**
 * permessage-deflate (RFC 7692) that always negotiates **no context takeover
 * in both directions**: the response carries `server_no_context_takeover`
 * and `client_no_context_takeover`, so every message is compressed on its
 * own and device data (RFC 001) never shares a compression history with
 * other messages. Hypen clients enable the device plane on a compressed
 * socket only in this mode; with context takeover in either direction they
 * keep the connection UI-only.
 *
 * Why a wrapper (Ktor 3.1.1, verified by `HypenDeflateTest`):
 * - `WebSocketDeflateExtension.serverNegotiation` answers only the
 *   no-context-takeover parameters the CLIENT offered — its
 *   `clientNoContextTakeOver` / `serverNoContextTakeOver` settings apply to
 *   Ktor as a client. Browsers offer `permessage-deflate;
 *   client_max_window_bits` and OkHttp a bare `permessage-deflate`, so the
 *   plain extension negotiates context takeover with both. This wrapper adds
 *   both parameters to the client's offer before handing it to Ktor's
 *   extension, which then resets its deflater and inflater per message
 *   (RFC 7692 lets a server include both unilaterally).
 * - Ktor's server writes a negotiated extension's parameters as
 *   `permessage-deflate , p1,p2` (commas: to a client these are separate,
 *   unknown extensions, and browsers and OkHttp fail the socket). The wrapper
 *   therefore answers the whole element as the header's name, which Ktor
 *   writes verbatim: `permessage-deflate; server_no_context_takeover;
 *   client_no_context_takeover`.
 *
 * ```kotlin
 * install(WebSockets) {
 *     if (hypenServer.compression) {
 *         extensions { install(HypenDeflate) { compressIfBiggerThan(bytes = 1024) } }
 *     }
 * }
 * // in webSocket { }: tell HypenServer what was negotiated
 * hypenServer.openConnection(key, transport, webSocketExtensions = extensionOrNull(HypenDeflate)?.negotiated ?: "")
 * ```
 */
class HypenDeflate private constructor(
    private val deflate: WebSocketDeflateExtension,
) : WebSocketExtension<WebSocketDeflateExtension.Config> by deflate {

    /** The negotiated `Sec-WebSocket-Extensions` element, once the server answered; `null` before. */
    @Volatile
    var negotiated: String? = null
        private set

    override val factory: WebSocketExtensionFactory<WebSocketDeflateExtension.Config, HypenDeflate> get() = Companion

    override fun serverNegotiation(requestedProtocols: List<WebSocketExtensionHeader>): List<WebSocketExtensionHeader> {
        val offer = requestedProtocols.firstOrNull { it.name.equals(PERMESSAGE_DEFLATE, ignoreCase = true) }
            ?: return emptyList()
        val params = offer.parameters.filterNot { it.substringBefore('=').trim().lowercase() in NO_CONTEXT_TAKEOVER } +
            NO_CONTEXT_TAKEOVER
        val answer = deflate.serverNegotiation(listOf(WebSocketExtensionHeader(PERMESSAGE_DEFLATE, params)))
            .firstOrNull() ?: return emptyList()
        val element = (listOf(answer.name) + answer.parameters).joinToString("; ")
        negotiated = element
        // The whole element as the name, no parameters: see the class KDoc.
        return listOf(WebSocketExtensionHeader(element, emptyList()))
    }

    companion object : WebSocketExtensionFactory<WebSocketDeflateExtension.Config, HypenDeflate> {
        private const val PERMESSAGE_DEFLATE = "permessage-deflate"
        private val NO_CONTEXT_TAKEOVER = listOf("server_no_context_takeover", "client_no_context_takeover")

        override val key: AttributeKey<HypenDeflate> = AttributeKey("HypenDeflate")
        override val rsv1: Boolean = true
        override val rsv2: Boolean = false
        override val rsv3: Boolean = false

        override fun install(config: WebSocketDeflateExtension.Config.() -> Unit): HypenDeflate =
            HypenDeflate(
                WebSocketDeflateExtension.install {
                    config()
                    // Ktor as a client (and the offer this extension lists):
                    // ask for no context takeover in both directions too.
                    clientNoContextTakeOver = true
                    serverNoContextTakeOver = true
                },
            )
    }
}
