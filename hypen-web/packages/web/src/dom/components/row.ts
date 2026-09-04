/**
 * Row Component - Horizontal Stack
 * Children keep their intrinsic size by default (matching iOS/Android behavior).
 * Use .weight(1) on children to make them expand equally.
 */

import type { ComponentHandler } from "./index.js";

export const rowHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.style.display = "flex";
    el.style.flexDirection = "row";
    // Wrap to content by default (match iOS/Android behavior)
    el.style.alignItems = "flex-start";
    el.dataset.hypenType = "row";
    return el;
  },
};
