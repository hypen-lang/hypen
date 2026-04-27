/**
 * Typography Applicators
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength } from "./size.js";

export const typographyHandlers: Record<string, ApplicatorHandler> = {
  textAlign: (el, value) => {
    const v = String(value);
    el.style.textAlign = v;
    // Mirror `font.ts#textAlign`: stretch + block so non-left alignments
    // actually have room to act in a shrink-to-fit `Text` element.
    if (v === "center" || v === "right" || v === "end" || v === "justify") {
      if (!el.style.alignSelf) el.style.alignSelf = "stretch";
      if (!el.style.width) el.style.width = "100%";
      if (el.style.display === "inline-block" || !el.style.display) {
        el.style.display = "block";
      }
    }
  },

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


