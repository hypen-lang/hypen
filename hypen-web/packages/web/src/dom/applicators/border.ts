/**
 * Border Applicators
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength } from "./size.js";

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
    el.style.borderWidth = toCssLength(value);
    // CSS `border-style` default is `none`, so a width-only border draws
    // nothing. The Hypen DSL writes `.borderWidth(2).borderColor(...)`
    // expecting a visible stroke (the social Stories ring + the Profile
    // page Edit button). Override `none` too — the Button component
    // resets `border: none` at create time, so the inherited
    // border-style is "none" by the time this applicator lands.
    if (!el.style.borderStyle || el.style.borderStyle === "none") {
      el.style.borderStyle = "solid";
    }
  },

  borderStyle: (el, value) => {
    el.style.borderStyle = String(value);
  },

  borderRadius: (el, value) => {
    if (typeof value === "object" && value !== null) {
      // Support for individual corners
      const obj = value as Record<string, any>;
      const topLeft = obj.topLeft ?? obj.topStart ?? 0;
      const topRight = obj.topRight ?? obj.topEnd ?? 0;
      const bottomRight = obj.bottomRight ?? obj.bottomEnd ?? 0;
      const bottomLeft = obj.bottomLeft ?? obj.bottomStart ?? 0;
      el.style.borderRadius = `${toCssLength(topLeft)} ${toCssLength(topRight)} ${toCssLength(bottomRight)} ${toCssLength(bottomLeft)}`;
    } else {
      el.style.borderRadius = toCssLength(value);
    }
  },

  // Alias for borderRadius (Compose naming)
  cornerRadius: (el, value) => {
    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, any>;
      const topLeft = obj.topLeft ?? obj.topStart ?? 0;
      const topRight = obj.topRight ?? obj.topEnd ?? 0;
      const bottomRight = obj.bottomRight ?? obj.bottomEnd ?? 0;
      const bottomLeft = obj.bottomLeft ?? obj.bottomStart ?? 0;
      el.style.borderRadius = `${toCssLength(topLeft)} ${toCssLength(topRight)} ${toCssLength(bottomRight)} ${toCssLength(bottomLeft)}`;
    } else {
      el.style.borderRadius = toCssLength(value);
    }
  },
};
