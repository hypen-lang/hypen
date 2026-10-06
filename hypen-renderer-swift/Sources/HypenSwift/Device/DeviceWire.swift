import Foundation

// Device Capability Protocol — client-side wire types (RFC 001 v2.4,
// §2.1/§2.2/§2.3/§2.7/§3).
//
// A minimal copy of the shapes ported for the server SDK in
// `hypen-server-swift/Sources/HypenServer/Remote/Device/`. The renderer
// package cannot depend on the server package, so the subset a DeviceHost
// needs lives here with the same design: closed decoders that reject unknown
// keys (`additionalProperties: false`), camelCase wire keys, and the shared
// golden fixtures in `engine-compatibility-tests/fixtures/device/`.
//
// Everything here is Foundation-only and platform-agnostic. It is routed
// through a dedicated device plane and is never carried by the UI message
// path (`dispatchAction`, patches, state).
//
// Provisional: nothing is frozen until the RFC 001 §6 Phase 4 gate passes.

// MARK: - Constants

/// Protocol-level constants (RFC 001 §2.3/§2.7).
public enum DeviceProtocolConstants {
    /// Device protocol version implemented by this host.
    public static let version: UInt32 = 1
    /// Lease renewal interval, seconds (§2.7). The server renews; informational here.
    public static let leaseRenewInterval: TimeInterval = 5
    /// Lease expiry after the last accepted renewal (or receipt), seconds (§2.7).
    public static let leaseExpiry: TimeInterval = 15
    /// Maximum binary chunk payload handed to the transport per scheduling turn (§2.3).
    public static let maxBulkChunkBytes: Int = 64 * 1024
    /// Bulk enqueueing stops while transport-pending bytes are at or above this bound (§2.3).
    public static let maxTransportPendingBytes: Int = 256 * 1024
    /// Bound on `platformDetail` (§3; schema `maxLength: 512`).
    public static let maxPlatformDetailLength = 512
}

// MARK: - JSON value

/// A JSON value for opaque capability payloads (params / result / event).
/// Integers and doubles are kept apart so integral values round-trip as
/// integers (`65536`, never `65536.0`).
public enum DeviceJSON: Sendable, Hashable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([DeviceJSON])
    case object([String: DeviceJSON])

    public subscript(key: String) -> DeviceJSON? {
        if case let .object(fields) = self { return fields[key] }
        return nil
    }

    public var stringValue: String? {
        if case let .string(s) = self { return s }
        return nil
    }

    public var int64Value: Int64? {
        switch self {
        case let .int(n): return n
        case let .double(d) where d.rounded() == d && abs(d) < 9_007_199_254_740_992: return Int64(d)
        default: return nil
        }
    }

    public var boolValue: Bool? {
        if case let .bool(b) = self { return b }
        return nil
    }

    public var arrayValue: [DeviceJSON]? {
        if case let .array(a) = self { return a }
        return nil
    }

    public var objectValue: [String: DeviceJSON]? {
        if case let .object(o) = self { return o }
        return nil
    }
}

extension DeviceJSON: Codable {
    public init(from decoder: Decoder) throws {
        // Device input is decoded from a strictly parsed tree (never raw text).
        if let tree = decoder as? DeviceJSONTreeDecoder {
            self = tree.value
            return
        }
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Int64.self) {
            self = .int(n)
        } else if let d = try? c.decode(Double.self) {
            self = .double(d)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([DeviceJSON].self) {
            self = .array(a)
        } else {
            self = .object(try c.decode([String: DeviceJSON].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case let .bool(b): try c.encode(b)
        case let .int(n): try c.encode(n)
        case let .double(d): try c.encode(d)
        case let .string(s): try c.encode(s)
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
        }
    }
}

/// Opaque capability payload object.
public typealias DeviceJSONObject = [String: DeviceJSON]

// MARK: - Closed-object decoding helpers

struct DeviceWireKey: CodingKey, Hashable {
    let stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
    init(_ stringValue: String) { self.stringValue = stringValue }
}

enum DeviceWire {
    /// Open a keyed container and reject any key outside `allowed`.
    static func closedContainer(
        _ decoder: Decoder,
        allowed: Set<String>,
        typeName: String
    ) throws -> KeyedDecodingContainer<DeviceWireKey> {
        let container = try decoder.container(keyedBy: DeviceWireKey.self)
        for key in container.allKeys where !allowed.contains(key.stringValue) {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: container.codingPath,
                debugDescription: "\(typeName): unknown key '\(key.stringValue)' (closed schema)"
            ))
        }
        return container
    }

    static func fail(_ container: KeyedDecodingContainer<DeviceWireKey>, _ message: String) -> DecodingError {
        DecodingError.dataCorrupted(DecodingError.Context(
            codingPath: container.codingPath, debugDescription: message))
    }

    static func expectTag(
        _ container: KeyedDecodingContainer<DeviceWireKey>,
        expected: String
    ) throws {
        let actual = try container.decode(String.self, forKey: DeviceWireKey("type"))
        if actual != expected {
            throw fail(container, "expected type \"\(expected)\", got \"\(actual)\"")
        }
    }

    /// Shared encoder for outgoing device messages. Sorted keys keep the
    /// output deterministic for tests and transcripts.
    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    /// Strict decode of device text: the JSON limits (`DeviceStrictJSON`),
    /// then the typed decoder over the parsed tree. `JSONDecoder` never sees
    /// device input.
    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try decode(type, from: try DeviceStrictJSON.parse(data))
    }

    /// Typed decode of an already-parsed value.
    static func decode<T: Decodable>(_ type: T.Type, from value: DeviceJSON) throws -> T {
        try DeviceJSONTreeDecoder.nested(type, value, [])
    }

    /// Decode a capability payload object into a closed typed shape.
    static func decode<T: Decodable>(_ type: T.Type, from object: DeviceJSONObject) throws -> T {
        try decode(type, from: DeviceJSON.object(object))
    }

    /// Capability names compare by exact code points (bytes), never by
    /// Unicode canonical equivalence (decision D7).
    static func sameName(_ a: String, _ b: String) -> Bool {
        a.utf8.elementsEqual(b.utf8)
    }

    /// Whether `names` repeats a name (exact bytes).
    static func hasDuplicateNames<S: Sequence>(_ names: S) -> Bool where S.Element == String {
        var seen = Set<[UInt8]>()
        for name in names where !seen.insert(Array(name.utf8)).inserted { return true }
        return false
    }
}

extension DeviceWire {
    /// Largest JSON-safe integer (2^53 − 1): the schema bound for byte
    /// counts, credit, and deadlines.
    static let maxSafeInteger: UInt64 = 9_007_199_254_740_991

    /// Schema `maxLength` counts Unicode code points.
    static func codePointCount(_ value: String) -> Int {
        value.unicodeScalars.count
    }
}

extension KeyedDecodingContainer where K == DeviceWireKey {
    func req<T: Decodable>(_ type: T.Type, _ key: String) throws -> T {
        try decode(type, forKey: DeviceWireKey(key))
    }

    /// Optional field of a closed schema: absent → nil; an explicit `null`
    /// is rejected (no device schema admits null).
    func opt<T: Decodable>(_ type: T.Type, _ key: String) throws -> T? {
        guard contains(DeviceWireKey(key)) else { return nil }
        return try decode(type, forKey: DeviceWireKey(key))
    }

    /// Required string bounded by `maxLength` Unicode code points.
    func string(_ key: String, maxLength: Int, minLength: Int = 0) throws -> String {
        let value = try req(String.self, key)
        let length = DeviceWire.codePointCount(value)
        guard length >= minLength else {
            throw DeviceWire.fail(self, "\(key) shorter than \(minLength) code points")
        }
        guard length <= maxLength else {
            throw DeviceWire.fail(self, "\(key) exceeds \(maxLength) code points")
        }
        return value
    }

    func optString(_ key: String, maxLength: Int) throws -> String? {
        guard contains(DeviceWireKey(key)) else { return nil }
        return try string(key, maxLength: maxLength)
    }

    /// Required `u32` ≥ 1; values above `UInt32.max` fail to decode.
    func positiveU32(_ key: String) throws -> UInt32 {
        let value = try req(UInt32.self, key)
        guard value >= 1 else { throw DeviceWire.fail(self, "\(key) must be >= 1") }
        return value
    }

    /// Required JSON-safe integer in `minimum...2^53-1`.
    func safeInteger(_ key: String, minimum: UInt64 = 0) throws -> UInt64 {
        let value = try req(UInt64.self, key)
        guard value >= minimum, value <= DeviceWire.maxSafeInteger else {
            throw DeviceWire.fail(self, "\(key) must be in \(minimum)...2^53-1")
        }
        return value
    }

    func array<T: Decodable>(_ type: T.Type, _ key: String, maxItems: Int) throws -> [T] {
        let value = try req([T].self, key)
        guard value.count <= maxItems else { throw DeviceWire.fail(self, "\(key) exceeds \(maxItems) items") }
        return value
    }
}

extension KeyedEncodingContainer where K == DeviceWireKey {
    mutating func put<T: Encodable>(_ value: T, _ key: String) throws {
        try encode(value, forKey: DeviceWireKey(key))
    }

    mutating func putIfPresent<T: Encodable>(_ value: T?, _ key: String) throws {
        try encodeIfPresent(value, forKey: DeviceWireKey(key))
    }
}

// MARK: - Binary frames (§2.3)

/// Fixed 12-byte little-endian frame header:
/// `[u8 version=1][u8 flags=0][u16 channel][u32 requestId][u32 seq][payload…]`.
public struct DeviceFrameHeader: Hashable, Sendable {
    public var version: UInt8
    public var flags: UInt8
    public var channel: UInt16
    public var requestId: UInt32
    public var seq: UInt32

    public init(
        version: UInt8 = DeviceFrameCodec.version,
        flags: UInt8 = 0,
        channel: UInt16,
        requestId: UInt32,
        seq: UInt32
    ) {
        self.version = version
        self.flags = flags
        self.channel = channel
        self.requestId = requestId
        self.seq = seq
    }
}

/// Decode failure classification (§2.3).
public enum DeviceFrameError: Error, Hashable, Sendable {
    /// Frame shorter than the 12-byte header: drop silently.
    case shortHeader
    /// Unknown version or nonzero flags: protocol violation.
    case violation(String)
}

/// A decoded frame: header plus the payload that follows it.
public struct DecodedDeviceFrame: Hashable, Sendable {
    public let header: DeviceFrameHeader
    public let payload: Data
}

/// Native frame codec, pinned by `engine-compatibility-tests/fixtures/device/frames.json`.
public enum DeviceFrameCodec {
    public static let headerLength = 12
    public static let version: UInt8 = 1

    public static func encodeHeader(_ header: DeviceFrameHeader) -> Data {
        var out = Data(capacity: headerLength)
        out.append(header.version)
        out.append(header.flags)
        appendLE(UInt64(header.channel), 2, &out)
        appendLE(UInt64(header.requestId), 4, &out)
        appendLE(UInt64(header.seq), 4, &out)
        return out
    }

    public static func encode(_ header: DeviceFrameHeader, payload: Data = Data()) -> Data {
        var out = encodeHeader(header)
        out.reserveCapacity(headerLength + payload.count)
        out.append(payload)
        return out
    }

    /// Decode and validate. Works on `Data` slices with a nonzero `startIndex`.
    public static func decode(_ frame: Data) -> Result<DecodedDeviceFrame, DeviceFrameError> {
        guard frame.count >= headerLength else { return .failure(.shortHeader) }
        let base = frame.startIndex
        func byte(_ i: Int) -> UInt64 { UInt64(frame[base + i]) }
        let version = UInt8(byte(0))
        let flags = UInt8(byte(1))
        if version != self.version { return .failure(.violation("version \(version)")) }
        if flags != 0 { return .failure(.violation("flags \(flags)")) }
        let channel = UInt16(byte(2) | byte(3) << 8)
        let requestId = UInt32(byte(4) | byte(5) << 8 | byte(6) << 16 | byte(7) << 24)
        let seq = UInt32(byte(8) | byte(9) << 8 | byte(10) << 16 | byte(11) << 24)
        let payload = Data(frame[(base + headerLength)...])
        return .success(DecodedDeviceFrame(
            header: DeviceFrameHeader(version: version, flags: flags, channel: channel,
                                      requestId: requestId, seq: seq),
            payload: payload))
    }

    private static func appendLE(_ value: UInt64, _ count: Int, _ out: inout Data) {
        var v = value
        for _ in 0..<count {
            out.append(UInt8(truncatingIfNeeded: v))
            v >>= 8
        }
    }
}

/// Receiver-side per-(request, channel) sequence rule (§2.3), pinned by
/// `frames.json` `sequences`: `seq` starts at 0; a lossless (`pause`)
/// channel requires exactly the next seq; `dropOldest` permits forward gaps;
/// repeats, decreases and any wrap past 2^32 − 1 are violations.
public struct DeviceSequenceTracker: Sendable, Hashable {
    /// The lowest acceptable next seq (2^32 once `UInt32.max` was seen).
    private var next: UInt64 = 0

    public init() {}

    /// Accept `seq` (and advance), or report a violation.
    public mutating func accept(_ seq: UInt32, overflow: DeviceRevisionPolicy.Overflow) -> Bool {
        let value = UInt64(seq)
        switch overflow {
        case .dropOldest:
            guard value >= next else { return false }
        case .pause, .none:
            guard value == next else { return false }
        }
        next = value + 1
        return true
    }
}

// MARK: - Handshake (§2.2)

/// Capability name plus every implementable revision.
public struct CapabilityOffer: Hashable, Sendable, Codable {
    public var name: String
    public var versions: [UInt32]

    public init(name: String, versions: [UInt32]) {
        self.name = name
        self.versions = versions
    }

    public init(from decoder: Decoder) throws {
        let c = try DeviceWire.closedContainer(decoder, allowed: ["name", "versions"], typeName: "capabilityOffer")
        name = try c.string("name", maxLength: 128, minLength: 1)
        versions = try c.array(UInt32.self, "versions", maxItems: 32)
        // Revision 0 is reserved; `versions` is a set.
        guard !versions.contains(0), Set(versions).count == versions.count else {
            throw DeviceWire.fail(c, "versions: revisions are unique and >= 1")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DeviceWireKey.self)
        try c.put(name, "name")
        try c.put(versions, "versions")
    }
}

/// A selected capability revision from `sessionAck.device`.
public struct CapabilitySelection: Hashable, Sendable, Codable {
    public var name: String
    public var version: UInt32

    public init(name: String, version: UInt32) {
        self.name = name
        self.version = version
    }

    public init(from decoder: Decoder) throws {
        let c = try DeviceWire.closedContainer(decoder, allowed: ["name", "version"], typeName: "capabilitySelection")
        name = try c.string("name", maxLength: 128, minLength: 1)
        version = try c.positiveU32("version")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DeviceWireKey.self)
        try c.put(name, "name")
        try c.put(version, "version")
    }
}

/// `hello.device`: the client's complete initial advertisement.
public struct DeviceHello: Hashable, Sendable, Codable {
    public var protocolVersions: [UInt32]
    public var binary: Bool
    public var capabilities: [CapabilityOffer]

    public init(protocolVersions: [UInt32], binary: Bool, capabilities: [CapabilityOffer]) {
        self.protocolVersions = protocolVersions
        self.binary = binary
        self.capabilities = capabilities
    }

    public init(from decoder: Decoder) throws {
        let c = try DeviceWire.closedContainer(
            decoder, allowed: ["protocolVersions", "binary", "capabilities"], typeName: "hello.device")
        protocolVersions = try c.array(UInt32.self, "protocolVersions", maxItems: 8)
        guard !protocolVersions.contains(0), Set(protocolVersions).count == protocolVersions.count else {
            throw DeviceWire.fail(c, "protocolVersions: versions are unique and >= 1")
        }
        binary = try c.req(Bool.self, "binary")
        capabilities = try c.array(CapabilityOffer.self, "capabilities", maxItems: 64)
        guard !DeviceWire.hasDuplicateNames(capabilities.map { $0.name }) else {
            throw DeviceWire.fail(c, "capabilities: a capability is offered once")
        }
    }

    /// Strict decode of `hello.device` text (JSON limits, closed shape).
    public static func decodeStrict(_ data: Data) throws -> DeviceHello {
        try DeviceWire.decode(DeviceHello.self, from: data)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DeviceWireKey.self)
        try c.put(protocolVersions, "protocolVersions")
        try c.put(binary, "binary")
        try c.put(capabilities, "capabilities")
    }

    /// `[String: Any]` form for embedding in the legacy `hello` dictionary.
    public func jsonObject() -> [String: Any] {
        [
            "protocolVersions": protocolVersions.map { Int($0) },
            "binary": binary,
            "capabilities": capabilities.map { ["name": $0.name, "versions": $0.versions.map { Int($0) }] },
        ]
    }
}

/// `sessionAck.device`: the server's selection.
public struct DeviceAck: Hashable, Sendable, Codable {
    public var protocolVersion: UInt32
    public var binary: Bool
    public var capabilities: [CapabilitySelection]

    public init(protocolVersion: UInt32, binary: Bool, capabilities: [CapabilitySelection]) {
        self.protocolVersion = protocolVersion
        self.binary = binary
        self.capabilities = capabilities
    }

    public func selectedVersion(of name: String) -> UInt32? {
        capabilities.first { DeviceWire.sameName($0.name, name) }?.version
    }

    /// Strict decode of `sessionAck.device` text (JSON limits, closed shape).
    public static func decodeStrict(_ data: Data) throws -> DeviceAck {
        try DeviceWire.decode(DeviceAck.self, from: data)
    }

    public init(from decoder: Decoder) throws {
        let c = try DeviceWire.closedContainer(
            decoder, allowed: ["protocolVersion", "binary", "capabilities"], typeName: "sessionAck.device")
        protocolVersion = try c.positiveU32("protocolVersion")
        binary = try c.req(Bool.self, "binary")
        capabilities = try c.array(CapabilitySelection.self, "capabilities", maxItems: 64)
        guard !DeviceWire.hasDuplicateNames(capabilities.map { $0.name }) else {
            throw DeviceWire.fail(c, "capabilities: a selection names each capability once")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DeviceWireKey.self)
        try c.put(protocolVersion, "protocolVersion")
        try c.put(binary, "binary")
        try c.put(capabilities, "capabilities")
    }
}

// MARK: - Lifetime, owner, control, errors (§2.1/§2.7/§3)

public enum DeviceLifetime: String, Codable, Sendable, CaseIterable, Hashable {
    case activation
    case background
    case connection
}

/// Logical owner identity. Closed shapes:
/// `{moduleInstanceId, activationId}` / `{moduleInstanceId}` / `{connection: true}`.
public enum DeviceOwner: Hashable, Sendable {
    case activation(moduleInstanceId: String, activationId: UInt32)
    case module(moduleInstanceId: String)
    case connection

    public func matches(_ lifetime: DeviceLifetime) -> Bool {
        switch (self, lifetime) {
        case (.activation, .activation), (.module, .background), (.connection, .connection): return true
        default: return false
        }
    }
}

extension DeviceOwner: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DeviceWireKey.self)
        let keys = Set(c.allKeys.map { $0.stringValue })
        // Exactly one closed shape, no extra keys; activation ids start at 1.
        if keys == ["moduleInstanceId", "activationId"] {
            self = .activation(moduleInstanceId: try c.string("moduleInstanceId", maxLength: 256, minLength: 1),
                               activationId: try c.positiveU32("activationId"))
        } else if keys == ["moduleInstanceId"] {
            self = .module(moduleInstanceId: try c.string("moduleInstanceId", maxLength: 256, minLength: 1))
        } else if keys == ["connection"] {
            guard try c.req(Bool.self, "connection") else {
                throw DeviceWire.fail(c, "owner: connection must be true")
            }
            self = .connection
        } else {
            throw DeviceWire.fail(c, "owner: keys \(keys.sorted()) match no owner shape")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DeviceWireKey.self)
        switch self {
        case let .activation(moduleInstanceId, activationId):
            try c.put(moduleInstanceId, "moduleInstanceId")
            try c.put(activationId, "activationId")
        case let .module(moduleInstanceId):
            try c.put(moduleInstanceId, "moduleInstanceId")
        case .connection:
            try c.put(true, "connection")
        }
    }
}

/// Control variants; exactly one key per control object. `grant` is at
/// least 1 and at most the largest registry credit bound; lease sequences
/// are `u32` in 1...4294967295 (the cross-SDK lowest common denominator;
/// they cannot wrap, §2.7).
public enum DeviceControl: Hashable, Sendable {
    case grant(UInt32)
    case cancel
    case renewLease(UInt32)
    case leaseAck(UInt32)
    case paused(Bool)
}

extension DeviceControl: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DeviceWireKey.self)
        let keys = c.allKeys.map { $0.stringValue }
        guard keys.count == 1, let key = keys.first else {
            throw DeviceWire.fail(c, "control must contain exactly one variant, got \(keys.sorted())")
        }
        switch key {
        case "grant":
            let grant = try c.positiveU32("grant")
            guard UInt64(grant) <= DeviceRegistry.envelopeMaxGrant else {
                throw DeviceWire.fail(c, "control.grant exceeds every registry credit bound")
            }
            self = .grant(grant)
        case "cancel":
            guard try c.req(Bool.self, "cancel") else { throw DeviceWire.fail(c, "control.cancel must be true") }
            self = .cancel
        case "renewLease": self = .renewLease(try c.positiveU32("renewLease"))
        case "leaseAck": self = .leaseAck(try c.positiveU32("leaseAck"))
        case "paused": self = .paused(try c.req(Bool.self, "paused"))
        default: throw DeviceWire.fail(c, "unknown control variant '\(key)'")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DeviceWireKey.self)
        switch self {
        case let .grant(n): try c.put(n, "grant")
        case .cancel: try c.put(true, "cancel")
        case let .renewLease(n): try c.put(n, "renewLease")
        case let .leaseAck(n): try c.put(n, "leaseAck")
        case let .paused(flag): try c.put(flag, "paused")
        }
    }
}

/// Closed error taxonomy for protocol v1 (§3).
public enum DeviceErrorCode: String, Codable, Sendable, CaseIterable, Hashable {
    case unsupported
    case unavailable
    case denied
    case revoked
    case cancelled
    case timeout
    case throttled
    case connectionLost
    case invalidParams
    case `internal`
}

public struct DeviceError: Hashable, Sendable, Error, Codable {
    public var code: DeviceErrorCode
    /// Bounded diagnostic text; portable handlers must not branch on it.
    public var platformDetail: String?

    public init(_ code: DeviceErrorCode, _ platformDetail: String? = nil) {
        self.code = code
        if let detail = platformDetail {
            // Bounded in code points, like the schema's maxLength.
            var scalars = String.UnicodeScalarView()
            scalars.append(contentsOf: detail.unicodeScalars.prefix(DeviceProtocolConstants.maxPlatformDetailLength))
            self.platformDetail = String(scalars)
        } else {
            self.platformDetail = nil
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try DeviceWire.closedContainer(decoder, allowed: ["code", "platformDetail"], typeName: "error")
        code = try c.req(DeviceErrorCode.self, "code")
        platformDetail = try c.optString("platformDetail", maxLength: DeviceProtocolConstants.maxPlatformDetailLength)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DeviceWireKey.self)
        try c.put(code, "code")
        try c.putIfPresent(platformDetail, "platformDetail")
    }
}

// MARK: - Envelope (§2.1)

/// Server → client: open a module-owned operation.
public struct DeviceRequest: Sendable, Hashable {
    public static let wireType = "deviceRequest"

    public var id: UInt32
    public var capability: String
    public var version: UInt32
    public var owner: DeviceOwner
    public var lifetime: DeviceLifetime
    public var timeoutMs: UInt64
    public var initialCredit: UInt64
    public var params: DeviceJSONObject

    public init(id: UInt32, capability: String, version: UInt32, owner: DeviceOwner,
                lifetime: DeviceLifetime, timeoutMs: UInt64, initialCredit: UInt64,
                params: DeviceJSONObject) {
        self.id = id
        self.capability = capability
        self.version = version
        self.owner = owner
        self.lifetime = lifetime
        self.timeoutMs = timeoutMs
        self.initialCredit = initialCredit
        self.params = params
    }
}

extension DeviceRequest: Codable {
    public init(from decoder: Decoder) throws {
        let c = try DeviceWire.closedContainer(
            decoder,
            allowed: ["type", "id", "capability", "version", "owner", "lifetime",
                      "timeoutMs", "initialCredit", "params"],
            typeName: Self.wireType)
        try DeviceWire.expectTag(c, expected: Self.wireType)
        id = try c.positiveU32("id")
        capability = try c.string("capability", maxLength: 128, minLength: 1)
        version = try c.positiveU32("version")
        owner = try c.req(DeviceOwner.self, "owner")
        lifetime = try c.req(DeviceLifetime.self, "lifetime")
        timeoutMs = try c.safeInteger("timeoutMs", minimum: 1)
        guard timeoutMs <= DeviceRegistry.envelopeMaxTimeoutMs else {
            throw DeviceWire.fail(c, "timeoutMs exceeds every registry bound")
        }
        initialCredit = try c.safeInteger("initialCredit")
        guard initialCredit <= DeviceRegistry.envelopeMaxInitialCredit else {
            throw DeviceWire.fail(c, "initialCredit exceeds every registry bound")
        }
        params = try c.req(DeviceJSONObject.self, "params")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DeviceWireKey.self)
        try c.put(Self.wireType, "type")
        try c.put(id, "id")
        try c.put(capability, "capability")
        try c.put(version, "version")
        try c.put(owner, "owner")
        try c.put(lifetime, "lifetime")
        try c.put(timeoutMs, "timeoutMs")
        try c.put(initialCredit, "initialCredit")
        try c.put(params, "params")
    }
}

/// Client → server: the single terminal message (result XOR error).
public struct DeviceResponse: Sendable, Hashable {
    public static let wireType = "deviceResponse"

    public var id: UInt32
    public var result: DeviceJSONObject?
    public var error: DeviceError?
    /// Set only by fakes/simulators; a real host never sets it (RFC 001
    /// pillar 11). Carried so a decoded response re-encodes exactly.
    public var simulated: Bool = false

    public init(id: UInt32, result: DeviceJSONObject) {
        self.id = id
        self.result = result
        self.error = nil
    }

    public init(id: UInt32, error: DeviceError) {
        self.id = id
        self.result = nil
        self.error = error
    }
}

extension DeviceResponse: Codable {
    public init(from decoder: Decoder) throws {
        let c = try DeviceWire.closedContainer(
            decoder, allowed: ["type", "id", "result", "error", "simulated"], typeName: Self.wireType)
        try DeviceWire.expectTag(c, expected: Self.wireType)
        id = try c.positiveU32("id")
        result = try c.opt(DeviceJSONObject.self, "result")
        error = try c.opt(DeviceError.self, "error")
        if (result == nil) == (error == nil) {
            throw DeviceWire.fail(c, "deviceResponse must carry exactly one of result/error")
        }
        // Schema `const: true`: `false` and `null` are not valid encodings.
        if let flag = try c.opt(Bool.self, "simulated") {
            guard flag else { throw DeviceWire.fail(c, "deviceResponse.simulated must be true when present") }
            simulated = true
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DeviceWireKey.self)
        try c.put(Self.wireType, "type")
        try c.put(id, "id")
        try c.putIfPresent(result, "result")
        try c.putIfPresent(error, "error")
        if simulated { try c.put(true, "simulated") }
    }
}

/// Either direction: a capability event XOR exactly one control variant.
public struct DeviceEvent: Sendable, Hashable {
    public static let wireType = "deviceEvent"

    public var id: UInt32
    public var event: DeviceJSONObject?
    public var control: DeviceControl?

    public init(id: UInt32, event: DeviceJSONObject) {
        self.id = id
        self.event = event
        self.control = nil
    }

    public init(id: UInt32, control: DeviceControl) {
        self.id = id
        self.event = nil
        self.control = control
    }
}

extension DeviceEvent: Codable {
    public init(from decoder: Decoder) throws {
        let c = try DeviceWire.closedContainer(
            decoder, allowed: ["type", "id", "event", "control"], typeName: Self.wireType)
        try DeviceWire.expectTag(c, expected: Self.wireType)
        id = try c.positiveU32("id")
        event = try c.opt(DeviceJSONObject.self, "event")
        control = try c.opt(DeviceControl.self, "control")
        if (event == nil) == (control == nil) {
            throw DeviceWire.fail(c, "deviceEvent must carry exactly one of event/control")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DeviceWireKey.self)
        try c.put(Self.wireType, "type")
        try c.put(id, "id")
        try c.putIfPresent(event, "event")
        try c.putIfPresent(control, "control")
    }
}

/// The three device envelope messages, tagged by `type` (§2.1).
public enum DeviceWireMessage: Sendable, Hashable {
    case request(DeviceRequest)
    case response(DeviceResponse)
    case event(DeviceEvent)

    public var id: UInt32 {
        switch self {
        case let .request(m): return m.id
        case let .response(m): return m.id
        case let .event(m): return m.id
        }
    }

    /// Strict wire decode for one device-plane text message: the JSON
    /// limits (size, depth, integer tokens, strings, duplicate keys; RFC 001
    /// §2.1, decision D4), then the closed shape from the parsed tree.
    public static func decodeStrict(_ data: Data) throws -> DeviceWireMessage {
        try DeviceWire.decode(DeviceWireMessage.self, from: data)
    }
}

extension DeviceWireMessage: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DeviceWireKey.self)
        switch try c.req(String.self, "type") {
        case DeviceRequest.wireType: self = .request(try DeviceRequest(from: decoder))
        case DeviceResponse.wireType: self = .response(try DeviceResponse(from: decoder))
        case DeviceEvent.wireType: self = .event(try DeviceEvent(from: decoder))
        case let other: throw DeviceWire.fail(c, "unknown device message type '\(other)'")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .request(m): try m.encode(to: encoder)
        case let .response(m): try m.encode(to: encoder)
        case let .event(m): try m.encode(to: encoder)
        }
    }
}

// MARK: - Client-side registry (§3)

/// One capability revision as a DeviceHost enforces it. Mirrors
/// `DeviceCapabilityRegistry` in hypen-server-swift and the Rust reference
/// `registry()` field for field; pinned by
/// `engine-compatibility-tests/schema/device/registry-v1.json`.
public struct DeviceRevisionPolicy: Sendable, Hashable {
    public enum Mode: String, Sendable, Hashable { case unary, stream }
    public enum DataPlane: String, Sendable, Hashable { case none, jsonEvents, binaryUpload, binaryDownload }
    public enum Consent: String, Sendable, Hashable { case none, perUse, persistable }
    public enum Overflow: String, Sendable, Hashable { case none, dropOldest, pause }

    public let capability: String
    public let version: UInt32
    public let mode: Mode
    public let data: DataPlane
    public let consent: Consent
    public let overflow: Overflow
    public let lifetimes: [DeviceLifetime]
    public let maxItemBytes: UInt64
    public let maxItems: Int
    public let maxInitialCredit: UInt64
    public let maxOutstandingCredit: UInt64
    public let maxTimeoutMs: UInt64
}

public enum DeviceRegistry {
    private static let kib: UInt64 = 1024
    private static let mib: UInt64 = 1024 * 1024

    /// Every v1 capability revision, `core.*` first then alphabetical.
    public static let revisions: [DeviceRevisionPolicy] = [
        .init(capability: "core.capabilities", version: 1, mode: .stream, data: .jsonEvents, consent: .none,
              overflow: .dropOldest, lifetimes: [.connection], maxItemBytes: 0, maxItems: 0,
              maxInitialCredit: 64, maxOutstandingCredit: 64, maxTimeoutMs: 86_400_000),
        .init(capability: "bluetooth.scan", version: 1, mode: .stream, data: .jsonEvents, consent: .persistable,
              overflow: .dropOldest, lifetimes: [.activation], maxItemBytes: 0, maxItems: 0,
              maxInitialCredit: 256, maxOutstandingCredit: 1024, maxTimeoutMs: 600_000),
        .init(capability: "bluetooth.select", version: 1, mode: .unary, data: .none, consent: .perUse,
              overflow: .none, lifetimes: [.activation], maxItemBytes: 0, maxItems: 0,
              maxInitialCredit: 0, maxOutstandingCredit: 0, maxTimeoutMs: 300_000),
        .init(capability: "camera.capture", version: 1, mode: .unary, data: .binaryUpload, consent: .perUse,
              overflow: .pause, lifetimes: [.activation], maxItemBytes: 64 * mib, maxItems: 1,
              maxInitialCredit: 4 * mib, maxOutstandingCredit: 8 * mib, maxTimeoutMs: 600_000),
        .init(capability: "file.pick", version: 1, mode: .unary, data: .binaryUpload, consent: .perUse,
              overflow: .pause, lifetimes: [.activation], maxItemBytes: 64 * mib, maxItems: 16,
              maxInitialCredit: 4 * mib, maxOutstandingCredit: 8 * mib, maxTimeoutMs: 300_000),
        .init(capability: "file.save", version: 1, mode: .unary, data: .binaryDownload, consent: .perUse,
              overflow: .pause, lifetimes: [.activation], maxItemBytes: 64 * mib, maxItems: 1,
              maxInitialCredit: 0, maxOutstandingCredit: 8 * mib, maxTimeoutMs: 300_000),
        .init(capability: "gallery.pick", version: 1, mode: .unary, data: .binaryUpload, consent: .perUse,
              overflow: .pause, lifetimes: [.activation], maxItemBytes: 64 * mib, maxItems: 16,
              maxInitialCredit: 4 * mib, maxOutstandingCredit: 8 * mib, maxTimeoutMs: 300_000),
        .init(capability: "mic.record", version: 1, mode: .stream, data: .binaryUpload, consent: .perUse,
              overflow: .pause, lifetimes: [.activation], maxItemBytes: 64 * mib, maxItems: 1,
              maxInitialCredit: 256 * kib, maxOutstandingCredit: mib, maxTimeoutMs: 600_000),
        .init(capability: "permission.query", version: 1, mode: .unary, data: .none, consent: .none,
              overflow: .none, lifetimes: [.activation], maxItemBytes: 0, maxItems: 0,
              maxInitialCredit: 0, maxOutstandingCredit: 0, maxTimeoutMs: 30_000),
        .init(capability: "permission.request", version: 1, mode: .unary, data: .none, consent: .perUse,
              overflow: .none, lifetimes: [.activation], maxItemBytes: 0, maxItems: 0,
              maxInitialCredit: 0, maxOutstandingCredit: 0, maxTimeoutMs: 300_000),
    ]

    /// Envelope-level caps: the largest bound any v1 revision allows.
    public static let envelopeMaxTimeoutMs: UInt64 = revisions.map { $0.maxTimeoutMs }.max() ?? 0
    public static let envelopeMaxInitialCredit: UInt64 = revisions.map { $0.maxInitialCredit }.max() ?? 0
    public static let envelopeMaxGrant: UInt64 = revisions.map { $0.maxOutstandingCredit }.max() ?? 0

    public static func find(_ capability: String, version: UInt32) -> DeviceRevisionPolicy? {
        revisions.first { DeviceWire.sameName($0.capability, capability) && $0.version == version }
    }

    /// The result member that carries a binary-upload revision's verified
    /// items: `item` (one object) for `mic.record`, `items` otherwise.
    public static func resultItemField(_ capability: String) -> String {
        capability == "mic.record" ? "item" : "items"
    }
}
