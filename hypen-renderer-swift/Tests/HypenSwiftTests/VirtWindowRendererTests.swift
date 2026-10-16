import XCTest
@testable import HypenSwift

/// `__virt.window` handling in `HypenRenderer` (hypen-web/docs/virtualization.md
/// §1): the window lands on `HypenElement.virtWindow`, never in `props` (so it
/// never reaches the applicator pipeline as a style), `removeProp` clears it,
/// and reports go to the host's `viewportReporter`.
@MainActor
final class VirtWindowRendererTests: XCTestCase {
    private func listRenderer() -> HypenRenderer {
        let renderer = HypenRenderer()
        renderer.applyPatches([
            Patch(type: .create, id: "list", elementType: "list"),
            Patch(type: .create, id: "r0", elementType: "text"),
            Patch(type: .insert, id: "r0", parentId: "list"),
            Patch(type: .create, id: "r1", elementType: "text"),
            Patch(type: .insert, id: "r1", parentId: "list"),
            Patch(type: .setProp, id: "list", name: "__virt.window",
                  value: ["total": 100, "start": 0, "end": 2, "estimatedSize": 40]),
        ])
        return renderer
    }

    func testSetPropStoresTheWindowOutsideProps() throws {
        let renderer = listRenderer()
        let list = try XCTUnwrap(renderer.getElement("list"))
        XCTAssertEqual(list.virtWindow, VirtWindow(total: 100, start: 0, end: 2, estimatedSize: 40))
        XCTAssertNil(list.props["__virt.window"], "never stored as an ordinary prop")
        XCTAssertEqual(list.virtChildIds(renderer: renderer), ["r0", "r1"])
    }

    func testRemovePropClearsTheWindow() throws {
        let renderer = listRenderer()
        renderer.applyPatches([Patch(type: .removeProp, id: "list", name: "__virt.window")])
        XCTAssertNil(try XCTUnwrap(renderer.getElement("list")).virtWindow)
    }

    func testMalformedWindowClearsIt() throws {
        let renderer = listRenderer()
        renderer.applyPatches([
            Patch(type: .setProp, id: "list", name: "__virt.window", value: ["total": 1, "start": 0, "end": 5]),
        ])
        let list = try XCTUnwrap(renderer.getElement("list"))
        XCTAssertNil(list.virtWindow)
        XCTAssertNil(list.props["__virt.window"])
    }

    func testCreateCarryingTheWindowLiftsItOutOfProps() throws {
        let renderer = HypenRenderer()
        renderer.applyPatches([
            Patch(type: .create, id: "grid", elementType: "grid",
                  props: ["__virt.window": ["total": 9, "start": 3, "end": 6], "columns.0": 3]),
        ])
        let grid = try XCTUnwrap(renderer.getElement("grid"))
        XCTAssertEqual(grid.virtWindow, VirtWindow(total: 9, start: 3, end: 6))
        XCTAssertNil(grid.props["__virt.window"])
        XCTAssertEqual(grid.getIntProp("columns.0"), 3)
    }

    func testReportGoesToTheViewportReporter() {
        let renderer = listRenderer()
        var reports: [String] = []
        renderer.viewportReporter = { id, start, end in reports.append("\(id):\(start)-\(end)") }
        renderer.reportListViewport(listId: "list", start: 10, end: 40)
        XCTAssertEqual(reports, ["list:10-40"])
    }
}
