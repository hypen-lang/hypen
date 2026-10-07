import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif
#if canImport(Darwin)
import Darwin
#endif

// Device Capability Protocol — host support: hashing, clocks, the prompt
// gate, and grant/cooldown storage (RFC 001 §2.4/§2.6/§2.7/§5).
// Platform-agnostic; every OS dependency sits behind a small protocol.

// MARK: - SHA-256

public enum DeviceHash {
    /// Lowercase hex SHA-256 (`^[0-9a-f]{64}$`, the blob item schema).
    public static func sha256Hex(_ data: Data) -> String {
        #if canImport(CryptoKit)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        #else
        return PortableSHA256.hex(data)
        #endif
    }
}

/// Incremental SHA-256 over an item's frames, so hashing proceeds with the
/// transfer (a streamed item of unknown size is never held whole).
struct DeviceHasher {
    #if canImport(CryptoKit)
    private var state = SHA256()

    mutating func update(_ chunk: Data) {
        state.update(data: chunk)
    }

    /// Lowercase hex digest of every chunk passed to `update`.
    func finalize() -> String {
        state.finalize().map { String(format: "%02x", $0) }.joined()
    }
    #else
    private var state = PortableSHA256()

    mutating func update(_ chunk: Data) {
        state.update(chunk)
    }

    func finalize() -> String {
        state.finalizeHex()
    }
    #endif
}

#if !canImport(CryptoKit)
/// FIPS 180-4 SHA-256, incremental, used only where CryptoKit is unavailable
/// (Linux).
struct PortableSHA256 {
    private static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    private var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                               0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    private var block: [UInt8] = []
    private var length: UInt64 = 0

    static func hex(_ data: Data) -> String {
        var hasher = PortableSHA256()
        hasher.update(data)
        return hasher.finalizeHex()
    }

    mutating func update(_ data: Data) {
        length &+= UInt64(data.count)
        for byte in data {
            block.append(byte)
            if block.count == 64 {
                compress(block)
                block.removeAll(keepingCapacity: true)
            }
        }
    }

    func finalizeHex() -> String {
        var copy = self
        let bitLength = length &* 8
        var tail = copy.block
        tail.append(0x80)
        while tail.count % 64 != 56 { tail.append(0) }
        for i in (0..<8).reversed() { tail.append(UInt8(truncatingIfNeeded: bitLength >> (UInt64(i) * 8))) }
        for start in stride(from: 0, to: tail.count, by: 64) {
            copy.compress(Array(tail[start..<(start + 64)]))
        }
        return copy.h.map { word in
            let s = String(word, radix: 16)
            return String(repeating: "0", count: 8 - s.count) + s
        }.joined()
    }

    private mutating func compress(_ chunk: [UInt8]) {
        func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }
        var w = [UInt32](repeating: 0, count: 64)
        for i in 0..<16 {
            let b = i * 4
            w[i] = UInt32(chunk[b]) << 24 | UInt32(chunk[b + 1]) << 16 | UInt32(chunk[b + 2]) << 8 | UInt32(chunk[b + 3])
        }
        for i in 16..<64 {
            let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
            let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
            w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
        }
        var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
        for i in 0..<64 {
            let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
            let ch = (e & f) ^ (~e & g)
            let t1 = hh &+ s1 &+ ch &+ Self.k[i] &+ w[i]
            let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
            let maj = (a & b) ^ (a & c) ^ (b & c)
            let t2 = s0 &+ maj
            hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
        }
        h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
        h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
    }
}
#endif

// MARK: - Clock and scheduling

/// Something that can be cancelled (timer, OS presentation, scan).
@MainActor
public protocol DeviceCancellable: AnyObject, Sendable {
    func cancel()
}

/// Monotonic time, wall time, timers, and scheduling turns. Injected so the
/// protocol core is deterministic under test (see `ManualDeviceClock` in the
/// test target).
@MainActor
public protocol DeviceClock: AnyObject {
    /// Monotonic seconds (includes device sleep where the platform allows),
    /// used for leases and deadlines.
    var monotonicNow: TimeInterval { get }
    /// Wall-clock time, used for persisted cooldowns/grants.
    var wallNow: Date { get }
    /// Run `fire` once after `delay` seconds unless cancelled.
    func schedule(after delay: TimeInterval, _ fire: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable
    /// Run `work` on a later main-actor turn (bulk transfer scheduling, §2.3).
    func enqueueTurn(_ work: @escaping @Sendable @MainActor () -> Void)
}

/// Production clock: main-actor tasks and a monotonic clock that keeps
/// counting across device sleep (`CLOCK_MONOTONIC` on Darwin), so a lease or
/// deadline measured from receipt stays measured from receipt across sleep
/// (§2.1/§2.7).
///
/// `Task.sleep` is uptime-based on Darwin: it stops counting while the
/// device sleeps, so a timer armed for 10 s before a one-hour sleep would
/// fire 9 s after wake. Timers therefore sleep in slices of at most
/// `pollInterval` and re-read the monotonic clock after each slice, firing
/// within one slice of their monotonic deadline.
@MainActor
public final class SystemDeviceClock: DeviceClock {
    /// Longest single sleep between monotonic-clock checks.
    public let pollInterval: TimeInterval
    private let timeSource: @Sendable () -> TimeInterval

    /// - Parameters:
    ///   - pollInterval: longest sleep slice before a timer re-reads the clock.
    ///   - timeSource: monotonic seconds (tests inject one; default
    ///     `CLOCK_MONOTONIC`, which includes sleep on Darwin).
    public init(pollInterval: TimeInterval = 1,
                timeSource: (@Sendable () -> TimeInterval)? = nil) {
        self.pollInterval = max(0.001, pollInterval)
        self.timeSource = timeSource ?? SystemDeviceClock.systemMonotonic
    }

    nonisolated static func systemMonotonic() -> TimeInterval {
        #if canImport(Darwin)
        return TimeInterval(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
        #else
        // Linux CLOCK_BOOTTIME would include suspend; uptime is adequate for
        // the Linux test host.
        return TimeInterval(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
        #endif
    }

    public var monotonicNow: TimeInterval { timeSource() }

    public var wallNow: Date { Date() }

    private final class TaskHandle: DeviceCancellable {
        var task: Task<Void, Never>?
        func cancel() {
            task?.cancel()
            task = nil
        }
    }

    public func schedule(after delay: TimeInterval, _ fire: @escaping @Sendable @MainActor () -> Void) -> DeviceCancellable {
        let handle = TaskHandle()
        let now = timeSource
        let slice = pollInterval
        let deadline = now() + max(0, delay)
        handle.task = Task { @MainActor in
            while true {
                let remaining = deadline - now()
                if remaining <= 0 { break }
                try? await Task.sleep(nanoseconds: UInt64(min(remaining, slice) * 1_000_000_000))
                if Task.isCancelled { return }
            }
            if Task.isCancelled { return }
            fire()
        }
        return handle
    }

    public func enqueueTurn(_ work: @escaping @Sendable @MainActor () -> Void) {
        Task { @MainActor in work() }
    }
}

// MARK: - Prompt gate (§5)

/// At most one prompt-raising operation per gate at once, across connections
/// (RFC 001 §5). Share one gate between hosts to extend the rule app-wide.
@MainActor
public final class DevicePromptGate {
    public private(set) var holder: UInt64?
    private var nextToken: UInt64 = 1

    /// Process-wide gate: one prompt at a time across every host/connection.
    public static let shared = DevicePromptGate()

    public init() {}

    public var isBusy: Bool { holder != nil }

    /// Acquire the gate; nil when another prompt holds it.
    func acquire() -> UInt64? {
        guard holder == nil else { return nil }
        let token = nextToken
        nextToken += 1
        holder = token
        return token
    }

    func release(_ token: UInt64) {
        if holder == token { holder = nil }
    }
}

// MARK: - Grant and cooldown storage (§5)

/// Key/value persistence for cooldowns and persistable grants.
public protocol DeviceKeyValueStore: AnyObject {
    func double(forKey key: String) -> Double?
    func set(_ value: Double?, forKey key: String)
}

/// Process-memory store (connection-/process-scoped grants).
public final class InMemoryDeviceStore: DeviceKeyValueStore {
    private var values: [String: Double] = [:]
    public init() {}
    public func double(forKey key: String) -> Double? { values[key] }
    public func set(_ value: Double?, forKey key: String) { values[key] = value }
}

/// `UserDefaults`-backed store, used only for authenticated `wss://` origins.
public final class UserDefaultsDeviceStore: DeviceKeyValueStore {
    private let defaults: UserDefaults
    public init(_ defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func double(forKey key: String) -> Double? {
        defaults.object(forKey: key) == nil ? nil : defaults.double(forKey: key)
    }
    public func set(_ value: Double?, forKey key: String) {
        if let value = value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}

/// Cooldowns (finite, capped exponential backoff after refusals) and
/// persistable grants with finite expiry, keyed on
/// `(normalized origin, capability)` (RFC 001 §3/§5).
///
/// Persistence follows §5: grants persist only for authenticated
/// `wss://`/`https://` origins with a parseable host; plaintext or
/// unparseable origins get connection-scoped grants
/// (`resetConnectionScoped()` on every detach) and a visible
/// development-mode marker in host UI. Cooldowns always persist across
/// reconnect/restart, whatever the scheme.
@MainActor
public final class DeviceGrantStore {
    public let origin: String
    /// Grants persist beyond the connection (authenticated origin).
    public let persistent: Bool
    private let cooldowns: DeviceKeyValueStore
    private var grantStore: DeviceKeyValueStore
    private let baseCooldown: TimeInterval
    private let maxCooldown: TimeInterval

    public init(origin: String,
                persistentStore: DeviceKeyValueStore,
                baseCooldown: TimeInterval = 30,
                maxCooldown: TimeInterval = 600) {
        let normalized = DeviceGrantStore.normalizeOrigin(origin)
        self.origin = normalized.origin
        self.persistent = normalized.authenticated
        self.cooldowns = persistentStore
        self.grantStore = normalized.authenticated ? persistentStore : InMemoryDeviceStore()
        self.baseCooldown = baseCooldown
        self.maxCooldown = maxCooldown
    }

    /// The origin as host-owned UI names it; plaintext / unauthenticated
    /// origins are marked as a development connection (§5).
    public var displayOrigin: String {
        persistent ? origin : "\(origin) (development connection, not secure)"
    }

    /// Scheme + lowercased host + effective port (default ports elided).
    nonisolated public static func normalize(_ origin: String) -> String {
        normalizeOrigin(origin).origin
    }

    /// Normalized origin plus whether it is an authenticated (`wss`/`https`)
    /// origin with a real host. Userinfo, path, query and fragment are
    /// dropped; IPv6 hosts keep their brackets. An origin that cannot be
    /// parsed is kept verbatim and never treated as authenticated.
    nonisolated static func normalizeOrigin(_ raw: String) -> (origin: String, authenticated: Bool) {
        guard let comps = URLComponents(string: raw),
              let scheme = comps.scheme?.lowercased(),
              var host = comps.host?.lowercased(), !host.isEmpty else {
            return (raw, false)
        }
        if host.contains(":"), !host.hasPrefix("[") { host = "[\(host)]" }
        let defaultPort: Int? = ["wss": 443, "https": 443, "ws": 80, "http": 80][scheme]
        let normalized: String
        if let port = comps.port, port != defaultPort {
            normalized = "\(scheme)://\(host):\(port)"
        } else {
            normalized = "\(scheme)://\(host)"
        }
        return (normalized, scheme == "wss" || scheme == "https")
    }

    private func key(_ kind: String, _ capability: String) -> String {
        "hypen.device.\(kind):\(origin):\(capability)"
    }

    public func cooldownUntil(_ capability: String) -> Date? {
        cooldowns.double(forKey: key("cooldown", capability)).map { Date(timeIntervalSince1970: $0) }
    }

    public func isCoolingDown(_ capability: String, now: Date) -> Bool {
        guard let until = cooldownUntil(capability) else { return false }
        return until > now
    }

    /// Record a refusal: base × 2^(n−1), capped.
    public func recordDenial(_ capability: String, now: Date) {
        let countKey = key("denials", capability)
        let count = (cooldowns.double(forKey: countKey) ?? 0) + 1
        cooldowns.set(count, forKey: countKey)
        let delay = min(maxCooldown, baseCooldown * pow(2, min(count - 1, 16)))
        cooldowns.set(now.addingTimeInterval(delay).timeIntervalSince1970, forKey: key("cooldown", capability))
    }

    /// A successful user acceptance resets the backoff.
    public func recordAcceptance(_ capability: String) {
        cooldowns.set(nil, forKey: key("denials", capability))
        cooldowns.set(nil, forKey: key("cooldown", capability))
    }

    public func hasGrant(_ capability: String, now: Date) -> Bool {
        guard let until = grantStore.double(forKey: key("grant", capability)) else { return false }
        return Date(timeIntervalSince1970: until) > now
    }

    public func setGrant(_ capability: String, until: Date) {
        grantStore.set(until.timeIntervalSince1970, forKey: key("grant", capability))
    }

    public func revokeGrant(_ capability: String) {
        grantStore.set(nil, forKey: key("grant", capability))
    }

    /// Unauthenticated origins: grants end with the connection (§5).
    /// Cooldowns are kept.
    func resetConnectionScoped() {
        if !persistent { grantStore = InMemoryDeviceStore() }
    }
}
