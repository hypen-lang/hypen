import Foundation
import XCTest
import HypenEngine
@testable import HypenServer

/// `clearChildren` on the Swift server (contract:
/// `hypen-web/docs/clear-children.md`). The UniFFI record carries
/// `patchType == .clearChildren` with `id` set and every other field at its
/// default; the server must put `{ "type": "clearChildren", "id": … }` on the
/// wire, and nothing else.
final class ClearChildrenWireTests: XCTestCase {

    private func ffiPatch(_ type: HypenEnginePatchType, id: String) -> HypenEnginePatch {
        HypenEnginePatch(
            patchType: type, id: id, elementType: nil, propsJson: nil, name: nil,
            valueJson: nil, text: nil, parentId: nil, beforeId: nil
        )
    }

    // MARK: - Encode (engine record → wire)

    func testClearChildrenWireName() {
        XCTAssertEqual(NativeEngine.patchTypeName(.clearChildren), "clearChildren")
    }

    func testClearChildrenWireDictionaryCarriesOnlyTypeAndId() throws {
        let dict = NativeEngine.convertPatch(ffiPatch(.clearChildren, id: "4294967301"))

        XCTAssertEqual(Set(dict.keys), ["type", "id"])
        XCTAssertEqual(dict["type"] as? String, "clearChildren")
        XCTAssertEqual(dict["id"] as? String, "4294967301")

        let data = try JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
        XCTAssertEqual(
            String(data: data, encoding: .utf8),
            #"{"id":"4294967301","type":"clearChildren"}"#
        )
    }

    /// Every engine patch type has its own wire name, so a new case can
    /// never silently alias an existing one.
    func testEveryEnginePatchTypeHasADistinctWireName() {
        let all: [HypenEnginePatchType] = [
            .create, .setProp, .removeProp, .setText, .insert, .move, .remove,
            .detach, .attach, .setSemantics, .batchAnimation, .clearChildren,
        ]
        let names = all.map(NativeEngine.patchTypeName)
        XCTAssertEqual(Set(names).count, all.count)
        XCTAssertEqual(names.last, "clearChildren")
    }

    // MARK: - Decode (wire → SDK patch)

    // `Patch` / `PatchType` exist in both HypenEngine and HypenServer, so
    // the SDK's wire types are module-qualified here.
    func testClearChildrenDecodesAndReencodes() throws {
        let json = #"{"type":"clearChildren","id":"list-1"}"#
        let patch = try JSONDecoder().decode(HypenServer.Patch.self, from: Data(json.utf8))

        XCTAssertEqual(patch.type, HypenServer.PatchType.clearChildren.rawValue)
        XCTAssertEqual(patch.id, "list-1")
        XCTAssertNil(patch.parentId)
        XCTAssertNil(patch.beforeId)
        XCTAssertNil(patch.props)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let reencoded = try encoder.encode(patch)
        XCTAssertEqual(
            String(data: reencoded, encoding: .utf8),
            #"{"id":"list-1","type":"clearChildren"}"#
        )
    }

    func testClearChildrenPatchTypeRawValue() {
        XCTAssertEqual(HypenServer.PatchType(rawValue: "clearChildren"), .clearChildren)
        XCTAssertEqual(HypenServer.PatchType.clearChildren.rawValue, "clearChildren")
    }

    // MARK: - Live engine (needs the native library, like NativeEngineTests)

    /// Emptying an eager List makes the engine send one `clearChildren` for
    /// the List element instead of a `remove` per row; the server forwards
    /// it with the wire name and only `id`.
    func testEngineEmitsClearChildrenWhenAListIsEmptied() throws {
        let engine = try NativeEngine()
        let items: [[String: Any]] = (0..<5).map { ["id": "k\($0)", "name": "row \($0)"] }
        engine.setModule(
            name: "Rows",
            actions: [],
            stateKeys: ["items"],
            initialState: ["items": items]
        )
        let initial = try engine.renderSource(
            #"List(@state.items, key: "id", lazy: false) { Text("@{item.name}") }"#
        )
        let listId = initial.first {
            ($0["type"] as? String) == "create" && ($0["elementType"] as? String) == "List"
        }?["id"] as? String
        XCTAssertNotNil(listId, "initial render should create the List")

        let patches = try engine.updateState(state: ["items": [Any]()])
        let clears = patches.filter { ($0["type"] as? String) == "clearChildren" }
        XCTAssertEqual(clears.count, 1, "patches: \(patches)")
        XCTAssertEqual(clears.first?["id"] as? String, listId)
        XCTAssertEqual(clears.first.map { Set($0.keys) }, ["type", "id"])
        XCTAssertFalse(patches.contains { ($0["type"] as? String) == "remove" })
    }
}
