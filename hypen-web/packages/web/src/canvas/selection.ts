/**
 * Text Selection System
 *
 * Enables click-to-place-cursor, drag-to-select, double-click-word,
 * triple-click-line, and Ctrl/Cmd+C copy for canvas-rendered text.
 */

import type { VirtualNode, Point, FontStyle, TextMetrics } from "./types.js";
import { getScrollAwareBounds } from "./scroll.js";
import { measureText } from "./text.js";
import { createFontString } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A caret position within a text node. */
export interface TextPosition {
  /** The VirtualNode (must be type "text") */
  nodeId: string;
  /** Index into the resolved text string */
  offset: number;
}

/** Active selection range (anchor → focus, may be reversed). */
export interface TextSelection {
  anchor: TextPosition;
  focus: TextPosition;
}

/** Resolved geometry for painting a selection highlight on one line. */
export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

const HIGHLIGHT_COLOR = "rgba(59, 130, 246, 0.35)";

// ---------------------------------------------------------------------------
// SelectionManager
// ---------------------------------------------------------------------------

export class SelectionManager {
  private canvas: HTMLCanvasElement;
  private rootNode: VirtualNode | null = null;
  private requestRedraw: () => void;

  /** Current selection (null = nothing selected). */
  selection: TextSelection | null = null;

  // Drag tracking
  private dragging = false;
  private clickCount = 0;
  private lastClickTime = 0;
  private lastClickNodeId = "";

  // Bound handlers
  private boundMouseDown!: (e: MouseEvent) => void;
  private boundMouseMove!: (e: MouseEvent) => void;
  private boundMouseUp!: (e: MouseEvent) => void;
  private boundKeyDown!: (e: KeyboardEvent) => void;

  constructor(canvas: HTMLCanvasElement, requestRedraw: () => void) {
    this.canvas = canvas;
    this.requestRedraw = requestRedraw;
    this.setupListeners();
  }

  setRootNode(node: VirtualNode | null): void {
    this.rootNode = node;
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  private setupListeners(): void {
    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);

    this.canvas.addEventListener("mousedown", this.boundMouseDown);
    this.canvas.addEventListener("mousemove", this.boundMouseMove);
    this.canvas.addEventListener("mouseup", this.boundMouseUp);
    // keydown on window so it works even without canvas focus
    (typeof window !== "undefined" ? window : this.canvas).addEventListener(
      "keydown",
      this.boundKeyDown as EventListener,
    );
  }

  // -------------------------------------------------------------------------
  // Mouse handlers
  // -------------------------------------------------------------------------

  private canvasPoint(e: MouseEvent): Point {
    // Logical CSS pixels — same convention as `events.ts#getCanvasCoordinates`.
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return; // left-click only
    const point = this.canvasPoint(e);
    const hit = this.hitTestText(point);

    if (!hit) {
      if (this.selection) {
        this.selection = null;
        this.requestRedraw();
      }
      return;
    }

    // Detect multi-click (double/triple)
    const now = performance.now();
    if (
      now - this.lastClickTime < 400 &&
      this.lastClickNodeId === hit.nodeId
    ) {
      this.clickCount++;
    } else {
      this.clickCount = 1;
    }
    this.lastClickTime = now;
    this.lastClickNodeId = hit.nodeId;

    if (this.clickCount === 2) {
      // Double-click: select word
      this.selectWord(hit);
    } else if (this.clickCount >= 3) {
      // Triple-click: select entire text node
      this.selectAll(hit.nodeId);
      this.clickCount = 0;
    } else {
      // Single click: place caret, start drag
      this.selection = { anchor: hit, focus: { ...hit } };
      this.dragging = true;
    }

    this.requestRedraw();
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.dragging || !this.selection) return;
    const point = this.canvasPoint(e);
    const hit = this.hitTestText(point);
    if (hit && hit.nodeId === this.selection.anchor.nodeId) {
      this.selection.focus = hit;
      this.requestRedraw();
    }
  }

  private onMouseUp(_e: MouseEvent): void {
    this.dragging = false;
  }

  // -------------------------------------------------------------------------
  // Keyboard (copy)
  // -------------------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    const isCopy =
      (e.ctrlKey || e.metaKey) && e.key === "c";
    const isSelectAll =
      (e.ctrlKey || e.metaKey) && e.key === "a";

    if (isCopy && this.selection) {
      e.preventDefault();
      const text = this.getSelectedText();
      if (text && typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => {
          // Fallback: execCommand (deprecated but works in more contexts)
          fallbackCopy(text);
        });
      } else if (text) {
        fallbackCopy(text);
      }
    }

    if (isSelectAll && this.selection) {
      e.preventDefault();
      this.selectAll(this.selection.anchor.nodeId);
      this.requestRedraw();
    }
  }

  // -------------------------------------------------------------------------
  // Selection logic
  // -------------------------------------------------------------------------

  private selectWord(pos: TextPosition): void {
    const node = this.findNodeById(pos.nodeId);
    if (!node) return;
    const text = resolveText(node);
    const start = wordBoundaryBefore(text, pos.offset);
    const end = wordBoundaryAfter(text, pos.offset);
    this.selection = {
      anchor: { nodeId: pos.nodeId, offset: start },
      focus: { nodeId: pos.nodeId, offset: end },
    };
  }

  private selectAll(nodeId: string): void {
    const node = this.findNodeById(nodeId);
    if (!node) return;
    const text = resolveText(node);
    this.selection = {
      anchor: { nodeId, offset: 0 },
      focus: { nodeId, offset: text.length },
    };
  }

  getSelectedText(): string | null {
    if (!this.selection) return null;
    const node = this.findNodeById(this.selection.anchor.nodeId);
    if (!node) return null;
    const text = resolveText(node);
    const [start, end] = normalizeRange(this.selection);
    return text.slice(start, end);
  }

  // -------------------------------------------------------------------------
  // Hit testing — map canvas point → TextPosition
  // -------------------------------------------------------------------------

  /**
   * Find which text node and character offset a canvas point maps to.
   */
  private hitTestText(point: Point): TextPosition | null {
    if (!this.rootNode) return null;
    return this.hitTestTextNode(this.rootNode, point);
  }

  private hitTestTextNode(
    node: VirtualNode,
    point: Point,
  ): TextPosition | null {
    if (!node.visible || !node.layout) return null;

    // Check children first (front-to-back)
    for (let i = node.children.length - 1; i >= 0; i--) {
      const result = this.hitTestTextNode(node.children[i], point);
      if (result) return result;
    }

    // Only text nodes are selectable
    if (node.type !== "text") return null;

    const bounds = getScrollAwareBounds(node);
    if (!bounds) return null;
    if (
      point.x < bounds.x || point.x > bounds.x + bounds.width ||
      point.y < bounds.y || point.y > bounds.y + bounds.height
    ) {
      return null;
    }

    // Map point to character offset within this text node
    const offset = pointToOffset(this.canvas, node, bounds, point);
    return { nodeId: node.id, offset };
  }

  // -------------------------------------------------------------------------
  // Painting — called from paint pipeline
  // -------------------------------------------------------------------------

  /**
   * Paint selection highlight for a text node (called before text is drawn).
   */
  paintSelection(ctx: CanvasRenderingContext2D, node: VirtualNode): void {
    if (!this.selection) return;
    if (this.selection.anchor.nodeId !== node.id) return;

    const [start, end] = normalizeRange(this.selection);
    if (start === end) return; // caret only, no highlight

    const rects = getSelectionRects(ctx, node, start, end);

    ctx.save();
    ctx.fillStyle = HIGHLIGHT_COLOR;
    for (const r of rects) {
      ctx.fillRect(r.x, r.y, r.width, r.height);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private findNodeById(id: string): VirtualNode | null {
    if (!this.rootNode) return null;
    return findById(this.rootNode, id);
  }

  destroy(): void {
    this.canvas.removeEventListener("mousedown", this.boundMouseDown);
    this.canvas.removeEventListener("mousemove", this.boundMouseMove);
    this.canvas.removeEventListener("mouseup", this.boundMouseUp);
    (typeof window !== "undefined" ? window : this.canvas).removeEventListener(
      "keydown",
      this.boundKeyDown as EventListener,
    );
    this.rootNode = null;
    this.selection = null;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function resolveText(node: VirtualNode): string {
  const raw = node.props[0] || node.props.text || "";
  let text = String(raw);
  const tt = node.props.textTransform || "none";
  if (tt === "uppercase") text = text.toUpperCase();
  else if (tt === "lowercase") text = text.toLowerCase();
  else if (tt === "capitalize") text = text.replace(/\b\w/g, (c) => c.toUpperCase());
  return text;
}

function normalizeRange(sel: TextSelection): [number, number] {
  const a = sel.anchor.offset;
  const b = sel.focus.offset;
  return a <= b ? [a, b] : [b, a];
}

function wordBoundaryBefore(text: string, offset: number): number {
  let i = Math.min(offset, text.length - 1);
  // Skip non-word chars
  while (i > 0 && !/\w/.test(text[i])) i--;
  // Walk back through word chars
  while (i > 0 && /\w/.test(text[i - 1])) i--;
  return i;
}

function wordBoundaryAfter(text: string, offset: number): number {
  let i = offset;
  // Skip non-word chars
  while (i < text.length && !/\w/.test(text[i])) i++;
  // Walk forward through word chars
  while (i < text.length && /\w/.test(text[i])) i++;
  return i;
}

function findById(node: VirtualNode, id: string): VirtualNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Geometry: map a canvas point to a character offset
// ---------------------------------------------------------------------------

/**
 * Given a point inside a text node's bounds, return the character index
 * that the point falls on.
 */
function pointToOffset(
  canvas: HTMLCanvasElement,
  node: VirtualNode,
  bounds: { x: number; y: number; width: number; height: number },
  point: Point,
): number {
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;

  const props = node.props;
  const text = resolveText(node);
  const layout = node.layout!;
  const fontSize = parseFloat(props.fontSize) || 16;
  const fontWeight = props.fontWeight || "normal";
  const fontFamily = props.fontFamily || "system-ui, sans-serif";
  const lineHeight = parseFloat(props.lineHeight) || fontSize * 1.2;
  const textAlign = props.textAlign || "left";

  const fontStyle: FontStyle = { fontSize, fontWeight, fontFamily, lineHeight };
  const font = createFontString(fontSize, fontWeight, fontFamily);

  ctx.save();
  ctx.font = font;

  const metrics = measureText(ctx, text, fontStyle, layout.contentWidth);
  const contentX = bounds.x + layout.contentX;
  const contentY = bounds.y + layout.contentY;

  // Find which line the point falls on
  const relY = point.y - contentY;
  let lineIndex = Math.floor(relY / metrics.lineHeight);
  lineIndex = Math.max(0, Math.min(lineIndex, metrics.lines.length - 1));

  // Calculate character offset before this line
  let charsBefore = 0;
  for (let i = 0; i < lineIndex; i++) {
    charsBefore += metrics.lines[i].length;
    // Account for space/newline between lines (word wrap eats the space)
    if (i < metrics.lines.length - 1) {
      const nextLineStart = text.indexOf(metrics.lines[i + 1], charsBefore);
      if (nextLineStart > charsBefore) charsBefore = nextLineStart;
    }
  }

  const line = metrics.lines[lineIndex];

  // Calculate line X offset (for text-align)
  let lineX = contentX;
  if (textAlign === "center") {
    const lw = ctx.measureText(line).width;
    lineX = contentX + (layout.contentWidth - lw) / 2;
  } else if (textAlign === "right") {
    const lw = ctx.measureText(line).width;
    lineX = contentX + layout.contentWidth - lw;
  }

  // Binary search for the character at point.x
  const relX = point.x - lineX;
  let best = 0;
  for (let i = 0; i <= line.length; i++) {
    const w = ctx.measureText(line.slice(0, i)).width;
    if (w <= relX) {
      best = i;
    } else {
      // Check if we're closer to this char or the previous
      const prevW = ctx.measureText(line.slice(0, i - 1)).width;
      if (relX - prevW < w - relX) {
        best = i - 1;
      } else {
        best = i;
      }
      break;
    }
  }

  ctx.restore();
  return charsBefore + best;
}

// ---------------------------------------------------------------------------
// Geometry: compute highlight rectangles for a selection range
// ---------------------------------------------------------------------------

/**
 * Return a list of rectangles to paint as the selection highlight for
 * characters [start, end) within a text node.
 */
function getSelectionRects(
  ctx: CanvasRenderingContext2D,
  node: VirtualNode,
  start: number,
  end: number,
): SelectionRect[] {
  const props = node.props;
  const layout = node.layout!;
  const text = resolveText(node);
  const fontSize = parseFloat(props.fontSize) || 16;
  const fontWeight = props.fontWeight || "normal";
  const fontFamily = props.fontFamily || "system-ui, sans-serif";
  const lineHeight = parseFloat(props.lineHeight) || fontSize * 1.2;
  const textAlign = props.textAlign || "left";

  const fontStyle: FontStyle = { fontSize, fontWeight, fontFamily, lineHeight };
  const font = createFontString(fontSize, fontWeight, fontFamily);

  ctx.save();
  ctx.font = font;

  const metrics = measureText(ctx, text, fontStyle, layout.contentWidth);
  const x = layout.x + layout.contentX;
  const y = layout.y + layout.contentY;

  const rects: SelectionRect[] = [];

  // Map lines to character ranges
  let charOffset = 0;
  for (let i = 0; i < metrics.lines.length; i++) {
    const line = metrics.lines[i];
    const lineStart = charOffset;
    const lineEnd = charOffset + line.length;

    // Find actual position in original text for this line
    if (i > 0) {
      const idx = text.indexOf(line, charOffset);
      if (idx > charOffset) charOffset = idx;
    }
    const actualLineStart = charOffset;
    const actualLineEnd = charOffset + line.length;

    // Does this line overlap with the selection?
    if (actualLineEnd <= start || actualLineStart >= end) {
      charOffset = actualLineEnd;
      continue;
    }

    // Clamp selection to this line
    const selStart = Math.max(0, start - actualLineStart);
    const selEnd = Math.min(line.length, end - actualLineStart);

    // Calculate line X offset (text-align)
    let lineX = x;
    const lineWidth = ctx.measureText(line).width;
    if (textAlign === "center") {
      lineX = x + (layout.contentWidth - lineWidth) / 2;
    } else if (textAlign === "right") {
      lineX = x + layout.contentWidth - lineWidth;
    }

    // Measure selection bounds within this line
    const startX = ctx.measureText(line.slice(0, selStart)).width;
    const endX = ctx.measureText(line.slice(0, selEnd)).width;

    rects.push({
      x: lineX + startX,
      y: y + i * metrics.lineHeight,
      width: endX - startX,
      height: metrics.lineHeight,
    });

    charOffset = actualLineEnd;
  }

  ctx.restore();
  return rects;
}

// ---------------------------------------------------------------------------
// Clipboard fallback
// ---------------------------------------------------------------------------

function fallbackCopy(text: string): void {
  if (typeof document === "undefined") return;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch {
    // ignore
  }
  document.body.removeChild(textarea);
}
