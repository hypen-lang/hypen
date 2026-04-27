/**
 * Windowed / Virtual Rendering
 *
 * For scrollable containers with many children, determines which children
 * intersect the visible viewport so the paint system can skip off-screen nodes.
 * This is paint-level virtualization only -- all children still get layout
 * computed (Taffy handles that efficiently). We just skip painting off-screen
 * children.
 */

import type { VirtualNode, Rectangle } from "./types.js";
import { isScrollable } from "./scroll.js";

/** Number of pixels to render beyond the visible viewport edges. */
const OVERSCAN = 100;

/** Minimum child count before virtualization kicks in. */
export const VIRTUALIZE_THRESHOLD = 20;

/**
 * Return the subset of `parent.children` whose layouts overlap the visible
 * viewport of the parent container.
 *
 * - For non-scrollable containers every child is returned unchanged.
 * - For scrollable containers the visible rect is the parent's layout bounds
 *   offset by the current scroll position, expanded by OVERSCAN pixels on
 *   each axis to prevent pop-in during fast scrolling.
 *
 * Children without a computed layout are always included (defensive -- they
 * may need painting for side-effects).
 */
export function getVisibleChildren(
  parent: VirtualNode,
  viewport: Rectangle,
): VirtualNode[] {
  if (!isScrollable(parent)) {
    return parent.children;
  }

  const ss = parent.scrollState;
  if (!ss) {
    return parent.children;
  }

  // The visible window in *content coordinates* (i.e. coordinates that
  // children are laid out in). The viewport rectangle is already in the
  // parent's coordinate space; we shift it by the scroll offset so that
  // it matches where the children actually are in the layout.
  const visibleMinX = viewport.x + ss.scrollX - OVERSCAN;
  const visibleMaxX = viewport.x + ss.scrollX + viewport.width + OVERSCAN;
  const visibleMinY = viewport.y + ss.scrollY - OVERSCAN;
  const visibleMaxY = viewport.y + ss.scrollY + viewport.height + OVERSCAN;

  const visible: VirtualNode[] = [];

  for (const child of parent.children) {
    // Always include children without layout (safety net).
    if (!child.layout) {
      visible.push(child);
      continue;
    }

    const cl = child.layout;
    const childMinX = cl.x;
    const childMaxX = cl.x + cl.width;
    const childMinY = cl.y;
    const childMaxY = cl.y + cl.height;

    // Standard AABB intersection test.
    if (
      childMaxX > visibleMinX &&
      childMinX < visibleMaxX &&
      childMaxY > visibleMinY &&
      childMinY < visibleMaxY
    ) {
      visible.push(child);
    }
  }

  return visible;
}
