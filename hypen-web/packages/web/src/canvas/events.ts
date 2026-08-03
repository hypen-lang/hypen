/**
 * Event System
 *
 * Hit testing and event handling for canvas nodes
 */

import type { VirtualNode, Point, Rectangle } from "./types.js";
import { isPointInRoundedRect } from "./utils.js";
import { dispatchNodeEvent } from "./dispatch.js";
import type { FocusManager } from "./focus.js";

// Interface for the engine that CanvasEventManager needs
interface IEngine {
  dispatchAction(name: string, payload?: any): void;
}

/**
 * Canvas Event Manager
 *
 * Pointer-side interaction: hit testing, hover/pressed state, cursor, and
 * click dispatch. Focus is NOT owned here — the pointer path funnels into
 * the {@link FocusManager}, which treats real DOM focus on the
 * accessibility-mirror (canvas fallback content) as the single source of
 * truth. Keyboard events likewise arrive via the mirror (a canvas without
 * tabindex never receives them), so this class attaches no key listeners.
 */
export class CanvasEventManager {
  private canvas: HTMLCanvasElement;
  private engine: IEngine;
  private rootNode: VirtualNode | null = null;
  private hoveredNode: VirtualNode | null = null;
  private mouseDownNode: VirtualNode | null = null;
  private focusManager: FocusManager | null = null;
  private editablePointerHandler: ((node: VirtualNode, point: Point) => void) | null = null;

  // Reused for the per-node rounded-rect test so hit testing allocates
  // nothing per visited node.
  private scratchBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  // Bound handler references for cleanup
  private boundOnMouseMove!: (e: MouseEvent) => void;
  private boundOnMouseDown!: (e: MouseEvent) => void;
  private boundOnMouseUp!: (e: MouseEvent) => void;
  private boundOnClick!: (e: MouseEvent) => void;
  private boundOnDoubleClick!: (e: MouseEvent) => void;
  private boundOnContextMenu!: (e: MouseEvent) => void;

  constructor(canvas: HTMLCanvasElement, engine: IEngine) {
    this.canvas = canvas;
    this.engine = engine;
    this.setupEventListeners();
  }

  /**
   * Set the root node for hit testing
   */
  setRootNode(node: VirtualNode | null): void {
    this.rootNode = node;
  }

  /**
   * Wire the focus manager the pointer path reports into. Clicking a
   * focusable node focuses its mirror element; clicking anything else
   * clears mirror focus.
   */
  setFocusManager(fm: FocusManager | null): void {
    this.focusManager = fm;
  }

  /**
   * Called with (node, point) when a mousedown lands on a focusable node —
   * the renderer maps the point to a caret position for editable nodes.
   */
  setEditablePointerHandler(
    fn: ((node: VirtualNode, point: Point) => void) | null,
  ): void {
    this.editablePointerHandler = fn;
  }

  /**
   * Setup canvas event listeners
   */
  private setupEventListeners(): void {
    this.boundOnMouseMove = this.onMouseMove.bind(this);
    this.boundOnMouseDown = this.onMouseDown.bind(this);
    this.boundOnMouseUp = this.onMouseUp.bind(this);
    this.boundOnClick = this.onClick.bind(this);
    this.boundOnDoubleClick = this.onDoubleClick.bind(this);
    this.boundOnContextMenu = this.onContextMenu.bind(this);

    this.canvas.addEventListener("mousemove", this.boundOnMouseMove);
    this.canvas.addEventListener("mousedown", this.boundOnMouseDown);
    this.canvas.addEventListener("mouseup", this.boundOnMouseUp);
    this.canvas.addEventListener("click", this.boundOnClick);
    this.canvas.addEventListener("dblclick", this.boundOnDoubleClick);
    this.canvas.addEventListener("contextmenu", this.boundOnContextMenu);
  }

  /**
   * Get canvas coordinates from mouse event.
   *
   * Returns LOGICAL pixels (CSS pixels), matching the layout coordinate
   * space. Layout is computed in logical units because the renderer calls
   * `ctx.scale(dpr, dpr)` once at setup; do NOT multiply by `canvas.width /
   * rect.width` here — that would land hit tests in canvas-pixel space (2x
   * on a HiDPI Mac), with the practical effect that the cursor changes to a
   * pointer above the actual element instead of on it.
   */
  private getCanvasCoordinates(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  /**
   * Find node at canvas coordinates
   */
  private hitTest(point: Point): VirtualNode | null {
    if (!this.rootNode) return null;
    return this.hitTestNode(this.rootNode, point);
  }

  /**
   * Recursively test node and children. Absolute-positioned siblings are
   * checked first because they paint on top (see `paint.ts` overlay
   * ordering) — without this, a click on the Story's close-button overlay
   * lands on the underlying Image instead.
   *
   * `scrollX`/`scrollY` accumulate the ancestors' scroll offsets down the
   * recursion (the translation paint applies) so no per-node ancestor walk
   * is needed. Subtrees behind a clipping container are pruned when the
   * point falls outside the container — nothing inside can be visible there.
   */
  private hitTestNode(
    node: VirtualNode,
    point: Point,
    scrollX: number = 0,
    scrollY: number = 0,
  ): VirtualNode | null {
    // Exit-animating subtrees are pruned wholesale: the corpse is painted
    // while its exit plays, but engine-side those ids are already dead.
    if (!node.visible || !node.layout || node.exiting) return null;

    const layout = node.layout;
    const x = layout.x - scrollX;
    const y = layout.y - scrollY;
    const inBounds =
      point.x >= x && point.x <= x + layout.width &&
      point.y >= y && point.y <= y + layout.height;

    if (!inBounds) {
      const overflow = node.props.overflow;
      if (overflow === "hidden" || overflow === "scroll" || overflow === "auto") {
        return null;
      }
    }

    const childScrollX = scrollX + (node.scrollState?.scrollX ?? 0);
    const childScrollY = scrollY + (node.scrollState?.scrollY ?? 0);

    // Front-to-back order: absolute overlays (newest in paint stack)
    // first, then flow children in reverse paint order.
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child.props.position !== "absolute") continue;
      const hit = this.hitTestNode(child, point, childScrollX, childScrollY);
      if (hit) return hit;
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child.props.position === "absolute") continue;
      const hit = this.hitTestNode(child, point, childScrollX, childScrollY);
      if (hit) return hit;
    }

    // Test this node
    if (inBounds) {
      const radius = layout.border.radius;
      if (radius <= 0) return node;
      const bounds = this.scratchBounds;
      bounds.x = x;
      bounds.y = y;
      bounds.width = layout.width;
      bounds.height = layout.height;
      if (isPointInRoundedRect(point, bounds, radius)) {
        return node;
      }
    }

    return null;
  }

  /**
   * Walk up from a node to find the nearest clickable ancestor (or the node
   * itself if it's clickable). Returns null if none. Used so that hovering
   * a non-clickable child of a Button (e.g. the Icon inside a transparent
   * nav button) still resolves to the Button for cursor + click purposes.
   */
  private findClickableAncestor(node: VirtualNode | null): VirtualNode | null {
    let current = node;
    while (current) {
      if (current.clickable) return current;
      current = current.parent;
    }
    return null;
  }

  /**
   * Handle mouse move
   */
  private onMouseMove(e: MouseEvent): void {
    const point = this.getCanvasCoordinates(e);
    const hit = this.hitTest(point);
    // Resolve to the clickable ancestor so the cursor stays a pointer over
    // the whole Button surface (not flashing back to default whenever the
    // mouse passes over the Button's non-clickable Icon child).
    const node = this.findClickableAncestor(hit) ?? hit;

    // Update hover state
    if (node !== this.hoveredNode) {
      // Leave old node
      if (this.hoveredNode) {
        this.hoveredNode.hovered = false;
        this.dispatchNodeEvent(this.hoveredNode, "mouseleave", {});
      }

      // Enter new node
      this.hoveredNode = node;
      if (node) {
        node.hovered = true;
        this.dispatchNodeEvent(node, "mouseenter", {});
      }

      // Update cursor
      this.updateCursor(node);

      // Request redraw for hover effects
      this.requestRedraw();
    }
  }

  /**
   * Handle mouse down
   */
  private onMouseDown(e: MouseEvent): void {
    // Suppress the browser's default mousedown focus action. The canvas
    // itself isn't focusable, so the default would move focus to <body>
    // AFTER this handler — undoing the mirror/proxy focus we set below and
    // instantly ending any edit session. (Synthetic events have no default
    // action, so this only bites with real pointers.)
    e.preventDefault?.();

    const point = this.getCanvasCoordinates(e);
    // Same lift-to-clickable as hover so a click on a Button's Icon child
    // dispatches against the Button (where `onClick` actually lives).
    const hit = this.hitTest(point);
    const node = this.findClickableAncestor(hit) ?? hit;

    this.mouseDownNode = node;

    // Track pressed (`:active`) state so paint-time `:active` variants resolve.
    // Repaint so the active style appears immediately on press.
    if (node) {
      node.pressed = true;
      this.requestRedraw();
    }

    if (node && node.clickable) {
      this.dispatchNodeEvent(node, "mousedown", {
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    }

    // Focus routes through the mirror: focusing the node's fallback-content
    // element makes document.activeElement the truth, and the FocusManager's
    // focusin/focusout handlers update node state + repaint.
    if (node && node.focusable) {
      this.focusManager?.requestFocus(node);
      // After focus (which starts an edit session for Input/Textarea), let
      // the renderer place the caret at the clicked character.
      this.editablePointerHandler?.(node, point);
    } else {
      this.focusManager?.requestFocus(null);
    }
  }

  /**
   * Handle mouse up
   */
  private onMouseUp(e: MouseEvent): void {
    const point = this.getCanvasCoordinates(e);
    const hit = this.hitTest(point);
    const node = this.findClickableAncestor(hit) ?? hit;

    // Clear the pressed (`:active`) flag from the node that was pressed —
    // release ends `:active` even if the pointer drifted off the node first.
    if (this.mouseDownNode && this.mouseDownNode.pressed) {
      this.mouseDownNode.pressed = false;
      this.requestRedraw();
    }

    if (node && node.clickable) {
      this.dispatchNodeEvent(node, "mouseup", {
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    }

    // NOTE: do NOT clear `this.mouseDownNode` here — the browser fires
    // `click` after `mouseup`, and onClick uses mouseDownNode to verify
    // press+release happened on the same target. Clearing here meant the
    // click handler always saw `null` and silently dropped every click.
    // The click handler clears mouseDownNode itself.
  }

  /**
   * Handle click
   */
  private onClick(e: MouseEvent): void {
    const point = this.getCanvasCoordinates(e);
    const hit = this.hitTest(point);
    const node = this.findClickableAncestor(hit) ?? hit;

    if (node && node.clickable && node === this.mouseDownNode) {
      this.dispatchNodeEvent(node, "click", {
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    }
    this.mouseDownNode = null;
  }

  /**
   * Handle double click
   */
  private onDoubleClick(e: MouseEvent): void {
    const point = this.getCanvasCoordinates(e);
    const node = this.hitTest(point);

    if (node && node.clickable) {
      this.dispatchNodeEvent(node, "dblclick", {
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    }
  }

  /**
   * Handle context menu (right-click)
   */
  private onContextMenu(e: MouseEvent): void {
    const point = this.getCanvasCoordinates(e);
    const node = this.hitTest(point);

    if (node) {
      const actionName = node.props["oncontextmenu"] || node.props["contextmenu"];

      if (actionName && typeof actionName === "string") {
        e.preventDefault();
        this.dispatchNodeEvent(node, "contextmenu", {
          button: e.button,
          clientX: e.clientX,
          clientY: e.clientY,
        });
      }
    }
  }

  /**
   * Update cursor based on node
   */
  private updateCursor(node: VirtualNode | null): void {
    if (!node) {
      this.canvas.style.cursor = "default";
      return;
    }

    let cursor: string | undefined = node.props.cursor;
    if (!cursor) {
      const t = node.type.toLowerCase();
      if (t === "input" || t === "textarea") cursor = "text";
      else if (node.clickable) cursor = "pointer";
      else cursor = "default";
    }
    this.canvas.style.cursor = cursor;
  }

  /**
   * Dispatch event to engine (shared resolver — same payload shape as the
   * mirror's keyboard/AT path).
   */
  private dispatchNodeEvent(node: VirtualNode, eventType: string, data: any): void {
    dispatchNodeEvent(this.engine, node, eventType, data);
  }

  /**
   * Request redraw from renderer
   */
  private requestRedraw(): void {
    // This will be called via a callback set by the renderer
    // For now, dispatch a custom event
    this.canvas.dispatchEvent(new CustomEvent("hypen:redraw"));
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.canvas.removeEventListener("mousemove", this.boundOnMouseMove);
    this.canvas.removeEventListener("mousedown", this.boundOnMouseDown);
    this.canvas.removeEventListener("mouseup", this.boundOnMouseUp);
    this.canvas.removeEventListener("click", this.boundOnClick);
    this.canvas.removeEventListener("dblclick", this.boundOnDoubleClick);
    this.canvas.removeEventListener("contextmenu", this.boundOnContextMenu);
    if (this.mouseDownNode) this.mouseDownNode.pressed = false;
    this.rootNode = null;
    this.hoveredNode = null;
    this.mouseDownNode = null;
    this.focusManager = null;
  }
}









