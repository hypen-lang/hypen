import Combine
import Testing
@testable import HypenSwift

/// A patch batch publishes each changed element once, when the batch ends,
/// and a child's prop change re-renders its host only when the host's body
/// actually reads that prop.
@MainActor
@Suite("Batch publication and host notification")
struct BatchPublicationTests {
    private func mountList(_ renderer: HypenRenderer, rows: Int) -> [String] {
        let ids = (0..<rows).map { "row\($0)" }
        var patches: [Patch] = [
            Patch(type: .create, id: "list", elementType: "list"),
            Patch(type: .insert, id: "list", parentId: "root"),
        ]
        for id in ids {
            patches.append(Patch(type: .create, id: id, elementType: "text", props: ["0": id, "color.0": "#000"]))
            patches.append(Patch(type: .insert, id: id, parentId: "list"))
        }
        renderer.applyPatches(patches)
        return ids
    }

    private func publications(of element: HypenElement) -> (count: () -> Int, cancellable: AnyCancellable) {
        var n = 0
        let c = element.objectWillChange.sink { _ in n += 1 }
        return ({ n }, c)
    }

    @Test func manyPropWritesOnOneElementPublishOnce() {
        let renderer = HypenRenderer()
        _ = mountList(renderer, rows: 1)
        let row = renderer.getElement("row0")!
        let (count, cancellable) = publications(of: row)
        defer { cancellable.cancel() }

        var batch = (1...20).map { (n: Int) in Patch(type: .setProp, id: "row0", name: "style\(n)", value: n) }
        batch.append(Patch(type: .setText, id: "row0", text: "hello"))
        batch.append(Patch(type: .removeProp, id: "row0", name: "style3"))
        renderer.applyPatches(batch)

        #expect(count() == 1)
        #expect(row.props["style20"] as? Int == 20)
        #expect(row.props["style3"] == nil)
        #expect(row.textContent == "hello")
        #expect(renderer.publishBatch.pendingCount == 0)
    }

    @Test func textChangeOnARowDoesNotRepublishTheList() {
        let renderer = HypenRenderer()
        _ = mountList(renderer, rows: 3)
        let list = renderer.getElement("list")!
        let (listCount, c1) = publications(of: list)
        defer { c1.cancel() }

        renderer.applyPatches([
            Patch(type: .setProp, id: "row1", name: "0", value: "edited"),
            Patch(type: .setProp, id: "row1", name: "color.0", value: "#fff"),
            Patch(type: .setText, id: "row1", text: "edited"),
        ])
        #expect(listCount() == 0)

        // A prop the host's body reads (weight distribution) does reach it.
        renderer.applyPatches([
            Patch(type: .setProp, id: "row1", name: "weight.0", value: 2),
        ])
        #expect(listCount() == 1)
    }

    @Test func selectOptionsAlwaysReachTheirHost() {
        let renderer = HypenRenderer()
        renderer.applyPatches([
            Patch(type: .create, id: "sel", elementType: "select"),
            Patch(type: .insert, id: "sel", parentId: "root"),
            Patch(type: .create, id: "opt", elementType: "option", props: ["0": "A"]),
            Patch(type: .insert, id: "opt", parentId: "sel"),
        ])
        let select = renderer.getElement("sel")!
        let (count, c) = publications(of: select)
        defer { c.cancel() }
        renderer.applyPatches([Patch(type: .setProp, id: "opt", name: "0", value: "B")])
        #expect(count() == 1)
    }

    @Test func denseReorderLandsInTheRightOrderWithOnePublication() {
        let renderer = HypenRenderer()
        let ids = mountList(renderer, rows: 50)
        let list = renderer.getElement("list")!
        #expect(list.children == ids)
        let (count, c) = publications(of: list)
        defer { c.cancel() }

        // Reverse the list with one move per row: each row moves in front
        // of the row that was moved before it, so the head keeps changing.
        let reversed = Array(ids.reversed())
        let moves = (1..<ids.count).map { k in
            Patch(type: .move, id: ids[k], parentId: "list", beforeId: ids[k - 1])
        }
        renderer.applyPatches(moves)

        #expect(list.children == reversed)
        #expect(renderer.getChildren(of: "list").map(\.id) == reversed)
        #expect(count() == 1)
    }

    @Test func childOrderOperations() {
        let order = HypenChildOrder(["a", "b", "c"])
        order.insert("x", before: "b")
        #expect(order.ids == ["a", "x", "b", "c"])
        order.insert("c", before: "a")
        #expect(order.ids == ["c", "a", "x", "b"])
        #expect(order.remove("x"))
        #expect(!order.remove("x"))
        order.append("a")
        #expect(order.ids == ["c", "b", "a"])
        order.insert("q", before: "missing")
        #expect(order.ids == ["c", "b", "a", "q"])
        #expect(order.count == 4)
    }

    @Test func removeAfterInsertInTheSameBatchSeesTheNewOrder() {
        let renderer = HypenRenderer()
        _ = mountList(renderer, rows: 2)
        renderer.applyPatches([
            Patch(type: .create, id: "row2", elementType: "text", props: ["0": "row2"]),
            Patch(type: .insert, id: "row2", parentId: "list", beforeId: "row0"),
            Patch(type: .remove, id: "row1"),
        ])
        #expect(renderer.getElement("list")!.children == ["row2", "row0"])
        #expect(renderer.getElement("row1") == nil)
    }
}
