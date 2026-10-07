import Foundation
import Dispatch
@preconcurrency import HypenEngine

// Device Capability Protocol (RFC 001) — the host driver of one
// connection's broker.
//
// The broker is the Rust `DeviceBroker` (UniFFI, `HypenEngine`): the whole
// protocol state machine — request ids, owners and activation authority,
// leases, deadlines, credit, upload/download data planes, blob
// verification, `core.capabilities`, strict decoding and violation
// reactions, transport scheduling. It is sans-IO. `DevicePlane` is the I/O
// half the Swift server adds (the same role as `DevicePlane` in
// `@hypen-space/core`):
//
// - socket text / binary frames → `broker.onText` / `broker.onFrame`;
// - `broker.poll()` outputs → the socket (`sendText`, `sendFrame`), the
//   handler API (settlements, JSON stream events, streamed upload bytes) or
//   a connection close;
// - ONE timer, re-armed from the broker's next deadline and run through
//   `broker.tick(now)`;
// - the transport's buffered bytes are reported before every poll, and a
//   bulk turn that is due "now" runs as its own queue hop, so UI messages
//   queued meanwhile go out first (RFC 001 §2.3 priority);
// - consumer pacing: the handler layer reports consumed events / chunks
//   (`consumedEvents` / `consumedData`) as its consumer advances.
//
// Every broker call happens under one recursive lock, and outputs are
// dispatched in broker order under it: sinks are non-blocking (a socket
// write is queued on the channel's event loop, a settlement resumes a
// continuation), and re-entrant calls from a sink (e.g. a close) only mark
// another pump round.

// MARK: - Clock

/// A cancellable one-shot timer.
public protocol DeviceTimer: Sendable {
    func cancel()
}

/// Monotonic clock + one-shot timer seam (deterministic in tests).
public protocol DeviceClock: Sendable {
    /// Monotonic milliseconds.
    func nowMs() -> UInt64
    /// Run `fn` once after `ms` milliseconds (0 = after already queued work).
    func schedule(afterMs ms: UInt64, _ fn: @escaping @Sendable () -> Void) -> DeviceTimer
}

/// The process clock: `DispatchTime` (monotonic) and global-queue timers.
public struct SystemDeviceClock: DeviceClock {
    public init() {}

    public func nowMs() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds / 1_000_000
    }

    public func schedule(afterMs ms: UInt64, _ fn: @escaping @Sendable () -> Void) -> DeviceTimer {
        let item = DispatchWorkItem(block: fn)
        if ms == 0 {
            DispatchQueue.global().async(execute: item)
        } else {
            DispatchQueue.global().asyncAfter(
                deadline: .now() + .milliseconds(Int(min(ms, UInt64(Int32.max)))), execute: item)
        }
        return WorkItemTimer(item: item)
    }

    private struct WorkItemTimer: DeviceTimer, @unchecked Sendable {
        let item: DispatchWorkItem
        func cancel() { item.cancel() }
    }
}

// MARK: - Sink

/// Where a device plane's traffic goes (the connection's transport).
public struct DevicePlaneSink: Sendable {
    /// One server → client device JSON message (request, cancel, lease, grant).
    public var sendText: @Sendable (String) -> Void
    /// One binary download frame; nil ⇒ the connection carries no downloads.
    public var sendFrame: (@Sendable (Data) -> Void)?
    /// Bytes accepted by the transport but not yet written.
    public var bufferedAmount: @Sendable () -> Int
    /// The broker closed the device plane (repeated violations, the mandatory
    /// `core.capabilities` stream ended, id space exhausted): reset the socket
    /// with this code so the client reconnects with a full advertisement.
    public var closeConnection: @Sendable (UInt16, String) -> Void

    public init(
        sendText: @escaping @Sendable (String) -> Void,
        sendFrame: (@Sendable (Data) -> Void)?,
        bufferedAmount: @escaping @Sendable () -> Int = { 0 },
        closeConnection: @escaping @Sendable (UInt16, String) -> Void
    ) {
        self.sendText = sendText
        self.sendFrame = sendFrame
        self.bufferedAmount = bufferedAmount
        self.closeConnection = closeConnection
    }
}

// MARK: - Settlement

/// One verified upload item (bytes already checked against the declared
/// size and sha256 by the broker).
public struct DeviceReceivedBlob: Sendable, Hashable {
    public let channel: UInt16
    public let name: String?
    public let contentType: String
    public let bytes: Data

    public init(channel: UInt16, name: String?, contentType: String, bytes: Data) {
        self.channel = channel
        self.name = name
        self.contentType = contentType
        self.bytes = bytes
    }
}

/// A request's terminal outcome as the handler layer sees it.
enum DevicePlaneSettlement: Sendable {
    /// `resultJSON` is the client's result exactly as the broker validated it.
    case success(resultJSON: String, blobs: [DeviceReceivedBlob], simulated: Bool, release: (@Sendable () -> Void)?)
    case failure(DeviceError)
}

/// What a JSON stream / binary stream consumer receives.
protocol DevicePlaneConsumer: AnyObject, Sendable {
    /// A validated capability event (JSON text of the event object).
    func deliverEvent(_ json: String)
    /// Upload bytes of a binary-upload stream, in order.
    func deliverData(channel: UInt16, bytes: Data)
    /// The request ended; no more events / data follow. A failed request
    /// drops what its consumer has not taken yet.
    func finish(dropBuffered: Bool)
}

/// The awaited settlement of one request. Terminal exactly once.
final class DeviceSettlementBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: DevicePlaneSettlement?
    private var waiters: [CheckedContinuation<DevicePlaneSettlement, Never>] = []

    init(_ value: DevicePlaneSettlement? = nil) { self.value = value }

    func resolve(_ v: DevicePlaneSettlement) {
        lock.lock()
        if value != nil { lock.unlock(); return }
        value = v
        let w = waiters
        waiters.removeAll()
        lock.unlock()
        for c in w { c.resume(returning: v) }
    }

    var isResolved: Bool { lock.lock(); defer { lock.unlock() }; return value != nil }

    /// The settlement, once resolved (non-blocking).
    var current: DevicePlaneSettlement? { lock.lock(); defer { lock.unlock() }; return value }

    func wait() async -> DevicePlaneSettlement {
        await withCheckedContinuation { (c: CheckedContinuation<DevicePlaneSettlement, Never>) in
            lock.lock()
            if let v = value {
                lock.unlock()
                c.resume(returning: v)
                return
            }
            waiters.append(c)
            lock.unlock()
        }
    }
}

/// Everything `DevicePlane.open` takes (serialized to the broker's open JSON).
/// `paramsJSON` is a JSON object text the broker validates against the
/// selected revision.
struct DevicePlaneOpenSpec: Sendable, Encodable {
    var capability: String
    var version: UInt32?
    var paramsJSON: String
    var moduleInstanceId: String
    var activationId: UInt32
    var lifetime: DeviceLifetime?
    var timeoutMs: UInt64?
    var initialCredit: UInt64?
    var mode: DeviceCapabilityMode?
    var holdResult: Bool?
    var replayed: Bool?
    /// Admit `initialCredit: 0` on a client → server data plane (protocol
    /// fixtures open uploads at zero credit; the handler API never does).
    var allowZeroCredit: Bool?
    var download: Data?

    private enum CodingKeys: String, CodingKey {
        case capability, version, moduleInstanceId, activationId, lifetime, timeoutMs, initialCredit,
             mode, holdResult, replayed, allowZeroCredit
    }

    /// The broker's open JSON (`device_binding` "Open JSON"): the typed
    /// fields, with the params object text spliced in verbatim.
    func json() throws -> String {
        let rest = try DeviceBrokerJSON.encode(self)
        return "{\"params\":" + paramsJSON + "," + String(rest.dropFirst())
    }
}

/// `open` → a live request id with its settlement, or a local refusal.
enum DevicePlaneOpenResult: Sendable {
    case opened(id: UInt32, settlement: DeviceSettlementBox)
    case refused(DeviceError)
}

// MARK: - DevicePlane

/// The I/O driver of one connection's Rust `DeviceBroker`.
public final class DevicePlane: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private let broker: DeviceBroker
    private let sink: DevicePlaneSink
    private let clock: DeviceClock
    private let onError: @Sendable (String) -> Void
    private let binaryRoute: Bool

    private struct Pending {
        let settlement: DeviceSettlementBox
        weak var consumer: (any DevicePlaneConsumer)?
        let hasConsumer: Bool
    }
    private var pending: [UInt32: Pending] = [:]
    private var timer: DeviceTimer?
    private var timerAt: UInt64?
    private var turnQueued = false
    private var pumping = false
    private var again = false
    private var closing = false
    private var freed = false
    private var receivedTexts = 0

    /// Create a plane over a started-or-not broker built from `configJSON`.
    /// Throws `DeviceBindingError` for an invalid configuration.
    init(
        configJSON: String,
        pool: DeviceRetainedBytesPool?,
        sink: DevicePlaneSink,
        clock: DeviceClock,
        binary: Bool,
        onError: @escaping @Sendable (String) -> Void = { _ in }
    ) throws {
        self.clock = clock
        self.broker = try DeviceBroker(configJson: configJSON, pool: pool, nowMs: clock.nowMs())
        self.sink = sink
        self.binaryRoute = binary && sink.sendFrame != nil
        self.onError = onError
    }

    private func now() -> UInt64 { clock.nowMs() }

    // MARK: Lifecycle

    /// Open the connection-owned `core.capabilities` stream (RFC 001 §2.2),
    /// right after the handshake — before any module callback can request
    /// device work. False when it could not be opened.
    func start() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return false }
        let r = broker.start(nowMs: now())
        pump()
        if case .opened = r { return true }
        return false
    }

    /// Close the device plane locally (connection teardown / reset): every
    /// live request settles with `code` (nothing is sent), the timer stops
    /// and the broker's retained bytes return to the pool. Idempotent.
    public func close(_ code: DeviceErrorCode = .connectionLost) {
        lock.lock(); defer { lock.unlock() }
        if freed || closing { return }
        closing = true
        clearTimer()
        if !broker.isClosed() {
            do { try broker.close(code: code.rawValue) } catch { onError("device broker close: \(error)") }
        }
        pump()
    }

    /// True once the plane closed (locally or by the broker).
    public var isClosed: Bool {
        lock.lock(); defer { lock.unlock() }
        return isClosedLocked
    }

    private var isClosedLocked: Bool { freed || closing || broker.isClosed() }

    /// Whether downloads (`file.save`) can be carried on this connection.
    public var canSendBinary: Bool { binaryRoute }

    // MARK: Ownership (RFC 001 §2.7)

    /// A module instance became active as `activationId` (strictly increasing).
    @discardableResult
    public func ownerActivated(_ moduleInstanceId: String, activationId: UInt32) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return false }
        let ok = broker.ownerActivated(moduleInstanceId: moduleInstanceId, activationId: activationId, nowMs: now())
        pump()
        return ok
    }

    /// The activation ended: its activation-owned work is cancelled.
    public func ownerDeactivated(_ moduleInstanceId: String, activationId: UInt32) {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return }
        broker.ownerDeactivated(moduleInstanceId: moduleInstanceId, activationId: activationId, nowMs: now())
        pump()
    }

    /// The module instance was destroyed: all of its work is cancelled.
    public func ownerDestroyed(_ moduleInstanceId: String) {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return }
        broker.ownerDestroyed(moduleInstanceId: moduleInstanceId, nowMs: now())
        pump()
    }

    // MARK: Requests

    /// Open a request through the broker. A local refusal (the broker admits
    /// nothing it cannot honor) sends nothing.
    func open(_ spec: DevicePlaneOpenSpec, consumer: (any DevicePlaneConsumer)? = nil) -> DevicePlaneOpenResult {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return .refused(DeviceError(code: .connectionLost)) }
        let result: DeviceOpenResult
        do {
            result = try broker.open(specJson: try spec.json(), download: spec.download, nowMs: now())
        } catch {
            // A malformed spec is a host bug; the handler API never throws.
            onError("device open: \(error)")
            return .refused(DeviceError(code: .internal, platformDetail: String("\(error)".prefix(512))))
        }
        switch result {
        case .refused(let code, let detail):
            pump()
            return .refused(DeviceError(code: DeviceErrorCode(rawValue: code) ?? .internal, platformDetail: detail))
        case .opened(let id):
            let box = DeviceSettlementBox()
            pending[id] = Pending(settlement: box, consumer: consumer, hasConsumer: consumer != nil)
            pump()
            return .opened(id: id, settlement: box)
        }
    }

    /// Server-initiated cancel: `cancel` is sent and the request settles
    /// `cancelled`. Idempotent; unknown ids are ignored.
    public func cancel(_ id: UInt32) {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return }
        broker.cancel(id: id, nowMs: now())
        pump()
    }

    /// Release a held result's retained-bytes charge (idempotent).
    func releaseResult(_ id: UInt32) {
        lock.lock(); defer { lock.unlock() }
        if freed { return }
        broker.releaseResult(id: id)
    }

    /// The consumer finished `n` JSON events of stream `id`.
    func consumedEvents(_ id: UInt32, _ n: UInt64 = 1) {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return }
        broker.consumedEvents(id: id, n: n, nowMs: now())
        pump()
    }

    /// The consumer finished the next `chunks` data chunks of stream `id`.
    func consumedData(_ id: UInt32, _ chunks: UInt32 = 1) {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return }
        broker.consumedData(id: id, chunks: chunks, nowMs: now())
        pump()
    }

    /// Planned reopen of `core.capabilities` now; the new id, if reopened.
    @discardableResult
    public func reopenCoreCapabilities() -> UInt32? {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return nil }
        let id = broker.reopenCoreCapabilities(nowMs: now())
        pump()
        return id
    }

    // MARK: Incoming traffic

    /// One client → server device text message (the raw text). True when it
    /// was for a live request.
    @discardableResult
    public func receiveText(_ text: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return false }
        receivedTexts += 1
        let live = broker.onText(text: text, nowMs: now())
        pump()
        return live
    }

    /// One client → server binary frame. True when it was accepted.
    @discardableResult
    public func receiveFrame(_ frame: Data) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return false }
        let ok = broker.onFrame(frame: frame, nowMs: now())
        pump()
        return ok
    }

    /// A connection-level violation the host detected before feeding anything.
    public func reportViolation(_ reason: String) {
        lock.lock(); defer { lock.unlock() }
        if isClosedLocked { return }
        broker.reportViolation(reason: reason, nowMs: now())
        pump()
    }

    // MARK: Queries

    /// Negotiated live support (the live selection after every snapshot).
    public func supports(_ capability: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !isClosedLocked && broker.supports(capability: capability)
    }

    public func selectedVersion(_ capability: String) -> UInt32? {
        lock.lock(); defer { lock.unlock() }
        return freed ? nil : broker.selectedVersion(capability: capability)
    }

    /// The revision the broker enforces for `capability@version`.
    public func revision(_ capability: String, version: UInt32) -> DeviceCapabilityRevision? {
        lock.lock()
        let json = freed ? nil : broker.revisionJson(capability: capability, version: version)
        lock.unlock()
        guard let json else { return nil }
        return try? DeviceBrokerJSON.decode(DeviceCapabilityRevision.self, from: json)
    }

    public func admitsBackground(_ moduleInstanceId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !freed && broker.admitsBackground(moduleInstanceId: moduleInstanceId)
    }

    public func hasBackgroundWork(_ moduleInstanceId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !freed && broker.hasBackgroundWork(moduleInstanceId: moduleInstanceId)
    }

    public func ownerIsActive(_ moduleInstanceId: String, activationId: UInt32) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !freed && broker.ownerIsActive(moduleInstanceId: moduleInstanceId, activationId: activationId)
    }

    public func isLive(_ id: UInt32) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !freed && broker.isLive(id: id)
    }

    public var liveCount: UInt32 {
        lock.lock(); defer { lock.unlock() }
        return freed ? 0 : broker.liveCount()
    }

    public var retainedBytes: UInt64 {
        lock.lock(); defer { lock.unlock() }
        return freed ? 0 : broker.retainedBytes()
    }

    public var coreStreamId: UInt32? {
        lock.lock(); defer { lock.unlock() }
        return freed ? nil : broker.coreStreamId()
    }

    public func outstandingCredit(_ id: UInt32) -> UInt64? {
        lock.lock(); defer { lock.unlock() }
        return freed ? nil : broker.outstandingCredit(id: id)
    }

    public func outstandingEventCredit(_ id: UInt32) -> UInt64? {
        lock.lock(); defer { lock.unlock() }
        return freed ? nil : broker.outstandingEventCredit(id: id)
    }

    /// A JSON snapshot of the broker's state (`device_binding::info_json`),
    /// nil once released.
    public func infoJSON() -> String? {
        lock.lock(); defer { lock.unlock() }
        return freed ? nil : broker.infoJson()
    }

    /// Device texts this plane handed to the broker (routing diagnostics).
    var receivedTextCount: Int {
        lock.lock(); defer { lock.unlock() }
        return receivedTexts
    }

    /// Connection-level protocol violations counted so far (D3/D8).
    public var connectionViolations: Int {
        guard let json = infoJSON(),
              let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
              let n = obj["connectionViolations"] as? NSNumber else { return 0 }
        return n.intValue
    }

    // MARK: Pump

    /// Drain the broker's outputs. Non-reentrant: a sink that calls back into
    /// the plane while outputs are dispatched only marks another round, so
    /// outputs are always handled in broker order. Caller holds `lock`.
    private func pump() {
        if freed { return }
        if pumping {
            again = true
            return
        }
        pumping = true
        repeat {
            again = false
            broker.setTransportBuffered(bytes: UInt64(max(0, sink.bufferedAmount())))
            for o in broker.poll() { dispatch(o) }
        } while again
        pumping = false
        if closing || broker.isClosed() {
            release()
            return
        }
        schedule()
    }

    private func dispatch(_ o: DeviceOutput) {
        switch o {
        case .sendText(let text):
            sink.sendText(text)
        case .sendFrame(let frame):
            // A request cancelled while this turn's frames were written sends
            // nothing more: its remaining frames are discarded.
            if frame.count >= 8, !broker.isLive(id: DevicePlane.frameRequestId(frame)) { return }
            sink.sendFrame?(frame)
        case .event(let id, let json):
            if let consumer = pending[id]?.consumer {
                consumer.deliverEvent(json)
            } else {
                // No live consumer (dropped): the event is consumed so the
                // broker's credit moves on.
                broker.consumedEvents(id: id, n: 1, nowMs: now())
                again = true
            }
        case .data(let id, let channel, let bytes):
            if let consumer = pending[id]?.consumer {
                consumer.deliverData(channel: channel, bytes: bytes)
            } else {
                broker.consumedData(id: id, chunks: 1, nowMs: now())
                again = true
            }
        case .settled(let id, let outcome):
            settle(id, outcome)
        case .closeConnection(let code, let reason):
            closing = true
            clearTimer()
            sink.closeConnection(code, reason)
        }
    }

    private func settle(_ id: UInt32, _ outcome: DeviceOutcome) {
        guard let p = pending.removeValue(forKey: id) else { return }
        if case .failure = outcome {
            p.consumer?.finish(dropBuffered: true)
        } else {
            p.consumer?.finish(dropBuffered: false)
        }
        switch outcome {
        case .failure(let code, let detail):
            p.settlement.resolve(.failure(DeviceError(
                code: DeviceErrorCode(rawValue: code) ?? .internal, platformDetail: detail)))
        case .success(let resultJson, let blobs, let simulated, let held):
            let received = blobs.map {
                DeviceReceivedBlob(channel: $0.channel, name: $0.name, contentType: $0.contentType, bytes: $0.bytes)
            }
            var release: (@Sendable () -> Void)? = nil
            if held {
                release = { @Sendable [weak self] in self?.releaseResult(id) }
            }
            p.settlement.resolve(.success(resultJSON: resultJson, blobs: received, simulated: simulated, release: release))
        }
    }

    // MARK: Timer

    private func schedule() {
        if freed || closing { return }
        guard let next = broker.nextDeadline() else {
            clearTimer()
            return
        }
        let current = now()
        if next <= current {
            // Due now (a bulk turn): after already-queued work, never inline.
            clearTimer()
            if turnQueued { return }
            turnQueued = true
            _ = clock.schedule(afterMs: 0) { [weak self] in
                guard let self else { return }
                self.lock.lock(); defer { self.lock.unlock() }
                self.turnQueued = false
                self.fire()
            }
            return
        }
        if timer != nil, timerAt == next { return }
        clearTimer()
        timerAt = next
        timer = clock.schedule(afterMs: max(1, next - current)) { [weak self] in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            self.timer = nil
            self.timerAt = nil
            self.fire()
        }
    }

    private func fire() {
        if freed || closing { return }
        _ = broker.tick(nowMs: now())
        pump()
    }

    private func clearTimer() {
        timer?.cancel()
        timer = nil
        timerAt = nil
    }

    /// Release the broker (closed): anything still pending ends connectionLost.
    private func release() {
        if freed { return }
        freed = true
        closing = true
        clearTimer()
        let left = pending
        pending.removeAll()
        for (_, p) in left {
            p.consumer?.finish(dropBuffered: true)
            p.settlement.resolve(.failure(DeviceError(code: .connectionLost)))
        }
    }

    // MARK: Helpers

    /// The request id of a device frame header (u32 LE at offset 4).
    static func frameRequestId(_ frame: Data) -> UInt32 {
        let b = [UInt8](frame.prefix(8))
        return UInt32(b[4]) | UInt32(b[5]) << 8 | UInt32(b[6]) << 16 | UInt32(b[7]) << 24
    }
}
