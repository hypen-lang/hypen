/**
 * Grid Component - CSS Grid Layout
 *
 * Grid items stretch to fill their cells by default (matching Android/iOS behavior).
 */

import type { ComponentHandler } from "./index.js";
import { trackCount } from "../../grid-tracks.js";

// Inject global styles for grid children
let gridStylesInjected = false;
function ensureGridStyles(): void {
  if (gridStylesInjected) return;
  gridStylesInjected = true;

  const style = document.createElement("style");
  style.id = "hypen-grid-styles";
  style.textContent = `
    /* Grid children stretch to fill cells by default (matches Android behavior) */
    [data-hypen-type="grid"] > * {
      justify-self: stretch;
      align-self: stretch;
    }
  `;
  document.head.appendChild(style);
}

export const gridHandler: ComponentHandler = {
  create(): HTMLElement {
    ensureGridStyles();

    const el = document.createElement("div");
    el.style.display = "grid";
    el.style.gap = "0px";
    el.dataset.hypenType = "grid";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Columns: a count only (see grid-tracks.ts).
    const columns = trackCount(props.columns);
    if (columns !== null) el.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;

    // Gap
    if (props.gap !== undefined) {
      const gap = typeof props.gap === "number" ? `${props.gap}px` : String(props.gap);
      el.style.gap = gap;
    }
  },
};

