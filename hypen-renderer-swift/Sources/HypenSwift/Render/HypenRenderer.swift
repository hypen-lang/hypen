import Foundation
import Combine
import SwiftUI

private let log = HypenLoggers.renderer

/// Listener for render tree changes
public protocol RendererStateListener: AnyObject {
    func onElementCreated(_ element: HypenElement)
    func onElementRemoved(id: String)
    func onTreeChanged()
}

/// Main renderer that manages the Hypen element tree
@MainActor
public final class HypenRenderer: ObservableObject {

    // Element storage. Includes both attached elements (reachable
    // from `rootId` via `children`) and detached elements (unlinked
    // by a `detach` patch, kept alive in this map until `attach` or
    // `remove` arrives).
    private var elements: [String: HypenElement] = [:]

    /// IDs that have been detached but not yet re-attached or removed.
    /// Exposed read-only so a Strategy 3 upgrade (limbo container) can
    /// render them invisibly to preserve SwiftUI `@State`, focus, and
    /// scroll position across the detach → attach cycle.
    private(set) public var detachedIds: Set<String> = []

    private(set) public var rootId: String?

    // Reactive state
    @Published public private(set) var treeVersion: Int = 0
    @Published public private(set) var serverState: [String: Any] = [:]

    // Error handling
    private let errorsSubject = PassthroughSubject<Error, Never>()
    public var errors: AnyPublisher<Error, Never> {
        errorsSubject.eraseToAnyPublisher()
    }

    // Listener
    public weak var listener: RendererStateListener?

    public init() {}

    // MARK: - Element Access

    public func getElement(_ id: String) -> HypenElement? {
        elements[id]
    }

    public func getRootElement() -> HypenElement? {
        guard let rootId = rootId else { return nil }
        return elements[rootId]
    }

    public func getAllElements() -> [HypenElement] {
        Array(elements.values)
    }

    public func getChildren(of elementId: String) -> [HypenElement] {
        guard let element = elements[elementId] else { return [] }
        return element.children.compactMap { elements[$0] }
    }

    // MARK: - State Updates

    public func updateState(_ state: [String: Any]) {
        serverState = state
        log.debug("State updated: %@", state.keys.joined(separator: ", "))
    }

    // MARK: - Patch Application

    public func applyPatches(_ patches: [Patch]) {
        log.debug("Applying %d patches", patches.count)

        for patch in patches {
            applyPatch(patch)
        }

        treeVersion += 1
        log.debug("Tree version now: %d, rootId: %@", treeVersion, rootId ?? "nil")
        listener?.onTreeChanged()
    }

    private func applyPatch(_ patch: Patch) {
        log.debug("Applying patch: %@ (id: %@)", patch.type.rawValue, patch.id ?? "nil")

        switch patch.type {
        case .create:
            applyCreate(patch)
        case .setProp:
            applySetProp(patch)
        case .removeProp:
            applyRemoveProp(patch)
        case .setText:
            applySetText(patch)
        case .insert:
            applyInsert(patch)
        case .move:
            applyMove(patch)
        case .remove:
            applyRemove(patch)
        case .attachEvent:
            applyAttachEvent(patch)
        case .detachEvent:
            applyDetachEvent(patch)
        case .detach:
            applyDetach(patch)
        case .attach:
            applyAttach(patch)
        }
    }

    private func applyCreate(_ patch: Patch) {
        guard let id = patch.id, let elementType = patch.elementType else {
            log.warn("CREATE: Missing id or elementType")
            return
        }

        let element = HypenElement(
            id: id,
            elementType: elementType,
            props: patch.props ?? [:]
        )

        if elementType.lowercased() == "grid" || elementType.lowercased() == "image" {
            print("[HypenRenderer] CREATE type=\(elementType) id=\(id) props=\(element.props.keys.sorted())")
        }

        elements[id] = element

        // Set as root if this is the first element
        if rootId == nil {
            rootId = id
            log.debug("Root element set: %@ (%@)", id, elementType)
        }

        listener?.onElementCreated(element)
        log.debug("Created element: %@ (%@)", id, elementType)
    }

    private func applySetProp(_ patch: Patch) {
        guard let id = patch.id, let name = patch.name else {
            log.debug("SET_PROP: Missing id or name")
            return
        }

        guard let element = elements[id] else {
            log.debug("SET_PROP: Element not found: %@", id)
            return
        }

        // Handle special prop names
        if name == "0" || name == "text" {
            // Text content
            if let text = patch.value as? String {
                element.textContent = text
            }
        }

        element.setProp(name, value: patch.value)
        log.debug("Set prop: %@.%@ = %@", id, name, String(describing: patch.value ?? "nil"))
    }

    private func applyRemoveProp(_ patch: Patch) {
        guard let id = patch.id, let name = patch.name else {
            log.debug("REMOVE_PROP: Missing id or name")
            return
        }

        guard let element = elements[id] else {
            log.debug("REMOVE_PROP: Element not found: %@", id)
            return
        }

        element.setProp(name, value: nil)
        log.debug("Removed prop: %@.%@", id, name)
    }

    private func applySetText(_ patch: Patch) {
        guard let id = patch.id else {
            log.debug("SET_TEXT: Missing id")
            return
        }

        guard let element = elements[id] else {
            log.debug("SET_TEXT: Element not found: %@", id)
            return
        }

        element.textContent = patch.text
        log.debug("Set text: %@ = \"%@\"", id, patch.text ?? "")
    }

    private func applyInsert(_ patch: Patch) {
        guard let id = patch.id, let parentId = patch.parentId else {
            log.debug("INSERT: Missing id or parentId")
            return
        }

        guard let element = elements[id] else {
            log.debug("INSERT: Element not found: %@", id)
            return
        }

        // `"root"` is a sentinel for the top-level mount container, not
        // an element id. The engine emits it for root-level inserts
        // (IR root is an Element, or a root-level control-flow
        // container like Router rendering under the mount point).
        // Every patch-driven renderer (DOM, Compose, iOS) must treat it
        // as a container. We check `elements[parentId]` FIRST so legacy
        // callers/tests that use "root" as a literal element id still
        // work.
        if parentId == "root" && elements[parentId] == nil {
            if let oldParentId = element.parentId, let oldParent = elements[oldParentId] {
                oldParent.removeChild(id)
            }
            element.parentId = nil
            rootId = id
            log.debug("Inserted at root: %@", id)
            return
        }

        guard let parent = elements[parentId] else {
            log.debug("INSERT: Parent not found: %@", parentId)
            return
        }

        // Remove from old parent if exists
        if let oldParentId = element.parentId, let oldParent = elements[oldParentId] {
            oldParent.removeChild(id)
        }

        // Add to new parent
        element.parentId = parentId
        parent.addChild(id, beforeId: patch.beforeId)
        log.debug("Inserted: %@ -> %@", id, parentId)
    }

    private func applyMove(_ patch: Patch) {
        guard let id = patch.id, let parentId = patch.parentId else {
            log.debug("MOVE: Missing id or parentId")
            return
        }

        guard let element = elements[id] else {
            log.debug("MOVE: Element not found: %@", id)
            return
        }

        if parentId == "root" && elements[parentId] == nil {
            if let oldParentId = element.parentId, let oldParent = elements[oldParentId] {
                oldParent.removeChild(id)
            }
            element.parentId = nil
            rootId = id
            log.debug("Moved to root: %@", id)
            return
        }

        guard let parent = elements[parentId] else {
            log.debug("MOVE: Parent not found: %@", parentId)
            return
        }

        // Remove from old parent
        if let oldParentId = element.parentId, let oldParent = elements[oldParentId] {
            oldParent.removeChild(id)
        }

        // Add to new parent
        element.parentId = parentId
        parent.addChild(id, beforeId: patch.beforeId)
        log.debug("Moved: %@ -> %@", id, parentId)
    }

    private func applyRemove(_ patch: Patch) {
        guard let id = patch.id else {
            log.debug("REMOVE: Missing id")
            return
        }

        guard let element = elements[id] else {
            log.debug("REMOVE: Element not found: %@", id)
            return
        }

        // Remove from parent
        if let parentId = element.parentId, let parent = elements[parentId] {
            parent.removeChild(id)
        }

        // Recursively remove children
        removeElementAndChildren(id)
        log.debug("Removed: %@", id)
    }

    private func removeElementAndChildren(_ id: String) {
        guard let element = elements[id] else { return }

        // Remove children first
        for childId in element.children {
            removeElementAndChildren(childId)
        }

        // Remove this element
        elements.removeValue(forKey: id)
        // Evict from the detached set in case the engine removed a
        // subtree while it was off-screen (e.g. Router LRU eviction).
        detachedIds.remove(id)
        listener?.onElementRemoved(id: id)

        // Clear root if this was the root
        if rootId == id {
            rootId = nil
        }
    }

    /// Unlink an element from its parent without destroying it.
    /// The element, its props, and its subtree stay in `elements`,
    /// so a subsequent `Attach` can reinsert with zero rebuild work.
    /// If `Remove` arrives instead, the subtree is torn down normally.
    ///
    /// Used by the engine's Router cache to preserve off-screen route
    /// subtrees — navigating back to a previously-visited route
    /// reattaches the cached subtree instead of rebuilding it.
    private func applyDetach(_ patch: Patch) {
        guard let id = patch.id else {
            log.debug("DETACH: Missing id")
            return
        }
        guard let element = elements[id] else {
            log.debug("DETACH: Element not found: %@", id)
            return
        }

        // Unlink from parent. Descendants stay under this element
        // untouched — they remain reachable via `element.children`
        // while off-screen.
        if let parentId = element.parentId, let parent = elements[parentId] {
            parent.removeChild(id)
        }
        element.parentId = nil
        detachedIds.insert(id)

        if rootId == id {
            rootId = nil
        }

        log.debug("Detached: %@", id)
    }

    /// Reattach a previously-detached element to a parent. The element
    /// must still be in `elements` (i.e., not removed in the interim).
    private func applyAttach(_ patch: Patch) {
        guard let id = patch.id, let parentId = patch.parentId else {
            log.debug("ATTACH: Missing id or parentId")
            return
        }
        guard let element = elements[id] else {
            log.warn("ATTACH: Element not found: %@ (was it removed?)", id)
            return
        }

        // "root" is the mount-container sentinel, not an element id.
        // See applyInsert for the full story.
        if parentId == "root" && elements[parentId] == nil {
            if let oldParentId = element.parentId, let oldParent = elements[oldParentId] {
                oldParent.removeChild(id)
            }
            element.parentId = nil
            rootId = id
            detachedIds.remove(id)
            log.debug("Attached at root: %@", id)
            return
        }

        guard let parent = elements[parentId] else {
            log.warn("ATTACH: Parent not found: %@", parentId)
            return
        }

        // Defensive: if the element happens to still be linked
        // somewhere (engine bug), unlink it first.
        if let oldParentId = element.parentId, let oldParent = elements[oldParentId] {
            oldParent.removeChild(id)
        }

        element.parentId = parentId
        parent.addChild(id, beforeId: patch.beforeId)
        detachedIds.remove(id)

        log.debug(
            "Attached: %@ -> %@ (before: %@)",
            id,
            parentId,
            patch.beforeId ?? "end"
        )
    }

    private func applyAttachEvent(_ patch: Patch) {
        guard let id = patch.id, let eventName = patch.eventName else {
            log.debug("ATTACH_EVENT: Missing id or eventName")
            return
        }

        log.debug("Attached event: %@.%@", id, eventName)
        // Events are handled via props in SwiftUI, this is informational
    }

    private func applyDetachEvent(_ patch: Patch) {
        guard let id = patch.id, let eventName = patch.eventName else {
            log.debug("DETACH_EVENT: Missing id or eventName")
            return
        }

        log.debug("Detached event: %@.%@", id, eventName)
        // Events are handled via props in SwiftUI, this is informational
    }

    // MARK: - Clear

    public func clear() {
        elements.removeAll()
        detachedIds.removeAll()
        rootId = nil
        treeVersion += 1
        log.debug("Cleared renderer")
    }
}
