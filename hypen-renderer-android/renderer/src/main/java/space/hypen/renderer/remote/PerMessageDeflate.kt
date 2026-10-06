package space.hypen.renderer.remote

/**
 * The device plane's compression rule (RFC 001): device data may travel over
 * a compressed socket only when every message is compressed on its own, i.e.
 * the negotiated permessage-deflate (RFC 7692) carries BOTH
 * `server_no_context_takeover` and `client_no_context_takeover`. Device data
 * then never shares a compression history with other messages (the
 * cross-message context CRIME/BREACH-style attacks rely on). OkHttp honours
 * both parameters: it resets its deflater per message for
 * `client_no_context_takeover` and its inflater for
 * `server_no_context_takeover`.
 */
internal object PerMessageDeflate {
    const val SERVER_NO_CONTEXT_TAKEOVER = "server_no_context_takeover"
    const val CLIENT_NO_CONTEXT_TAKEOVER = "client_no_context_takeover"

    /**
     * Whether the device plane may run on a socket whose upgrade response
     * carried these `Sec-WebSocket-Extensions` values: true when no
     * permessage-deflate was negotiated, or when every negotiated
     * permessage-deflate element has both no-context-takeover parameters.
     */
    fun allowsDevice(negotiated: List<String>): Boolean =
        negotiated.flatMap { elements(it) }.none { params ->
            params.first().equals("permessage-deflate", ignoreCase = true) &&
                !(hasParam(params, SERVER_NO_CONTEXT_TAKEOVER) && hasParam(params, CLIENT_NO_CONTEXT_TAKEOVER))
        }

    private fun hasParam(params: List<String>, name: String): Boolean =
        params.drop(1).any { it.substringBefore('=').trim().equals(name, ignoreCase = true) }

    /** Extension elements (`,`-separated) as `[name, param, …]` (`;`-separated), quotes respected. */
    private fun elements(header: String): List<List<String>> {
        val out = mutableListOf<List<String>>()
        var params = mutableListOf<String>()
        val token = StringBuilder()
        var quoted = false

        fun endToken() {
            params += token.toString().trim()
            token.clear()
        }
        for (c in header) {
            when {
                c == '"' -> {
                    quoted = !quoted
                    token.append(c)
                }
                quoted -> token.append(c)
                c == ';' -> endToken()
                c == ',' -> {
                    endToken()
                    out += params
                    params = mutableListOf()
                }
                else -> token.append(c)
            }
        }
        endToken()
        out += params
        return out.map { element -> element.filter { it.isNotEmpty() } }.filter { it.isNotEmpty() }
    }
}
