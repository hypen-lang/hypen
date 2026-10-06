import Testing
import SwiftUI
@testable import HypenSwift

// MARK: - Harness

/// A renderer wired to a virtual clock, a recording dispatcher, and
/// synthetic node frames, so the drag runtime can be driven with pointer
/// samples exactly as the gesture layer would — no views, no gestures.
@MainActor
private struct DndHarness {
    let renderer = HypenRenderer()
    let clock = HypenManualAnimationScheduler()
    let dispatcher = MockActionDispatcher()

    init(touch: Bool = false) {
        renderer.dnd.scheduler = clock
        renderer.dnd.actionDispatcher = dispatcher
        renderer.dnd.reducedMotionOverride = true
        renderer.dnd.isTouchInput = touch
    }

    var dnd: HypenDndCoordinator { renderer.dnd }

    var actions: [String] {
        dispatcher.dispatchedActions.map { $0.action == "__hypen_dispatch" ? ($0.payload?["action"] as? String ?? "") : $0.action }
    }

    func payload(_ index: Int) -> [String: Any] {
        guard index < dispatcher.dispatchedActions.count else { return [:] }
        let call = dispatcher.dispatchedActions[index]
        return (call.action == "__hypen_dispatch" ? call.payload?["payload"] as? [String: Any] : call.payload) ?? [:]
    }

    func element(_ id: String) -> HypenElement? {
        renderer.getElement(id)
    }

    static func sourceSpec(group: String? = nil, activation: String = "auto") -> [String: Any] {
        ["group": group.map { $0 as Any } ?? NSNull(), "handle": false, "activation": activation]
    }

    /// `Column#list.sortable(axis: y).bind(@state.tasks)` with three rows,
    /// each wrapping a draggable Text keyed `t1`..`t3` (the
    /// `sortable-lowering` fixture shape). Rows are 90pt tall with a 10pt
    /// gap in a 200x300 list at the host origin.
    func buildSortable(
        listExtra: [String: Any] = [:],
        rowExtra: [String: [String: Any]] = [:],
        sourceExtra: [String: [String: Any]] = [:]
    ) {
        var listProps: [String: Any] = [
            HypenDnd.sortProp: ["group": NSNull(), "axis": "y"] as [String: Any],
            "bind": "tasks",
            "onSort.0": "@reorder",
            "onDragStart.0": "@started",
            "onDragEnd.0": "@ended",
        ]
        for (key, value) in listExtra { listProps[key] = value }

        var patches: [Patch] = [
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "list", elementType: "column", props: listProps),
            Patch(type: .insert, id: "list", parentId: "root"),
        ]
        var frames: [String: CGRect] = [
            "root": CGRect(x: 0, y: 0, width: 400, height: 600),
            "list": CGRect(x: 0, y: 0, width: 200, height: 300),
        ]
        for i in 1...3 {
            let row = "r\(i)"
            let source = "t\(i)"
            var rowProps: [String: Any] = [:]
            for (key, value) in rowExtra[row] ?? [:] { rowProps[key] = value }
            var sourceProps: [String: Any] = [
                HypenDnd.keyProp: source,
                HypenDnd.sourceProp: DndHarness.sourceSpec(),
                HypenDnd.sourcePayloadProp: ["id": source] as [String: Any],
            ]
            for (key, value) in sourceExtra[source] ?? [:] { sourceProps[key] = value }
            patches.append(Patch(type: .create, id: row, elementType: "row", props: rowProps))
            patches.append(Patch(type: .insert, id: row, parentId: "list"))
            patches.append(Patch(type: .create, id: source, elementType: "text", props: sourceProps))
            patches.append(Patch(type: .insert, id: source, parentId: row))
            let top = CGFloat(i - 1) * 100
            frames[row] = CGRect(x: 0, y: top, width: 200, height: 90)
            frames[source] = CGRect(x: 10, y: top + 10, width: 100, height: 30)
        }
        renderer.applyPatches(patches)
        dnd.updateFrames(frames)
    }

    /// `Stack#board.pinboard(group: "board", grid: 8)` in reserved mode with
    /// one note (`pinboard-reserved-lowering` shape): translate bindings
    /// present with explicit null.
    func buildPinboard(units: String = "px", bounds: String = "clamp", bind: String? = nil) {
        // Reserved mode carries the group; user-field mode (a `bind`) leaves it null.
        let group: Any = bind == nil ? "board" as Any : NSNull() as Any
        var boardProps: [String: Any] = [
            HypenDnd.pinProp: [
                "group": group,
                "xKey": "x", "yKey": "y", "grid": 8, "bounds": bounds, "units": units,
            ] as [String: Any],
            "onPin.0": "@pinned",
            "onDragEnd.0": "@ended",
        ]
        if let bind = bind { boardProps["bind"] = bind }
        var noteProps: [String: Any] = [
            HypenDnd.keyProp: "n1",
            HypenDnd.sourceProp: DndHarness.sourceSpec(),
            "translateX.0": NSNull(),
            "translateY.0": NSNull(),
        ]
        if bind == nil { noteProps[HypenDnd.pinGroupProp] = "board" }
        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "board", elementType: "stack", props: boardProps),
            Patch(type: .insert, id: "board", parentId: "root"),
            Patch(type: .create, id: "n1", elementType: "note", props: noteProps),
            Patch(type: .insert, id: "n1", parentId: "board"),
        ])
        dnd.updateFrames([
            "root": CGRect(x: 0, y: 0, width: 400, height: 600),
            "board": CGRect(x: 0, y: 0, width: 400, height: 400),
            "n1": CGRect(x: 20, y: 30, width: 50, height: 50),
        ])
    }

    /// Lift `t1` with a below-slop-then-past-slop mouse move (slop
    /// activation) and park it at `location`.
    func liftT1(to location: CGPoint) {
        dnd.dragChanged(
            sourceId: "t1",
            location: CGPoint(x: 60, y: 35),
            translation: CGSize(width: 0, height: 10)
        )
        dnd.dragChanged(
            sourceId: "t1",
            location: location,
            translation: CGSize(width: location.x - 60, height: location.y - 25)
        )
    }
}

private func location(_ payload: [String: Any], _ key: String) -> (zone: String?, index: Any?) {
    let loc = payload[key] as? [String: Any]
    return (loc?["zone"] as? String, loc?["index"])
}

// MARK: - Parsing (§2)

@Test func testDndParseSourceDefaultsAndMalformed() {
    let spec = HypenDnd.parseSource(["group": NSNull(), "handle": false, "activation": "auto"] as [String: Any])
    #expect(spec == DndSourceSpec(group: nil, handle: false, activation: .auto))

    let pressed = HypenDnd.parseSource(["group": "cards", "handle": true, "activation": "press"] as [String: Any])
    #expect(pressed == DndSourceSpec(group: "cards", handle: true, activation: .press))

    // Unknown activation degrades to the default; a non-object is no role.
    #expect(HypenDnd.parseSource(["activation": "bogus"] as [String: Any])?.activation == .auto)
    #expect(HypenDnd.parseSource("draggable") == nil)
    #expect(HypenDnd.parseSource(nil) == nil)
    #expect(HypenDnd.parseSource(42) == nil)
}

@Test func testDndParseZoneClampsBand() {
    #expect(HypenDnd.parseZone(["group": "fs", "band": 0.3] as [String: Any]) == DndZoneSpec(group: "fs", band: 0.3))
    #expect(HypenDnd.parseZone(["group": NSNull(), "band": 7] as [String: Any])?.band == 1)
    #expect(HypenDnd.parseZone(["band": -1] as [String: Any])?.band == 0)
    #expect(HypenDnd.parseZone(["band": "wide"] as [String: Any])?.band == HypenDnd.defaultBand)
    #expect(HypenDnd.parseZone([] as [Any]) == nil)
}

@Test func testDndParseSortAndPinDefaults() {
    #expect(HypenDnd.parseSort(["group": NSNull(), "axis": "y"] as [String: Any]) == DndSortSpec(group: nil, axis: .y))
    #expect(HypenDnd.parseSort(["axis": "diagonal"] as [String: Any])?.axis == .y)

    let pin = HypenDnd.parsePin([
        "group": "board", "xKey": "x", "yKey": "y", "grid": NSNull(), "bounds": "clamp", "units": "px",
    ] as [String: Any])
    #expect(pin == DndPinSpec(group: "board", xKey: "x", yKey: "y", grid: nil, bounds: .clamp, units: .px))

    let custom = HypenDnd.parsePin([
        "group": NSNull(), "xKey": "left", "yKey": "top", "grid": 8, "bounds": "free", "units": "fraction",
    ] as [String: Any])
    #expect(custom == DndPinSpec(group: nil, xKey: "left", yKey: "top", grid: 8, bounds: .free, units: .fraction))

    // A non-positive grid is no grid; empty keys fall back.
    let degraded = HypenDnd.parsePin(["grid": -4, "xKey": ""] as [String: Any])
    #expect(degraded?.grid == nil)
    #expect(degraded?.xKey == "x")
}

@Test func testDndParseEnabledAndString() {
    #expect(HypenDnd.parseEnabled(nil) == true)
    #expect(HypenDnd.parseEnabled(NSNull()) == true)
    #expect(HypenDnd.parseEnabled(true) == true)
    #expect(HypenDnd.parseEnabled(false) == false)
    #expect(HypenDnd.parseEnabled("false") == false)
    #expect(HypenDnd.parseEnabled("yes") == true)

    #expect(HypenDnd.parseString("t1") == "t1")
    #expect(HypenDnd.parseString("") == nil)
    #expect(HypenDnd.parseString(7) == "7")
    #expect(HypenDnd.parseString(2.5) == "2.5")
    #expect(HypenDnd.parseString(NSNull()) == nil)
    #expect(HypenDnd.parseString(true) == nil)
}

@Test func testDndParseSpecsReadsTheWholeSurface() {
    let specs = HypenDnd.parseSpecs([
        HypenDnd.keyProp: "t1",
        HypenDnd.sourceProp: ["group": NSNull(), "handle": false, "activation": "auto"] as [String: Any],
        HypenDnd.sourcePayloadProp: NSNull(),
        HypenDnd.sourceEnabledProp: false,
        HypenDnd.statePosesProp: [
            "lifted": ["opacity.0": 0.6, "scale.0": 1.04] as [String: Any],
            "over": ["backgroundColor.0": "#eee"] as [String: Any],
            "junk": "not a pose",
        ] as [String: Any],
    ])
    #expect(specs.source != nil)
    #expect(specs.key == "t1")
    // A payload that resolved to null is still "given".
    #expect(specs.hasPayload)
    #expect(specs.payload is NSNull)
    #expect(specs.sourceEnabled == false)
    #expect(specs.poses?.count == 2)
    #expect(specs.poses?["lifted"]?["scale.0"] as? Double == 1.04)
    #expect(specs.hasRole)
    #expect(!specs.isEmpty)
    #expect(!specs.isContainer)

    let plain = HypenDnd.parseSpecs(["opacity.0": 1])
    #expect(plain.isEmpty)
    #expect(plain.sourceEnabled)
    #expect(plain.zoneEnabled)
}

// MARK: - Geometry

@Test func testResolveBandIsHalfOpen() {
    // Item [100, 190), band 0.5 → before < 122.5 ≤ into < 167.5 ≤ after.
    #expect(DndGeometry.resolveBand(pointer: 122.49, itemStart: 100, itemLength: 90, band: 0.5) == .before)
    #expect(DndGeometry.resolveBand(pointer: 122.5, itemStart: 100, itemLength: 90, band: 0.5) == .into)
    #expect(DndGeometry.resolveBand(pointer: 167.49, itemStart: 100, itemLength: 90, band: 0.5) == .into)
    #expect(DndGeometry.resolveBand(pointer: 167.5, itemStart: 100, itemLength: 90, band: 0.5) == .after)
    // Outside the item resolves by side.
    #expect(DndGeometry.resolveBand(pointer: 50, itemStart: 100, itemLength: 90, band: 0.5) == .before)
    #expect(DndGeometry.resolveBand(pointer: 300, itemStart: 100, itemLength: 90, band: 0.5) == .after)
    // band 0 never yields into (midpoint split); band 1 is into everywhere inside.
    #expect(DndGeometry.resolveBand(pointer: 144.9, itemStart: 100, itemLength: 90, band: 0) == .before)
    #expect(DndGeometry.resolveBand(pointer: 145, itemStart: 100, itemLength: 90, band: 0) == .after)
    #expect(DndGeometry.resolveBand(pointer: 100, itemStart: 100, itemLength: 90, band: 1) == .into)
    #expect(DndGeometry.resolveBand(pointer: 189.9, itemStart: 100, itemLength: 90, band: 1) == .into)
    #expect(DndGeometry.resolveBand(pointer: 190, itemStart: 100, itemLength: 90, band: 1) == .after)
    // Non-finite band falls back to the default.
    #expect(DndGeometry.resolveBand(pointer: 145, itemStart: 100, itemLength: 90, band: .nan) == .into)
}

@Test func testSnapToGrid() {
    #expect(DndGeometry.snapToGrid(123, grid: 8) == 120)
    #expect(DndGeometry.snapToGrid(124, grid: 8) == 128)
    #expect(DndGeometry.snapToGrid(123, grid: nil) == 123)
    #expect(DndGeometry.snapToGrid(123, grid: 0) == 123)
    #expect(DndGeometry.snapToGrid(123, grid: -8) == 123)
}

@Test func testPinPaths() {
    #expect(DndGeometry.reservedPinPath(group: "board", key: "n1") == "__dnd.board.n1")
    #expect(DndGeometry.userPinPath(bindPath: "seats", index: 3) == "seats.3")
}

@Test func testInsertionIndexCountsPassedMidpoints() {
    let rects = [
        CGRect(x: 0, y: 0, width: 200, height: 90),
        CGRect(x: 0, y: 100, width: 200, height: 90),
        CGRect(x: 0, y: 200, width: 200, height: 90),
    ]
    // Dragging the first row: midpoints of the others are 145 and 245.
    #expect(DndGeometry.insertionIndex(rects: rects, axis: .y, draggedIndex: 0, position: 45) == 0)
    #expect(DndGeometry.insertionIndex(rects: rects, axis: .y, draggedIndex: 0, position: 145) == 1)
    #expect(DndGeometry.insertionIndex(rects: rects, axis: .y, draggedIndex: 0, position: 260) == 2)
    // A foreign item counts every row.
    #expect(DndGeometry.insertionIndex(rects: rects, axis: .y, draggedIndex: nil, position: 260) == 3)
    #expect(DndGeometry.insertionIndex(rects: rects, axis: .y, draggedIndex: nil, position: 10) == 0)
}

@Test func testGapShiftsOpenTheGapTowardTheOrigin() {
    // Move index 0 to final index 2: rows 1 and 2 shift up one slot.
    #expect(DndGeometry.gapShifts(count: 3, draggedIndex: 0, to: 2, size: 100) == [0, -100, -100])
    // Move index 2 to final index 0: rows 0 and 1 shift down.
    #expect(DndGeometry.gapShifts(count: 3, draggedIndex: 2, to: 0, size: 100) == [100, 100, 0])
    // Back at the origin slot: nothing moves.
    #expect(DndGeometry.gapShifts(count: 3, draggedIndex: 1, to: 1, size: 100) == [0, 0, 0])
    // Foreign item entering at 1: rows at-or-after 1 make room.
    #expect(DndGeometry.gapShifts(count: 3, draggedIndex: nil, to: 1, size: 100) == [0, 100, 100])
    // The reset closes every gap.
    #expect(DndGeometry.gapShifts(count: 3, draggedIndex: nil, to: Int.max, size: 100) == [0, 0, 0])
}

@Test func testPinPositionSnapsClampsAndFractions() {
    let item = CGRect(x: 20, y: 30, width: 50, height: 50)
    let box = CGRect(x: 0, y: 0, width: 400, height: 400)

    let snapped = DndGeometry.pinPosition(
        itemRect: item, translation: CGSize(width: 103, height: 57), contentBox: box,
        spec: DndPinSpec(group: "board", grid: 8)
    )
    #expect(snapped.x == 120)
    #expect(snapped.y == 88)
    // The ghost lands exactly on the resolved position.
    #expect(snapped.ghostOffset == CGSize(width: 100, height: 58))

    let clamped = DndGeometry.pinPosition(
        itemRect: item, translation: CGSize(width: 900, height: -200), contentBox: box,
        spec: DndPinSpec(group: "board")
    )
    #expect(clamped.x == 350)
    #expect(clamped.y == 0)

    let free = DndGeometry.pinPosition(
        itemRect: item, translation: CGSize(width: 900, height: -200), contentBox: box,
        spec: DndPinSpec(group: "board", bounds: .free)
    )
    #expect(free.x == 920)
    #expect(free.y == -170)

    let fraction = DndGeometry.pinPosition(
        itemRect: item, translation: CGSize(width: 80, height: 70), contentBox: box,
        spec: DndPinSpec(group: "board", units: .fraction)
    )
    #expect(fraction.x == 0.25)
    #expect(fraction.y == 0.25)

    // A content box offset by padding shifts the origin.
    var padded = HypenModifier()
    padded.setPadding(all: 16)
    padded.setMargin(all: 4)
    let content = DndGeometry.contentBox(frame: CGRect(x: 100, y: 100, width: 240, height: 240), modifier: padded)
    #expect(content == CGRect(x: 120, y: 120, width: 200, height: 200))
}

// MARK: - Payload shape (§4.2) and event bindings (§2.2)

@Test func testEventPayloadDictionaryIsTheContractShape() {
    let base = DndEventPayload(
        item: "t1",
        hasPayload: true,
        payload: ["id": "t1"] as [String: Any],
        from: DndLocation(zone: "todo", index: 0),
        to: DndLocation(zone: "trash", index: nil)
    )
    let dict = base.dictionary()
    #expect(dict["item"] as? String == "t1")
    #expect((dict["payload"] as? [String: Any])?["id"] as? String == "t1")
    #expect(location(dict, "from").zone == "todo")
    #expect(location(dict, "from").index as? Int == 0)
    #expect(location(dict, "to").zone == "trash")
    // index null = "into" travels as JSON null, never as a missing key.
    #expect(location(dict, "to").index is NSNull)
    #expect(dict["x"] == nil)
    #expect(dict["y"] == nil)
    #expect(dict["dropped"] == nil)
    #expect(Set(dict.keys) == ["item", "payload", "from", "to"])

    let noPayload = DndEventPayload(item: "t1", from: DndLocation(zone: "a", index: 1), to: DndLocation(zone: "a", index: 2))
    #expect(noPayload.dictionary()["payload"] == nil)

    let pinned = base.pinned(x: 120, y: 88).dictionary()
    #expect(pinned["x"] as? Double == 120)
    #expect(pinned["y"] as? Double == 88)

    let ended = base.ended(dropped: false).dictionary()
    #expect(ended["dropped"] as? Bool == false)
}

@Test func testEventBindingStripsDwellAndMergesUnderThePayload() {
    let props: [String: Any] = [
        "onDragOver.0": "@peek",
        "onDragOver.dwell": 200,
        "onDragOver.folder": "docs",
        // A colliding custom arg must lose to the §4.2 field.
        "onDragOver.item": "spoofed",
    ]
    let binding = DndEventBinding.from(props: props, name: "onDragOver")
    #expect(binding?.actionName == "peek")
    #expect(binding?.dwellMs == 200)
    #expect(binding?.customPayload["folder"] as? String == "docs")
    #expect(binding?.customPayload["dwell"] == nil)

    let dispatched = binding!.dispatchPayload(
        DndEventPayload(item: "t1", from: DndLocation(zone: "a", index: 0), to: DndLocation(zone: "b", index: nil))
    )
    #expect(dispatched["folder"] as? String == "docs")
    #expect(dispatched["item"] as? String == "t1")
    #expect(dispatched["dwell"] == nil)

    // Absent binding, bare form, and the fixture's "@reorder" ref.
    #expect(DndEventBinding.from(props: props, name: "onSort") == nil)
    #expect(DndEventBinding.from(props: ["onSort": "@actions.reorder"], name: "onSort")?.actionName == "reorder")
    #expect(DndEventBinding.from(props: ["onSort.0": "@reorder"], name: "onSort")?.dwellMs == nil)
}

// MARK: - Activation (§6.1)

@Test func testActivationModeFollowsTheAutoRules() async {
    await MainActor.run {
        let mouse = DndHarness(touch: false)
        mouse.buildSortable()
        #expect(mouse.dnd.activationMode(for: mouse.element("t1")!) == .drag(minimumDistance: HypenDnd.slopPoints))

        let touch = DndHarness(touch: true)
        touch.buildSortable(sourceExtra: [
            "t2": [HypenDnd.sourceProp: DndHarness.sourceSpec(activation: "press")],
            "t3": [HypenDnd.sourceProp: DndHarness.sourceSpec(activation: "immediate")],
        ])
        // auto + touch inside an axis-constrained sortable: slop (cross-axis
        // rule applied to the first sample).
        #expect(touch.dnd.activationMode(for: touch.element("t1")!) == .drag(minimumDistance: HypenDnd.slopPoints))
        #expect(touch.dnd.activationMode(for: touch.element("t2")!) == .press)
        #expect(touch.dnd.activationMode(for: touch.element("t3")!) == .drag(minimumDistance: 0))

        // auto + touch outside any sortable: press.
        touch.renderer.applyPatches([
            Patch(type: .create, id: "loose", elementType: "card",
                  props: [HypenDnd.sourceProp: DndHarness.sourceSpec()]),
            Patch(type: .insert, id: "loose", parentId: "root"),
        ])
        #expect(touch.dnd.activationMode(for: touch.element("loose")!) == .press)
    }
}

@Test func testATapIsATotalNoOp() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()

        // A gesture that never reaches slop stays pending, then abandons.
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 62, y: 26), translation: CGSize(width: 2, height: 1))
        #expect(h.dnd.phase == .pending)
        #expect(h.element("r1")?.dndRaised == false)
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.dnd.phase == .idle)
        #expect(h.actions.isEmpty)

        // An end with no preceding sample is nothing at all.
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.actions.isEmpty)
        #expect(h.dnd.phase == .idle)
    }
}

@Test func testTouchAutoInAnAxisSortableLiftsOnCrossAxisTravelOnly() async {
    await MainActor.run {
        let h = DndHarness(touch: true)
        h.buildSortable()

        // Main-axis (vertical) travel scrolls: abandoned for the rest of the gesture.
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 37), translation: CGSize(width: 0, height: 12))
        #expect(h.dnd.phase == .pending)
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 90, y: 60), translation: CGSize(width: 30, height: 35))
        #expect(h.dnd.phase == .pending)
        #expect(h.element("r1")?.dndRaised == false)
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.dnd.phase == .idle)
        #expect(h.actions.isEmpty)

        // Cross-axis (horizontal) travel lifts.
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 72, y: 26), translation: CGSize(width: 12, height: 1))
        #expect(h.dnd.phase == .dragging)
        #expect(h.element("r1")?.dndRaised == true)
        #expect(h.actions == ["started"])
    }
}

@Test func testADisabledOrExitingSourceNeverLifts() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable(sourceExtra: ["t1": [HypenDnd.sourceEnabledProp: false]])
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 60), translation: CGSize(width: 0, height: 35))
        #expect(h.dnd.phase == .idle)

        // Flipping the bindable flag via SetProp re-arms it.
        h.renderer.applyPatches([Patch(type: .setProp, id: "t1", name: HypenDnd.sourceEnabledProp, value: true)])
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 60), translation: CGSize(width: 0, height: 35))
        #expect(h.dnd.phase == .dragging)
    }
}

@Test func testSourceEnabledFlippingFalseMidDragCancelsSilently() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable(sourceExtra: [
            "t1": [HypenDnd.statePosesProp: ["lifted": ["opacity.0": 0.6] as [String: Any]] as [String: Any]],
        ])
        h.liftT1(to: CGPoint(x: 60, y: 260))
        #expect(h.dnd.phase == .dragging)
        #expect(h.element("r2")?.dndShift == CGSize(width: 0, height: -100))
        #expect(h.actions == ["started"])

        // The item got locked under the finger (§6.11): cancel silently —
        // no reserved write, no onDragEnd, everything restored.
        h.renderer.applyPatches([Patch(type: .setProp, id: "t1", name: HypenDnd.sourceEnabledProp, value: false)])
        #expect(h.dnd.phase == .idle)
        #expect(h.actions == ["started"])
        #expect(h.element("r1")?.dndRaised == false)
        #expect(h.element("r1")?.dndGhostOffset == .zero)
        #expect(h.element("r2")?.dndShift == .zero)
        #expect(h.element("r3")?.dndShift == .zero)
        #expect(h.element("t1")?.dndPoseLabel == nil)

        // The rest of the gesture is dead: a later sample / end is ignored
        // and dispatches nothing.
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 270), translation: CGSize(width: 0, height: 245))
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.dnd.phase == .idle)
        #expect(h.actions == ["started"])

        // Re-armed, a pending (below-slop) gesture is abandoned the same way.
        h.renderer.applyPatches([Patch(type: .setProp, id: "t1", name: HypenDnd.sourceEnabledProp, value: true)])
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 27), translation: CGSize(width: 0, height: 2))
        #expect(h.dnd.phase == .pending)
        h.renderer.applyPatches([Patch(type: .setProp, id: "t1", name: HypenDnd.sourceEnabledProp, value: false)])
        #expect(h.dnd.phase == .idle)
        #expect(h.actions == ["started"])
    }
}

@Test func testSourceEnabledFlippingFalseDuringTheHoldLeavesTheHoldAlone() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.liftT1(to: CGPoint(x: 60, y: 260))
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.dnd.phase == .holding)
        // The drop already happened; the engine's re-render ends the hold.
        h.renderer.applyPatches([Patch(type: .setProp, id: "t1", name: HypenDnd.sourceEnabledProp, value: false)])
        #expect(h.dnd.phase == .holding)
        h.renderer.applyPatches([Patch(type: .move, id: "r1", parentId: "list")])
        #expect(h.dnd.phase == .idle)
        #expect(h.actions == ["started", HypenDnd.reorderAction, "reorder", "ended"])
    }
}

// MARK: - Sortable: preview, drop ordering, hold-until-Move (§4.2 / §6.3)

@Test func testSameListReorderDispatchesInContractOrderAndHoldsUntilMove() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable(sourceExtra: [
            "t1": [HypenDnd.statePosesProp: ["lifted": ["opacity.0": 0.6] as [String: Any]] as [String: Any]],
        ])

        h.liftT1(to: CGPoint(x: 60, y: 260))
        #expect(h.dnd.phase == .dragging)
        #expect(h.dnd.activeSourceId == "t1")
        // Ghost = the sortable's direct child (the Row), raised; lifted pose on the source.
        #expect(h.element("r1")?.dndRaised == true)
        #expect(h.element("r1")?.dndGhostOffset == CGSize(width: 0, height: 235))
        #expect(h.element("t1")?.dndPoseLabel == HypenDnd.labelLifted)
        // Siblings open the gap: one row + gap upward.
        #expect(h.element("r2")?.dndShift == CGSize(width: 0, height: -100))
        #expect(h.element("r3")?.dndShift == CGSize(width: 0, height: -100))
        // Only the opted-in onDragStart crossed the boundary so far.
        #expect(h.actions == ["started"])
        #expect(h.payload(0)["item"] as? String == "t1")
        #expect(location(h.payload(0), "from").zone == "list")
        #expect(location(h.payload(0), "from").index as? Int == 0)

        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.dnd.phase == .holding)
        // (1) reserved write, (2) onSort on the destination, (3) onDragEnd {dropped: true}.
        #expect(h.actions == ["started", HypenDnd.reorderAction, "reorder", "ended"])
        let reorder = h.payload(1)
        #expect(reorder["path"] as? String == "tasks")
        #expect(reorder["from"] as? Int == 0)
        #expect(reorder["to"] as? Int == 2)
        #expect(reorder["fromPath"] == nil)
        let sort = h.payload(2)
        #expect(sort["item"] as? String == "t1")
        #expect((sort["payload"] as? [String: Any])?["id"] as? String == "t1")
        #expect(location(sort, "from").zone == "list")
        #expect(location(sort, "from").index as? Int == 0)
        #expect(location(sort, "to").zone == "list")
        #expect(location(sort, "to").index as? Int == 2)
        #expect(sort["dropped"] == nil)
        let end = h.payload(3)
        #expect(end["dropped"] as? Bool == true)
        #expect(location(end, "to").index as? Int == 2)

        // Held: the local transforms survive the drop (no flash)...
        #expect(h.element("r2")?.dndShift == CGSize(width: 0, height: -100))
        #expect(h.element("r1")?.dndRaised == true)
        #expect(h.element("t1")?.dndPoseLabel == HypenDnd.labelLifted)

        // ...until the engine's Move for the dragged row lands.
        h.renderer.applyPatches([Patch(type: .move, id: "r1", parentId: "list")])
        #expect(h.dnd.phase == .idle)
        #expect(h.element("r2")?.dndShift == .zero)
        #expect(h.element("r3")?.dndShift == .zero)
        #expect(h.element("r1")?.dndGhostOffset == .zero)
        #expect(h.element("r1")?.dndRaised == false)
        #expect(h.element("t1")?.dndPoseLabel == nil)
        // Nothing else was dispatched by the release.
        #expect(h.actions.count == 4)
    }
}

@Test func testHoldReleasesOnTheTimeoutWhenNoReRenderLands() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.liftT1(to: CGPoint(x: 60, y: 260))
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.dnd.phase == .holding)

        h.clock.advance(by: 0.499)
        #expect(h.dnd.phase == .holding)
        h.clock.advance(by: 0.002)
        #expect(h.dnd.phase == .idle)
        #expect(h.element("r2")?.dndShift == .zero)
        #expect(h.element("r1")?.dndRaised == false)
    }
}

@Test func testDroppingBackOnTheOriginSlotWritesNothing() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        // Lift, wander, come back above the first midpoint.
        h.liftT1(to: CGPoint(x: 60, y: 260))
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 40), translation: CGSize(width: 0, height: 15))
        #expect(h.element("r2")?.dndShift == .zero)
        h.dnd.dragEnded(sourceId: "t1")
        // No reserved write, no onSort — only onDragEnd {dropped: true}; and no hold.
        #expect(h.actions == ["started", "ended"])
        #expect(h.payload(1)["dropped"] as? Bool == true)
        #expect(h.dnd.phase == .idle)
    }
}

@Test func testDropOutsideEveryZoneCancelsWithOnlyDragEndFalse() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.liftT1(to: CGPoint(x: 350, y: 500))  // inside root, outside the list
        #expect(h.dnd.phase == .dragging)
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.dnd.phase == .idle)
        #expect(h.actions == ["started", "ended"])
        #expect(h.payload(1)["dropped"] as? Bool == false)
        // The `to` of a cancel is the origin.
        #expect(location(h.payload(1), "to").zone == "list")
        #expect(location(h.payload(1), "to").index as? Int == 0)
        #expect(h.element("r1")?.dndRaised == false)
    }
}

@Test func testRemoveMidDragCancelsAndDispatchesNothing() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.liftT1(to: CGPoint(x: 60, y: 260))
        #expect(h.actions == ["started"])

        // The dragged row's subtree is torn down by the engine.
        h.renderer.applyPatches([Patch(type: .remove, id: "r1")])
        #expect(h.dnd.phase == .idle)
        // NO onDragEnd, no write: a dead interaction never writes state.
        #expect(h.actions == ["started"])
        #expect(h.element("r2")?.dndShift == .zero)
        #expect(h.element("r1") == nil)

        // The runtime is usable again afterwards.
        h.dnd.dragChanged(sourceId: "t2", location: CGPoint(x: 60, y: 160), translation: CGSize(width: 0, height: 35))
        #expect(h.dnd.phase == .dragging)
    }
}

@Test func testDetachOfAnAncestorMidDragCancelsSilently() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.liftT1(to: CGPoint(x: 60, y: 260))
        h.renderer.applyPatches([Patch(type: .detach, id: "list")])
        #expect(h.dnd.phase == .idle)
        #expect(h.actions == ["started"])
        #expect(h.element("r1")?.dndRaised == false)
    }
}

@Test func testRemoveOfAnUnrelatedRowMidDragKeepsTheDrag() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.liftT1(to: CGPoint(x: 60, y: 260))
        h.renderer.applyPatches([Patch(type: .remove, id: "r3")])
        #expect(h.dnd.phase == .dragging)
        #expect(h.actions == ["started"])
    }
}

@Test func testSystemGestureCancelFiresDragEndFalseAfterTheDeferredCheck() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.liftT1(to: CGPoint(x: 60, y: 260))

        // The @GestureState reset without an onEnded (pointercancel).
        h.dnd.gestureReset(sourceId: "t1")
        // Deferred one turn so a normal end can never race it.
        #expect(h.dnd.phase == .dragging)
        h.clock.advance(by: 0)
        #expect(h.dnd.phase == .idle)
        #expect(h.actions == ["started", "ended"])
        #expect(h.payload(1)["dropped"] as? Bool == false)

        // After a normal end the reset is bookkeeping: nothing more fires.
        h.dispatcher.clear()
        h.liftT1(to: CGPoint(x: 60, y: 260))
        h.dnd.dragEnded(sourceId: "t1")
        h.dnd.gestureReset(sourceId: "t1")
        h.clock.advance(by: 0)
        #expect(h.dnd.phase == .holding)
        #expect(h.actions == ["started", HypenDnd.reorderAction, "reorder", "ended"])
    }
}

@Test func testASecondSourceIsIgnoredWhileADragIsInFlight() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.liftT1(to: CGPoint(x: 60, y: 260))
        h.dnd.dragChanged(sourceId: "t2", location: CGPoint(x: 60, y: 160), translation: CGSize(width: 0, height: 35))
        #expect(h.dnd.activeSourceId == "t1")
        #expect(h.element("r2")?.dndRaised == false)
        h.dnd.dragEnded(sourceId: "t2")
        #expect(h.dnd.phase == .dragging)
    }
}

@Test func testTranslateSetPropOnTheLiftedNodeIsDeferredUntilRelease() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.liftT1(to: CGPoint(x: 60, y: 260))

        // dnd > engine: the write is swallowed while the drag owns the node...
        h.renderer.applyPatches([Patch(type: .setProp, id: "t1", name: "translateX.0", value: 40)])
        #expect(h.element("t1")?.props["translateX.0"] == nil)
        // ...but writes to other props still land.
        h.renderer.applyPatches([Patch(type: .setProp, id: "t1", name: "opacity.0", value: 0.5)])
        #expect(h.element("t1")?.props["opacity.0"] as? Double == 0.5)

        h.dnd.dragEnded(sourceId: "t1")
        h.clock.advance(by: 0.5)
        #expect(h.dnd.phase == .idle)
        // Flushed at release.
        #expect(h.element("t1")?.props["translateX.0"] as? Int == 40)
    }
}

@Test func testCrossListDropDispatchesTheLongReorderFormOnTheDestination() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable(listExtra: [HypenDnd.sortProp: ["group": "kanban", "axis": "y"] as [String: Any]])
        // A second, empty sortable of the same group beside the first.
        h.renderer.applyPatches([
            Patch(type: .create, id: "done", elementType: "column", props: [
                HypenDnd.sortProp: ["group": "kanban", "axis": "y"] as [String: Any],
                "bind": "done",
                "onSort.0": "@sortedDone",
            ]),
            Patch(type: .insert, id: "done", parentId: "root"),
        ])
        var frames = h.dnd.frames
        frames["done"] = CGRect(x: 200, y: 0, width: 200, height: 300)
        h.dnd.updateFrames(frames)

        h.liftT1(to: CGPoint(x: 300, y: 50))
        #expect(h.dnd.phase == .dragging)
        // Leaving the origin list for a foreign target closes the origin gap.
        #expect(h.element("r2")?.dndShift == .zero)

        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.actions == ["started", HypenDnd.reorderAction, "sortedDone", "ended"])
        let reorder = h.payload(1)
        #expect(reorder["fromPath"] as? String == "tasks")
        #expect(reorder["from"] as? Int == 0)
        #expect(reorder["toPath"] as? String == "done")
        #expect(reorder["to"] as? Int == 0)
        // zone labels are the groups.
        #expect(location(h.payload(2), "from").zone == "kanban")
        #expect(location(h.payload(2), "to").zone == "kanban")
        #expect(location(h.payload(2), "to").index as? Int == 0)

        // The re-render arrives as an Insert under the destination: release.
        h.renderer.applyPatches([Patch(type: .move, id: "r1", parentId: "done")])
        #expect(h.dnd.phase == .idle)
    }
}

// MARK: - Zones (§6.4)

@Test func testDropZoneOnASortableItemUsesTheBandRule() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable(rowExtra: [
            "r2": [
                HypenDnd.zoneProp: ["group": NSNull(), "band": 0.5] as [String: Any],
                "onDrop.0": "@dropped",
                HypenDnd.statePosesProp: ["over": ["backgroundColor.0": "#eee"] as [String: Any]] as [String: Any],
            ],
        ])

        // Middle band of r2 ([100, 190) → into for y in [122.5, 167.5)).
        h.liftT1(to: CGPoint(x: 60, y: 145))
        #expect(h.element("r2")?.dndPoseLabel == HypenDnd.labelOver)
        // "into" a zone opens no gap in the list.
        #expect(h.element("r2")?.dndShift == .zero)

        // Outer band → reorder after r2 (final index 1 for the lifted first row).
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 180), translation: CGSize(width: 0, height: 155))
        #expect(h.element("r2")?.dndPoseLabel == nil)
        #expect(h.element("list")?.dndPoseLabel == nil)
        #expect(h.element("r2")?.dndShift == CGSize(width: 0, height: -100))
        #expect(h.element("r3")?.dndShift == .zero)

        // Back into the band and drop: onDrop on the zone, index null.
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 150), translation: CGSize(width: 0, height: 125))
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.actions == ["started", "dropped", "ended"])
        let drop = h.payload(1)
        #expect(location(drop, "to").zone == "r2")
        #expect(location(drop, "to").index is NSNull)
        #expect(location(drop, "from").index as? Int == 0)
        // The over pose survives the hold and clears at release.
        #expect(h.element("r2")?.dndPoseLabel == HypenDnd.labelOver)
        h.clock.advance(by: 0.5)
        #expect(h.element("r2")?.dndPoseLabel == nil)
    }
}

@Test func testOnDragOverFiresOncePerZoneEntryAfterTheDwell() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable(rowExtra: [
            "r3": [
                HypenDnd.zoneProp: ["group": NSNull(), "band": 1] as [String: Any],
                "onDragOver.0": "@peek",
                "onDragOver.dwell": 200,
                "onDragOver.folder": "r3",
            ],
        ])
        h.liftT1(to: CGPoint(x: 60, y: 245))
        #expect(h.actions == ["started"])
        // Moving within the zone does not re-arm; the dwell fires once.
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 70, y: 250), translation: CGSize(width: 10, height: 225))
        h.clock.advance(by: 0.199)
        #expect(h.actions == ["started"])
        h.clock.advance(by: 0.002)
        #expect(h.actions == ["started", "peek"])
        let peek = h.payload(1)
        #expect(peek["folder"] as? String == "r3")
        #expect(peek["dwell"] == nil)
        #expect(location(peek, "to").zone == "r3")
        h.clock.advance(by: 1)
        #expect(h.actions == ["started", "peek"])

        // Leaving before the dwell cancels it.
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 150), translation: CGSize(width: 0, height: 125))
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 245), translation: CGSize(width: 0, height: 220))
        h.dnd.dragChanged(sourceId: "t1", location: CGPoint(x: 60, y: 150), translation: CGSize(width: 0, height: 125))
        h.clock.advance(by: 1)
        #expect(h.actions == ["started", "peek"])
    }
}

@Test func testGroupIncompatibleZonesAreNeverTargets() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.renderer.applyPatches([
            Patch(type: .create, id: "trash", elementType: "row", props: [
                HypenDnd.zoneProp: ["group": "files", "band": 0.5] as [String: Any],
                "onDrop.0": "@trashed",
            ]),
            Patch(type: .insert, id: "trash", parentId: "root"),
            Patch(type: .create, id: "bin", elementType: "row", props: [
                HypenDnd.zoneProp: ["group": NSNull(), "band": 0.5] as [String: Any],
                HypenDnd.zoneEnabledProp: false,
                "onDrop.0": "@binned",
            ]),
            Patch(type: .insert, id: "bin", parentId: "root"),
        ])
        var frames = h.dnd.frames
        frames["trash"] = CGRect(x: 250, y: 0, width: 100, height: 100)
        frames["bin"] = CGRect(x: 250, y: 200, width: 100, height: 100)
        h.dnd.updateFrames(frames)

        // A grouped zone rejects an ungrouped source; a disabled zone rejects everyone.
        h.liftT1(to: CGPoint(x: 300, y: 50))
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.actions == ["started", "ended"])
        #expect(h.payload(1)["dropped"] as? Bool == false)

        h.dispatcher.clear()
        h.liftT1(to: CGPoint(x: 300, y: 250))
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.actions == ["started", "ended"])
        #expect(h.payload(1)["dropped"] as? Bool == false)

        // Re-enabling the zone via SetProp makes it a target.
        h.dispatcher.clear()
        h.renderer.applyPatches([Patch(type: .setProp, id: "bin", name: HypenDnd.zoneEnabledProp, value: true)])
        h.liftT1(to: CGPoint(x: 300, y: 250))
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.actions == ["started", "binned", "ended"])
        #expect(location(h.payload(1), "to").zone == "bin")
    }
}

// MARK: - Pinboard (§6.5 / §4.1)

@Test func testReservedPinboardDropWritesThePinThenFiresOnPin() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildPinboard()

        // Mouse: slop. Drag the note by (103, 57).
        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 55, y: 55), translation: CGSize(width: 10, height: 0))
        #expect(h.dnd.phase == .dragging)
        // Outside a sortable the ghost is the source itself.
        #expect(h.element("n1")?.dndRaised == true)
        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 148, y: 112), translation: CGSize(width: 103, height: 57))
        #expect(h.element("n1")?.dndGhostOffset == CGSize(width: 103, height: 57))

        h.dnd.dragEnded(sourceId: "n1")
        #expect(h.dnd.phase == .holding)
        #expect(h.actions == [HypenDnd.pinAction, "pinned", "ended"])
        let pin = h.payload(0)
        #expect(pin["path"] as? String == "__dnd.board.n1")
        #expect(pin["x"] as? Double == 120)
        #expect(pin["y"] as? Double == 88)
        #expect(pin["xKey"] as? String == "x")
        #expect(pin["yKey"] as? String == "y")
        #expect(Set(pin.keys) == ["path", "x", "y", "xKey", "yKey"])
        let pinned = h.payload(1)
        #expect(pinned["item"] as? String == "n1")
        #expect(pinned["x"] as? Double == 120)
        #expect(pinned["y"] as? Double == 88)
        #expect(location(pinned, "from").zone == "board")
        #expect(location(pinned, "from").index as? Int == 0)
        #expect(location(pinned, "to").zone == "board")
        #expect(location(pinned, "to").index as? Int == 0)
        #expect(h.payload(2)["dropped"] as? Bool == true)
        // The ghost snapped to the grid-resolved spot for the hold.
        #expect(h.element("n1")?.dndGhostOffset == CGSize(width: 100, height: 58))

        // The host's write lands as translate SetProps on exactly this node:
        // that IS the re-render — release, and let the write through.
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "n1", name: "translateX.0", value: 120),
            Patch(type: .setProp, id: "n1", name: "translateY.0", value: 88),
        ])
        #expect(h.dnd.phase == .idle)
        #expect(h.element("n1")?.props["translateX.0"] as? Int == 120)
        #expect(h.element("n1")?.props["translateY.0"] as? Int == 88)
        #expect(h.element("n1")?.dndGhostOffset == .zero)
        #expect(h.element("n1")?.dndRaised == false)
    }
}

@Test func testUserFieldPinboardWritesUnderTheBindPath() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildPinboard(bind: "seats")
        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 55, y: 55), translation: CGSize(width: 10, height: 0))
        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 148, y: 112), translation: CGSize(width: 103, height: 57))
        h.dnd.dragEnded(sourceId: "n1")
        #expect(h.actions == [HypenDnd.pinAction, "pinned", "ended"])
        #expect(h.payload(0)["path"] as? String == "seats.0")
        // An ungrouped user-field board still labels by its node id.
        #expect(location(h.payload(1), "to").zone == "board")
    }
}

@Test func testFractionUnitsDivideByTheContentBox() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildPinboard(units: "fraction")
        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 55, y: 55), translation: CGSize(width: 10, height: 0))
        // Raw (20 + 80, 30 + 70) = (100, 100); grid 8 snaps 12.5 → 13 → 104;
        // fraction of the 400pt content box = 0.26.
        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 125, y: 125), translation: CGSize(width: 80, height: 70))
        h.dnd.dragEnded(sourceId: "n1")
        #expect(h.payload(0)["x"] as? Double == 0.26)
        #expect(h.payload(0)["y"] as? Double == 0.26)
    }
}

@Test func testRePinOfAPositionedNoteStartsFromItsRenderedRect() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildPinboard()
        // The host pinned the note at (120, 88): its engine translate. The
        // measured frame is the LAYOUT rect (20, 30) — SwiftUI's `offset`
        // is invisible to the anchor outside it — so the rendered top-left
        // is (140, 118). No render happened, so the coordinator reads the
        // lowered props directly.
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "n1", name: "translateX.0", value: 120),
            Patch(type: .setProp, id: "n1", name: "translateY.0", value: 88),
        ])
        #expect(h.dnd.frames["n1"] == CGRect(x: 20, y: 30, width: 50, height: 50))

        // Drag it by (16, 16): raw (156, 134) → grid 8 → (160, 136).
        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 165, y: 143), translation: CGSize(width: 10, height: 0))
        #expect(h.dnd.phase == .dragging)
        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 171, y: 159), translation: CGSize(width: 16, height: 16))
        h.dnd.dragEnded(sourceId: "n1")
        #expect(h.actions == [HypenDnd.pinAction, "pinned", "ended"])
        let pin = h.payload(0)
        #expect(pin["path"] as? String == "__dnd.board.n1")
        #expect(pin["x"] as? Double == 160)
        #expect(pin["y"] as? Double == 136)
        #expect(h.payload(1)["x"] as? Double == 160)
        #expect(h.payload(1)["y"] as? Double == 136)
        // The ghost offset composes over the engine translate (it is applied
        // outside it): rendered (140, 118) + (20, 18) = the resolved spot.
        #expect(h.element("n1")?.dndGhostOffset == CGSize(width: 20, height: 18))

        // A translate SetProp is the re-render: release, and the ghost goes.
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "n1", name: "translateX.0", value: 160),
            Patch(type: .setProp, id: "n1", name: "translateY.0", value: 136),
        ])
        #expect(h.dnd.phase == .idle)
        #expect(h.element("n1")?.dndGhostOffset == .zero)
    }
}

@Test func testRePinReadsTheRenderedTranslateWhenTheNodeHasBeenRendered() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildPinboard()
        h.renderer.applyPatches([
            Patch(type: .setProp, id: "n1", name: "translateX.0", value: 120),
            Patch(type: .setProp, id: "n1", name: "translateY.0", value: 88),
        ])
        // Render once through the registry so the memoized result exists —
        // the coordinator prefers it (it is what is on screen).
        let note = h.element("n1")!
        let registry = ApplicatorRegistry.withDefaults()
        let context = ApplicatorContext(element: note, actionDispatcher: h.dispatcher)
        _ = registry.applyAllWithVariants(element: note, context: context)
        #expect(note.cachedApplicatorResult?.baseModifier.translateX == 120)

        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 165, y: 143), translation: CGSize(width: 10, height: 0))
        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 171, y: 159), translation: CGSize(width: 16, height: 16))
        h.dnd.dragEnded(sourceId: "n1")
        #expect(h.payload(0)["x"] as? Double == 160)
        #expect(h.payload(0)["y"] as? Double == 136)
    }
}

@Test func testATranslatedZoneIsHitWhereItIsDrawn() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        // A trash zone laid out at (300, 0) but translated 200pt down: it is
        // drawn at (300, 200) and must be hit there, not at its layout spot.
        h.renderer.applyPatches([
            Patch(type: .create, id: "bin", elementType: "row", props: [
                HypenDnd.zoneProp: ["group": NSNull(), "band": 0.5] as [String: Any],
                HypenDnd.zoneIdProp: "trash",
                "onDrop.0": "@binned",
                "translateY.0": 200,
            ]),
            Patch(type: .insert, id: "bin", parentId: "root"),
        ])
        var frames = h.dnd.frames
        frames["bin"] = CGRect(x: 300, y: 0, width: 100, height: 100)
        h.dnd.updateFrames(frames)

        // Over the layout spot: nothing is drawn there, so it is not a
        // target — the drop cancels.
        h.liftT1(to: CGPoint(x: 350, y: 50))
        #expect(h.dnd.phase == .dragging)
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.actions == ["started", "ended"])
        #expect(h.payload(1)["dropped"] as? Bool == false)

        // Over the drawn spot: the zone.
        h.dispatcher.clear()
        h.liftT1(to: CGPoint(x: 350, y: 250))
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.actions == ["started", "binned", "ended"])
        #expect(location(h.payload(1), "to").zone == "trash")
    }
}

// MARK: - Hosts

@Test func testEachHostDeclaresItsOwnCoordinateSpace() async {
    await MainActor.run {
        let outer = HypenRenderer()
        let embedded = HypenRenderer()
        // A nested embedded app must not alias its parent host's space —
        // the name carries the coordinator's identity.
        #expect(outer.dnd.coordinateSpaceName != embedded.dnd.coordinateSpaceName)
        #expect(outer.dnd.coordinateSpaceName.hasPrefix(HypenDnd.coordinateSpaceName + "."))
        // Stable for the coordinator's lifetime: the gesture and the host
        // resolve against the same name across body re-evaluations.
        #expect(outer.dnd.coordinateSpaceName == outer.dnd.coordinateSpaceName)
    }
}

// MARK: - Poses (§2.1) and the null-translate rule (§3)

@Test func testRuntimeLabelOverlaysThePoseAndClearingRestoresTheBase() async {
    await MainActor.run {
        let h = DndHarness()
        h.renderer.applyPatches([
            Patch(type: .create, id: "card", elementType: "card", props: [
                "opacity.0": 1,
                HypenDnd.sourceProp: DndHarness.sourceSpec(),
                HypenAnim.statesProp: ["label": NSNull(), "runtime": true] as [String: Any],
                HypenDnd.statePosesProp: [
                    "lifted": ["opacity.0": 0.6, "scale.0": 1.04] as [String: Any],
                    "over": ["backgroundColor.0": "#eee", "padding@md.0": 4] as [String: Any],
                ] as [String: Any],
                HypenAnim.transitionProp: [
                    "curve": "easeOut", "duration": 250, "props": ["opacity", "scale", "backgroundColor"],
                ] as [String: Any],
            ]),
        ])
        let card = h.element("card")!
        let registry = ApplicatorRegistry.withDefaults()
        let context = ApplicatorContext(element: card, actionDispatcher: h.dispatcher)
        let base = registry.applyAllWithVariants(element: card, context: context)
        #expect(base.baseModifier.opacity == 1)
        #expect(base.baseModifier.scaleX == 1)

        // No label: the base passes through untouched.
        let plain = h.dnd.overlayingPose(onto: base, element: card, registry: registry, context: context)
        #expect(plain.baseModifier.opacity == 1)

        card.dndPoseLabel = HypenDnd.labelLifted
        let lifted = h.dnd.overlayingPose(onto: base, element: card, registry: registry, context: context)
        #expect(lifted.baseModifier.opacity == 0.6)
        #expect(lifted.baseModifier.scaleX == 1.04)
        #expect(lifted.baseModifier.scaleY == 1.04)
        // The element's own props are the untouched base.
        #expect(card.props["opacity.0"] as? Int == 1)
        #expect(card.props["scale.0"] == nil)

        // A variant-qualified pose key is skipped; the rest of the pose applies.
        card.dndPoseLabel = HypenDnd.labelOver
        let over = h.dnd.overlayingPose(onto: base, element: card, registry: registry, context: context)
        #expect(over.baseModifier.backgroundColor != nil)
        #expect(over.baseModifier.paddingTop == 0)
        #expect(over.baseModifier.opacity == 1)

        // The label switch rides the synthesized transition (reduced motion off here).
        h.dnd.reducedMotionOverride = false
        #expect(h.dnd.poseAnimation(for: card) == Animation.easeOut(duration: 0.25))
        h.dnd.reducedMotionOverride = true
        #expect(h.dnd.poseAnimation(for: card) == nil)

        card.dndPoseLabel = nil
        let restored = h.dnd.overlayingPose(onto: base, element: card, registry: registry, context: context)
        #expect(restored.baseModifier.opacity == 1)
        #expect(restored.baseModifier.backgroundColor == nil)

        // The `__anim.states` runtime marker carries no label for the animator.
        #expect(card.animSpecs.statesLabel == nil)
    }
}

@Test func testNullTranslateReadsAsZero() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildPinboard()
        let note = h.element("n1")!
        let registry = ApplicatorRegistry.withDefaults()
        let context = ApplicatorContext(element: note, actionDispatcher: h.dispatcher)

        // Present with explicit null on Create (§3): treated as 0.
        #expect(note.props["translateX.0"] is NSNull)
        let unpinned = registry.applyAllWithVariants(element: note, context: context)
        #expect(unpinned.baseModifier.translateX == 0)
        #expect(unpinned.baseModifier.translateY == 0)

        h.renderer.applyPatches([
            Patch(type: .setProp, id: "n1", name: "translateX.0", value: 120),
            Patch(type: .setProp, id: "n1", name: "translateY.0", value: 80),
        ])
        let pinned = registry.applyAllWithVariants(element: note, context: context)
        #expect(pinned.baseModifier.translateX == 120)
        #expect(pinned.baseModifier.translateY == 80)
    }
}

@Test func testRelevanceGatesTheViewLayerToRolesAndRows() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.renderer.applyPatches([
            Patch(type: .create, id: "plain", elementType: "text"),
            Patch(type: .insert, id: "plain", parentId: "root"),
        ])
        #expect(h.dnd.isRelevant(h.element("list")!))
        #expect(h.dnd.isRelevant(h.element("r1")!))   // a row of the sortable
        #expect(h.dnd.isRelevant(h.element("t1")!))   // the source
        #expect(!h.dnd.isRelevant(h.element("plain")!))
        #expect(!h.dnd.isRelevant(h.element("root")!))
    }
}

@Test func testClearResetsAnInFlightDragSilently() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.liftT1(to: CGPoint(x: 60, y: 260))
        h.renderer.clear()
        #expect(h.dnd.phase == .idle)
        #expect(h.actions == ["started"])
        #expect(h.dnd.frames.isEmpty)
    }
}

// MARK: - Regressions (Stage C review)

/// `onDragOver.dwell` follows the warn-and-degrade rule of every other
/// renderer: a number or a numeric string (a Remote UI host passing raw
/// JSON through) is honoured; a negative, non-finite or non-numeric value
/// warns and falls back to the default (`nil` here). `dwell` is reserved on
/// `.onDragOver` only — elsewhere it is an ordinary named argument.
@Test func testOnDragOverDwellAcceptsNumericStringsAndRejectsMalformedValues() {
    let asString = DndEventBinding.from(
        props: ["onDragOver.0": "@peek", "onDragOver.dwell": "200"], name: "onDragOver"
    )
    #expect(asString?.dwellMs == 200)
    #expect(asString?.customPayload["dwell"] == nil)

    let malformed: [Any] = [-1, "soon", true, NSNull(), Double.infinity, [200]]
    for bad in malformed {
        let binding = DndEventBinding.from(
            props: ["onDragOver.0": "@peek", "onDragOver.dwell": bad], name: "onDragOver"
        )
        #expect(binding?.actionName == "peek")
        #expect(binding?.dwellMs == nil)
        // Still stripped from the dispatched payload.
        #expect(binding?.customPayload["dwell"] == nil)
    }

    #expect(HypenDnd.parseDwellMs(0) == 0)
    #expect(HypenDnd.parseDwellMs(" 250 ") == 250)
    #expect(HypenDnd.parseDwellMs("-5") == nil)
    #expect(HypenDnd.parseDwellMs(nil) == nil)

    let sort = DndEventBinding.from(props: ["onSort.0": "@reorder", "onSort.dwell": 5], name: "onSort")
    #expect(sort?.dwellMs == nil)
    #expect(sort?.customPayload["dwell"] as? Int == 5)
}

@Test func testFillUnmeasuredBorrowsTheNextSlotAndExtendsTheTail() {
    let a = CGRect(x: 0, y: 0, width: 200, height: 90)
    let b = CGRect(x: 0, y: 100, width: 200, height: 90)
    // An inserted row above `b` takes the slot `b` is about to leave.
    #expect(DndGeometry.fillUnmeasured([a, nil, b], axis: .y, gap: 10) == [a, b, b])
    // Appended rows step past the last measured rect, one slot each.
    #expect(DndGeometry.fillUnmeasured([a, b, nil, nil], axis: .y, gap: 10) == [
        a, b, CGRect(x: 0, y: 200, width: 200, height: 90), CGRect(x: 0, y: 300, width: 200, height: 90),
    ])
    #expect(DndGeometry.fillUnmeasured([a, nil], axis: .x, gap: 4) == [a, CGRect(x: 204, y: 0, width: 200, height: 90)])
    // Nothing measured: every slot is zero.
    #expect(DndGeometry.fillUnmeasured([nil, nil], axis: .y, gap: 10) == [.zero, .zero])
    #expect(DndGeometry.fillUnmeasured([], axis: .y, gap: 10).isEmpty)
}

/// §6.11: `to.zone` for a foreign compatible pinboard hit as a plain "into"
/// target follows the sortable rule — group → resolved `id` → node id — on
/// every renderer, not the `.dropZone` rule.
@Test func testAForeignPinboardHitAsAnIntoTargetReportsItsGroup() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildPinboard()
        // A second board of the same group beside the first. It carries an
        // `id` prop too: the group must win over it.
        h.renderer.applyPatches([
            Patch(type: .create, id: "board2", elementType: "stack", props: [
                HypenDnd.pinProp: [
                    "group": "board", "xKey": "x", "yKey": "y",
                    "grid": NSNull(), "bounds": "clamp", "units": "px",
                ] as [String: Any],
                "id.0": "inbox",
                "onDrop.0": "@dropped",
            ]),
            Patch(type: .insert, id: "board2", parentId: "root"),
        ])
        var frames = h.dnd.frames
        frames["board2"] = CGRect(x: 400, y: 0, width: 400, height: 400)
        h.dnd.updateFrames(frames)

        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 55, y: 55), translation: CGSize(width: 10, height: 0))
        #expect(h.dnd.phase == .dragging)
        h.dnd.dragChanged(sourceId: "n1", location: CGPoint(x: 500, y: 100), translation: CGSize(width: 455, height: 45))

        h.dnd.dragEnded(sourceId: "n1")
        // A foreign board is a plain "into" zone: no reserved write, then
        // `.onDrop` on it, then `.onDragEnd`.
        #expect(h.actions == ["dropped", "ended"])
        let dropped = h.payload(0)
        #expect(location(dropped, "from").zone == "board")
        #expect(location(dropped, "from").index as? Int == 0)
        #expect(location(dropped, "to").zone == "board")
        #expect((location(dropped, "to").index as? NSNull) != nil)
        #expect(location(h.payload(1), "to").zone == "board")
        #expect(h.payload(1)["dropped"] as? Bool == true)
    }
}

/// A spring-loaded folder inserting rows under the ORIGIN mid-drag: the
/// origin list is rebuilt (not frozen at lift), so the reserved write's
/// `from` and the preview slots track the engine's array — the row that
/// moves is the dragged one, not whichever row now sits at the lift index.
@Test func testAnInsertUnderTheOriginMidDragRetargetsTheReorderWrite() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()

        // Lift the LAST row (t3 / r3, index 2) and park it above the first.
        h.dnd.dragChanged(sourceId: "t3", location: CGPoint(x: 60, y: 235), translation: CGSize(width: 0, height: 10))
        #expect(h.dnd.phase == .dragging)
        h.dnd.dragChanged(sourceId: "t3", location: CGPoint(x: 60, y: 40), translation: CGSize(width: 0, height: -195))
        #expect(h.actions == ["started"])
        #expect(location(h.payload(0), "from").index as? Int == 2)
        #expect(h.element("r1")?.dndShift == CGSize(width: 0, height: 100))
        #expect(h.element("r2")?.dndShift == CGSize(width: 0, height: 100))

        // The engine inserts a new draggable row at the top (top-down: the
        // row first, then the source under it), before layout has measured it.
        h.renderer.applyPatches([
            Patch(type: .create, id: "r0", elementType: "row"),
            Patch(type: .insert, id: "r0", parentId: "list", beforeId: "r1"),
            Patch(type: .create, id: "t0", elementType: "text", props: [
                HypenDnd.keyProp: "t0",
                HypenDnd.sourceProp: DndHarness.sourceSpec(),
            ]),
            Patch(type: .insert, id: "t0", parentId: "r0"),
        ])
        #expect(h.dnd.phase == .dragging)
        // The new row is a live slot at once: it opens the gap with the rest.
        #expect(h.element("r0")?.dndShift == CGSize(width: 0, height: 100))
        #expect(h.element("r1")?.dndShift == CGSize(width: 0, height: 100))
        #expect(h.element("r2")?.dndShift == CGSize(width: 0, height: 100))

        // Layout settles: every row is one slot lower, r0 measured for the
        // first time. The preview stays at slot 0.
        var frames = h.dnd.frames
        for (i, row) in ["r0", "r1", "r2", "r3"].enumerated() {
            frames[row] = CGRect(x: 0, y: CGFloat(i) * 100, width: 200, height: 90)
        }
        frames["t0"] = CGRect(x: 10, y: 10, width: 100, height: 30)
        h.dnd.updateFrames(frames)
        #expect(h.element("r0")?.dndShift == CGSize(width: 0, height: 100))
        #expect(h.element("r1")?.dndShift == CGSize(width: 0, height: 100))
        #expect(h.element("r2")?.dndShift == CGSize(width: 0, height: 100))
        #expect(h.actions == ["started"])

        h.dnd.dragEnded(sourceId: "t3")
        #expect(h.actions == ["started", HypenDnd.reorderAction, "reorder", "ended"])
        let reorder = h.payload(1)
        #expect(reorder["path"] as? String == "tasks")
        // The dragged row now lives at index 3 in the engine's array.
        #expect(reorder["from"] as? Int == 3)
        #expect(reorder["to"] as? Int == 0)
        // The event payload keeps the lift-time `from` (DOM parity).
        let sort = h.payload(2)
        #expect(sort["item"] as? String == "t3")
        #expect(location(sort, "from").index as? Int == 2)
        #expect(location(sort, "to").index as? Int == 0)
    }
}

/// A `Remove` of a row ABOVE the dragged one mid-drag (the hook runs while
/// the subtree is still linked): the origin list drops it and `from` moves
/// up by one.
@Test func testARemoveAboveTheDraggedRowMidDragShiftsTheReorderFrom() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable()
        h.dnd.dragChanged(sourceId: "t3", location: CGPoint(x: 60, y: 235), translation: CGSize(width: 0, height: 10))
        h.dnd.dragChanged(sourceId: "t3", location: CGPoint(x: 60, y: 40), translation: CGSize(width: 0, height: -195))
        #expect(h.element("r1")?.dndShift == CGSize(width: 0, height: 100))

        h.renderer.applyPatches([Patch(type: .remove, id: "r1")])
        #expect(h.dnd.phase == .dragging)
        #expect(h.element("r1") == nil)
        // The surviving row still holds the gap open at slot 0.
        #expect(h.element("r2")?.dndShift == CGSize(width: 0, height: 100))

        h.dnd.dragEnded(sourceId: "t3")
        #expect(h.actions == ["started", HypenDnd.reorderAction, "reorder", "ended"])
        #expect(h.payload(1)["from"] as? Int == 1)
        #expect(h.payload(1)["to"] as? Int == 0)
    }
}

/// The pre-fix behaviour, pinned: a structural change under a FOREIGN
/// cached list still refreshes it (the new row becomes a live slot on the
/// spot), and the hold-phase release rule is untouched.
@Test func testAnInsertUnderAForeignListMidDragMakesTheRowALiveSlot() async {
    await MainActor.run {
        let h = DndHarness()
        h.buildSortable(listExtra: [HypenDnd.sortProp: ["group": "kanban", "axis": "y"] as [String: Any]])
        h.renderer.applyPatches([
            Patch(type: .create, id: "done", elementType: "column", props: [
                HypenDnd.sortProp: ["group": "kanban", "axis": "y"] as [String: Any],
                "bind": "done",
                "onSort.0": "@sortedDone",
            ]),
            Patch(type: .insert, id: "done", parentId: "root"),
        ])
        var frames = h.dnd.frames
        frames["done"] = CGRect(x: 200, y: 0, width: 200, height: 300)
        h.dnd.updateFrames(frames)

        // Hover the empty foreign list, then the engine fills it with a row.
        h.liftT1(to: CGPoint(x: 300, y: 250))
        h.renderer.applyPatches([
            Patch(type: .create, id: "d1", elementType: "row"),
            Patch(type: .insert, id: "d1", parentId: "done"),
            Patch(type: .create, id: "s1", elementType: "text", props: [
                HypenDnd.keyProp: "s1",
                HypenDnd.sourceProp: DndHarness.sourceSpec(),
            ]),
            Patch(type: .insert, id: "s1", parentId: "d1"),
        ])
        frames = h.dnd.frames
        frames["d1"] = CGRect(x: 200, y: 0, width: 200, height: 90)
        frames["s1"] = CGRect(x: 210, y: 10, width: 100, height: 30)
        h.dnd.updateFrames(frames)

        // The pointer at y=250 is past the new row's midpoint: slot 1, and
        // the row is not shifted (the gap opens below it).
        #expect(h.element("d1")?.dndShift == .zero)
        h.dnd.dragEnded(sourceId: "t1")
        #expect(h.actions == ["started", HypenDnd.reorderAction, "sortedDone", "ended"])
        #expect(h.payload(1)["fromPath"] as? String == "tasks")
        #expect(h.payload(1)["from"] as? Int == 0)
        #expect(h.payload(1)["toPath"] as? String == "done")
        #expect(h.payload(1)["to"] as? Int == 1)
    }
}

@Test @MainActor func testFractionalPinsProjectAndResizeWithoutDispatch() {
    let h = DndHarness()
    h.buildPinboard(units: "fraction")
    h.renderer.applyPatches([
        Patch(type: .setProp, id: "n1", name: "__dnd.pinX", value: 0.5),
        Patch(type: .setProp, id: "n1", name: "__dnd.pinY", value: 0.25),
    ])
    #expect(h.element("n1")?.dndPinOffset == CGSize(width: 200, height: 100))
    var frames = h.dnd.frames
    frames["board"] = CGRect(x: 0, y: 0, width: 600, height: 200)
    h.dnd.updateFrames(frames)
    #expect(h.element("n1")?.dndPinOffset == CGSize(width: 300, height: 50))
    #expect(h.actions.isEmpty)
}
