import XCTest
@testable import HypenServer

/// Host side of drag-and-drop for the Swift server SDK
/// (`hypen-web/docs/dnd.md`; design §6.5–6.7).
/// Mirrors `hypen-kotlin/src/test/kotlin/space/hypen/core/DndHostTest.kt`:
///
/// - `ObservableState.move` routes through the engine's `portable_path_move`
///   and is pinned by the shared `fixtures/dnd/path-move.json` cases.
/// - `__hypen_reorder` / `__hypen_pin` are auto-registered by every module
///   instance and write through `ObservableState` (never the engine directly).
/// - The typed builder's `encodeState` never clears `__`-prefixed keys, so
///   the reserved `__dnd` subtree survives unrelated typed actions (the
///   silent-wipe regression).

// MARK: - Shared helpers

/// Thread-safe append-only patch log for `ModuleInstance.onPatches`.
private final class TestPatchLog: @unchecked Sendable {
    private var patches: [[String: Any]] = []
    private let lock = NSLock()

    func append(contentsOf batch: [[String: Any]]) {
        lock.lock()
        defer { lock.unlock() }
        patches.append(contentsOf: batch)
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        patches.removeAll()
    }

    var all: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return patches
    }
}

/// Thread-safe list of `ObservableState.StateChange`s.
private final class TestChangeLog: @unchecked Sendable {
    private var changes: [ObservableState.StateChange] = []
    private let lock = NSLock()

    func append(_ change: ObservableState.StateChange) {
        lock.lock()
        defer { lock.unlock() }
        changes.append(change)
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        changes.removeAll()
    }

    var all: [ObservableState.StateChange] {
        lock.lock()
        defer { lock.unlock() }
        return changes
    }
}

/// Captures warnings so the dropped-key guard can be asserted without
/// touching stdout. Installed on `HypenLoggerConfig.shared` per test.
private final class RecordingLogHandler: HypenLogHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var _warnings: [String] = []

    func debug(tag: String, message: String) {}
    func info(tag: String, message: String) {}
    func warn(tag: String, message: String) {
        lock.lock()
        defer { lock.unlock() }
        _warnings.append("[\(tag)] \(message)")
    }
    func error(tag: String, message: String) {}

    var warnings: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _warnings
    }
}

/// Compare JSON-shaped values (`[String: Any]`, `[Any]`, numbers, strings)
/// structurally through Foundation's `isEqual`, which sees through the
/// NSNumber/NSString/NSArray/NSDictionary bridging that `JSONSerialization`
/// round-trips produce.
private func assertJSONEqual(
    _ actual: Any?, _ expected: Any, _ message: String = "",
    file: StaticString = #filePath, line: UInt = #line
) {
    guard let actual = actual else {
        XCTFail("expected \(expected) but got nil. \(message)", file: file, line: line)
        return
    }
    XCTAssertTrue(
        jsonValuesEqual(actual, expected),
        "\(actual) is not equal to \(expected). \(message)",
        file: file, line: line
    )
}

/// Structural JSON equality: objects by key set and values, arrays in
/// order, strings by value, numbers by `NSNumber` value (so `0` equals
/// `0.0`, as `NSObject.isEqual` has it on Darwin). Portable: on Linux
/// `NSDictionary.isEqual` does not bridge a Swift `[String: Any]` argument
/// holding Swift `String` values, so the Foundation shortcut reports
/// unequal for equal dictionaries.
private func jsonValuesEqual(_ a: Any, _ b: Any) -> Bool {
    if let da = a as? [String: Any], let db = b as? [String: Any] {
        guard Set(da.keys) == Set(db.keys) else { return false }
        return da.allSatisfy { key, value in db[key].map { jsonValuesEqual(value, $0) } ?? false }
    }
    if let aa = a as? [Any], let ab = b as? [Any] {
        guard aa.count == ab.count else { return false }
        return zip(aa, ab).allSatisfy { jsonValuesEqual($0, $1) }
    }
    if let sa = a as? String, let sb = b as? String { return sa == sb }
    if a is NSNull || b is NSNull { return a is NSNull && b is NSNull }
    if let na = a as? NSNumber, let nb = b as? NSNumber { return na.isEqual(to: nb) }
    return false
}

// MARK: - A. portable::path_move conformance through ObservableState.move

final class PathMoveFixtureTests: XCTestCase {

    /// `hypen-server-swift/Tests/HypenServerTests/<this file>` → repo root.
    private static var fixtureURL: URL {
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // HypenServerTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // hypen-server-swift
            .deletingLastPathComponent()  // repo root
            .appendingPathComponent("engine-compatibility-tests/fixtures/dnd/path-move.json")
    }

    func testPathMoveFixture() throws {
        let url = Self.fixtureURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("path-move fixture not present at \(url.path) (standalone checkout)")
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return XCTFail("fixture root is not an object")
        }
        XCTAssertEqual(root["function"] as? String, "path_move")
        guard let cases = root["cases"] as? [[String: Any]], !cases.isEmpty else {
            return XCTFail("fixture has no cases")
        }

        for c in cases {
            let name = c["name"] as? String ?? "<unnamed>"
            guard let initial = c["state"] as? [String: Any],
                  let op = c["op"] as? [String: Any],
                  let fromPath = op["fromPath"] as? String,
                  let toPath = op["toPath"] as? String,
                  let from = op["from"] as? Int,
                  let to = op["to"] as? Int,
                  let expected = c["expected"] as? [String: Any],
                  let expectedMoved = c["moved"] as? Bool else {
                XCTFail("malformed fixture case \(name)")
                continue
            }

            let changes = TestChangeLog()
            let state = ObservableState(initial)
            state.onChange { changes.append($0) }

            let moved = state.move(fromPath: fromPath, from: from, toPath: toPath, to: to)

            XCTAssertEqual(moved, expectedMoved, "\(name): moved flag")
            XCTAssertEqual(
                state.snapshot() as NSDictionary, expected as NSDictionary,
                "\(name): state after move"
            )

            if expectedMoved {
                XCTAssertEqual(changes.all.count, 1, "\(name): exactly one change notification per move")
                guard let change = changes.all.first else { continue }
                XCTAssertFalse(change.paths.isEmpty, "\(name): notified paths must not be empty")
                for p in change.paths {
                    XCTAssertTrue(
                        p == fromPath || p == toPath,
                        "\(name): notified path '\(p)' must be one of the moved arrays"
                    )
                    // The notified value is the post-move array at that path.
                    assertJSONEqual(
                        change.newValues[p], state.get(p) ?? NSNull(),
                        "\(name): newValues[\(p)] is the post-move array"
                    )
                }
            } else {
                XCTAssertTrue(changes.all.isEmpty, "\(name): a refused move must not notify")
            }
        }
    }
}

// MARK: - B. ObservableState.move — change notification shape

final class ObservableStateMoveTests: XCTestCase {

    func testSameArrayMoveNotifiesTheArrayPathOnceWithTheNewOrder() {
        let changes = TestChangeLog()
        let state = ObservableState(["tasks": ["a", "b", "c"]])
        state.onChange { changes.append($0) }

        XCTAssertTrue(state.move(fromPath: "tasks", from: 0, toPath: "tasks", to: 2))

        XCTAssertEqual(state.get("tasks") as? [String], ["b", "c", "a"])
        XCTAssertEqual(changes.all.count, 1)
        XCTAssertEqual(changes.all[0].paths, ["tasks"])
        XCTAssertEqual(changes.all[0].newValues["tasks"] as? [String], ["b", "c", "a"])
    }

    func testCrossArrayMoveNotifiesBothArraysInOneChange() {
        let changes = TestChangeLog()
        let state = ObservableState(["todo": ["a", "b"], "done": ["z"]])
        state.onChange { changes.append($0) }

        XCTAssertTrue(state.move(fromPath: "todo", from: 1, toPath: "done", to: 0))

        XCTAssertEqual(changes.all.count, 1)
        XCTAssertEqual(changes.all[0].paths, ["todo", "done"])
        XCTAssertEqual(changes.all[0].newValues["todo"] as? [String], ["a"])
        XCTAssertEqual(changes.all[0].newValues["done"] as? [String], ["b", "z"])
    }

    func testNestedDestinationCollapsesTheNotificationToTheAncestorArray() {
        let changes = TestChangeLog()
        let state = ObservableState([
            "entries": [
                ["id": "f", "children": [Any]()] as [String: Any],
                ["id": "a", "children": ["a1"]] as [String: Any],
            ]
        ])
        state.onChange { changes.append($0) }

        XCTAssertTrue(state.move(fromPath: "entries", from: 0, toPath: "entries.1.children", to: 1))

        // After removing index 0 the destination is re-addressed to what is
        // now entries.0.children; only `entries` is a stable path to report.
        XCTAssertEqual(changes.all.count, 1)
        XCTAssertEqual(changes.all[0].paths, ["entries"])
        let entries = changes.all[0].newValues["entries"] as? [Any]
        XCTAssertEqual(entries?.count, 1)
        let a = entries?.first as? [String: Any]
        let expectedChildren: [Any] = ["a1", ["id": "f", "children": [Any]()] as [String: Any]]
        assertJSONEqual(a?["children"], expectedChildren)
    }

    func testRefusedMoveLeavesStateUntouchedAndDoesNotNotify() {
        let changes = TestChangeLog()
        let state = ObservableState(["tasks": ["a", "b"]])
        state.onChange { changes.append($0) }

        XCTAssertFalse(state.move(fromPath: "tasks", from: 5, toPath: "tasks", to: 0), "from out of range")
        XCTAssertFalse(state.move(fromPath: "tasks", from: 0, toPath: "missing", to: 0), "destination missing")
        XCTAssertFalse(state.move(fromPath: "tasks", from: -1, toPath: "tasks", to: 0), "negative index")
        XCTAssertFalse(state.move(fromPath: "tasks", from: 0, toPath: "tasks", to: -1), "negative index")

        XCTAssertEqual(state.get("tasks") as? [String], ["a", "b"])
        XCTAssertTrue(changes.all.isEmpty)
    }

    func testUpdateAppliesEveryPathAndNotifiesOnce() {
        let changes = TestChangeLog()
        let state = ObservableState(["n": 0])
        state.onChange { changes.append($0) }

        state.update(["a.b": 1, "c": "x"])

        XCTAssertEqual(state.get("a.b") as? Int, 1)
        XCTAssertEqual(state.get("c") as? String, "x")
        XCTAssertEqual(state.get("n") as? Int, 0)
        XCTAssertEqual(changes.all.count, 1, "one notification for the whole batch")
        XCTAssertEqual(Set(changes.all[0].paths), Set(["a.b", "c"]))
        XCTAssertEqual(changes.all[0].newValues["a.b"] as? Int, 1)
        XCTAssertEqual(changes.all[0].newValues["c"] as? String, "x")
    }

    func testChangedPathsForMoveCollapsesAncestors() {
        XCTAssertEqual(ObservableState.changedPathsForMove(fromPath: "a", toPath: "a"), ["a"])
        XCTAssertEqual(ObservableState.changedPathsForMove(fromPath: "a", toPath: "a.1.children"), ["a"])
        XCTAssertEqual(ObservableState.changedPathsForMove(fromPath: "a.0.children", toPath: "a"), ["a"])
        XCTAssertEqual(
            ObservableState.changedPathsForMove(fromPath: "ab", toPath: "a"), ["ab", "a"],
            "prefix without dot is NOT an ancestor"
        )
        XCTAssertEqual(ObservableState.changedPathsForMove(fromPath: "todo", toPath: "done"), ["todo", "done"])
    }
}

// MARK: - C. __hypen_reorder dispatch (untyped modules)

final class ReorderActionTests: XCTestCase {

    /// Every `ObservableState` change is exactly one `engine.updateState`
    /// call in `ModuleInstance`, so counting state changes counts engine
    /// updates.
    private func observe(_ instance: ModuleInstance) -> TestChangeLog {
        let changes = TestChangeLog()
        instance.state.onChange { changes.append($0) }
        return changes
    }

    func testReorderWithFromPathToPathAppliesPathMoveAndNotifiesOnce() {
        let def = AppBuilder(["tasks": ["a", "b", "c", "d"]]).build()
        let instance = try! ModuleInstance(definition: def)
        let changes = observe(instance)

        instance.dispatchAction(
            HypenDnd.reorderAction,
            payload: ["fromPath": "tasks", "from": 0, "toPath": "tasks", "to": 2]
        )

        XCTAssertEqual(instance.getState()["tasks"] as? [String], ["b", "c", "a", "d"])
        XCTAssertEqual(changes.all.count, 1, "one engine update per reorder")
        XCTAssertEqual(changes.all[0].paths, ["tasks"])
        XCTAssertEqual(changes.all[0].newValues["tasks"] as? [String], ["b", "c", "a", "d"])
    }

    func testPathShorthandMeansFromPathEqualsToPath() {
        let def = AppBuilder(["tasks": ["a", "b", "c"]]).build()
        let instance = try! ModuleInstance(definition: def)

        instance.dispatchAction(HypenDnd.reorderAction, payload: ["path": "tasks", "from": 2, "to": 0])

        XCTAssertEqual(instance.getState()["tasks"] as? [String], ["c", "a", "b"])
    }

    func testCrossListReorderMovesTheItemAndNotifiesBothArrays() {
        let def = AppBuilder([
            "todo": [["id": "t1"], ["id": "t2"]],
            "doing": [["id": "d1"]],
        ]).build()
        let instance = try! ModuleInstance(definition: def)
        let changes = observe(instance)

        instance.dispatchAction(
            HypenDnd.reorderAction,
            payload: ["fromPath": "todo", "from": 1, "toPath": "doing", "to": 0]
        )

        let state = instance.getState()
        assertJSONEqual(state["todo"], [["id": "t1"]])
        assertJSONEqual(state["doing"], [["id": "t2"], ["id": "d1"]])
        XCTAssertEqual(changes.all.count, 1)
        XCTAssertEqual(changes.all[0].paths, ["todo", "doing"])
    }

    func testReorderChangeNotificationReachesModuleStateListeners() {
        let def = AppBuilder(["tasks": ["a", "b"]]).build()
        let instance = try! ModuleInstance(definition: def)
        let notified = TestCounter(0)
        instance.onStateChange { notified.mutate { $0 += 1 } }
        let observed = observe(instance)

        instance.dispatchAction(HypenDnd.reorderAction, payload: ["path": "tasks", "from": 0, "to": 1])

        XCTAssertEqual(notified.current, 1)
        XCTAssertEqual(observed.all.count, 1)
        XCTAssertEqual(observed.all[0].paths, ["tasks"])
        XCTAssertEqual(observed.all[0].newValues["tasks"] as? [String], ["b", "a"])
    }

    func testMalformedOrRefusedReorderPayloadsLeaveStateUntouched() {
        let def = AppBuilder(["tasks": ["a", "b"]]).build()
        let instance = try! ModuleInstance(definition: def)
        let changes = observe(instance)

        let bad: [Any?] = [
            nil,
            "tasks",
            ["from": 0, "to": 1],                                       // no path
            ["path": "tasks", "from": "0", "to": 1],                    // string index
            ["path": "tasks", "from": 0.5, "to": 1],                    // fractional index
            ["path": "tasks", "from": true, "to": 1],                   // boolean index
            ["path": "tasks", "from": 0],                               // missing to
            ["path": "tasks", "from": 7, "to": 0],                      // out of range
            ["fromPath": "tasks", "from": 0, "toPath": "nope", "to": 0],
            ["path": "tasks", "from": -1, "to": 0],
        ]
        for payload in bad {
            instance.dispatchAction(HypenDnd.reorderAction, payload: payload)
        }
        // A non-object JSON payload straight off the wire (the handler's own
        // `as? [String: Any]` guard, past `dispatchAction`'s serialization).
        try? instance.engine.dispatchAction(HypenDnd.reorderAction, payloadJson: "[\"tasks\", 0, 1]")
        instance.engine.processPendingActions()

        XCTAssertEqual(instance.getState()["tasks"] as? [String], ["a", "b"])
        XCTAssertTrue(changes.all.isEmpty, "no engine update for refused moves")
    }

    func testDestroyedInstanceIgnoresReorder() {
        let def = AppBuilder(["tasks": ["a", "b"]]).build()
        let instance = try! ModuleInstance(definition: def)
        let changes = observe(instance)
        instance.destroy()

        // `dispatchAction` short-circuits on a destroyed instance; drive the
        // engine directly so the registered handler's own guard is exercised.
        try? instance.engine.dispatchAction(
            HypenDnd.reorderAction, payloadJson: "{\"path\":\"tasks\",\"from\":0,\"to\":1}"
        )
        instance.engine.processPendingActions()

        XCTAssertEqual(instance.getState()["tasks"] as? [String], ["a", "b"])
        XCTAssertTrue(changes.all.isEmpty)
    }
}

// MARK: - D. __hypen_pin dispatch (untyped modules)

final class PinActionTests: XCTestCase {

    func testReservedModePinAutoVivifiesAndWritesBothFieldsInOneBatch() {
        let def = AppBuilder(["notes": [["id": "n1"]]]).build()
        let instance = try! ModuleInstance(definition: def)
        let changes = TestChangeLog()
        instance.state.onChange { changes.append($0) }

        instance.dispatchAction(
            HypenDnd.pinAction,
            payload: [
                "path": HypenDnd.reservedPinPath(group: "board", key: "n1"),
                "x": 296, "y": 200, "xKey": "x", "yKey": "y",
            ]
        )

        assertJSONEqual(instance.getState()["__dnd"], ["board": ["n1": ["x": 296, "y": 200]]])
        XCTAssertEqual(changes.all.count, 1, "two path sets must land in a single engine update")
        XCTAssertEqual(Set(changes.all[0].paths), Set(["__dnd.board.n1.x", "__dnd.board.n1.y"]))
        XCTAssertEqual(changes.all[0].newValues["__dnd.board.n1.x"] as? Int, 296)
        XCTAssertEqual(changes.all[0].newValues["__dnd.board.n1.y"] as? Int, 200)
    }

    func testRepeatedPinsAccumulatePerKeyAndOverwriteInPlace() {
        let def = AppBuilder(["n": 0]).build()
        let instance = try! ModuleInstance(definition: def)

        instance.dispatchAction(HypenDnd.pinAction, payload: ["path": "__dnd.board.n1", "x": 1, "y": 2])
        instance.dispatchAction(HypenDnd.pinAction, payload: ["path": "__dnd.board.n2", "x": 3, "y": 4])
        instance.dispatchAction(HypenDnd.pinAction, payload: ["path": "__dnd.board.n1", "x": 10, "y": 20])

        assertJSONEqual(
            instance.getState()["__dnd"],
            ["board": ["n1": ["x": 10, "y": 20], "n2": ["x": 3, "y": 4]]]
        )
    }

    func testUserFieldPinWritesTheNamedKeysOnTheBoundItem() {
        let def = AppBuilder([
            "notes": [
                ["id": "n1", "left": 0, "top": 0] as [String: Any],
                ["id": "n2"] as [String: Any],
            ]
        ]).build()
        let instance = try! ModuleInstance(definition: def)

        instance.dispatchAction(
            HypenDnd.pinAction,
            payload: [
                "path": HypenDnd.userPinPath(bindPath: "notes", index: 1),
                "x": 12.5, "y": 7, "xKey": "left", "yKey": "top",
            ]
        )

        let notes = instance.getState()["notes"] as? [Any]
        XCTAssertEqual(notes?.count, 2)
        assertJSONEqual(notes?[0], ["id": "n1", "left": 0, "top": 0] as [String: Any])
        assertJSONEqual(notes?[1], ["id": "n2", "left": 12.5, "top": 7] as [String: Any])
    }

    func testMissingKeyNamesDefaultToXAndY() {
        let def = AppBuilder(["n": 0]).build()
        let instance = try! ModuleInstance(definition: def)

        instance.dispatchAction(HypenDnd.pinAction, payload: ["path": "__dnd.g.k", "x": 5, "y": 6])

        assertJSONEqual(instance.getState()["__dnd"], ["g": ["k": ["x": 5, "y": 6]]])
    }

    func testIdenticalKeyNamesDoNotTrap() {
        let def = AppBuilder(["n": 0]).build()
        let instance = try! ModuleInstance(definition: def)

        instance.dispatchAction(
            HypenDnd.pinAction,
            payload: ["path": "__dnd.g.k", "x": 1, "y": 2, "xKey": "p", "yKey": "p"]
        )

        XCTAssertNotNil(instance.state.get("__dnd.g.k.p"), "a single write lands; no duplicate-key trap")
    }

    func testMalformedPinPayloadsLeaveStateUntouched() {
        let def = AppBuilder(["n": 0]).build()
        let instance = try! ModuleInstance(definition: def)
        let changes = TestChangeLog()
        instance.state.onChange { changes.append($0) }

        let bad: [Any?] = [
            nil,
            ["x": 1, "y": 2],                               // no path
            ["path": "", "x": 1, "y": 2],                   // empty path
            ["path": "__dnd.g.k", "x": "1", "y": 2],        // string coordinate
            ["path": "__dnd.g.k", "x": true, "y": 2],       // boolean coordinate
            ["path": "__dnd.g.k", "x": 1],                  // missing y
            ["path": "__dnd.g.k", "x": Double.nan, "y": 2],
            ["path": "__dnd.g.k", "x": 1, "y": Double.infinity],
        ]
        for payload in bad {
            instance.dispatchAction(HypenDnd.pinAction, payload: payload)
        }
        try? instance.engine.dispatchAction(HypenDnd.pinAction, payloadJson: "[\"__dnd.g.k\", 1, 2]")
        instance.engine.processPendingActions()

        XCTAssertNil(instance.getState()["__dnd"])
        XCTAssertTrue(changes.all.isEmpty)
    }

    /// JSON booleans off the wire arrive as `NSNumber` just like `0`/`1`;
    /// the handler tells them apart without CoreFoundation (plan §6.11).
    func testWireJsonBooleanCoordinatesAreRejectedButIntegersAreNot() {
        let def = AppBuilder(["n": 0]).build()
        let instance = try! ModuleInstance(definition: def)
        let changes = TestChangeLog()
        instance.state.onChange { changes.append($0) }

        try? instance.engine.dispatchAction(
            HypenDnd.pinAction, payloadJson: "{\"path\":\"__dnd.g.k\",\"x\":true,\"y\":2}"
        )
        try? instance.engine.dispatchAction(
            HypenDnd.pinAction, payloadJson: "{\"path\":\"__dnd.g.k\",\"x\":1,\"y\":false}"
        )
        instance.engine.processPendingActions()
        XCTAssertNil(instance.getState()["__dnd"], "wire booleans are not coordinates")
        XCTAssertTrue(changes.all.isEmpty)

        // `0` / `1` / `1.0` are numbers, not booleans.
        try? instance.engine.dispatchAction(
            HypenDnd.pinAction, payloadJson: "{\"path\":\"__dnd.g.k\",\"x\":1,\"y\":0}"
        )
        instance.engine.processPendingActions()
        assertJSONEqual(instance.getState()["__dnd"], ["g": ["k": ["x": 1, "y": 0]]])
        XCTAssertEqual(changes.all.count, 1)
    }

    func testIsBooleanNumberDiscriminatesParsedJson() throws {
        let data = Data("{\"t\":true,\"f\":false,\"one\":1,\"zero\":0,\"real\":1.0,\"big\":120}".utf8)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        func number(_ key: String) throws -> NSNumber {
            return try XCTUnwrap(parsed[key] as? NSNumber, key)
        }
        XCTAssertTrue(ModuleInstance.isBooleanNumber(try number("t")))
        XCTAssertTrue(ModuleInstance.isBooleanNumber(try number("f")))
        XCTAssertFalse(ModuleInstance.isBooleanNumber(try number("one")))
        XCTAssertFalse(ModuleInstance.isBooleanNumber(try number("zero")))
        XCTAssertFalse(ModuleInstance.isBooleanNumber(try number("real")))
        XCTAssertFalse(ModuleInstance.isBooleanNumber(try number("big")))
        // Swift literals bridged into a payload dictionary behave the same.
        XCTAssertTrue(ModuleInstance.isBooleanNumber(try XCTUnwrap((true as Any) as? NSNumber)))
        XCTAssertFalse(ModuleInstance.isBooleanNumber(try XCTUnwrap((1 as Any) as? NSNumber)))
    }
}

// MARK: - E. Typed modules — the silent-wipe regression (design §6.6)

struct DndNote: Codable {
    var id: String = ""
    var text: String = ""
}

/// Deliberately declares NO x/y and NO __dnd: the reserved subtree lives only in the map.
struct DndBoardState: Codable {
    var title: String = ""
    var notes: [DndNote] = []
}

struct DndListState: Codable {
    var tasks: [String] = []
    var clicks: Int = 0
}

struct RetitlePayload: Codable {
    let title: String
}

final class TypedDndRoundTripTests: XCTestCase {

    private let handler = RecordingLogHandler()
    private var previousLevel: HypenLogLevel = .info
    private var previousHandler: (any HypenLogHandler)?

    override func setUp() {
        super.setUp()
        previousLevel = HypenLoggerConfig.shared.level
        previousHandler = HypenLoggerConfig.shared.handler
        HypenLoggerConfig.shared.level = .warn
        HypenLoggerConfig.shared.handler = handler
        // Warn-once is process-wide; start each test with a clean slate.
        TypedStateSyncConfig.shared.resetWarnedPaths()
        TypedStateSyncConfig.shared.warnOnDroppedKeys = true
    }

    override func tearDown() {
        HypenLoggerConfig.shared.handler = previousHandler
        HypenLoggerConfig.shared.level = previousLevel
        TypedStateSyncConfig.shared.warnOnDroppedKeys = true
        super.tearDown()
    }

    // Computed, not stored: a `static let` of a non-Sendable `[String: Any]`
    // is a compile error in Swift 6 language mode (plan §6.11).
    private static var pinnedN1: [String: Any] { ["board": ["n1": ["x": 296, "y": 200]]] }

    func testReservedDndSurvivesAnUnrelatedTypedAction() {
        let def = hypen(DndBoardState(title: "Board", notes: [DndNote(id: "n1", text: "one"), DndNote(id: "n2", text: "two")]))
            .onAction("retitle", payload: RetitlePayload.self) { state, payload in
                state.title = payload.title
            }
            .onAction("touch") { state in
                state.notes[0].text = "touched"
            }
            .build()
        let instance = try! ModuleInstance(definition: def)

        // Renderer drops a note on a reserved-mode pinboard.
        instance.dispatchAction(
            HypenDnd.pinAction,
            payload: ["path": "__dnd.board.n1", "x": 296, "y": 200, "xKey": "x", "yKey": "y"]
        )
        assertJSONEqual(instance.getState()["__dnd"], Self.pinnedN1)

        // Unrelated typed actions decode -> mutate -> encodeState. Before
        // the reserved-key exemption this cleared every key the struct did
        // not declare and wiped the pin.
        instance.dispatchAction("retitle", payload: ["title": "Renamed"])
        instance.dispatchAction("touch")

        let state = instance.getState()
        XCTAssertEqual(state["title"] as? String, "Renamed")
        let notes = state["notes"] as? [Any]
        XCTAssertEqual((notes?.first as? [String: Any])?["text"] as? String, "touched")
        assertJSONEqual(state["__dnd"], Self.pinnedN1, "__dnd must survive typed round-trips")
        XCTAssertTrue(
            handler.warnings.allSatisfy { !$0.contains("__dnd") },
            "reserved keys are preserved, not warned about: \(handler.warnings)"
        )
    }

    func testTypedActionsNeverTouchDndPaths() {
        let def = hypen(DndBoardState(title: "Board"))
            .onAction("retitle", payload: RetitlePayload.self) { state, payload in
                state.title = payload.title
            }
            .build()
        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction(HypenDnd.pinAction, payload: ["path": "__dnd.board.n1", "x": 1, "y": 2])
        let changes = TestChangeLog()
        instance.state.onChange { changes.append($0) }

        instance.dispatchAction("retitle", payload: ["title": "Renamed"])

        // encodeState writes the typed fields only; the engine keeps its __dnd.
        let paths = changes.all.flatMap { $0.paths }
        XCTAssertFalse(paths.isEmpty)
        XCTAssertTrue(paths.allSatisfy { !$0.hasPrefix("__dnd") }, "encodeState must not touch __dnd: \(paths)")
        XCTAssertTrue(paths.contains("title"))
        assertJSONEqual(instance.getState()["__dnd"], ["board": ["n1": ["x": 1, "y": 2]]])
    }

    func testReorderOnATypedListSurvivesAnUnrelatedTypedAction() {
        let def = hypen(DndListState(tasks: ["a", "b", "c"]))
            .onAction("click") { state in
                state.clicks += 1
            }
            .build()
        let instance = try! ModuleInstance(definition: def)

        instance.dispatchAction(HypenDnd.reorderAction, payload: ["path": "tasks", "from": 0, "to": 2])
        XCTAssertEqual(instance.getState()["tasks"] as? [String], ["b", "c", "a"])

        instance.dispatchAction("click")

        XCTAssertEqual(instance.getState()["tasks"] as? [String], ["b", "c", "a"], "sort is immune to the typed round-trip")
        XCTAssertEqual(instance.getState()["clicks"] as? Int, 1)
    }

    func testUserFieldPinOntoAnUndeclaredFieldWarnsOnceWhenTheTypedEncodingDropsIt() {
        let def = hypen(DndBoardState(title: "Board", notes: [DndNote(id: "n1", text: "one")]))
            .onAction("touch") { state in
                state.title = "t"
            }
            .build()
        let instance = try! ModuleInstance(definition: def)

        // `.pinboard(x: "x", y: "y").bind(@state.notes)` on a Note that
        // declares no x/y: the write lands in the map...
        instance.dispatchAction(HypenDnd.pinAction, payload: ["path": "notes.0", "x": 40, "y": 60])
        let pinnedNote = (instance.getState()["notes"] as? [Any])?.first as? [String: Any]
        XCTAssertEqual(pinnedNote?["x"] as? Int, 40)

        // ...and the next typed round-trip cannot keep it (documented
        // hazard, design §6.6). The SHOULD guard makes that loud, once.
        instance.dispatchAction("touch")
        instance.dispatchAction("touch")

        let note = (instance.getState()["notes"] as? [Any])?.first as? [String: Any]
        XCTAssertNil(note?["x"], "encoding without x drops the field (this is the hazard the warning reports)")
        XCTAssertEqual(handler.warnings.filter { $0.contains("`notes.0.x`") }.count, 1, "warn once per path: \(handler.warnings)")
        XCTAssertEqual(handler.warnings.filter { $0.contains("`notes.0.y`") }.count, 1, "warn once per path: \(handler.warnings)")
    }

    func testDroppedKeyWarningCanBeSwitchedOff() {
        TypedStateSyncConfig.shared.warnOnDroppedKeys = false
        defer { TypedStateSyncConfig.shared.warnOnDroppedKeys = true }

        let def = hypen(DndBoardState(notes: [DndNote(id: "n1", text: "one")]))
            .onAction("touch") { state in
                state.title = "t"
            }
            .build()
        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction(HypenDnd.pinAction, payload: ["path": "notes.0", "x": 1, "y": 2])
        instance.dispatchAction("touch")

        XCTAssertTrue(handler.warnings.allSatisfy { !$0.contains("dropped") }, "\(handler.warnings)")
    }

    func testTypedReconnectRestorePreservesDnd() {
        let def = hypen(DndBoardState(title: "Board", notes: [DndNote(id: "n1", text: "one")]))
            .onReconnect { _, restore in
                // The typed value cannot mention `__dnd`; restoring through
                // it must not wipe the live reserved subtree (plan §3).
                restore(DndBoardState(title: "Restored", notes: [DndNote(id: "n1", text: "kept")]))
            }
            .build()
        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction(
            HypenDnd.pinAction,
            payload: ["path": "__dnd.board.n1", "x": 296, "y": 200]
        )
        assertJSONEqual(instance.getState()["__dnd"], Self.pinnedN1)

        instance.handleReconnect(session: SessionInfo(id: "s-typed"), savedState: ["title": "Saved"])

        let state = instance.getState()
        XCTAssertEqual(state["title"] as? String, "Restored")
        let notes = state["notes"] as? [Any]
        XCTAssertEqual((notes?.first as? [String: Any])?["text"] as? String, "kept")
        assertJSONEqual(state["__dnd"], Self.pinnedN1, "typed restore keeps runtime-owned keys")
    }

    func testRawReconnectRestoreReplacesExactly() {
        // `onReconnectRaw` hands the author the whole map: what they pass is
        // what the instance holds, reserved keys included or not.
        let def = hypen(DndBoardState(title: "Board"))
            .onReconnectRaw { _, restore in
                restore(["title": "Raw", "notes": [String]()])
            }
            .build()
        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction(HypenDnd.pinAction, payload: ["path": "__dnd.board.n1", "x": 1, "y": 2])
        XCTAssertNotNil(instance.getState()["__dnd"])

        instance.handleReconnect(session: SessionInfo(id: "s-raw"), savedState: [:])

        XCTAssertEqual(instance.getState()["title"] as? String, "Raw")
        XCTAssertNil(instance.getState()["__dnd"], "raw restore is an exact replace")
    }

    func testDefaultReconnectRestoreCarriesSavedDnd() {
        let def = hypen(DndBoardState(title: "Board")).build()
        let instance = try! ModuleInstance(definition: def)

        instance.handleReconnect(
            session: SessionInfo(id: "s-default"),
            savedState: ["title": "Saved", "notes": [String](), "__dnd": Self.pinnedN1]
        )

        XCTAssertEqual(instance.getState()["title"] as? String, "Saved")
        assertJSONEqual(instance.getState()["__dnd"], Self.pinnedN1)
    }

    func testLifecycleHandlersPreserveDndToo() {
        let seenTitle = TestCounter<String?>(nil)
        let def = hypen(DndBoardState(title: "Board"))
            .onActivated { state, _ in
                state.title = "active"
            }
            .onDeactivated { state, _ in
                seenTitle.set(state.title)
            }
            .build()
        let instance = try! ModuleInstance(definition: def)
        instance.dispatchAction(HypenDnd.pinAction, payload: ["path": "__dnd.board.n1", "x": 1, "y": 2])

        instance.activate()
        instance.deactivate()

        XCTAssertEqual(seenTitle.current, "active")
        assertJSONEqual(instance.getState()["__dnd"], ["board": ["n1": ["x": 1, "y": 2]]])
    }
}

// MARK: - F. End to end on the native engine: pin -> SetProp translateX.0/translateY.0

final class NativeDndPinRenderTests: XCTestCase {

    func testPinOnAReservedModePinboardReResolvesExactlyThePinnedNode() throws {
        let engine = try NativeEngine()
        engine.registerPrimitive("Note")

        let def = AppBuilder(
            ["notes": [["id": "n1", "text": "one"], ["id": "n2", "text": "two"]]],
            options: ModuleOptions(name: "Board")
        ).build()
        let instance = ModuleInstance(definition: def, engine: engine)

        let received = TestPatchLog()
        instance.onPatches { received.append(contentsOf: $0) }

        let initial = try engine.renderSource("""
            module Board {
                Stack {
                    ForEach(items: @state.notes, key: "id") {
                        Note("@{item.text}").draggable()
                    }
                }.pinboard(group: "board")
            }
        """)

        // Wire contract (fixtures/dnd/pinboard-reserved-lowering.json): both
        // Notes carry the injected translate bindings, resolving to explicit
        // null while the reserved path is unset.
        let noteCreates = initial.filter {
            ($0["type"] as? String) == "create" && ($0["elementType"] as? String) == "Note"
        }
        XCTAssertEqual(noteCreates.count, 2, "creates: \(initial.map { "\($0["type"] ?? ""):\($0["elementType"] ?? "")" })")
        guard let n1 = noteCreates.first(where: {
            (($0["props"] as? [String: Any])?["__dnd.key"] as? String) == "n1"
        }), let n1Props = n1["props"] as? [String: Any], let n1Id = n1["id"] as? String else {
            return XCTFail("no Note create carrying __dnd.key = n1: \(noteCreates)")
        }
        XCTAssertEqual(n1Props["__dnd.pinGroup"] as? String, "board")
        XCTAssertTrue(n1Props.keys.contains("translateX.0"), "translateX.0 present on Create: \(n1Props.keys)")
        XCTAssertTrue(n1Props["translateX.0"] is NSNull, "unset reserved path resolves to explicit null")
        received.clear()

        // The renderer's drop outcome.
        instance.dispatchAction(
            HypenDnd.pinAction,
            payload: ["path": "__dnd.board.n1", "x": 120, "y": 80, "xKey": "x", "yKey": "y"]
        )

        assertJSONEqual(instance.getState()["__dnd"], ["board": ["n1": ["x": 120, "y": 80]]])
        let patches = received.all
        XCTAssertFalse(patches.isEmpty, "the pin must produce patches")
        XCTAssertTrue(
            patches.allSatisfy { ($0["type"] as? String) == "setProp" },
            "nothing structural: \(patches.map { $0["type"] ?? "" })"
        )
        var byName: [String: Any] = [:]
        for patch in patches {
            if let name = patch["name"] as? String, let value = patch["value"] {
                byName[name] = value
            }
        }
        XCTAssertEqual(byName["translateX.0"] as? Int, 120, "setProps: \(patches)")
        XCTAssertEqual(byName["translateY.0"] as? Int, 80, "setProps: \(patches)")
        XCTAssertTrue(
            patches.allSatisfy { ($0["id"] as? String) == n1Id },
            "only the pinned node re-resolves: \(patches)"
        )
    }
}
