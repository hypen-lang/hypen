/**
 * Text Geometry
 *
 * Pure point↔offset↔rect math shared by static-text selection
 * (SelectionManager), input caret placement, and selection/caret painting.
 * Everything is parameterized by an explicit {@link TextGeometry} — no
 * node-type assumptions — so the same math serves Text, Input, and Textarea.
 *
 * Font sizes go through `cssLengthToPx` (matching paint.ts) so geometry
 * lines up with painted glyphs even for `rem`-valued props.
 */

import type { FontStyle, Point, Rectangle, VirtualNode } from "./types.js";
import { measureText } from "./text.js";
import { createFontString, cssLengthToPx } from "./utils.js";

/** Selection highlight color shared by static text and input painting. */
export const SELECTION_HIGHLIGHT_COLOR = "rgba(59, 130, 246, 0.35)";

export interface TextGeometry {
  /** Already-resolved text (node text or input value, post-transform). */
  text: string;
  font: FontStyle;
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  /** Content-box origin in the coordinate space of queried points / returned rects. */
  contentX: number;
  contentY: number;
  contentWidth: number;
  contentHeight: number;
  /** Width used for line wrapping; undefined = single line (no wrap). */
  wrapWidth?: number;
}

/**
 * Resolve a node's displayed text, applying `textTransform` the same way
 * paint does — geometry must measure what is actually drawn.
 */
export function resolveNodeText(node: VirtualNode): string {
  const raw = node.props[0] || node.props.text || "";
  let text = String(raw);
  const tt = node.props.textTransform || "none";
  if (tt === "uppercase") text = text.toUpperCase();
  else if (tt === "lowercase") text = text.toLowerCase();
  else if (tt === "capitalize") text = text.replace(/\b\w/g, (c) => c.toUpperCase());
  return text;
}

/** Font style from node props with paint.ts parity defaults. */
export function nodeFontStyle(props: Record<string, any>): FontStyle {
  const fontSize = cssLengthToPx(props.fontSize) ?? 16;
  return {
    fontSize,
    fontWeight: props.fontWeight || "normal",
    fontFamily: props.fontFamily || "system-ui, sans-serif",
    lineHeight: cssLengthToPx(props.lineHeight) ?? fontSize * 1.2,
  };
}

/**
 * Build a TextGeometry for a node whose content box starts at
 * (contentX, contentY) in the caller's coordinate space. Wrapping and
 * vertical alignment are caller decisions: static text wraps at content
 * width and is top-aligned (paintText parity); single-line inputs don't
 * wrap and are middle-aligned (paintInput parity).
 */
export function nodeTextGeometry(
  node: VirtualNode,
  text: string,
  contentX: number,
  contentY: number,
  opts?: { verticalAlign?: TextGeometry["verticalAlign"]; wrap?: boolean },
): TextGeometry {
  const layout = node.layout!;
  return {
    text,
    font: nodeFontStyle(node.props),
    textAlign: (node.props.textAlign || "left") as TextGeometry["textAlign"],
    verticalAlign: opts?.verticalAlign ?? "top",
    contentX,
    contentY,
    contentWidth: layout.contentWidth,
    contentHeight: layout.contentHeight,
    wrapWidth: (opts?.wrap ?? true) ? layout.contentWidth : undefined,
  };
}

/**
 * Character range each wrapped line covers in the original text. Word wrap
 * eats the separator between lines, so line N+1's start is re-anchored with
 * indexOf — same bookkeeping the selection code has always used.
 */
export interface LineRange {
  start: number;
  end: number;
  line: string;
}

export function lineRanges(text: string, lines: string[]): LineRange[] {
  const ranges: LineRange[] = [];
  let charOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      if (lines[i] === "") {
        // A blank line (from a hard "\n\n" or a trailing Enter) can't be
        // re-anchored with indexOf — it sits just past its newline.
        if (text[charOffset] === "\n") charOffset += 1;
      } else {
        const idx = text.indexOf(lines[i], charOffset);
        if (idx > charOffset) charOffset = idx;
      }
    }
    ranges.push({ start: charOffset, end: charOffset + lines[i].length, line: lines[i] });
    charOffset += lines[i].length;
  }
  return ranges;
}

/**
 * Line layout for geometry purposes. Wrapping goes through `measureText`
 * (pretext-aware) per hard-break paragraph. Single-line text (`wrapWidth`
 * undefined) deliberately does NOT: line-layout engines strip trailing
 * whitespace at line ends, which would pin the caret before a just-typed
 * space until the next visible character arrives. A single-line input's
 * "line" is the raw text, spaces and all — `ctx.measureText` advances
 * include them.
 *
 * For wrapped text, each paragraph's stripped whitespace tail is
 * re-attached to its last line for the same reason — a textarea caret must
 * sit after a just-typed space, including one typed right before a newline.
 * (Blank lines from "\n" come from measureText itself.)
 */
function layoutLines(
  ctx: CanvasRenderingContext2D,
  g: TextGeometry,
): { lines: string[]; lineHeight: number; height: number } {
  const lineHeight = g.font.lineHeight || g.font.fontSize * 1.2;

  if (g.wrapWidth === undefined) {
    return { lines: [g.text], lineHeight, height: lineHeight };
  }

  const lines: string[] = [];
  for (const paragraph of g.text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    const m = measureText(ctx, paragraph, g.font, g.wrapWidth);
    const paragraphLines = [...m.lines];
    // Re-attach the paragraph's trailing whitespace (stripped by wrap
    // layout) so the caret can sit after it.
    const ranges = lineRanges(paragraph, paragraphLines);
    const lastEnd = ranges.length > 0 ? ranges[ranges.length - 1].end : 0;
    const tail = paragraph.slice(lastEnd);
    if (tail.length > 0 && tail.trim() === "") {
      paragraphLines[paragraphLines.length - 1] += tail;
    }
    lines.push(...paragraphLines);
  }
  if (lines.length === 0) lines.push("");

  return { lines, lineHeight, height: lines.length * lineHeight };
}

function alignedStartY(g: TextGeometry, totalHeight: number): number {
  if (g.verticalAlign === "middle") return g.contentY + (g.contentHeight - totalHeight) / 2;
  if (g.verticalAlign === "bottom") return g.contentY + g.contentHeight - totalHeight;
  return g.contentY;
}

function alignedLineX(ctx: CanvasRenderingContext2D, g: TextGeometry, line: string): number {
  if (g.textAlign === "center") {
    return g.contentX + (g.contentWidth - ctx.measureText(line).width) / 2;
  }
  if (g.textAlign === "right") {
    return g.contentX + g.contentWidth - ctx.measureText(line).width;
  }
  return g.contentX;
}

/**
 * Map a point to the character offset it falls on.
 */
export function pointToOffset(
  ctx: CanvasRenderingContext2D,
  g: TextGeometry,
  point: Point,
): number {
  ctx.save();
  ctx.font = createFontString(g.font.fontSize, g.font.fontWeight, g.font.fontFamily);

  const metrics = layoutLines(ctx, g);
  const startY = alignedStartY(g, metrics.height);

  const relY = point.y - startY;
  let lineIndex = Math.floor(relY / metrics.lineHeight);
  lineIndex = Math.max(0, Math.min(lineIndex, metrics.lines.length - 1));

  const ranges = lineRanges(g.text, metrics.lines);
  const { start: lineStart, line } = ranges[lineIndex];

  const relX = point.x - alignedLineX(ctx, g, line);

  // Walk characters; snap to whichever side of the glyph is closer. A point
  // left of the line start clamps to 0 (i has no previous glyph at 0).
  let best = 0;
  for (let i = 0; i <= line.length; i++) {
    const w = ctx.measureText(line.slice(0, i)).width;
    if (w <= relX) {
      best = i;
    } else {
      if (i === 0) break;
      const prevW = ctx.measureText(line.slice(0, i - 1)).width;
      best = relX - prevW < w - relX ? i - 1 : i;
      break;
    }
  }

  ctx.restore();
  return lineStart + best;
}

/**
 * Rectangles covering characters [start, end) — one per wrapped line the
 * range touches. Used for selection highlights.
 */
export function rangeToRects(
  ctx: CanvasRenderingContext2D,
  g: TextGeometry,
  start: number,
  end: number,
): Rectangle[] {
  if (start >= end) return [];
  ctx.save();
  ctx.font = createFontString(g.font.fontSize, g.font.fontWeight, g.font.fontFamily);

  const metrics = layoutLines(ctx, g);
  const startY = alignedStartY(g, metrics.height);
  const ranges = lineRanges(g.text, metrics.lines);

  const rects: Rectangle[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const { start: lineStart, end: lineEnd, line } = ranges[i];
    if (lineEnd <= start || lineStart >= end) continue;

    const selStart = Math.max(0, start - lineStart);
    const selEnd = Math.min(line.length, end - lineStart);

    const lineX = alignedLineX(ctx, g, line);
    const fromX = ctx.measureText(line.slice(0, selStart)).width;
    const toX = ctx.measureText(line.slice(0, selEnd)).width;

    rects.push({
      x: lineX + fromX,
      y: startY + i * metrics.lineHeight,
      width: toX - fromX,
      height: metrics.lineHeight,
    });
  }

  ctx.restore();
  return rects;
}

/**
 * Caret rectangle for a character offset. At a wrap boundary the caret
 * sits at the end of the earlier line (matching browser end-of-line
 * placement for soft wraps).
 */
export function offsetToCaretRect(
  ctx: CanvasRenderingContext2D,
  g: TextGeometry,
  offset: number,
): Rectangle {
  ctx.save();
  ctx.font = createFontString(g.font.fontSize, g.font.fontWeight, g.font.fontFamily);

  const metrics = layoutLines(ctx, g);
  const startY = alignedStartY(g, metrics.height);
  const ranges = lineRanges(g.text, metrics.lines);

  const clamped = Math.max(0, Math.min(offset, g.text.length));
  let lineIndex = ranges.length - 1;
  for (let i = 0; i < ranges.length; i++) {
    if (clamped <= ranges[i].end) {
      lineIndex = i;
      break;
    }
  }

  const { start: lineStart, line } = ranges[lineIndex];
  const col = Math.max(0, Math.min(clamped - lineStart, line.length));
  const x = alignedLineX(ctx, g, line) + ctx.measureText(line.slice(0, col)).width;

  ctx.restore();
  return {
    x,
    y: startY + lineIndex * metrics.lineHeight,
    width: 1,
    height: metrics.lineHeight,
  };
}
