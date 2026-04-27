import Foundation

/// Configuration options for the RemoteEngine
public struct RemoteEngineConfig: Sendable {
    /// Whether to automatically reconnect on disconnect
    public let autoReconnect: Bool

    /// Interval between reconnection attempts in seconds
    public let reconnectInterval: TimeInterval

    /// Maximum number of reconnection attempts (0 for unlimited)
    public let maxReconnectAttempts: Int

    /// Connection timeout in seconds
    public let connectTimeout: TimeInterval

    /// Read timeout in seconds
    public let readTimeout: TimeInterval

    /// Write timeout in seconds
    public let writeTimeout: TimeInterval

    /// Ping interval in seconds (for keep-alive)
    public let pingInterval: TimeInterval

    /// Enable debug logging
    public let debugLogging: Bool

    public init(
        autoReconnect: Bool = true,
        reconnectInterval: TimeInterval = 3.0,
        maxReconnectAttempts: Int = 10,
        connectTimeout: TimeInterval = 10.0,
        readTimeout: TimeInterval = 30.0,
        writeTimeout: TimeInterval = 10.0,
        pingInterval: TimeInterval = 30.0,
        debugLogging: Bool = false
    ) {
        self.autoReconnect = autoReconnect
        self.reconnectInterval = reconnectInterval
        self.maxReconnectAttempts = maxReconnectAttempts
        self.connectTimeout = connectTimeout
        self.readTimeout = readTimeout
        self.writeTimeout = writeTimeout
        self.pingInterval = pingInterval
        self.debugLogging = debugLogging
    }

    /// Default configuration
    public static let `default` = RemoteEngineConfig()

    /// Development configuration with debug logging enabled
    public static let debug = RemoteEngineConfig(debugLogging: true)

    /// Configuration with no automatic reconnection
    public static let noReconnect = RemoteEngineConfig(autoReconnect: false)
}
