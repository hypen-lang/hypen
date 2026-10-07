import Foundation
import HypenServer

let ui = try String(contentsOfFile: "../examples/device-lab/app.hypen", encoding: .utf8)
let app = HypenApp()
let builder = app.module("App").defineState(["server":"Swift", "runs":0, "result":"Connected. Choose a check.", "detail":"", "history":""])
let names = ["gallery.pick","file.pick","file.save","camera.capture","mic.record","bluetooth.scan","bluetooth.select","permission.query","permission.request"]
for action in ["status","query","permission","gallery","file","save","camera","record","scan","bluetooth","cancel","ping"] {
    builder.onActionAsync(action) { ctx in
        ctx.state.set("result", "\(action): running…")
        ctx.state.set("runs", (ctx.state.get("runs") as? Int ?? 0) + 1)
        var detail = ""
        switch action {
        case "status": detail = names.map { "\($0): \(ctx.device.supports($0))" }.joined(separator: "\n")
        case "query": detail = String(describing: await ctx.device.permissions.query(.camera))
        case "permission": detail = String(describing: await ctx.device.permissions.request(.microphone))
        case "save": detail = String(describing: await ctx.device.save(Data(String(repeating:"Device Lab payload 0123456789\n",count:3400).utf8),name:"device-lab.txt",contentType:"text/plain"))
        case "record":
            let stream = ctx.device.mic.record(sampleRate:16000,channels:1,maxDurationMs:3000)
            var bytes = Data()
            for await chunk in stream { bytes.append(chunk.bytes); ctx.state.set("detail", "Audio received: \(bytes.count)") }
            detail = "\(await stream.result())\nbytes=\(bytes.count) SHA256=\(DeviceDigest.sha256Hex(bytes))"
        case "scan":
            let stream = ctx.device.bluetooth.scan(options: .init(timeoutMs:3000))
            var count = 0
            for await item in stream { count += 1; ctx.state.set("detail",String(describing:item)) }
            detail = "\(await stream.result()) events=\(count)"
        case "ping": detail = "UI remains responsive"
        case "cancel": detail = "Use host Cancel or Stop"
        default:
            let capability: String
            let params: String
            switch action {
            case "gallery": capability="gallery.pick";params=#"{"mediaTypes":["photo"],"maxCount":1}"#
            case "file": capability="file.pick";params=#"{"accept":["text/plain",".txt"],"maxCount":2}"#
            case "camera": capability="camera.capture";params=#"{"mode":"photo","facing":"back"}"#
            default: capability="bluetooth.select";params="{}"
            }
            switch await ctx.device.requestUntyped(capability,paramsJSON:params,options:.init(timeoutMs:45000)) {
            case .failure(let error): detail="\(error.code): \(error.platformDetail ?? "")"
            case .success(let value):
                detail=value.resultJSON
                for blob in value.blobs {
                    let hash=DeviceDigest.sha256Hex(blob.bytes)
                    let url=URL(fileURLWithPath:"../examples/device-lab/results-2026-09-26/uploads/\(hash).bin")
                    try? FileManager.default.createDirectory(at:url.deletingLastPathComponent(),withIntermediateDirectories:true)
                    try? blob.bytes.write(to:url)
                    detail += "\nverified \(blob.bytes.count) bytes SHA256=\(hash)"
                }
            }
        }
        ctx.state.set("result","\(action): completed")
        ctx.state.set("detail",detail)
        print("DEVICE_LAB \(action) \(detail)")
    }
}
let server = RemoteServer().module("App",builder.build()).ui(ui)
    .config(ServerConfig(port:45104,hostname:"127.0.0.1",allowedOrigins:["http://127.0.0.1:45100"],authenticate:{$0.uri.contains("token=device-lab")}))
server.listen(45104)
print("Device Lab Swift 45104")
dispatchMain()
