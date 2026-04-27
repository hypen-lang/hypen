/**
 * Color Applicators
 */

import type { ApplicatorHandler } from "./types.js";

export const colorHandlers: Record<string, ApplicatorHandler> = {
  color: (el, value) => {
    el.style.color = String(value);
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
