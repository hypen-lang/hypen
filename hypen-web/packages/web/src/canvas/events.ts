/**
 * Event System
 *
 * Hit testing and event handling for canvas nodes
 */

import type { VirtualNode, Point, Rectangle } from "./types.js";
import { isPointInRoundedRect } from "./utils.js";
import { dispatchNodeEvent } from "./dispatch.js";
import {
  isFormControl,
  isToggleControl,
  isSliderControl,
  isControlDisabled,
  activateToggle,
  finishSliderDrag as finishSliderDragCommit,
  updateSliderDrag,
} from "./controls.js";
import {
  beginScrubberDrag,
  cancelScrubberDrag,
  commitScrubberDrag,
  hasVideoSlot,
  isScrubberLive,
  isScrubberNode,
  isInsideVideoSlot,
  isVideoNode,
  isVideoSlotChildVisible,
  scrubberFractionAt,
  toggleVideoPlayback,
  updateScrubberDrag,
  visibleVideoSlotChildren,
} from "./paint.js";
import type { FocusManager } from "./focus.js";

/** `controls` may arrive as a boolean or a "true"/"false" string. */
function hasVideoControls(node: VirtualNode): boolean {
  const v = node.props.controls;
  return v === true || v === "true" || (v !== undefined && v !== null && v !== false && v !== "false" && !!v);
}

/**
 * The renderer-local video intent a node is tagged with, or null.
 * `.videoIntent("fullscreen")` lowers to the `videoIntent.0` prop; the flat
 * alias is accepted the same way slot names are.
 */
function videoIntentOf(node: VirtualNode): string | null {
  const raw = node.props["videoIntent.0"] ?? node.props.videoIntent;
  return typeof raw === "string" ? raw : null;
}

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
  /** Scrubber the pointer is currently dragging (local preview, no dispatch). */
  private scrubbingNode: VirtualNode | null = null;
  /** Slider currently being dragged, if any. Mirrors `scrubbingNode`. */
  private slidingNode: VirtualNode | null = null;
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
  private boundOnWindowRelease!: (e: MouseEvent) => void;
  /** True while the drag-scoped window release listeners are registered. */
  private windowReleaseArmed = false;

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
    this.boundOnWindowRelease = this.onWindowRelease.bind(this);

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

    // A Video's slot children are only hittable while the normative
    // visibility table shows them (a `controls` overlay must not swallow
    // taps in `loading`), and untagged children of a Video never are.
    if (!isVideoSlotChildVisible(node)) return null;

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

    if (isVideoNode(node)) {
      // A Video's children paint in NORMATIVE slot order (poster → loading
      // → controls → error, bottom-to-top), not declaration order — so hit
      // testing walks the same list topmost-first. Without this, a `poster`
      // slot declared after `controls` (the spec's own example order) would
      // swallow the controls' taps in `idle`/`ended`, where both are
      // visible — exactly the states where a controls-slot play button must
      // be reachable to start first play.
      const slots = visibleVideoSlotChildren(node);
      for (let i = slots.length - 1; i >= 0; i--) {
        const hit = this.hitTestNode(slots[i]!, point, childScrollX, childScrollY);
        if (hit) return hit;
      }
    } else {
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
   * Walk up from a hit node to the nearest Video (video nodes are leaves,
   * so the hit itself is the common case — the walk covers overlays that
   * absorb the hit inside a Video-wrapping Stack).
   */
  private findVideoAncestor(node: VirtualNode | null): VirtualNode | null {
    let current = node;
    while (current) {
      if (current.type.toLowerCase() === "video") return current;
      current = current.parent;
    }
    return null;
  }

  /**
   * Walk up from a hit node to the nearest node carrying a renderer-local
   * `.videoIntent(...)` (normally the hit itself — a controls-slot Button —
   * but a tap can land on that Button's Icon child).
   */
  private findVideoIntentAncestor(node: VirtualNode | null): VirtualNode | null {
    let current = node;
    while (current) {
      if (videoIntentOf(current) !== null) return current;
      current = current.parent;
    }
    return null;
  }

  /**
   * Renderer-local fullscreen intent (`.videoIntent("fullscreen")`).
   *
   * Runs SYNCHRONOUSLY inside the input handler: platforms gate fullscreen
   * behind a user gesture, and even a local promise hop can lose transient
   * activation. Presentation only — no action dispatch, no module round
   * trip, and the player's state/events are untouched.
   *
   * Target: the canvas HOST element, which is this renderer's analogue of
   * the DOM wrapper. The canvas paints the whole app, so the video surface
   * AND its painted slot chrome (custom controls) scale with it — the same
   * normative guarantee the DOM path gets by fullscreening the video
   * container rather than the raw <video>.
   *
   * Returns true when the intent was consumed, so the caller can suppress
   * the built-in tap-to-toggle for that same tap.
   */
  private handleVideoIntent(node: VirtualNode): boolean {
    if (videoIntentOf(node) !== "fullscreen") return false;
    // Inert outside a Video subtree (contract: the intent is scoped to a
    // player, exactly like Scrubber).
    if (!this.findVideoAncestor(node)) return false;

    const host = this.canvas as HTMLCanvasElement & {
      requestFullscreen?: () => Promise<void>;
      ownerDocument?: Document;
    };
    const doc = (host.ownerDocument ?? (globalThis as any).document) as
      | (Document & { fullscreenElement?: Element | null; exitFullscreen?: () => Promise<void> })
      | undefined;
    try {
      if (doc?.fullscreenElement === host) {
        void doc.exitFullscreen?.();
      } else {
        void host.requestFullscreen?.();
      }
    } catch {
      // Environments without the Fullscreen API (or with it blocked by
      // permissions policy) simply render the intent inert.
    }
    return true;
  }

  /**
   * Walk up from a hit node to the nearest Scrubber (the widget is a leaf,
   * so this normally resolves to the hit itself).
   */
  /**
   * Nearest form control at or above `node`.
   *
   * Same lift as `findClickableAncestor`: a press on the label inside a
   * Checkbox has to operate the checkbox, not fall through to the container.
   */
  private findFormControlAncestor(node: VirtualNode | null): VirtualNode | null {
    let current = node;
    while (current) {
      if (isFormControl(current)) return current;
      current = current.parent;
    }
    return null;
  }

  private findScrubberAncestor(node: VirtualNode | null): VirtualNode | null {
    let current = node;
    while (current) {
      if (isScrubberNode(current)) return current;
      current = current.parent;
    }
    return null;
  }

  /**
   * A Scrubber drag owns the pointer beyond the canvas: the button can be
   * released anywhere on the page (or outside the window entirely), so while
   * a drag is live we listen for release at the window level. Registered on
   * drag start, removed as soon as the drag finalizes — the listeners never
   * outlive the drag they serve.
   */
  private armWindowRelease(): void {
    if (this.windowReleaseArmed || typeof window === "undefined") return;
    window.addEventListener("pointerup", this.boundOnWindowRelease);
    window.addEventListener("mouseup", this.boundOnWindowRelease);
    this.windowReleaseArmed = true;
  }

  private disarmWindowRelease(): void {
    if (!this.windowReleaseArmed) return;
    this.windowReleaseArmed = false;
    if (typeof window === "undefined") return;
    window.removeEventListener("pointerup", this.boundOnWindowRelease);
    window.removeEventListener("mouseup", this.boundOnWindowRelease);
  }

  /**
   * Release observed at the window level (pointer left the canvas before the
   * button went up). Commit — DOM's <input type=range> commits on release
   * wherever the pointer is, and the local preview the user watched during
   * the drag is exactly what commit applies. A release the canvas handler
   * already consumed leaves scrubbingNode null; then this only tidies up.
   */
  private onWindowRelease(e: MouseEvent): void {
    if (this.scrubbingNode) {
      this.finishScrubberDrag(e);
      return;
    }
    if (this.slidingNode) {
      this.finishSliderDrag();
      return;
    }
    this.disarmWindowRelease();
  }

  /**
   * Finalize the live drag exactly once: sync the preview to the event's
   * pointer x (fraction clamps to the track), commit (seek + bind write or
   * onSeek), drop the window listeners, repaint. Every release path — canvas
   * mouseup, window pointerup/mouseup, and the missed-release guard in
   * onMouseMove — funnels here so commit semantics cannot diverge.
   */
  /**
   * End a slider drag exactly once: the value was written and `input`
   * dispatched on every move; this sends the single `change`. Every release
   * path — canvas mouseup/click, window release, the buttonless-move guard,
   * and removal of the node — funnels here.
   */
  private finishSliderDrag(): void {
    const slider = this.slidingNode;
    if (!slider) return;
    this.slidingNode = null;
    this.disarmWindowRelease();
    finishSliderDragCommit(this.engine, slider);
    this.requestRedraw();
  }

  private finishScrubberDrag(e: MouseEvent): void {
    const scrubber = this.scrubbingNode;
    if (!scrubber) return;
    this.scrubbingNode = null;
    this.disarmWindowRelease();
    const point = this.getCanvasCoordinates(e);
    updateScrubberDrag(scrubber, scrubberFractionAt(scrubber, point.x));
    commitScrubberDrag(scrubber);
    this.requestRedraw();
  }

  /**
   * Handle mouse move
   */
  private onMouseMove(e: MouseEvent): void {
    const point = this.getCanvasCoordinates(e);

    // A scrub in flight owns the pointer: preview locally (no dispatch, no
    // hover churn) until release commits.
    if (this.scrubbingNode) {
      // No buttons down means the release happened where nobody could see
      // it (outside the window, alt-tab, listener races). Finalize now —
      // commit, matching release semantics — instead of letting the thumb
      // follow buttonless hover forever and a later unrelated click commit
      // a stale seek. Strict === 0: synthetic events without a `buttons`
      // field (undefined) must not end a drag.
      if (e.buttons === 0) {
        this.finishScrubberDrag(e);
        return;
      }
      updateScrubberDrag(this.scrubbingNode, scrubberFractionAt(this.scrubbingNode, point.x));
      this.requestRedraw();
      return;
    }

    if (this.slidingNode) {
      // Same buttonless-release guard the scrubber uses: a drag that ended
      // where no listener saw it must finalize rather than follow the cursor.
      if (e.buttons === 0) {
        this.finishSliderDrag();
      } else {
        updateSliderDrag(this.engine, this.slidingNode, point.x);
        this.requestRedraw();
        return;
      }
    }

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

    // Press on a live Scrubber starts a local scrub: the thumb follows the
    // pointer renderer-side and nothing is dispatched until release.
    const scrubber = this.findScrubberAncestor(hit);
    if (scrubber && isScrubberLive(scrubber)) {
      this.scrubbingNode = scrubber;
      beginScrubberDrag(scrubber, scrubberFractionAt(scrubber, point.x));
      // The release may land anywhere — arm window-level listeners for the
      // lifetime of this drag so an off-canvas release still commits.
      this.armWindowRelease();
      this.requestRedraw();
    }

    // Press on a slider starts a drag and seeks immediately, so a click
    // anywhere on the track jumps the thumb there — the same affordance the
    // scrubber and every native slider give.
    const control = this.findFormControlAncestor(hit);
    if (control && isSliderControl(control) && !isControlDisabled(control)) {
      this.slidingNode = control;
      updateSliderDrag(this.engine, control, point.x);
      this.armWindowRelease();
      this.requestRedraw();
    }

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

    // Release commits the scrub exactly once (seek + `position` bind write
    // or `onSeek`), then the pointer goes back to normal handling. (With a
    // real pointer the window-level pointerup may have finalized already —
    // finishScrubberDrag no-ops when the drag is gone.)
    if (this.scrubbingNode) {
      this.finishScrubberDrag(e);
    }
    // A slider drag ends on release too (click may not follow if press and
    // release straddled the canvas edge).
    this.finishSliderDrag();

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

    // Renderer-local video intents fire on a COMPLETED tap: press and
    // release must resolve to the same intent node (the same pairing rule
    // the click dispatch below uses), so a press that drifts off the
    // button never fullscreens.
    const intentNode = this.findVideoIntentAncestor(hit);
    const intentHandled =
      intentNode !== null &&
      this.findVideoIntentAncestor(this.mouseDownNode) === intentNode &&
      this.handleVideoIntent(intentNode);

    // Canvas video controls common denominator: tap toggles play/pause.
    // Only when the node opts in via `controls` (DOM parity — a
    // controls-less <video> offers no transport UI either).
    //
    // A `controls` slot REPLACES the built-in transport (normative), so it
    // suppresses tap-to-toggle regardless of the `controls` prop; and a tap
    // that landed inside ANY slot's authored chrome (a Retry button, a
    // Scrubber) is that widget's, never the player's. A tap consumed by a
    // renderer-local intent likewise isn't the player's: fullscreen is
    // presentation only and must not also pause playback.
    const videoNode = this.findVideoAncestor(hit);
    if (
      !intentHandled &&
      videoNode &&
      hasVideoControls(videoNode) &&
      !hasVideoSlot(videoNode, "controls") &&
      !isInsideVideoSlot(hit)
    ) {
      toggleVideoPlayback(videoNode.id);
      this.requestRedraw();
    }

    // A slider drag ends here; its value is already committed.
    this.finishSliderDrag();

    // Operate a toggle before the generic click dispatch, so a control that
    // also carries `onClick` gets both its state change and its action.
    const control = this.findFormControlAncestor(hit);
    if (
      control &&
      isToggleControl(control) &&
      control === this.findFormControlAncestor(this.mouseDownNode)
    ) {
      if (activateToggle(this.engine, control)) {
        this.requestRedraw();
      }
    }

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
      else if (t === "scrubber" && isScrubberLive(node)) cursor = "pointer";
      else if (
        t === "video" &&
        hasVideoControls(node) &&
        !hasVideoSlot(node, "controls")
      ) cursor = "pointer";
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
  /**
   * Drop pointer state that refers to `node` or a descendant — called before
   * a subtree is removed or detached, so a slider removed mid-drag stops
   * receiving writes and a pressed node does not stay `:active` forever.
   */
  clearIfWithin(node: VirtualNode): void {
    const within = (candidate: VirtualNode | null): boolean => {
      for (let cur = candidate; cur; cur = cur.parent) if (cur === node) return true;
      return false;
    };
    if (within(this.slidingNode)) {
      // No `change`: the node is engine-dead.
      this.slidingNode = null;
      if (!this.scrubbingNode) this.disarmWindowRelease();
    }
    if (within(this.scrubbingNode)) {
      cancelScrubberDrag();
      this.scrubbingNode = null;
      if (!this.slidingNode) this.disarmWindowRelease();
    }
    if (within(this.mouseDownNode)) {
      this.mouseDownNode!.pressed = false;
      this.mouseDownNode = null;
    }
    if (within(this.hoveredNode)) this.hoveredNode = null;
  }

  destroy(): void {
    this.canvas.removeEventListener("mousemove", this.boundOnMouseMove);
    this.canvas.removeEventListener("mousedown", this.boundOnMouseDown);
    this.canvas.removeEventListener("mouseup", this.boundOnMouseUp);
    this.canvas.removeEventListener("click", this.boundOnClick);
    this.canvas.removeEventListener("dblclick", this.boundOnDoubleClick);
    this.canvas.removeEventListener("contextmenu", this.boundOnContextMenu);
    if (this.mouseDownNode) this.mouseDownNode.pressed = false;
    if (this.scrubbingNode) cancelScrubberDrag();
    this.scrubbingNode = null;
    this.slidingNode = null;
    this.disarmWindowRelease();
    this.rootNode = null;
    this.hoveredNode = null;
    this.mouseDownNode = null;
    this.focusManager = null;
  }
}









