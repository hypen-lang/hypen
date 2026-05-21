/**
 * Row Component - Horizontal Stack
 * Children keep their intrinsic size by default (matching iOS/Android behavior).
 * Use .weight(1) on children to make them expand equally.
 */

import type { ComponentHandler } from "./index.js";

// Inject global styles for Row with flex/weighted children
let rowStylesInjected = false;
function ensureRowStyles(): void {
  if (rowStylesInjected) return;
  rowStylesInjected = true;

  const style = document.createElement("style");
  style.id = "hypen-row-styles";
  style.textContent = `
    /* Row expands to fill width when it has children with flex/weight */
    /* This matches iOS/Android behavior where weighted children cause parent to expand */
    [data-hypen-type="row"]:has(> [data-hypen-flex]) {
      width: 100%;
    }
  `;
  document.head.appendChild(style);
}

export const rowHandler: ComponentHandler = {
  create(): HTMLElement {
    ensureRowStyles();

    const el = document.createElement("div");
    el.style.display = "flex";
    el.style.flexDirection = "row";
    // Wrap to content by default (match iOS/Android behavior)
    el.style.alignItems = "flex-start";
    el.dataset.hypenType = "row";
    return el;
  },
};
