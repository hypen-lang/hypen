import Foundation

/// Represents the current connection state of the RemoteEngine
public enum ConnectionState: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int)
    case error(message: String)

    public var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }

    public var isConnecting: Bool {
        switch self {
        case .connecting, .reconnecting:
            return true
        default:
            return false
        }
    }

    public var isError: Bool {
        if case .error = self { return true }
        return false
    }

    public var errorMessage: String? {
        if case .error(let message) = self {
            return message
        }
        return nil
    }
}

extension ConnectionState: CustomStringConvertible {
    public var description: String {
        switch self {
        case .disconnected:
            return "Disconnected"
        case .connecting:
            return "Connecting..."
        case .connected:
            return "Connected"
        case .reconnecting(let attempt):
            return "Reconnecting (attempt \(attempt))..."
        case .error(let message):
            return "Error: \(message)"
        }
    }
}
