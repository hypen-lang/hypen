import XCTest
@testable import HypenSwift

/// The renderer-side window math from hypen-web/docs/virtualization.md.
/// Mirrors hypen-web/tests/virtualization-math.test.ts case for case (the
/// reference every native port aligns with), plus the Swift-only slot
/// mapping and viewport tracker used by the lazy containers.
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

    // MARK: Slot mapping (§5, Swift-only)

    func testSlotsDeclareTotalWithItemsInsideTheWindow() {
        let w = VirtWindow(total: 6, start: 2, end: 4)
        let slots = V.slots(w, childIds: ["a", "b"])
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
        XCTAssertEqual(V.slots(w, childIds: ["a1", "a2", "a3", "b1", "b2", "b3"]), [
            .placeholder(index: 0),
            .item(index: 1, childIds: ["a1", "a2", "a3"]),
            .item(index: 2, childIds: ["b1", "b2", "b3"]),
            .placeholder(index: 3),
        ])
    }

    func testSlotsLeaveMissingChildrenAsPlaceholders() {
        // A window of 3 items with only 2 children (a batch still settling).
        let w = VirtWindow(total: 5, start: 1, end: 4)
        XCTAssertEqual(V.slots(w, childIds: ["a", "b"]), [
            .placeholder(index: 0),
            .item(index: 1, childIds: ["a"]),
            .item(index: 2, childIds: ["b"]),
            .placeholder(index: 3),
            .placeholder(index: 4),
        ])
    }

    func testSlotsForAnEmptyWindowAreAllPlaceholders() {
        let w = VirtWindow(total: 3, start: 0, end: 0)
        XCTAssertEqual(V.childrenPerItem(w, childCount: 0), 0)
        XCTAssertEqual(V.slots(w, childIds: []), [.placeholder(index: 0), .placeholder(index: 1), .placeholder(index: 2)])
        XCTAssertEqual(V.slots(VirtWindow(total: 0, start: 0, end: 0), childIds: []), [])
    }

    func testSlotIdsKeyRowsByNodeAndPlaceholdersByIndex() {
        XCTAssertEqual(Virtualization.Slot.item(index: 7, childIds: ["42", "43"]).id, "n:42")
        XCTAssertEqual(Virtualization.Slot.placeholder(index: 7).id, "p:7")
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
        XCTAssertEqual(tracker.visibleRange(total: 1000), ItemRange(start: 40, end: 50))
        XCTAssertEqual(tracker.evaluate(w), ItemRange(start: 30, end: 60))
        XCTAssertNil(tracker.evaluate(w), "never the same range twice")
        XCTAssertEqual(tracker.lastReported, ItemRange(start: 30, end: 60))
    }

    func testTrackerCountsOverlappingAppearances() {
        // Placeholder → row swap: the row's onAppear can precede the
        // placeholder's onDisappear for the same index.
        let tracker = VirtViewportTracker()
        tracker.slotAppeared(5)
        tracker.slotAppeared(5)
        tracker.slotDisappeared(5)
        XCTAssertEqual(tracker.visibleRange(total: 10), ItemRange(start: 5, end: 6))
        tracker.slotDisappeared(5)
        XCTAssertNil(tracker.visibleRange(total: 10))
        tracker.slotDisappeared(5) // unbalanced: ignored
        XCTAssertNil(tracker.visibleRange(total: 10))
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
}
