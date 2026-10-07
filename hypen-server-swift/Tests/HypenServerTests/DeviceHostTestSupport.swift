import Foundation
import XCTest
@testable import HypenServer
import HypenEngine

// Shared fixtures for the Swift device plane tests (DevicePlaneTests,
// DeviceSessionTests): a manual clock, a recording sink/transport, and a
// scripted "client" that answers the broker with raw protocol text/frames.

/// Deterministic clock: time moves only through `advance(by:)`; due timers
/// (including 0 ms "after queued work" hops) run on `advance`/`runDue`.
final class ManualDeviceClock: DeviceClock, @unchecked Sendable {
    private let lock = NSLock()
    private var now: UInt64
    private var nextId = 0
    private var timers: [(id: Int, at: UInt64, fn: @Sendable () -> Void)] = []

    init(start: UInt64 = 1_000) { now = start }

    func nowMs() -> UInt64 { lock.withLock { now } }

    func schedule(afterMs ms: UInt64, _ fn: @escaping @Sendable () -> Void) -> DeviceTimer {
        lock.lock()
        nextId += 1
        let id = nextId
        timers.append((id, now + ms, fn))
        lock.unlock()
        return Handle(clock: self, id: id)
    }

    private struct Handle: DeviceTimer, @unchecked Sendable {
        weak var clock: ManualDeviceClock?
        let id: Int
        func cancel() { clock?.cancel(id) }
    }

    private func cancel(_ id: Int) {
        lock.withLock { timers.removeAll { $0.id == id } }
    }

    var pendingTimers: Int { lock.withLock { timers.count } }

    /// Run every timer due now (repeatedly, as fired timers re-arm).
    func runDue() {
        for _ in 0..<10_000 {
            lock.lock()
            guard let i = timers.indices.min(by: { timers[$0].at < timers[$1].at }), timers[i].at <= now else {
                lock.unlock()
                return
            }
            let t = timers.remove(at: i)
            lock.unlock()
            t.fn()
        }
    }

    func advance(by ms: UInt64) {
        let target = lock.withLock { now + ms }
        // Step through due timers in time order.
        for _ in 0..<10_000 {
            lock.lock()
            guard let i = timers.indices.min(by: { timers[$0].at < timers[$1].at }), timers[i].at <= target else {
                now = target
                lock.unlock()
                runDue()
                return
            }
            let t = timers.remove(at: i)
            now = max(now, t.at)
            lock.unlock()
            t.fn()
        }
    }
}

/// Records everything a device plane sends.
final class DeviceSinkRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var texts: [String] = []
    private(set) var frames: [Data] = []
    private(set) var closes: [(code: UInt16, reason: String)] = []
    var buffered = 0

    var sink: DevicePlaneSink {
        DevicePlaneSink(
            sendText: { [weak self] t in self?.lock.withLock { self?.texts.append(t) } },
            sendFrame: { [weak self] f in self?.lock.withLock { self?.frames.append(f) } },
            bufferedAmount: { [weak self] in self?.lock.withLock { self?.buffered ?? 0 } ?? 0 },
            closeConnection: { [weak self] c, r in self?.lock.withLock { self?.closes.append((c, r)) } }
        )
    }

    var messages: [[String: Any]] {
        lock.withLock { texts }.compactMap {
            (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
        }
    }

    var sentFrames: [Data] { lock.withLock { frames } }
    var closed: [(code: UInt16, reason: String)] { lock.withLock { closes } }

    func requests(_ capability: String? = nil) -> [[String: Any]] {
        messages.filter {
            ($0["type"] as? String) == "deviceRequest" && (capability == nil || ($0["capability"] as? String) == capability)
        }
    }

    func controls(_ id: UInt32, _ key: String) -> [Any] {
        messages.compactMap { m -> Any? in
            guard (m["type"] as? String) == "deviceEvent", (m["id"] as? NSNumber)?.uint32Value == id,
                  let control = m["control"] as? [String: Any] else { return nil }
            return control[key]
        }
    }

    /// Wait (real time, bounded) until `predicate` holds.
    func wait(_ what: String, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line,
              _ predicate: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !predicate() {
            if Date() > end {
                XCTFail("timed out waiting for \(what)", file: file, line: line)
                return
            }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    /// The id of the request for `capability` sent after the first `count`
    /// ones (waits for it).
    func nextRequestId(_ capability: String, after count: Int,
                       file: StaticString = #filePath, line: UInt = #line) async -> UInt32 {
        await wait("\(capability) request #\(count + 1)", file: file, line: line) { requests(capability).count > count }
        let all = requests(capability)
        return all.count > count ? (all[count]["id"] as? NSNumber)?.uint32Value ?? 0 : 0
    }

    /// The id of the latest request for `capability`, once sent.
    func requestId(_ capability: String, file: StaticString = #filePath, line: UInt = #line) async -> UInt32 {
        await wait("\(capability) request", file: file, line: line) { !requests(capability).isEmpty }
        return (requests(capability).last?["id"] as? NSNumber)?.uint32Value ?? 0
    }
}

enum DeviceTestWire {
    /// A hello advertising every registry capability at revision 1.
    static let fullHello = #"{"protocolVersions":[1],"binary":true,"capabilities":["#
        + #"{"name":"core.capabilities","versions":[1]},{"name":"bluetooth.scan","versions":[1]},"#
        + #"{"name":"bluetooth.select","versions":[1]},{"name":"camera.capture","versions":[1]},"#
        + #"{"name":"file.pick","versions":[1]},{"name":"file.save","versions":[1]},"#
        + #"{"name":"gallery.pick","versions":[1]},{"name":"mic.record","versions":[1]},"#
        + #"{"name":"permission.query","versions":[1]},{"name":"permission.request","versions":[1]}]}"#

    static func frame(_ id: UInt32, _ channel: UInt16, _ seq: UInt32, _ payload: Data,
                      version: UInt8 = 1, flags: UInt8 = 0) -> Data {
        var d = Data([version, flags])
        withUnsafeBytes(of: channel.littleEndian) { d.append(contentsOf: $0) }
        withUnsafeBytes(of: id.littleEndian) { d.append(contentsOf: $0) }
        withUnsafeBytes(of: seq.littleEndian) { d.append(contentsOf: $0) }
        d.append(payload)
        return d
    }

    static func json(_ object: [String: Any]) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }

    static func response(_ id: UInt32, result: [String: Any], simulated: Bool = false) -> String {
        var o: [String: Any] = ["type": "deviceResponse", "id": id, "result": result]
        if simulated { o["simulated"] = true }
        return json(o)
    }

    static func error(_ id: UInt32, _ code: String, _ detail: String? = nil) -> String {
        var e: [String: Any] = ["code": code]
        if let detail { e["platformDetail"] = detail }
        return json(["type": "deviceResponse", "id": id, "error": e])
    }

    static func event(_ id: UInt32, _ event: [String: Any]) -> String {
        json(["type": "deviceEvent", "id": id, "event": event])
    }

    static func control(_ id: UInt32, _ control: [String: Any]) -> String {
        json(["type": "deviceEvent", "id": id, "control": control])
    }

    static func bytes(_ n: Int, seed: UInt8 = 7) -> Data {
        Data((0..<n).map { UInt8(truncatingIfNeeded: $0 &* 13 &+ Int(seed)) })
    }
}

/// A device plane over the real Rust broker with a manual clock, owner
/// `m1` activation 1, and the core stream opened.
struct PlaneHarness {
    let plane: DevicePlane
    let recorder: DeviceSinkRecorder
    let clock: ManualDeviceClock

    init(extraConfig: String = "", binary: Bool = true, activate: Bool = true) throws {
        let ack = try XCTUnwrap(deviceNegotiate(helloJson: DeviceTestWire.fullHello, binaryRoute: binary))
        recorder = DeviceSinkRecorder()
        clock = ManualDeviceClock()
        plane = try DevicePlane(
            configJSON: "{\"ack\":\(ack)\(extraConfig)}", pool: nil, sink: recorder.sink,
            clock: clock, binary: binary)
        XCTAssertTrue(plane.start())
        if activate { XCTAssertTrue(plane.ownerActivated("m1", activationId: 1)) }
    }

    /// A handler-facing context owned by `m1` activation 1.
    func context(provenance: DeviceProvenance = .origin, live: @escaping @Sendable () -> Bool = { true }) -> DeviceContext {
        DeviceContext(plane: plane, owner: DeviceOwnerAuthority(moduleInstanceId: "m1", activationId: 1),
                      provenance: provenance, ownerLive: live)
    }
}

// MARK: - Bounded awaits

/// Timed out waiting for a device outcome.
struct DeviceTestTimeout: Error, CustomStringConvertible {
    var description: String { "timed out waiting for a device outcome" }
}

/// The first of two outcomes, resumed exactly once.
private final class FirstOutcome<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T?, Never>?
    private var resolved: T??

    func install(_ c: CheckedContinuation<T?, Never>) {
        lock.lock()
        if let r = resolved {
            lock.unlock()
            c.resume(returning: r)
            return
        }
        continuation = c
        lock.unlock()
    }

    func resolve(_ value: T?) {
        lock.lock()
        if resolved != nil {
            lock.unlock()
            return
        }
        resolved = .some(value)
        let c = continuation
        continuation = nil
        lock.unlock()
        c?.resume(returning: value)
    }
}

/// `task`'s value, or nil once `timeout` elapsed first. Returns at the
/// timeout even when `task` never finishes — it never waits for the loser.
///
/// (A task group cannot do this: `withTaskGroup` only returns once EVERY
/// child finished, so a child awaiting a task that ignores its cancellation
/// kept the group — and the test, and the whole xctest process — waiting
/// forever. That turned a device outcome that never arrived into a hung,
/// orphaned test process instead of a failure.)
func awaitBounded<T: Sendable>(_ task: Task<T, Never>, timeout: TimeInterval) async -> T? {
    let first = FirstOutcome<T>()
    let watcher = Task { first.resolve(await task.value) }
    let timer = Task {
        try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
        first.resolve(nil)
    }
    let value = await withCheckedContinuation { first.install($0) }
    timer.cancel()
    if value == nil { watcher.cancel() }
    return value
}

/// Await `task` for at most `timeout`; on timeout the task is cancelled (the
/// device API settles `cancelled` then), a failure is recorded and nil is
/// returned — so a regression fails the test instead of hanging it, even
/// when the task does not honour its cancellation.
func settle<T: Sendable>(
    _ task: Task<T, Never>, timeout: TimeInterval = 5,
    file: StaticString = #filePath, line: UInt = #line
) async -> T? {
    let value = await awaitBounded(task, timeout: timeout)
    task.cancel()
    guard let value else {
        XCTFail("timed out waiting for a device outcome", file: file, line: line)
        return nil
    }
    return value
}

/// `settle` for an async expression.
func settle<T: Sendable>(
    timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line,
    _ body: @escaping @Sendable () async -> T
) async -> T? {
    await settle(Task { await body() }, timeout: timeout, file: file, line: line)
}

extension Optional {
    /// The value, or a thrown `DeviceTestTimeout` (after `settle` failed).
    func unwrapped() throws -> Wrapped {
        guard let v = self else { throw DeviceTestTimeout() }
        return v
    }
}
