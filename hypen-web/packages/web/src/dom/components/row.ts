/**
 * Row Component - Horizontal Stack
 * Children keep their intrinsic size by default (matching iOS/Android behavior).
 * Use .weight(1) on children to make them expand equally.
 */

import type { ComponentHandler } from "./index.js";

// Inject global styles for Row with flex/weighted children (per-document)
const injectedDocs = new WeakSet<Document>();
function ensureRowStyles(doc: Document): void {
  if (injectedDocs.has(doc)) return;
  injectedDocs.add(doc);

  const style = doc.createElement("style");
  style.id = "hypen-row-styles";
  style.textContent = `
    /* Row expands to fill width when it has children with flex/weight */
    /* This matches iOS/Android behavior where weighted children cause parent to expand */
    [data-hypen-type="row"]:has(> [data-hypen-flex]) {
      width: 100%;
    }
  `;
  doc.head.appendChild(style);
}

export const rowHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    ensureRowStyles(doc);

    const el = doc.createElement("div");
    el.style.display = "flex";
    el.style.flexDirection = "row";
    // Wrap to content by default (match iOS/Android behavior)
    el.style.alignItems = "flex-start";
    el.dataset.hypenType = "row";
    return el;
  },
};
