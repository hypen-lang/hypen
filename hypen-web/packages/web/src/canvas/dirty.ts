/**
 * Dirty Rect Tracker
 *
 * Tracks which rectangular regions of the canvas have changed and need repainting.
 * Instead of per-node tracking, we accumulate dirty rectangles and merge them into
 * a single bounding box. The canvas clip path ensures only dirty pixels are drawn.
 */

import type { Rectangle, VirtualNode } from "./types.js";

export class DirtyRectTracker {
  private dirtyRegion: Rectangle | null = null;
  private canvasWidth: number;
  private canvasHeight: number;

  constructor(canvasWidth: number, canvasHeight: number) {
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
  }

  /**
   * Update canvas dimensions (e.g. on resize)
   */
  setCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  /**
   * Union a rectangle into the dirty region
   */
  markDirty(rect: Rectangle): void {
    if (rect.width <= 0 || rect.height <= 0) return;

    if (this.dirtyRegion === null) {
      this.dirtyRegion = { ...rect };
    } else {
      this.dirtyRegion = unionRects(this.dirtyRegion, rect);
    }
  }

  /**
   * Mark both old and new bounds of a node as dirty.
   * This ensures the old position is erased and the new position is painted.
   */
  markNodeDirty(node: VirtualNode): void {
    if (node.layout) {
      // Mark current layout bounds (covers both erase of old content and paint of new)
      this.markDirty({
        x: node.layout.x,
        y: node.layout.y,
        width: node.layout.width,
        height: node.layout.height,
      });
    }
  }

  /**
   * Mark the entire canvas as dirty (first render, resize, etc.)
   */
  markFullDirty(): void {
    this.dirtyRegion = {
      x: 0,
      y: 0,
      width: this.canvasWidth,
      height: this.canvasHeight,
    };
  }

  /**
   * Returns the merged bounding box of all dirty rects, or null if clean.
   * Adds a 1px padding to avoid sub-pixel clipping artifacts.
   */
  getDirtyRegion(): Rectangle | null {
    if (this.dirtyRegion === null) return null;

    // Expand by 1px to avoid sub-pixel edge artifacts, clamped to canvas bounds
    const padded: Rectangle = {
      x: Math.max(0, Math.floor(this.dirtyRegion.x) - 1),
      y: Math.max(0, Math.floor(this.dirtyRegion.y) - 1),
      width: Math.min(
        this.canvasWidth,
        Math.ceil(this.dirtyRegion.width) + 2
      ),
      height: Math.min(
        this.canvasHeight,
        Math.ceil(this.dirtyRegion.height) + 2
      ),
    };

    return padded;
  }

  /**
   * Reset dirty state after a frame
   */
  clear(): void {
    this.dirtyRegion = null;
  }
}

/**
 * Compute the union (bounding box) of two rectangles
 */
function unionRects(a: Rectangle, b: Rectangle): Rectangle {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}
