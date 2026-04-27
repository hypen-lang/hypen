/**
 * Canvas Renderer Utilities
 *
 * Common utility functions
 */

import type { BoxSpacing, Rectangle, Point, VirtualNode } from "./types.js";

// Pixel equivalent for 1rem (and 1em, which we approximate the same without a
// real inheritance chain). The engine emits Tailwind values — `0.75rem`,
// `1rem`, `3.5rem` — and any earlier `parseFloat` path was stripping the unit
// and treating `3.5rem` as 3.5px, collapsing whole layouts to 1/16 size.
const ROOT_FONT_PX = 16;

/**
 * Active layout viewport — used to resolve `vw` / `vh` correctly during a
 * layout pass. Set by `computeLayout` (layout.ts) at entry and cleared on
 * exit. Layout traversal is synchronous, so a single module-level slot is
 * sufficient and avoids threading a `viewport` parameter through every
 * `cssLengthToPx` call site (there are dozens).
 *
 * Falls back to `window.innerWidth` / `window.innerHeight` outside a layout
 * pass (e.g. for direct callers that resolve sizes ahead of layout). When
 * neither is available — e.g. headless tests — `vw`/`vh` degrade to the
 * pre-fix unitless-pixel behavior.
 */
let currentViewport: { width: number; height: number } | null = null;

export function setCurrentViewport(viewport: { width: number; height: number } | null): void {
  currentViewport = viewport;
}

export function getCurrentViewport(): { width: number; height: number } | null {
  return currentViewport;
}

function resolveViewportPx(unit: "vw" | "vh", n: number): number {
  if (currentViewport) {
    const dim = unit === "vw" ? currentViewport.width : currentViewport.height;
    return (n / 100) * dim;
  }
  if (typeof window !== "undefined") {
    const dim = unit === "vw" ? window.innerWidth : window.innerHeight;
    if (Number.isFinite(dim) && dim > 0) return (n / 100) * dim;
  }
  // Last resort: treat as unitless px so the layout still gets a numeric
  // value (matches pre-fix behavior in the no-viewport case).
  return n;
}

/**
 * Parse a CSS length string (or number) into pixels.
 * Returns `null` for `"auto"` or unparseable input; returns `null` for `%`
 * values so callers can decide whether to keep the percentage verbatim or
 * fall back to 0.
 */
export function cssLengthToPx(value: any): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || s === "auto") return null;
  if (s.endsWith("%")) return null;
  const match = s.match(/^(-?\d*\.?\d+)\s*([a-zA-Z]+)?$/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (match[2] || "px").toLowerCase();
  switch (unit) {
    case "px": return n;
    case "rem":
    case "em": return n * ROOT_FONT_PX;
    case "vw":
    case "vh": return resolveViewportPx(unit, n);
    // Typographic point — 1/72 inch at CSS reference density (96dpi).
    case "pt": return n * (96 / 72);
    // Density-independent (dp) and scale-independent (sp) logical pixels
    // collapse to CSS px 1:1 — matches the cross-platform contract where
    // 1 dp = 1 iOS point = 1 CSS px at standard density.
    case "dp":
    case "sp": return n;
    case "pc": return n * 16;
    case "in": return n * 96;
    case "cm": return n * (96 / 2.54);
    case "mm": return n * (96 / 25.4);
    default: return n;
  }
}

/**
 * Resolve a CSS `line-height` value to a pixel value.
 *
 * Unitless numbers (e.g. `1`, `1.5`, `"1.25"`) are CSS multipliers of the
 * font-size — `line-height: 1` (Tailwind's `leading-none`) means line box =
 * 1 × font-size, NOT 1 pixel. Without this branch, `cssLengthToPx("1")`
 * returned literally `1`, and a Column of `leading-none` Texts collapsed
 * each line to 1px tall — emoji + label in a bottom-tab button rendered at
 * the same y and overlapped.
 *
 * Anything with an explicit unit (`16px`, `1.5em`, `1rem`, `120%` is
 * rejected → null since Taffy/measure expects px) falls through to
 * `cssLengthToPx`.
 */
export function resolveLineHeight(value: any, fontSize: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Unitless number: multiplier of font-size (matches CSS spec).
    return value * fontSize;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "" || s === "auto" || s === "normal") return null;
    // Pure numeric string with no unit → unitless multiplier.
    if (/^-?\d*\.?\d+$/.test(s)) {
      const n = parseFloat(s);
      return Number.isFinite(n) ? n * fontSize : null;
    }
  }
  return cssLengthToPx(value);
}

/**
 * Parse a CSS length string for Taffy's Dimension type. Keeps `%` values as
 * the tagged percentage string, turns `"auto"`/empty/invalid into `"auto"`,
 * converts everything else (including rem/em) through `cssLengthToPx`.
 */
export function cssLengthToDimension(value: any): "auto" | number | `${number}%` {
  if (value === undefined || value === null || value === "auto") return "auto";
  if (typeof value === "number") return Number.isFinite(value) ? value : "auto";
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "" || s === "auto") return "auto";
    if (s.endsWith("%")) return s as `${number}%`;
    const px = cssLengthToPx(s);
    return px !== null ? px : "auto";
  }
  return "auto";
}

/**
 * Parse spacing value (margin, padding).
 *
 * Supports the same forms as the DOM and native renderers:
 * - `number` — all sides
 * - `"10"`, `"10 20"`, `"10 20 30"`, `"10 20 30 40"` — CSS shorthand string
 * - `{top, right, bottom, left}` — named keys
 * - `{0, 1, ...}` — positional applicator args from the engine, mapped via
 *   CSS shorthand semantics (1=all, 2=v/h, 3=t/h/b, 4=t/r/b/l)
 */
export function parseSpacing(value: any): BoxSpacing {
  if (typeof value === "number") {
    return { top: value, right: value, bottom: value, left: value };
  }

  if (typeof value === "string") {
    const parts = value.split(/\s+/).map((v) => cssLengthToPx(v) ?? 0);
    return spacingFromArray(parts);
  }

  if (typeof value === "object" && value !== null) {
    // Named-keys form takes priority when any side is named.
    if (
      value.top !== undefined ||
      value.right !== undefined ||
      value.bottom !== undefined ||
      value.left !== undefined
    ) {
      return {
        top: cssLengthToPx(value.top) ?? 0,
        right: cssLengthToPx(value.right) ?? 0,
        bottom: cssLengthToPx(value.bottom) ?? 0,
        left: cssLengthToPx(value.left) ?? 0,
      };
    }

    // Positional form: walk contiguous "0", "1", … keys.
    const args: number[] = [];
    for (let i = 0; value[String(i)] !== undefined; i++) {
      args.push(cssLengthToPx(value[String(i)]) ?? 0);
    }
    if (args.length > 0) {
      return spacingFromArray(args);
    }
  }

  return { top: 0, right: 0, bottom: 0, left: 0 };
}

/** CSS shorthand: 1=all, 2=v/h, 3=t/h/b, 4=t/r/b/l. */
function spacingFromArray(parts: number[]): BoxSpacing {
  if (parts.length === 1) {
    return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
  }
  if (parts.length === 2) {
    return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
  }
  if (parts.length === 3) {
    return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
  }
  // 4+ values: top, right, bottom, left
  return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
}

/**
 * Parse size value (width, height) into pixels.
 * Returns `null` for `"auto"`, percentages, or unparseable input — callers
 * that want to keep the percentage form should use `cssLengthToDimension`.
 */
export function parseSize(value: any): number | null {
  return cssLengthToPx(value);
}

/**
 * Check if point is inside rectangle
 */
export function isPointInRect(point: Point, rect: Rectangle): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Check if point is inside rounded rectangle
 */
export function isPointInRoundedRect(
  point: Point,
  rect: Rectangle,
  radius: number
): boolean {
  const { x, y, width, height } = rect;

  // Quick reject if outside bounding box
  if (!isPointInRect(point, rect)) return false;

  // No radius means simple rectangle. Clamp the radius to the box, since
  // Tailwind's `rounded-full` arrives as 9999 — without clamping, the
  // corner-test math thinks the corners are far outside the box and
  // mis-classifies hits.
  if (radius <= 0) return true;
  radius = Math.min(radius, width / 2, height / 2);

  const px = point.x;
  const py = point.y;

  // Check corners
  // Top-left
  if (px < x + radius && py < y + radius) {
    return Math.pow(px - (x + radius), 2) + Math.pow(py - (y + radius), 2) <= Math.pow(radius, 2);
  }

  // Top-right
  if (px > x + width - radius && py < y + radius) {
    return (
      Math.pow(px - (x + width - radius), 2) + Math.pow(py - (y + radius), 2) <=
      Math.pow(radius, 2)
    );
  }

  // Bottom-left
  if (px < x + radius && py > y + height - radius) {
    return (
      Math.pow(px - (x + radius), 2) + Math.pow(py - (y + height - radius), 2) <=
      Math.pow(radius, 2)
    );
  }

  // Bottom-right
  if (px > x + width - radius && py > y + height - radius) {
    return (
      Math.pow(px - (x + width - radius), 2) + Math.pow(py - (y + height - radius), 2) <=
      Math.pow(radius, 2)
    );
  }

  // Inside rectangle
  return true;
}

/**
 * Merge rectangles into bounding box
 */
export function mergeRects(rects: Rectangle[]): Rectangle | null {
  if (rects.length === 0) return null;
  if (rects.length === 1) return rects[0];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Create a canvas font string from font style
 */
export function createFontString(
  fontSize: number,
  fontWeight: string | number,
  fontFamily: string
): string {
  return `${fontWeight} ${fontSize}px ${fontFamily}`;
}

/**
 * Walk tree depth-first
 */
export function walkTree(node: VirtualNode, callback: (node: VirtualNode) => void): void {
  callback(node);
  for (const child of node.children) {
    walkTree(child, callback);
  }
}

/**
 * Find node by ID in tree
 */
export function findNodeById(root: VirtualNode, id: string): VirtualNode | null {
  if (root.id === id) return root;

  for (const child of root.children) {
    const found = findNodeById(child, id);
    if (found) return found;
  }

  return null;
}

/**
 * Get absolute bounds of a node. `node.layout.{x,y}` is already absolute
 * (the layout pass writes parent.absX + child.x in both the Taffy and JS
 * fallback paths), so this is a thin wrapper for callers that work in
 * `Rectangle` shape.
 *
 * Use `getScrollAwareBounds` (in `scroll.ts`) when ancestor scroll offsets
 * matter — e.g. for hit testing.
 */
export function getAbsoluteBounds(node: VirtualNode): Rectangle | null {
  if (!node.layout) return null;
  return {
    x: node.layout.x,
    y: node.layout.y,
    width: node.layout.width,
    height: node.layout.height,
  };
}











