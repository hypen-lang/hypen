/**
 * Border Applicators
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength } from "./size.js";

type BorderWidthProperty =
  | "borderWidth"
  | "borderTopWidth"
  | "borderRightWidth"
  | "borderBottomWidth"
  | "borderLeftWidth";

type BorderStyleProperty =
  | "borderStyle"
  | "borderTopStyle"
  | "borderRightStyle"
  | "borderBottomStyle"
  | "borderLeftStyle";

function applyVisibleBorderWidth(
  el: HTMLElement,
  value: any,
  widthProperty: BorderWidthProperty,
  styleProperty: BorderStyleProperty,
): void {
  el.style[widthProperty] = toCssLength(value);

  // A CSS width without a style has a used width of zero. Hypen's border
  // width applicators represent a visible border, so default both uniform
  // and directional widths to solid unless a visible style is already set.
  if (!el.style[styleProperty] || el.style[styleProperty] === "none") {
    el.style[styleProperty] = "solid";
  }
}

/** Logical corner key → CSS logical radius property (follows `dir`). */
const LOGICAL_CORNERS: Array<[string, string]> = [
  ["topStart", "border-start-start-radius"],
  ["topEnd", "border-start-end-radius"],
  ["bottomEnd", "border-end-end-radius"],
  ["bottomStart", "border-end-start-radius"],
];

/**
 * Per-corner radius object. Physical keys (`topLeft`, …) set physical
 * corners; logical keys (`topStart`, `topEnd`, `bottomStart`, `bottomEnd`)
 * set CSS logical radii, so they mirror under `dir="rtl"`. A logical key
 * wins over the physical key for the same corner in LTR (it is written
 * last). Unset corners are 0, as before.
 */
function applyCornerRadii(el: HTMLElement, obj: Record<string, any>): void {
  el.style.borderRadius = `${toCssLength(obj.topLeft ?? 0)} ${toCssLength(obj.topRight ?? 0)} ${toCssLength(obj.bottomRight ?? 0)} ${toCssLength(obj.bottomLeft ?? 0)}`;
  for (const [key, prop] of LOGICAL_CORNERS) {
    if (obj[key] !== undefined) el.style.setProperty(prop, toCssLength(obj[key]));
  }
}

export const borderHandlers: Record<string, ApplicatorHandler> = {
  // Compound border applicator - can take width, color, style, radius
  border: (el, value) => {
    if (typeof value === "number") {
      // Just width
      el.style.borderWidth = `${value}px`;
      el.style.borderStyle = "solid";
    } else if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, any>;

      // Width
      if (obj.width !== undefined) {
        el.style.borderWidth = toCssLength(obj.width);
      }

      // Color
      if (obj.color !== undefined) {
        el.style.borderColor = String(obj.color);
      }

      // Style (solid, dashed, dotted, etc.)
      if (obj.style !== undefined) {
        el.style.borderStyle = String(obj.style);
      } else {
        // Default to solid if not specified
        el.style.borderStyle = "solid";
      }

      // Radius
      if (obj.radius !== undefined) {
        el.style.borderRadius = toCssLength(obj.radius);
      }
    } else if (typeof value === "string") {
      // CSS shorthand like "1px solid black"
      el.style.border = value;
    }
  },

  borderWidth: (el, value) => {
    applyVisibleBorderWidth(el, value, "borderWidth", "borderStyle");
  },

  borderTopWidth: (el, value) => {
    applyVisibleBorderWidth(el, value, "borderTopWidth", "borderTopStyle");
  },

  borderRightWidth: (el, value) => {
    applyVisibleBorderWidth(el, value, "borderRightWidth", "borderRightStyle");
  },

  borderBottomWidth: (el, value) => {
    applyVisibleBorderWidth(el, value, "borderBottomWidth", "borderBottomStyle");
  },

  borderLeftWidth: (el, value) => {
    applyVisibleBorderWidth(el, value, "borderLeftWidth", "borderLeftStyle");
  },

  borderStyle: (el, value) => {
    el.style.borderStyle = String(value);
  },

  borderRadius: (el, value) => {
    if (typeof value === "object" && value !== null) {
      // Support for individual corners
      applyCornerRadii(el, value as Record<string, any>);
    } else {
      el.style.borderRadius = toCssLength(value);
    }
  },

  // Alias for borderRadius (Compose naming)
  cornerRadius: (el, value) => {
    if (typeof value === "object" && value !== null) {
      applyCornerRadii(el, value as Record<string, any>);
    } else {
      el.style.borderRadius = toCssLength(value);
    }
  },
};
