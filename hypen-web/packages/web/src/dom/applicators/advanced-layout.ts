/**
 * Advanced Layout Applicators (Flexbox, Grid, Positioning)
 */

import type { ApplicatorHandler } from "./index.js";
import { mapAlignmentValue } from "./layout.js";
import { toCssLength } from "./size.js";

export const advancedLayoutHandlers: Record<string, ApplicatorHandler> = {
  // Flexbox properties
  flexDirection: (el, value) => {
    el.style.flexDirection = String(value);
  },

  flexBasis: (el, value) => {
    el.style.flexBasis = toCssLength(value);
  },

  alignContent: (el, value) => {
    el.style.alignContent = String(value);
  },

  order: (el, value) => {
    el.style.order = String(value);
  },

  // Grid properties
  gridTemplateColumns: (el, value) => {
    el.style.gridTemplateColumns = String(value);
  },

  gridTemplateRows: (el, value) => {
    el.style.gridTemplateRows = String(value);
  },

  // Unified API aliases (simpler names)
  gridColumns: (el, value) => {
    // Support number (repeat) or string (CSS value)
    if (typeof value === "number") {
      el.style.gridTemplateColumns = `repeat(${value}, 1fr)`;
    } else {
      el.style.gridTemplateColumns = String(value);
    }
  },

  gridRows: (el, value) => {
    // Support number (repeat) or string (CSS value)
    if (typeof value === "number") {
      el.style.gridTemplateRows = `repeat(${value}, 1fr)`;
    } else {
      el.style.gridTemplateRows = String(value);
    }
  },

  gridTemplateAreas: (el, value) => {
    el.style.gridTemplateAreas = String(value);
  },

  gridColumn: (el, value) => {
    el.style.gridColumn = String(value);
  },

  gridRow: (el, value) => {
    el.style.gridRow = String(value);
  },

  gridArea: (el, value) => {
    el.style.gridArea = String(value);
  },

  gridAutoFlow: (el, value) => {
    el.style.gridAutoFlow = String(value);
  },

  gridAutoColumns: (el, value) => {
    el.style.gridAutoColumns = String(value);
  },

  gridAutoRows: (el, value) => {
    el.style.gridAutoRows = String(value);
  },

  rowGap: (el, value) => {
    el.style.rowGap = toCssLength(value);
  },

  columnGap: (el, value) => {
    el.style.columnGap = toCssLength(value);
  },

  placeItems: (el, value) => {
    el.style.placeItems = String(value);
  },

  placeContent: (el, value) => {
    el.style.placeContent = String(value);
  },

  placeSelf: (el, value) => {
    el.style.placeSelf = String(value);
  },

  // Positioning
  position: (el, value) => {
    el.style.position = String(value);
  },

  top: (el, value) => {
    el.style.top = toCssLength(value);
  },

  right: (el, value) => {
    el.style.right = toCssLength(value);
  },

  bottom: (el, value) => {
    el.style.bottom = toCssLength(value);
  },

  left: (el, value) => {
    el.style.left = toCssLength(value);
  },

  inset: (el, value) => {
    el.style.inset = toCssLength(value);
  },

  zIndex: (el, value) => {
    el.style.zIndex = String(value);
  },
};


