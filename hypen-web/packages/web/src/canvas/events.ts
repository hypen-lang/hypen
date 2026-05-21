/**
 * Event System
 *
 * Hit testing and event handling for canvas nodes
 */

import type { VirtualNode, Point } from "./types.js";
import { isPointInRoundedRect } from "./utils.js";
import { getScrollAwareBounds } from "./scroll.js";
import { resolveEventAction } from "./props.js";

// Interface for the engine that CanvasEventManager needs
interface IEngine {
  dispatchAction(name: string, payload?: any): void;
}

// Maps a DOM event type to the applicator prop names the engine may have set
// on a node, in priority order. Multi-word events (`mouseenter`) need their
// proper camelCase form (`onMouseEnter`) since the engine emits applicator
// names verbatim. `mouseenter` also accepts `onHover` as an alias.
const CANVAS_EVENT_PROP_NAMES: Record<string, string[]> = {
  mouseenter: ["onMouseEnter", "onHover", "onmouseenter", "mouseenter"],
  mouseleave: ["onMouseLeave", "onmouseleave", "mouseleave"],
  mousedown: ["onMouseDown", "onmousedown", "mousedown"],
  mouseup: ["onMouseUp", "onmouseup", "mouseup"],
  dblclick: ["onDblClick", "onDoubleClick", "ondblclick", "dblclick"],
  contextmenu: ["onContextMenu", "oncontextmenu", "contextmenu"],
  keydown: ["onKeyDown", "onkeydown", "keydown"],
  keyup: ["onKeyUp", "onkeyup", "keyup"],
};

/**
 * Canvas Event Manager
 */
export class CanvasEventManager {
  private canvas: HTMLCanvasElement;
  private engine: IEngine;
  private rootNode: VirtualNode | null = null;
  private hoveredNode: VirtualNode | null = null;
  private focusedNode: VirtualNode | null = null;
  private mouseDownNode: VirtualNode | null = null;
  private focusChangeHandler:
    | ((next: VirtualNode | null, prev: VirtualNode | null) => void)
    | null = null;

  // Bound handler references for cleanup
  private boundOnMouseMove!: (e: MouseEvent) => void;
  private boundOnMouseDown!: (e: MouseEvent) => void;
  private boundOnMouseUp!: (e: MouseEvent) => void;
  private boundOnClick!: (e: MouseEvent) => void;
  private boundOnDoubleClick!: (e: MouseEvent) => void;
  private boundOnContextMenu!: (e: MouseEvent) => void;
  private boundOnKeyDown!: (e: KeyboardEvent) => void;
  private boundOnKeyUp!: (e: KeyboardEvent) => void;

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
   * Subscribe to focus changes. Used by the renderer to mount the
   * `InputOverlay` HTML element when an Input/Textarea gains focus and
   * unmount it when focus moves away. Without this hookup the canvas
   * Input painted as a pretty pill but a click on it did nothing — the
   * overlay was constructed but never invoked.
   */
  setFocusChangeHandler(
    fn: ((next: VirtualNode | null, prev: VirtualNode | null) => void) | null,
  ): void {
    this.focusChangeHandler = fn;
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
    this.boundOnKeyDown = this.onKeyDown.bind(this);
    this.boundOnKeyUp = this.onKeyUp.bind(this);

    this.canvas.addEventListener("mousemove", this.boundOnMouseMove);
    this.canvas.addEventListener("mousedown", this.boundOnMouseDown);
    this.canvas.addEventListener("mouseup", this.boundOnMouseUp);
    this.canvas.addEventListener("click", this.boundOnClick);
    this.canvas.addEventListener("dblclick", this.boundOnDoubleClick);
    this.canvas.addEventListener("contextmenu", this.boundOnContextMenu);
    this.canvas.addEventListener("keydown", this.boundOnKeyDown);
    this.canvas.addEventListener("keyup", this.boundOnKeyUp);
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
   */
  private hitTestNode(node: VirtualNode, point: Point): VirtualNode | null {
    if (!node.visible || !node.layout) return null;

    const bounds = getScrollAwareBounds(node);
    if (!bounds) return null;

    // Front-to-back order: absolute overlays (newest in paint stack)
    // first, then flow children in reverse paint order.
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child.props.position !== "absolute") continue;
      const hit = this.hitTestNode(child, point);
      if (hit) return hit;
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child.props.position === "absolute") continue;
      const hit = this.hitTestNode(child, point);
      if (hit) return hit;
    }

    // Test this node
    const radius = node.layout.border.radius;
    if (isPointInRoundedRect(point, bounds, radius)) {
      return node;
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
    const point = this.getCanvasCoordinates(e);
    // Same lift-to-clickable as hover so a click on a Button's Icon child
    // dispatches against the Button (where `onClick` actually lives).
    const hit = this.hitTest(point);
    const node = this.findClickableAncestor(hit) ?? hit;

    this.mouseDownNode = node;

    if (node && node.clickable) {
      this.dispatchNodeEvent(node, "mousedown", {
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    }

    // Update focus
    if (node && node.focusable) {
      this.setFocus(node);
    } else {
      this.setFocus(null);
    }
  }

  /**
   * Handle mouse up
   */
  private onMouseUp(e: MouseEvent): void {
    const point = this.getCanvasCoordinates(e);
    const hit = this.hitTest(point);
    const node = this.findClickableAncestor(hit) ?? hit;

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
   * Handle keyboard events
   */
  private onKeyDown(e: KeyboardEvent): void {
    if (this.focusedNode) {
      this.dispatchNodeEvent(this.focusedNode, "keydown", {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      });
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (this.focusedNode) {
      this.dispatchNodeEvent(this.focusedNode, "keyup", {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      });
    }
  }

  /**
   * Set focused node
   */
  private setFocus(node: VirtualNode | null): void {
    if (node === this.focusedNode) return;

    const prev = this.focusedNode;
    if (prev) {
      prev.focused = false;
      this.dispatchNodeEvent(prev, "blur", {});
    }

    this.focusedNode = node;

    if (node) {
      node.focused = true;
      this.dispatchNodeEvent(node, "focus", {});
    }

    if (this.focusChangeHandler) this.focusChangeHandler(node, prev);

    this.requestRedraw();
  }

  /** Public for the renderer's overlay-blur path. */
  clearFocus(): void {
    this.setFocus(null);
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
   * Dispatch event to engine
   */
  private dispatchNodeEvent(node: VirtualNode, eventType: string, data: any): void {
    // Engine emits event applicators in camelCase (`onClick`, `onMouseEnter`).
    // Multi-word DOM events like `mouseenter` must map to `onMouseEnter`, not
    // the naive `onMouseenter` that `on${capitalize(eventType)}` would produce.
    // The older flat form `onclick`/`onmouseenter` is still accepted. After
    // prop normalisation the value is either a string (action name) or an
    // object carrying an action name at `"0"` plus an auxiliary payload.
    const propNames = CANVAS_EVENT_PROP_NAMES[eventType] ?? [
      `on${eventType.charAt(0).toUpperCase()}${eventType.slice(1)}`,
      `on${eventType}`,
      eventType,
    ];

    let spec: unknown;
    for (const name of propNames) {
      if (node.props[name] != null) {
        spec = node.props[name];
        break;
      }
    }

    // Actionable components fall back to the bare `action` prop on click.
    if (spec == null && eventType === "click") {
      spec = node.props.action;
    }

    const resolved = resolveEventAction(spec);
    if (!resolved) return;

    this.engine.dispatchAction(resolved.actionName, {
      type: eventType,
      nodeId: node.id,
      timestamp: Date.now(),
      ...resolved.payload,
      ...data,
    });
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
    this.canvas.removeEventListener("keydown", this.boundOnKeyDown);
    this.canvas.removeEventListener("keyup", this.boundOnKeyUp);
    this.rootNode = null;
    this.hoveredNode = null;
    this.focusedNode = null;
    this.mouseDownNode = null;
  }
}









