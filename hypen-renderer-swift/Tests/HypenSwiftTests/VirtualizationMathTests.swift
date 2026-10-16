import XCTest
@testable import HypenSwift

/// The renderer-side window math from hypen-web/docs/virtualization.md.
/// Mirrors hypen-web/tests/virtualization-math.test.ts case for case (the
/// reference every native port aligns with; Android's VirtualizationMathTest
/// carries the same cases), plus the slot mapping, wire message and viewport
/// tracker used by the lazy containers.
final class VirtualizationMathTests: XCTestCase {
    typealias V = Virtualization

    // MARK: parseVirtWindow

    func testParseDecodesTheEnginesProp() {
        XCTAssertEqual(V.parseVirtWindow(["total": 100, "start": 10, "end": 40]),
                       VirtWindow(total: 100, start: 10, end: 40))
        XCTAssertEqual(V.parseVirtWindow(["total": 5, "start": 0, "end": 2, "estimatedSize": 48]),
                       VirtWindow(total: 5, start: 0, end: 2, estimatedSize: 48))
    }

    func testParseDecodesJSONSerializationValues() throws {
        let json = #"{"total":100,"start":10,"end":40,"estimatedSize":32.5}"#
        let value = try JSONSerialization.jsonObject(with: Data(json.utf8))
        XCTAssertEqual(V.parseVirtWindow(value),
                       VirtWindow(total: 100, start: 10, end: 40, estimatedSize: 32.5))
        let boolJSON = #"{"total":true,"start":0,"end":1}"#
        XCTAssertNil(V.parseVirtWindow(try JSONSerialization.jsonObject(with: Data(boolJSON.utf8))))
    }

    func testParseRejectsMalformedValues() {
        XCTAssertNil(V.parseVirtWindow(nil))
        XCTAssertNil(V.parseVirtWindow(NSNull()))
        XCTAssertNil(V.parseVirtWindow(["total": 10, "start": 5, "end": 3]))
        XCTAssertNil(V.parseVirtWindow(["total": 10, "start": 0, "end": 11]))
        XCTAssertNil(V.parseVirtWindow(["total": 10, "start": -1, "end": 3]))
        XCTAssertNil(V.parseVirtWindow(["total": "10", "start": 0, "end": 3]))
        XCTAssertNil(V.parseVirtWindow(["total": 10, "start": 0.5, "end": 3]))
    }

    func testParseIgnoresNonPositiveEstimate() {
        XCTAssertNil(V.parseVirtWindow(["total": 5, "start": 0, "end": 2, "estimatedSize": 0])?.estimatedSize)
        XCTAssertNil(V.parseVirtWindow(["total": 5, "start": 0, "end": 2, "estimatedSize": "48"])?.estimatedSize)
    }

    // MARK: itemSize

    func testItemSizePrefersTheMeasuredAverage() {
        let w = VirtWindow(total: 100, start: 0, end: 10, estimatedSize: 30)
        XCTAssertEqual(V.itemSize(w, measuredTotal: 500, measuredCount: 10), 50)
    }

    func testItemSizeFallsBackToTheEstimateThenTheDefault() {
        XCTAssertEqual(V.itemSize(VirtWindow(total: 100, start: 0, end: 10, estimatedSize: 30),
                                  measuredTotal: 0, measuredCount: 0), 30)
        XCTAssertEqual(V.itemSize(VirtWindow(total: 100, start: 0, end: 10),
                                  measuredTotal: 0, measuredCount: 0), V.defaultItemSize)
        XCTAssertEqual(V.defaultItemSize, 48)
    }

    // MARK: windowPadding

    func testPaddingStandsInForTheItemsOutsideTheWindow() {
        let p = V.windowPadding(VirtWindow(total: 100, start: 40, end: 70), size: 10)
        XCTAssertEqual(p.leading, 400)
        XCTAssertEqual(p.trailing, 300)
    }

    func testPaddingIsZeroWhenTheWindowCoversEverything() {
        let p = V.windowPadding(VirtWindow(total: 5, start: 0, end: 5), size: 10)
        XCTAssertEqual(p.leading, 0)
        XCTAssertEqual(p.trailing, 0)
    }

    func testPaddingCountsGridRows() {
        // 3 columns: items 0..8 are rows 0..2; window 9..18 is rows 3..5; 30 items = 10 rows.
        let p = V.windowPadding(VirtWindow(total: 30, start: 9, end: 18), size: 100, columns: 3)
        XCTAssertEqual(p.leading, 300)
        XCTAssertEqual(p.trailing, 400)
    }

    // MARK: windowRows

    func testWindowRowsIsTheItemCountForAList() {
        XCTAssertEqual(V.windowRows(VirtWindow(total: 100, start: 40, end: 70)), 30)
    }

    func testWindowRowsCountsEveryGridRowTheWindowTouches() {
        XCTAssertEqual(V.windowRows(VirtWindow(total: 30, start: 9, end: 18), columns: 3), 3)
        XCTAssertEqual(V.windowRows(VirtWindow(total: 30, start: 10, end: 17), columns: 3), 3)
    }

    // MARK: childrenPerItem

    func testChildrenPerItemGroupsAMultiNodeTemplatesChildren() {
        XCTAssertEqual(V.childrenPerItem(VirtWindow(total: 100, start: 10, end: 20), childCount: 10), 1)
        XCTAssertEqual(V.childrenPerItem(VirtWindow(total: 100, start: 10, end: 20), childCount: 30), 3)
    }

    func testChildrenPerItemIsAtLeastOne() {
        XCTAssertEqual(V.childrenPerItem(VirtWindow(total: 100, start: 10, end: 10), childCount: 0), 1)
        XCTAssertEqual(V.childrenPerItem(VirtWindow(total: 100, start: 10, end: 20), childCount: 0), 1)
    }

    // MARK: visibleRange

    func testVisibleRangeMapsTheScrollOffsetToItems() {
        XCTAssertEqual(V.visibleRange(total: 1000, size: 50, scrolledPast: 500, viewportExtent: 200),
                       ItemRange(start: 10, end: 14))
    }

    func testVisibleRangeClampsToTheList() {
        XCTAssertEqual(V.visibleRange(total: 12, size: 50, scrolledPast: 500, viewportExtent: 200),
                       ItemRange(start: 10, end: 12))
        XCTAssertEqual(V.visibleRange(total: 100, size: 50, scrolledPast: -300, viewportExtent: 200),
                       ItemRange(start: 0, end: 4))
    }

    func testVisibleRangeCountsGridRows() {
        XCTAssertEqual(V.visibleRange(total: 90, size: 100, scrolledPast: 300, viewportExtent: 200, columns: 3),
                       ItemRange(start: 9, end: 15))
    }

    // MARK: wantedRange

    func testWantedRangeAddsAViewportOfOverscanOnEachSide() {
        XCTAssertEqual(V.wantedRange(ItemRange(start: 40, end: 60), total: 1000), ItemRange(start: 20, end: 80))
    }

    func testWantedRangeOverscansAtLeastFiveItems() {
        XCTAssertEqual(V.wantedRange(ItemRange(start: 40, end: 42), total: 1000), ItemRange(start: 35, end: 47))
    }

    func testWantedRangeClampsToTheList() {
        XCTAssertEqual(V.wantedRange(ItemRange(start: 2, end: 10), total: 12), ItemRange(start: 0, end: 12))
    }

    // MARK: shouldReport

    private let window = VirtWindow(total: 1000, start: 20, end: 80)

    func testShouldNotReportWhileTheVisibleRangeIsCovered() {
        XCTAssertFalse(V.shouldReport(window, visible: ItemRange(start: 40, end: 60),
                                      wanted: ItemRange(start: 20, end: 80), lastReported: nil))
    }

    func testShouldReportWhenTheVisibleRangeLeavesTheWindow() {
        XCTAssertTrue(V.shouldReport(window, visible: ItemRange(start: 70, end: 90),
                                     wanted: ItemRange(start: 50, end: 110), lastReported: nil))
    }

    func testShouldReportWhenTheWindowIsFarLargerThanNeeded() {
        let wide = VirtWindow(total: 1000, start: 0, end: 500)
        XCTAssertTrue(V.shouldReport(wide, visible: ItemRange(start: 100, end: 110),
                                     wanted: ItemRange(start: 90, end: 120), lastReported: nil))
    }

    func testShouldNeverReportTheSameRangeTwice() {
        let wanted = ItemRange(start: 50, end: 110)
        XCTAssertFalse(V.shouldReport(window, visible: ItemRange(start: 70, end: 90),
                                      wanted: wanted, lastReported: wanted))
    }

    // MARK: viewportReport

    private let top = VirtWindow(total: 1000, start: 0, end: 20)

    func testViewportReportNothingWhileTheWindowCoversTheVisibleRange() {
        XCTAssertNil(V.viewportReport(top, geometry: ViewportGeometry(size: 50, scrolledPast: 0, viewportExtent: 500),
                                      lastReported: nil))
    }

    func testViewportReportTheOverscannedRangeOnceTheUserScrollsPastTheWindow() {
        let geometry = ViewportGeometry(size: 50, scrolledPast: 2000, viewportExtent: 500)
        // visible [40,50) → one viewport (10 items) of overscan each side.
        XCTAssertEqual(V.viewportReport(top, geometry: geometry, lastReported: nil), ItemRange(start: 30, end: 60))
        XCTAssertNil(V.viewportReport(top, geometry: geometry, lastReported: ItemRange(start: 30, end: 60)))
    }

    func testViewportReportCountsOnlyThePartOfTheViewportOverAListThatStartsBelowItsTop() {
        let short = VirtWindow(total: 1000, start: 0, end: 2)
        // The list starts 100pt down a 300pt viewport: 200pt (4 items) of it shows.
        XCTAssertEqual(V.viewportReport(short, geometry: ViewportGeometry(size: 50, scrolledPast: -100, viewportExtent: 300),
                                        lastReported: nil),
                       ItemRange(start: 0, end: 9))
        // Entirely below the viewport: nothing is visible, nothing to report.
        XCTAssertNil(V.viewportReport(short, geometry: ViewportGeometry(size: 50, scrolledPast: -400, viewportExtent: 300),
                                      lastReported: nil))
    }

    func testViewportReportGridsReportWholeRows() {
        let grid = VirtWindow(total: 90, start: 0, end: 9)
        XCTAssertEqual(V.viewportReport(grid, geometry: ViewportGeometry(size: 100, scrolledPast: 300, viewportExtent: 200, columns: 3),
                                        lastReported: nil),
                       ItemRange(start: 3, end: 21))
    }

    // MARK: Slot mapping (§5)

    func testSlotsDeclareTotalWithItemsInsideTheWindow() {
        let w = VirtWindow(total: 6, start: 2, end: 4)
        let slots = Array(V.slots(w, childIds: ["a", "b"]))
        XCTAssertEqual(slots, [
            .placeholder(index: 0),
            .placeholder(index: 1),
            .item(index: 2, childIds: ["a"]),
            .item(index: 3, childIds: ["b"]),
            .placeholder(index: 4),
            .placeholder(index: 5),
        ])
        XCTAssertEqual(slots.map(\.index), Array(0..<6))
    }

    func testSlotsGroupMultiNodeTemplates() {
        let w = VirtWindow(total: 4, start: 1, end: 3)
        XCTAssertEqual(V.childrenPerItem(w, childCount: 6), 3)
        XCTAssertEqual(Array(V.slots(w, childIds: ["a1", "a2", "a3", "b1", "b2", "b3"])), [
            .placeholder(index: 0),
            .item(index: 1, childIds: ["a1", "a2", "a3"]),
            .item(index: 2, childIds: ["b1", "b2", "b3"]),
            .placeholder(index: 3),
        ])
    }

    func testSlotsLeaveMissingChildrenAsPlaceholders() {
        // A window of 3 items with only 2 children (a batch still settling).
        let w = VirtWindow(total: 5, start: 1, end: 4)
        XCTAssertEqual(Array(V.slots(w, childIds: ["a", "b"])), [
            .placeholder(index: 0),
            .item(index: 1, childIds: ["a"]),
            .item(index: 2, childIds: ["b"]),
            .placeholder(index: 3),
            .placeholder(index: 4),
        ])
    }

    func testSlotsForAnEmptyWindowAreAllPlaceholders() {
        let w = VirtWindow(total: 3, start: 0, end: 0)
        XCTAssertEqual(V.childrenPerItem(w, childCount: 0), 1)
        XCTAssertEqual(Array(V.slots(w, childIds: [])), [.placeholder(index: 0), .placeholder(index: 1), .placeholder(index: 2)])
        XCTAssertTrue(V.slots(VirtWindow(total: 0, start: 0, end: 0), childIds: []).isEmpty)
    }

    func testSlotIdsAreTheItemIndexAcrossMaterialization() {
        // scrollPosition(id:) anchors on the slot id: it must not change when
        // the engine materializes the item.
        let row = Virtualization.Slot.item(index: 7, childIds: ["42", "43"])
        let placeholder = Virtualization.Slot.placeholder(index: 7)
        XCTAssertEqual(row.id, "i:7")
        XCTAssertEqual(placeholder.id, row.id)
        XCTAssertEqual(V.slotId(7), "i:7")
        // The content inside the slot is keyed by node (row) or index.
        XCTAssertEqual(row.contentId, "n:42")
        XCTAssertEqual(row.nodeId, "42")
        XCTAssertEqual(placeholder.contentId, "p:7")
        XCTAssertNil(placeholder.nodeId)
    }

    func testSlotIdsAreUniqueAcrossTheList() {
        let w = VirtWindow(total: 50, start: 10, end: 20)
        let slots = V.slots(w, childIds: (10..<20).map { "n\($0)" })
        XCTAssertEqual(Set(slots.map(\.id)).count, 50)
        XCTAssertEqual(Set(slots.map(\.contentId)).count, 50)
    }

    func testSlotsFindAnItemByItsFirstNode() {
        let w = VirtWindow(total: 10, start: 4, end: 6)
        let slots = V.slots(w, childIds: ["a1", "a2", "b1", "b2"])
        XCTAssertEqual(slots.itemIndex(ofNode: "a1"), 4)
        XCTAssertEqual(slots.itemIndex(ofNode: "b1"), 5)
        XCTAssertNil(slots.itemIndex(ofNode: "b2"), "not an item's first child")
        XCTAssertNil(slots.itemIndex(ofNode: "zz"))
    }

    // MARK: Remote message (§4)

    func testViewportMessageShape() throws {
        let message = V.viewportMessage(listId: "4294967301", start: 40, end: 70)
        let data = try JSONSerialization.data(withJSONObject: message, options: [.sortedKeys])
        XCTAssertEqual(String(decoding: data, as: UTF8.self),
                       #"{"end":70,"listId":"4294967301","start":40,"type":"viewport"}"#)
        let clamped = V.viewportMessage(listId: "1", start: -3, end: Int(UInt32.max) + 10)
        XCTAssertEqual(clamped["start"] as? Int, 0)
        XCTAssertEqual(clamped["end"] as? Int, Int(UInt32.max))
    }

    // MARK: Viewport tracker

    func testTrackerReportsWhenTheVisibleSlotsLeaveTheWindow() {
        let tracker = VirtViewportTracker()
        let w = VirtWindow(total: 1000, start: 0, end: 30)
        XCTAssertNil(tracker.evaluate(w), "nothing on screen yet")
        for i in 0..<10 { tracker.slotAppeared(i) }
        XCTAssertNil(tracker.evaluate(w), "covered by the initial window")

        // Scroll to 40..50.
        for i in 0..<10 { tracker.slotDisappeared(i) }
        for i in 40..<50 { tracker.slotAppeared(i) }
        XCTAssertEqual(tracker.visibleRange(w), ItemRange(start: 40, end: 50))
        XCTAssertEqual(tracker.evaluate(w), ItemRange(start: 30, end: 60))
        XCTAssertNil(tracker.evaluate(w), "never the same range twice")
        XCTAssertEqual(tracker.lastReported, ItemRange(start: 30, end: 60))
    }

    func testTrackerCountsOverlappingAppearances() {
        // Placeholder → row swap: the row's onAppear can precede the
        // placeholder's onDisappear for the same index.
        let tracker = VirtViewportTracker()
        let ten = VirtWindow(total: 10, start: 0, end: 0)
        tracker.slotAppeared(5)
        tracker.slotAppeared(5)
        tracker.slotDisappeared(5)
        XCTAssertEqual(tracker.visibleRange(ten), ItemRange(start: 5, end: 6))
        tracker.slotDisappeared(5)
        XCTAssertNil(tracker.visibleRange(ten))
        tracker.slotDisappeared(5) // unbalanced: ignored
        XCTAssertNil(tracker.visibleRange(ten))
    }

    func testTrackerPrefersTheScrollGeometry() {
        let tracker = VirtViewportTracker()
        let w = VirtWindow(total: 1000, start: 0, end: 30, estimatedSize: 40)
        // Prefetched slots appear well past the screen...
        for i in 0..<20 { tracker.slotAppeared(i) }
        XCTAssertEqual(tracker.visibleRange(w), ItemRange(start: 0, end: 20))
        // ...the geometry says what is actually on screen: rows 40 + 10 apart.
        tracker.scrolled(offset: 500, extent: 200)
        XCTAssertEqual(tracker.visibleRange(w, spacing: 10), ItemRange(start: 10, end: 14))
        XCTAssertEqual(tracker.evaluate(w, spacing: 10), nil, "covered by the window")
        // A grid counts rows.
        XCTAssertEqual(tracker.visibleRange(w, spacing: 10, columns: 3), ItemRange(start: 30, end: 42))
        // An unlaid-out container (zero extent) is ignored.
        let fresh = VirtViewportTracker()
        fresh.slotAppeared(3)
        fresh.scrolled(offset: 0, extent: 0)
        XCTAssertEqual(fresh.visibleRange(w), ItemRange(start: 3, end: 4))
    }

    func testSlotsResolveOnDemand() {
        let slots = V.slots(VirtWindow(total: 10_000, start: 40, end: 42), childIds: ["a", "b"])
        XCTAssertEqual(slots.count, 10_000)
        XCTAssertEqual(slots[41], .item(index: 41, childIds: ["b"]))
        XCTAssertEqual(slots[9_999], .placeholder(index: 9_999))
    }

    func testTrackerItemSizeAveragesTheWindowsMeasurements() {
        let tracker = VirtViewportTracker()
        let w = VirtWindow(total: 100, start: 10, end: 20, estimatedSize: 30)
        XCTAssertEqual(tracker.itemSize(w), 30)
        tracker.recordSize(10, extent: 40)
        tracker.recordSize(11, extent: 60)
        tracker.recordSize(99, extent: 1000) // outside the window: dropped
        tracker.recordSize(12, extent: 0)    // unmeasured: ignored
        XCTAssertEqual(tracker.itemSize(w), 50)
    }

    // MARK: windowChanged (§3 step 4)

    func testWindowChangedTheFirstWindowIsAChange() {
        XCTAssertTrue(V.windowChanged(nil, VirtWindow(total: 1000, start: 30, end: 60)))
    }

    func testWindowChangedAnIdenticalResendIsNotAChange() {
        let w = VirtWindow(total: 1000, start: 30, end: 60)
        XCTAssertFalse(V.windowChanged(w, VirtWindow(total: 1000, start: 30, end: 60)))
        XCTAssertFalse(V.windowChanged(VirtWindow(total: 1000, start: 30, end: 60, estimatedSize: 40),
                                       VirtWindow(total: 1000, start: 30, end: 60, estimatedSize: 40)))
    }

    func testWindowChangedAnyFieldMovingIsAChangeTotalAloneIncluded() {
        let w = VirtWindow(total: 1000, start: 30, end: 60)
        XCTAssertTrue(V.windowChanged(w, VirtWindow(total: 1001, start: 30, end: 60)))
        XCTAssertTrue(V.windowChanged(w, VirtWindow(total: 1000, start: 31, end: 60)))
        XCTAssertTrue(V.windowChanged(w, VirtWindow(total: 1000, start: 30, end: 61)))
        XCTAssertTrue(V.windowChanged(w, VirtWindow(total: 1000, start: 30, end: 60, estimatedSize: 40)))
    }

    func testWindowChangedForgettingTheLastReportLetsTheSameRangeBeAskedAgain() {
        let geometry = ViewportGeometry(size: 50, scrolledPast: 2000, viewportExtent: 500)
        let before = VirtWindow(total: 1000, start: 0, end: 20)
        var last = V.viewportReport(before, geometry: geometry, lastReported: nil)
        XCTAssertEqual(last, ItemRange(start: 30, end: 60))
        // The engine moves the window on its own (total changed), still not covering.
        let after = VirtWindow(total: 1001, start: 0, end: 20)
        if V.windowChanged(before, after) { last = nil }
        XCTAssertEqual(V.viewportReport(after, geometry: geometry, lastReported: last), ItemRange(start: 30, end: 60))
    }

    func testTrackerDoesNotRepeatAReportAnsweredWithNoWindowChange() {
        let tracker = VirtViewportTracker()
        let w = VirtWindow(total: 1000, start: 0, end: 20, estimatedSize: 50)
        tracker.scrolled(offset: 2000, extent: 500)
        XCTAssertEqual(tracker.evaluate(w), ItemRange(start: 30, end: 60))
        // The engine answered with an identical re-send (the report moved
        // nothing): observing it must not reset, so no repeat.
        XCTAssertFalse(tracker.observe(VirtWindow(total: 1000, start: 0, end: 20, estimatedSize: 50)))
        XCTAssertNil(tracker.evaluate(w))
        XCTAssertNil(tracker.evaluate(w))
        XCTAssertEqual(tracker.lastReported, ItemRange(start: 30, end: 60))
    }

    func testTrackerForgetsTheLastReportWhenTheWindowChanges() {
        let tracker = VirtViewportTracker()
        let w = VirtWindow(total: 1000, start: 0, end: 20, estimatedSize: 50)
        tracker.scrolled(offset: 2000, extent: 500)
        XCTAssertEqual(tracker.evaluate(w), ItemRange(start: 30, end: 60))
        // The engine moves the window on its own (total changed) and it still
        // does not cover the visible range: the same range may be asked again.
        let moved = VirtWindow(total: 1001, start: 0, end: 20, estimatedSize: 50)
        XCTAssertTrue(tracker.observe(moved))
        XCTAssertNil(tracker.lastReported)
        XCTAssertEqual(tracker.evaluate(moved), ItemRange(start: 30, end: 60))
        XCTAssertNil(tracker.evaluate(moved), "at most once per window value")
        // evaluate() observes by itself too.
        XCTAssertEqual(tracker.evaluate(VirtWindow(total: 1002, start: 0, end: 20, estimatedSize: 50)),
                       ItemRange(start: 30, end: 60))
        XCTAssertEqual(tracker.lastWindow, VirtWindow(total: 1002, start: 0, end: 20, estimatedSize: 50))
    }

    // MARK: Tracker geometry (slot frames)

    func testTrackerPrefersSlotFramesInTheScrollContainer() {
        let tracker = VirtViewportTracker()
        let w = VirtWindow(total: 1000, start: 0, end: 30, estimatedSize: 40)
        // Prefetched slots appear well past the screen...
        for i in 0..<20 { tracker.slotAppeared(i) }
        // ...the list starts at the viewport top and the rows are taller than
        // the estimate, so the item-size math would say 0..15 for 600pt.
        tracker.listFrame(leading: 0, viewportExtent: 600)
        XCTAssertEqual(tracker.visibleRange(w), ItemRange(start: 0, end: 15))
        // Frames say rows 0..5 (100pt each) are on screen; 6..9 are prefetched below.
        for i in 0..<10 {
            tracker.slotFrame(id: "i:\(i)", index: i, min: Double(i) * 100, max: Double(i + 1) * 100)
        }
        XCTAssertEqual(tracker.visibleRange(w), ItemRange(start: 0, end: 6))
        // Scrolled 250pt: rows 2 (partly) ..8 (partly).
        tracker.listFrame(leading: -250, viewportExtent: 600)
        for i in 0..<10 {
            tracker.slotFrame(id: "i:\(i)", index: i, min: Double(i) * 100 - 250, max: Double(i + 1) * 100 - 250)
        }
        XCTAssertEqual(tracker.visibleRange(w), ItemRange(start: 2, end: 9))
        // A slot that left the container no longer counts.
        tracker.slotFrameRemoved(id: "i:8")
        XCTAssertEqual(tracker.visibleRange(w), ItemRange(start: 2, end: 8))
    }

    func testTrackerFallsBackToTheListGeometryWhenNoSlotIsOnScreen() {
        // A list below the viewport's top: only the part over the list counts.
        let tracker = VirtViewportTracker()
        let w = VirtWindow(total: 1000, start: 0, end: 30, estimatedSize: 50)
        tracker.listFrame(leading: 300, viewportExtent: 800)
        XCTAssertEqual(tracker.visibleRange(w), ItemRange(start: 0, end: 10))
        // Frames entirely off screen are ignored.
        tracker.slotFrame(id: "i:0", index: 0, min: 900, max: 950)
        XCTAssertEqual(tracker.visibleRange(w), ItemRange(start: 0, end: 10))
        // Scrolled far past it (an outer scroller): geometry, not appearances.
        tracker.slotAppeared(3)
        tracker.listFrame(leading: -5000, viewportExtent: 500)
        XCTAssertEqual(tracker.visibleRange(w), ItemRange(start: 100, end: 110))
        // Non-positive extents (not laid out yet) are ignored.
        let fresh = VirtViewportTracker()
        fresh.slotAppeared(3)
        fresh.listFrame(leading: 0, viewportExtent: 0)
        XCTAssertEqual(fresh.visibleRange(w), ItemRange(start: 3, end: 4))
    }

    // MARK: Scroll anchoring (§2)

    func testAnchorUnitPointPlacesTheRowsLeadingEdge() throws {
        // scrollTo aligns point u of the row with point u of the viewport:
        // rowOffset = u × (viewport − row).
        XCTAssertEqual(V.anchorUnitPoint(rowOffset: 0, rowExtent: 100, viewportExtent: 600), 0)
        XCTAssertEqual(V.anchorUnitPoint(rowOffset: 500, rowExtent: 100, viewportExtent: 600), 1)
        let u = try XCTUnwrap(V.anchorUnitPoint(rowOffset: -20, rowExtent: 60, viewportExtent: 600))
        XCTAssertEqual(u * (600 - 60), -20, accuracy: 1e-9)
        // A row as long as the viewport: every anchor gives the same position.
        XCTAssertNil(V.anchorUnitPoint(rowOffset: 10, rowExtent: 600, viewportExtent: 600))
        XCTAssertNil(V.anchorUnitPoint(rowOffset: .nan, rowExtent: 60, viewportExtent: 600))
        // A row taller than the viewport still resolves.
        let tall = try XCTUnwrap(V.anchorUnitPoint(rowOffset: -100, rowExtent: 1000, viewportExtent: 600))
        XCTAssertEqual(tall * (600 - 1000), -100, accuracy: 1e-9)
    }

    /// All placeholders: the anchor is found by index.
    private let unwindowed = V.slots(VirtWindow(total: 1000, start: 0, end: 0), childIds: [])

    func testAnchorCorrectionIgnoresAPlainScroll() {
        for mode in [VirtAnchorMode.contentOffset, .slotPosition] {
            let tracker = VirtViewportTracker()
            tracker.listFrame(leading: -1000, viewportExtent: 600)
            tracker.slotFrame(id: "i:10", index: 10, min: -20, max: 40)
            tracker.slotFrame(id: "i:11", index: 11, min: 40, max: 100)
            XCTAssertNil(tracker.anchorCorrection(unwindowed, mode: mode), "first call only records the anchor")
            // The user scrolls 30pt: list and rows move together.
            tracker.listFrame(leading: -1030, viewportExtent: 600)
            tracker.slotFrame(id: "i:10", index: 10, min: -50, max: 10)
            tracker.slotFrame(id: "i:11", index: 11, min: 10, max: 70)
            XCTAssertNil(tracker.anchorCorrection(unwindowed, mode: mode))
        }
    }

    func testAnchorCorrectionUndoesALayoutShiftAboveTheFirstVisibleRow() throws {
        let tracker = VirtViewportTracker()
        tracker.listFrame(leading: -1000, viewportExtent: 600)
        tracker.slotFrame(id: "i:10", index: 10, min: -20, max: 40)
        XCTAssertNil(tracker.anchorCorrection(unwindowed, mode: .contentOffset))
        // The window moved and the placeholders above grew by 50pt in total;
        // the scroll view kept its offset, so the row slid down 50pt.
        tracker.slotFrame(id: "i:10", index: 10, min: 30, max: 90)
        let c = try XCTUnwrap(tracker.anchorCorrection(unwindowed, mode: .contentOffset))
        XCTAssertEqual(c.slotId, "i:10")
        XCTAssertEqual(c.unitPoint * (600 - 60), -20, accuracy: 1e-9, "back at -20")
        // Once corrected (list moved by the shift, row back at -20), nothing more.
        tracker.listFrame(leading: -1050, viewportExtent: 600)
        tracker.slotFrame(id: "i:10", index: 10, min: -20, max: 40)
        XCTAssertNil(tracker.anchorCorrection(unwindowed, mode: .contentOffset))
    }

    func testAnchorCorrectionLeavesAHeldSlotToScrollPosition() {
        // scrollPosition(id:) kept slot 10 in place while the rows above grew
        // (the list's leading edge moved instead): nothing to correct.
        let tracker = VirtViewportTracker()
        tracker.listFrame(leading: -1000, viewportExtent: 600)
        tracker.slotFrame(id: "i:10", index: 10, min: -20, max: 40)
        XCTAssertNil(tracker.anchorCorrection(unwindowed, mode: .slotPosition))
        tracker.listFrame(leading: -1050, viewportExtent: 600)
        XCTAssertNil(tracker.anchorCorrection(unwindowed, mode: .slotPosition))
    }

    func testAnchorCorrectionFollowsAPlaceholderThatBecameARow() throws {
        let tracker = VirtViewportTracker()
        tracker.listFrame(leading: -4800, viewportExtent: 500)
        tracker.slotFrame(id: "i:100", index: 100, min: 0, max: 48)
        tracker.slotFrame(id: "i:101", index: 101, min: 48, max: 96)
        XCTAssertNil(tracker.anchorCorrection(unwindowed, mode: .contentOffset))
        // Item 100 materialized (same slot id) and the placeholder size above
        // changed from 48 to 50: 100 × 2pt further down.
        let window = V.slots(VirtWindow(total: 1000, start: 100, end: 102), childIds: ["x", "y"])
        tracker.slotFrame(id: "i:100", index: 100, min: 200, max: 270)
        tracker.slotFrame(id: "i:101", index: 101, min: 270, max: 330)
        let c = try XCTUnwrap(tracker.anchorCorrection(window, mode: .contentOffset))
        XCTAssertEqual(c.slotId, "i:100")
        XCTAssertEqual(c.unitPoint, 0, accuracy: 1e-9, "its leading edge back at the viewport top")
    }

    /// Items 90..<110 materialized as nodes "n90".."n109", rows 60pt; then two
    /// items inserted at 95: "n100" is now item 102.
    private func insertAbove() -> (before: Virtualization.Slots, after: Virtualization.Slots) {
        let before = V.slots(VirtWindow(total: 1000, start: 90, end: 110), childIds: (90..<110).map { "n\($0)" })
        let nodes = (90..<95).map { "n\($0)" } + ["new1", "new2"] + (95..<108).map { "n\($0)" }
        let after = V.slots(VirtWindow(total: 1002, start: 90, end: 110), childIds: nodes)
        return (before, after)
    }

    private func rowFrames(_ tracker: VirtViewportTracker, firstAt top: Double) {
        for i in 98..<106 {
            let min = top + Double(i - 100) * 60
            tracker.slotFrame(id: "i:\(i)", index: i, min: min, max: min + 60)
        }
    }

    func testAnchorCorrectionFollowsTheAnchoredNodeAfterAnInsertAbove() throws {
        for mode in [VirtAnchorMode.contentOffset, .slotPosition] {
            let (before, after) = insertAbove()
            let tracker = VirtViewportTracker()
            tracker.listFrame(leading: -5000, viewportExtent: 600)
            rowFrames(tracker, firstAt: -20)
            XCTAssertNil(tracker.anchorCorrection(before, mode: mode))
            XCTAssertEqual(after.itemIndex(ofNode: "n100"), 102)
            // Index 100 stayed where it was (by offset or by scrollPosition),
            // but now shows "n98": the anchored "n100" is two rows down.
            let c = try XCTUnwrap(tracker.anchorCorrection(after, mode: mode), "\(mode)")
            XCTAssertEqual(c.slotId, "i:102")
            XCTAssertEqual(c.unitPoint * (600 - 60), -20, accuracy: 1e-9, "n100 back at -20")
            // Corrected: everything moved up two rows with the scroll.
            tracker.listFrame(leading: -5120, viewportExtent: 600)
            rowFrames(tracker, firstAt: -140)
            XCTAssertNil(tracker.anchorCorrection(after, mode: mode))
        }
    }

    func testAnchorCorrectionFallsBackToTheIndexWhenTheNodeLeftTheWindow() {
        let (before, _) = insertAbove()
        let shifted = V.slots(VirtWindow(total: 1000, start: 0, end: 20), childIds: (0..<20).map { "m\($0)" })
        let tracker = VirtViewportTracker()
        tracker.listFrame(leading: -5000, viewportExtent: 600)
        rowFrames(tracker, firstAt: -20)
        XCTAssertNil(tracker.anchorCorrection(before, mode: .slotPosition))
        // "n100" is gone: index 100 is all there is, and scrollPosition holds it.
        XCTAssertNil(tracker.anchorCorrection(shifted, mode: .slotPosition))
    }

    func testAnchorCorrectionNeedsTheListGeometry() {
        let tracker = VirtViewportTracker()
        tracker.slotFrame(id: "i:0", index: 0, min: 0, max: 10)
        XCTAssertNil(tracker.anchorCorrection(unwindowed, mode: .contentOffset))
        tracker.slotFrame(id: "i:0", index: 0, min: 50, max: 60)
        XCTAssertNil(tracker.anchorCorrection(unwindowed, mode: .contentOffset))
    }

    // MARK: Accessibility (§2)

    func testAccessibilityPositionCountsFromOneInTheWholeList() {
        XCTAssertEqual(V.accessibilityPosition(index: 0, total: 10_000), "Row 1 of 10000")
        XCTAssertEqual(V.accessibilityPosition(index: 40, total: 10_000), "Row 41 of 10000")
        XCTAssertEqual(V.accessibilityPosition(index: 4, total: 30, columns: 3), "Item 5 of 30")
    }

    func testAccessibilitySummaryNamesTheTotal() {
        XCTAssertEqual(V.accessibilitySummary(total: 10_000), "10000 rows")
        XCTAssertEqual(V.accessibilitySummary(total: 1), "1 row")
        XCTAssertEqual(V.accessibilitySummary(total: 0), "0 rows")
        XCTAssertEqual(V.accessibilitySummary(total: 30, columns: 3), "30 items")
        XCTAssertEqual(V.accessibilitySummary(total: 1, columns: 3), "1 item")
    }
}
