/**
 * Layout Applicators (Flexbox/Grid)
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength } from "./size.js";

/**
 * Maps Hypen alignment values to CSS flexbox values.
 * Ensures consistent cross-platform API (Android/iOS/Web).
 */
export function mapAlignmentValue(value: string): string {
  const v = String(value).toLowerCase();
  switch (v) {
    // Positional values -> CSS equivalents
    case "top":
    case "start":
    case "leading":
    case "left":
      return "flex-start";
    case "bottom":
    case "end":
    case "trailing":
    case "right":
      return "flex-end";
    case "center":
      return "center";
    // Spacing values -> CSS equivalents
    case "spacebetween":
    case "space-between":
      return "space-between";
    case "spacearound":
    case "space-around":
      return "space-around";
    case "spaceevenly":
    case "space-evenly":
      return "space-evenly";
    // Pass through CSS values as-is
    default:
      return v;
  }
}

export const layoutHandlers: Record<string, ApplicatorHandler> = {
  // Unified alignment API - works for both Column and Row
  verticalAlignment: (el, value) => {
    const val = mapAlignmentValue(String(value));
    // Check display and flex-direction to determine which CSS property to set
    const display = el.style.display || getComputedStyle(el).display;
    const flexDirection = el.style.flexDirection || getComputedStyle(el).flexDirection;

    if (display === "grid") {
      // For Grid (Stack): use align-items to align children vertically
      el.style.alignItems = val;
    } else if (flexDirection === "column" || flexDirection === "column-reverse") {
      // For column: vertical is the main axis (justify-content)
      el.style.justifyContent = val;
    } else {
      // For row: vertical is the cross axis (align-items)
      el.style.alignItems = val;
    }
  },

  horizontalAlignment: (el, value) => {
    const val = mapAlignmentValue(String(value));
    // Check display and flex-direction to determine which CSS property to set
    const display = el.style.display || getComputedStyle(el).display;
    const flexDirection = el.style.flexDirection || getComputedStyle(el).flexDirection;

    if (display === "grid") {
      // For Grid (Stack): use justify-items to align children horizontally
      el.style.justifyItems = val;
    } else if (flexDirection === "column" || flexDirection === "column-reverse") {
      // For column: horizontal is the cross axis (align-items)
      el.style.alignItems = val;
    } else if (flexDirection === "row" || flexDirection === "row-reverse") {
      // For row: horizontal is the main axis (justify-content)
      el.style.justifyContent = val;
      // For arrangement to have visible effect, Row needs to fill available width
      // (matching iOS/Android behavior where non-start alignment auto-expands)
      // Only auto-expand if not scrollable
      if (val !== "flex-start" && el.style.overflow !== "auto" && el.style.overflowX !== "auto") {
        el.style.width = "100%";
      }
    } else {
      // Fallback for other display types
      el.style.justifyContent = val;
    }
  },

  // Legacy aliases (kept for backward compatibility)
  horizontalAlign: (el, value) => {
    el.style.justifyContent = mapAlignmentValue(String(value));
  },

  verticalAlign: (el, value) => {
    el.style.alignItems = mapAlignmentValue(String(value));
  },

  gap: (el, value) => {
    el.style.gap = toCssLength(value);
  },

  // weight: unified cross-platform API (same as flex)
  // Use .weight(1) to make element take remaining space in Row/Column
  weight: (el, value) => {
    el.style.flex = String(value);
    // CSS sets `min-width/min-height: auto` (= min-content) on flex items by
    // default, so a flex-1 child can never shrink below its intrinsic
    // content size — meaning a 20,000-tall feed inside a 900px viewport
    // overflowed because HomePage's `flex-1` couldn't shrink. The classic
    // CSS workaround is `min-*: 0`. Apply it here so authors don't need to
    // remember; explicit user `minWidth`/`minHeight` overrides it (the
    // applicator runs after `weight`/`flex`).
    if (!el.style.minWidth) el.style.minWidth = "0";
    if (!el.style.minHeight) el.style.minHeight = "0";
    el.dataset.hypenFlex = "true";
  },

  // flex: CSS flex shorthand (kept for CSS compatibility)
  flex: (el, value) => {
    el.style.flex = String(value);
    // See note on `weight` above — flex children need `min-*: 0` to shrink.
    if (!el.style.minWidth) el.style.minWidth = "0";
    if (!el.style.minHeight) el.style.minHeight = "0";
    el.dataset.hypenFlex = "true";
  },

  flexGrow: (el, value) => {
    el.style.flexGrow = String(value);
  },

  flexShrink: (el, value) => {
    el.style.flexShrink = String(value);
  },

  cursor: (el, value) => {
    el.style.cursor = String(value);
  },

  overflow: (el, value) => {
    el.style.overflow = String(value);
  },

  scrollable: (el, value) => {
    // CSS spec: setting `overflow-x` to a non-visible value forces
    // `overflow-y: auto` (and vice versa) — you can't mix `visible` with
    // a scrolling axis. That combo makes the element a scroll container
    // on both axes, and flex items with overflow get `min-height: auto`
    // collapsed to 0, so a `scrollable("horizontal")` row inside a
    // flex-column parent (the social Stories carousel) shrank to just
    // its padding (18 tall) instead of hugging its 92-tall avatars. We
    // pin `min-height`/`min-width` to `fit-content` on the non-scroll
    // axis so the intrinsic size survives.
    if (value === true || value === "true" || value === "both") {
      el.style.overflow = "auto";
    } else if (value === false || value === "false") {
      el.style.overflow = "hidden";
    } else if (value === "vertical") {
      el.style.overflowY = "auto";
      if (!el.style.minWidth) el.style.minWidth = "fit-content";
    } else if (value === "horizontal") {
      el.style.overflowX = "auto";
      if (!el.style.minHeight) el.style.minHeight = "fit-content";
      // A flex-column parent with `align-items: flex-start` (our Column
      // default, matching iOS/Android "wrap to content") leaves a child
      // row at its natural width — so a 5×96 carousel was 498 wide inside
      // a 470 viewport and the whole page scrolled horizontally. Force
      // the scroll container to fit the parent's cross-axis and clamp at
      // that width so the overflow is trapped inside.
      if (!el.style.alignSelf) el.style.alignSelf = "stretch";
      if (!el.style.width) el.style.width = "100%";
      if (!el.style.maxWidth) el.style.maxWidth = "100%";
      if (!el.style.minWidth) el.style.minWidth = "0";
    } else {
      el.style.overflow = String(value);
    }
  },
};
