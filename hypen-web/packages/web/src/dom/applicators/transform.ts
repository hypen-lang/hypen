/**
 * Transform Applicators
 *
 * Every function applicator (`translateX`, `rotate`, `scale`, …) composes
 * into the single CSS `transform` property. Each one REPLACES its own
 * previous function in the list (keeping the others and their order) —
 * appending instead meant a reactive `.scale("@{hovered ? 1.07 : 1}")`
 * accumulated `scale(1) scale(1.07) scale(1)` and the product never
 * returned to 1, so a hovered icon stayed scaled after the pointer left.
 */

import type { ApplicatorHandler } from "./types.js";
import { toCssLength } from "./size.js";
import { setCssFunction } from "./css-functions.js";

/**
 * Set `fn(arg)` on the element's transform, replacing an existing `fn(...)`
 * in place or appending when absent; `undefined` (RemoveProp) drops it.
 * Thin wrapper over the shared list helper the filter applicators use too.
 */
export function setTransformFunction(
  el: HTMLElement,
  fn: string,
  arg: string | undefined,
): void {
  setCssFunction(el, "transform", fn, arg);
}

const lengthFn = (fn: string): ApplicatorHandler => (el, value) =>
  setTransformFunction(el, fn, value === undefined ? undefined : toCssLength(value ?? 0));
const rawFn = (fn: string): ApplicatorHandler => (el, value) =>
  setTransformFunction(el, fn, value === undefined ? undefined : String(value));

export const transformHandlers: Record<string, ApplicatorHandler> = {
  transform: (el, value) => {
    el.style.transform = String(value);
  },

  transformOrigin: (el, value) => {
    el.style.transformOrigin = String(value);
  },

  translateX: lengthFn("translateX"),
  translateY: lengthFn("translateY"),
  translateZ: lengthFn("translateZ"),

  rotate: rawFn("rotate"),
  rotateX: rawFn("rotateX"),
  rotateY: rawFn("rotateY"),
  rotateZ: rawFn("rotateZ"),

  scale: rawFn("scale"),
  scaleX: rawFn("scaleX"),
  scaleY: rawFn("scaleY"),

  skew: rawFn("skew"),
  skewX: rawFn("skewX"),
  skewY: rawFn("skewY"),

  perspective: (el, value) => {
    el.style.perspective = toCssLength(value);
  },
};
