import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Remote UI handshake helpers shared by `RemoteEngine` (which needs
// Combine/URLSession and so cannot build off Apple platforms) and kept here,
// Foundation-only, so they are unit-testable everywhere:
// - the session resume credential (RFC 001 §5: "A session resume credential
//   is distinct from the public session id");
// - `hello` construction;
// - device-plane routing and admission checks for the socket (binary frame
//   classification, `sessionAck.device` decode, compression detection).
//
// Servers put a random `resumeToken` (base64url) in `sessionAck` (it is
// required to resume a session that had a negotiated device plane). The client keeps it in memory next to the session id it was
// issued for, never logs it, and sends it as `hello.resumeToken` whenever a
// hello resumes that session. A server that sends no token keeps the legacy
// id-only resume. Foundation-only so the logic is testable off-device;
// `RemoteEngine` owns one instance per engine.

/// The resume credential bound to one session id. Its descriptions and its
/// reflection (`dump`, `Mirror`, debugger summaries) redact the token so it
/// cannot leak through logging or debugging output.
struct RemoteResumeCredential: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible,
    CustomReflectable {
    /// Upper bound on an accepted token (base64url of a few hundred random
    /// bytes at most); anything else is ignored rather than echoed.
    static let maxTokenLength = 512

    private(set) var sessionId: String?
    private var token: String?

    init() {}

    /// A valid token is non-empty base64url (`A–Z a–z 0–9 - _`, optional
    /// trailing `=` padding) within `maxTokenLength`.
    static func isValidToken(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= maxTokenLength else { return false }
        let body = value.utf8.reversed().drop { $0 == UInt8(ascii: "=") }
        guard !body.isEmpty, value.utf8.count - body.count <= 2 else { return false }
        return body.allSatisfy {
            ($0 >= UInt8(ascii: "A") && $0 <= UInt8(ascii: "Z"))
                || ($0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "z"))
                || ($0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9"))
                || $0 == UInt8(ascii: "-") || $0 == UInt8(ascii: "_")
        }
    }

    /// Record a `sessionAck`. A valid `resumeToken` replaces the credential
    /// for `sessionId`; an absent or invalid one clears it (legacy server).
    mutating func acknowledge(sessionId: String, resumeToken: Any?) {
        self.sessionId = sessionId
        if let value = resumeToken as? String, Self.isValidToken(value) {
            token = value
        } else {
            token = nil
        }
    }

    /// The session ended (`sessionExpired`): the credential is useless.
    mutating func clear() {
        sessionId = nil
        token = nil
    }

    /// The token to send when resuming `sessionId`, if one was issued for it.
    func token(resuming sessionId: String) -> String? {
        self.sessionId == sessionId ? token : nil
    }

    var description: String {
        "RemoteResumeCredential(sessionId: \(sessionId ?? "nil"), token: \(token == nil ? "none" : "<redacted>"))"
    }

    var debugDescription: String { description }

    var customMirror: Mirror {
        Mirror(self, children: ["sessionId": sessionId as Any,
                                "token": token == nil ? "none" : "<redacted>"],
               displayStyle: .struct)
    }
}

/// Builds the `hello` message (Remote UI handshake).
enum RemoteHello {
    /// - Parameters:
    ///   - sessionId: the session to resume, if any.
    ///   - credential: resume credential; its token is included only when it
    ///     was issued for `sessionId`.
    ///   - props: client metadata.
    ///   - device: the DeviceHost advertisement (`hello.device`), when the
    ///     device plane is attached to this socket.
    static func message(sessionId: String?,
                        credential: RemoteResumeCredential,
                        props: [String: Any]?,
                        device: DeviceHello?) -> [String: Any] {
        var message: [String: Any] = ["type": "hello"]
        if let sessionId = sessionId {
            message["sessionId"] = sessionId
            if let token = credential.token(resuming: sessionId) {
                message["resumeToken"] = token
            }
        }
        if let props = props {
            message["props"] = props
        }
        if let device = device {
            message["device"] = device.jsonObject()
        }
        return message
    }
}

/// Device-plane checks `RemoteEngine` applies to its socket (RFC 001 §2.2/§2.3).
enum RemoteDevicePlane {
    /// Binary frames start with the version byte (1); a JSON document starts
    /// with `{` or whitespace. Anything that is not JSON goes to the device
    /// plane, which classifies/drops it (§2.3).
    static func isDeviceFrame(_ data: Data) -> Bool {
        guard let first = data.first else { return true }
        return !(first == UInt8(ascii: "{") || first == UInt8(ascii: " ")
            || first == UInt8(ascii: "\n") || first == UInt8(ascii: "\r") || first == UInt8(ascii: "\t"))
    }

    /// `sessionAck.device` from the sessionAck's exact text: the device JSON
    /// limits apply (strict parse, closed decode; RFC 001 §2.1, D4), so a
    /// float, a duplicate key or a malformed key can never be reinterpreted
    /// by a lenient parser. Absent or malformed ⇒ nil (device access not
    /// enabled for this socket; UI-only operation continues, §2.2).
    static func deviceAck(fromSessionAckText data: Data) -> DeviceAck? {
        guard case let .object(fields)? = try? DeviceStrictJSON.parse(data),
              let device = fields["device"] else { return nil }
        return try? DeviceWire.decode(DeviceAck.self, from: device)
    }

    /// Whether the opening handshake negotiated compression that SHARES a
    /// compression history across messages, from the 101 response's
    /// `Sec-WebSocket-Extensions` header — the only kind that must keep the
    /// device plane off (§2.3). `permessage-deflate` with both
    /// `server_no_context_takeover` and `client_no_context_takeover`
    /// (each message compressed on its own, the reference servers' default)
    /// is safe; so is no compression. Anything else that compresses — a
    /// missing parameter, a parameter with a value or repeated, a malformed
    /// header, an unrecognised deflate-style extension — counts as shared.
    /// Fails closed: no inspectable response (`responseAvailable == false`)
    /// counts as shared. Mirrors `deflateContextPolicy` in
    /// `@hypen-space/core/remote` and the Android client.
    static func compressionSharesContext(responseAvailable: Bool, extensionsHeader: String?) -> Bool {
        guard responseAvailable else { return true }
        guard let header = extensionsHeader,
              !header.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        guard let extensions = parseWebSocketExtensions(header) else { return true }
        for ext in extensions {
            if ext.name == "permessage-deflate" {
                let perMessage = !ext.duplicateParam
                    && ext.params.keys.contains("server_no_context_takeover")
                    && ext.params["server_no_context_takeover"] == .some(nil)
                    && ext.params.keys.contains("client_no_context_takeover")
                    && ext.params["client_no_context_takeover"] == .some(nil)
                if !perMessage { return true }
            } else if ext.name.contains("deflate") || ext.name.contains("compress") {
                // e.g. legacy `x-webkit-deflate-frame`: context behaviour unknown.
                return true
            }
        }
        return false
    }

    struct WebSocketExtension {
        /// Extension token, lower-cased.
        let name: String
        /// Parameters by lower-cased name; `nil` value for a bare parameter.
        let params: [String: String?]
        /// A parameter name appeared twice (invalid for permessage-deflate).
        let duplicateParam: Bool
    }

    /// Parse a `Sec-WebSocket-Extensions` value (names and parameter names
    /// lower-cased). Nil for a malformed value: an unterminated quoted string
    /// or an empty extension or parameter name.
    static func parseWebSocketExtensions(_ value: String) -> [WebSocketExtension]? {
        guard let items = splitOutsideQuotes(value, ",") else { return nil }
        var out: [WebSocketExtension] = []
        for item in items where !item.trimmingCharacters(in: .whitespaces).isEmpty {
            guard let segments = splitOutsideQuotes(item, ";") else { return nil }
            let name = segments[0].trimmingCharacters(in: .whitespaces).lowercased()
            if name.isEmpty { return nil }
            var params: [String: String?] = [:]
            var duplicate = false
            for raw in segments.dropFirst() {
                let seg = raw.trimmingCharacters(in: .whitespaces)
                if seg.isEmpty { continue }
                let key: String
                let val: String?
                if let eq = seg.firstIndex(of: "=") {
                    key = seg[..<eq].trimmingCharacters(in: .whitespaces).lowercased()
                    val = unquote(seg[seg.index(after: eq)...].trimmingCharacters(in: .whitespaces))
                } else {
                    key = seg.lowercased()
                    val = nil
                }
                if key.isEmpty { return nil }
                if params.keys.contains(key) { duplicate = true }
                params[key] = .some(val)
            }
            out.append(WebSocketExtension(name: name, params: params, duplicateParam: duplicate))
        }
        return out
    }

    /// Split on `separator` outside RFC 7230 quoted strings (backslash
    /// escapes). Nil on an unterminated quote.
    private static func splitOutsideQuotes(_ value: String, _ separator: Character) -> [String]? {
        var parts: [String] = []
        var current = ""
        var quoted = false
        var escaped = false
        for ch in value {
            if quoted {
                current.append(ch)
                if escaped { escaped = false }
                else if ch == "\\" { escaped = true }
                else if ch == "\"" { quoted = false }
            } else if ch == "\"" {
                quoted = true
                current.append(ch)
            } else if ch == separator {
                parts.append(current)
                current = ""
            } else {
                current.append(ch)
            }
        }
        if quoted { return nil }
        parts.append(current)
        return parts
    }

    private static func unquote(_ value: String) -> String {
        guard value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") else { return value }
        var out = ""
        var escaped = false
        for ch in value.dropFirst().dropLast() {
            if escaped { out.append(ch); escaped = false }
            else if ch == "\\" { escaped = true }
            else { out.append(ch) }
        }
        return out
    }
}


// MARK: - Upgrade request (RFC 001 §5, decision D1)

/// Builds the WebSocket upgrade request. Native clients send no `Origin` by
/// default (it is a browser-only CSWSH defence) and authenticate through
/// configured headers instead; an app may set an explicit `Origin` for a
/// server that admits it by an allowlisted origin.
enum RemoteUpgradeRequest {
    /// Headers the WebSocket handshake owns; never taken from configuration.
    static func isReserved(_ name: String) -> Bool {
        let lower = name.lowercased()
        return lower.hasPrefix("sec-websocket-")
            || ["host", "upgrade", "connection", "content-length", "origin"].contains(lower)
    }

    static func make(url: URL, config: RemoteEngineConfig) -> URLRequest {
        var request = URLRequest(url: url)
        request.timeoutInterval = config.connectTimeout
        var headers = config.upgradeHeaders
        if let provider = config.upgradeHeaderProvider {
            headers.merge(provider(url)) { _, fresh in fresh }
        }
        for (name, value) in headers.sorted(by: { $0.key < $1.key }) where !isReserved(name) {
            // Header values never carry line breaks (request splitting).
            guard !value.contains(where: { $0 == "\r" || $0 == "\n" }) else { continue }
            request.setValue(value, forHTTPHeaderField: name)
        }
        if let origin = config.origin, !origin.contains(where: { $0 == "\r" || $0 == "\n" }) {
            request.setValue(origin, forHTTPHeaderField: "Origin")
        }
        return request
    }

    /// `scheme://host[:port]` of the socket URL (what a DeviceHost binds its
    /// prompts and grants to).
    static func origin(of url: URL) -> String {
        DeviceGrantStore.normalizeOrigin(url.absoluteString).origin
    }
}

// MARK: - Connection lifecycle (socket identity)

/// Socket identity and reconnect bookkeeping for `RemoteEngine`, kept
/// Foundation-only so it is unit-testable. Every socket gets a generation;
/// open/close/receive callbacks carry the generation of the socket they
/// belong to, and anything from a socket that is no longer current is
/// ignored. Reconnects are idempotent: a socket's ending (a failed receive
/// and its close callback both report it) schedules at most one reconnect.
struct RemoteConnectionLifecycle: Equatable {
    enum Phase: Equatable {
        /// No socket (never connected, or stopped).
        case idle
        /// A socket was created and has not opened yet.
        case connecting
        /// The current socket is open.
        case open
        /// The current socket ended; one reconnect is scheduled.
        case reconnecting
    }

    enum EndDecision: Equatable {
        /// Stale or already-handled ending: do nothing.
        case ignore
        /// Schedule one reconnect (attempt number).
        case reconnect(attempt: Int)
        /// No more attempts: the connection stays down.
        case stop
    }

    private(set) var generation: UInt64 = 0
    private(set) var phase: Phase = .idle
    private(set) var attempts = 0

    /// `connect()`: the generation to establish, or nil while a socket is
    /// connecting or open, or a reconnect is already scheduled.
    mutating func connect() -> UInt64? {
        guard phase == .idle else { return nil }
        attempts = 0
        return begin()
    }

    private mutating func begin() -> UInt64 {
        generation &+= 1
        phase = .connecting
        return generation
    }

    /// Whether `generation` is the socket currently connecting or open.
    func isCurrent(_ generation: UInt64) -> Bool {
        generation == self.generation && (phase == .connecting || phase == .open)
    }

    /// The socket of `generation` opened. False when it is stale (its hello
    /// must not be sent, nor the device plane attached).
    mutating func opened(_ generation: UInt64) -> Bool {
        guard generation == self.generation, phase == .connecting else { return false }
        phase = .open
        attempts = 0
        return true
    }

    /// The socket of `generation` ended (close callback or failed receive).
    mutating func ended(_ generation: UInt64, autoReconnect: Bool, maxAttempts: Int) -> EndDecision {
        guard isCurrent(generation) else { return .ignore }
        if autoReconnect, maxAttempts == 0 || attempts < maxAttempts {
            attempts += 1
            phase = .reconnecting
            return .reconnect(attempt: attempts)
        }
        phase = .idle
        return .stop
    }

    /// The scheduled reconnect fired: the generation to establish, or nil
    /// when it was superseded (disconnect, or an explicit connect).
    mutating func reconnectFired() -> UInt64? {
        guard phase == .reconnecting else { return nil }
        return begin()
    }

    /// `disconnect()`: every existing socket becomes stale.
    mutating func disconnect() {
        generation &+= 1
        phase = .idle
    }

    /// The URLSessionTask description that carries a socket's generation
    /// into nonisolated delegate callbacks.
    static func taskDescription(_ generation: UInt64) -> String {
        "hypen-remote-\(generation)"
    }

    static func generation(fromTaskDescription description: String?) -> UInt64? {
        let prefix = "hypen-remote-"
        guard let description = description, description.hasPrefix(prefix) else { return nil }
        return UInt64(description.dropFirst(prefix.count))
    }
}

// MARK: - Logging (never message contents that can carry credentials)

enum RemoteLogRedaction {
    /// What is logged for a server frame that did not parse: its size only.
    /// Its text could be a malformed `sessionAck` carrying `resumeToken`.
    static func unparseable(byteCount: Int) -> String {
        "Failed to parse server message (\(byteCount) bytes)"
    }
}
