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
 * The user-agent stylesheet's size and block margins for each heading tag
 * (both in `em`, so relative to the parent's font size / the heading's own,
 * exactly as `<h1>`…`<h6>` get them), all bold. Sizes mirror Canvas's
 * `HEADING_FONT_SIZES` (32/24/18.72/16/13.28/10.72 px at a 16 px base),
 * desktop's `heading_level_at`, SwiftUI and Compose; the margins are the
 * tags' own, so a re-levelled `<h1>` is spaced like the `<h4>` it stands in
 * for, not like an `<h1>` at `h4` size.
 */
const HEADING_LEVEL_METRICS: Record<number, { size: string; margin: string }> = {
  1: { size: "2em", margin: "0.67em" },
  2: { size: "1.5em", margin: "0.83em" },
  3: { size: "1.17em", margin: "1em" },
  4: { size: "1em", margin: "1.33em" },
  5: { size: "0.83em", margin: "1.67em" },
  6: { size: "0.67em", margin: "2.33em" },
};

const HEADING_LEVEL_STYLE_ID = "hypen-heading-level-styles";

/**
 * Rules giving a heading whose `level` changed after creation the NEW level's
 * size, weight and block margins (see `applyProps`). Every selector sits inside
 * `:where()`, so the rules have zero specificity: as author-origin rules they
 * still beat the user-agent `hN` defaults they stand in for, yet ANY author
 * styling — a `.fontSize()` / `.margin()` applicator (inline), a Tailwind
 * `text-*` class — wins over them, just as it would over the tag's own UA
 * style. The sheet is inserted FIRST in its root, so an equally unspecific
 * author reset (`* { margin: 0 }`) also wins, whatever order it loaded in.
 */
export const HEADING_LEVEL_CSS = Object.entries(HEADING_LEVEL_METRICS)
  .map(
    ([level, { size, margin }]) =>
      `:where([data-hypen-type="heading"][data-hypen-level="${level}"]) ` +
      `{ font-size: ${size}; font-weight: bold; margin-block: ${margin}; }`
  )
  .join("\n");

/**
 * Install `HEADING_LEVEL_CSS` where `el` will match it: its shadow root when
 * it lives in one (document-level rules never cross a shadow boundary), else
 * its OWN document — which, for a renderer mounted in an iframe or another
 * window's document, is not the global `document`. Once per root (re-added
 * if a host app replaced `<head>` or the shadow root's content).
 */
function ensureHeadingLevelStyles(el: HTMLElement): void {
  const root: any = typeof el.getRootNode === "function" ? el.getRootNode() : null;
  const isShadowRoot =
    !!root && root.nodeType === 11 /* DOCUMENT_FRAGMENT_NODE */ && "host" in root && !!root.host;
  const doc: Document | null =
    el.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  if (!doc) return;
  const existing = isShadowRoot
    ? root.querySelector?.(`#${HEADING_LEVEL_STYLE_ID}`)
    : doc.getElementById(HEADING_LEVEL_STYLE_ID);
  if (existing) return;
  const parent = isShadowRoot ? root : doc.head ?? doc.documentElement;
  if (!parent) return;
  const style = doc.createElement("style");
  style.id = HEADING_LEVEL_STYLE_ID;
  style.textContent = HEADING_LEVEL_CSS;
  // FIRST in its root: among author rules of equal (zero) specificity the
  // later one wins, so a host's own reset (`* { margin: 0 }`, `:where(h1…)`)
  // declared anywhere must still beat these UA stand-ins.
  parent.insertBefore(style, parent.firstChild);
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
        el.dataset.hypenLevel = String(level);
        ensureHeadingLevelStyles(el);
      }
    }

    const text = props["0"] ?? props.text;
    if (text !== undefined) {
      el.dataset.textTemplate = String(text);
      el.textContent = String(text);
    }
  },
};
