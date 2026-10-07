import XCTest
import SwiftUI
@testable import HypenSwift

/// `.dropZone(files: true, accept:)` — "Files from the OS" in
/// `hypen-web/docs/dnd.md`. Real external drags can't be synthesized, so
/// the coordinator is driven through the same seam `HypenFileDropDelegate`
/// uses (`fileDragShouldValidate` / `Entered` / `Updated` / `Exited` /
/// `PerformDrop` with `HypenFileDragItem` samples).
@MainActor
final class FileDropZoneTests: XCTestCase {

    // MARK: - Harness

    private var renderer: HypenRenderer!
    private var clock: HypenManualAnimationScheduler!
    private var dispatcher: MockActionDispatcher!

    private var dnd: HypenDndCoordinator { renderer.dnd }

    override func setUp() async throws {
        renderer = HypenRenderer()
        clock = HypenManualAnimationScheduler()
        dispatcher = MockActionDispatcher()
        renderer.dnd.scheduler = clock
        renderer.dnd.actionDispatcher = dispatcher
        renderer.dnd.reducedMotionOverride = true
    }

    private static let overPose: [String: Any] = [
        "over": ["backgroundColor.0": "#eef2ff"] as [String: Any],
    ]

    private static func zone(files: Bool = true, accept: String? = nil) -> [String: Any] {
        var zone: [String: Any] = ["group": NSNull(), "band": 0.5]
        if files {
            zone["files"] = true
            zone["accept"] = accept.map { $0 as Any } ?? NSNull()
        }
        return zone
    }

    private static let jpeg = HypenFileDragItem(typeIdentifiers: ["public.jpeg"], suggestedName: "IMG_1.jpeg")
    private static let pdf = HypenFileDragItem(typeIdentifiers: ["com.adobe.pdf"], suggestedName: "doc.pdf")
    private static let textSelection = HypenFileDragItem(
        typeIdentifiers: ["public.utf8-plain-text", "com.apple.uikit.attributedstring"]
    )

    /// root > outer (files zone, `.onFileDragEnter(@outerEnter)`) > inner
    /// (files zone, `accept: image/*`, `.onFileDragEnter(@innerEnter)`),
    /// both with an `over` pose.
    private func build(
        outerExtra: [String: Any] = [:],
        innerExtra: [String: Any] = [:],
        innerAccept: String? = "image/*"
    ) {
        var outer: [String: Any] = [
            HypenDnd.zoneProp: Self.zone(),
            HypenDnd.statePosesProp: Self.overPose,
            "onFileDragEnter.0": "@outerEnter",
        ]
        // An NSNull extra removes the key.
        for (key, value) in outerExtra { outer[key] = value is NSNull ? nil : value }
        var inner: [String: Any] = [
            HypenDnd.zoneProp: Self.zone(accept: innerAccept),
            HypenDnd.statePosesProp: Self.overPose,
            "onFileDragEnter.0": "@innerEnter",
        ]
        for (key, value) in innerExtra { inner[key] = value }
        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "outer", elementType: "column", props: outer),
            Patch(type: .insert, id: "outer", parentId: "root"),
            Patch(type: .create, id: "inner", elementType: "column", props: inner),
            Patch(type: .insert, id: "inner", parentId: "outer"),
        ])
    }

    private func label(_ id: String) -> String? {
        renderer.getElement(id)?.dndPoseLabel
    }

    /// `(node, action, payload)` of every `__hypen_dispatch`.
    private var dispatched: [(node: String, action: String, payload: [String: Any])] {
        dispatcher.dispatchedActions.compactMap { call in
            guard call.action == "__hypen_dispatch", let envelope = call.payload else { return nil }
            return (
                envelope["node"] as? String ?? "",
                envelope["action"] as? String ?? "",
                envelope["payload"] as? [String: Any] ?? [:]
            )
        }
    }

    private func settle() {
        clock.advance(by: 0)
    }

    // MARK: - Spec parsing

    func testParseZoneFilesAndAccept() {
        let spec = HypenDnd.parseZone(["group": "cards", "band": 0.3, "files": true, "accept": "image/*"])
        XCTAssertEqual(spec, DndZoneSpec(group: "cards", band: 0.3, files: true, accept: "image/*"))
    }

    func testParseZoneWithoutFilesIsInAppOnly() {
        let spec = HypenDnd.parseZone(["group": NSNull(), "band": 0.5])
        XCTAssertEqual(spec?.files, false)
        XCTAssertNil(spec?.accept)
    }

    func testParseZoneNullAcceptMeansAny() {
        let spec = HypenDnd.parseZone(["group": NSNull(), "band": 0.5, "files": true, "accept": NSNull()])
        XCTAssertEqual(spec?.files, true)
        XCTAssertNil(spec?.accept)
    }

    func testParseZoneDefensive() {
        // accept without files is ignored; a blank accept is "any".
        XCTAssertNil(HypenDnd.parseZone(["accept": "image/*"])?.accept)
        XCTAssertNil(HypenDnd.parseZone(["files": true, "accept": "  "])?.accept)
        // A number 1 is not the bool true; a raw-JSON "true" string is tolerated.
        XCTAssertEqual(HypenDnd.parseZone(["files": 1])?.files, false)
        XCTAssertEqual(HypenDnd.parseZone(["files": "true"])?.files, true)
        XCTAssertEqual(HypenDnd.parseZone(["files": false, "accept": ".pdf"]), DndZoneSpec(group: nil, band: 0.5))
    }

    func testParseSpecsCarriesFilesZone() {
        let specs = HypenDnd.parseSpecs([
            HypenDnd.zoneProp: ["group": NSNull(), "band": 0.5, "files": true, "accept": ".pdf"] as [String: Any],
            HypenDnd.zoneEnabledProp: false,
        ])
        XCTAssertEqual(specs.zone?.files, true)
        XCTAssertEqual(specs.zone?.accept, ".pdf")
        XCTAssertFalse(specs.zoneEnabled)
    }

    // MARK: - Accept matching

    func testAcceptNoFilterMatchesEverything() {
        XCTAssertTrue(HypenFileAccept.matches(accept: nil, items: [Self.pdf]))
        XCTAssertTrue(HypenFileAccept.matches(accept: "*/*", items: [Self.pdf]))
        XCTAssertTrue(HypenFileAccept.matches(accept: " , ", items: [Self.pdf]))
    }

    func testAcceptWildcardUsesTopLevelConformance() {
        XCTAssertTrue(HypenFileAccept.matches(accept: "image/*", items: [Self.jpeg]))
        XCTAssertTrue(HypenFileAccept.matches(accept: "image/*", items: [HypenFileDragItem(typeIdentifiers: ["public.heic"])]))
        XCTAssertFalse(HypenFileAccept.matches(accept: "image/*", items: [Self.pdf]))
        XCTAssertTrue(HypenFileAccept.matches(accept: "video/*", items: [HypenFileDragItem(typeIdentifiers: ["com.apple.quicktime-movie"])]))
        XCTAssertFalse(HypenFileAccept.matches(accept: "audio/*", items: [Self.jpeg]))
    }

    func testAcceptMimeType() {
        XCTAssertTrue(HypenFileAccept.matches(accept: "application/pdf", items: [Self.pdf]))
        XCTAssertFalse(HypenFileAccept.matches(accept: "application/pdf", items: [Self.jpeg]))
        XCTAssertTrue(HypenFileAccept.matches(accept: "IMAGE/JPEG", items: [Self.jpeg]))
    }

    func testAcceptExtension() {
        // By suggested name (case-insensitive), with or without the dot.
        XCTAssertTrue(HypenFileAccept.matches(accept: ".pdf", items: [HypenFileDragItem(typeIdentifiers: [], suggestedName: "Report.PDF")]))
        XCTAssertTrue(HypenFileAccept.matches(accept: "pdf", items: [Self.pdf]))
        // By the extension's UTType, without a name.
        XCTAssertTrue(HypenFileAccept.matches(accept: ".pdf", items: [HypenFileDragItem(typeIdentifiers: ["com.adobe.pdf"])]))
        XCTAssertFalse(HypenFileAccept.matches(accept: ".pdf", items: [Self.jpeg]))
    }

    func testAcceptListMatchesAnyEntryAndAnyItem() {
        XCTAssertTrue(HypenFileAccept.matches(accept: "image/png, .pdf", items: [Self.pdf]))
        XCTAssertTrue(HypenFileAccept.matches(accept: "image/*", items: [Self.pdf, Self.jpeg]))
        XCTAssertFalse(HypenFileAccept.matches(accept: "image/png, audio/*", items: [Self.pdf]))
    }

    func testAcceptUnknownCountsAsMatch() {
        // A filter entry the system can't resolve.
        XCTAssertTrue(HypenFileAccept.matches(accept: "x-hypen/x-never-registered", items: [Self.pdf]))
        XCTAssertTrue(HypenFileAccept.matches(accept: "chemical/*", items: [Self.pdf]))
        // An item whose type can't be told before the drop.
        XCTAssertTrue(HypenFileAccept.matches(accept: "image/*", items: [HypenFileDragItem(typeIdentifiers: ["com.example.never-declared"])]))
        // No item information at all.
        XCTAssertTrue(HypenFileAccept.matches(accept: "image/*", items: []))
    }

    func testFileItemHeuristic() {
        XCTAssertTrue(HypenFileAccept.isFileItem(Self.jpeg))
        XCTAssertTrue(HypenFileAccept.isFileItem(HypenFileDragItem(typeIdentifiers: ["public.jpeg"])))
        XCTAssertTrue(HypenFileAccept.isFileItem(HypenFileDragItem(typeIdentifiers: ["public.file-url"])))
        XCTAssertTrue(HypenFileAccept.isFileItem(HypenFileDragItem(typeIdentifiers: ["public.plain-text"], suggestedName: "notes.txt")))
        XCTAssertFalse(HypenFileAccept.isFileItem(Self.textSelection))
        XCTAssertFalse(HypenFileAccept.isFileItem(HypenFileDragItem(typeIdentifiers: ["public.url"])))
        XCTAssertFalse(HypenFileAccept.isFileItem(HypenFileDragItem(typeIdentifiers: [])))
        XCTAssertTrue(HypenFileAccept.carriesFiles([Self.textSelection, Self.pdf]))
        XCTAssertFalse(HypenFileAccept.carriesFiles([Self.textSelection]))
    }

    // MARK: - Over pose and onFileDragEnter

    func testEnterLightsZoneAndDispatchesOnce() {
        build()
        XCTAssertTrue(dnd.fileDragShouldValidate(zoneId: "outer", items: [Self.pdf, Self.jpeg]))
        dnd.fileDragEntered(zoneId: "outer", items: [Self.pdf, Self.jpeg])
        XCTAssertEqual(label("outer"), HypenDnd.labelOver)
        XCTAssertEqual(dnd.fileOverZoneId, "outer")

        XCTAssertEqual(dispatched.count, 1)
        let call = dispatched[0]
        XCTAssertEqual(call.node, "outer")
        XCTAssertEqual(call.action, "outerEnter")
        XCTAssertEqual(call.payload["type"] as? String, "filedragenter")
        XCTAssertEqual(call.payload["items"] as? Int, 2)
        XCTAssertNotNil(call.payload["timestamp"] as? Int)
        XCTAssertEqual(Set(call.payload.keys), ["type", "timestamp", "items"])

        // Hover updates refuse the release and never re-fire.
        XCTAssertEqual(dnd.fileDragUpdated(zoneId: "outer", items: [Self.pdf, Self.jpeg]), .forbidden)
        XCTAssertEqual(dnd.fileDragUpdated(zoneId: "outer", items: [Self.pdf, Self.jpeg]), .forbidden)
        settle()
        XCTAssertEqual(dispatched.count, 1)
    }

    func testExitClearsAfterOneTurn() {
        build()
        dnd.fileDragEntered(zoneId: "outer", items: [Self.pdf])
        dnd.fileDragExited(zoneId: "outer")
        XCTAssertEqual(label("outer"), HypenDnd.labelOver, "exit settles one turn later")
        settle()
        XCTAssertNil(label("outer"))
        XCTAssertNil(dnd.fileOverZoneId)

        // A fresh entry is a new entry: it fires again.
        dnd.fileDragEntered(zoneId: "outer", items: [Self.pdf])
        XCTAssertEqual(dispatched.map(\.action), ["outerEnter", "outerEnter"])
    }

    func testInnermostZoneWinsAndNestedMovesDoNotRefire() {
        build()
        dnd.fileDragEntered(zoneId: "outer", items: [Self.jpeg])
        // Into the nested zone: the platform reports outer exit + inner enter.
        dnd.fileDragExited(zoneId: "outer")
        dnd.fileDragEntered(zoneId: "inner", items: [Self.jpeg])
        settle()
        XCTAssertEqual(label("inner"), HypenDnd.labelOver)
        XCTAssertNil(label("outer"), "only one zone is over at a time")
        XCTAssertEqual(dnd.fileOverZoneId, "inner")
        XCTAssertEqual(dispatched.map(\.action), ["outerEnter", "innerEnter"])

        // Back out to the outer zone (enter before exit this time).
        dnd.fileDragEntered(zoneId: "outer", items: [Self.jpeg])
        dnd.fileDragExited(zoneId: "inner")
        settle()
        XCTAssertEqual(label("outer"), HypenDnd.labelOver)
        XCTAssertNil(label("inner"))
        XCTAssertEqual(dispatched.map(\.action), ["outerEnter", "innerEnter"], "outer never left: no re-fire")
    }

    func testEnteringNestedZoneDirectlyEntersBoth() {
        build()
        dnd.fileDragEntered(zoneId: "inner", items: [Self.jpeg])
        XCTAssertEqual(label("inner"), HypenDnd.labelOver)
        XCTAssertNil(label("outer"))
        // Outer first, like DOM bubbling.
        XCTAssertEqual(dispatched.map(\.action), ["outerEnter", "innerEnter"])
    }

    func testAcceptMismatchFallsThroughToMatchingAncestor() {
        build()
        dnd.fileDragEntered(zoneId: "inner", items: [Self.pdf])
        XCTAssertNil(label("inner"))
        XCTAssertEqual(label("outer"), HypenDnd.labelOver, "the enclosing zone (no accept) matches and lights")
        XCTAssertEqual(dnd.fileOverZoneId, "outer")
        // `.onFileDragEnter` follows the same condition as `over`: the
        // non-matching inner zone stays silent; the outer zone (no accept)
        // still signals its own entry.
        XCTAssertEqual(dispatched.map(\.action), ["outerEnter"])
    }

    func testOnFileDragEnterRequiresAcceptMatch() {
        build()
        // Only the inner zone (`accept: image/*`) is hovered by a PDF drag.
        dnd.fileDragEntered(zoneId: "inner", items: [Self.pdf])
        XCTAssertFalse(dispatched.map(\.action).contains("innerEnter"))
        dnd.fileDragExited(zoneId: "inner")
        settle()
        // An image drag matches: it lights and signals.
        dnd.fileDragEntered(zoneId: "inner", items: [Self.jpeg])
        XCTAssertEqual(label("inner"), HypenDnd.labelOver)
        XCTAssertEqual(dispatched.filter { $0.action == "innerEnter" }.count, 1)
    }

    func testNoMatchingZoneLightsNothing() {
        build(outerExtra: [HypenDnd.zoneProp: Self.zone(accept: "audio/*")])
        dnd.fileDragEntered(zoneId: "inner", items: [Self.pdf])
        XCTAssertNil(label("inner"))
        XCTAssertNil(label("outer"))
        XCTAssertNil(dnd.fileOverZoneId)
        XCTAssertTrue(dispatched.isEmpty)
    }

    func testFallThroughMovesBackInWhenInnerMatches() {
        build()
        // Mixed drag: inner (image/*) matches thanks to the jpeg → inner wins.
        dnd.fileDragEntered(zoneId: "inner", items: [Self.pdf, Self.jpeg])
        XCTAssertEqual(label("inner"), HypenDnd.labelOver)
        XCTAssertNil(label("outer"))
        XCTAssertEqual(dispatched.map(\.action), ["outerEnter", "innerEnter"])
    }

    func testOnFileDragEnterRequiresEnabledZone() {
        build(outerExtra: [HypenDnd.zoneEnabledProp: false])
        dnd.fileDragEntered(zoneId: "outer", items: [Self.jpeg])
        XCTAssertNil(label("outer"))
        XCTAssertTrue(dispatched.isEmpty)
    }

    func testDropIsRefusedAndClears() {
        build()
        dnd.fileDragEntered(zoneId: "inner", items: [Self.jpeg])
        XCTAssertFalse(dnd.fileDragPerformDrop(zoneId: "inner"))
        XCTAssertNil(label("inner"))
        XCTAssertNil(label("outer"))
        XCTAssertNil(dnd.fileOverZoneId)
        // A trailing exit after the drop is harmless.
        dnd.fileDragExited(zoneId: "inner")
        settle()
        XCTAssertNil(label("inner"))
        XCTAssertEqual(dispatched.count, 2)
    }

    func testDisabledZoneIsTransparent() {
        build(innerExtra: [HypenDnd.zoneEnabledProp: false])
        XCTAssertFalse(dnd.fileDragShouldValidate(zoneId: "inner", items: [Self.jpeg]))
        // If the platform still reports the nested target, the enclosing
        // enabled zone is the innermost one.
        dnd.fileDragEntered(zoneId: "inner", items: [Self.jpeg])
        XCTAssertNil(label("inner"))
        XCTAssertEqual(label("outer"), HypenDnd.labelOver)
        XCTAssertEqual(dispatched.map(\.action), ["outerEnter"])
    }

    func testDisablingMidHoverClearsAndReenablingRelights() {
        build()
        dnd.fileDragEntered(zoneId: "outer", items: [Self.pdf])
        renderer.applyPatches([Patch(type: .setProp, id: "outer", name: HypenDnd.zoneEnabledProp, value: false)])
        XCTAssertNil(label("outer"))
        renderer.applyPatches([Patch(type: .setProp, id: "outer", name: HypenDnd.zoneEnabledProp, value: true)])
        XCTAssertEqual(label("outer"), HypenDnd.labelOver)
        // Re-enabled while still hovered counts as a new entry into an enabled zone.
        XCTAssertEqual(dispatched.map(\.action), ["outerEnter", "outerEnter"])
    }

    func testNonFileDragsAndInAppZonesAreIgnored() {
        build()
        // A text selection dragged in is not a file drag.
        XCTAssertFalse(dnd.fileDragShouldValidate(zoneId: "outer", items: [Self.textSelection]))
        dnd.fileDragEntered(zoneId: "outer", items: [Self.textSelection])
        XCTAssertNil(label("outer"))

        // A zone without `files: true` never takes part.
        renderer.applyPatches([
            Patch(type: .create, id: "plain", elementType: "column", props: [
                HypenDnd.zoneProp: Self.zone(files: false),
                HypenDnd.statePosesProp: Self.overPose,
                "onFileDragEnter.0": "@plainEnter",
            ]),
            Patch(type: .insert, id: "plain", parentId: "root"),
        ])
        XCTAssertFalse(dnd.fileDragShouldValidate(zoneId: "plain", items: [Self.pdf]))
        dnd.fileDragEntered(zoneId: "plain", items: [Self.pdf])
        XCTAssertNil(label("plain"))
        XCTAssertTrue(dispatched.isEmpty)
    }

    func testNeverClobbersGestureRuntimeLabel() {
        build()
        // The in-app gesture runtime has this zone `over` already.
        renderer.getElement("outer")?.dndPoseLabel = HypenDnd.labelOver
        dnd.fileDragEntered(zoneId: "inner", items: [Self.jpeg])
        dnd.fileDragExited(zoneId: "inner")
        settle()
        XCTAssertEqual(label("outer"), HypenDnd.labelOver, "a label this half didn't set is left alone")
        XCTAssertNil(label("inner"))
    }

    func testCustomNamedArgumentsReplacePayload() {
        build(outerExtra: ["onFileDragEnter.kind": "photos"])
        dnd.fileDragEntered(zoneId: "outer", items: [Self.jpeg])
        XCTAssertEqual(dispatched.count, 1)
        XCTAssertEqual(dispatched[0].payload as NSDictionary, ["kind": "photos"] as NSDictionary)
    }

    func testZoneWithoutHandlerStillLightsWithoutDispatch() {
        build(outerExtra: ["onFileDragEnter.0": NSNull()])
        dnd.fileDragEntered(zoneId: "outer", items: [Self.pdf])
        XCTAssertEqual(label("outer"), HypenDnd.labelOver)
        XCTAssertTrue(dispatched.isEmpty)
    }

    func testRemovingHoveredZoneForgetsIt() {
        build()
        dnd.fileDragEntered(zoneId: "inner", items: [Self.jpeg])
        renderer.applyPatches([Patch(type: .remove, id: "inner")])
        settle()
        XCTAssertNil(dnd.fileOverZoneId)
        XCTAssertNil(label("outer"), "outer is no longer hovered once its hovered child is gone")
    }

    func testDetachOfHoveredSubtreeClears() {
        build()
        dnd.fileDragEntered(zoneId: "inner", items: [Self.jpeg])
        renderer.applyPatches([Patch(type: .detach, id: "outer")])
        XCTAssertNil(dnd.fileOverZoneId)
        XCTAssertNil(label("inner"))
    }

    func testInAppDragUnaffectedByFilesFlag() {
        // A files zone still lights for an in-app drag exactly as before.
        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "card", elementType: "text", props: [
                HypenDnd.sourceProp: ["group": NSNull(), "handle": false, "activation": "slop"] as [String: Any],
                HypenDnd.keyProp: "c1",
            ]),
            Patch(type: .insert, id: "card", parentId: "root"),
            Patch(type: .create, id: "drop", elementType: "column", props: [
                HypenDnd.zoneProp: Self.zone(accept: "image/*"),
                HypenDnd.statePosesProp: Self.overPose,
            ]),
            Patch(type: .insert, id: "drop", parentId: "root"),
        ])
        dnd.isTouchInput = false
        dnd.updateFrames([
            "root": CGRect(x: 0, y: 0, width: 400, height: 600),
            "card": CGRect(x: 0, y: 0, width: 100, height: 40),
            "drop": CGRect(x: 0, y: 200, width: 400, height: 200),
        ])
        dnd.dragChanged(sourceId: "card", location: CGPoint(x: 50, y: 30), translation: CGSize(width: 0, height: 10))
        dnd.dragChanged(sourceId: "card", location: CGPoint(x: 50, y: 300), translation: CGSize(width: 0, height: 280))
        XCTAssertEqual(dnd.phase, .dragging)
        XCTAssertEqual(label("drop"), HypenDnd.labelOver)
        XCTAssertNil(dnd.fileOverZoneId)
    }
}
