/**
 * Paint culling for scroll containers.
 *
 * List virtualization proper (only a window of a long list's rows exists at
 * all) is the engine's `__virt.window` contract, handled by
 * `virt-list.ts`. This module is the paint-side complement: a scroll
 * container with many laid-out children — a windowed list's overscanned
 * rows, or a long non-lazy list — skips painting the children that do not
 * intersect its visible box. Layout and hit-testing are unaffected.
 *
 * Child layouts are absolute and already include a windowed list's leading
 * stand-in space (layout padding, or the post-layout shift of a list that
 * scrolls itself), so the plain AABB test below composes with windowing.
 */

import type { VirtualNode } from "./types.js";
import { isScrollable } from "./scroll.js";

/** Pixels painted beyond the visible box to prevent pop-in while scrolling. */
const OVERSCAN = 100;

/** Minimum child count before culling is worth the per-child test. */
const CULL_THRESHOLD = 20;

/**
 * The children of `node` to paint: all of them, unless `node` is a scrolled
 * container (scrollable, with a `scrollState`) with
 * more than {@link CULL_THRESHOLD} children — then only those whose
 * layout overlaps its box shifted by the scroll offset, widened by
 * {@link OVERSCAN}. Children without a layout are always kept.
 */
export function getVisibleChildren(node: VirtualNode): VirtualNode[] {
  const ss = node.scrollState;
  const box = node.layout;
  if (!ss || !box || node.children.length <= CULL_THRESHOLD || !isScrollable(node)) {
    return node.children;
  }

  // The visible box in content coordinates (where children are laid out).
  const minX = box.x + ss.scrollX - OVERSCAN;
  const maxX = box.x + ss.scrollX + box.width + OVERSCAN;
  const minY = box.y + ss.scrollY - OVERSCAN;
  const maxY = box.y + ss.scrollY + box.height + OVERSCAN;

  return node.children.filter((child) => {
    const cl = child.layout;
    if (!cl) return true;
    return cl.x + cl.width > minX && cl.x < maxX && cl.y + cl.height > minY && cl.y < maxY;
  });
}
