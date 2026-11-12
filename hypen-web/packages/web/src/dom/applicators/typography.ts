/**
 * Typography Applicators
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength } from "./size.js";

/**
 * The cross-axis fill a non-start `textAlign` asks for, as a stylesheet rule
 * rather than inline styles.
 *
 * `text-align: center | right | end | justify` only shows when the box is
 * wider than its text, so an aligned element fills its parent's width. That
 * fill used to be written inline (`align-self: stretch; width: 100%`)
 * without knowing the parent, which is wrong in a horizontal parent: in a
 * Row, `align-self` is the VERTICAL axis (the text stretched to the row's
 * height and sat at the top, ignoring the Row's vertical alignment) and
 * `width: 100%` took the whole row (an unread badge filled its row). The
 * native renderers fill the available width but never the cross axis of a
 * row, and never override the row's own alignment.
 *
 * The rule fills only outside horizontal parents. Both selectors are
 * zero-specificity (`:where`), so any explicit `alignSelf` / `width` — inline
 * or a variant class — still wins, as the old `if (!el.style.alignSelf)`
 * guards intended.
 */
const TEXT_FILL_STYLE_ID = "hypen-text-align-fill";
const TEXT_FILL_CSS = `
:where([data-hypen-text-fill]) { align-self: stretch; justify-self: stretch; }
:where([data-hypen-type="row"], [data-hypen-type="center"], [data-hypen-type="badge"]) > :where([data-hypen-text-fill]) {
  align-self: auto;
  justify-self: auto;
}
`;

function ensureTextFillStyles(): void {
  if (typeof document === "undefined" || !document.head) return;
  if (typeof document.getElementById === "function" && document.getElementById(TEXT_FILL_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = TEXT_FILL_STYLE_ID;
  style.textContent = TEXT_FILL_CSS;
  document.head.appendChild(style);
}

/** Shared by `font.ts` and this module (the later registration wins). */
export const applyTextAlign: ApplicatorHandler = (el, value) => {
  if (value === null || value === undefined) {
    el.style.removeProperty("text-align");
    delete el.dataset.hypenTextFill;
    return;
  }
  const v = String(value);
  el.style.textAlign = v;
  if (v === "center" || v === "right" || v === "end" || v === "justify") {
    ensureTextFillStyles();
    el.dataset.hypenTextFill = "";
    // A shrink-to-fit `Text` (inline-block) cannot take the fill.
    if (el.style.display === "inline-block" || !el.style.display) {
      el.style.display = "block";
    }
  } else {
    delete el.dataset.hypenTextFill;
  }
};

export const typographyHandlers: Record<string, ApplicatorHandler> = {
  textAlign: applyTextAlign,

  textTransform: (el, value) => {
    el.style.textTransform = String(value);
  },

  textDecoration: (el, value) => {
    el.style.textDecoration = String(value);
  },

  textDecorationColor: (el, value) => {
    el.style.textDecorationColor = String(value);
  },

  textDecorationStyle: (el, value) => {
    el.style.textDecorationStyle = String(value);
  },

  textDecorationThickness: (el, value) => {
    el.style.textDecorationThickness = toCssLength(value);
  },

  letterSpacing: (el, value) => {
    el.style.letterSpacing = toCssLength(value);
  },

  wordSpacing: (el, value) => {
    el.style.wordSpacing = toCssLength(value);
  },

  lineHeight: (el, value) => {
    // `line-height` is unitless by convention when the value is a bare
    // number (CSS multiplier on the element's font-size); only normalise
    // when the value carries a length unit like `dp` / `sp`.
    if (typeof value === "string" && /^-?[\d.]+\s*(dp|sp)$/i.test(value.trim())) {
      el.style.lineHeight = toCssLength(value);
    } else {
      el.style.lineHeight = String(value);
    }
  },

  textIndent: (el, value) => {
    el.style.textIndent = toCssLength(value);
  },

  textOverflow: (el, value) => {
    el.style.textOverflow = String(value);
  },

  whiteSpace: (el, value) => {
    el.style.whiteSpace = String(value);
  },

  wordBreak: (el, value) => {
    el.style.wordBreak = String(value);
  },

  verticalAlign: (el, value) => {
    el.style.verticalAlign = String(value);
  },

  fontVariant: (el, value) => {
    el.style.fontVariant = String(value);
  },

  fontStretch: (el, value) => {
    el.style.fontStretch = String(value);
  },

  fontStyle: (el, value) => {
    el.style.fontStyle = String(value);
  },

  writingMode: (el, value) => {
    el.style.writingMode = String(value);
  },

  maxLines: (el, value) => {
    const lines = typeof value === "number" ? value : parseInt(String(value), 10);
    if (!isNaN(lines) && lines > 0) {
      el.style.display = "-webkit-box";
      el.style.setProperty("-webkit-line-clamp", String(lines));
      el.style.setProperty("-webkit-box-orient", "vertical");
      el.style.overflow = "hidden";
    }
  },
};


