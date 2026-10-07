import { dispatchUIAction } from "@hypen-space/core";
/**
 * Native Canvas Text Editing
 *
 * Text, caret, and selection are painted on the canvas; the browser does
 * the actual editing (typing, caret movement, word-jumps, select-all,
 * clipboard, undo, IME composition) in a single hidden **proxy textarea**
 * positioned at the caret — the Monaco/xterm.js approach. This controller
 * reads `value`/`selectionStart`/`selectionEnd` from the proxy after each
 * event and the canvas paints the result. No visible DOM overlay.
 *
 * Why a proxy and not the accessibility-mirror input itself: the proxy is
 * per-session and positioned at the caret, which (a) puts the IME candidate
 * window next to the painted text regardless of where the mirror element
 * sits, and (b) gives screen readers a FRESH focus target per field so
 * every field is announced (AT stays silent when focus "returns" to an
 * element it already announced). Focus and accessibility live on the
 * mirror; the keystroke stream lives on the proxy.
 *
 * Positioning the proxy at the caret makes the IME candidate window
 * appear next to the painted text.
 *
 * Data flow for one keystroke:
 *   focusin on mirror input → beginEditing → proxy seeded + focused
 *   key → proxy (native edit) → "input" event
 *     → EditState {value, selStart, selEnd} read from the proxy
 *     → node.props.value = value (local echo so the next paint is current)
 *     → engine.dispatchAction("__hypen_bind", {path, value})  (two-way bind)
 *     → scheduleRedraw + caret blink reset
 *   engine echoes SetProp("value") → onEngineValueEcho → same value → no-op
 *   (a *different* echo, e.g. engine-side formatting, rewrites the proxy
 *   and clamps the selection).
 */

import type { Point, Rectangle, VirtualNode } from "./types.js";
import type { DispatchEngine } from "./dispatch.js";
import { getScrollAwareBounds } from "./scroll.js";
import { cssLengthToPx } from "./utils.js";
import {
  nodeTextGeometry,
  offsetToCaretRect,
  pointToOffset,
  type TextGeometry,
} from "./text-geometry.js";

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

/** Margin kept between the caret and the content edge when auto-scrolling. */
const CARET_SCROLL_MARGIN = 4;

export interface EditState {
  node: VirtualNode;
  /** The hidden proxy textarea receiving keystrokes and IME composition. */
  element: EditableElement;
  /** The node's accessibility-mirror element (Tab transit target). */
  mirrorElement: HTMLElement;
  value: string;
  selStart: number;
  selEnd: number;
  /** IME composition range (underlined in paint), null when not composing. */
  compStart: number | null;
  compEnd: number | null;
  composing: boolean;
  /** Horizontal pan for single-line inputs whose text overflows. */
  scrollX: number;
  /** Caret blink phase. */
  caretVisible: boolean;
}

export interface TextEditHooks {
  scheduleRedraw(): void;
  /** Mark the edited node's region dirty (dirty-rect mode). */
  markDirty(node: VirtualNode): void;
  /**
   * Focus left the proxy for somewhere outside the canvas — the renderer
   * clears the focus manager so `node.focused` follows.
   */
  onEditBlur(): void;
}

export function isEditableNode(node: VirtualNode | null): boolean {
  if (!node) return false;
  const t = node.type.toLowerCase();
  return t === "input" || t === "textarea";
}

/** Whether an element lives inside the accessibility mirror. */
function isInMirror(el: HTMLElement | null): boolean {
  let current: any = el;
  while (current) {
    if (current.getAttribute?.("data-hypen-id")) return true;
    current = current.parentNode;
  }
  return false;
}

export class TextEditController {
  private canvas: HTMLCanvasElement;
  private engine: DispatchEngine;
  private hooks: TextEditHooks;
  private state: EditState | null = null;
  private bindPath: string | null = null;
  private proxy: HTMLTextAreaElement | null = null;

  /** Blink period; tests may set 0 to disable the timer. */
  blinkIntervalMs = 530;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;

  // Drag-selection tracking (canvas mousemove while button held on the node)
  private dragAnchor: number | null = null;

  private boundInput = () => this.onInput();
  private boundSelect = () => this.onSelectionMaybeChanged();
  private boundKeyUp = () => this.onSelectionMaybeChanged();
  private boundKeyDown = (e: Event) => this.onKeyDown(e as KeyboardEvent);
  private boundCompStart = () => this.onCompositionStart();
  private boundCompUpdate = (e: Event) => this.onCompositionUpdate(e as CompositionEvent);
  private boundCompEnd = () => this.onCompositionEnd();
  private boundSelectionChange = () => this.onDocumentSelectionChange();
  private boundBlur = (e: Event) => this.onProxyBlur(e as FocusEvent);
  private boundDragMove = (e: Event) => this.onDragMove(e as MouseEvent);
  private boundDragEnd = () => this.onDragEnd();

  constructor(canvas: HTMLCanvasElement, engine: DispatchEngine, hooks: TextEditHooks) {
    this.canvas = canvas;
    this.engine = engine;
    this.hooks = hooks;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /**
   * The hidden keystroke/IME target. A FRESH element per edit session:
   * screen readers key announcements off focus moving to a *new* node — a
   * reused proxy reads as "focus returned to the element I already
   * announced" and stays silent, so tabbing between fields would speak the
   * first field's label and then nothing. Kept OUT of the tab order
   * (tabindex=-1) — Tab reaches inputs through their mirror elements;
   * `beginEditing` hands focus here from there.
   */
  private createProxy(node: VirtualNode): HTMLTextAreaElement | null {
    if (typeof document === "undefined") return null;

    const proxy = document.createElement("textarea") as HTMLTextAreaElement;
    proxy.setAttribute("tabindex", "-1");
    proxy.setAttribute("autocorrect", "off");
    proxy.setAttribute("autocapitalize", "off");
    proxy.setAttribute("spellcheck", "false");
    proxy.setAttribute("data-hypen-ime-proxy", "");
    Object.assign(proxy.style, {
      position: "absolute",
      width: "1px",
      height: "16px",
      padding: "0",
      border: "0",
      outline: "none",
      margin: "0",
      opacity: "0",
      background: "transparent",
      color: "transparent",
      resize: "none",
      overflow: "hidden",
      zIndex: "1000",
      // Never intercept pointer events meant for the canvas underneath.
      pointerEvents: "none",
    });

    // Announce like the field it stands in for: label, hint, multiline-ness.
    const isSingleLine = node.type.toLowerCase() === "input";
    proxy.setAttribute("aria-multiline", isSingleLine ? "false" : "true");
    const label =
      node.semantics?.name || node.props.placeholder || node.props["aria-label"];
    if (label) proxy.setAttribute("aria-label", String(label));
    if (node.props.placeholder != null) {
      proxy.placeholder = String(node.props.placeholder);
    }

    // IME metrics and iOS zoom guard: candidate windows size off the
    // focused element's font; iOS Safari zooms inputs under 16px.
    const fontSize = Math.max(16, cssLengthToPx(node.props.fontSize) ?? 16);
    proxy.style.font = `${fontSize}px ${node.props.fontFamily || "system-ui, sans-serif"}`;

    const host =
      (this.canvas as any).parentElement ||
      (typeof document !== "undefined" ? document.body : null);
    host?.appendChild?.(proxy);

    return proxy;
  }

  /**
   * Start editing a node. `mirrorElement` is the node's fallback-content
   * element (focus/AT anchor); keystrokes flow through the hidden proxy.
   * Idempotent for the same node.
   */
  beginEditing(node: VirtualNode, mirrorElement: HTMLElement): void {
    if (this.state?.node === node) return;
    this.endEditing();

    const element = this.createProxy(node);
    if (!element) return;
    this.proxy = element;

    this.bindPath = typeof node.props.bind === "string" ? node.props.bind : null;

    // Seed the proxy from the node; caret at the end (the pointer path
    // refines it via placeCaretFromPoint right after).
    const value = String(node.props.value ?? "");
    element.value = value;
    element.setSelectionRange?.(value.length, value.length);

    this.state = {
      node,
      element,
      mirrorElement,
      value,
      selStart: element.selectionStart ?? value.length,
      selEnd: element.selectionEnd ?? value.length,
      compStart: null,
      compEnd: null,
      composing: false,
      scrollX: 0,
      caretVisible: true,
    };

    element.addEventListener("input", this.boundInput);
    element.addEventListener("select", this.boundSelect);
    element.addEventListener("keyup", this.boundKeyUp);
    element.addEventListener("keydown", this.boundKeyDown);
    element.addEventListener("compositionstart", this.boundCompStart);
    element.addEventListener("compositionupdate", this.boundCompUpdate);
    element.addEventListener("compositionend", this.boundCompEnd);
    element.addEventListener("blur", this.boundBlur);
    // Belt-and-braces caret tracking: `select`/`keyup` miss some caret-only
    // movements in some engines; document selectionchange covers them.
    if (typeof document !== "undefined") {
      (document as any).addEventListener?.("selectionchange", this.boundSelectionChange);
    }

    this.ensureCaretVisible();
    this.syncProxyPosition();
    (element as any).focus?.({ preventScroll: true });

    this.startBlink();
    this.hooks.markDirty(node);
    this.hooks.scheduleRedraw();
  }

  /** Stop editing (focus left the node, Enter/Escape, teardown). */
  endEditing(): void {
    const state = this.state;
    if (!state) return;

    const { element, node } = state;
    element.removeEventListener("input", this.boundInput);
    element.removeEventListener("select", this.boundSelect);
    element.removeEventListener("keyup", this.boundKeyUp);
    element.removeEventListener("keydown", this.boundKeyDown);
    element.removeEventListener("compositionstart", this.boundCompStart);
    element.removeEventListener("compositionupdate", this.boundCompUpdate);
    element.removeEventListener("compositionend", this.boundCompEnd);
    element.removeEventListener("blur", this.boundBlur);
    if (typeof document !== "undefined") {
      (document as any).removeEventListener?.("selectionchange", this.boundSelectionChange);
    }

    // A composition cut short by blur/navigation still owes the engine its
    // final value.
    if (state.composing) {
      this.dispatchBind(state.value);
    }

    this.stopBlink();
    this.onDragEnd();
    this.state = null;
    this.bindPath = null;

    // If the session ends while the proxy still holds focus (detach,
    // remove, clear), release it. Listener is already removed, so this
    // can't re-enter.
    if (typeof document !== "undefined" && document.activeElement === element) {
      (element as any).blur?.();
    }

    // The proxy is per-session (fresh element per field so AT announces
    // each one) — remove it from the DOM entirely.
    (element as any).remove?.();
    this.proxy = null;

    this.hooks.markDirty(node);
    this.hooks.scheduleRedraw();
  }

  /**
   * Focus left the proxy. Movement back into the mirror (Tab transit, or a
   * click that focuses another node) is handled by the FocusManager's own
   * focusin — only a true departure ends the session here.
   */
  private onProxyBlur(e: FocusEvent): void {
    if (!this.state) return;
    const next = e.relatedTarget as HTMLElement | null;
    if (next && this.state.mirrorElement.parentNode && isInMirror(next)) return;
    this.endEditing();
    this.hooks.onEditBlur();
  }

  /** True while `element` is this controller's proxy (focus bookkeeping). */
  isProxyElement(element: unknown): boolean {
    return this.proxy !== null && element === this.proxy;
  }

  /** The hidden proxy textarea (test/diagnostic access). */
  getProxyElement(): HTMLTextAreaElement | null {
    return this.proxy;
  }

  isActive(): boolean {
    return this.state !== null;
  }

  /** Editing state for a node, or null — read by paintInput each frame. */
  getStateFor(node: VirtualNode): EditState | null {
    return this.state?.node === node ? this.state : null;
  }

  /**
   * End the session if the edited node is `node` or a descendant of it —
   * called by the renderer before remove/detach unlinks a subtree (in a
   * real browser removing a focused element blurs it, but the renderer
   * can't rely on that in every host environment).
   */
  endIfWithin(node: VirtualNode): void {
    let current: VirtualNode | null = this.state?.node ?? null;
    while (current) {
      if (current === node) {
        this.endEditing();
        return;
      }
      current = current.parent;
    }
  }

  destroy(): void {
    this.endEditing();
  }

  // -------------------------------------------------------------------------
  // Element events → state → engine
  // -------------------------------------------------------------------------

  private syncFromElement(): boolean {
    const state = this.state;
    if (!state) return false;
    const { element } = state;

    const value = String(element.value ?? "");
    const selStart = element.selectionStart ?? value.length;
    const selEnd = element.selectionEnd ?? value.length;

    const changed =
      value !== state.value || selStart !== state.selStart || selEnd !== state.selEnd;
    state.value = value;
    state.selStart = selStart;
    state.selEnd = selEnd;
    return changed;
  }

  private onInput(): void {
    const state = this.state;
    if (!state) return;

    this.syncFromElement();

    // Local echo: the next paint shows the typed text before the engine
    // round-trips it via SetProp.
    state.node.props.value = state.value;

    // Two-way binding — suppressed during IME composition (intermediate
    // composition strings aren't values); compositionend flushes the final.
    if (!state.composing) {
      this.dispatchBind(state.value);
    }

    this.afterEditActivity();
  }

  private onSelectionMaybeChanged(): void {
    if (!this.state) return;
    if (this.syncFromElement()) {
      this.afterEditActivity();
    }
  }

  private onDocumentSelectionChange(): void {
    const state = this.state;
    if (!state) return;
    if (typeof document === "undefined" || document.activeElement !== state.element) return;
    this.onSelectionMaybeChanged();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const state = this.state;
    if (!state) return;

    const isSingleLine = state.node.type.toLowerCase() === "input";

    // Enter submits single-line inputs (blur commits), Escape cancels focus.
    // The proxy's blur handler ends the session, matching the old overlay.
    if ((e.key === "Enter" && isSingleLine && !state.composing) || e.key === "Escape") {
      e.preventDefault();
      state.element.blur?.();
      return;
    }

    // Tab transit: hand focus back to the node's mirror element WITHOUT
    // preventDefault — the browser's default sequential navigation then
    // proceeds from the mirror, landing on the next/previous mirror element
    // (or out of the canvas) in natural order. If the destination is
    // another Input, its focusin starts the next edit session.
    if (e.key === "Tab" && !state.composing) {
      (state.mirrorElement as any).focus?.({ preventScroll: true });
    }
  }

  private onCompositionStart(): void {
    const state = this.state;
    if (!state) return;
    state.composing = true;
    state.compStart = state.selStart;
    state.compEnd = state.selStart;
  }

  private onCompositionUpdate(e: CompositionEvent): void {
    const state = this.state;
    if (!state || state.compStart === null) return;
    state.compEnd = state.compStart + (e.data?.length ?? 0);
    this.afterEditActivity();
  }

  private onCompositionEnd(): void {
    const state = this.state;
    if (!state) return;
    state.composing = false;
    state.compStart = null;
    state.compEnd = null;
    // Browsers disagree on input-vs-compositionend ordering; syncing and
    // dispatching here covers both (the same-value no-op makes double
    // dispatch harmless).
    this.syncFromElement();
    state.node.props.value = state.value;
    this.dispatchBind(state.value);
    this.afterEditActivity();
  }

  private dispatchBind(value: string): void {
    if (!this.bindPath) return;
    dispatchUIAction(this.engine, this.state?.node.id, "__hypen_bind", { path: this.bindPath, value });
  }

  /** Common tail for anything that edited or moved the caret. */
  private afterEditActivity(): void {
    const state = this.state;
    if (!state) return;
    this.ensureCaretVisible();
    this.syncProxyPosition();
    state.caretVisible = true;
    this.restartBlink();
    this.hooks.markDirty(state.node);
    this.hooks.scheduleRedraw();
  }

  // -------------------------------------------------------------------------
  // Engine echo
  // -------------------------------------------------------------------------

  /**
   * The engine confirmed/rewrote the value via SetProp. Our own echo
   * round-tripping (same value) must NOT touch the element — writing
   * `element.value` collapses the caret. A genuinely different value
   * (engine-side formatting) rewrites the element and clamps the selection.
   */
  onEngineValueEcho(node: VirtualNode): void {
    const state = this.state;
    if (!state || state.node !== node) return;

    const value = String(node.props.value ?? "");
    if (value === state.value) return;

    const { element } = state;
    element.value = value;
    const sel = Math.min(state.selEnd, value.length);
    element.setSelectionRange?.(sel, sel);
    this.syncFromElement();
    this.afterEditActivity();
  }

  // -------------------------------------------------------------------------
  // Pointer path — caret placement and drag selection on the canvas
  // -------------------------------------------------------------------------

  /**
   * Map a canvas mousedown on the edited node to a caret position, and arm
   * drag-selection until mouseup.
   */
  placeCaretFromPoint(node: VirtualNode, point: Point): void {
    const state = this.state;
    if (!state || state.node !== node) return;

    const offset = this.offsetFromPoint(point);
    if (offset === null) return;

    state.element.setSelectionRange?.(offset, offset);
    this.dragAnchor = offset;
    this.canvas.addEventListener("mousemove", this.boundDragMove);
    (typeof window !== "undefined" ? window : this.canvas).addEventListener(
      "mouseup",
      this.boundDragEnd as EventListener,
    );

    this.syncFromElement();
    this.afterEditActivity();
  }

  private onDragMove(e: MouseEvent): void {
    const state = this.state;
    if (!state || this.dragAnchor === null) return;

    const rect = this.canvas.getBoundingClientRect();
    const offset = this.offsetFromPoint({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    if (offset === null) return;

    state.element.setSelectionRange?.(
      Math.min(this.dragAnchor, offset),
      Math.max(this.dragAnchor, offset),
      offset < this.dragAnchor ? "backward" : "forward",
    );
    if (this.syncFromElement()) {
      this.afterEditActivity();
    }
  }

  private onDragEnd(): void {
    if (this.dragAnchor === null) return;
    this.dragAnchor = null;
    this.canvas.removeEventListener("mousemove", this.boundDragMove);
    (typeof window !== "undefined" ? window : this.canvas).removeEventListener(
      "mouseup",
      this.boundDragEnd as EventListener,
    );
  }

  /** Canvas-space point → character offset in the edited node's value. */
  private offsetFromPoint(point: Point): number | null {
    const state = this.state;
    if (!state) return null;

    const ctx = this.canvas.getContext("2d");
    const bounds = getScrollAwareBounds(state.node);
    const layout = state.node.layout;
    if (!ctx || !bounds || !layout) return null;

    const g = this.geometry(
      bounds.x + layout.contentX - state.scrollX,
      bounds.y + layout.contentY,
    );
    return pointToOffset(ctx, g, point);
  }

  // -------------------------------------------------------------------------
  // Geometry (shared with paintInput via getStateFor + text-geometry)
  // -------------------------------------------------------------------------

  /**
   * TextGeometry for the edited value at a given content origin. Single-line
   * inputs don't wrap and are middle-aligned; textareas wrap at content
   * width and are top-aligned — both matching how paintInput draws them.
   */
  geometry(contentX: number, contentY: number): TextGeometry {
    const state = this.state!;
    const isSingleLine = state.node.type.toLowerCase() === "input";
    const g = nodeTextGeometry(state.node, state.value, contentX, contentY, {
      verticalAlign: isSingleLine ? "middle" : "top",
      wrap: !isSingleLine,
    });
    // Inputs always paint left-aligned (paintInput parity).
    g.textAlign = "left";
    return g;
  }

  /**
   * Position the proxy at the caret in page coordinates so the IME
   * candidate window opens next to the painted text. Called on every edit
   * activity and by the renderer after each frame (layout/scroll changes).
   */
  syncProxyPosition(): void {
    const state = this.state;
    if (!state) return;
    const el = state.element;
    if (!el.style) return;

    const canvasBounds = (this.canvas as any).getBoundingClientRect?.();
    if (!canvasBounds) return;

    const ctx = this.canvas.getContext("2d");
    const bounds = getScrollAwareBounds(state.node);
    const layout = state.node.layout;

    let x = canvasBounds.left;
    let y = canvasBounds.top;
    let h = 16;
    if (ctx && bounds && layout) {
      const g = this.geometry(
        bounds.x + layout.contentX - state.scrollX,
        bounds.y + layout.contentY,
      );
      const caret = offsetToCaretRect(ctx, g, state.selEnd);
      x += caret.x;
      y += caret.y;
      h = caret.height;
    }

    // Same page-coordinate math the old overlay used: canvas rect is
    // viewport-relative, absolute positioning is document-relative.
    const sx = typeof window !== "undefined" ? window.scrollX : 0;
    const sy = typeof window !== "undefined" ? window.scrollY : 0;
    Object.assign(el.style, {
      left: `${x + sx}px`,
      top: `${y + sy}px`,
      height: `${h}px`,
    });
  }

  /**
   * Keep the caret inside the visible content box of single-line inputs by
   * panning `scrollX` (textareas wrap instead).
   */
  private ensureCaretVisible(): void {
    const state = this.state;
    if (!state) return;
    if (state.node.type.toLowerCase() !== "input") return;

    const ctx = this.canvas.getContext("2d");
    const layout = state.node.layout;
    if (!ctx || !layout) return;

    // Content-space geometry (origin 0) — caretX is the caret's distance
    // from the content-box left edge before scrolling.
    const g = this.geometry(0, 0);
    const caretX = offsetToCaretRect(ctx, g, state.selEnd).x;
    const visible = layout.contentWidth;

    if (caretX - state.scrollX > visible - CARET_SCROLL_MARGIN) {
      state.scrollX = caretX - visible + CARET_SCROLL_MARGIN;
    } else if (caretX - state.scrollX < CARET_SCROLL_MARGIN) {
      state.scrollX = Math.max(0, caretX - CARET_SCROLL_MARGIN);
    }
    if (state.scrollX < 0) state.scrollX = 0;
  }

  // -------------------------------------------------------------------------
  // Caret blink
  // -------------------------------------------------------------------------

  private startBlink(): void {
    if (this.blinkIntervalMs <= 0) return;
    this.blinkTimer = setInterval(() => {
      const state = this.state;
      if (!state) return;
      state.caretVisible = !state.caretVisible;
      this.hooks.markDirty(state.node);
      this.hooks.scheduleRedraw();
    }, this.blinkIntervalMs);
  }

  private stopBlink(): void {
    if (this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
  }

  private restartBlink(): void {
    this.stopBlink();
    this.startBlink();
  }

  /** Test hook: advance one blink phase without timers. */
  tickBlink(): void {
    const state = this.state;
    if (!state) return;
    state.caretVisible = !state.caretVisible;
  }
}
