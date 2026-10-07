import Foundation
import SwiftUI
import UniformTypeIdentifiers

/// Files from the OS — the `files: true` half of `.dropZone()`
/// (`hypen-web/docs/dnd.md`, "Files from the OS").
///
/// A files zone reacts while files dragged in from OUTSIDE the app hover it
/// (iPad multitasking, drags from Files / Photos / another app; Finder on a
/// Mac build): it wears the runtime `over` pose and dispatches
/// `.onFileDragEnter` once per entry. The files themselves are never
/// delivered — a release on the zone is refused (`.forbidden`) and nothing
/// is ever loaded from the item providers; only their registered type
/// identifiers, suggested names and count are read, to decide `accept`.
///
/// Why this is separate from the gesture runtime: Hypen's in-app drags are
/// renderer-local `DragGesture`s that never open a system drag session, so
/// they can never reach a `DropDelegate`. Anything the delegate sees is a
/// system drag. Of those, only drags that carry files count (a text
/// selection or a bare link dragged out of a text field — the same app or
/// another — does not), mirroring the DOM's `dataTransfer.types` includes
/// `"Files"` rule. The two halves share only the `over` label, and each
/// clears only a label it set itself.
///
/// The view layer feeds the coordinator abstract samples
/// (`HypenFileDragItem`) instead of `DropInfo`, which has no public
/// initializer — so the whole state machine is unit-testable.

// MARK: - Drag items and the accept filter

/// What the renderer may know about one dragged item before the drop: the
/// type identifiers its provider registered and its suggested file name.
/// Never contents.
public struct HypenFileDragItem: Equatable, Sendable {
    public var typeIdentifiers: [String]
    public var suggestedName: String?

    public init(typeIdentifiers: [String], suggestedName: String? = nil) {
        self.typeIdentifiers = typeIdentifiers
        self.suggestedName = suggestedName
    }

    /// Read an item provider's metadata. Loads nothing.
    public init(provider: NSItemProvider) {
        self.init(typeIdentifiers: provider.registeredTypeIdentifiers, suggestedName: provider.suggestedName)
    }
}

/// The `accept` matcher and the "is this a file drag" rule.
public enum HypenFileAccept {

    /// One parsed `accept` entry.
    public enum Filter: Equatable, Sendable {
        /// A type the system knows (a MIME type, a `type/*` wildcard, or an
        /// extension resolved to a declared UTType): items must conform.
        case type(UTType)
        /// A `.ext` entry: matched against the item's suggested file name
        /// (case-insensitive), and against `type` when the extension
        /// resolves to a declared UTType.
        case fileExtension(String, UTType?)
        /// An entry the system cannot resolve — counts as a match.
        case unknown
    }

    /// Parse an `<input accept>` string. Entries are comma-separated,
    /// trimmed and lowercased; blanks, `*` and `*/*` impose no filter. An
    /// empty result means "any".
    public static func parse(_ accept: String?) -> [Filter] {
        guard let accept = accept else { return [] }
        var out: [Filter] = []
        for raw in accept.split(separator: ",") {
            let entry = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if entry.isEmpty || entry == "*" || entry == "*/*" { continue }
            if let slash = entry.firstIndex(of: "/") {
                let top = String(entry[..<slash])
                let sub = entry[entry.index(after: slash)...]
                if sub == "*" {
                    out.append(wildcardType(top).map(Filter.type) ?? .unknown)
                } else if let type = UTType(mimeType: entry), !type.isDynamic {
                    out.append(.type(type))
                } else {
                    out.append(.unknown)
                }
            } else {
                let ext = entry.hasPrefix(".") ? String(entry.dropFirst()) : entry
                guard !ext.isEmpty else { continue }
                let type = UTType(filenameExtension: ext).flatMap { $0.isDynamic ? nil : $0 }
                out.append(.fileExtension(ext, type))
            }
        }
        return out
    }

    /// `type/*` → the top-level type every member conforms to; `nil` for a
    /// top-level type with no system equivalent.
    static func wildcardType(_ top: String) -> UTType? {
        switch top {
        case "image": return .image
        case "video": return .movie
        case "audio": return .audio
        case "text": return .text
        case "font": return .font
        case "application": return .data
        case "model": return .threeDContent
        default: return nil
        }
    }

    /// Whether at least one item satisfies `accept`. No filter, an
    /// unresolvable entry, an item whose type the platform can't tell yet,
    /// or an empty / unknown item list all count as a match.
    public static func matches(accept: String?, items: [HypenFileDragItem]) -> Bool {
        let filters = parse(accept)
        if filters.isEmpty || filters.contains(.unknown) { return true }
        if items.isEmpty { return true }
        return items.contains { item in matches(filters: filters, item: item) }
    }

    static func matches(filters: [Filter], item: HypenFileDragItem) -> Bool {
        var types = item.typeIdentifiers.compactMap { UTType($0) }.filter { !$0.isDynamic }
        let nameExtension = item.suggestedName.flatMap(fileExtension(of:))
        if let ext = nameExtension, let byName = UTType(filenameExtension: ext), !byName.isDynamic {
            types.append(byName)
        }
        // The platform can't tell this item's type before the drop: a match.
        if types.isEmpty && nameExtension == nil { return true }
        for filter in filters {
            switch filter {
            case .unknown:
                return true
            case .type(let wanted):
                if types.contains(where: { $0.conforms(to: wanted) }) { return true }
            case .fileExtension(let ext, let wanted):
                if nameExtension == ext { return true }
                if let wanted = wanted, types.contains(where: { $0.conforms(to: wanted) }) { return true }
            }
        }
        return false
    }

    static func fileExtension(of name: String) -> String? {
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return nil }
        let ext = name[name.index(after: dot)...].lowercased()
        return ext.isEmpty ? nil : ext
    }

    /// Pasteboard flavours a text / rich-text selection drag registers that
    /// are not evidence of a file.
    private static let nonFilePrefixes = [
        "com.apple.uikit.", "com.apple.rtfd", "com.apple.flat-rtfd", "com.apple.webarchive",
    ]

    /// Whether one item looks like a file rather than a text selection or a
    /// bare link: it has a suggested file name, is a file URL, or registers
    /// a data / content type that is neither text nor a URL.
    public static func isFileItem(_ item: HypenFileDragItem) -> Bool {
        if let name = item.suggestedName, !name.isEmpty { return true }
        for identifier in item.typeIdentifiers {
            if nonFilePrefixes.contains(where: { identifier.hasPrefix($0) }) { continue }
            guard let type = UTType(identifier) else { continue }
            if type.conforms(to: .fileURL) { return true }
            if type.conforms(to: .text) || type.conforms(to: .url) { continue }
            if type.conforms(to: .data) || type.conforms(to: .content)
                || type.conforms(to: .directory) || type.conforms(to: .package) {
                return true
            }
        }
        return false
    }

    /// Whether a system drag carries files at all (DOM: `types` includes
    /// `"Files"`).
    public static func carriesFiles(_ items: [HypenFileDragItem]) -> Bool {
        items.contains(where: isFileItem)
    }
}

// MARK: - Hover state

/// The proposal the view layer hands back to the system while a file drag
/// hovers a files zone. Files are never accepted.
public enum HypenFileDropOperation: Equatable, Sendable {
    /// "No drop" — the release is refused.
    case forbidden
}

/// OS-file-drag hover bookkeeping, owned by `HypenDndCoordinator`.
@MainActor
final class FileHoverState {
    /// Files zones whose drop target the drag is directly over (as the
    /// platform reported via enter / exit).
    var hovered: Set<String> = []
    /// Exits not yet applied: an exit is settled one turn later, so moving
    /// from a zone into a nested zone (exit + enter in either order) never
    /// reads as leaving the outer zone.
    var pendingExits: Set<String> = []
    var flushWork: HypenScheduledWork?
    /// Zones the drag is inside (hovered zones plus their enclosing enabled
    /// files zones) whose `accept` matches, as of the last reconcile —
    /// `.onFileDragEnter` fires on the transition into this set, so nested
    /// children never re-fire.
    var inside: Set<String> = []
    /// The innermost enabled files zone under the drag whose `accept`
    /// matches — the one wearing `over`.
    var overId: String?
    /// The id this half actually set `dndPoseLabel = over` on (only when
    /// the node has an `over` pose and no other label was live).
    var poseAppliedId: String?
    /// The latest items sample.
    var items: [HypenFileDragItem] = []
}

// MARK: - Coordinator: OS file drags

extension HypenDndCoordinator {

    /// The files zone currently lit by an OS file drag, if any.
    public var fileOverZoneId: String? { fileHover.overId }

    /// Whether `id` is an enabled `files: true` zone that can light up.
    func isEnabledFileZone(_ id: String) -> Bool {
        guard let element = renderer.getElement(id),
              let zone = element.dndSpecs.zone, zone.files,
              element.dndSpecs.zoneEnabled,
              !renderer.animator.isExiting(id) else { return false }
        return true
    }

    /// `validateDrop`: take part only for an enabled files zone and a drag
    /// that carries files. A disabled zone declines, so the system can
    /// offer the drag to an enclosing one.
    public func fileDragShouldValidate(zoneId: String, items: [HypenFileDragItem]) -> Bool {
        isEnabledFileZone(zoneId) && HypenFileAccept.carriesFiles(items)
    }

    /// `dropEntered`: the drag is now directly over `zoneId`.
    public func fileDragEntered(zoneId: String, items: [HypenFileDragItem]) {
        guard HypenFileAccept.carriesFiles(items) else { return }
        fileHover.items = items
        fileHover.pendingExits.remove(zoneId)
        fileHover.hovered.insert(zoneId)
        reconcileFileHover()
    }

    /// `dropUpdated`: refresh the items sample and refuse the release.
    public func fileDragUpdated(zoneId: String, items: [HypenFileDragItem]) -> HypenFileDropOperation {
        if fileHover.hovered.contains(zoneId), !items.isEmpty {
            fileHover.items = items
        }
        return .forbidden
    }

    /// `dropExited`: left `zoneId` (or the drag was cancelled / ended). The
    /// exit settles one scheduler turn later.
    public func fileDragExited(zoneId: String) {
        guard fileHover.hovered.contains(zoneId) else { return }
        fileHover.pendingExits.insert(zoneId)
        guard fileHover.flushWork == nil else { return }
        fileHover.flushWork = scheduler.schedule(after: 0) { [weak self] in
            guard let self else { return }
            self.fileHover.flushWork = nil
            self.fileHover.hovered.subtract(self.fileHover.pendingExits)
            self.fileHover.pendingExits.removeAll()
            self.reconcileFileHover()
        }
    }

    /// `performDrop`: the files are released on a zone. Nothing is loaded
    /// or delivered; the hover ends now. Returns `false` (not accepted).
    public func fileDragPerformDrop(zoneId: String) -> Bool {
        resetFileHover()
        return false
    }

    /// Drop every trace of the file hover (renderer reset, drop).
    func resetFileHover() {
        fileHover.flushWork?.cancel()
        fileHover.flushWork = nil
        fileHover.hovered.removeAll()
        fileHover.pendingExits.removeAll()
        fileHover.items = []
        reconcileFileHover()
    }

    /// A node's props changed: a hovered zone that was disabled (or lost
    /// its files role) goes dark; re-enabled, it lights again.
    func fileZoneChanged(_ id: String) {
        guard !fileHover.hovered.isEmpty else { return }
        reconcileFileHover()
    }

    /// A node is being purged.
    func forgetFileZone(_ id: String) {
        guard fileHover.hovered.contains(id) || fileHover.inside.contains(id) || fileHover.poseAppliedId == id else { return }
        fileHover.hovered.remove(id)
        fileHover.pendingExits.remove(id)
        fileHover.inside.remove(id)
        if fileHover.poseAppliedId == id { fileHover.poseAppliedId = nil }
        if fileHover.overId == id { fileHover.overId = nil }
        reconcileFileHover()
    }

    /// A Router `Detach` of the subtree at `id` (called before unlinking):
    /// hovered zones at or under it stop hovering.
    func fileZoneDetached(_ id: String) {
        let gone = fileHover.hovered.filter { $0 == id || fileIsDescendant($0, of: id) }
        guard !gone.isEmpty else { return }
        fileHover.hovered.subtract(gone)
        fileHover.pendingExits.subtract(gone)
        reconcileFileHover()
    }

    // MARK: Reconcile

    /// Recompute which zones the drag is inside, fire `.onFileDragEnter`
    /// on each new entry, and move the `over` pose to the innermost enabled
    /// files zone whose `accept` matches (falling through a disabled or
    /// non-matching inner zone to its nearest matching ancestor).
    private func reconcileFileHover() {
        // The hovered zones and every enclosing enabled files zone contain
        // the drag; a disabled zone is transparent.
        var inside: Set<String> = []
        for id in fileHover.hovered {
            var cursor: String? = id
            var hops = 0
            while let current = cursor, hops < 4096 {
                if isEnabledFileZone(current) { inside.insert(current) }
                cursor = renderer.getElement(current)?.parentId
                hops += 1
            }
        }
        // `.onFileDragEnter` fires only where `over` could light: an enabled
        // zone whose `accept` matches the drag — an app never opens a picker
        // for the wrong types.
        let signalled = inside.filter { id in
            HypenFileAccept.matches(accept: renderer.getElement(id)?.dndSpecs.zone?.accept, items: fileHover.items)
        }
        let entered = signalled.subtracting(fileHover.inside)
        fileHover.inside = signalled
        // Outer zones first (DOM bubbling order), deterministic otherwise.
        for id in entered.sorted(by: { (fileDepth(of: $0), $0) < (fileDepth(of: $1), $1) }) {
            dispatchFileDragEnter(zoneId: id)
        }

        // Fall-through: the innermost zone that is enabled AND matches wins;
        // a disabled or non-matching inner zone hands `over` to the nearest
        // enclosing one that matches. Only one zone is lit.
        let lit = signalled.max { (fileDepth(of: $0), $1) < (fileDepth(of: $1), $0) }
        guard lit != fileHover.overId || (lit != nil && fileHover.poseAppliedId != lit) else { return }

        if let applied = fileHover.poseAppliedId, applied != lit {
            if let element = renderer.getElement(applied), element.dndPoseLabel == HypenDnd.labelOver {
                element.dndPoseLabel = nil
            }
            fileHover.poseAppliedId = nil
        }
        fileHover.overId = lit
        if let lit = lit, fileHover.poseAppliedId != lit,
           let element = renderer.getElement(lit),
           element.dndSpecs.poses?[HypenDnd.labelOver] != nil,
           element.dndPoseLabel == nil {
            // Never clobber a label the gesture runtime owns.
            element.dndPoseLabel = HypenDnd.labelOver
            fileHover.poseAppliedId = lit
        }
    }

    /// `.onFileDragEnter` on `zoneId`: `{type, timestamp, items}`, or the
    /// author's named arguments in its place (DOM parity). Never names,
    /// paths or bytes.
    private func dispatchFileDragEnter(zoneId: String) {
        guard let element = renderer.getElement(zoneId),
              let binding = DndEventBinding.from(props: element.props, name: HypenDnd.fileDragEnterEvent) else { return }
        let payload: [String: Any]
        if !binding.customPayload.isEmpty {
            payload = binding.customPayload
        } else {
            payload = [
                "type": "filedragenter",
                "timestamp": Int(Date().timeIntervalSince1970 * 1000),
                "items": fileHover.items.count,
            ]
        }
        guard let dispatcher = actionDispatcher else { return }
        dispatcher.dispatch(action: "__hypen_dispatch", payload: [
            "node": zoneId, "action": binding.actionName, "payload": payload,
        ])
    }

    private func fileDepth(of id: String) -> Int {
        var count = 0
        var current = renderer.getElement(id)?.parentId
        while let currentId = current, count < 4096 {
            count += 1
            current = renderer.getElement(currentId)?.parentId
        }
        return count
    }

    private func fileIsDescendant(_ id: String, of rootId: String) -> Bool {
        var current = renderer.getElement(id)?.parentId
        var hops = 0
        while let currentId = current, hops < 4096 {
            if currentId == rootId { return true }
            current = renderer.getElement(currentId)?.parentId
            hops += 1
        }
        return false
    }
}

extension HypenDnd {
    /// `.onFileDragEnter(@action)` — lowered as `onFileDragEnter.0`.
    public static let fileDragEnterEvent = "onFileDragEnter"
}

// MARK: - View layer

#if os(iOS) || os(macOS) || os(visionOS)
/// The SwiftUI drop target of one files zone. Reads only provider
/// metadata; `performDrop` loads nothing and reports "not accepted".
@MainActor
struct HypenFileDropDelegate: DropDelegate {
    let zoneId: String
    let coordinator: HypenDndCoordinator

    private func items(_ info: DropInfo) -> [HypenFileDragItem] {
        info.itemProviders(for: [UTType.item]).map(HypenFileDragItem.init(provider:))
    }

    func validateDrop(info: DropInfo) -> Bool {
        coordinator.fileDragShouldValidate(zoneId: zoneId, items: items(info))
    }

    func dropEntered(info: DropInfo) {
        coordinator.fileDragEntered(zoneId: zoneId, items: items(info))
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        switch coordinator.fileDragUpdated(zoneId: zoneId, items: items(info)) {
        case .forbidden:
            return DropProposal(operation: .forbidden)
        }
    }

    func dropExited(info: DropInfo) {
        coordinator.fileDragExited(zoneId: zoneId)
    }

    func performDrop(info: DropInfo) -> Bool {
        coordinator.fileDragPerformDrop(zoneId: zoneId)
    }
}
#endif

extension View {
    /// Make a `files: true` zone an OS file drop target. A no-op for every
    /// other node, and on platforms without drag and drop (tvOS, watchOS),
    /// where the zone stays an ordinary in-app zone.
    @MainActor
    @ViewBuilder
    func hypenFileDropZone(_ element: HypenElement, coordinator: HypenDndCoordinator) -> some View {
        #if os(iOS) || os(macOS) || os(visionOS)
        if element.dndSpecs.zone?.files == true {
            onDrop(of: [UTType.item], delegate: HypenFileDropDelegate(zoneId: element.id, coordinator: coordinator))
        } else {
            self
        }
        #else
        self
        #endif
    }
}
