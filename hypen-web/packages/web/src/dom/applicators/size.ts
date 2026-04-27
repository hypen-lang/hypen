/**
 * Size Applicators
 *
 * Cross-platform sizing value support:
 * - Numbers: treated as px (platform default)
 * - "100px": absolute pixels (1px = 1px everywhere)
 * - "100dp" / "100pt": density-independent (1dp ≈ 1pt, scaled by device)
 * - "50%": percentage of parent
 * - "50vw" / "50vh": viewport width/height
 * - "fill" / "100%": fill available space
 * - "wrap" / "auto": fit content
 */

import type { ApplicatorHandler } from "./types.js";

/**
 * Parse a size value and return CSS-compatible string.
 * Ensures cross-platform compatibility with Android/iOS.
 *
 * Exported for reuse by other DOM applicators (padding, margin, font,
 * typography, border, …) that historically passed strings through
 * untouched. CSS doesn't understand `dp` / `sp`, so `fontSize("24dp")`
 * or `padding("16sp")` would otherwise be silently dropped by the
 * browser even though the Android / iOS renderers accept them.
 */
export function parseSizeValue(value: any): string | null {
  if (value === null || value === undefined) return null;

  // Numbers default to px
  if (typeof value === "number") {
    return `${value}px`;
  }

  const str = String(value).trim().toLowerCase();

  // Keywords
  switch (str) {
    case "fill":
    case "match_parent":
      return "100%";
    case "wrap":
    case "wrap_content":
    case "auto":
      return "auto";
    case "infinity":
    case "inf":
    case "max":
      return "100%";
  }

  // Parse value with unit. `sp` is accepted as an alias for `dp` — on web,
  // density-independent and scale-independent units all collapse to CSS
  // `px` at 96dpi (there's no separate text-scaling knob on the DOM side).
  const match = str.match(/^(-?[\d.]+)\s*(px|dp|pt|sp|%|vw|vh|vmin|vmax|em|rem)?$/);
  if (!match) {
    // Pass through other CSS values as-is (e.g., "calc(...)", "fit-content")
    return str;
  }

  const num = parseFloat(match[1]);
  const unit = match[2] || "px";

  switch (unit) {
    case "px":
      // Absolute pixels - use as-is
      return `${num}px`;
    case "dp":
    case "sp":
      // Density/scale-independent logical pixels.
      // On web, 1dp/1sp = 1 CSS px at standard density (96dpi).
      // (`sp` does not yet scale with the user's text-size preference
      // — that's a separate cross-renderer change.)
      return `${num}px`;
    case "pt":
      // Typographic point = 1/72 inch. Emit native CSS `pt` so the
      // browser's own length resolution runs (1pt = 1.333… CSS px at
      // 96dpi). Matches the 96/72 multiplier used on iOS and Android.
      return `${num}pt`;
    case "%":
      return `${num}%`;
    case "vw":
      return `${num}vw`;
    case "vh":
      return `${num}vh`;
    case "vmin":
      return `${num}vmin`;
    case "vmax":
      return `${num}vmax`;
    case "em":
      return `${num}em`;
    case "rem":
      return `${num}rem`;
    default:
      return `${num}px`;
  }
}

/**
 * Coerce a Hypen length value to a CSS length string for applicators that
 * feed directly into `el.style.*`. Numbers become `${n}px`; strings with
 * platform-agnostic units (`dp`, `sp`, `pt`) are normalised; anything the
 * browser already understands (`em`, `rem`, `%`, `calc(...)`, …) passes
 * through.
 */
export function toCssLength(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return `${value}px`;
  return parseSizeValue(value) ?? String(value);
}

export const sizeHandlers: Record<string, ApplicatorHandler> = {
  width: (el, value) => {
    const size = parseSizeValue(value);
    if (size) el.style.width = size;
  },

  height: (el, value) => {
    const size = parseSizeValue(value);
    if (size) el.style.height = size;
  },

  minWidth: (el, value) => {
    const size = parseSizeValue(value);
    if (size) el.style.minWidth = size;
  },

  minHeight: (el, value) => {
    const size = parseSizeValue(value);
    if (size) el.style.minHeight = size;
  },

  maxWidth: (el, value) => {
    const size = parseSizeValue(value);
    if (size) el.style.maxWidth = size;
  },

  maxHeight: (el, value) => {
    const size = parseSizeValue(value);
    if (size) el.style.maxHeight = size;
  },

  // Combined size applicator - sets both width and height
  size: (el, value) => {
    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, any>;
      if (obj.width !== undefined) {
        const w = parseSizeValue(obj.width);
        if (w) el.style.width = w;
      }
      if (obj.height !== undefined) {
        const h = parseSizeValue(obj.height);
        if (h) el.style.height = h;
      }
    } else {
      const size = parseSizeValue(value);
      if (size) {
        el.style.width = size;
        el.style.height = size;
      }
    }
  },

  // Fill max width - stretch to fill parent width
  // Note: This only stretches within parent's current width.
  // For full-width behavior, parent Columns also need fillMaxWidth(true).
  fillMaxWidth: (el, value) => {
    if (value === false) return;
    const fraction = typeof value === "number" ? value : 1;
    if (fraction === 1) {
      // Use align-self stretch to fill cross-axis in flex containers
      el.style.alignSelf = "stretch";
      el.style.width = "100%";
      el.style.minWidth = "0"; // Prevent flex item from overflowing
    } else {
      // For fractional width, use percentage
      el.style.width = `${fraction * 100}%`;
    }
    // For grid containers (Stack)
    el.style.justifySelf = "stretch";
  },

  // Fill max height - shorthand for height: 100%
  fillMaxHeight: (el, value) => {
    if (value === false) return;
    // Value can be a fraction (0-1) or boolean
    const fraction = typeof value === "number" ? value : 1;
    el.style.height = `${fraction * 100}%`;
  },

  // Fill max size - shorthand for width: 100% and height: 100%
  fillMaxSize: (el, value) => {
    if (value === false) return;
    // Value can be a fraction (0-1) or boolean
    const fraction = typeof value === "number" ? value : 1;
    el.style.width = `${fraction * 100}%`;
    el.style.height = `${fraction * 100}%`;
    // Use align-self stretch to fill cross-axis in flex containers
    // This is needed because parent might have alignItems: flex-start (wrap behavior)
    el.style.alignSelf = "stretch";
    el.style.minWidth = "0"; // Prevent flex item from overflowing
  },
};
