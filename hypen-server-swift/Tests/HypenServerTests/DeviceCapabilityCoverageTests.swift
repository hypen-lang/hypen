import Foundation
import XCTest
@testable import HypenServer
import HypenEngine

/// Round-3 capability coverage through the handler API and the Rust broker
/// (RFC 001 §3): the closed `Permission` enum (P1), `camera.capture@1` (C2),
/// `mic.record@1` `channels` (C3) and `bluetooth.select@1` (C4). The typed
/// Swift params are encoded as they are and judged by the broker — the only
/// validator — before anything is sent; results come back decoded from the
/// JSON the broker validated.
final class DeviceCapabilityCoverageTests: XCTestCase {
    typealias W = DeviceTestWire

    private func untypedOpen(_ h: PlaneHarness, _ capability: String, _ params: String,
                             mode: DeviceCapabilityMode = .unary) -> DevicePlaneOpenResult {
        h.plane.open(DevicePlaneOpenSpec(capability: capability, version: 1, paramsJSON: params,
                                         moduleInstanceId: "m1", activationId: 1, mode: mode))
    }

    // MARK: P1 typed permissions

    func testEveryPermissionIsSentTypedAndMisspellingsAreRefusedByTheBroker() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        for (i, permission) in Permission.allCases.enumerated() {
            let task = Task { await ctx.permissions.request(permission) }
            await h.recorder.wait("request \(i)") { h.recorder.requests("permission.request").count == i + 1 }
            let req = try XCTUnwrap(h.recorder.requests("permission.request").last)
            XCTAssertEqual(req["params"] as? [String: String], ["permission": permission.rawValue])
            let id = try XCTUnwrap((req["id"] as? NSNumber)?.uint32Value)
            h.plane.receiveText(W.response(id, result: ["status": "denied"]))
            let value = try await settle(task).unwrapped().get()
            XCTAssertEqual(value.status, .denied)
        }
        // Typos, aliases, other cases, whitespace, look-alikes, non-strings,
        // extra members: invalidParams, nothing sent.
        let before = h.recorder.requests().count
        let spellings = [
            #""camra""#, #""geolocation""#, #""photo""#, #""Camera""#, #""camera ""#, #""""#,
            #""ｃamera""#, #""caméra""#, "1", "null", "true", #"["camera"]"#, #"{"camera":null}"#,
        ]
        for capability in ["permission.query", "permission.request"] {
            for spelling in spellings {
                let r = await ctx.requestUntyped(capability, paramsJSON: #"{"permission":\#(spelling)}"#)
                guard case .failure(let e) = r else { XCTFail("\(capability) \(spelling) admitted"); continue }
                XCTAssertEqual(e.code, .invalidParams, "\(capability) \(spelling)")
            }
            guard case .failure(let e) = await ctx.requestUntyped(capability, paramsJSON: #"{"permission":"camera","why":"x"}"#)
            else { XCTFail("extra member admitted"); continue }
            XCTAssertEqual(e.code, .invalidParams)
        }
        XCTAssertEqual(h.recorder.requests().count, before, "refused locally, never sent")
    }

    // MARK: C3 mic.record channels

    func testMicRecordChannelsIsOptionalOneOrTwo() throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let mono = ctx.mic.record(sampleRate: 48_000)
        XCTAssertNotNil(mono.id)
        let monoParams = try XCTUnwrap(h.recorder.requests("mic.record").last?["params"] as? [String: Any])
        XCTAssertNil(monoParams["channels"], "absent stays absent on the wire")
        XCTAssertEqual(MicRecordParams(sampleRate: 1, format: .pcm16).channelCount, 1)
        mono.cancel()
        let stereo = ctx.mic.record(sampleRate: 8_000, channels: 2, maxDurationMs: 600_000)
        XCTAssertNotNil(stereo.id)
        let stereoParams = try XCTUnwrap(h.recorder.requests("mic.record").last?["params"] as? [String: Any])
        XCTAssertEqual(stereoParams["channels"] as? Int, 2)
        XCTAssertEqual(stereoParams["maxDurationMs"] as? Int, 600_000)
        stereo.cancel()
        // Out-of-range values are refused by the broker, typed or not.
        let sent = h.recorder.requests("mic.record").count
        XCTAssertNil(ctx.mic.record(sampleRate: 16_000, channels: 3).id)
        XCTAssertNil(ctx.mic.record(sampleRate: 7_999).id)
        XCTAssertNil(ctx.mic.record(sampleRate: 16_000, maxDurationMs: 600_001).id)
        for bad in ["0", "3", "-1", "null", #""2""#, "[2]", "1.0"] {
            guard case .refused(let e) = untypedOpen(h, "mic.record", #"{"sampleRate":48000,"format":"pcm16","channels":\#(bad)}"#,
                                                     mode: .stream) else {
                XCTFail("channels \(bad) admitted")
                continue
            }
            XCTAssertEqual(e.code, .invalidParams, bad)
        }
        XCTAssertEqual(h.recorder.requests("mic.record").count, sent)
    }

    // MARK: C2 camera.capture

    func testCameraCaptureParamsAndTheModeRuleOnItems() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let photoTask = Task { await ctx.camera.capture(.photo, facing: .front) }
        let photoId = await h.recorder.requestId("camera.capture")
        let photoParams = try XCTUnwrap(h.recorder.requests("camera.capture").last?["params"] as? [String: String])
        XCTAssertEqual(photoParams, ["mode": "photo", "facing": "front"])
        // A video item on a photo request violates the request (blob rule).
        h.plane.receiveText(W.event(photoId, ["kind": "blobStart", "channel": 0, "contentType": "video/mp4"]))
        guard case .failure(let e)? = await settle(photoTask) else { return XCTFail("mode mismatch admitted") }
        XCTAssertEqual(e.code, .invalidParams)
        XCTAssertEqual(h.recorder.controls(photoId, "cancel").count, 1)

        // Parameterised media types (`;codecs=`) and other case are not camera types.
        let videoTask = Task { await ctx.camera.capture(.video, maxDurationMs: 1) }
        let videoId = await h.recorder.nextRequestId("camera.capture", after: 1)
        h.plane.receiveText(W.event(videoId, ["kind": "blobStart", "channel": 0, "contentType": "video/webm;codecs=vp8"]))
        guard case .failure(let e2)? = await settle(videoTask) else { return XCTFail("parameterised type admitted") }
        XCTAssertEqual(e2.code, .invalidParams)

        // Exactly one item; photo results carry an image type.
        let okTask = Task { await ctx.camera.capture(.photo) }
        let okId = await h.recorder.nextRequestId("camera.capture", after: 2)
        let jpeg = W.bytes(300)
        h.plane.receiveText(W.event(okId, ["kind": "blobStart", "channel": 0, "contentType": "image/heic"]))
        h.plane.receiveFrame(W.frame(okId, 0, 0, jpeg))
        h.plane.receiveText(W.response(okId, result: ["items": [[
            "channel": 0, "contentType": "image/heic", "bytes": jpeg.count, "sha256": DeviceDigest.sha256Hex(jpeg)]]]))
        let item = try await settle(okTask).unwrapped().get()
        XCTAssertEqual(item.contentType, "image/heic")
        XCTAssertEqual(item.bytes, jpeg)

        // Timeouts and credit beyond the revision are clamped by the broker.
        let rev = try XCTUnwrap(h.plane.revision("camera.capture", version: 1))
        XCTAssertEqual(rev.maxItems, 1)
        XCTAssertEqual(rev.maxTimeoutMs, 600_000)
        let clamped = Task {
            await ctx.camera.capture(.photo, options: DeviceRequestOptions(
                timeoutMs: rev.maxTimeoutMs + 1, initialCredit: rev.maxInitialCredit + 1))
        }
        _ = await h.recorder.nextRequestId("camera.capture", after: 3)
        let sent = try XCTUnwrap(h.recorder.requests("camera.capture").last)
        XCTAssertEqual((sent["initialCredit"] as? NSNumber)?.uint64Value, rev.maxInitialCredit)
        XCTAssertEqual((sent["timeoutMs"] as? NSNumber)?.uint64Value, rev.maxTimeoutMs)
        clamped.cancel()
        guard case .failure(let e3)? = await settle(clamped) else { return XCTFail("cancel must settle") }
        XCTAssertEqual(e3.code, .cancelled)
    }

    // MARK: C4 bluetooth.select

    func testBluetoothSelectParamsAndIdentityOnlyResult() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let refusals: [(services: [String]?, namePrefix: String?)] = [
            (["0000180D-0000-1000-8000-00805F9B34FB"], nil), // uppercase
            (["0x180d"], nil),                                // 16-bit short form
            (["180d"], nil),
            ([], nil),                                        // empty list
            (Array(repeating: "0000180d-0000-1000-8000-00805f9b34fb", count: 2), nil), // not unique
            ((0..<17).map { String(format: "%08x-0000-1000-8000-00805f9b34fb", $0) }, nil),
            (nil, ""),
            (nil, String(repeating: "n", count: 65)),
        ]
        for r in refusals {
            guard case .failure(let e) = await ctx.bluetooth.select(services: r.services, namePrefix: r.namePrefix) else {
                XCTFail("admitted \(r)")
                continue
            }
            XCTAssertEqual(e.code, .invalidParams, "\(r)")
        }
        XCTAssertTrue(h.recorder.requests("bluetooth.select").isEmpty)
        // 64 code points (not bytes) is within bounds.
        let task = Task { await ctx.bluetooth.select(namePrefix: String(repeating: "é", count: 64)) }
        let id = await h.recorder.requestId("bluetooth.select")
        h.plane.receiveText(W.response(id, result: ["device": ["id": "d-9"]]))
        let device = try await settle(task).unwrapped().get()
        XCTAssertEqual(device.id, "d-9")
        XCTAssertNil(device.name)
        // Identity only: an rssi in the result is refused.
        let task2 = Task { await ctx.bluetooth.select() }
        let id2 = await h.recorder.nextRequestId("bluetooth.select", after: 1)
        XCTAssertNotEqual(id, id2)
        h.plane.receiveText(W.response(id2, result: ["device": ["id": "d-9", "rssi": -40]]))
        guard case .failure(let e)? = await settle(task2) else { return XCTFail("rssi admitted") }
        XCTAssertEqual(e.code, .invalidParams)
    }

    // MARK: Untyped API

    func testUntypedRequestsTakeJSONAndReturnTheValidatedResult() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let task = Task { await ctx.requestUntyped("permission.query", paramsJSON: #"{"permission":"photos"}"#) }
        let id = await h.recorder.requestId("permission.query")
        h.plane.receiveText(W.response(id, result: ["status": "granted"], simulated: true))
        let value = try await settle(task).unwrapped().get()
        XCTAssertTrue(value.simulated)
        XCTAssertEqual(try value.value.decode(PermissionResult.self).status, .granted)
        XCTAssertEqual(value.value.object["status"] as? String, "granted")
        XCTAssertTrue(value.blobs.isEmpty)

        let typed = Task { await ctx.requestUntyped("permission.query", params: PermissionParams(permission: .contacts)) }
        let id2 = await h.recorder.nextRequestId("permission.query", after: 1)
        XCTAssertNotEqual(id, id2)
        XCTAssertEqual(h.recorder.requests("permission.query").last?["params"] as? [String: String], ["permission": "contacts"])
        h.plane.receiveText(W.response(id2, result: ["status": "prompt"]))
        let typedValue = try await settle(typed).unwrapped().get()
        XCTAssertEqual(try typedValue.value.decode(PermissionResult.self).status, .prompt)

        let sent = h.recorder.requests().count
        for bad in ["[]", "garbage", "", "1", #""x""#] {
            guard case .failure(let e) = await ctx.requestUntyped("permission.query", paramsJSON: bad) else {
                XCTFail("params \(bad) admitted")
                continue
            }
            XCTAssertEqual(e.code, .invalidParams, bad)
        }
        guard case .failure(let e) = await ctx.requestUntyped("no.such.capability") else { return XCTFail() }
        XCTAssertEqual(e.code, .unsupported)
        XCTAssertEqual(h.recorder.requests().count, sent)
    }

    // MARK: file.save announcement

    func testFileSaveAnnouncementIsJudgedByTheBroker() async throws {
        // A host item cap below the download: refused before anything is sent.
        let h = try PlaneHarness(extraConfig: #","maxItemBytes":1000"#)
        let ctx = h.context()
        XCTAssertEqual(h.plane.revision("file.save", version: 1)?.maxItemBytes, 1000)
        guard case .failure(let e) = await ctx.files.save(W.bytes(2000), name: "big.bin", contentType: "application/octet-stream")
        else { return XCTFail("oversize download admitted") }
        XCTAssertEqual(e.code, .invalidParams)
        for (name, type) in [("a", String(repeating: "t", count: 257)), (String(repeating: "n", count: 513), "text/plain")] {
            guard case .failure(let e2) = await ctx.files.save(W.bytes(3), name: name, contentType: type) else {
                XCTFail("announcement over its bounds admitted")
                continue
            }
            XCTAssertEqual(e2.code, .invalidParams)
        }
        XCTAssertTrue(h.recorder.requests("file.save").isEmpty)
        // Within bounds it is announced exactly as the engine builds it.
        let bytes = W.bytes(1000)
        let task = Task { await ctx.files.save(bytes, name: "ok.bin", contentType: "application/octet-stream") }
        let id = await h.recorder.requestId("file.save")
        let params = try XCTUnwrap(h.recorder.requests("file.save").last?["params"] as? [String: Any])
        let expected = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(
            deviceFileSaveParamsJson(name: "ok.bin", contentType: "application/octet-stream", bytes: bytes).utf8)) as? NSDictionary)
        XCTAssertEqual(params as NSDictionary, expected)
        task.cancel()
        _ = await settle(task)
        XCTAssertEqual(h.recorder.controls(id, "cancel").count, 1)
    }
}

/// Background lifetime at the handler layer: owned by the module instance,
/// survives deactivation, swept on destroy, and bounded by the broker's pin
/// cap (RFC 001 §2.7) — configured through `configureDevice(DeviceServerOptions(...))`.
final class DeviceBackgroundPinTests: XCTestCase {
    typealias W = DeviceTestWire

    private static let backgroundScan =
        #","revisionOverrides":[{"capability":"bluetooth.scan","version":1,"lifetimes":["activation","background"]}]"#

    private func module(_ plane: DevicePlane) throws -> ModuleInstance {
        let instance = try ModuleInstance(definition: AppBuilder([:]).build())
        instance.attachDevice(plane)
        instance.activate()
        return instance
    }

    func testTheThirdModuleToPinBackgroundWorkIsRefusedThrottled() async throws {
        let h = try PlaneHarness(extraConfig: Self.backgroundScan, activate: false)
        XCTAssertEqual(DeviceProtocol.maxBackgroundPinnedModules, 2)
        let a = try module(h.plane)
        let b = try module(h.plane)
        let c = try module(h.plane)
        let bg = DeviceRequestOptions(lifetime: .background)

        let scanA = a.deviceContext().bluetooth.scan(options: bg)
        let scanB = b.deviceContext().bluetooth.scan(options: bg)
        XCTAssertNotNil(scanA.id)
        XCTAssertNotNil(scanB.id)
        XCTAssertTrue(a.hasLiveBackgroundDeviceWork)
        XCTAssertTrue(b.hasLiveBackgroundDeviceWork)
        // A pinned module may add more background work.
        let scanA2 = a.deviceContext().bluetooth.scan(options: bg)
        XCTAssertNotNil(scanA2.id)

        // A third module is over the cap: refused locally, nothing sent.
        let sent = h.recorder.requests("bluetooth.scan").count
        XCTAssertFalse(h.plane.admitsBackground(c.deviceInstanceId))
        let scanC = c.deviceContext().bluetooth.scan(options: bg)
        XCTAssertNil(scanC.id)
        guard case .failure(let e)? = await settle({ await scanC.result() }) else { return XCTFail("pin cap not enforced") }
        XCTAssertEqual(e.code, .throttled)
        XCTAssertEqual(h.recorder.requests("bluetooth.scan").count, sent)
        XCTAssertFalse(c.hasLiveBackgroundDeviceWork)
        // Activation-lifetime work of the same module is not capped.
        XCTAssertNotNil(c.deviceContext().bluetooth.scan().id)

        // Deactivation keeps the pins; destroying a pinned module frees a slot.
        a.deactivate()
        XCTAssertTrue(h.plane.isLive(scanA.id!))
        XCTAssertTrue(a.hasLiveBackgroundDeviceWork)
        a.destroy()
        guard case .failure(let swept)? = await settle({ await scanA.result() }) else { return XCTFail() }
        XCTAssertEqual(swept.code, .cancelled)
        XCTAssertFalse(a.hasLiveBackgroundDeviceWork)
        XCTAssertTrue(h.plane.admitsBackground(c.deviceInstanceId))
        let retry = c.deviceContext().bluetooth.scan(options: bg)
        XCTAssertNotNil(retry.id)
        XCTAssertTrue(c.hasLiveBackgroundDeviceWork)
    }

    func testDeviceServerOptionsConfigureOverridesAndThePinCap() async throws {
        let server = RemoteServer()
            .module("App", AppBuilder([:]).build())
            .ui("Text(\"pins\")")
            .configureDevice(DeviceServerOptions(
                clock: ManualDeviceClock(),
                revisionOverrides: [DeviceRevisionOverride(
                    capability: "bluetooth.scan", version: 1, lifetimes: [.activation, .background])],
                maxBackgroundOwners: 1))
        try server.prepare()
        defer { server.stop() }
        let t = DeviceSessionTests.DeviceTestTransport()
        let session = try server.createSession(transport: t)
        session.receive(#"{"type":"hello","device":\#(W.fullHello)}"#)
        let plane = try XCTUnwrap(session.device)
        XCTAssertEqual(plane.revision("bluetooth.scan", version: 1)?.lifetimes, [.activation, .background])
        XCTAssertEqual(plane.revision("gallery.pick", version: 1)?.lifetimes, [.activation], "only the override changes")

        let a = try module(plane)
        let b = try module(plane)
        let bg = DeviceRequestOptions(lifetime: .background)
        XCTAssertNotNil(a.deviceContext().bluetooth.scan(options: bg).id)
        let refused = b.deviceContext().bluetooth.scan(options: bg)
        XCTAssertNil(refused.id, "maxBackgroundOwners: 1")
        guard case .failure(let e)? = await settle({ await refused.result() }) else { return XCTFail() }
        XCTAssertEqual(e.code, .throttled)
        let backgroundRequests = t.requests("bluetooth.scan").filter { ($0["lifetime"] as? String) == "background" }
        XCTAssertEqual(backgroundRequests.count, 1)
        XCTAssertEqual((backgroundRequests.first?["owner"] as? [String: Any])?["activationId"] == nil, true,
                       "background work is owned by the module instance, not an activation")
        session.destroy()
    }

    func testOptionsTheBrokerRefusesFailPrepare() throws {
        for overrides in [
            [DeviceRevisionOverride(capability: "bluetooth.scan", version: 9, lifetimes: [.background])],
            [DeviceRevisionOverride(capability: "no.such.capability", version: 1)],
        ] {
            let server = RemoteServer()
                .module("App", AppBuilder([:]).build())
                .ui("Text(\"pins\")")
                .configureDevice(DeviceServerOptions(clock: ManualDeviceClock(), revisionOverrides: overrides))
            XCTAssertThrowsError(try server.prepare(), "\(overrides)") { error in
                guard case RemoteServerError.invalidDeviceOptions = error else {
                    return XCTFail("unexpected error \(error)")
                }
            }
            XCTAssertThrowsError(try server.createSession(transport: DeviceSessionTests.DeviceTestTransport()))
        }
    }
}
