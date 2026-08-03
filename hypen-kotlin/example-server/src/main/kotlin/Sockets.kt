package space.hypen

import io.ktor.server.application.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import kotlinx.serialization.json.*
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
        if (hypenServer.compression) {
            extensions {
                install(WebSocketDeflateExtension) {
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
        webSocket("/ws") {
            // Each WebSocket session gets its own engine + module via HypenServer
            val sendMessage: suspend (String) -> Unit = { msg ->
                try {
                    send(Frame.Text(msg))
                } catch (_: Exception) { /* connection closed */ }
            }

            // Handle connect — creates per-client engine, sends session ack + initial tree
            val initialTree = hypenServer.handleConnect(
                connectionKey = this,
                sendMessage = sendMessage
            )
            sendMessage(initialTree)

            try {
                for (frame in incoming) {
                    if (frame is Frame.Text) {
                        hypenServer.handleMessage(
                            connectionKey = this,
                            message = frame.readText(),
                            sendMessage = sendMessage
                        )
                    }
                }
            } finally {
                hypenServer.handleDisconnect(this)
            }
        }
    }
}
