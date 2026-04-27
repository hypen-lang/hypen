/**
 * Stack Component - Overlaying elements with absolute positioning
 */

import type { ComponentHandler } from "./index.js";

// Inject global styles once per document
const injectedDocs = new WeakSet<Document>();
function ensureStackStyles(doc: Document): void {
  if (injectedDocs.has(doc)) return;
  injectedDocs.add(doc);

  const style = doc.createElement("style");
  style.id = "hypen-stack-styles";
  style.textContent = `
    [data-hypen-type="stack"] {
      position: relative;
      display: grid;
      grid-template-areas: "stack";
      /* Default alignment: top-left (matching iOS/Android ZStack default) */
      justify-items: start;
      align-items: start;
      /* Ensure Stack participates properly in flex layouts (Row/Column) */
      min-width: 0;
      min-height: 0;
    }
    [data-hypen-type="stack"] > * {
      grid-area: stack;
      /* Don't set justify-self/align-self here - let parent's justify-items/align-items control */
    }
  `;
  doc.head.appendChild(style);
}

export const stackHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    ensureStackStyles(doc);

    const el = doc.createElement("div");
    el.dataset.hypenType = "stack";

    return el;
  },
};


