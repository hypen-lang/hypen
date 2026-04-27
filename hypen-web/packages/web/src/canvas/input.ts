/**
 * Input Overlay System
 *
 * Handle text input using DOM overlay elements
 */

import type { VirtualNode, Rectangle } from "./types.js";
import { getAbsoluteBounds, cssLengthToPx } from "./utils.js";

/** Minimal engine interface for dispatching bind actions */
interface BindEngine {
  dispatchAction(name: string, payload?: unknown): void;
}

/**
 * Input Overlay Manager
 */
export class InputOverlay {
  private container: HTMLElement;
  private overlay: HTMLInputElement | HTMLTextAreaElement | null = null;
  private focusedNode: VirtualNode | null = null;
  private onChangeCallback: ((value: string) => void) | null = null;
  private bindPath: string | null = null;
  private engine: BindEngine | null = null;

  constructor(container: HTMLElement | null) {
    this.container = container || ({} as HTMLElement);
  }

  /**
   * Show input overlay for a node.
   *
   * Type comparison is case-insensitive — the engine emits `"Input"` /
   * `"Textarea"`, but the overlay branch was looking for lowercase
   * `"textarea"` and always created an `<input>` (so multi-line typing
   * couldn't enter newlines and the visible caret was the wrong height).
   */
  showInput(
    node: VirtualNode,
    canvasBounds: DOMRect,
    onChange: (value: string) => void,
    engine?: BindEngine | null
  ): void {
    // Skip if document is not available (non-browser environment)
    if (typeof document === "undefined") return;

    this.hideInput();

    // Store bind path and engine for two-way binding
    this.bindPath = (node.props.bind as string) || null;
    this.engine = engine || null;

    const bounds = getAbsoluteBounds(node);
    if (!bounds) return;

    const isMultiline = node.type.toLowerCase() === "textarea";
    this.overlay = isMultiline
      ? document.createElement("textarea")
      : document.createElement("input");

    // Style overlay
    this.styleOverlay(node, bounds, canvasBounds);

    // Set initial value
    const value = node.props.value || "";
    this.overlay.value = value;

    // Setup event handlers
    this.onChangeCallback = onChange;
    this.overlay.addEventListener("input", this.onInput.bind(this));
    this.overlay.addEventListener("blur", this.onBlur.bind(this));
    this.overlay.addEventListener("keydown", this.onKeyDown.bind(this) as EventListener);

    // Mount on document.body so absolute positioning is relative to the
    // viewport (`canvasBounds.left/top` are page coords too) — no
    // dependency on the canvas's wrapper having `position: relative`.
    document.body.appendChild(this.overlay);
    this.overlay.focus();

    this.focusedNode = node;
  }

  /**
   * Hide input overlay
   */
  hideInput(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    this.focusedNode = null;
    this.onChangeCallback = null;
    this.bindPath = null;
    this.engine = null;
  }

  /**
   * Update overlay position
   */
  updatePosition(node: VirtualNode, canvasBounds: DOMRect): void {
    if (!this.overlay || node !== this.focusedNode) return;

    const bounds = getAbsoluteBounds(node);
    if (!bounds) return;

    this.positionOverlay(bounds, canvasBounds);
  }

  /**
   * Style overlay to match canvas node
   */
  private styleOverlay(
    node: VirtualNode,
    bounds: Rectangle,
    canvasBounds: DOMRect
  ): void {
    if (!this.overlay) return;

    const props = node.props;

    // Position
    this.positionOverlay(bounds, canvasBounds);

    // Font and text styling — go through `cssLengthToPx` so values that
    // arrive in `rem` ("0.875rem" for `text-sm`) round to real pixels
    // instead of `parseFloat`'s bare 0.875 (which made the caret disappear).
    const fontSize = cssLengthToPx(props.fontSize) ?? 16;
    const fontWeight = props.fontWeight || "normal";
    const fontFamily = props.fontFamily || "system-ui, sans-serif";
    const color = props.color || "#000000";

    const padTop = cssLengthToPx(props.paddingTop ?? props.padding) ?? 0;
    const padRight = cssLengthToPx(props.paddingRight ?? props.padding) ?? 0;
    const padBottom = cssLengthToPx(props.paddingBottom ?? props.padding) ?? 0;
    const padLeft = cssLengthToPx(props.paddingLeft ?? props.padding) ?? 0;
    const borderRadius = cssLengthToPx(props.borderRadius) ?? 4;

    Object.assign(this.overlay.style, {
      fontSize: `${fontSize}px`,
      fontWeight: String(fontWeight),
      fontFamily: fontFamily,
      color: color,
      border: "none",
      outline: "none",
      backgroundColor: props.backgroundColor || "#ffffff",
      padding: `${padTop}px ${padRight}px ${padBottom}px ${padLeft}px`,
      borderRadius: `${borderRadius}px`,
      boxSizing: "border-box",
      resize: "none",
      // Keep the overlay above the canvas; the Bun-served stage has no
      // stacking context of its own so a plain z-index works.
      zIndex: "1000",
    });

    // Placeholder
    if (props.placeholder) {
      this.overlay.placeholder = props.placeholder;
    }

    // Input type
    if (this.overlay instanceof HTMLInputElement && props.type) {
      this.overlay.type = props.type;
    }
  }

  /**
   * Position overlay over canvas node.
   *
   * `bounds` is in canvas-local CSS pixels (the layout coordinate space
   * the renderer paints into after `ctx.scale(dpr, dpr)`). The overlay is
   * mounted on `document.body`, so we add `canvasBounds.left/top`
   * (page coords from `getBoundingClientRect`) to land at the right
   * absolute position regardless of where the canvas sits on the page.
   * Adding `window.scrollX/Y` keeps the overlay pinned to the canvas
   * even when the page scrolls between focus and reposition.
   */
  private positionOverlay(bounds: Rectangle, canvasBounds: DOMRect): void {
    if (!this.overlay) return;

    const sx = typeof window !== "undefined" ? window.scrollX : 0;
    const sy = typeof window !== "undefined" ? window.scrollY : 0;

    Object.assign(this.overlay.style, {
      position: "absolute",
      left: `${canvasBounds.left + sx + bounds.x}px`,
      top: `${canvasBounds.top + sy + bounds.y}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    });
  }

  /**
   * Handle input event
   */
  private onInput(e: Event): void {
    if (!this.overlay || !this.onChangeCallback) return;

    const value = this.overlay.value;
    this.onChangeCallback(value);

    // Dispatch __hypen_bind for two-way binding
    if (this.bindPath && this.engine) {
      this.engine.dispatchAction("__hypen_bind", {
        path: this.bindPath,
        value,
      });
    }
  }

  /**
   * Handle blur event
   */
  private onBlur(): void {
    // Hide overlay when focus is lost
    this.hideInput();
  }

  /**
   * Handle keyboard events
   */
  private onKeyDown(e: KeyboardEvent): void {
    if (!this.overlay) return;

    // Enter key submits (unless multiline)
    if (e.key === "Enter" && this.overlay instanceof HTMLInputElement) {
      e.preventDefault();
      this.overlay.blur();
    }

    // Escape cancels
    if (e.key === "Escape") {
      e.preventDefault();
      this.overlay.blur();
    }
  }

  /**
   * Check if input is currently shown
   */
  isShown(): boolean {
    return this.overlay !== null;
  }

  /**
   * Get current focused node
   */
  getFocusedNode(): VirtualNode | null {
    return this.focusedNode;
  }
}

