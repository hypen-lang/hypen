import Foundation
@preconcurrency import HypenEngine

// Device Capability Protocol (RFC 001) — the handler-facing Swift values.
//
// The protocol itself lives ONCE, in the Rust `DeviceBroker`
// (`hypen-engine-rs/src/device/`, reached through UniFFI): strict decoding of
// every device message (the §2.1 JSON limits, decision D4), handshake
// validation and selection, the binary frame codec and per-channel `seq`
// rule, the capability registry and per-revision params/result/event
// validation, leases, credit, blob verification and violation reactions.
// The Swift server re-implements none of it.
//
// What is left here is data the handler API takes and hands out:
//
// - typed params (`PermissionParams`, `MicRecordParams`, …) are ENCODED with
//   `JSONEncoder` and passed to `broker.open`, which validates them against
//   the selected revision (a refusal is `invalidParams`, nothing is sent);
// - typed results and events are DECODED with `JSONDecoder` from JSON the
//   broker produced after validating it strictly (`DeviceOutcome.success`'s
//   `resultJson`, `DeviceOutput.event`'s `eventJson`) — never from client
//   text, which only the broker reads;
// - error codes, lifetimes and the revision limits the broker reports.
//
// Provisional: nothing here is frozen until the RFC 001 §6 Phase 4
// real-driver gate passes.

// MARK: - Constants (from the Rust engine)

/// Protocol constants, read from the Rust engine (`deviceConstantsJson()`),
/// plus the WebSocket limits the Swift transport configures for them.
public enum DeviceProtocol {
    private static let constants: [String: Int] =
        (try? DeviceBrokerJSON.decode([String: Int].self, from: deviceConstantsJson())) ?? [:]

    private static func constant(_ key: String) -> Int {
        guard let n = constants[key] else { preconditionFailure("deviceConstantsJson() has no \(key)") }
        return n
    }

    /// Device protocol version this engine speaks.
    public static var version: UInt32 { UInt32(constant("protocolVersion")) }
    /// Close code of a connection whose device plane the broker closed.
    public static var devicePlaneCloseCode: UInt16 { UInt16(constant("devicePlaneCloseCode")) }
    /// Largest device text message (RFC 001 §2.1), checked before parsing.
    public static var maxTextMessageBytes: Int { constant("maxMessageBytes") }
    /// Largest binary frame a receiver must accept: the 12-byte header plus
    /// one 64 KiB chunk.
    public static var maxBinaryFrameBytes: Int { constant("frameHeaderLen") + constant("maxBulkChunkBytes") }
    /// Modules one connection may pin with live `background` work.
    public static var maxBackgroundPinnedModules: Int { constant("maxBackgroundPinnedModules") }
    /// Inbound WebSocket frame and aggregated-message cap for a transport that
    /// carries the device plane. At least `maxBinaryFrameBytes` and above
    /// `maxTextMessageBytes`, so an oversize device text reaches the broker
    /// (a counted, connection-level violation) instead of the transport
    /// closing the socket; anything larger is refused by the transport
    /// before it is buffered.
    public static let transportMaxInboundMessageBytes: Int = 2 * 1_048_576
    /// Fragments one aggregated inbound WebSocket message may span.
    public static let transportMaxInboundFragments: Int = 1_024
}

// MARK: - Lifetimes, errors

/// Requested lifetime for a device operation (RFC 001 §2.7).
public enum DeviceLifetime: String, Codable, Sendable, CaseIterable, Hashable {
    /// Owned by an exact `{moduleInstanceId, activationId}`; swept on deactivation.
    case activation
    /// Owned by `{moduleInstanceId}`; swept on destruction, not deactivation.
    /// Only revisions that list it (e.g. through
    /// `DeviceServerOptions.revisionOverrides`) admit it, within the
    /// connection's pin cap.
    case background
    /// Reserved for protocol control (`core.*`); survives module navigation.
    case connection
}

/// Closed error taxonomy for protocol v1 (RFC 001 §3).
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

/// A device call's error value.
public struct DeviceError: Hashable, Sendable, Codable {
    public var code: DeviceErrorCode
    /// Bounded diagnostic text. Portable handlers MUST NOT branch on it.
    public var platformDetail: String?

    public init(code: DeviceErrorCode, platformDetail: String? = nil) {
        self.code = code
        self.platformDetail = platformDetail
    }
}

// MARK: - Revisions (as the broker reports them)

/// Operation shape.
public enum DeviceCapabilityMode: String, Codable, Sendable, Hashable {
    case unary
    case stream
}

/// What flows on the data plane, and in which direction.
public enum DeviceDataPlane: String, Codable, Sendable, Hashable {
    /// No data plane beyond params/result.
    case none
    /// JSON `deviceEvent`s, client → server.
    case jsonEvents
    /// Binary frames, client → server.
    case binaryUpload
    /// Binary frames, server → client.
    case binaryDownload
}

/// Consent policy the client's host enforces (§2.6/§5).
public enum DeviceConsent: String, Codable, Sendable, Hashable {
    case none
    case perUse
    case persistable
}

/// Overflow policy for the data plane when credit is exhausted.
public enum DeviceOverflow: String, Codable, Sendable, Hashable {
    case none
    case dropOldest
    case pause
}

/// One capability revision exactly as the broker enforces it on this
/// connection (`DevicePlane.revision(_:version:)`: the registry revision or
/// its configured override, `maxItemBytes` capped by the broker's budget).
public struct DeviceCapabilityRevision: Codable, Sendable, Hashable {
    public let version: UInt32
    public let mode: DeviceCapabilityMode
    public let data: DeviceDataPlane
    public let consent: DeviceConsent
    public let overflow: DeviceOverflow
    /// Lifetimes a request may select. First entry is the default.
    public let lifetimes: [DeviceLifetime]
    /// Hard cap on a single blob item, bytes (0 = no blob items).
    public let maxItemBytes: UInt64
    /// Hard cap on blob items / channels per request.
    public let maxItems: UInt16
    /// Upper bound for `initialCredit`.
    public let maxInitialCredit: UInt64
    /// Upper bound on outstanding (granted, unspent) credit.
    public let maxOutstandingCredit: UInt64
    /// Upper bound a request's `timeoutMs` may take.
    public let maxTimeoutMs: UInt64
}

/// A registry revision replacement for this server's brokers (RFC 001
/// §2.7): e.g. a revision that also allows the `background` lifetime.
/// Absent fields keep the shipped registry value; the payload schemas stay
/// the shipped ones. The broker rejects an override of an unknown revision.
public struct DeviceRevisionOverride: Codable, Sendable, Hashable {
    public var capability: String
    public var version: UInt32
    public var lifetimes: [DeviceLifetime]?
    public var maxItemBytes: UInt64?
    public var maxItems: UInt16?
    public var maxInitialCredit: UInt64?
    public var maxOutstandingCredit: UInt64?
    public var maxTimeoutMs: UInt64?

    public init(
        capability: String, version: UInt32, lifetimes: [DeviceLifetime]? = nil,
        maxItemBytes: UInt64? = nil, maxItems: UInt16? = nil, maxInitialCredit: UInt64? = nil,
        maxOutstandingCredit: UInt64? = nil, maxTimeoutMs: UInt64? = nil
    ) {
        self.capability = capability
        self.version = version
        self.lifetimes = lifetimes
        self.maxItemBytes = maxItemBytes
        self.maxItems = maxItems
        self.maxInitialCredit = maxInitialCredit
        self.maxOutstandingCredit = maxOutstandingCredit
        self.maxTimeoutMs = maxTimeoutMs
    }
}

// MARK: - Broker JSON bridge

/// Codable over broker JSON: typed params out (validated by `broker.open`),
/// typed results/events in (already validated by the broker).
enum DeviceBrokerJSON {
    static func encode<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    /// Decode broker-produced JSON (never raw client text).
    static func decode<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
}

// MARK: - Capability payloads (provisional revision 1)

/// One upload item as a result reports it (`bytes` and `sha256` were
/// verified by the broker against what was received).
public struct BlobItem: Codable, Hashable, Sendable {
    public var channel: UInt16
    public var contentType: String
    public var bytes: UInt64
    public var sha256: String

    public init(channel: UInt16, contentType: String, bytes: UInt64, sha256: String) {
        self.channel = channel
        self.contentType = contentType
        self.bytes = bytes
        self.sha256 = sha256
    }
}

/// `gallery.pick` media kinds.
public enum MediaType: String, Codable, Sendable, CaseIterable, Hashable {
    case photo
    case video
}

/// `gallery.pick@1` params.
public struct GalleryPickParams: Codable, Hashable, Sendable {
    public var mediaTypes: [MediaType]
    public var maxCount: UInt16

    public init(mediaTypes: [MediaType], maxCount: UInt16) {
        self.mediaTypes = mediaTypes
        self.maxCount = maxCount
    }
}

/// `file.pick@1` params: `accept` holds MIME types or extensions.
public struct FilePickParams: Codable, Hashable, Sendable {
    public var accept: [String]
    public var maxCount: UInt16

    public init(accept: [String], maxCount: UInt16) {
        self.accept = accept
        self.maxCount = maxCount
    }
}

/// `file.save@1` result.
public struct FileSaveResult: Codable, Hashable, Sendable {
    public var bytesWritten: UInt64

    public init(bytesWritten: UInt64) {
        self.bytesWritten = bytesWritten
    }
}

/// `permission.*` status.
public enum PermissionStatus: String, Codable, Sendable, CaseIterable, Hashable {
    case granted
    case denied
    case prompt
}

/// The closed permission enum of `permission.query@1` / `permission.request@1`
/// (round 3 P1), in schema order.
public enum Permission: String, Codable, Sendable, CaseIterable, Hashable {
    case camera
    case microphone
    case photos
    case location
    case notifications
    case bluetooth
    case contacts
}

/// `permission.query@1` / `permission.request@1` params.
public struct PermissionParams: Codable, Hashable, Sendable {
    public var permission: Permission

    public init(permission: Permission) {
        self.permission = permission
    }
}

/// `permission.query@1` / `permission.request@1` result.
public struct PermissionResult: Codable, Hashable, Sendable {
    public var status: PermissionStatus

    public init(status: PermissionStatus) {
        self.status = status
    }
}

/// `bluetooth.scan@1` params (none).
public struct BluetoothScanParams: Codable, Hashable, Sendable {
    public init() {}
}

/// One advertisement seen by `bluetooth.scan`.
public struct BluetoothDevice: Codable, Hashable, Sendable {
    public var id: String
    public var name: String?
    public var rssi: Int16

    public init(id: String, name: String? = nil, rssi: Int16) {
        self.id = id
        self.name = name
        self.rssi = rssi
    }
}

/// A `bluetooth.scan@1` device event.
public struct BluetoothScanEvent: Codable, Hashable, Sendable {
    public var device: BluetoothDevice

    public init(device: BluetoothDevice) {
        self.device = device
    }
}

/// `bluetooth.scan@1` result (empty).
public struct BluetoothScanResult: Codable, Hashable, Sendable {
    public init() {}
}

/// `mic.record` sample format.
public enum MicFormat: String, Codable, Sendable, CaseIterable, Hashable {
    case pcm16
}

/// `mic.record@1` params.
public struct MicRecordParams: Codable, Hashable, Sendable {
    public var sampleRate: UInt32
    public var format: MicFormat
    /// Recording limit (not a size).
    public var maxDurationMs: UInt64?
    /// 1 (default) or 2, interleaved.
    public var channels: UInt8?

    public init(sampleRate: UInt32, format: MicFormat, maxDurationMs: UInt64? = nil, channels: UInt8? = nil) {
        self.sampleRate = sampleRate
        self.format = format
        self.maxDurationMs = maxDurationMs
        self.channels = channels
    }

    /// The effective channel count.
    public var channelCount: UInt8 { channels ?? 1 }
}

/// `mic.record@1` result.
public struct MicRecordResult: Codable, Hashable, Sendable {
    public var durationMs: UInt64
    public var item: BlobItem

    public init(durationMs: UInt64, item: BlobItem) {
        self.durationMs = durationMs
        self.item = item
    }
}

/// `camera.capture` mode.
public enum CaptureMode: String, Codable, Sendable, CaseIterable, Hashable {
    case photo
    case video
}

/// `camera.capture` lens.
public enum CameraFacing: String, Codable, Sendable, CaseIterable, Hashable {
    case front
    case back
}

/// `camera.capture@1` params (`maxDurationMs` is for video only; the broker
/// refuses it for a photo).
public struct CameraCaptureParams: Codable, Hashable, Sendable {
    public var mode: CaptureMode
    public var facing: CameraFacing?
    public var maxDurationMs: UInt64?

    public init(mode: CaptureMode, facing: CameraFacing? = nil, maxDurationMs: UInt64? = nil) {
        self.mode = mode
        self.facing = facing
        self.maxDurationMs = maxDurationMs
    }
}

/// `bluetooth.select@1` params: service UUIDs in lowercase 128-bit form.
public struct BluetoothSelectParams: Codable, Hashable, Sendable {
    public var services: [String]?
    public var namePrefix: String?

    public init(services: [String]? = nil, namePrefix: String? = nil) {
        self.services = services
        self.namePrefix = namePrefix
    }
}

/// The identity `bluetooth.select` returns (no GATT access).
public struct SelectedBluetoothDevice: Codable, Hashable, Sendable {
    public var id: String
    public var name: String?

    public init(id: String, name: String? = nil) {
        self.id = id
        self.name = name
    }
}

/// `bluetooth.select@1` result.
public struct BluetoothSelectResult: Codable, Hashable, Sendable {
    public var device: SelectedBluetoothDevice

    public init(device: SelectedBluetoothDevice) {
        self.device = device
    }
}
