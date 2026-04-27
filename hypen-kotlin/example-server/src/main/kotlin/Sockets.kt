package space.hypen

import io.ktor.server.application.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import kotlinx.serialization.json.*
import kotlin.time.Duration.Companion.seconds

fun Application.configureSockets() {
    install(WebSockets) {
        pingPeriod = 15.seconds
        timeout = 15.seconds
        maxFrameSize = Long.MAX_VALUE
        masking = false
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
