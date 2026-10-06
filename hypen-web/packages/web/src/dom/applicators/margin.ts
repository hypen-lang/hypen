/**
 * Margin Applicators
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength as toCssLengthShared } from "./size.js";
import { hasSpacingNamedKey, resolveSpacingKeys } from "./spacing-keys.js";

// See `padding.ts#toCssLength` — shared helper normalises `dp` / `sp` / `pt`
// (which CSS doesn't understand) to `px`, and passes `rem` / `em` / `%`
// through unchanged.
const toCssLength = (v: any): string => {
  if (v == null) return "";
  if (typeof v === "object" && v["0"] !== undefined) return toCssLength(v["0"]);
  return toCssLengthShared(v);
};

// Collect positional args ("0", "1", "2", "3") in order, stopping at the first gap.
const positionalArgs = (value: any): any[] => {
  const args: any[] = [];
  for (let i = 0; value[String(i)] !== undefined; i++) {
    args.push(value[String(i)]);
  }
  return args;
};

export const marginHandler: ApplicatorHandler = (el, value) => {
  if (typeof value === "number") {
    el.style.margin = `${value}px`;
    return;
  }

  if (typeof value !== "object" || value === null) {
    el.style.margin = toCssLength(value);
    return;
  }

  // Named-keys form: physical edges, the horizontal/vertical axes, and the
  // direction-aware start/end pair.
  if (hasSpacingNamedKey(value)) {
    const edges = resolveSpacingKeys(value);
    if (edges.top !== undefined) el.style.marginTop = toCssLength(edges.top);
    if (edges.bottom !== undefined) el.style.marginBottom = toCssLength(edges.bottom);
    if (edges.left !== undefined) el.style.marginLeft = toCssLength(edges.left);
    if (edges.right !== undefined) el.style.marginRight = toCssLength(edges.right);
    // Written after the physical edges so a logical key wins the cascade.
    if (edges.inlineStart !== undefined) {
      el.style.setProperty("margin-inline-start", toCssLength(edges.inlineStart));
    }
    if (edges.inlineEnd !== undefined) {
      el.style.setProperty("margin-inline-end", toCssLength(edges.inlineEnd));
    }
    return;
  }

  // Positional form mirrors CSS shorthand: .margin(v), .margin(v, h),
  // .margin(t, h, b), .margin(t, r, b, l)
  const args = positionalArgs(value);
  if (args.length > 0) {
    el.style.margin = args.map(toCssLength).join(" ");
  }
};

// Directional margin handlers for .marginTop(8), .marginBottom(8), etc.
// All routed through `toCssLength` so `rem` / `em` / `%` units survive.
export const marginTopHandler: ApplicatorHandler = (el, value) => {
  el.style.marginTop = toCssLength(value);
};

export const marginBottomHandler: ApplicatorHandler = (el, value) => {
  el.style.marginBottom = toCssLength(value);
};

export const marginLeftHandler: ApplicatorHandler = (el, value) => {
  el.style.marginLeft = toCssLength(value);
};

export const marginRightHandler: ApplicatorHandler = (el, value) => {
  el.style.marginRight = toCssLength(value);
};

export const marginHorizontalHandler: ApplicatorHandler = (el, value) => {
  const css = toCssLength(value);
  el.style.marginLeft = css;
  el.style.marginRight = css;
};

export const marginVerticalHandler: ApplicatorHandler = (el, value) => {
  const css = toCssLength(value);
  el.style.marginTop = css;
  el.style.marginBottom = css;
};
