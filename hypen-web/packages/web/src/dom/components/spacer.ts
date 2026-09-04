/**
 * Spacer Component - Flexible space in flex layouts
 */

import type { ComponentHandler } from "./index.js";

export const spacerHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.style.flex = "1";
    // Spacer is the built-in remaining-space participant. The durable marker
    // lets an otherwise-unsized Row request a finite width from its ancestors.
    el.dataset.hypenFlex = "true";
    el.dataset.hypenType = "spacer";
    return el;
  },
};

