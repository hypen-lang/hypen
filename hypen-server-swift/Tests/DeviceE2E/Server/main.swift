// Device Capability Protocol (RFC 001) — end-to-end test server.
//
// A real `RemoteServer` (NIO + WebSocketKit) — device plane on by default,
// tuned with `configureDevice(...)` — driven by
// `Tests/DeviceE2E/device-e2e.test.ts`: the TypeScript web client
// (`RemoteEngine` + `FakeDeviceHost`) connects over a real WebSocket and
// dispatches the actions below; every handler reports what the Swift
// device API returned as one `E2E {json}` line on stderr (see `report`),
// which the test asserts on.
//
// Usage: HypenDeviceE2EServer <port>
// stdin commands: `broadcast <action> [json payload]` → RemoteServer.broadcastAction.

import Foundation
import HypenServer

// MARK: - Reporting

// Reports go to their own stream, stderr, one direct `write` per line under
// a lock. stdout belongs to the HypenServer logger, which writes through
// `print` — the C `stdout` stream, block-buffered when stdout is a pipe and
// flushed at arbitrary 4 KiB boundaries, mid-line. A report written to the
// stdout file descriptor directly would land while half a log line still
// sat in that buffer and be glued onto it; and flushing stdout from here is
// not an option either (`fflush(NULL)` takes every stream's lock, including
// stdin's, which the command thread holds while blocked in `readLine` — a
// deadlock on the event loop). Nothing else in the process writes stderr
// in normal operation; the test still finds the `E2E {` marker anywhere in
// a line, so a stray unterminated write there (a runtime diagnostic) can't
// hide a report.
let outLock = NSLock()

func report(_ tag: String, _ fields: [String: Any]) {
    var obj = fields
    obj["tag"] = tag
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    outLock.lock()
    FileHandle.standardError.write(Data(("E2E " + line + "\n").utf8))
    outLock.unlock()
}

/// Log-style noise through `print` (the logger's path), deliberately not
/// flushed: the report stream must survive any amount of it.
func noise(_ i: Int, _ width: Int) {
    print("[E2ENoise] DEBUG: line \(i) " + String(repeating: "x", count: width))
}

func failure(_ e: DeviceError) -> [String: Any] {
    ["ok": false, "code": e.code.rawValue, "detail": e.platformDetail ?? ""]
}

func payloadDict(_ ctx: ActionHandlerContext) -> [String: Any] {
    (ctx.action.payload as? [String: Any]) ?? [:]
}

/// Deterministic download bytes.
func pattern(_ n: Int) -> Data {
    Data((0..<n).map { UInt8(truncatingIfNeeded: ($0 &* 31) ^ ($0 >> 8)) })
}

// MARK: - App

let port = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 0 : 0
let app = HypenApp()

// Route modules for the lifecycle sweep: activating /home starts a slow
// activation-owned gallery.pick; leaving /home deactivates the module, which
// must cancel it (RFC 001 §2.7).
_ = app.module("Idle").defineState([:]).build()
_ = app.module("Other").defineState([:]).build()
_ = app.module("Home").defineState([:])
    .onActivatedAsync { _, device in
        report("homeActivated", ["supports": device.supports("gallery.pick")])
        let r = await device.gallery.pick([.photo])
        switch r {
        case .success(let v): report("homePick", ["ok": true, "count": v.items.count])
        case .failure(let e): report("homePick", failure(e))
        }
    }
    .build()

let capabilityNames = [
    "core.capabilities", "bluetooth.scan", "bluetooth.select", "camera.capture", "file.pick",
    "file.save", "gallery.pick", "mic.record", "permission.query", "permission.request",
]

let primary = app.module("App").defineState(["n": 0])
    .onActionAsync("caps") { ctx in
        var supports: [String: Any] = [:]
        for name in capabilityNames { supports[name] = ctx.device.supports(name) }
        report("caps", ["supports": supports, "typed": ctx.device.supports(PermissionQuery.self)])
    }
    .onActionAsync("perm") { ctx in
        let p = payloadDict(ctx)
        guard let permission = Permission(rawValue: p["permission"] as? String ?? "") else {
            report("perm", ["ok": false, "code": "badPermission"])
            return
        }
        let r = (p["mode"] as? String) == "request"
            ? await ctx.device.permissions.request(permission)
            : await ctx.device.permissions.query(permission)
        switch r {
        case .success(let v):
            report("perm", ["ok": true, "status": v.status.rawValue, "simulated": v.simulated])
        case .failure(let e):
            report("perm", failure(e))
        }
    }
    .onActionAsync("pick") { ctx in
        let r = await ctx.device.gallery.pick([.photo], maxCount: 1)
        switch r {
        case .success(let v):
            let item = v.items.first
            report("pick", [
                "ok": true, "count": v.items.count, "simulated": v.simulated,
                "contentType": item?.contentType ?? "", "size": item?.bytes.count ?? -1,
                "sha256": item.map { DeviceDigest.sha256Hex($0.bytes) } ?? "",
            ])
        case .failure(let e):
            report("pick", failure(e))
        }
    }
    .onActionAsync("pickCancel") { ctx in
        // Swift Task cancellation cancels the device request.
        let task = Task { await ctx.device.gallery.pick() }
        try? await Task.sleep(nanoseconds: 300_000_000)
        task.cancel()
        switch await task.value {
        case .success: report("pickCancel", ["ok": true])
        case .failure(let e): report("pickCancel", failure(e))
        }
    }
    .onActionAsync("camera") { ctx in
        switch await ctx.device.camera.capture(.photo) {
        case .success(let v):
            report("camera", ["ok": true, "contentType": v.contentType, "size": v.bytes.count,
                              "sha256": DeviceDigest.sha256Hex(v.bytes)])
        case .failure(let e):
            report("camera", failure(e))
        }
    }
    .onActionAsync("select") { ctx in
        switch await ctx.device.bluetooth.select(namePrefix: "HR") {
        case .success(let v): report("select", ["ok": true, "id": v.id, "name": v.name ?? ""])
        case .failure(let e): report("select", failure(e))
        }
    }
    .onActionAsync("save") { ctx in
        let size = (payloadDict(ctx)["size"] as? Int) ?? 1000
        let bytes = pattern(size)
        switch await ctx.device.files.save(bytes, name: "report.bin", contentType: "application/octet-stream") {
        case .success(let v):
            report("save", ["ok": true, "bytesWritten": Int(v.bytesWritten), "sha256": DeviceDigest.sha256Hex(bytes)])
        case .failure(let e):
            report("save", failure(e))
        }
    }
    .onActionAsync("scan") { ctx in
        let max = (payloadDict(ctx)["max"] as? Int) ?? 2
        let scan = ctx.device.bluetooth.scan()
        var ids: [String] = []
        for await device in scan {
            ids.append(device.id)
            if ids.count >= max { break } // leaving the loop abandons (cancels) the stream
        }
        let end = await scan.result()
        var fields: [String: Any] = ["ids": ids, "id": Int(scan.id ?? 0)]
        switch end {
        case .success: fields["ok"] = true
        case .failure(let e): fields.merge(failure(e)) { a, _ in a }
        }
        report("scan", fields)
    }
    .onActionAsync("flood") { ctx in
        // Reports interleaved with unflushed log output from several
        // threads at once (the harness's report stream must lose nothing).
        let p = payloadDict(ctx)
        let reportsPerWorker = (p["reports"] as? Int) ?? 50
        let workers = (p["workers"] as? Int) ?? 4
        await withTaskGroup(of: Void.self) { group in
            for w in 0..<workers {
                group.addTask {
                    for i in 0..<reportsPerWorker {
                        for j in 0..<7 { noise(i * 7 + j, 37 + (i * 13 + j * 101 + w) % 211) }
                        report("flood", ["worker": w, "i": i])
                    }
                }
            }
        }
        report("floodDone", ["workers": workers, "reports": reportsPerWorker])
    }
    .onActionAsync("mic") { ctx in
        let rec = ctx.device.mic.record(sampleRate: 16_000, channels: 1)
        var received = Data()
        var chunks = 0
        for await chunk in rec {
            received.append(chunk.bytes)
            chunks += 1
        }
        switch await rec.result() {
        case .success(let v):
            report("mic", ["ok": true, "bytes": received.count, "chunks": chunks,
                           "sha256": DeviceDigest.sha256Hex(received), "resultSha256": v.item.sha256,
                           "resultBytes": Int(v.item.bytes), "durationMs": Int(v.durationMs)])
        case .failure(let e):
            report("mic", failure(e))
        }
    }
    .build()

// MARK: - Server

let server = RemoteServer()
    .app(app)
    .module("App", primary)
    .ui("""
    module App {
        Column {
            Text("device e2e")
            Router {
                Route(path: "/") { Idle() }
                Route(path: "/home") { Home() }
                Route(path: "/other") { Other() }
            }
        }
    }
    """)
    .config(ServerConfig(
        port: port,
        hostname: "127.0.0.1",
        allowedOrigins: ["https://app.example"],
        authenticate: { request in
            request.header("Authorization") == "Bearer e2e-token"
        }
    ))
    .configureDevice(DeviceServerOptions(helloTimeoutMs: 10_000))

// Component templates the router mounts.
let componentDir = FileManager.default.temporaryDirectory
    .appendingPathComponent("hypen-device-e2e-\(ProcessInfo.processInfo.processIdentifier)")
for (name, body) in ["Idle": "Text(\"idle\")", "Home": "Text(\"home\")", "Other": "Text(\"other\")"] {
    let dir = componentDir.appendingPathComponent(name)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try "module \(name) { \(body) }".write(
        to: dir.appendingPathComponent("component.hypen"), atomically: true, encoding: .utf8)
}
_ = try server.componentsDir(componentDir.path)

server.onConnection { client in report("connected", ["client": client.id]) }
server.listen(port)
report("ready", ["port": port])

// stdin: `broadcast <action> [payload json]`
let stdinThread = Thread {
    while let line = readLine() {
        let parts = line.split(separator: " ", maxSplits: 2).map(String.init)
        guard parts.first == "broadcast", parts.count >= 2 else { continue }
        var payload: Any? = nil
        if parts.count == 3, let data = parts[2].data(using: .utf8) {
            payload = try? JSONSerialization.jsonObject(with: data)
        }
        server.broadcastAction(parts[1], payload: payload)
        report("broadcasted", ["action": parts[1]])
    }
    server.stop()
    try? FileManager.default.removeItem(at: componentDir)
    exit(0)
}
stdinThread.start()

dispatchMain()
