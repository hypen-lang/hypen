/**
 * Visual Effects Applicators (Shadows, Filters, Blend Modes)
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength } from "./size.js";
import { setCssFunction, fnArg } from "./css-functions.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * SVG geometry has no box, so `box-shadow` does nothing on a chart mark or
 * an icon. The shadow family routes to `filter: drop-shadow()` there — the
 * one shadow that follows a stroked path.
 */
function isSvg(el: HTMLElement): boolean {
  const SVG = (globalThis as any).SVGElement;
  if (typeof SVG === "function" && el instanceof SVG) return true;
  return (el as any).namespaceURI === SVG_NS;
}

function dropShadow(el: HTMLElement, x: string, y: string, blur: string, color: string): void {
  setCssFunction(el, "filter", "drop-shadow", `${x} ${y} ${blur} ${color}`);
}

/**
 * `.shadow(...)`-style value → `[x, y, blur, color]` CSS pieces, or null when
 * the value is a raw CSS string the caller should write through unchanged.
 */
function shadowParts(value: unknown, defaultBlur: number): [string, string, string, string] | null {
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    return [
      toCssLength((obj.x ?? obj.offsetX ?? 0) as any),
      toCssLength((obj.y ?? obj.offsetY ?? 0) as any),
      toCssLength((obj.blur ?? obj.radius ?? defaultBlur) as any),
      String(obj.color ?? "rgba(0,0,0,0.2)"),
    ];
  }
  if (typeof value === "number") {
    return ["0", `${value}px`, `${value * 2}px`, "rgba(0,0,0,0.2)"];
  }
  return null;
}

export const effectsHandlers: Record<string, ApplicatorHandler> = {
  // Shadow effects
  boxShadow: (el, value) => {
    if (isSvg(el)) {
      const parts = shadowParts(value, 0);
      if (parts) dropShadow(el, ...parts);
      else setCssFunction(el, "filter", "drop-shadow", String(value));
      return;
    }
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
    if (isSvg(el)) {
      const parts = shadowParts(value, 4);
      if (parts) dropShadow(el, ...parts);
      else setCssFunction(el, "filter", "drop-shadow", String(value));
      return;
    }
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
    if (isSvg(el)) {
      const level = Number(value) || 0;
      dropShadow(el, "0", `${level}px`, `${level * 1.5}px`, `rgba(0,0,0,${Math.min(0.1 + level * 0.02, 0.4)})`);
      return;
    }
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

  // Individual filter functions — each replaces its own function inside
  // `style.filter` (see css-functions.ts); they compose with each other.
  blur: (el, value) => setCssFunction(el, "filter", "blur", fnArg(value, (v) => toCssLength(v as any))),
  brightness: (el, value) => setCssFunction(el, "filter", "brightness", fnArg(value)),
  contrast: (el, value) => setCssFunction(el, "filter", "contrast", fnArg(value)),
  grayscale: (el, value) => setCssFunction(el, "filter", "grayscale", fnArg(value)),
  hueRotate: (el, value) => setCssFunction(el, "filter", "hue-rotate", fnArg(value)),
  invert: (el, value) => setCssFunction(el, "filter", "invert", fnArg(value)),
  saturate: (el, value) => setCssFunction(el, "filter", "saturate", fnArg(value)),
  sepia: (el, value) => setCssFunction(el, "filter", "sepia", fnArg(value)),
  dropShadow: (el, value) => setCssFunction(el, "filter", "drop-shadow", fnArg(value)),
  /**
   * Soft light around the element's painted shape — a chart line, an icon,
   * a button. `.glow(color)`, `.glow(radius)`, or `.glow({color, radius})`;
   * defaults to the element's text colour and 6px. Composes with the other
   * filter functions and works on HTML and SVG alike.
   */
  glow: (el, value) => {
    if (value == null || value === false) {
      setCssFunction(el, "filter", "drop-shadow", null);
      return;
    }
    let color = "currentColor";
    let radius = 6;
    if (typeof value === "number") radius = value;
    else if (typeof value === "string") color = value;
    else if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (obj.color != null) color = String(obj.color);
      if (obj.radius != null) radius = Number(obj.radius);
      else if (obj.blur != null) radius = Number(obj.blur);
    }
    dropShadow(el, "0", "0", `${radius}px`, color);
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


