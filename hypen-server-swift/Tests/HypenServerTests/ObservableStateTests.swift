import XCTest
@testable import HypenServer

final class ObservableStateTests: XCTestCase {
    func testGetAndSet() {
        let state = ObservableState(["count": 0, "name": "test"])

        XCTAssertEqual(state.get("count") as? Int, 0)
        XCTAssertEqual(state.get("name") as? String, "test")

        state.set("count", 42)
        XCTAssertEqual(state.get("count") as? Int, 42)
    }

    func testSnapshot() {
        let state = ObservableState(["a": 1, "b": "hello"])
        let snap = state.snapshot()
        XCTAssertEqual(snap["a"] as? Int, 1)
        XCTAssertEqual(snap["b"] as? String, "hello")
    }

    func testNestedGet() {
        let state = ObservableState(["user": ["name": "Alice", "age": 30] as [String: Any]])
        XCTAssertEqual(state.get("user.name") as? String, "Alice")
        XCTAssertEqual(state.get("user.age") as? Int, 30)
    }

    func testNestedSet() {
        let state = ObservableState(["user": ["name": "Alice"] as [String: Any]])
        state.set("user.name", "Bob")
        XCTAssertEqual(state.get("user.name") as? String, "Bob")
    }

    func testOnChange() {
        let state = ObservableState(["count": 0])
        let expectation = XCTestExpectation(description: "Change callback")

        state.onChange { change in
            XCTAssertEqual(change.paths, ["count"])
            expectation.fulfill()
        }

        state.set("count", 1)
        wait(for: [expectation], timeout: 1.0)
    }

    func testOnChangeReportsRawPath() {
        // ObservableState no longer prefixes paths — scope is owned by the
        // module instance that wraps it and passed to the engine separately.
        let state = ObservableState(["count": 0])
        let expectation = XCTestExpectation(description: "Raw path change")

        state.onChange { change in
            XCTAssertEqual(change.paths, ["count"])
            expectation.fulfill()
        }

        state.set("count", 5)
        wait(for: [expectation], timeout: 1.0)
    }

    func testReplace() {
        let state = ObservableState(["a": 1, "b": 2])
        let expectation = XCTestExpectation(description: "Replace callback")

        state.onChange { change in
            XCTAssertTrue(change.paths.contains("x"))
            XCTAssertTrue(change.paths.contains("y"))
            // Removed keys also reported
            XCTAssertTrue(change.paths.contains("a"))
            XCTAssertTrue(change.paths.contains("b"))
            expectation.fulfill()
        }

        state.replace(["x": 10, "y": 20])
        let snap = state.snapshot()
        XCTAssertEqual(snap["x"] as? Int, 10)
        XCTAssertEqual(snap["y"] as? Int, 20)
        XCTAssertNil(snap["a"])
        wait(for: [expectation], timeout: 1.0)
    }
}
