/**
 * Advanced Layout Applicators (Flexbox, Grid, Positioning)
 */

import type { ApplicatorHandler } from "./index.js";
import { mapAlignmentValue } from "./layout.js";
import { toCssLength } from "./size.js";
import { trackCount } from "../../grid-tracks.js";

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

  // Grid: a column COUNT on the Grid and a column SPAN on its items — the
  // only grid features every renderer (DOM, Canvas, iOS, Android, desktop)
  // supports. The engine may deliver numbers as strings ("3").
  gridColumns: (el, value) => {
    const n = trackCount(value);
    if (n !== null) el.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  },

  // "span N" or N, as on iOS/Android (a bare N is a span, not a grid line).
  gridColumn: (el, value) => {
    const n = trackCount(String(value).trim().replace(/^span\s+/i, ""));
    if (n !== null) el.style.gridColumn = `span ${n}`;
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


