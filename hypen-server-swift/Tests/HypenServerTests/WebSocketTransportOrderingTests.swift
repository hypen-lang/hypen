import XCTest
import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import WebSocketKit
import HypenServer

// `WebSocketKitTransport` over a REAL loopback WebSocket (NIO server +
// WebSocketKit client). The device plane sends from the NIO event loop (the
// pump after an incoming credit grant), from the clock's dispatch queue
// (bulk turns, timers) and from handler tasks, in broker order under its
// lock. NIO writes immediately on the loop but queues writes made from any
// other thread, so a bare `ws.send` let a frame sent on the loop overtake
// frames still queued from another thread — a `file.save` download then
// failed at the client with `download seq N, expected M`. The in-memory
// transports the other tests use cannot show this; these tests do.

// MARK: - Loopback pair

/// Everything the client received, in arrival order: `"<n>"` for a frame
/// numbered n (binary or text), `"close:<code>"` when the socket closed.
private final class ClientLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []

    func append(_ item: String) {
        lock.lock(); items.append(item); lock.unlock()
    }

    var snapshot: [String] {
        lock.lock(); defer { lock.unlock() }
        return items
    }

    func wait(until done: ([String]) -> Bool, timeout: TimeInterval = 20) -> [String] {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let items = snapshot
            if done(items) || Date() > deadline { return items }
            usleep(2_000)
        }
    }
}

private final class LoopbackPair: @unchecked Sendable {
    let group: MultiThreadedEventLoopGroup
    let serverChannel: Channel
    /// The server side of the connection, to wrap in the transport.
    let server: WebSocket
    let client: WebSocket
    let log: ClientLog

    private init(group: MultiThreadedEventLoopGroup, serverChannel: Channel,
                 server: WebSocket, client: WebSocket, log: ClientLog) {
        self.group = group
        self.serverChannel = serverChannel
        self.server = server
        self.client = client
        self.log = log
    }

    static func open() throws -> LoopbackPair {
        let group = MultiThreadedEventLoopGroup(numberOfThreads: 4)
        let serverSocket = group.next().makePromise(of: WebSocket.self)
        let bootstrap = ServerBootstrap(group: group)
            .serverChannelOption(.socketOption(.so_reuseaddr), value: 1)
            .childChannelInitializer { channel in
                let upgrader = NIOWebSocketServerUpgrader(
                    maxFrameSize: 1 << 20,
                    shouldUpgrade: { channel, _ in channel.eventLoop.makeSucceededFuture(HTTPHeaders()) },
                    upgradePipelineHandler: { channel, _ in
                        WebSocket.server(on: channel) { ws in serverSocket.succeed(ws) }
                    }
                )
                // The initializer runs on the channel's event loop.
                do {
                    try channel.pipeline.syncOperations.configureHTTPServerPipeline(
                        withServerUpgrade: (upgraders: [upgrader], completionHandler: { _ in }))
                    return channel.eventLoop.makeSucceededVoidFuture()
                } catch {
                    return channel.eventLoop.makeFailedFuture(error)
                }
            }
        let serverChannel = try bootstrap.bind(host: "127.0.0.1", port: 0).wait()
        guard let port = serverChannel.localAddress?.port else {
            throw NSError(domain: "LoopbackPair", code: 1)
        }

        let log = ClientLog()
        let clientSocket = group.next().makePromise(of: WebSocket.self)
        try WebSocket.connect(
            to: "ws://127.0.0.1:\(port)/ws",
            configuration: WebSocketClient.Configuration(maxFrameSize: 1 << 20),
            on: group
        ) { ws in
            ws.onText { _, text in
                log.append(String(text.dropFirst())) // "t<n>"
            }
            ws.onBinary { _, buffer in
                var buffer = buffer
                let n = buffer.readInteger(endianness: .little, as: UInt64.self) ?? UInt64.max
                log.append(String(n))
            }
            ws.onClose.whenComplete { _ in
                let code = ws.closeCode.map { "\($0)" } ?? "nil"
                log.append("close:\(code)")
            }
            clientSocket.succeed(ws)
        }.wait()

        return LoopbackPair(
            group: group, serverChannel: serverChannel,
            server: try serverSocket.futureResult.wait(),
            client: try clientSocket.futureResult.wait(), log: log)
    }

    func shutdown() {
        _ = try? client.close().wait()
        _ = try? serverChannel.close().wait()
        try? group.syncShutdownGracefully()
    }
}

/// Frame `n`: its number (UInt64 LE) plus some payload.
private func frame(_ n: Int, payload: Int = 120) -> Data {
    var d = Data(count: 8 + payload)
    withUnsafeBytes(of: UInt64(n).littleEndian) { d.replaceSubrange(0..<8, with: $0) }
    return d
}

/// The first position where `got` departs from `want`, for a readable failure.
private func firstDivergence(_ got: [String], _ want: [String]) -> String {
    for i in 0..<min(got.count, want.count) where got[i] != want[i] {
        return "at \(i): got \(got[i]), expected \(want[i]) (next: \(got[i..<min(got.count, i + 6)]))"
    }
    return "counts \(got.count) vs \(want.count)"
}

/// Hands out frame numbers in one global order and sends each under the
/// same lock — how the device plane sends broker output in broker order.
private final class Sequencer: @unchecked Sendable {
    private let lock = NSLock()
    private var next = 0
    let total: Int
    let transport: WebSocketKitTransport

    init(total: Int, transport: WebSocketKitTransport) {
        self.total = total
        self.transport = transport
    }

    /// Send the next frame; false once all are sent.
    func sendNext() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard next < total else { return false }
        let n = next
        next += 1
        if n % 7 == 0 {
            transport.sendDeviceText("t\(n)")
        } else {
            transport.sendBinary(frame(n))
        }
        return true
    }
}

/// Sends bursts from the transport's event loop, rescheduling itself.
private final class LoopProducer: @unchecked Sendable {
    let sequencer: Sequencer
    let loop: EventLoop
    let done: EventLoopPromise<Void>

    init(sequencer: Sequencer, loop: EventLoop) {
        self.sequencer = sequencer
        self.loop = loop
        self.done = loop.makePromise(of: Void.self)
    }

    func start() { loop.execute { self.burst() } }

    private func burst() {
        for _ in 0..<Int.random(in: 1...6) {
            if !sequencer.sendNext() { done.succeed(()); return }
        }
        loop.execute { self.burst() }
    }
}

// MARK: - Tests

final class WebSocketTransportOrderingTests: XCTestCase {

    /// Deterministic: a write made ON the loop while writes from another
    /// thread are still queued for it must go out after them.
    func testALoopWriteNeverOvertakesWritesQueuedFromAnotherThread() throws {
        let pair = try LoopbackPair.open()
        defer { pair.shutdown() }
        let transport = WebSocketKitTransport(pair.server)
        let rounds = 20
        let perRound = 25

        for round in 0..<rounds {
            let base = round * (perRound + 1)
            let offLoopDone = DispatchSemaphore(value: 0)
            let roundDone = pair.server.eventLoop.makePromise(of: Void.self)
            pair.server.eventLoop.execute {
                // While this task holds the loop, another thread sends
                // frames base..<base+perRound (they can only be queued)...
                DispatchQueue.global().async {
                    for i in 0..<perRound {
                        if i % 5 == 0 {
                            transport.sendDeviceText("t\(base + i)")
                        } else {
                            transport.sendBinary(frame(base + i))
                        }
                    }
                    offLoopDone.signal()
                }
                offLoopDone.wait()
                // ...then the loop sends the next frame in call order.
                transport.sendBinary(frame(base + perRound))
                roundDone.succeed(())
            }
            try roundDone.futureResult.wait()
        }

        let total = rounds * (perRound + 1)
        let want = (0..<total).map(String.init)
        let got = pair.log.wait { $0.count >= total }
        XCTAssertEqual(got, want, firstDivergence(got, want))
    }

    /// Stress: frames numbered in one global order (under one lock, like
    /// the device plane) sent from the event loop, dispatch-queue threads
    /// and tasks at once reach the client in exactly that order.
    func testWritesFromTheLoopQueuesAndTasksReachTheClientInCallOrder() async throws {
        let pair = try LoopbackPair.open()
        defer { pair.shutdown() }
        let transport = WebSocketKitTransport(pair.server)
        let total = 8000
        let sequencer = Sequencer(total: total, transport: transport)

        let loopProducer = LoopProducer(sequencer: sequencer, loop: pair.server.eventLoop)
        let queues = DispatchGroup()
        for _ in 0..<2 {
            queues.enter()
            DispatchQueue.global().async {
                while sequencer.sendNext() {
                    if Int.random(in: 0..<8) == 0 { usleep(20) }
                }
                queues.leave()
            }
        }
        loopProducer.start()
        await withTaskGroup(of: Void.self) { tasks in
            for _ in 0..<2 {
                tasks.addTask {
                    while sequencer.sendNext() {
                        if Int.random(in: 0..<16) == 0 { await Task.yield() }
                    }
                }
            }
        }
        // Never block an async context on the group: resume when it drains.
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queues.notify(queue: .global()) { done.resume() }
        }
        try await loopProducer.done.futureResult.get()

        let want = (0..<total).map(String.init)
        let got = pair.log.wait { $0.count >= total }
        XCTAssertEqual(got, want, firstDivergence(got, want))

        // Every accepted byte was written: the buffered amount the broker
        // schedules bulk frames against drains back to zero.
        let deadline = Date().addingTimeInterval(10)
        while transport.bufferedAmount() != 0 && Date() < deadline { usleep(2_000) }
        XCTAssertEqual(transport.bufferedAmount(), 0)
    }

    /// A close issued on the loop goes out after every frame sent before
    /// it from another thread (a 1012 reset never drops earlier frames).
    func testCloseIsOrderedAfterFramesSentBeforeIt() throws {
        let pair = try LoopbackPair.open()
        defer { pair.shutdown() }
        let transport = WebSocketKitTransport(pair.server)
        let total = 400

        let offLoopDone = DispatchSemaphore(value: 0)
        pair.server.eventLoop.execute {
            DispatchQueue.global().async {
                for n in 0..<total { transport.sendBinary(frame(n, payload: 2048)) }
                offLoopDone.signal()
            }
            offLoopDone.wait()
            transport.close(code: 4001, reason: "done")
        }

        let got = pair.log.wait { $0.last?.hasPrefix("close:") == true }
        let want = (0..<total).map(String.init)
        XCTAssertEqual(Array(got.dropLast()), want, firstDivergence(Array(got.dropLast()), want))
        XCTAssertEqual(got.last, "close:\(WebSocketErrorCode(codeNumber: 4001))")
    }

    /// Accepted-but-unwritten bytes count toward `bufferedAmount` from the
    /// moment of the call (the broker's bulk scheduling reads it).
    func testBufferedAmountCountsQueuedWritesUntilTheyAreWritten() throws {
        let pair = try LoopbackPair.open()
        defer { pair.shutdown() }
        let transport = WebSocketKitTransport(pair.server)

        let checked = pair.server.eventLoop.makePromise(of: Int.self)
        let offLoopDone = DispatchSemaphore(value: 0)
        pair.server.eventLoop.execute {
            // Held loop: the off-loop writes can only be queued.
            DispatchQueue.global().async {
                transport.sendBinary(frame(0, payload: 992))  // 1000 bytes
                transport.sendDeviceText("t1")                 // 2 bytes
                offLoopDone.signal()
            }
            offLoopDone.wait()
            checked.succeed(transport.bufferedAmount())
        }
        XCTAssertEqual(try checked.futureResult.wait(), 1002)

        let got = pair.log.wait { $0.count >= 2 }
        XCTAssertEqual(got, ["0", "1"])
        let deadline = Date().addingTimeInterval(10)
        while transport.bufferedAmount() != 0 && Date() < deadline { usleep(2_000) }
        XCTAssertEqual(transport.bufferedAmount(), 0)
    }
}
