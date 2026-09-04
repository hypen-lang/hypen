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

export const headingHandler: ComponentHandler = {
  // The tag is chosen here and never changes afterwards: `createElement` runs
  // before the element is parented, so the old replaceChild path could never
  // fire, and swapping the element later would orphan the renderer's `nodes`
  // entry. A level that changes reactively is expressed with `aria-level`,
  // which is the ARIA-sanctioned override for exactly this case.
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
      } else {
        el.setAttribute("aria-level", String(level));
      }
    }

    const text = props["0"] ?? props.text;
    if (text !== undefined) {
      el.dataset.textTemplate = String(text);
      el.textContent = String(text);
    }
  },
};
