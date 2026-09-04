/**
 * Color Applicators
 */

import type { ApplicatorHandler } from "./types.js";

/**
 * Marks an element whose text colour came from the canonical `color`, so the
 * `foregroundColor` alias yields to it regardless of which applicator the
 * registry happens to run first.
 */
const COLOR_IS_CANONICAL = "hypenColorCanonical";

export const colorHandlers: Record<string, ApplicatorHandler> = {
  color: (el, value) => {
    if (value === undefined) {
      delete el.dataset[COLOR_IS_CANONICAL];
      el.style.color = "";
      return;
    }
    el.dataset[COLOR_IS_CANONICAL] = "true";
    el.style.color = String(value);
  },

  /**
   * SwiftUI/Compose spelling of the same applicator, which the native
   * renderers already accept. Without it the unknown-prop fallback writes
   * `foreground-color`, which is not a CSS property, so the text colour is
   * silently dropped on the web.
   *
   * When a node sets both, `color` wins — matching the canvas, which resolves
   * the alias only after the canonical name on each node
   * (`canvas/utils.ts` INHERITED_PROP_ALIASES). The marker makes that true in
   * either application order rather than leaving it to key iteration.
   */
  foregroundColor: (el, value) => {
    if (el.dataset[COLOR_IS_CANONICAL]) return;
    el.style.color = value === undefined ? "" : String(value);
  },

  backgroundColor: (el, value) => {
    el.style.backgroundColor = String(value);
  },

  borderColor: (el, value) => {
    el.style.borderColor = String(value);
  },

  opacity: (el, value) => {
    el.style.opacity = String(value);
  },
};
