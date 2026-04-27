package space.hypen.renderer.remote

/**
 * Represents the connection state of the remote engine.
 */
enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    ERROR,
}
