/**
 * Padding Applicators
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength as toCssLengthShared } from "./size.js";
import { hasSpacingNamedKey, resolveSpacingKeys } from "./spacing-keys.js";

// Format a value as a CSS length. Delegates to the shared helper in
// `size.ts` so `dp` / `sp` / `pt` normalise to `px` (CSS doesn't understand
// those suffixes). Numbers become `${n}px`; anything CSS already knows
// (`rem`, `em`, `%`, `calc(...)`, …) passes through unchanged. The object
// form (`v["0"]`) is carried over from the legacy applicator-argument
// shape that sometimes reaches this handler.
const toCssLength = (v: any): string => {
  if (v == null) return "";
  if (typeof v === "object" && v["0"] !== undefined) return toCssLength(v["0"]);
  return toCssLengthShared(v);
};

// Collect positional args ("0", "1", "2", "3") in order, stopping at the first
// gap. Returns an empty array if no positional args are present.
const positionalArgs = (value: any): any[] => {
  const args: any[] = [];
  for (let i = 0; value[String(i)] !== undefined; i++) {
    args.push(value[String(i)]);
  }
  return args;
};

export const paddingHandler: ApplicatorHandler = (el, value) => {
  if (typeof value === "number") {
    el.style.padding = `${value}px`;
    return;
  }

  if (typeof value !== "object" || value === null) {
    el.style.padding = toCssLength(value);
    return;
  }

  // Named-keys form: physical edges, the horizontal/vertical axes, and the
  // direction-aware start/end pair.
  if (hasSpacingNamedKey(value)) {
    const edges = resolveSpacingKeys(value);
    if (edges.top !== undefined) el.style.paddingTop = toCssLength(edges.top);
    if (edges.bottom !== undefined) el.style.paddingBottom = toCssLength(edges.bottom);
    if (edges.left !== undefined) el.style.paddingLeft = toCssLength(edges.left);
    if (edges.right !== undefined) el.style.paddingRight = toCssLength(edges.right);
    // Written after the physical edges so a logical key wins the cascade,
    // matching Swift's `leading ?? start ?? left` precedence.
    if (edges.inlineStart !== undefined) {
      el.style.setProperty("padding-inline-start", toCssLength(edges.inlineStart));
    }
    if (edges.inlineEnd !== undefined) {
      el.style.setProperty("padding-inline-end", toCssLength(edges.inlineEnd));
    }
    return;
  }

  // Positional form: .padding(v), .padding(v, h), .padding(t, h, b), .padding(t, r, b, l)
  // Mirrors CSS shorthand semantics so users can write
  //   .padding(10, 16)         // -> 10px 16px
  //   .padding(8, 12, 4)       // -> 8px 12px 4px
  //   .padding(8, 12, 4, 6)    // -> 8px 12px 4px 6px
  const args = positionalArgs(value);
  if (args.length > 0) {
    el.style.padding = args.map(toCssLength).join(" ");
  }
};

// Directional padding handlers for .paddingTop(8), .paddingBottom(8), etc.
// All routed through `toCssLength` so `rem` / `em` / `%` units survive.
export const paddingTopHandler: ApplicatorHandler = (el, value) => {
  el.style.paddingTop = toCssLength(value);
};

export const paddingBottomHandler: ApplicatorHandler = (el, value) => {
  el.style.paddingBottom = toCssLength(value);
};

export const paddingLeftHandler: ApplicatorHandler = (el, value) => {
  el.style.paddingLeft = toCssLength(value);
};

export const paddingRightHandler: ApplicatorHandler = (el, value) => {
  el.style.paddingRight = toCssLength(value);
};

export const paddingHorizontalHandler: ApplicatorHandler = (el, value) => {
  const css = toCssLength(value);
  el.style.paddingLeft = css;
  el.style.paddingRight = css;
};

export const paddingVerticalHandler: ApplicatorHandler = (el, value) => {
  const css = toCssLength(value);
  el.style.paddingTop = css;
  el.style.paddingBottom = css;
};
