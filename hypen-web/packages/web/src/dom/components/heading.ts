/**
 * Heading Component - Semantic headings (h1-h6)
 */

import type { ComponentHandler } from "./index.js";

const clampLevel = (raw: any): number | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(6, Math.round(n)));
};

/** `level` arrives bare from a constructor arg and as `level.0` from `.level(n)`. */
const readLevel = (props: Record<string, any>): number | undefined =>
  clampLevel(props.level ?? props["level.0"]);

/**
 * The user-agent stylesheet's size for each heading tag (relative to the
 * parent's font size, exactly as `<h1>`…`<h6>` get it), all bold. Mirrors
 * Canvas's `HEADING_FONT_SIZES` (32/24/18.72/16/13.28/10.72 px at a 16 px
 * base), desktop's `heading_level_at`, SwiftUI and Compose.
 */
const HEADING_LEVEL_FONT_SIZES: Record<number, string> = {
  1: "2em",
  2: "1.5em",
  3: "1.17em",
  4: "1em",
  5: "0.83em",
  6: "0.67em",
};

const HEADING_LEVEL_STYLE_ID = "hypen-heading-level-styles";

/**
 * Rules giving a heading whose `level` changed after creation the NEW level's
 * size and weight (see `applyProps`). Every selector sits inside `:where()`,
 * so the rules have zero specificity: as author-origin rules they still beat
 * the user-agent `hN` defaults they stand in for, yet ANY author styling — a
 * `.fontSize()` applicator (inline), a Tailwind `text-*` class — wins over
 * them, just as it would over the tag's own UA size.
 */
export const HEADING_LEVEL_CSS = Object.entries(HEADING_LEVEL_FONT_SIZES)
  .map(
    ([level, size]) =>
      `:where([data-hypen-type="heading"][data-hypen-level="${level}"]) ` +
      `{ font-size: ${size}; font-weight: bold; }`
  )
  .join("\n");

function ensureHeadingLevelStyles(): void {
  if (typeof document === "undefined" || document.getElementById(HEADING_LEVEL_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = HEADING_LEVEL_STYLE_ID;
  style.textContent = HEADING_LEVEL_CSS;
  document.head.appendChild(style);
}

export const headingHandler: ComponentHandler = {
  // The tag is chosen here and never changes afterwards: `createElement` runs
  // before the element is parented, so the old replaceChild path could never
  // fire, and swapping the element later would orphan the renderer's `nodes`
  // entry (and drop listeners, inline applicator styles and children). A
  // level that changes reactively is expressed with `aria-level` — the
  // ARIA-sanctioned override for exactly this case — and, so the heading
  // also LOOKS like its new level (as on Canvas, desktop, SwiftUI and
  // Compose, which all re-derive the size from the current level), a
  // `data-hypen-level` attribute that the zero-specificity rules in
  // `HEADING_LEVEL_CSS` size like the new level's tag.
  create(props: Record<string, any> = {}): HTMLElement {
    const level = readLevel(props) ?? 2;
    const el = document.createElement(`h${level}`);
    el.dataset.hypenType = "heading";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const level = readLevel(props);
    if (level !== undefined) {
      // `h2` → 2. Matches the tag chosen at create time unless the level has
      // since changed, in which case aria-level carries the new one.
      const tagLevel = Number(el.tagName.slice(1));
      if (level === tagLevel) {
        el.removeAttribute("aria-level");
        delete el.dataset.hypenLevel;
      } else {
        el.setAttribute("aria-level", String(level));
        ensureHeadingLevelStyles();
        el.dataset.hypenLevel = String(level);
      }
    }

    const text = props["0"] ?? props.text;
    if (text !== undefined) {
      el.dataset.textTemplate = String(text);
      el.textContent = String(text);
    }
  },
};
