/**
 * Button Component
 *
 * Renders as a flex container. Children align to start by default (matching iOS).
 * Use .horizontalAlignment("center") to center content.
 * Reset default HTML button styles for cross-platform consistency.
 */

import type { ComponentHandler } from "./index.js";

export const buttonHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("button");
    // Reset default button styles for cross-platform consistency
    el.style.border = "none";
    el.style.background = "none";
    el.style.padding = "0";
    el.style.margin = "0";
    el.style.font = "inherit";
    el.style.color = "inherit";
    el.style.cursor = "pointer";
    // Make it a flex container - align to start by default (matching iOS)
    // Use .horizontalAlignment("center") to center content
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.alignItems = "flex-start";
    el.dataset.hypenType = "button";
    return el;
  },
};
