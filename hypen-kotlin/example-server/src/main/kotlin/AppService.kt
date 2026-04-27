package space.hypen

import space.hypen.core.*

// Configure logging for the example server (DEBUG in dev, INFO in production)
private val log = createLogger("App").also {
    Logger.setLogLevel(LogLevel.DEBUG)
}

/**
 * HypenServer instance with per-client engine isolation.
 *
 * Each WebSocket client gets its own NativeEngine + ModuleInstance.
 * Sessions are managed with TTL-based expiry and reconnection support.
 */
val hypenServer = HypenServer {
    // Register modules — each defines state, actions, UI template, and lifecycle hooks
    module("Counter", counterModule)
    module("Profile", profileModule)
    module("Todo", todoModule)

    // Define routes — maps URL paths to module names
    route("/counter", "Counter")
    route("/profile", "Profile")
    route("/todo", "Todo")

    // Session management — controls TTL and concurrent connection policy
    session {
        ttl = 3600 // 1 hour session TTL
        concurrent = ConcurrentPolicy.KICK_OLD
    }

    // Watch components directory for hot-reload (if it exists)
    watchComponents("./components") {
        debounceMs = 150
        recursive = true
    }

    // Connection lifecycle — log when clients connect/disconnect
    onConnection { client ->
        log.info("Client connected: session=${client.sessionId}")
    }

    onDisconnection { client ->
        log.info("Client disconnected: session=${client.sessionId}")
    }
}.also { server ->
    // Subscribe to framework events for observability
    val events = server.events()

    events.on(HypenEvents.moduleCreated) { event ->
        log.debug("Module created for session=${event.moduleId}")
    }

    events.on(HypenEvents.moduleDestroyed) { event ->
        log.debug("Module destroyed for session=${event.moduleId}")
    }

    events.on(HypenEvents.actionDispatched) { event ->
        log.debug("Action dispatched: ${event.actionName} (module=${event.moduleId})")
    }

    events.on(HypenEvents.error) { event ->
        log.error("Framework error: ${event.message}", event.context ?: "")
    }
}
