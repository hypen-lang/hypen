/**
 * Transform Applicators
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength } from "./size.js";

export const transformHandlers: Record<string, ApplicatorHandler> = {
  transform: (el, value) => {
    el.style.transform = String(value);
  },

  transformOrigin: (el, value) => {
    el.style.transformOrigin = String(value);
  },

  translateX: (el, value) => {
    const current = el.style.transform || "";
    const val = toCssLength(value);
    el.style.transform = current ? `${current} translateX(${val})` : `translateX(${val})`;
  },

  translateY: (el, value) => {
    const current = el.style.transform || "";
    const val = toCssLength(value);
    el.style.transform = current ? `${current} translateY(${val})` : `translateY(${val})`;
  },

  translateZ: (el, value) => {
    const current = el.style.transform || "";
    const val = toCssLength(value);
    el.style.transform = current ? `${current} translateZ(${val})` : `translateZ(${val})`;
  },

  rotate: (el, value) => {
    const current = el.style.transform || "";
    const val = String(value);
    el.style.transform = current ? `${current} rotate(${val})` : `rotate(${val})`;
  },

  rotateX: (el, value) => {
    const current = el.style.transform || "";
    const val = String(value);
    el.style.transform = current ? `${current} rotateX(${val})` : `rotateX(${val})`;
  },

  rotateY: (el, value) => {
    const current = el.style.transform || "";
    const val = String(value);
    el.style.transform = current ? `${current} rotateY(${val})` : `rotateY(${val})`;
  },

  rotateZ: (el, value) => {
    const current = el.style.transform || "";
    const val = String(value);
    el.style.transform = current ? `${current} rotateZ(${val})` : `rotateZ(${val})`;
  },

  scale: (el, value) => {
    const current = el.style.transform || "";
    el.style.transform = current ? `${current} scale(${value})` : `scale(${value})`;
  },

  scaleX: (el, value) => {
    const current = el.style.transform || "";
    el.style.transform = current ? `${current} scaleX(${value})` : `scaleX(${value})`;
  },

  scaleY: (el, value) => {
    const current = el.style.transform || "";
    el.style.transform = current ? `${current} scaleY(${value})` : `scaleY(${value})`;
  },

  skew: (el, value) => {
    const current = el.style.transform || "";
    el.style.transform = current ? `${current} skew(${value})` : `skew(${value})`;
  },

  skewX: (el, value) => {
    const current = el.style.transform || "";
    el.style.transform = current ? `${current} skewX(${value})` : `skewX(${value})`;
  },

  skewY: (el, value) => {
    const current = el.style.transform || "";
    el.style.transform = current ? `${current} skewY(${value})` : `skewY(${value})`;
  },

  perspective: (el, value) => {
    el.style.perspective = toCssLength(value);
  },
};


