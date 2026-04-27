/**
 * Background Applicators
 */

import type { ApplicatorHandler } from "./types.js";

export const backgroundHandlers: Record<string, ApplicatorHandler> = {
  backgroundImage: (el, value) => {
    el.style.backgroundImage = String(value);
  },

  backgroundSize: (el, value) => {
    el.style.backgroundSize = String(value);
  },

  backgroundPosition: (el, value) => {
    el.style.backgroundPosition = String(value);
  },

  backgroundRepeat: (el, value) => {
    el.style.backgroundRepeat = String(value);
  },

  backgroundAttachment: (el, value) => {
    el.style.backgroundAttachment = String(value);
  },

  backgroundClip: (el, value) => {
    el.style.backgroundClip = String(value);
  },

  backgroundOrigin: (el, value) => {
    el.style.backgroundOrigin = String(value);
  },

  // Gradient helpers
  linearGradient: (el, value) => {
    el.style.backgroundImage = `linear-gradient(${value})`;
  },

  radialGradient: (el, value) => {
    el.style.backgroundImage = `radial-gradient(${value})`;
  },

  conicGradient: (el, value) => {
    el.style.backgroundImage = `conic-gradient(${value})`;
  },
};


