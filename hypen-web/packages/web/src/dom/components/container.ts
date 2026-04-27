/**
 * Container/Box Component
 */

import type { ComponentHandler } from "./index.js";

export const containerHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("div");
    // Simple block container - wraps to content by default
    // Use .fillMaxWidth(true) to stretch
    el.dataset.hypenType = "container";
    return el;
  },
};
