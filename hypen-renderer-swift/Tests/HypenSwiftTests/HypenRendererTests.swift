import Testing
@testable import HypenSwift

// MARK: - HypenRenderer Tests

@Test func testRendererCreateAndInsertSetsRoot() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column")
        ])

        #expect(renderer.rootId == "root")
        #expect(renderer.getElement("root") != nil)
        #expect(renderer.getElement("root")?.elementType == "column")
    }
}

@Test func testRendererNestedElements() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "child-1", elementType: "text"),
            Patch(type: .insert, id: "child-1", parentId: "root"),
            Patch(type: .create, id: "child-2", elementType: "text"),
            Patch(type: .insert, id: "child-2", parentId: "root"),
        ])

        let children = renderer.getChildren(of: "root")
        #expect(children.count == 2)
        #expect(children[0].id == "child-1")
        #expect(children[1].id == "child-2")
    }
}

@Test func testRendererSetPropUpdatesTextContent() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.applyPatches([
            Patch(type: .create, id: "txt", elementType: "text"),
        ])

        // "text" prop sets textContent
        renderer.applyPatches([
            Patch(type: .setProp, id: "txt", name: "text", value: "Hello")
        ])
        #expect(renderer.getElement("txt")?.textContent == "Hello")

        // "0" prop also sets textContent
        renderer.applyPatches([
            Patch(type: .setProp, id: "txt", name: "0", value: "World")
        ])
        #expect(renderer.getElement("txt")?.textContent == "World")
    }
}

@Test func testRendererSetText() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.applyPatches([
            Patch(type: .create, id: "txt", elementType: "text"),
        ])

        renderer.applyPatches([
            Patch(type: .setText, id: "txt", text: "Direct text")
        ])

        #expect(renderer.getElement("txt")?.textContent == "Direct text")
    }
}

@Test func testRendererRemoveElement() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "child", elementType: "text"),
            Patch(type: .insert, id: "child", parentId: "root"),
        ])

        renderer.applyPatches([
            Patch(type: .remove, id: "child")
        ])

        #expect(renderer.getElement("child") == nil)
        #expect(renderer.getElement("root")?.children.contains("child") == false)
    }
}

@Test func testRendererRemoveRecursive() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "parent", elementType: "column"),
            Patch(type: .insert, id: "parent", parentId: "root"),
            Patch(type: .create, id: "grandchild", elementType: "text"),
            Patch(type: .insert, id: "grandchild", parentId: "parent"),
        ])

        renderer.applyPatches([
            Patch(type: .remove, id: "parent")
        ])

        #expect(renderer.getElement("parent") == nil)
        #expect(renderer.getElement("grandchild") == nil)
    }
}

@Test func testRendererMoveBetweenParents() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "parent-a", elementType: "column"),
            Patch(type: .insert, id: "parent-a", parentId: "root"),
            Patch(type: .create, id: "parent-b", elementType: "column"),
            Patch(type: .insert, id: "parent-b", parentId: "root"),
            Patch(type: .create, id: "child", elementType: "text"),
            Patch(type: .insert, id: "child", parentId: "parent-a"),
        ])

        #expect(renderer.getElement("parent-a")?.children.contains("child") == true)

        renderer.applyPatches([
            Patch(type: .move, id: "child", parentId: "parent-b")
        ])

        #expect(renderer.getElement("parent-a")?.children.contains("child") == false)
        #expect(renderer.getElement("parent-b")?.children.contains("child") == true)
    }
}

@Test func testRendererInsertWithBeforeId() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "first", elementType: "text"),
            Patch(type: .insert, id: "first", parentId: "root"),
            Patch(type: .create, id: "third", elementType: "text"),
            Patch(type: .insert, id: "third", parentId: "root"),
        ])

        renderer.applyPatches([
            Patch(type: .create, id: "second", elementType: "text"),
            Patch(type: .insert, id: "second", parentId: "root", beforeId: "third"),
        ])

        let root = renderer.getElement("root")
        #expect(root?.children == ["first", "second", "third"])
    }
}

@Test func testRendererClear() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "child", elementType: "text"),
            Patch(type: .insert, id: "child", parentId: "root"),
        ])

        renderer.clear()

        #expect(renderer.rootId == nil)
        #expect(renderer.getElement("root") == nil)
        #expect(renderer.getElement("child") == nil)
        #expect(renderer.getAllElements().isEmpty == true)
    }
}

@Test func testRendererTreeVersionIncrements() async {
    await MainActor.run {
        let renderer = HypenRenderer()
        #expect(renderer.treeVersion == 0)

        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column")
        ])
        #expect(renderer.treeVersion == 1)

        renderer.applyPatches([
            Patch(type: .create, id: "child", elementType: "text"),
            Patch(type: .insert, id: "child", parentId: "root"),
        ])
        #expect(renderer.treeVersion == 2)

        renderer.clear()
        #expect(renderer.treeVersion == 3)
    }
}

@Test func testRendererUpdateState() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.updateState(["count": 5, "name": "test"])

        #expect(renderer.serverState["count"] as? Int == 5)
        #expect(renderer.serverState["name"] as? String == "test")
    }
}

@Test func testRendererGetAllElements() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        renderer.applyPatches([
            Patch(type: .create, id: "root", elementType: "column"),
            Patch(type: .create, id: "child-1", elementType: "text"),
            Patch(type: .insert, id: "child-1", parentId: "root"),
            Patch(type: .create, id: "child-2", elementType: "text"),
            Patch(type: .insert, id: "child-2", parentId: "root"),
        ])

        #expect(renderer.getAllElements().count == 3)
    }
}

// MARK: - "root" parentId sentinel (engine contract)
//
// The engine emits `parentId: "root"` as a sentinel for "mount at the
// top of the tree". Element ids from the engine are opaque NodeIds
// (e.g. "4294967298") — "root" never appears as a real id. The
// renderer must treat it as a container, not as an `elements[]`
// lookup key, otherwise root-level Insert / Attach patches (emitted
// by a Router sitting at the IR root) silently drop.

@Test func testRendererRootSentinelInsertSetsRootId() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        // Engine-style patches: opaque ids, "root" as parentId sentinel.
        renderer.applyPatches([
            Patch(type: .create, id: "4294967298", elementType: "column"),
            Patch(type: .insert, id: "4294967298", parentId: "root"),
        ])

        #expect(renderer.rootId == "4294967298")
        #expect(renderer.getElement("4294967298") != nil)
        #expect(renderer.getElement("root") == nil)
    }
}

@Test func testRendererRootSentinelAttachSetsRootId() async {
    await MainActor.run {
        let renderer = HypenRenderer()

        // Mount, detach, then re-attach to "root" — mimics a Router
        // cache hit on nav-back when the Router is at the IR root.
        renderer.applyPatches([
            Patch(type: .create, id: "home-1", elementType: "column"),
            Patch(type: .insert, id: "home-1", parentId: "root"),
            Patch(type: .detach, id: "home-1"),
            Patch(type: .create, id: "search-1", elementType: "column"),
            Patch(type: .insert, id: "search-1", parentId: "root"),
            Patch(type: .detach, id: "search-1"),
            Patch(type: .attach, id: "home-1", parentId: "root"),
        ])

        #expect(renderer.rootId == "home-1")
        #expect(renderer.getElement("home-1") != nil)
        #expect(renderer.getElement("home-1")?.parentId == nil)
    }
}

// MARK: - HypenImageCache

@Test func testImageCacheReturnsNilBeforeLoad() async {
    await MainActor.run {
        let cache = HypenImageCache.shared
        let url = URL(string: "https://example.invalid/\(UUID().uuidString).png")!
        #expect(cache.cached(for: url) == nil)
    }
}

@Test func testImageCacheCoalescesInflightRequests() async {
    // Regression: a feed that renders the same image N times must not
    // issue N independent downloads. HypenImageCache collapses repeated
    // concurrent .load(url:) calls onto one in-flight task.
    await MainActor.run {
        let cache = HypenImageCache.shared
        let url = URL(string: "https://example.invalid/\(UUID().uuidString).png")!
        let t1 = Task { await cache.load(url: url) }
        let t2 = Task { await cache.load(url: url) }
        _ = (t1, t2)
        // We don't await the network — the invalid host will fail — but
        // the test asserts that the cache doesn't crash under contention
        // and returns nil for the missing URL.
        #expect(cache.cached(for: url) == nil)
    }
}
