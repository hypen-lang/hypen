/**
 * Text Rendering System
 *
 * Text measurement, wrapping, and rendering using pretext for accurate
 * multilingual line breaking (CJK, bidi, emoji, etc.). Falls back to
 * basic word-splitting in environments without OffscreenCanvas (e.g. tests).
 */

import type { FontStyle, TextMetrics, TextStyle } from "./types.js";
import { createFontString } from "./utils.js";
import {
  prepareWithSegments,
  layoutWithLines,
  clearCache as pretextClearCache,
} from "@chenglou/pretext";
import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.canvas;

/**
 * Whether pretext is available (requires a working canvas with measureText)
 */
let pretextAvailable: boolean | null = null;

function isPretextAvailable(): boolean {
  if (pretextAvailable !== null) return pretextAvailable;
  try {
    // Probe by running a minimal prepare — throws if neither OffscreenCanvas
    // nor a real DOM canvas is available (e.g. jsdom in tests).
    prepareWithSegments("x", "16px sans-serif");
    pretextAvailable = true;
  } catch {
    pretextAvailable = false;
  }
  return pretextAvailable;
}

/**
 * Text metrics cache — bounded LRU. Every distinct (text, font, width,
 * clamp) combination measured on the layout/paint hot path lands here, so
 * without a cap a long-lived session (live feeds, ticking clocks, per-width
 * generations from resizes) grows it forever. Map iteration order is
 * insertion order; hits re-insert to keep hot entries at the tail and the
 * oldest entry is evicted past the cap.
 */
const textMetricsCache = new Map<string, TextMetrics>();
const MAX_TEXT_METRICS_CACHE_SIZE = 4096;

/**
 * Get cache key for text metrics
 */
function getCacheKey(text: string, fontStyle: FontStyle, maxWidth?: number): string {
  return `${text}|${fontStyle.fontSize}|${fontStyle.fontWeight}|${fontStyle.fontFamily}|${maxWidth || "auto"}`;
}

/**
 * Fallback word wrap for environments without pretext support
 */
function wrapTextFallback(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    // An empty paragraph is a blank line — dropping it would collapse
    // consecutive newlines (and a trailing Enter in a Textarea).
    if (paragraph === "") {
      lines.push("");
      continue;
    }

    const words = paragraph.split(" ");
    let currentLine = "";

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }

    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [""];
}

/**
 * Measure text dimensions. Uses pretext for accurate multilingual line
 * breaking when available, falls back to basic word-splitting otherwise.
 *
 * When `maxLines` is set, wrapped lines past the limit are dropped and the
 * reported `height` shrinks accordingly. With `textOverflow === "ellipsis"`,
 * the last kept line is trimmed character-by-character until it plus "…"
 * fits within `maxWidth`. Matches the DOM `-webkit-line-clamp` behaviour
 * the Tailwind `truncate` utility compiles to on web.
 */
export function measureText(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontStyle: FontStyle,
  maxWidth?: number,
  maxLines?: number,
  textOverflow?: "ellipsis" | "clip"
): TextMetrics {
  const cacheKey = `${getCacheKey(text, fontStyle, maxWidth)}|${maxLines ?? ""}|${textOverflow ?? ""}`;
  const cached = textMetricsCache.get(cacheKey);
  if (cached) {
    // Refresh recency so steady-state entries survive eviction.
    textMetricsCache.delete(cacheKey);
    textMetricsCache.set(cacheKey, cached);
    return cached;
  }

  const font = createFontString(fontStyle.fontSize, fontStyle.fontWeight, fontStyle.fontFamily);
  const lineHeight = fontStyle.lineHeight || fontStyle.fontSize * 1.2;

  let lines: string[];
  let width: number;

  if (isPretextAvailable()) {
    const effectiveMaxWidth = maxWidth || Infinity;
    // Hard line breaks: pretext treats "\n" as ordinary whitespace, so
    // paragraphs are laid out separately (matching the fallback path and
    // what Textarea editing needs). Empty paragraphs stay as blank lines.
    lines = [];
    width = 0;
    for (const paragraph of text.split("\n")) {
      if (paragraph === "") {
        lines.push("");
        continue;
      }
      const prepared = prepareWithSegments(paragraph, font);
      const linesResult = layoutWithLines(prepared, effectiveMaxWidth, lineHeight);
      const paragraphLines = linesResult.lines.map((l) => l.text);
      lines.push(...(paragraphLines.length > 0 ? paragraphLines : [""]));
      for (const l of linesResult.lines) {
        width = Math.max(width, l.width);
      }
    }
    if (lines.length === 0) lines = [""];
  } else {
    ctx.save();
    ctx.font = font;
    if (!maxWidth) {
      lines = [text];
      width = ctx.measureText(text).width;
    } else {
      lines = wrapTextFallback(ctx, text, maxWidth);
      width = Math.max(...lines.map((line) => ctx.measureText(line).width));
    }
    ctx.restore();
  }

  // Clamp to maxLines and append ellipsis if content was truncated.
  // Handled in two cases:
  //  1. `lines.length > maxLines` — multi-line wrap that must collapse.
  //  2. The last kept line alone exceeds `maxWidth` — pretext can leave an
  //     unbreakable glyph run (usernames, URLs, no-space CJK) on one long
  //     line. Without this, `truncate` on a 13-char username in an 80px
  //     slot would render one overflowing line instead of ellipsising.
  if (maxLines !== undefined) {
    const kept = lines.length > maxLines ? lines.slice(0, maxLines) : [...lines];
    const droppedLines = lines.length > maxLines;

    if (textOverflow === "ellipsis" && maxWidth !== undefined && kept.length > 0) {
      ctx.save();
      ctx.font = font;
      const ellipsis = "…";
      const lastIdx = kept.length - 1;
      let last = kept[lastIdx];
      const lastWidth = ctx.measureText(last).width;
      if (droppedLines || lastWidth > maxWidth) {
        while (last.length > 0 && ctx.measureText(last + ellipsis).width > maxWidth) {
          last = last.slice(0, -1);
        }
        kept[lastIdx] = last + ellipsis;
      }
      ctx.restore();
    }

    if (droppedLines || kept.length !== lines.length) {
      lines = kept;
    }
    ctx.save();
    ctx.font = font;
    width = lines.length > 0 ? Math.max(...lines.map((line) => ctx.measureText(line).width)) : 0;
    ctx.restore();
  }

  const result: TextMetrics = {
    width,
    height: lines.length * lineHeight,
    lines,
    lineHeight,
  };

  textMetricsCache.set(cacheKey, result);
  if (textMetricsCache.size > MAX_TEXT_METRICS_CACHE_SIZE) {
    const oldest = textMetricsCache.keys().next().value;
    if (oldest !== undefined) textMetricsCache.delete(oldest);
  }
  return result;
}

/**
 * Render text with style
 */
export function renderText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  style: TextStyle,
  maxLines?: number,
  textOverflow?: "ellipsis" | "clip"
): void {
  const font = createFontString(style.fontSize, style.fontWeight, style.fontFamily);
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = style.color;
  ctx.textBaseline = "top";

  const metrics = measureText(ctx, text, style, width, maxLines, textOverflow);

  // Calculate starting Y based on vertical alignment
  let startY = y;
  if (style.verticalAlign === "middle") {
    startY = y + (height - metrics.height) / 2;
  } else if (style.verticalAlign === "bottom") {
    startY = y + height - metrics.height;
  }

  // Render each line
  for (let i = 0; i < metrics.lines.length; i++) {
    const line = metrics.lines[i];
    const lineY = startY + i * metrics.lineHeight;

    // Calculate X based on text alignment
    let lineX = x;
    if (style.textAlign === "center") {
      const lineWidth = ctx.measureText(line).width;
      lineX = x + (width - lineWidth) / 2;
    } else if (style.textAlign === "right") {
      const lineWidth = ctx.measureText(line).width;
      lineX = x + width - lineWidth;
    }

    ctx.fillText(line, lineX, lineY);
  }

  ctx.restore();
}

/**
 * Clear text metrics cache (both local and pretext internal caches)
 */
export function clearTextCache(): void {
  textMetricsCache.clear();
  pretextClearCache();
}

/**
 * Preload font to ensure it's available
 */
export async function loadFont(fontFamily: string, fontWeight: string | number = "normal"): Promise<void> {
  if (!("fonts" in document)) return;

  const font = `${fontWeight} 16px ${fontFamily}`;
  try {
    await document.fonts.load(font);
  } catch (error) {
    log.warn(`Failed to load font: ${font}`, error);
  }
}











