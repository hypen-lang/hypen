import Foundation

// MARK: - Patch

/// Represents a DOM patch (mirrors core.Patch across all Hypen SDKs).
public struct Patch: Codable, Sendable {
    public let type: String
    public let id: String?
    public let elementType: String?
    public let props: [String: AnyCodable]?
    public let name: String?
    public let value: AnyCodable?
    public let text: String?
    public let parentId: String?
    public let beforeId: String?
    public let eventName: String?

    public init(
        type: String,
        id: String? = nil,
        elementType: String? = nil,
        props: [String: AnyCodable]? = nil,
        name: String? = nil,
        value: AnyCodable? = nil,
        text: String? = nil,
        parentId: String? = nil,
        beforeId: String? = nil,
        eventName: String? = nil
    ) {
        self.type = type
        self.id = id
        self.elementType = elementType
        self.props = props
        self.name = name
        self.value = value
        self.text = text
        self.parentId = parentId
        self.beforeId = beforeId
        self.eventName = eventName
    }
}

// MARK: - Patch Type Constants

public enum PatchType: String, Codable, Sendable {
    case create
    case setProp
    case setText
    case insert
    case move
    case remove
    case removeProp
    case attachEvent
    case detachEvent
}

// MARK: - Message Types

public enum MessageType: String, Codable, Sendable {
    case initialTree = "initialTree"
    case patch = "patch"
    case stateUpdate = "stateUpdate"
    case dispatchAction = "dispatchAction"
    case sessionAck = "sessionAck"
    case render = "render"
}

// MARK: - Action

/// Represents an action dispatched from UI.
/// Thread-safety: payload contains JSON-compatible value types only.
public struct Action: @unchecked Sendable {
    public let name: String
    public let payload: Any?
    public let sender: String

    public init(name: String, payload: Any? = nil, sender: String = "client") {
        self.name = name
        self.payload = payload
        self.sender = sender
    }
}

// MARK: - Server Config

/// Configuration options for the RemoteServer.
public struct ServerConfig: Sendable {
    public var port: Int
    public var hostname: String
    /// Browser origins allowed to open a WebSocket (RFC 001 §5, decision
    /// D1): when set, a request carrying an `Origin` header must name one of
    /// these (compared as `scheme://host[:port]`, lowercased), else 403, and
    /// an Origin-less request needs `authenticate`. Empty = no allowlist.
    /// With neither this nor `authenticate` every client is admitted and the
    /// server logs one startup warning — set them in production.
    public var allowedOrigins: [String]
    /// App-supplied connection authenticator (bearer token, cookie, …):
    /// when set it runs for every upgrade that passed the Origin check —
    /// the only admission for clients without an `Origin` (native apps).
    public var authenticate: DeviceAuthenticator?

    public init(
        port: Int = 3000,
        hostname: String = "0.0.0.0",
        allowedOrigins: [String] = [],
        authenticate: DeviceAuthenticator? = nil
    ) {
        self.port = port
        self.hostname = hostname
        self.allowedOrigins = allowedOrigins
        self.authenticate = authenticate
    }
}

// MARK: - Client Info

/// Represents a connected remote client.
public struct ClientInfo: Sendable {
    public let id: String
    public let connectedAt: Date

    public init(id: String, connectedAt: Date = Date()) {
        self.id = id
        self.connectedAt = connectedAt
    }
}

// MARK: - Connection State

public enum ConnectionState: String, Sendable {
    case disconnected
    case connecting
    case connected
    case error
}

// MARK: - AnyCodable

/// Type-erased Codable wrapper for dynamic JSON values.
/// Thread-safety: Only stores value types (Bool, Int, Double, String, Array, Dictionary, NSNull).
public struct AnyCodable: Codable, @unchecked Sendable, CustomStringConvertible {
    public let value: Any

    public init(_ value: Any) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(value, .init(codingPath: encoder.codingPath, debugDescription: "Unsupported value type \(type(of: value)) for AnyCodable"))
        }
    }

    public var description: String {
        "\(value)"
    }
}

// MARK: - Type Aliases

/// Action handler that receives action name, payload, and current state.
/// Returns the new state if changed, or nil if no change.
public typealias ActionHandler = @Sendable (String, Any?, [String: Any]) -> [String: Any]?

/// Connection callback.
public typealias ConnectionCallback = @Sendable (ClientInfo) -> Void
