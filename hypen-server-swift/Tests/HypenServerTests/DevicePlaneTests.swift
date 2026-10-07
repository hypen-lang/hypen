import Foundation
import XCTest
@testable import HypenServer
import HypenEngine

/// The Swift device plane (`DevicePlane` driving the Rust `DeviceBroker`
/// through UniFFI) and the handler API (`DeviceContext`): typed requests,
/// streams as `AsyncSequence`, downloads, Task cancellation, the replay
/// firewall, activation authority, leases/deadlines on a manual clock, and
/// violation reactions. The test plays the client with raw protocol text and
/// frames.
final class DevicePlaneTests: XCTestCase {
    typealias W = DeviceTestWire

    // MARK: - Handshake / queries

    func testCoreCapabilitiesOpensFirstAndSupportsFollowsTheSelection() throws {
        let h = try PlaneHarness()
        let first = try XCTUnwrap(h.recorder.requests().first)
        XCTAssertEqual(first["capability"] as? String, "core.capabilities")
        XCTAssertEqual(first["lifetime"] as? String, "connection")
        XCTAssertEqual((first["id"] as? NSNumber)?.uint32Value, h.plane.coreStreamId)
        XCTAssertTrue(h.plane.supports("gallery.pick"))
        XCTAssertEqual(h.plane.selectedVersion("mic.record"), 1)
        XCTAssertFalse(h.plane.supports("nope.nothing"))
        let ctx = h.context()
        XCTAssertTrue(ctx.supports(PermissionQuery.self))
        let rev = try XCTUnwrap(h.plane.revision("gallery.pick", version: 1))
        XCTAssertEqual(rev.mode, .unary)
        XCTAssertEqual(rev.data, .binaryUpload)
        XCTAssertEqual(rev.lifetimes.first, .activation)
        // A snapshot on the core stream replaces the live selection.
        let core = try XCTUnwrap(h.plane.coreStreamId)
        h.plane.receiveText(W.event(core, ["capabilities": [["name": "core.capabilities", "versions": [1]],
                                                            ["name": "permission.query", "versions": [1]]]]))
        XCTAssertFalse(h.plane.supports("gallery.pick"))
        XCTAssertTrue(h.plane.supports("permission.query"))
    }

    // MARK: - Unary

    func testPermissionQueryIsTypedAndCarriesTheSimulatedMarker() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let task = Task { await ctx.permissions.query(.camera) }
        let id = await h.recorder.requestId("permission.query")
        let req = try XCTUnwrap(h.recorder.requests("permission.query").last)
        XCTAssertEqual(req["params"] as? [String: String], ["permission": "camera"])
        XCTAssertEqual((req["owner"] as? [String: Any])?["moduleInstanceId"] as? String, "m1")
        h.plane.receiveText(W.response(id, result: ["status": "granted"], simulated: true))
        let value = try await settle(task).unwrapped().get()
        XCTAssertEqual(value.status, .granted)
        XCTAssertTrue(value.simulated)
    }

    func testDenialIsAnErrorValueNotAThrow() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let task = Task { await ctx.permissions.request(.location) }
        let id = await h.recorder.requestId("permission.request")
        h.plane.receiveText(W.error(id, "denied", "user-declined"))
        guard case .failure(let e)? = await settle(task) else { return XCTFail("expected denial") }
        XCTAssertEqual(e.code, .denied)
        XCTAssertEqual(e.platformDetail, "user-declined")
    }

    func testGalleryPickUploadIsVerifiedAndDeliveredAsBytes() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let photo = W.bytes(100_000)
        let task = Task { await ctx.gallery.pick([.photo], maxCount: 1) }
        let id = await h.recorder.requestId("gallery.pick")
        h.plane.receiveText(W.event(id, ["kind": "blobStart", "channel": 0, "contentType": "image/jpeg",
                                         "bytes": photo.count]))
        XCTAssertTrue(h.plane.receiveFrame(W.frame(id, 0, 0, photo.prefix(65_536))))
        XCTAssertTrue(h.plane.receiveFrame(W.frame(id, 0, 1, photo.suffix(from: 65_536))))
        h.plane.receiveText(W.response(id, result: ["items": [[
            "channel": 0, "contentType": "image/jpeg", "bytes": photo.count,
            "sha256": DeviceDigest.sha256Hex(photo)]]]))
        let value = try await settle(task).unwrapped().get()
        XCTAssertEqual(value.items.count, 1)
        XCTAssertEqual(value.items[0].bytes, photo)
        XCTAssertEqual(value.items[0].contentType, "image/jpeg")
        // Released at delivery (no open handler scope): nothing retained.
        XCTAssertEqual(h.plane.retainedBytes, 0)
    }

    func testUploadHashMismatchFailsInvalidParams() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let photo = W.bytes(1000)
        let task = Task { await ctx.gallery.pick() }
        let id = await h.recorder.requestId("gallery.pick")
        h.plane.receiveText(W.event(id, ["kind": "blobStart", "channel": 0, "contentType": "image/jpeg"]))
        h.plane.receiveFrame(W.frame(id, 0, 0, photo))
        h.plane.receiveText(W.response(id, result: ["items": [[
            "channel": 0, "contentType": "image/jpeg", "bytes": photo.count,
            "sha256": String(repeating: "a", count: 64)]]]))
        guard case .failure(let e)? = await settle(task) else { return XCTFail("expected failure") }
        XCTAssertEqual(e.code, .invalidParams)
    }

    func testCameraCaptureUndeclaredSizeAndTypedParams() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let clip = W.bytes(70_000, seed: 3)
        let task = Task { await ctx.camera.capture(.video, facing: .back, maxDurationMs: 3000) }
        let id = await h.recorder.requestId("camera.capture")
        let params = try XCTUnwrap(h.recorder.requests("camera.capture").last?["params"] as? [String: Any])
        XCTAssertEqual(params["mode"] as? String, "video")
        XCTAssertEqual(params["facing"] as? String, "back")
        XCTAssertEqual(params["maxDurationMs"] as? Int, 3000)
        h.plane.receiveText(W.event(id, ["kind": "blobStart", "channel": 0, "contentType": "video/webm"]))
        h.plane.receiveFrame(W.frame(id, 0, 0, clip.prefix(65_536)))
        h.plane.receiveFrame(W.frame(id, 0, 1, clip.suffix(from: 65_536)))
        h.plane.receiveText(W.response(id, result: ["items": [[
            "channel": 0, "contentType": "video/webm", "bytes": clip.count,
            "sha256": DeviceDigest.sha256Hex(clip)]]]))
        let item = try await settle(task).unwrapped().get()
        XCTAssertEqual(item.bytes, clip)
        XCTAssertEqual(item.contentType, "video/webm")

        // Params the revision rejects fail locally, before anything is sent.
        let before = h.recorder.requests("camera.capture").count
        let bad = await ctx.camera.capture(.photo, maxDurationMs: 10)
        guard case .failure(let e) = bad else { return XCTFail("photo with maxDurationMs must fail") }
        XCTAssertEqual(e.code, .invalidParams)
        XCTAssertEqual(h.recorder.requests("camera.capture").count, before)
    }

    func testBluetoothSelectResult() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let uuid = "0000180d-0000-1000-8000-00805f9b34fb"
        let task = Task { await ctx.bluetooth.select(services: [uuid], namePrefix: "HR") }
        let id = await h.recorder.requestId("bluetooth.select")
        h.plane.receiveText(W.response(id, result: ["device": ["id": "d-1", "name": "HR Strap"]]))
        let device = try await settle(task).unwrapped().get()
        XCTAssertEqual(device.id, "d-1")
        XCTAssertEqual(device.name, "HR Strap")
    }

    // MARK: - Downloads

    func testFileSaveSendsFramesOnlyWithinGrantedCredit() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let payload = W.bytes(150_000, seed: 9)
        let task = Task { await ctx.files.save(payload, name: "a.bin", contentType: "application/octet-stream") }
        let id = await h.recorder.requestId("file.save")
        let req = try XCTUnwrap(h.recorder.requests("file.save").last)
        XCTAssertEqual(req["initialCredit"] as? Int, 0)
        let params = try XCTUnwrap(req["params"] as? [String: Any])
        XCTAssertEqual(params["sha256"] as? String, DeviceDigest.sha256Hex(payload))
        XCTAssertEqual(params["bytes"] as? Int, payload.count)
        h.clock.runDue()
        XCTAssertTrue(h.recorder.sentFrames.isEmpty, "no bytes before the client grants credit")

        h.plane.receiveText(W.control(id, ["grant": 100_000]))
        for _ in 0..<8 { h.clock.runDue() }
        var received = Data(h.recorder.sentFrames.map { $0.dropFirst(12) }.joined())
        XCTAssertLessThanOrEqual(received.count, 100_000)
        XCTAssertTrue(h.recorder.sentFrames.allSatisfy { $0.count <= 12 + 65_536 })
        h.plane.receiveText(W.control(id, ["grant": 100_000]))
        for _ in 0..<8 { h.clock.runDue() }
        received = Data(h.recorder.sentFrames.map { $0.dropFirst(12) }.joined())
        XCTAssertEqual(received, payload)

        h.plane.receiveText(W.response(id, result: ["bytesWritten": payload.count]))
        let written = try await settle(task).unwrapped().get()
        XCTAssertEqual(written.bytesWritten, UInt64(payload.count))
    }

    func testFileSaveWrongByteCountIsInvalidParams() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let payload = W.bytes(10)
        let task = Task { await ctx.files.save(payload, name: "a.txt", contentType: "text/plain") }
        let id = await h.recorder.requestId("file.save")
        h.plane.receiveText(W.control(id, ["grant": 1024]))
        for _ in 0..<4 { h.clock.runDue() }
        h.plane.receiveText(W.response(id, result: ["bytesWritten": 3]))
        guard case .failure(let e)? = await settle(task) else { return XCTFail("expected failure") }
        XCTAssertEqual(e.code, .invalidParams)
    }

    func testFileSaveRefusalsBeforeAnythingIsSent() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let empty = await ctx.files.save(Data(), name: "a", contentType: "text/plain")
        guard case .failure(let e1) = empty else { return XCTFail() }
        XCTAssertEqual(e1.code, .invalidParams)
        let longName = await ctx.files.save(W.bytes(4), name: String(repeating: "n", count: 600), contentType: "text/plain")
        guard case .failure(let e2) = longName else { return XCTFail() }
        XCTAssertEqual(e2.code, .invalidParams)
        XCTAssertTrue(h.recorder.requests("file.save").isEmpty)

        // A connection without a binary route carries no downloads.
        let text = try PlaneHarness(binary: false)
        let r = await text.context().files.save(W.bytes(4), name: "a", contentType: "text/plain")
        guard case .failure(let e3) = r else { return XCTFail() }
        XCTAssertEqual(e3.code, .unsupported)
    }

    // MARK: - Streams

    func testBluetoothScanEventsViaForAwaitWithCreditAndBreakCancels() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let scan = ctx.bluetooth.scan(options: DeviceRequestOptions(initialCredit: 4))
        let id = try XCTUnwrap(scan.id)
        XCTAssertEqual(h.recorder.requests("bluetooth.scan").last?["initialCredit"] as? Int, 4)
        for i in 0..<3 {
            h.plane.receiveText(W.event(id, ["device": ["id": "dev-\(i)", "rssi": -40]]))
        }
        // Progress is not a consumer-facing event.
        h.plane.receiveText(W.event(id, ["kind": "progress", "state": "running"]))
        XCTAssertEqual(h.plane.outstandingEventCredit(id), 1)
        // Bounded: a lost event fails the test instead of hanging the loop.
        let seen = await settle(Task { () -> [String] in
            var seen: [String] = []
            for await device in scan {
                seen.append(device.id)
                if seen.count == 2 { break }
            }
            return seen
        })
        XCTAssertEqual(seen, ["dev-0", "dev-1"])
        guard case .failure(let e)? = await settle({ await scan.result() }) else { return XCTFail("expected cancelled") }
        XCTAssertEqual(e.code, .cancelled)
        XCTAssertEqual(h.recorder.controls(id, "cancel").count, 1)
    }

    func testScanEndsWithTheClientsResult() async throws {
        let h = try PlaneHarness()
        let scan = h.context().stream(BluetoothScan())
        let id = try XCTUnwrap(scan.id)
        h.plane.receiveText(W.event(id, ["device": ["id": "a", "name": "A", "rssi": -1]]))
        h.plane.receiveText(W.response(id, result: [:]))
        let names = await settle(Task { () -> [String?] in
            var names: [String?] = []
            for await d in scan { names.append(d.name) }
            return names
        })
        XCTAssertEqual(names, ["A"])
        let end = await settle { await scan.result() }
        XCTAssertNoThrow(try end.unwrapped().get())
    }

    func testMicRecordStreamsBytesInOrderAndVerifiesTheResult() async throws {
        let h = try PlaneHarness()
        let rec = h.context().mic.record(sampleRate: 16_000, channels: 2)
        let id = try XCTUnwrap(rec.id)
        let params = try XCTUnwrap(h.recorder.requests("mic.record").last?["params"] as? [String: Any])
        XCTAssertEqual(params["channels"] as? Int, 2)
        XCTAssertEqual(params["format"] as? String, "pcm16")
        let chunks = (0..<4).map { W.bytes(4000, seed: UInt8($0)) }
        let all = Data(chunks.joined())
        let reader = Task { () -> Data in
            var got = Data()
            for await chunk in rec { got.append(chunk.bytes) }
            return got
        }
        h.plane.receiveText(W.event(id, ["kind": "blobStart", "channel": 0, "contentType": "audio/L16"]))
        for (i, c) in chunks.enumerated() { XCTAssertTrue(h.plane.receiveFrame(W.frame(id, 0, UInt32(i), c))) }
        h.plane.receiveText(W.response(id, result: ["durationMs": 250, "item": [
            "channel": 0, "contentType": "audio/L16", "bytes": all.count, "sha256": DeviceDigest.sha256Hex(all)]]))
        let got = await settle(reader)
        XCTAssertEqual(got, all)
        let result = try await settle { await rec.result() }.unwrapped().get()
        XCTAssertEqual(result.durationMs, 250)
        XCTAssertEqual(result.item.sha256, DeviceDigest.sha256Hex(all))
    }

    func testStreamOnAUnaryCapabilityAndZeroCreditAreRefusedLocally() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        // The broker refuses a unary open of a stream revision.
        let r = await ctx.requestUntyped("bluetooth.scan")
        guard case .failure(let e) = r else { return XCTFail() }
        XCTAssertEqual(e.code, .invalidParams)
        // Zero credit on a client → server plane could never progress.
        let zero = ctx.stream(BluetoothScan(), options: DeviceRequestOptions(initialCredit: 0))
        XCTAssertNil(zero.id)
        guard case .failure(let e2)? = await settle({ await zero.result() }) else { return XCTFail() }
        XCTAssertEqual(e2.code, .invalidParams)
        XCTAssertTrue(h.recorder.requests("bluetooth.scan").isEmpty)
    }

    // MARK: - Cancellation, leases, deadlines

    func testTaskCancellationCancelsTheRequestOnTheWire() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let task = Task { await ctx.gallery.pick() }
        let id = await h.recorder.requestId("gallery.pick")
        task.cancel()
        guard case .failure(let e)? = await settle(task) else { return XCTFail("expected cancelled") }
        XCTAssertEqual(e.code, .cancelled)
        XCTAssertEqual(h.recorder.controls(id, "cancel").count, 1)
        XCTAssertFalse(h.plane.isLive(id))

        // An already-cancelled task sends nothing at all.
        let before = h.recorder.requests().count
        let pre = Task { () -> DeviceResult<PermissionResult> in
            withUnsafeCurrentTask { $0?.cancel() }
            return await ctx.permissions.query(.camera)
        }
        guard case .failure(let e2)? = await settle(pre) else { return XCTFail() }
        XCTAssertEqual(e2.code, .cancelled)
        XCTAssertEqual(h.recorder.requests().count, before)
    }

    func testLeasesRenewEveryFiveSecondsAndExpireWithoutAcks() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let task = Task { await ctx.gallery.pick(options: DeviceRequestOptions(timeoutMs: 600_000)) }
        let id = await h.recorder.requestId("gallery.pick")
        XCTAssertEqual(h.recorder.controls(id, "renewLease") as? [Int], [1])
        h.plane.receiveText(W.control(id, ["leaseAck": 1]))
        h.clock.advance(by: 5_000)
        XCTAssertEqual(h.recorder.controls(id, "renewLease") as? [Int], [1, 2])
        // No more acks: the lease lapses and the request ends.
        h.clock.advance(by: 20_000)
        guard case .failure(let e)? = await settle(task) else { return XCTFail("lease expiry must end it") }
        XCTAssertNotEqual(e.code, .cancelled)
        XCTAssertFalse(h.plane.isLive(id))
    }

    func testDeadlineEndsTheRequestWithTimeout() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let task = Task { await ctx.permissions.request(.camera, options: DeviceRequestOptions(timeoutMs: 2_000)) }
        let id = await h.recorder.requestId("permission.request")
        XCTAssertEqual(h.recorder.requests("permission.request").last?["timeoutMs"] as? Int, 2_000)
        h.plane.receiveText(W.control(id, ["leaseAck": 1]))
        h.clock.advance(by: 2_001)
        guard case .failure(let e)? = await settle(task) else { return XCTFail() }
        XCTAssertEqual(e.code, .timeout)
    }

    // MARK: - Authority

    func testReplayProvenanceRefusesWithoutSendingAnything() async throws {
        let h = try PlaneHarness()
        let ctx = h.context(provenance: .replay)
        let before = h.recorder.requests().count
        guard case .failure(let e) = await ctx.permissions.query(.camera) else { return XCTFail() }
        XCTAssertEqual(e.code, .unavailable)
        XCTAssertEqual(e.platformDetail, "replay")
        let scan = ctx.bluetooth.scan()
        XCTAssertNil(scan.id)
        guard case .failure(let e2) = await ctx.files.save(W.bytes(3), name: "a", contentType: "b/c") else { return XCTFail() }
        XCTAssertEqual(e2.code, .unavailable)
        XCTAssertEqual(h.recorder.requests().count, before)
    }

    func testInactiveOwnerAndDisabledPlaneAreUnavailable() async throws {
        let h = try PlaneHarness()
        let stale = h.context(live: { false })
        guard case .failure(let e) = await stale.permissions.query(.camera) else { return XCTFail() }
        XCTAssertEqual(e.code, .unavailable)
        XCTAssertEqual(e.platformDetail, "owner-inactive")
        guard case .failure(let e2) = await DeviceContext.unavailable().gallery.pick() else { return XCTFail() }
        XCTAssertEqual(e2.platformDetail, "device-disabled")
        h.plane.close()
        guard case .failure(let e3) = await h.context().permissions.query(.camera) else { return XCTFail() }
        XCTAssertEqual(e3.code, .connectionLost)
    }

    func testDeactivationSweepsActivationWorkButNotBackgroundWork() async throws {
        let h = try PlaneHarness(extraConfig:
            #","revisionOverrides":[{"capability":"bluetooth.scan","version":1,"lifetimes":["activation","background"]}]"#)
        let ctx = h.context()
        let pick = Task { await ctx.gallery.pick() }
        let pickId = await h.recorder.requestId("gallery.pick")
        let scan = ctx.bluetooth.scan(options: DeviceRequestOptions(lifetime: .background))
        let scanId = try XCTUnwrap(scan.id)
        XCTAssertEqual(h.recorder.requests("bluetooth.scan").last?["lifetime"] as? String, "background")
        XCTAssertTrue(h.plane.hasBackgroundWork("m1"))

        h.plane.ownerDeactivated("m1", activationId: 1)
        guard case .failure(let e)? = await settle(pick) else { return XCTFail() }
        XCTAssertEqual(e.code, .cancelled)
        XCTAssertEqual(h.recorder.controls(pickId, "cancel").count, 1)
        XCTAssertTrue(h.plane.isLive(scanId), "background work survives deactivation")

        h.plane.ownerDestroyed("m1")
        guard case .failure(let e2)? = await settle({ await scan.result() }) else { return XCTFail() }
        XCTAssertEqual(e2.code, .cancelled)
        XCTAssertFalse(h.plane.hasBackgroundWork("m1"))
    }

    func testHandlerScopeCancelsUnaryWorkLeftPendingWhenTheHandlerReturns() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        ctx.beginHandlerScope()
        let orphan = Task { await ctx.gallery.pick() }
        let id = await h.recorder.requestId("gallery.pick")
        ctx.endHandlerScope()
        guard case .failure(let e)? = await settle(orphan) else { return XCTFail() }
        XCTAssertEqual(e.code, .cancelled)
        XCTAssertEqual(h.recorder.controls(id, "cancel").count, 1)
        // After the scope, requests are unscoped.
        let later = Task { await ctx.permissions.query(.camera) }
        let id2 = await h.recorder.requestId("permission.query")
        h.plane.receiveText(W.response(id2, result: ["status": "prompt"]))
        let laterValue = try await settle(later).unwrapped().get()
        XCTAssertEqual(laterValue.status, .prompt)
    }

    func testResultsReceivedInsideAScopeStayChargedUntilItEnds() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        ctx.beginHandlerScope()
        let photo = W.bytes(5000)
        let task = Task { await ctx.gallery.pick() }
        let id = await h.recorder.requestId("gallery.pick")
        h.plane.receiveText(W.event(id, ["kind": "blobStart", "channel": 0, "contentType": "image/png", "bytes": 5000]))
        h.plane.receiveFrame(W.frame(id, 0, 0, photo))
        h.plane.receiveText(W.response(id, result: ["items": [[
            "channel": 0, "contentType": "image/png", "bytes": 5000, "sha256": DeviceDigest.sha256Hex(photo)]]]))
        _ = try await settle(task).unwrapped().get()
        XCTAssertGreaterThan(h.plane.retainedBytes, 0)
        ctx.endHandlerScope()
        XCTAssertEqual(h.plane.retainedBytes, 0)
    }

    // MARK: - Violations / close

    func testRepeatedConnectionViolationsCloseTheDevicePlane() throws {
        let h = try PlaneHarness(extraConfig: #","violationRate":{"burst":3,"perSecond":0}"#)
        for _ in 0..<10 {
            h.plane.receiveFrame(W.frame(77, 0, 0, Data([1]), version: 9))
        }
        XCTAssertEqual(h.recorder.closed.first?.code, 1012)
        XCTAssertTrue(h.plane.isClosed)
    }

    func testUnknownIdsAreIgnoredAndKnownIdGarbageTerminatesThatRequest() async throws {
        let h = try PlaneHarness()
        XCTAssertFalse(h.plane.receiveText(W.response(9999, result: ["status": "granted"])))
        XCTAssertEqual(h.plane.connectionViolations, 0)
        let ctx = h.context()
        // An invalid terminal from the client ends the request invalidParams
        // (no cancel: the client already ended it).
        let task = Task { await ctx.permissions.query(.camera) }
        let id = await h.recorder.requestId("permission.query")
        h.plane.receiveText(W.response(id, result: ["status": "maybe"]))
        guard case .failure(let e)? = await settle(task) else { return XCTFail() }
        XCTAssertEqual(e.code, .invalidParams)
        XCTAssertEqual(h.recorder.controls(id, "cancel").count, 0)
        // An invalid non-terminal message on a live id: invalidParams + cancel.
        let pick = Task { await ctx.gallery.pick() }
        let pickId = await h.recorder.requestId("gallery.pick")
        h.plane.receiveText(W.event(pickId, ["kind": "sparkles"]))
        guard case .failure(let e2)? = await settle(pick) else { return XCTFail() }
        XCTAssertEqual(e2.code, .invalidParams)
        XCTAssertEqual(h.recorder.controls(pickId, "cancel").count, 1)
        XCTAssertEqual(h.plane.connectionViolations, 0, "attributable to the request, not the connection")
    }

    func testCloseSettlesEverythingConnectionLostAndSendsNothing() async throws {
        let h = try PlaneHarness()
        let ctx = h.context()
        let task = Task { await ctx.gallery.pick() }
        let id = await h.recorder.requestId("gallery.pick")
        let sent = h.recorder.messages.count
        h.plane.close(.connectionLost)
        guard case .failure(let e)? = await settle(task) else { return XCTFail() }
        XCTAssertEqual(e.code, .connectionLost)
        XCTAssertEqual(h.recorder.messages.count, sent)
        XCTAssertFalse(h.plane.isLive(id))
        XCTAssertEqual(h.clock.pendingTimers, 0)
    }

    func testUnsupportedCapabilityOnANarrowSelection() async throws {
        let hello = #"{"protocolVersions":[1],"binary":true,"capabilities":[{"name":"core.capabilities","versions":[1]}]}"#
        let ack = try XCTUnwrap(deviceNegotiate(helloJson: hello, binaryRoute: true))
        let recorder = DeviceSinkRecorder()
        let plane = try DevicePlane(configJSON: "{\"ack\":\(ack)}", pool: nil, sink: recorder.sink,
                                    clock: ManualDeviceClock(), binary: true)
        XCTAssertTrue(plane.start())
        plane.ownerActivated("m1", activationId: 1)
        let ctx = DeviceContext(plane: plane, owner: DeviceOwnerAuthority(moduleInstanceId: "m1", activationId: 1),
                                provenance: .origin)
        guard case .failure(let e) = await ctx.gallery.pick() else { return XCTFail() }
        XCTAssertEqual(e.code, .unsupported)
        XCTAssertThrowsError(try DevicePlane(configJSON: "{}", pool: nil, sink: recorder.sink,
                                             clock: ManualDeviceClock(), binary: true))
    }
}

/// Activation authority tied to the module lifecycle (RFC 001 §2.7).
final class DeviceModuleOwnershipTests: XCTestCase {
    typealias W = DeviceTestWire

    func testActivationAuthorityFollowsTheModuleLifecycle() async throws {
        let h = try PlaneHarness(activate: false)
        let instance = try ModuleInstance(definition: AppBuilder([:]).build())
        instance.attachDevice(h.plane)

        // Not active yet: unavailable without waiting. Every await here is
        // bounded (`settle`), so a regression fails instead of hanging.
        let early = instance.deviceContext()
        guard case .failure(let e0)? = await settle({ await early.permissions.query(.camera) }) else { return XCTFail() }
        XCTAssertEqual(e0.platformDetail, "owner-inactive")
        XCTAssertTrue(h.recorder.requests("permission.query").isEmpty, "refused locally: nothing sent")

        instance.activate()
        XCTAssertTrue(h.plane.ownerIsActive(instance.deviceInstanceId, activationId: 1))
        let ctx = instance.deviceContext()
        XCTAssertEqual(ctx.owner?.activationId, 1)
        let pending = Task { await ctx.gallery.pick() }
        let id = await h.recorder.requestId("gallery.pick")

        instance.deactivate()
        guard case .failure(let e1)? = await settle(pending) else { return XCTFail() }
        XCTAssertEqual(e1.code, .cancelled)
        XCTAssertEqual(h.recorder.controls(id, "cancel").count, 1)
        // A context captured by the ended activation cannot start new work,
        // even after the module is active again.
        instance.activate()
        guard case .failure(let e2)? = await settle({ await ctx.permissions.query(.camera) }) else { return XCTFail() }
        XCTAssertEqual(e2.platformDetail, "owner-inactive")
        XCTAssertTrue(h.recorder.requests("permission.query").isEmpty, "refused locally: nothing sent")
        XCTAssertEqual(instance.deviceContext().owner?.activationId, 2)

        // Work of the new activation is swept by destroy.
        let ctx2 = instance.deviceContext()
        let second = Task { await ctx2.gallery.pick() }
        let id2 = await h.recorder.nextRequestId("gallery.pick", after: 1)
        XCTAssertNotEqual(id2, id)
        instance.destroy()
        guard case .failure(let e3)? = await settle(second) else { return XCTFail() }
        XCTAssertEqual(e3.code, .cancelled)
        XCTAssertEqual(h.recorder.controls(id2, "cancel").count, 1)
        XCTAssertFalse(h.plane.ownerIsActive(instance.deviceInstanceId, activationId: 2))
        XCTAssertFalse(instance.hasLiveBackgroundDeviceWork)
        XCTAssertEqual(h.plane.liveCount, 1, "only the control stream is left")
    }

    /// The bounded await behind `settle` returns at its timeout even when the
    /// awaited task ignores cancellation and never finishes on its own. The
    /// former task-group helper waited for that task instead: a device
    /// outcome that never arrived hung the test (and the xctest process)
    /// rather than failing it.
    func testBoundedAwaitNeverWaitsForATaskThatIgnoresCancellation() async throws {
        let gate = DeviceTestGate()
        let stubborn = Task { () -> Int in
            await gate.wait() // no cancellation handler: cancel is ignored
            return 7
        }
        // Released late, so a helper that waits for the task would return
        // only after the gate opens (and fail the elapsed-time check).
        let opener = Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            gate.open()
        }
        let start = Date()
        let value = await awaitBounded(stubborn, timeout: 0.2)
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertNil(value)
        XCTAssertLessThan(elapsed, 2, "returned at the timeout, not when the task finished")
        stubborn.cancel()
        gate.open()
        opener.cancel()
        let finished = await awaitBounded(stubborn, timeout: 5)
        XCTAssertEqual(finished, 7)
        // A value that arrives first is returned as soon as it exists.
        let quick = Task { 42 }
        let quickStart = Date()
        let v = await awaitBounded(quick, timeout: 30)
        XCTAssertEqual(v, 42)
        XCTAssertLessThan(Date().timeIntervalSince(quickStart), 2)
    }

    func testReplayedDispatchContextsCarryReplayProvenanceAcrossTasks() async throws {
        let h = try PlaneHarness(activate: false)
        let box = ContextBox()
        let def = AppBuilder([:])
            .onActionAsync("probe") { ctx in
                // A task spawned by the handler inherits the provenance.
                let inner = await Task { DeviceProvenance.current }.value
                box.put(ctx.device, inner)
            }
            .build()
        let instance = try ModuleInstance(definition: def)
        instance.attachDevice(h.plane)
        instance.activate()

        instance.runReplayed { instance.dispatchAction("probe") }
        let (replayed, inner) = await box.take()
        XCTAssertEqual(replayed.provenance, .replay)
        XCTAssertEqual(inner, .replay)
        guard case .failure(let e) = await replayed.permissions.query(.camera) else { return XCTFail() }
        XCTAssertEqual(e.code, .unavailable)

        instance.dispatchAction("probe")
        let (origin, _) = await box.take()
        XCTAssertEqual(origin.provenance, .origin)
        let task = Task { await origin.permissions.query(.camera) }
        let id = await h.recorder.requestId("permission.query")
        h.plane.receiveText(W.response(id, result: ["status": "granted"]))
        let granted = try await settle(task).unwrapped().get()
        XCTAssertEqual(granted.status, .granted)
    }

    func testOnActivatedAsyncOwnsItsActivation() async throws {
        let h = try PlaneHarness(activate: false)
        let box = ContextBox()
        let def = AppBuilder([:])
            .onActivatedAsync { _, device in
                box.put(device, DeviceProvenance.current)
                _ = await device.gallery.pick()
            }
            .build()
        let instance = try ModuleInstance(definition: def)
        instance.attachDevice(h.plane)
        instance.activate()
        let (ctx, _) = await box.take()
        XCTAssertEqual(ctx.owner?.moduleInstanceId, instance.deviceInstanceId)
        let id = await h.recorder.requestId("gallery.pick")
        instance.deactivate()
        await h.recorder.wait("sweep") { h.recorder.controls(id, "cancel").count == 1 }
    }
}

/// A one-shot gate a task can await without any cancellation handler.
final class DeviceTestGate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.lock()
            if isOpen {
                lock.unlock()
                c.resume()
                return
            }
            waiters.append(c)
            lock.unlock()
        }
    }

    func open() {
        lock.lock()
        isOpen = true
        let w = waiters
        waiters.removeAll()
        lock.unlock()
        for c in w { c.resume() }
    }
}

/// Hands a context from a handler to the test.
final class ContextBox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(DeviceContext, DeviceProvenance)] = []
    func put(_ c: DeviceContext, _ p: DeviceProvenance) { lock.withLock { items.append((c, p)) } }
    func take() async -> (DeviceContext, DeviceProvenance) {
        for _ in 0..<2_000 {
            if let v = lock.withLock({ items.isEmpty ? nil : items.removeFirst() }) { return v }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        fatalError("no context arrived")
    }
}
