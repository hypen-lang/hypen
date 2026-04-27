/**
 * Scroll Manager
 *
 * Handles touch gestures, wheel events, momentum scrolling, and
 * scrollbar rendering for the canvas renderer. Nodes with
 * overflow: "scroll" | "auto" become scrollable containers.
 */

import type { VirtualNode, ScrollState, Point, Rectangle } from "./types.js";
import { getAbsoluteBounds } from "./utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Friction coefficient for momentum deceleration (per ms) */
const FRICTION = 0.97;

/** Minimum velocity before stopping momentum (px/ms) */
const MIN_VELOCITY = 0.05;

/** Elastic overscroll damping factor */
const ELASTIC_DAMPING = 0.4;

/** Snap-back spring constant when released past bounds */
const SNAP_BACK_SPEED = 0.15;

/** Scrollbar thickness in CSS pixels */
const SCROLLBAR_SIZE = 6;

/** Scrollbar minimum thumb length */
const SCROLLBAR_MIN_THUMB = 24;

/** Scrollbar padding from edge */
const SCROLLBAR_PADDING = 2;

/** How quickly the scrollbar fades out (opacity per ms) */
const SCROLLBAR_FADE_RATE = 0.003;

/** Time after scroll stops before scrollbar starts fading (ms) */
const SCROLLBAR_LINGER = 800;

// ---------------------------------------------------------------------------
// ScrollState helpers
// ---------------------------------------------------------------------------

export function createScrollState(): ScrollState {
  return {
    scrollX: 0,
    scrollY: 0,
    velocityX: 0,
    velocityY: 0,
    scrollWidth: 0,
    scrollHeight: 0,
    touching: false,
    lastTouchTime: 0,
    scrollbarOpacity: 0,
  };
}

/** Returns true if the node is configured as a scrollable container.
 *
 * Accepts both forms the engine and user code emit:
 *   - `overflow: "scroll" | "auto"` — CSS-style (DOM parity)
 *   - `scrollable: true | "vertical" | "horizontal" | "both"` — Hypen DSL form
 */
export function isScrollable(node: VirtualNode): boolean {
  const axes = getScrollAxes(node);
  return axes.x || axes.y;
}

/**
 * Resolve which axes a node is allowed to scroll on.
 *
 * `scrollable: "horizontal"` means a horizontal strip — the user expects
 * vertical drags / wheel events to bubble out, and content overflowing the
 * Y axis must NOT inflate scrollHeight (otherwise the strip jitters
 * vertically on touch).
 */
export function getScrollAxes(node: VirtualNode): { x: boolean; y: boolean } {
  const overflow = node.props.overflow;
  if (overflow === "scroll" || overflow === "auto") return { x: true, y: true };
  const scrollable = node.props.scrollable;
  if (scrollable === true) return { x: true, y: true };
  if (typeof scrollable === "string") {
    if (scrollable === "horizontal") return { x: true, y: false };
    if (scrollable === "vertical") return { x: false, y: true };
    if (scrollable === "both") return { x: true, y: true };
  }
  return { x: false, y: false };
}

/** Ensure a scroll state is attached; returns the (possibly new) state. */
function ensureScrollState(node: VirtualNode): ScrollState {
  if (!node.scrollState) node.scrollState = createScrollState();
  return node.scrollState;
}

/** Maximum scroll offsets for a node (always ≥ 0). */
function maxScroll(node: VirtualNode): { maxX: number; maxY: number } {
  const ss = node.scrollState;
  if (!ss || !node.layout) return { maxX: 0, maxY: 0 };
  return {
    maxX: Math.max(0, ss.scrollWidth - node.layout.contentWidth),
    maxY: Math.max(0, ss.scrollHeight - node.layout.contentHeight),
  };
}

/** Clamp scroll to valid range (with optional elastic overshoot). */
function clampScroll(
  value: number,
  max: number,
  elastic: boolean,
): number {
  if (!elastic) return Math.max(0, Math.min(value, max));
  // Allow overscroll with damping
  if (value < 0) return value * ELASTIC_DAMPING;
  if (value > max) return max + (value - max) * ELASTIC_DAMPING;
  return value;
}

// ---------------------------------------------------------------------------
// ScrollManager
// ---------------------------------------------------------------------------

export class ScrollManager {
  private canvas: HTMLCanvasElement;
  private rootNode: VirtualNode | null = null;
  private requestRedraw: () => void;

  // Active touch tracking
  private activeNode: VirtualNode | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private lastPointerTime = 0;

  // Momentum animation
  private momentumRaf: number | null = null;
  private lastMomentumTime = 0;

  // Scrollbar fade timer
  private scrollbarFadeTimer: number | null = null;
  private scrollbarLastActivity = 0;

  // Bound handlers
  private boundWheel!: (e: WheelEvent) => void;
  private boundTouchStart!: (e: TouchEvent) => void;
  private boundTouchMove!: (e: TouchEvent) => void;
  private boundTouchEnd!: (e: TouchEvent) => void;
  private boundPointerDown!: (e: PointerEvent) => void;
  private boundPointerMove!: (e: PointerEvent) => void;
  private boundPointerUp!: (e: PointerEvent) => void;

  constructor(
    canvas: HTMLCanvasElement,
    requestRedraw: () => void,
  ) {
    this.canvas = canvas;
    this.requestRedraw = requestRedraw;
    this.setupEventListeners();
  }

  setRootNode(node: VirtualNode | null): void {
    this.rootNode = node;
  }

  // -------------------------------------------------------------------------
  // Event listeners
  // -------------------------------------------------------------------------

  private setupEventListeners(): void {
    this.boundWheel = this.onWheel.bind(this);
    this.boundTouchStart = this.onTouchStart.bind(this);
    this.boundTouchMove = this.onTouchMove.bind(this);
    this.boundTouchEnd = this.onTouchEnd.bind(this);
    this.boundPointerDown = this.onPointerDown.bind(this);
    this.boundPointerMove = this.onPointerMove.bind(this);
    this.boundPointerUp = this.onPointerUp.bind(this);

    this.canvas.addEventListener("wheel", this.boundWheel, { passive: false });
    this.canvas.addEventListener("touchstart", this.boundTouchStart, { passive: false });
    this.canvas.addEventListener("touchmove", this.boundTouchMove, { passive: false });
    this.canvas.addEventListener("touchend", this.boundTouchEnd);
    this.canvas.addEventListener("pointerdown", this.boundPointerDown);
    this.canvas.addEventListener("pointermove", this.boundPointerMove);
    this.canvas.addEventListener("pointerup", this.boundPointerUp);
  }

  // -------------------------------------------------------------------------
  // Coordinate helpers
  // -------------------------------------------------------------------------

  private canvasPoint(clientX: number, clientY: number): Point {
    // Logical CSS pixels — layout is in logical units (the renderer scales the
    // ctx by dpr once at setup), so hit tests must match. See the same note in
    // `events.ts#getCanvasCoordinates`.
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  /**
   * Find the deepest scrollable ancestor at a canvas-space point,
   * accounting for existing scroll offsets.
   */
  private findScrollTarget(point: Point): VirtualNode | null {
    if (!this.rootNode) return null;
    return this.findScrollableAt(this.rootNode, point);
  }

  private findScrollableAt(node: VirtualNode, point: Point): VirtualNode | null {
    if (!node.visible || !node.layout) return null;

    const bounds = getScrollAwareBounds(node);
    if (!bounds) return null;

    if (
      point.x < bounds.x || point.x > bounds.x + bounds.width ||
      point.y < bounds.y || point.y > bounds.y + bounds.height
    ) {
      return null;
    }

    // Check children first (front-to-back)
    for (let i = node.children.length - 1; i >= 0; i--) {
      const found = this.findScrollableAt(node.children[i], point);
      if (found) return found;
    }

    if (isScrollable(node)) return node;
    return null;
  }

  // -------------------------------------------------------------------------
  // Wheel event
  // -------------------------------------------------------------------------

  /**
   * Walk up from a node to find the nearest scrollable ancestor (excluding
   * the node itself). Returns null if no scrollable ancestor exists.
   */
  private findScrollableAncestor(node: VirtualNode): VirtualNode | null {
    let current = node.parent;
    while (current) {
      if (isScrollable(current)) return current;
      current = current.parent;
    }
    return null;
  }

  /**
   * Check whether a scrollable node can scroll further in the given delta
   * direction. Returns true if there is remaining scroll range.
   */
  private canScrollInDirection(
    node: VirtualNode,
    dx: number,
    dy: number,
  ): boolean {
    const ss = node.scrollState;
    if (!ss) return false;
    const axes = getScrollAxes(node);
    const { maxX, maxY } = maxScroll(node);

    if (axes.y && dy < 0 && ss.scrollY > 0) return true;
    if (axes.y && dy > 0 && ss.scrollY < maxY) return true;
    if (axes.x && dx < 0 && ss.scrollX > 0) return true;
    if (axes.x && dx > 0 && ss.scrollX < maxX) return true;

    return false;
  }

  private onWheel(e: WheelEvent): void {
    const point = this.canvasPoint(e.clientX, e.clientY);
    let target: VirtualNode | null = this.findScrollTarget(point);
    if (!target) return;

    let dx = e.deltaX;
    let dy = e.deltaY;

    // Normalise to pixels (deltaMode: 0=pixel, 1=line, 2=page)
    if (e.deltaMode === 1) { dx *= 20; dy *= 20; }
    if (e.deltaMode === 2) { dx *= 400; dy *= 400; }

    // Bubble: if the deepest target can't scroll in the requested direction,
    // walk up to find an ancestor that can.
    while (target && !this.canScrollInDirection(target, dx, dy)) {
      target = this.findScrollableAncestor(target);
    }
    if (!target) return;

    const ss = ensureScrollState(target);
    const axes = getScrollAxes(target);
    const { maxX, maxY } = maxScroll(target);

    const canScrollX = axes.x && maxX > 0;
    const canScrollY = axes.y && maxY > 0;
    if (!canScrollX && !canScrollY) return;

    if (canScrollY) {
      const prev = ss.scrollY;
      ss.scrollY = Math.max(0, Math.min(ss.scrollY + dy, maxY));
      if (ss.scrollY !== prev) e.preventDefault();
    }
    if (canScrollX) {
      const prev = ss.scrollX;
      ss.scrollX = Math.max(0, Math.min(ss.scrollX + dx, maxX));
      if (ss.scrollX !== prev) e.preventDefault();
    }

    // Stop any momentum
    ss.velocityX = 0;
    ss.velocityY = 0;

    this.showScrollbar(ss);
    this.requestRedraw();
  }

  // -------------------------------------------------------------------------
  // Touch events
  // -------------------------------------------------------------------------

  private onTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    this.startDrag(t.clientX, t.clientY);
    if (this.activeNode) e.preventDefault();
  }

  private onTouchMove(e: TouchEvent): void {
    if (e.touches.length !== 1 || !this.activeNode) return;
    const t = e.touches[0];
    this.moveDrag(t.clientX, t.clientY);
    e.preventDefault();
  }

  private onTouchEnd(_e: TouchEvent): void {
    this.endDrag();
  }

  // -------------------------------------------------------------------------
  // Pointer events (for mouse-drag scrolling on desktop)
  // -------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    // Only handle middle-button or touch pointer
    if (e.pointerType === "touch") return; // already handled by touch events
    if (e.button !== 1) return; // middle-click to scroll
    this.startDrag(e.clientX, e.clientY);
    if (this.activeNode) {
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === "touch" || !this.activeNode) return;
    this.moveDrag(e.clientX, e.clientY);
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === "touch") return;
    this.endDrag();
  }

  // -------------------------------------------------------------------------
  // Drag helpers (shared between touch and pointer)
  // -------------------------------------------------------------------------

  private startDrag(clientX: number, clientY: number): void {
    this.stopMomentum();
    const point = this.canvasPoint(clientX, clientY);
    const target = this.findScrollTarget(point);
    if (!target) { this.activeNode = null; return; }

    const ss = ensureScrollState(target);
    ss.touching = true;
    ss.velocityX = 0;
    ss.velocityY = 0;

    this.activeNode = target;
    this.lastPointerX = clientX;
    this.lastPointerY = clientY;
    this.lastPointerTime = performance.now();

    this.showScrollbar(ss);
  }

  private moveDrag(clientX: number, clientY: number): void {
    const node = this.activeNode;
    if (!node) return;

    const ss = ensureScrollState(node);
    const axes = getScrollAxes(node);
    const { maxX, maxY } = maxScroll(node);
    const now = performance.now();
    const dt = now - this.lastPointerTime;

    // Logical pixel deltas — layout (and scroll bounds) live in logical units.
    const dx = axes.x ? -(clientX - this.lastPointerX) : 0;
    const dy = axes.y ? -(clientY - this.lastPointerY) : 0;

    ss.scrollX = clampScroll(ss.scrollX + dx, maxX, true);
    ss.scrollY = clampScroll(ss.scrollY + dy, maxY, true);

    // Track velocity (exponential moving average)
    if (dt > 0) {
      const alpha = 0.4;
      ss.velocityX = alpha * (dx / dt) + (1 - alpha) * ss.velocityX;
      ss.velocityY = alpha * (dy / dt) + (1 - alpha) * ss.velocityY;
    }

    this.lastPointerX = clientX;
    this.lastPointerY = clientY;
    this.lastPointerTime = now;

    this.showScrollbar(ss);
    this.requestRedraw();
  }

  private endDrag(): void {
    const node = this.activeNode;
    if (!node) return;

    const ss = ensureScrollState(node);
    ss.touching = false;
    this.activeNode = null;

    // If overscrolled, snap back. Otherwise start momentum.
    const { maxX, maxY } = maxScroll(node);
    const overscrolled =
      ss.scrollX < 0 || ss.scrollX > maxX ||
      ss.scrollY < 0 || ss.scrollY > maxY;

    if (overscrolled) {
      this.startSnapBack(node);
    } else {
      this.startMomentum(node);
    }
  }

  // -------------------------------------------------------------------------
  // Momentum animation
  // -------------------------------------------------------------------------

  private startMomentum(node: VirtualNode): void {
    this.stopMomentum();
    const ss = node.scrollState;
    if (!ss) return;

    const absVelocity = Math.abs(ss.velocityX) + Math.abs(ss.velocityY);
    if (absVelocity < MIN_VELOCITY) {
      this.beginScrollbarFade(ss);
      return;
    }

    this.lastMomentumTime = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = now - this.lastMomentumTime;
      this.lastMomentumTime = now;

      const { maxX, maxY } = maxScroll(node);

      ss.scrollX += ss.velocityX * dt;
      ss.scrollY += ss.velocityY * dt;

      // Decelerate
      const factor = Math.pow(FRICTION, dt);
      ss.velocityX *= factor;
      ss.velocityY *= factor;

      // Clamp to bounds (hard stop at edges)
      let stopped = false;
      if (ss.scrollX < 0) { ss.scrollX = 0; ss.velocityX = 0; stopped = true; }
      if (ss.scrollX > maxX) { ss.scrollX = maxX; ss.velocityX = 0; stopped = true; }
      if (ss.scrollY < 0) { ss.scrollY = 0; ss.velocityY = 0; stopped = true; }
      if (ss.scrollY > maxY) { ss.scrollY = maxY; ss.velocityY = 0; stopped = true; }

      const v = Math.abs(ss.velocityX) + Math.abs(ss.velocityY);
      this.requestRedraw();

      if (v < MIN_VELOCITY || stopped) {
        this.momentumRaf = null;
        this.beginScrollbarFade(ss);
      } else {
        this.momentumRaf = requestAnimationFrame(tick);
      }
    };

    this.momentumRaf = requestAnimationFrame(tick);
  }

  private startSnapBack(node: VirtualNode): void {
    this.stopMomentum();
    const ss = node.scrollState;
    if (!ss) return;

    const tick = () => {
      const { maxX, maxY } = maxScroll(node);
      let targetX = ss.scrollX;
      let targetY = ss.scrollY;

      if (targetX < 0) targetX = 0;
      else if (targetX > maxX) targetX = maxX;

      if (targetY < 0) targetY = 0;
      else if (targetY > maxY) targetY = maxY;

      const dx = targetX - ss.scrollX;
      const dy = targetY - ss.scrollY;

      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        ss.scrollX = targetX;
        ss.scrollY = targetY;
        this.momentumRaf = null;
        this.beginScrollbarFade(ss);
        this.requestRedraw();
        return;
      }

      ss.scrollX += dx * SNAP_BACK_SPEED;
      ss.scrollY += dy * SNAP_BACK_SPEED;
      this.requestRedraw();
      this.momentumRaf = requestAnimationFrame(tick);
    };

    this.momentumRaf = requestAnimationFrame(tick);
  }

  private stopMomentum(): void {
    if (this.momentumRaf !== null) {
      cancelAnimationFrame(this.momentumRaf);
      this.momentumRaf = null;
    }
  }

  // -------------------------------------------------------------------------
  // Scrollbar visibility
  // -------------------------------------------------------------------------

  private showScrollbar(ss: ScrollState): void {
    ss.scrollbarOpacity = 1;
    this.scrollbarLastActivity = performance.now();
    if (this.scrollbarFadeTimer !== null) {
      clearInterval(this.scrollbarFadeTimer);
      this.scrollbarFadeTimer = null;
    }
  }

  private beginScrollbarFade(ss: ScrollState): void {
    if (this.scrollbarFadeTimer !== null) return;
    this.scrollbarLastActivity = performance.now();

    this.scrollbarFadeTimer = setInterval(() => {
      const elapsed = performance.now() - this.scrollbarLastActivity;
      if (elapsed < SCROLLBAR_LINGER) return;

      ss.scrollbarOpacity -= SCROLLBAR_FADE_RATE * 16; // ~16ms per interval tick
      if (ss.scrollbarOpacity <= 0) {
        ss.scrollbarOpacity = 0;
        clearInterval(this.scrollbarFadeTimer!);
        this.scrollbarFadeTimer = null;
      }
      this.requestRedraw();
    }, 16) as unknown as number;
  }

  // -------------------------------------------------------------------------
  // Scrollbar painting (called from paint pipeline)
  // -------------------------------------------------------------------------

  /**
   * Draw scrollbar indicators for a scrollable node.
   * Call this after painting the node's children, while the clip is still active.
   */
  static paintScrollbars(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
    const ss = node.scrollState;
    if (!ss || ss.scrollbarOpacity <= 0) return;
    if (!node.layout) return;

    const layout = node.layout;
    const x = layout.x;
    const y = layout.y;
    const w = layout.width;
    const h = layout.height;

    const alpha = ss.scrollbarOpacity * 0.5;

    // Vertical scrollbar
    if (ss.scrollHeight > layout.contentHeight) {
      const trackHeight = h - SCROLLBAR_PADDING * 2;
      const ratio = layout.contentHeight / ss.scrollHeight;
      const thumbHeight = Math.max(SCROLLBAR_MIN_THUMB, trackHeight * ratio);
      const { maxY } = { maxY: Math.max(0, ss.scrollHeight - layout.contentHeight) };
      const scrollRatio = maxY > 0 ? ss.scrollY / maxY : 0;
      const thumbY = SCROLLBAR_PADDING + scrollRatio * (trackHeight - thumbHeight);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#888";
      drawPill(
        ctx,
        x + w - SCROLLBAR_SIZE - SCROLLBAR_PADDING,
        y + thumbY,
        SCROLLBAR_SIZE,
        thumbHeight,
      );
      ctx.fill();
      ctx.restore();
    }

    // Horizontal scrollbar
    if (ss.scrollWidth > layout.contentWidth) {
      const trackWidth = w - SCROLLBAR_PADDING * 2;
      const ratio = layout.contentWidth / ss.scrollWidth;
      const thumbWidth = Math.max(SCROLLBAR_MIN_THUMB, trackWidth * ratio);
      const { maxX } = { maxX: Math.max(0, ss.scrollWidth - layout.contentWidth) };
      const scrollRatio = maxX > 0 ? ss.scrollX / maxX : 0;
      const thumbX = SCROLLBAR_PADDING + scrollRatio * (trackWidth - thumbWidth);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#888";
      drawPill(
        ctx,
        x + thumbX,
        y + h - SCROLLBAR_SIZE - SCROLLBAR_PADDING,
        thumbWidth,
        SCROLLBAR_SIZE,
      );
      ctx.fill();
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Layout integration
  // -------------------------------------------------------------------------

  /**
   * After layout is computed, calculate the total content size of
   * scrollable containers so we know the max scroll range.
   */
  static updateScrollBounds(node: VirtualNode): void {
    if (!node.layout) return;

    // Recurse first so children have their layouts
    for (const child of node.children) {
      ScrollManager.updateScrollBounds(child);
    }

    const axes = getScrollAxes(node);
    if (!axes.x && !axes.y) return;

    const ss = ensureScrollState(node);
    let maxRight = 0;
    let maxBottom = 0;

    for (const child of node.children) {
      if (!child.layout) continue;
      // Child positions are absolute; make them relative to this container
      const relX = child.layout.x - node.layout.x - node.layout.contentX;
      const relY = child.layout.y - node.layout.y - node.layout.contentY;
      maxRight = Math.max(maxRight, relX + child.layout.width + child.layout.margin.right);
      maxBottom = Math.max(maxBottom, relY + child.layout.height + child.layout.margin.bottom);
    }

    // Cap content size to the viewport on disabled axes — otherwise a
    // horizontal strip with tall children would report a phantom scrollHeight
    // and the touch handler would let users drag vertically into nothing.
    ss.scrollWidth = axes.x ? maxRight : Math.min(maxRight, node.layout.contentWidth);
    ss.scrollHeight = axes.y ? maxBottom : Math.min(maxBottom, node.layout.contentHeight);

    // Clamp current scroll to new bounds
    const { maxX, maxY } = maxScroll(node);
    ss.scrollX = Math.max(0, Math.min(ss.scrollX, maxX));
    ss.scrollY = Math.max(0, Math.min(ss.scrollY, maxY));
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  destroy(): void {
    this.stopMomentum();
    if (this.scrollbarFadeTimer !== null) {
      clearInterval(this.scrollbarFadeTimer);
      this.scrollbarFadeTimer = null;
    }
    this.canvas.removeEventListener("wheel", this.boundWheel);
    this.canvas.removeEventListener("touchstart", this.boundTouchStart);
    this.canvas.removeEventListener("touchmove", this.boundTouchMove);
    this.canvas.removeEventListener("touchend", this.boundTouchEnd);
    this.canvas.removeEventListener("pointerdown", this.boundPointerDown);
    this.canvas.removeEventListener("pointermove", this.boundPointerMove);
    this.canvas.removeEventListener("pointerup", this.boundPointerUp);
    this.rootNode = null;
    this.activeNode = null;
  }
}

// ---------------------------------------------------------------------------
// Scroll-aware coordinate helpers (used by hit testing)
// ---------------------------------------------------------------------------

/**
 * Get the on-screen bounds for a node, accounting for scroll offsets of all
 * ancestors. `node.layout.{x,y}` is already absolute (computed in
 * `writeLayout` for the Taffy path and the fallback equivalent), so we only
 * need to subtract each scrollable ancestor's offset — the same translation
 * the paint pipeline applies via `ctx.translate(-scrollX, -scrollY)`.
 *
 * NOTE: an earlier version walked up to add `current.layout.contentX`,
 * which double-counted the parent's padding+border. That made hit testing
 * land on the wrong node any time content was nested more than a level deep.
 */
export function getScrollAwareBounds(node: VirtualNode): Rectangle | null {
  if (!node.layout) return null;

  let x = node.layout.x;
  let y = node.layout.y;

  let current = node.parent;
  while (current) {
    if (current.scrollState) {
      x -= current.scrollState.scrollX;
      y -= current.scrollState.scrollY;
    }
    current = current.parent;
  }

  return { x, y, width: node.layout.width, height: node.layout.height };
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const r = Math.min(w, h) / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
