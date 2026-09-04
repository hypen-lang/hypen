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
 * Current canvas viewport in CSS pixels, used to resolve viewport-relative
 * units (`vw`/`vh`/`vmin`/`vmax` and the small/large/dynamic variants).
 *
 * The layout pass stamps this once per frame (`setCssViewport`) from the
 * canvas' logical size. Until it does, both values stay 0 and the unit
 * conversion falls back to treating the number as raw px — the historical
 * behaviour, kept so a standalone `cssLengthToPx("100vh")` in a test or a
 * paint-only path never collapses a box to zero.
 *
 * This is the load-bearing fix for Tailwind's `h-screen` (→ `100vh`): before
 * the viewport was known, `100vh` measured 100 PIXELS, so every `h-screen`
 * page collapsed into a ~100px band at the top of the canvas.
 */
let viewportWidthPx = 0;
let viewportHeightPx = 0;

const HEADING_FONT_SIZES: Record<number, number> = {
  1: 32,
  2: 24,
  3: 18.72,
  4: 16,
  5: 13.28,
  6: 10.72,
};

/**
 * Alternate spellings accepted for an inherited text prop.
 *
 * `.foregroundColor(…)` is the registered applicator name on Swift and
 * Android, where it feeds the very same text colour as `.color(…)`. The
 * canvas only ever looked at `color`, so a `.foregroundColor()` subtree
 * painted black. Aliases are consulted AFTER the canonical name on each
 * node, so an element that sets both keeps `color` winning.
 */
const INHERITED_PROP_ALIASES: Record<string, string[]> = {
  color: ["foregroundColor"],
};

/**
 * A node's own text colour, under any spelling it can arrive in.
 *
 * `inheritedTextProp` already resolves the `foregroundColor` alias, but only
 * the text painter goes through it — every other painter (Input, Select,
 * Switch, Icon, Link, Spinner, …) reads `props.color` straight off the node.
 * Without this those components honour `.color()` and silently ignore
 * `.foregroundColor()`, which both native renderers accept.
 *
 * Returns undefined when unset so callers keep their own default.
 */
export function ownTextColor(props: Record<string, any>): any {
  return (
    props.color ??
    props["color.0"] ??
    props.foregroundColor ??
    props["foregroundColor.0"]
  );
}

/** Resolve CSS-inherited text props through the retained virtual parent chain. */
export function inheritedTextProp(node: VirtualNode, name: string): any {
  const aliases = INHERITED_PROP_ALIASES[name];
  let current: VirtualNode | null = node;
  while (current) {
    if (current.props[name] !== undefined) return current.props[name];
    if (aliases) {
      for (const alias of aliases) {
        if (current.props[alias] !== undefined) return current.props[alias];
      }
    }
    if (current.type.toLowerCase() === "heading") {
      const level = Math.max(1, Math.min(6, Number(current.props.level ?? 2) || 2));
      if (name === "fontSize") return HEADING_FONT_SIZES[level];
      if (name === "fontWeight") return "bold";
    }
    if (name === "color" && current.type.toLowerCase() === "link") {
      return "#0000ee";
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Set the viewport basis for `vw`/`vh`/`vmin`/`vmax` resolution.
 * Called by the layout pass with the canvas' logical (CSS-pixel) size.
 */
export function setCssViewport(width: number, height: number): void {
  viewportWidthPx = Number.isFinite(width) && width > 0 ? width : 0;
  viewportHeightPx = Number.isFinite(height) && height > 0 ? height : 0;
}

/** Current viewport basis (0/0 when never set). */
export function getCssViewport(): { width: number; height: number } {
  return { width: viewportWidthPx, height: viewportHeightPx };
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
  if (s.startsWith("calc(")) {
    const calc = parseCalcLength(s);
    // A calc with a percentage term has no basis here — the caller
    // (layout) resolves those against the parent box.
    return calc && calc.pct === 0 ? calc.px : null;
  }
  const match = s.match(/^(-?\d*\.?\d+)\s*([a-zA-Z]+)?$/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (match[2] || "px").toLowerCase();
  switch (unit) {
    case "px": return n;
    case "rem":
    case "em": return n * ROOT_FONT_PX;
    // Viewport-relative units resolve against the canvas size once the
    // layout pass has published it; before that, fall back to raw px.
    case "vw":
    case "svw":
    case "lvw":
    case "dvw":
      return viewportWidthPx > 0 ? (n / 100) * viewportWidthPx : n;
    case "vh":
    case "svh":
    case "lvh":
    case "dvh":
      return viewportHeightPx > 0 ? (n / 100) * viewportHeightPx : n;
    case "vmin":
      return viewportWidthPx > 0 && viewportHeightPx > 0
        ? (n / 100) * Math.min(viewportWidthPx, viewportHeightPx)
        : n;
    case "vmax":
      return viewportWidthPx > 0 && viewportHeightPx > 0
        ? (n / 100) * Math.max(viewportWidthPx, viewportHeightPx)
        : n;
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
 * A `calc()` expression reduced to `pct% + px` form.
 *
 * Only the linear shapes Tailwind/Hypen actually emit are supported —
 * `calc(100% - 40px)`, `calc(50% + 1rem)`, `calc(100vh - 3rem)` — i.e. a
 * sum/difference of terms that are each either a percentage or an absolute
 * length. Multiplication/division by a scalar is folded in too
 * (`calc(100%/3)`). Anything more exotic returns null and the caller falls
 * back to `auto`.
 */
export interface CalcLength {
  /** Percentage part, relative to the containing block. */
  pct: number;
  /** Absolute part, already converted to px. */
  px: number;
}

/**
 * Parse `calc(...)` into `{ pct, px }`. Returns null when the value is not a
 * calc expression or uses a form we don't model.
 */
export function parseCalcLength(value: any): CalcLength | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s.toLowerCase().startsWith("calc(") || !s.endsWith(")")) return null;
  const body = s.slice(5, -1).trim();
  // Reject nested calc / parentheses — the flat linear form is all we model.
  if (body.includes("(")) return null;

  // CSS requires whitespace around top-level `+`/`-`, so a plain whitespace
  // split yields an alternating term/operator stream. `*` and `/` bind
  // tighter and stay inside their term.
  const tokens = body.split(/\s+/).filter(Boolean);
  const terms: Array<{ sign: number; text: string }> = [];
  let sign = 1;
  let expectTerm = true;
  for (const t of tokens) {
    if (expectTerm) {
      if (t === "+" || t === "-") return null;
      terms.push({ sign, text: t });
      expectTerm = false;
      continue;
    }
    if (t === "+") { sign = 1; expectTerm = true; continue; }
    if (t === "-") { sign = -1; expectTerm = true; continue; }
    // A dangling `*`/`/` operator (spaced out) — reattach to the last term.
    if (t === "*" || t === "/") return null;
    return null;
  }
  if (terms.length === 0 || expectTerm) return null;

  let pct = 0;
  let px = 0;
  for (const term of terms) {
    // Fold scalar multiplication/division into the term.
    let scale = 1;
    let text = term.text;
    const muls = text.split(/\s*([*/])\s*/);
    if (muls.length > 1) {
      text = muls[0].trim();
      for (let i = 1; i < muls.length; i += 2) {
        const op = muls[i];
        const n = parseFloat(muls[i + 1]);
        if (!Number.isFinite(n) || (op === "/" && n === 0)) return null;
        scale = op === "*" ? scale * n : scale / n;
      }
    }
    if (text.endsWith("%")) {
      const n = parseFloat(text);
      if (!Number.isFinite(n)) return null;
      pct += term.sign * n * scale;
    } else {
      const n = cssLengthToPx(text);
      if (n === null) return null;
      px += term.sign * n * scale;
    }
  }
  return { pct, px };
}

/**
 * Resolve a length (including `calc()` and percentages) to px against a known
 * containing-block size. Returns null when the value is `auto`/unparseable.
 */
export function cssLengthToPxWithBasis(value: any, basis: number | null): number | null {
  const calc = parseCalcLength(value);
  if (calc) {
    if (calc.pct === 0) return calc.px;
    if (basis === null || !Number.isFinite(basis)) return null;
    return (calc.pct / 100) * basis + calc.px;
  }
  if (typeof value === "string" && value.trim().endsWith("%")) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return null;
    if (basis === null || !Number.isFinite(basis)) return null;
    return (n / 100) * basis;
  }
  return cssLengthToPx(value);
}

/**
 * Resolve a length whose `em` unit is relative to the element's OWN font size
 * (CSS semantics for `letter-spacing`, `text-indent`, …). Everything else is
 * delegated to `cssLengthToPx`, which treats `em` as a root-relative unit
 * because it has no element context.
 *
 * Without this, Tailwind's `tracking-[0.2em]` on a `text-2xl` heading resolved
 * to 0.2 × 16 = 3.2px instead of 0.2 × 24 = 4.8px.
 */
export function cssLengthToPxForFont(value: any, fontSizePx: number): number | null {
  if (typeof value === "string") {
    const s = value.trim();
    const m = s.match(/^(-?\d*\.?\d+)\s*em$/i);
    if (m) {
      const n = parseFloat(m[1]);
      return Number.isFinite(n) ? n * fontSizePx : null;
    }
  }
  return cssLengthToPx(value);
}

/**
 * Parse a CSS length string for Taffy's Dimension type. Keeps `%` values as
 * the tagged percentage string, turns `"auto"`/empty/invalid into `"auto"`,
 * converts everything else (including rem/em) through `cssLengthToPx`.
 *
 * `basis` (optional) is the containing block's size on the relevant axis; it
 * is only consulted for `calc()` values that mix a percentage with an
 * absolute term (`calc(100% - 40px)`), which Taffy's Dimension cannot express
 * on its own. Without a basis such a value degrades to its percentage part.
 */
export function cssLengthToDimension(
  value: any,
  basis?: number | null,
): "auto" | number | `${number}%` {
  if (value === undefined || value === null || value === "auto") return "auto";
  if (typeof value === "number") return Number.isFinite(value) ? value : "auto";
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "" || s === "auto") return "auto";
    if (s.endsWith("%")) return s as `${number}%`;
    const calc = parseCalcLength(s);
    if (calc) {
      if (calc.pct === 0) return calc.px;
      if (basis != null && Number.isFinite(basis)) {
        return (calc.pct / 100) * basis + calc.px;
      }
      return `${calc.pct}%` as `${number}%`;
    }
    const px = cssLengthToPx(s);
    return px !== null ? px : "auto";
  }
  return "auto";
}

/**
 * Resolve a `line-height` value against the element's font size.
 *
 * CSS allows three forms and the engine emits all of them: a length
 * (`text-2xl` → `"2rem"`), a UNITLESS MULTIPLIER (`text-5xl` → `"1"`,
 * `leading-tight` → `"1.25"`), and a percentage. `cssLengthToPx` alone read
 * the multiplier forms as raw pixels, so every `text-5xl`/`text-6xl` heading
 * got a 1-pixel line box and the next sibling painted straight through it.
 *
 * A bare number is treated as a multiplier when it is small enough that no
 * one could have meant pixels (≤ `MAX_UNITLESS_LINE_HEIGHT`); larger bare
 * numbers keep the historical px reading so existing callers passing
 * `lineHeight: 20` are unaffected.
 */
const MAX_UNITLESS_LINE_HEIGHT = 4;

export function cssLineHeightToPx(value: any, fontSizePx: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 0 && value <= MAX_UNITLESS_LINE_HEIGHT ? value * fontSizePx : value;
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || s === "normal" || s === "auto") return null;
  if (s.endsWith("%")) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? (n / 100) * fontSizePx : null;
  }
  if (/^-?\d*\.?\d+$/.test(s)) {
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return null;
    return n > 0 && n <= MAX_UNITLESS_LINE_HEIGHT ? n * fontSizePx : n;
  }
  return cssLengthToPx(s);
}

/**
 * True when the node opts out of layout entirely (`display: none`, which
 * Tailwind's `hidden` compiles to). Callers go through `isLayoutHidden`.
 */
export function isDisplayNone(props: Record<string, any>): boolean {
  return props.display === "none";
}

/**
 * True for a `VisuallyHidden` wrapper — the screen-reader-only ("sr-only")
 * pattern documented in hypen-docs/content/docs/guide/accessibility.mdx.
 * The DOM renderer clips its span out of the visual layout while leaving it
 * in the accessibility tree; on canvas the equivalent is to keep the node in
 * the a11y mirror but drop it from both the layout and the paint pass.
 */
export function isVisuallyHidden(node: VirtualNode): boolean {
  return node.type.toLowerCase() === "visuallyhidden";
}

/**
 * True when the node contributes neither pixels nor layout space. Lives here
 * so BOTH layout and paint can ask the same question — a `hidden md:flex`
 * node must be skipped by both passes, and the two modules cannot import
 * each other. A `VisuallyHidden` subtree is skipped exactly like
 * `display: none`; the mirror in `accessibility.ts` keeps it announced.
 */
export function isLayoutHidden(node: VirtualNode): boolean {
  return isDisplayNone(node.props) || isVisuallyHidden(node);
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
/**
 * Resolve the named-keys form, or null when no named key is present.
 *
 * `.padding(horizontal: 16, vertical: 8)` is documented and both native
 * renderers honour it; the canvas used to test only top/right/bottom/left, so
 * an object carrying just the axis keys fell through to the positional branch
 * and produced all-zero spacing.
 */
function pickNamed(value: Record<string, any>): BoxSpacing | null {
  const pick = (...keys: string[]): any => {
    for (const k of keys) {
      if (value[k] !== undefined) return value[k];
    }
    return undefined;
  };

  const top = pick("top", "vertical");
  const bottom = pick("bottom", "vertical");
  const left = pick("leading", "start", "left", "horizontal");
  const right = pick("trailing", "end", "right", "horizontal");

  if (
    top === undefined &&
    bottom === undefined &&
    left === undefined &&
    right === undefined
  ) {
    return null;
  }

  return {
    top: cssLengthToPx(top) ?? 0,
    right: cssLengthToPx(right) ?? 0,
    bottom: cssLengthToPx(bottom) ?? 0,
    left: cssLengthToPx(left) ?? 0,
  };
}

export function parseSpacing(value: any): BoxSpacing {
  if (typeof value === "number") {
    return { top: value, right: value, bottom: value, left: value };
  }

  if (typeof value === "string") {
    const parts = value.split(/\s+/).map((v) => cssLengthToPx(v) ?? 0);
    return spacingFromArray(parts);
  }

  if (typeof value === "object" && value !== null) {
    // Named-keys form takes priority when any side is named. An axis key is
    // the fallback for its two edges, and the logical keys resolve to
    // physical ones — the canvas has no writing direction, so this matches
    // Swift's LTR behaviour (`leading ?? start ?? left ?? horizontal`).
    const named = pickNamed(value);
    if (named !== null) return named;

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










