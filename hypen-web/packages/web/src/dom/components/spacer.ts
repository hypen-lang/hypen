/**
 * Spacer Component - Flexible space in flex layouts
 */

import type { ComponentHandler } from "./index.js";

export const spacerHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("div");
    el.style.flex = "1";
    el.dataset.hypenType = "spacer";
    return el;
  },
};


