import Foundation
import CoreGraphics

/// Pure geometry for the drag runtime: the band rule, grid snapping, the
/// sortable insertion index and gap-opening shifts, and the pin coordinate
/// computation. Everything here is a function of rects and numbers — no
/// views, no renderer — so the whole rule set is unit-testable without a
/// gesture. Mirrors `resolveBand` / `snapToGrid` in `@hypen-space/core/dnd`
/// and `insertionIndex` / `previewList` / the `pin` branch of `commit` in
/// the DOM runtime (`hypen-web/packages/web/src/dom/dnd.ts`).
public enum DndBand: String, Sendable {
    case before
    case into
    case after
}

public enum DndGeometry {

    // MARK: - Axis helpers

    public static func axisStart(_ rect: CGRect, _ axis: DndAxis) -> CGFloat {
        axis == .x ? rect.minX : rect.minY
    }

    public static func axisLength(_ rect: CGRect, _ axis: DndAxis) -> CGFloat {
        axis == .x ? rect.width : rect.height
    }

    public static func axisPosition(_ point: CGPoint, _ axis: DndAxis) -> CGFloat {
        axis == .x ? point.x : point.y
    }

    /// Half-open containment: a point on the far edge is outside.
    public static func contains(_ rect: CGRect, _ point: CGPoint) -> Bool {
        point.x >= rect.minX && point.x < rect.maxX && point.y >= rect.minY && point.y < rect.maxY
    }

    /// Three-decimal rounding for the numbers that cross the wire.
    public static func round3(_ value: CGFloat) -> Double {
        (Double(value) * 1000).rounded() / 1000
    }

    // MARK: - Band rule (§6.4)

    /// A `.dropZone` on a sortable item: the middle `band` fraction of the
    /// item along the sort axis resolves to `.into`; the outer
    /// `(1 - band) / 2` on either side fall through to the sortable's
    /// before/after insertion. `band` clamps to `[0,1]` (non-finite → the
    /// default): `0` never yields `.into` (split at the midpoint), `1`
    /// yields `.into` anywhere inside `[start, start + length)`. Pointers
    /// outside the item resolve to `.before` / `.after` by side. Boundaries
    /// are half-open: a pointer exactly at the start of a band belongs to
    /// that band.
    public static func resolveBand(
        pointer: CGFloat,
        itemStart: CGFloat,
        itemLength: CGFloat,
        band: Double
    ) -> DndBand {
        let b = band.isFinite ? HypenDnd.clamp01(band) : HypenDnd.defaultBand
        let length = itemLength.isFinite && itemLength > 0 ? itemLength : 0
        let outer = CGFloat((1 - b) / 2)
        let beforeEnd = itemStart + length * outer
        let afterStart = itemStart + length * (1 - outer)
        if pointer < beforeEnd { return .before }
        if pointer >= afterStart { return .after }
        return .into
    }

    // MARK: - Grid

    /// Snap to the nearest multiple of `grid`. A `nil`, non-finite, or
    /// non-positive grid leaves `value` unchanged.
    public static func snapToGrid(_ value: CGFloat, grid: Double?) -> CGFloat {
        guard value.isFinite else { return value }
        guard let grid = grid, grid.isFinite, grid > 0 else { return value }
        let g = CGFloat(grid)
        return (value / g).rounded() * g
    }

    // MARK: - Paths (§4.1)

    /// Reserved-mode pin base path: `"__dnd.<group>.<key>"`.
    public static func reservedPinPath(group: String, key: String) -> String {
        "\(HypenDnd.reservedStateKey).\(group).\(key)"
    }

    /// User-field-mode pin base path: `"<bindPath>.<index>"`.
    public static func userPinPath(bindPath: String, index: Int) -> String {
        "\(bindPath).\(index)"
    }

    // MARK: - Sortable preview

    /// Estimated inter-item gap along the axis, from the first two rects.
    public static func estimatedGap(rects: [CGRect], axis: DndAxis) -> CGFloat {
        guard rects.count >= 2 else { return 0 }
        let a = rects[0]
        let b = rects[1]
        return max(0, axisStart(b, axis) - (axisStart(a, axis) + axisLength(a, axis)))
    }

    /// Fill the slots of items the view layer has not measured yet (rows the
    /// engine inserted mid-drag — layout settles a frame later, after the
    /// structural hook ran). An unmeasured item borrows the NEXT measured
    /// rect (the slot it is about to occupy — the rows below it shift down
    /// by one on settle); a trailing run extends the last measured rect by
    /// one item length plus the gap per slot; with nothing measured at all
    /// every slot is `.zero`. The estimate is replaced by the real rects on
    /// the next `updateFrames`.
    public static func fillUnmeasured(_ rects: [CGRect?], axis: DndAxis, gap: CGFloat) -> [CGRect] {
        var out = Array(repeating: CGRect.zero, count: rects.count)
        // Reverse pass: an unmeasured slot borrows the next measured rect;
        // `trailingFrom` is the first index of the unmeasured run at the end.
        var next: CGRect?
        var trailingFrom = rects.count
        for i in stride(from: rects.count - 1, through: 0, by: -1) {
            if let rect = rects[i] {
                next = rect
                out[i] = rect
            } else if let borrowed = next {
                out[i] = borrowed
            } else {
                trailingFrom = i
            }
        }
        // Trailing run: step past the last measured rect one slot at a time.
        guard trailingFrom > 0, trailingFrom < rects.count else { return out }
        var anchor = out[trailingFrom - 1]
        for i in trailingFrom..<rects.count {
            let step = axisLength(anchor, axis) + gap
            anchor = axis == .x ? anchor.offsetBy(dx: step, dy: 0) : anchor.offsetBy(dx: 0, dy: step)
            out[i] = anchor
        }
        return out
    }

    /// Final insertion index of the dragged item for a pointer position
    /// along the axis: one slot past every OTHER item whose midpoint the
    /// pointer has passed. `draggedIndex` is the dragged item's slot in
    /// `rects` (`nil` for a foreign list).
    public static func insertionIndex(
        rects: [CGRect],
        axis: DndAxis,
        draggedIndex: Int?,
        position: CGFloat
    ) -> Int {
        var index = 0
        for (i, rect) in rects.enumerated() {
            if i == draggedIndex { continue }
            let mid = axisStart(rect, axis) + axisLength(rect, axis) / 2
            if position >= mid { index += 1 }
        }
        return index
    }

    /// Sibling shifts that open the gap for the dragged item at final index
    /// `to`: items between the origin slot and the destination move one
    /// item-size (+ gap) toward the origin. `to == Int.max` closes every
    /// gap (the "not hovering this list" reset); the dragged slot itself is
    /// always 0 (the ghost carries its own transform).
    public static func gapShifts(count: Int, draggedIndex: Int?, to: Int, size: CGFloat) -> [CGFloat] {
        var shifts = Array(repeating: CGFloat(0), count: count)
        let from = draggedIndex ?? -1
        var others = 0
        for i in 0..<count {
            if i == from { continue }
            var shift: CGFloat = 0
            if from == -1 {
                if others >= to { shift = size }
            } else if from < to {
                if i > from && others < to { shift = -size }
            } else if to < from {
                if i < from && others >= to { shift = size }
            }
            others += 1
            shifts[i] = shift
        }
        return shifts
    }

    // MARK: - Pinboard (§6.5)

    /// The resolved drop of a pinboard item.
    public struct PinResult: Equatable, Sendable {
        /// Wire coordinates: content-box points, or a fraction of the content
        /// box when `units: fraction`. Rounded to three decimals.
        public let x: Double
        public let y: Double
        /// Offset that puts the ghost exactly at the resolved position (so
        /// the post-drop hold shows the snapped/clamped spot, not the
        /// finger's).
        public let ghostOffset: CGSize
    }

    /// `(x, y)` = the item's top-left (its rect at lift plus the drag
    /// translation) minus the container's content-box origin, in logical
    /// points; then the grid snap, then `bounds: clamp` clamps to the
    /// content box (keeping the whole item inside), then `units: fraction`
    /// divides by the content size (0 when the box has no extent).
    public static func pinPosition(
        itemRect: CGRect,
        translation: CGSize,
        contentBox: CGRect,
        spec: DndPinSpec
    ) -> PinResult {
        let rawX = itemRect.minX + translation.width - contentBox.minX
        let rawY = itemRect.minY + translation.height - contentBox.minY
        var px = snapToGrid(rawX, grid: spec.grid)
        var py = snapToGrid(rawY, grid: spec.grid)
        if spec.bounds == .clamp {
            px = min(max(0, px), max(0, contentBox.width - itemRect.width))
            py = min(max(0, py), max(0, contentBox.height - itemRect.height))
        }
        let ghost = CGSize(
            width: px + contentBox.minX - itemRect.minX,
            height: py + contentBox.minY - itemRect.minY
        )
        let x: Double
        let y: Double
        if spec.units == .fraction {
            x = round3(contentBox.width > 0 ? px / contentBox.width : 0)
            y = round3(contentBox.height > 0 ? py / contentBox.height : 0)
        } else {
            x = round3(px)
            y = round3(py)
        }
        return PinResult(x: x, y: y, ghostOffset: ghost)
    }

    /// The content box of a container whose measured frame includes its
    /// margin (applied as outer padding by `hypenModifier`) and padding.
    public static func contentBox(frame: CGRect, modifier: HypenModifier?) -> CGRect {
        guard let m = modifier else { return frame }
        let left = m.marginLeading + m.paddingLeading
        let right = m.marginTrailing + m.paddingTrailing
        let top = m.marginTop + m.paddingTop
        let bottom = m.marginBottom + m.paddingBottom
        return CGRect(
            x: frame.minX + left,
            y: frame.minY + top,
            width: max(0, frame.width - left - right),
            height: max(0, frame.height - top - bottom)
        )
    }
}
