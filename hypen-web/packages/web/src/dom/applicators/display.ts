/**
 * Display and Visibility Applicators
 */

import type { ApplicatorHandler } from "./types.js";

export const displayHandlers: Record<string, ApplicatorHandler> = {
  display: (el, value) => {
    el.style.display = String(value);
  },

  visibility: (el, value) => {
    el.style.visibility = String(value);
  },

  overflowX: (el, value) => {
    el.style.overflowX = String(value);
  },

  overflowY: (el, value) => {
    el.style.overflowY = String(value);
  },

  pointerEvents: (el, value) => {
    el.style.pointerEvents = String(value);
  },

  userSelect: (el, value) => {
    el.style.userSelect = String(value);
  },

  resize: (el, value) => {
    el.style.resize = String(value);
  },

  boxSizing: (el, value) => {
    el.style.boxSizing = String(value);
  },

  // Sizing helpers
  aspectRatio: (el, value) => {
    el.style.aspectRatio = String(value);
  },

  objectFit: (el, value) => {
    el.style.objectFit = String(value);
  },

  objectPosition: (el, value) => {
    el.style.objectPosition = String(value);
  },
};


