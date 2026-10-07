package space.hypen

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import space.hypen.core.Admission
import space.hypen.core.HypenTransport
import space.hypen.core.UpgradeRequest
import java.util.zip.Deflater
import kotlin.time.Duration.Companion.seconds

fun Application.configureSockets() {
    install(WebSockets) {
        pingPeriod = 15.seconds
        timeout = 15.seconds
        maxFrameSize = Long.MAX_VALUE
        masking = false

        // Hypen streams JSON patch batches, which deflate very well.
        // permessage-deflate (RFC 7692) is negotiated per-connection, so
        // clients that don't advertise the extension keep getting raw
        // frames — enabling it is safe for every client.
        //
        // HypenServer is transport-agnostic and never installs this
        // plugin itself, so it can't apply its own `compression` setting.
        // Reading the flag here is what makes `compression = false` in
        // the HypenServer { ... } block mean anything.
        //
        // Device access (RFC 001) is on by default, and device data must
        // never share a compression history with other messages, so the
        // extension MUST negotiate no context takeover in BOTH directions
        // (`server_no_context_takeover; client_no_context_takeover`): each
        // message is then compressed on its own. Hypen clients keep a socket
        // that negotiated context takeover UI-only (no device plane). Ktor's
        // own WebSocketDeflateExtension (with clientNoContextTakeOver /
        // serverNoContextTakeOver = true) only echoes what the client
        // offered when it is the server, and browsers / OkHttp offer
        // neither, so HypenDeflate (HypenDeflate.kt) wraps it and always
        // answers both.
        if (hypenServer.compression) {
            extensions {
                install(HypenDeflate) {
                    compressionLevel = Deflater.DEFAULT_COMPRESSION
                    // Tiny frames (acks, single setProp patches) cost more
                    // in deflate overhead than they save, so only compress
                    // payloads past ~1 KiB.
                    compressIfBiggerThan(bytes = 1024)
                }
            }
        }
    }

    routing {
        route("/ws") {
            // Upgrade admission (RFC 001 §5): HypenServer judges the HTTP
            // upgrade request BEFORE the socket is accepted — the Origin
            // allowlist for browsers, the app's authenticator for native
            // clients, each enforced when configured. With neither
            // configured everything is admitted (startup warning).
            install(HypenAdmission)

            webSocket {
                // The hello-driven connection: nothing is sent until the
                // client's `hello`, which establishes or resumes the session
                // (a session that had a device plane only with the rotating
                // `resumeToken`) and — when the hello offers `device`; on by
                // default — negotiates the device plane. Every write goes
                // through one ordered queue.
                //
                // `webSocketExtensions` tells HypenServer what this socket
                // negotiated, so it also refuses the device plane itself on a
                // context-takeover socket (HypenDeflate never negotiates one).
                val key = this
                hypenServer.openConnection(
                    key,
                    object : HypenTransport {
                        override suspend fun sendText(text: String) = send(Frame.Text(text))
                        override suspend fun sendBinary(bytes: ByteArray) = send(Frame.Binary(true, bytes))
                        override suspend fun close(code: Int, reason: String) =
                            close(CloseReason(code.toShort(), reason))
                    },
                    webSocketExtensions = extensionOrNull(HypenDeflate)?.negotiated ?: "",
                )
                try {
                    for (frame in incoming) {
                        when (frame) {
                            is Frame.Text -> hypenServer.handleMessage(key, frame.readText()) {}
                            // Device upload frames (RFC 001 §2.3).
                            is Frame.Binary -> hypenServer.handleBinary(key, frame.readBytes())
                            else -> {}
                        }
                    }
                } finally {
                    hypenServer.handleDisconnect(key)
                }
            }
        }
    }
}

/**
 * Refuses the WebSocket upgrade with 403 when [space.hypen.core.HypenServer.admit]
 * rejects it, so a refused client never gets a socket.
 */
private val HypenAdmission = createRouteScopedPlugin("HypenAdmission") {
    onCall { call ->
        val request = UpgradeRequest(
            headers = call.request.headers.entries().associate { (name, values) -> name to values },
            path = call.request.path(),
            remoteAddress = call.request.origin.remoteHost,
        )
        val verdict = hypenServer.admit(request)
        if (verdict is Admission.Rejected) {
            call.respond(HttpStatusCode.fromValue(verdict.status), verdict.reason)
        }
    }
}
