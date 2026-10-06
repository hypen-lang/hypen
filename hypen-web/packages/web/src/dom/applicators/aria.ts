/**
 * ARIA escape hatch applicator
 *
 * `.aria(key, value)` sets an arbitrary `aria-<key>` attribute on the element,
 * e.g. `.aria("expanded", "true")` -> `aria-expanded="true"`.
 *
 * WEB-ONLY / NON-PORTABLE: this is a raw DOM escape hatch. It bypasses the
 * engine-derived typed `Semantics` block, so the value does NOT reach the
 * Canvas, iOS or Android renderers. Prefer the portable accessibility
 * applicators (e.g. `.role()`, `.label()`) when one exists; reach for `.aria`
 * only for DOM-specific ARIA attributes the typed semantics do not cover.
 */

import type { ApplicatorHandler } from "./types.js";

/**
 * The grouped args arrive as `{ "0": key, "1": value }` for `.aria(key, value)`.
 * A single positional arg (`.aria("busy")`) arrives as the bare key string.
 */
export const ariaHandler: ApplicatorHandler = (el, value) => {
  let key: unknown;
  let attrValue: unknown = "";

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const args = value as Record<string, unknown>;
    key = args["0"];
    attrValue = "1" in args ? args["1"] : "";
  } else {
    key = value;
  }

  if (key === undefined || key === null || key === "") {
    return;
  }

  el.setAttribute("aria-" + String(key), String(attrValue));
};

export const ariaHandlers: Record<string, ApplicatorHandler> = {
  aria: ariaHandler,
};
