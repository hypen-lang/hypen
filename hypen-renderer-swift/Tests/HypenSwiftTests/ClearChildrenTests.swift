import Foundation
import Testing
@testable import HypenSwift

// MARK: - clearChildren
//
// Contract: hypen-web/docs/clear-children.md. Applying
// `{ "type": "clearChildren", "id": P }` is exactly a plain `remove` (no
// transition) of each of P's current children, in order: every child
// subtree leaves every renderer table, P keeps its props and can take new
// children in the same batch, and an unknown id is ignored.

/// Records `onElementRemoved` in order, so teardown can be compared
/// between a `clearChildren` and the equivalent per-child removes.
private final class RemovalRecorder: RendererStateListener {
    var removed: [String] = []
    func onElementCreated(_ element: HypenElement) {}
    func onElementRemoved(id: String) { removed.append(id) }
    func onTreeChanged() {}
}

/// `screen > header, list > [r0 > t0, r1 > (t1, box1 > deep1), r2 > t2]`.
private func listTreePatches() -> [Patch] {
    [
        Patch(type: .create, id: "screen", elementType: "column"),
        Patch(type: .insert, id: "screen", parentId: "root"),
        Patch(type: .create, id: "header", elementType: "text", props: ["0": "Header"]),
        Patch(type: .insert, id: "header", parentId: "screen"),
        Patch(type: .create, id: "list", elementType: "column", props: ["padding": 8]),
        Patch(type: .insert, id: "list", parentId: "screen"),

        Patch(type: .create, id: "r0", elementType: "row"),
        Patch(type: .insert, id: "r0", parentId: "list"),
        Patch(type: .create, id: "t0", elementType: "text", props: ["0": "zero"]),
        Patch(type: .insert, id: "t0", parentId: "r0"),

        Patch(type: .create, id: "r1", elementType: "row"),
        Patch(type: .insert, id: "r1", parentId: "list"),
        Patch(type: .create, id: "t1", elementType: "text", props: ["0": "one"]),
        Patch(type: .insert, id: "t1", parentId: "r1"),
        Patch(type: .create, id: "box1", elementType: "box"),
        Patch(type: .insert, id: "box1", parentId: "r1"),
        Patch(type: .create, id: "deep1", elementType: "text"),
        Patch(type: .insert, id: "deep1", parentId: "box1"),

        Patch(type: .create, id: "r2", elementType: "row"),
        Patch(type: .insert, id: "r2", parentId: "list"),
        Patch(type: .create, id: "t2", elementType: "text", props: ["0": "two"]),
        Patch(type: .insert, id: "t2", parentId: "r2"),
    ]
}

/// `{150, easeIn, [fade]}` — the `.exit` defaults.
private var exitFadeSpec: [String: Any] {
    ["curve": "easeIn", "duration": 150, "presets": ["fade"]]
}

private let clearedIds = ["r0", "t0", "r1", "t1", "box1", "deep1", "r2", "t2"]

@MainActor
private func sortedElementIds(_ renderer: HypenRenderer) -> [String] {
    renderer.getAllElements().map(\.id).sorted()
}

// MARK: - Wire

@Test func testPatchFromClearChildrenDictionary() {
    let patch = Patch.from(dictionary: ["type": "clearChildren", "id": "4294967301"])

    #expect(patch != nil)
    #expect(patch?.type == .clearChildren)
    #expect(patch?.id == "4294967301")
    #expect(patch?.parentId == nil)
    #expect(patch?.beforeId == nil)
    #expect(patch?.transition == false)
}

@Test func testPatchFromClearChildrenCapitalizedDictionary() {
    let patch = Patch.from(dictionary: ["type": "ClearChildren", "id": "list"])
    #expect(patch?.type == .clearChildren)
    #expect(patch?.id == "list")
}

@Test func testPatchArrayDecodesClearChildrenInOrder() {
    let patches = Patch.fromArray([
        ["type": "clearChildren", "id": "list"],
        ["type": "create", "id": "n", "elementType": "text"],
        ["type": "insert", "id": "n", "parentId": "list"],
    ])
    #expect(patches.map(\.type) == [.clearChildren, .create, .insert])
}

@Test func testClearChildrenPatchTypeCodableRoundTrip() throws {
    #expect(PatchType.clearChildren.rawValue == "ClearChildren")
    let data = try JSONEncoder().encode([PatchType.clearChildren])
    #expect(String(data: data, encoding: .utf8) == "[\"ClearChildren\"]")
    let decoded = try JSONDecoder().decode([PatchType].self, from: data)
    #expect(decoded == [.clearChildren])
}

@Test func testClearChildrenDebugDescription() {
    #expect(Patch(type: .clearChildren, id: "list").debugDescription == "CLEAR_CHILDREN(list)")
}

// MARK: - Application

@Test func testClearChildrenRemovesEveryChildAndDescendant() async {
    await MainActor.run {
        let renderer = HypenRenderer()
        let recorder = RemovalRecorder()
        renderer.listener = recorder
        renderer.applyPatches(listTreePatches())

        renderer.applyPatches([Patch(type: .clearChildren, id: "list")])

        for id in clearedIds {
            #expect(renderer.getElement(id) == nil, "\(id) should be gone")
        }
        #expect(Set(recorder.removed) == Set(clearedIds))
        #expect(recorder.removed.count == clearedIds.count)
        #expect(sortedElementIds(renderer) == ["header", "list", "screen"])
        #expect(renderer.detachedIds.isEmpty)
        for id in clearedIds {
            #expect(!renderer.animator.isExiting(id))
        }

        // The parent survives, still linked under its own parent, props intact.
        let list = renderer.getElement("list")
        #expect(list != nil)
        #expect(list?.children.isEmpty == true)
        #expect(list?.parentId == "screen")
        #expect(list?.props["padding"] as? Int == 8)
        #expect(renderer.getElement("screen")?.children == ["header", "list"])
        #expect(renderer.rootIds == ["screen"])
        #expect(renderer.getChildren(of: "list").isEmpty)
    }
}

@Test func testClearChildrenThenFillInTheSameBatch() async {
    await MainActor.run {
        let renderer = HypenRenderer()
        renderer.applyPatches(listTreePatches())

        // Wholesale replace: the engine positions the clear first.
        renderer.applyPatches([
            Patch(type: .clearChildren, id: "list"),
            Patch(type: .create, id: "n0", elementType: "row"),
            Patch(type: .insert, id: "n0", parentId: "list"),
            Patch(type: .create, id: "n1", elementType: "row"),
            Patch(type: .insert, id: "n1", parentId: "list"),
            Patch(type: .create, id: "n0t", elementType: "text"),
            Patch(type: .insert, id: "n0t", parentId: "n0"),
            Patch(type: .create, id: "n2", elementType: "row"),
            Patch(type: .insert, id: "n2", parentId: "list", beforeId: "n1"),
        ])

        #expect(renderer.getElement("list")?.children == ["n0", "n2", "n1"])
        #expect(renderer.getElement("n0")?.parentId == "list")
        #expect(renderer.getElement("n0")?.children == ["n0t"])
        for id in clearedIds {
            #expect(renderer.getElement(id) == nil)
        }
        #expect(sortedElementIds(renderer)
                == ["header", "list", "n0", "n0t", "n1", "n2", "screen"])
    }
}

@Test func testClearChildrenReusedIdIsAFreshElement() async {
    await MainActor.run {
        let renderer = HypenRenderer()
        renderer.applyPatches(listTreePatches())
        let before = renderer.getElement("r0")

        renderer.applyPatches([
            Patch(type: .clearChildren, id: "list"),
            Patch(type: .create, id: "r0", elementType: "text", props: ["0": "new"]),
            Patch(type: .insert, id: "r0", parentId: "list"),
        ])

        let after = renderer.getElement("r0")
        #expect(after != nil)
        #expect(after !== before)
        #expect(after?.elementType == "text")
        #expect(after?.children.isEmpty == true)
        #expect(renderer.getElement("t0") == nil)
        #expect(renderer.getElement("list")?.children == ["r0"])
    }
}

@Test func testClearChildrenUnknownIdIsANoOp() async {
    await MainActor.run {
        let renderer = HypenRenderer()
        let recorder = RemovalRecorder()
        renderer.listener = recorder
        renderer.applyPatches(listTreePatches())
        let before = sortedElementIds(renderer)

        renderer.applyPatches([
            Patch(type: .clearChildren, id: "does-not-exist"),
            Patch(type: .clearChildren),  // missing id
        ])

        #expect(sortedElementIds(renderer) == before)
        #expect(recorder.removed.isEmpty)
        #expect(renderer.getElement("list")?.children == ["r0", "r1", "r2"])
        #expect(renderer.rootIds == ["screen"])
    }
}

@Test func testClearChildrenOfALeafIsANoOp() async {
    await MainActor.run {
        let renderer = HypenRenderer()
        renderer.applyPatches(listTreePatches())
        let before = sortedElementIds(renderer)

        renderer.applyPatches([Patch(type: .clearChildren, id: "deep1")])

        #expect(sortedElementIds(renderer) == before)
        #expect(renderer.getElement("deep1") != nil)
    }
}

@Test func testClearChildrenEqualsAPlainRemovePerChild() async {
    await MainActor.run {
        let cleared = HypenRenderer()
        let clearedRecorder = RemovalRecorder()
        cleared.listener = clearedRecorder
        cleared.applyPatches(listTreePatches())

        let removed = HypenRenderer()
        let removedRecorder = RemovalRecorder()
        removed.listener = removedRecorder
        removed.applyPatches(listTreePatches())

        cleared.applyPatches([Patch(type: .clearChildren, id: "list")])
        removed.applyPatches([
            Patch(type: .remove, id: "r0"),
            Patch(type: .remove, id: "r1"),
            Patch(type: .remove, id: "r2"),
        ])

        #expect(sortedElementIds(cleared) == sortedElementIds(removed))
        // Same teardown, same order.
        #expect(clearedRecorder.removed == removedRecorder.removed)
        #expect(cleared.getElement("list")?.children == removed.getElement("list")?.children)
        #expect(cleared.getElement("screen")?.children == removed.getElement("screen")?.children)
        #expect(cleared.rootIds == removed.rootIds)
        #expect(cleared.detachedIds == removed.detachedIds)
    }
}

@Test func testClearChildrenUnderAControlFlowWrapper() async {
    await MainActor.run {
        let renderer = HypenRenderer()
        renderer.applyPatches([
            Patch(type: .create, id: "host", elementType: "list"),
            Patch(type: .insert, id: "host", parentId: "root"),
            Patch(type: .create, id: "each", elementType: "__ForEach"),
            Patch(type: .insert, id: "each", parentId: "host"),
            Patch(type: .create, id: "a", elementType: "text"),
            Patch(type: .insert, id: "a", parentId: "each"),
            Patch(type: .create, id: "b", elementType: "text"),
            Patch(type: .insert, id: "b", parentId: "each"),
        ])

        renderer.applyPatches([Patch(type: .clearChildren, id: "each")])

        #expect(renderer.getElement("each")?.children.isEmpty == true)
        #expect(renderer.getElement("host")?.children == ["each"])
        #expect(renderer.getElement("a") == nil)
        #expect(renderer.getElement("b") == nil)
    }
}

/// A child still on screen only because it is playing an exit from an
/// EARLIER `remove { transition: true }` is already dead to the engine.
/// This renderer lets the exit finish (allowed by the contract): the
/// corpse stays until its finalize, every other child goes at once.
@Test func testClearChildrenLetsAnEarlierExitFinish() async {
    await MainActor.run {
        let renderer = HypenRenderer()
        let clock = HypenManualAnimationScheduler()
        renderer.animator.scheduler = clock
        renderer.animator.reducedMotionOverride = false
        // The first-ever batch is suppressed for animation; settle it.
        renderer.applyPatches([Patch(type: .create, id: "__seed", elementType: "column")])

        renderer.applyPatches([
            Patch(type: .create, id: "list", elementType: "column"),
            Patch(type: .create, id: "gone", elementType: "row",
                  props: [HypenAnim.exitProp: exitFadeSpec]),
            Patch(type: .insert, id: "gone", parentId: "list"),
            Patch(type: .create, id: "goneLabel", elementType: "text"),
            Patch(type: .insert, id: "goneLabel", parentId: "gone"),
            Patch(type: .create, id: "a", elementType: "row"),
            Patch(type: .insert, id: "a", parentId: "list"),
            Patch(type: .create, id: "b", elementType: "row"),
            Patch(type: .insert, id: "b", parentId: "list"),
        ])
        renderer.applyPatches([Patch(type: .remove, id: "gone", transition: true)])
        #expect(renderer.animator.isExiting("gone"))

        renderer.applyPatches([
            Patch(type: .clearChildren, id: "list"),
            Patch(type: .create, id: "c", elementType: "row"),
            Patch(type: .insert, id: "c", parentId: "list"),
        ])

        #expect(renderer.getElement("a") == nil)
        #expect(renderer.getElement("b") == nil)
        #expect(renderer.getElement("gone") != nil)
        #expect(renderer.animator.isExiting("gone"))
        #expect(renderer.getElement("list")?.children == ["gone", "c"])

        // 150ms + 80ms grace: the corpse finalizes and unlinks itself.
        clock.advance(by: 0.231)
        #expect(renderer.getElement("gone") == nil)
        #expect(renderer.getElement("goneLabel") == nil)
        #expect(!renderer.animator.isExiting("gone"))
        #expect(renderer.getElement("list")?.children == ["c"])
    }
}

/// `list > [gone (exiting from an earlier flagged remove), a]`.
@MainActor
private func buildListWithExitingChild() -> HypenRenderer {
    let renderer = HypenRenderer()
    renderer.animator.scheduler = HypenManualAnimationScheduler()
    renderer.animator.reducedMotionOverride = false
    renderer.applyPatches([Patch(type: .create, id: "__seed", elementType: "column")])
    renderer.applyPatches([
        Patch(type: .create, id: "list", elementType: "column"),
        Patch(type: .create, id: "gone", elementType: "row",
              props: [HypenAnim.exitProp: exitFadeSpec]),
        Patch(type: .insert, id: "gone", parentId: "list"),
        Patch(type: .create, id: "a", elementType: "row"),
        Patch(type: .insert, id: "a", parentId: "list"),
    ])
    renderer.applyPatches([Patch(type: .remove, id: "gone", transition: true)])
    return renderer
}

/// A clear and a plain remove agree on an exiting child too: both leave
/// the earlier exit playing.
@Test func testClearChildrenMatchesPerChildRemoveWithAnExitingChild() async {
    await MainActor.run {
        let cleared = buildListWithExitingChild()
        let removed = buildListWithExitingChild()
        cleared.applyPatches([Patch(type: .clearChildren, id: "list")])
        removed.applyPatches([Patch(type: .remove, id: "gone"), Patch(type: .remove, id: "a")])

        #expect(sortedElementIds(cleared) == sortedElementIds(removed))
        #expect(cleared.getElement("list")?.children == removed.getElement("list")?.children)
        #expect(cleared.animator.isExiting("gone") == removed.animator.isExiting("gone"))
    }
}
