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

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;

const isVisibleStyle = (v: string | undefined): boolean => !!v && v !== "none" && v !== "hidden";

/**
 * Hypen borders follow Tailwind's model, where every side's width starts at
 * 0 (preflight) and only the widths the author writes are drawn: `.tw("border-t-2
 * border-dashed")` is ONE dashed rule on top. In plain CSS a side with a
 * visible style and no width is `medium` (3px), so once `borderStyle` made
 * every side dashed, the other three sides drew thick 3px dashes too (the
 * Calories goal line became a chunky dashed box edge; the desktop renderer
 * drew the top rule only). When the author set SOME sides' widths, a side
 * with a visible style but no width of its own is given 0.
 */
function zeroUnsetVisibleSides(el: HTMLElement): void {
  const style = el.style as unknown as Record<string, string>;
  if (style.borderWidth) return; // a uniform width covers every side
  const widthSet = SIDES.filter((side) => !!style[`border${side}Width`]);
  if (widthSet.length === 0 || widthSet.length === SIDES.length) return;
  for (const side of SIDES) {
    if (style[`border${side}Width`]) continue;
    const sideStyle = style[`border${side}Style`] || style.borderStyle;
    if (isVisibleStyle(sideStyle)) style[`border${side}Width`] = "0px";
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
    zeroUnsetVisibleSides(el);
  },

  borderRightWidth: (el, value) => {
    applyVisibleBorderWidth(el, value, "borderRightWidth", "borderRightStyle");
    zeroUnsetVisibleSides(el);
  },

  borderBottomWidth: (el, value) => {
    applyVisibleBorderWidth(el, value, "borderBottomWidth", "borderBottomStyle");
    zeroUnsetVisibleSides(el);
  },

  borderLeftWidth: (el, value) => {
    applyVisibleBorderWidth(el, value, "borderLeftWidth", "borderLeftStyle");
    zeroUnsetVisibleSides(el);
  },

  borderStyle: (el, value) => {
    el.style.borderStyle = String(value);
    zeroUnsetVisibleSides(el);
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
