/**
 * Transition and Animation Applicators
 */

import type { ApplicatorHandler } from "./types.js";

export const transitionHandlers: Record<string, ApplicatorHandler> = {
  transition: (el, value) => {
    el.style.transition = String(value);
  },

  transitionProperty: (el, value) => {
    el.style.transitionProperty = String(value);
  },

  transitionDuration: (el, value) => {
    el.style.transitionDuration = String(value);
  },

  transitionTimingFunction: (el, value) => {
    el.style.transitionTimingFunction = String(value);
  },

  transitionDelay: (el, value) => {
    el.style.transitionDelay = String(value);
  },

  animation: (el, value) => {
    el.style.animation = String(value);
  },

  animationName: (el, value) => {
    el.style.animationName = String(value);
  },

  animationDuration: (el, value) => {
    el.style.animationDuration = String(value);
  },

  animationTimingFunction: (el, value) => {
    el.style.animationTimingFunction = String(value);
  },

  animationDelay: (el, value) => {
    el.style.animationDelay = String(value);
  },

  animationIterationCount: (el, value) => {
    el.style.animationIterationCount = String(value);
  },

  animationDirection: (el, value) => {
    el.style.animationDirection = String(value);
  },

  animationFillMode: (el, value) => {
    el.style.animationFillMode = String(value);
  },

  animationPlayState: (el, value) => {
    el.style.animationPlayState = String(value);
  },
};


