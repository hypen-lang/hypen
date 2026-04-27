/**
 * Visual Effects Applicators (Shadows, Filters, Blend Modes)
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength } from "./size.js";

export const effectsHandlers: Record<string, ApplicatorHandler> = {
  // Shadow effects
  boxShadow: (el, value) => {
    if (typeof value === "string") {
      el.style.boxShadow = value;
    } else if (typeof value === "object" && value !== null) {
      // Object format: { x, y, blur, spread, color, inset }
      const obj = value as Record<string, any>;
      const x = toCssLength(obj.x ?? obj.offsetX ?? 0);
      const y = toCssLength(obj.y ?? obj.offsetY ?? 0);
      const blur = toCssLength(obj.blur ?? obj.radius ?? 0);
      const spread = toCssLength(obj.spread ?? 0);
      const color = obj.color ?? "rgba(0,0,0,0.2)";
      const inset = obj.inset ? "inset " : "";
      el.style.boxShadow = `${inset}${x} ${y} ${blur} ${spread} ${color}`;
    } else if (typeof value === "number") {
      // Just blur/elevation as number
      el.style.boxShadow = `0 ${value}px ${value * 2}px rgba(0,0,0,0.2)`;
    }
  },

  // Compound shadow with explicit offset support
  shadow: (el, value) => {
    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, any>;
      const x = toCssLength(obj.x ?? obj.offsetX ?? 0);
      const y = toCssLength(obj.y ?? obj.offsetY ?? 0);
      const blur = toCssLength(obj.blur ?? obj.radius ?? 4);
      const color = obj.color ?? "rgba(0,0,0,0.2)";
      el.style.boxShadow = `${x} ${y} ${blur} ${color}`;
    } else if (typeof value === "number") {
      // Elevation-style: shadow grows with value
      el.style.boxShadow = `0 ${value}px ${value * 2}px rgba(0,0,0,0.2)`;
    } else {
      el.style.boxShadow = String(value);
    }
  },

  // Elevation (Material Design style)
  elevation: (el, value) => {
    const level = typeof value === "number" ? value : parseInt(String(value), 10);
    if (!isNaN(level) && level >= 0) {
      // Map elevation to box-shadow similar to Material Design
      const y = level * 0.5;
      const blur = level * 1.5;
      const opacity = Math.min(0.1 + level * 0.02, 0.4);
      el.style.boxShadow = `0 ${y}px ${blur}px rgba(0,0,0,${opacity})`;
    }
  },

  textShadow: (el, value) => {
    el.style.textShadow = String(value);
  },

  // Filter effects
  filter: (el, value) => {
    el.style.filter = String(value);
  },

  backdropFilter: (el, value) => {
    el.style.backdropFilter = String(value);
  },

  // Individual filter functions
  blur: (el, value) => {
    const val = toCssLength(value);
    const current = el.style.filter || "";
    el.style.filter = current ? `${current} blur(${val})` : `blur(${val})`;
  },

  brightness: (el, value) => {
    const current = el.style.filter || "";
    el.style.filter = current ? `${current} brightness(${value})` : `brightness(${value})`;
  },

  contrast: (el, value) => {
    const current = el.style.filter || "";
    el.style.filter = current ? `${current} contrast(${value})` : `contrast(${value})`;
  },

  grayscale: (el, value) => {
    const current = el.style.filter || "";
    el.style.filter = current ? `${current} grayscale(${value})` : `grayscale(${value})`;
  },

  hueRotate: (el, value) => {
    const val = String(value);
    const current = el.style.filter || "";
    el.style.filter = current ? `${current} hue-rotate(${val})` : `hue-rotate(${val})`;
  },

  invert: (el, value) => {
    const current = el.style.filter || "";
    el.style.filter = current ? `${current} invert(${value})` : `invert(${value})`;
  },

  saturate: (el, value) => {
    const current = el.style.filter || "";
    el.style.filter = current ? `${current} saturate(${value})` : `saturate(${value})`;
  },

  sepia: (el, value) => {
    const current = el.style.filter || "";
    el.style.filter = current ? `${current} sepia(${value})` : `sepia(${value})`;
  },

  dropShadow: (el, value) => {
    const current = el.style.filter || "";
    el.style.filter = current ? `${current} drop-shadow(${value})` : `drop-shadow(${value})`;
  },

  // Blend modes
  mixBlendMode: (el, value) => {
    el.style.mixBlendMode = String(value);
  },

  backgroundBlendMode: (el, value) => {
    el.style.backgroundBlendMode = String(value);
  },

  // Clip and mask
  clipPath: (el, value) => {
    el.style.clipPath = String(value);
  },

  mask: (el, value) => {
    el.style.mask = String(value);
  },

  maskImage: (el, value) => {
    el.style.maskImage = String(value);
  },
};


