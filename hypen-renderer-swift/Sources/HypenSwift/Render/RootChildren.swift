import Foundation

/// The ordered children of the `"root"` mount container.
///
/// The engine addresses the top-level mount point with the `"root"` parent
/// sentinel. Usually exactly one node sits there, but when control flow
/// (Router / If / ForEach) is at the IR root with siblings the engine places
/// several, anchored with `beforeId` exactly like children of an element:
/// `Insert` / `Move` / `Attach { parentId: "root", id, beforeId }`, and
/// `Remove` / `Detach` of one root child (see
/// `hypen-engine-rs/tests/test_control_flow_order.rs`, `root_*`).
///
/// Semantics match the DOM renderer (the mount container's `insertBefore` /
/// `appendChild`) and the desktop renderer's `Tree::insert_at`:
/// - placing an id first unlinks it, so it never appears twice;
/// - it lands before `beforeId` when that anchor is a root child, otherwise
///   (no anchor, or an unknown one) at the end;
/// - unlinking drops just that id and keeps the others' order.
///
/// Hosts stack the children vertically in this order inside one
/// always-present container (`HypenRootChildrenView`), so going between one
/// and several roots never changes a surviving child's view identity.
///
/// `showsPlaceholder` is true only until a root child has ever been placed:
/// hosts show their loading content then, and afterwards an empty root list
/// (e.g. a root `If` that turned off) renders nothing.
///
/// Pure Foundation so it builds and tests on Linux; `HypenRenderer` owns one.
struct RootChildren: Equatable {
    /// The parent id the engine uses for the mount container.
    static let sentinel = "root"

    private(set) var ids: [String] = []

    /// Whether a root child has ever been placed (sticky: survives the list
    /// emptying and `removeAll`, so a renderer reset replaying the tree does
    /// not flash the loading content).
    private(set) var hasMounted = false

    /// Hosts show loading / placeholder content only before the first root
    /// child ever arrives; afterwards an empty root list renders nothing.
    var showsPlaceholder: Bool { !hasMounted }

    var isEmpty: Bool { ids.isEmpty }
    var count: Int { ids.count }
    var first: String? { ids.first }

    func contains(_ id: String) -> Bool { ids.contains(id) }

    /// Legacy implicit root: the first created element becomes the root when
    /// nothing is mounted yet, for hosts and tests that drive a single tree
    /// without a root-level `Insert`. The engine's own `Insert(root)` of the
    /// same node is then a no-op re-place, and linking it under a real parent
    /// takes it back out (`unlink`).
    mutating func adoptIfEmpty(_ id: String) {
        if ids.isEmpty {
            ids.append(id)
            hasMounted = true
        }
    }

    /// `Insert` / `Move` / `Attach` at the root: unlink `id`, then insert it
    /// before `beforeId` (append when the anchor is nil or not a root child).
    mutating func place(_ id: String, before beforeId: String?) {
        ids.removeAll { $0 == id }
        if let beforeId, let index = ids.firstIndex(of: beforeId) {
            ids.insert(id, at: index)
        } else {
            ids.append(id)
        }
        hasMounted = true
    }

    /// `Remove` / `Detach` of a root child, or a root child being linked under
    /// a real parent. Returns whether `id` was a root child.
    @discardableResult
    mutating func unlink(_ id: String) -> Bool {
        guard let index = ids.firstIndex(of: id) else { return false }
        ids.remove(at: index)
        return true
    }

    mutating func removeAll() {
        ids.removeAll()
    }
}
