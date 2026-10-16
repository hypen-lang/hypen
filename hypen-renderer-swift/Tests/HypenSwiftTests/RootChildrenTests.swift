import Testing
@testable import HypenSwift

// MARK: - RootChildren (the "root" mount container's ordered children)
//
// Pure, Foundation-only bookkeeping behind `HypenRenderer.rootIds`. The engine
// emits several root-level nodes when control flow (Router / If / ForEach)
// sits at the IR root with siblings (see hypen-engine-rs/tests/
// test_control_flow_order.rs, `root_*`): Insert / Move / Attach address the
// "root" sentinel with a `beforeId` anchor, Remove / Detach drop one root
// child. Semantics mirror the DOM renderer (the mount container's
// `insertBefore` / `appendChild`) and the desktop renderer's `Tree`
// (`insert_at`: anchor absent ⇒ append).

@Test func rootChildrenTwoSiblingsKeepPatchOrder() {
    var roots = RootChildren()
    roots.place("a", before: nil)
    roots.place("b", before: nil)
    #expect(roots.ids == ["a", "b"])
}

@Test func rootChildrenInsertWithBeforeIdLandsBeforeAnchor() {
    var roots = RootChildren()
    roots.place("body", before: nil)
    // An If at the root turning on lands its content before its sibling.
    roots.place("banner", before: "body")
    #expect(roots.ids == ["banner", "body"])
    roots.place("c", before: "body")
    #expect(roots.ids == ["banner", "c", "body"])
}

@Test func rootChildrenUnknownAnchorAppends() {
    var roots = RootChildren()
    roots.place("a", before: nil)
    roots.place("b", before: "ghost")
    #expect(roots.ids == ["a", "b"])
}

@Test func rootChildrenMoveRepositionsAtRoot() {
    var roots = RootChildren()
    for id in ["banner", "a", "b", "c", "footer"] { roots.place(id, before: nil) }
    // Reversing a root ForEach: Moves anchor on the following sibling.
    roots.place("c", before: "a")
    roots.place("b", before: "a")
    #expect(roots.ids == ["banner", "c", "b", "a", "footer"])
    // A Move with no anchor goes to the end, even when already present.
    roots.place("banner", before: nil)
    #expect(roots.ids == ["c", "b", "a", "footer", "banner"])
    // Anchoring on itself never duplicates.
    roots.place("a", before: "a")
    #expect(roots.ids.filter { $0 == "a" }.count == 1)
    #expect(roots.count == 5)
}

@Test func rootChildrenDetachThenAttachWithBeforeId() {
    var roots = RootChildren()
    roots.place("route", before: nil)
    roots.place("footer", before: nil)
    #expect(roots.unlink("route") == true)
    #expect(roots.ids == ["footer"])
    // Router cache hit: the cached subtree re-enters before its sibling.
    roots.place("route", before: "footer")
    #expect(roots.ids == ["route", "footer"])
}

@Test func rootChildrenRemoveOneOfSeveral() {
    var roots = RootChildren()
    for id in ["a", "b", "c"] { roots.place(id, before: nil) }
    #expect(roots.unlink("b") == true)
    #expect(roots.ids == ["a", "c"])
    #expect(roots.unlink("b") == false)
    #expect(roots.unlink("ghost") == false)
    #expect(roots.ids == ["a", "c"])
}

@Test func rootChildrenSingleRootUnchanged() {
    var roots = RootChildren()
    #expect(roots.isEmpty)
    #expect(roots.first == nil)
    // Legacy: the first Create becomes the implicit root (tests and hosts
    // that drive a single tree without a root-level Insert).
    roots.adoptIfEmpty("col")
    #expect(roots.ids == ["col"])
    roots.adoptIfEmpty("other")
    #expect(roots.ids == ["col"])
    // The engine's own Insert(root) of that node is idempotent.
    roots.place("col", before: nil)
    #expect(roots.ids == ["col"])
    #expect(roots.first == "col")
    // Router swap at the root: the new route enters, the old detaches.
    roots.place("route2", before: nil)
    roots.unlink("col")
    #expect(roots.ids == ["route2"])
    roots.removeAll()
    #expect(roots.isEmpty)
}

@Test func rootChildrenPlaceholderOnlyBeforeFirstRoot() {
    var roots = RootChildren()
    #expect(roots.showsPlaceholder)
    // Unlinking / clearing before anything mounted keeps the placeholder.
    roots.unlink("ghost")
    roots.removeAll()
    #expect(roots.showsPlaceholder)

    roots.place("banner", before: nil)
    #expect(!roots.showsPlaceholder)
    // A root If turning off empties the list: render nothing, not loading.
    roots.unlink("banner")
    #expect(roots.isEmpty)
    #expect(!roots.showsPlaceholder)
    // A renderer reset (initialTree replay) does not flash loading either.
    roots.removeAll()
    #expect(!roots.showsPlaceholder)
}

@Test func rootChildrenImplicitRootCountsAsMounted() {
    var roots = RootChildren()
    roots.adoptIfEmpty("col")
    #expect(!roots.showsPlaceholder)
}

@Test func rootChildrenImplicitRootLeavesWhenLinkedUnderAParent() {
    var roots = RootChildren()
    // A child created before its parent was adopted as the implicit root;
    // linking it under a real parent takes it back out.
    roots.adoptIfEmpty("text")
    roots.unlink("text")
    roots.place("col", before: nil)
    #expect(roots.ids == ["col"])
}

/// The engine's `root_if_children_keep_order_before_root_sibling` stream,
/// replayed through the root list.
@Test func rootChildrenEngineRootIfStream() {
    var roots = RootChildren()
    roots.place("a", before: nil)
    roots.place("b", before: nil)
    roots.place("footer", before: nil)
    roots.place("banner", before: "a")
    #expect(roots.ids == ["banner", "a", "b", "footer"])
    roots.place("c", before: "footer")
    roots.place("c", before: "a")
    roots.place("b", before: "a")
    #expect(roots.ids == ["banner", "c", "b", "a", "footer"])
    for id in ["banner", "c", "b", "a", "footer"] { roots.unlink(id) }
    #expect(roots.isEmpty)
    #expect(!roots.showsPlaceholder)
}
