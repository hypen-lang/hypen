import Foundation
@preconcurrency import HypenEngine

// Device Capability Protocol (RFC 001) — server-side helpers around the
// Rust broker that belong to the SDK's native layer: connection admission
// (§5, decision D1), the resume credential (§5), and locating the raw
// `hello.device` member so it is strictly decoded from the exact text the
// client sent (§2.1/§2.2, decision D7), and reading the `type` device text
// is routed on.

// MARK: - Admission (D1)

/// The HTTP upgrade request a server admits or refuses.
public struct DeviceUpgradeRequest: Sendable {
    public let uri: String
    /// Request headers in arrival order (names as sent).
    public let headers: [(name: String, value: String)]

    public init(uri: String, headers: [(name: String, value: String)]) {
        self.uri = uri
        self.headers = headers
    }

    /// First value of a header, by case-insensitive name.
    public func header(_ name: String) -> String? {
        headers.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.value
    }

    /// The `Origin` header, if the client sent one (browsers always do;
    /// native clients normally do not).
    public var origin: String? { header("Origin") }
}

/// App-supplied connection authenticator (e.g. checks a bearer token or a
/// cookie). When configured it runs for every upgrade that passed the
/// Origin check; `false` refuses the upgrade with 403.
public typealias DeviceAuthenticator = @Sendable (DeviceUpgradeRequest) async -> Bool

public enum DeviceAdmission {
    /// `scheme://host[:port]`, lowercased, default port dropped — the form
    /// browsers send and allowlists are compared in.
    public static func normalizeOrigin(_ origin: String) -> String {
        let trimmed = origin.trimmingCharacters(in: .whitespaces)
        guard let c = URLComponents(string: trimmed), let scheme = c.scheme?.lowercased(),
              let host = c.host, !host.isEmpty else {
            return trimmed.lowercased()
        }
        let defaultPort: Int? = ["http": 80, "ws": 80, "https": 443, "wss": 443][scheme]
        var out = "\(scheme)://\(host.lowercased())"
        if let port = c.port, port != defaultPort { out += ":\(port)" }
        return out
    }

    /// WebSocket upgrade admission (RFC 001 §5, decision D1). Returns nil to
    /// admit, or the refusal reason (answered with 403). Each check applies
    /// exactly when it is configured — admission is not tied to the device
    /// plane:
    ///
    /// - `Origin` present and an allowlist configured → it must be in it;
    /// - `Origin` absent with an allowlist but no authenticator → refused
    ///   (a native client can only be admitted by `authenticate`);
    /// - a configured `authenticate` runs for every request that passed the
    ///   Origin check (with or without an Origin);
    /// - neither configured → every client is admitted (the server logs one
    ///   startup warning).
    public static func refusal(
        for request: DeviceUpgradeRequest,
        allowedOrigins: Set<String>?,
        authenticate: DeviceAuthenticator?
    ) async -> String? {
        if let origin = request.origin {
            if let allowed = allowedOrigins, !allowed.contains(normalizeOrigin(origin)) {
                return "origin \(origin) not allowed"
            }
        } else if authenticate == nil, allowedOrigins != nil {
            return "no Origin and no authenticator configured"
        }
        if let authenticate {
            if await authenticate(request) != true { return "authenticate() refused the connection" }
        }
        return nil
    }
}

// MARK: - Resume credential (§5)

/// Per-session resume credentials, issued in every `sessionAck`: random
/// (256-bit), rotated on every acknowledged connection and compared in
/// constant time. A session that has had a negotiated device plane is
/// never resumed by its public id alone — the hello must also present the
/// current token; a UI-only session keeps the legacy id-only resume.
final class DeviceResumeTokens: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: [UInt8]] = [:]
    /// Sessions that have had a negotiated device plane (sticky until the
    /// session is revoked): their resume requires the current token.
    private var deviceSessions: Set<String> = []

    /// A fresh token for `sessionId` (the previous one stops working).
    /// `devicePlane: true` marks the session as one that negotiated a device
    /// plane; from then on its resume requires the token.
    func issue(_ sessionId: String, devicePlane: Bool = false) -> String {
        var rng = SystemRandomNumberGenerator() // CSPRNG on every platform
        var bytes = [UInt8](repeating: 0, count: 32)
        for i in bytes.indices { bytes[i] = rng.next() }
        let token = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        lock.lock()
        tokens[sessionId] = Array(token.utf8)
        if devicePlane { deviceSessions.insert(sessionId) }
        lock.unlock()
        return token
    }

    /// Whether resuming `sessionId` requires its current token: only a
    /// session that has had a negotiated device plane does.
    func requiresToken(_ sessionId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return deviceSessions.contains(sessionId)
    }

    /// Whether `token` is the current credential for `sessionId`. Constant
    /// time over the token contents (the length is fixed and public).
    func verify(_ sessionId: String, _ token: String?) -> Bool {
        lock.lock()
        let expected = tokens[sessionId]
        lock.unlock()
        guard let expected, let token else { return false }
        let given = Array(token.utf8)
        guard given.count == expected.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<expected.count { diff |= expected[i] ^ given[i] }
        return diff == 0
    }

    func revoke(_ sessionId: String) {
        lock.lock()
        tokens.removeValue(forKey: sessionId)
        deviceSessions.remove(sessionId)
        lock.unlock()
    }

    func removeAll() {
        lock.lock()
        tokens.removeAll()
        deviceSessions.removeAll()
        lock.unlock()
    }
}

// MARK: - Raw top-level members (routing, hello.device)

enum DeviceTopLevelMember: Equatable {
    case absent
    case found(String)
    case malformed(String)
}

/// Every top-level member named `member` of a JSON object text, as raw value
/// spans in text order, without parsing or validating anything else (a UI
/// `hello` may carry `props` the device limits would reject, and device
/// text is validated by the Rust broker alone). Linear. Keys are unescaped
/// the way `JSON.parse` does (lone surrogates never match an ASCII name).
/// `complete` is false when the text is not a well-formed object at the top
/// level; the members found before the defect are still returned.
func deviceTopLevelMembers(_ text: String, _ member: String) -> (values: [String], complete: Bool) {
    let b = Array(text.utf8)
    let n = b.count
    var i = 0
    func skipWs() {
        while i < n, b[i] == 0x20 || b[i] == 0x09 || b[i] == 0x0a || b[i] == 0x0d { i += 1 }
    }
    /// Skip a string literal starting at `b[i] == "`; false when unterminated.
    func skipString() -> Bool {
        i += 1
        while i < n {
            if b[i] == 0x5c { i += 2 } else if b[i] == 0x22 { i += 1; return true } else { i += 1 }
        }
        return false
    }
    func skipValue() {
        guard i < n else { return }
        let c = b[i]
        if c == 0x22 { _ = skipString(); return }
        if c == 0x7b || c == 0x5b {
            var depth = 0
            while i < n {
                let d = b[i]
                if d == 0x22 { _ = skipString(); continue }
                i += 1
                if d == 0x7b || d == 0x5b {
                    depth += 1
                } else if d == 0x7d || d == 0x5d {
                    depth -= 1
                    if depth == 0 { return }
                }
            }
            return
        }
        while i < n {
            let d = b[i]
            if d == 0x2c || d == 0x7d || d == 0x5d || d == 0x20 || d == 0x09 || d == 0x0a || d == 0x0d { return }
            i += 1
        }
    }
    var values: [String] = []
    skipWs()
    guard i < n, b[i] == 0x7b else { return (values, false) }
    i += 1
    let memberBytes = Array(member.utf8)
    var expectMember = true
    var members = 0
    while true {
        skipWs()
        if i >= n { return (values, false) }
        // `}` closes after a member, or an empty object; never after a comma.
        if b[i] == 0x7d { return (values, !expectMember || members == 0) }
        if b[i] == 0x2c {
            if expectMember { return (values, false) }
            expectMember = true
            i += 1
            continue
        }
        guard expectMember, b[i] == 0x22 else { return (values, false) }
        let keyStart = i
        guard skipString() else { return (values, false) }
        let key = deviceDecodeStringLiteral(b[keyStart..<i])
        skipWs()
        guard i < n, b[i] == 0x3a else { return (values, false) }
        i += 1
        skipWs()
        let valueStart = i
        skipValue()
        if i == valueStart { return (values, false) }
        if let key, key.elementsEqual(memberBytes) {
            values.append(String(decoding: b[valueStart..<min(i, n)], as: UTF8.self))
        }
        members += 1
        expectMember = false
    }
}

/// The raw text of the single top-level member `member`: absent, found, or
/// malformed (the object is not well formed at the top level, or the member
/// is duplicated — `hello.device` must be unambiguous, decision D7).
func deviceFindTopLevelMember(_ text: String, _ member: String) -> DeviceTopLevelMember {
    let (values, complete) = deviceTopLevelMembers(text, member)
    if !complete { return .malformed("malformed object") }
    if values.count > 1 { return .malformed("duplicate \"\(member)\" member") }
    if let only = values.first { return .found(only) }
    return .absent
}

/// The message `type` a client text announces, read the way `JSON.parse`
/// resolves it (the LAST top-level `type` member wins), without validating
/// anything else. Device messages are routed on this alone and handed to
/// the broker as their exact text, so malformed device JSON — duplicate
/// keys (including a duplicated `type`), number spellings, depth — is
/// strictly decoded and counted by the broker, never dropped on the way.
func deviceMessageType(_ text: String) -> String? {
    guard let raw = deviceTopLevelMembers(text, "type").values.last else { return nil }
    let bytes = Array(raw.utf8)
    guard bytes.first == 0x22, let decoded = deviceDecodeStringLiteral(bytes[...]) else { return nil }
    return String(decoding: decoded, as: UTF8.self)
}

/// UTF-8 bytes of a complete JSON string literal (quotes included), with
/// escapes resolved as `JSON.parse` resolves them; a lone surrogate escape
/// becomes U+FFFD (it can never equal a protocol name). Nil when the literal
/// is not a well-formed JSON string.
func deviceDecodeStringLiteral(_ lit: ArraySlice<UInt8>) -> [UInt8]? {
    guard lit.count >= 2, lit.first == 0x22, lit.last == 0x22 else { return nil }
    var out: [UInt8] = []
    out.reserveCapacity(lit.count)
    var i = lit.startIndex + 1
    let end = lit.endIndex - 1
    func hex4(_ at: Int) -> UInt32? {
        guard at + 4 <= end else { return nil }
        var v: UInt32 = 0
        for k in at..<(at + 4) {
            let c = lit[k]
            let d: UInt32
            switch c {
            case 0x30...0x39: d = UInt32(c - 0x30)
            case 0x41...0x46: d = UInt32(c - 0x41 + 10)
            case 0x61...0x66: d = UInt32(c - 0x61 + 10)
            default: return nil
            }
            v = v << 4 | d
        }
        return v
    }
    func append(_ scalar: UInt32) {
        let s = Unicode.Scalar(scalar) ?? "\u{FFFD}"
        out.append(contentsOf: Array(String(Character(s)).utf8))
    }
    while i < end {
        let c = lit[i]
        if c < 0x20 { return nil }
        if c == 0x22 { return nil }
        if c != 0x5c {
            out.append(c)
            i += 1
            continue
        }
        guard i + 1 < end else { return nil }
        let e = lit[i + 1]
        i += 2
        switch e {
        case 0x22: out.append(0x22)
        case 0x5c: out.append(0x5c)
        case 0x2f: out.append(0x2f)
        case 0x62: out.append(0x08)
        case 0x66: out.append(0x0c)
        case 0x6e: out.append(0x0a)
        case 0x72: out.append(0x0d)
        case 0x74: out.append(0x09)
        case 0x75:
            guard let u = hex4(i) else { return nil }
            i += 4
            if (0xD800...0xDBFF).contains(u), i + 6 <= end, lit[i] == 0x5c, lit[i + 1] == 0x75,
               let low = hex4(i + 2), (0xDC00...0xDFFF).contains(low) {
                i += 6
                append(0x10000 + ((u - 0xD800) << 10) + (low - 0xDC00))
            } else {
                append(u) // a lone surrogate is not a scalar: U+FFFD
            }
        default:
            return nil
        }
    }
    return out
}

// MARK: - Digest

/// SHA-256 as the device protocol spells it (lowercase hex), computed by the
/// Rust engine — the same function the broker verifies uploads with.
public enum DeviceDigest {
    public static func sha256Hex(_ bytes: Data) -> String {
        deviceSha256Hex(bytes: bytes)
    }
}
