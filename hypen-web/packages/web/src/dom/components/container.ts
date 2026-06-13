/**
 * Container/Box Component
 */

import type { ComponentHandler } from "./index.js";

export const containerHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    // Simple block container - wraps to content by default
    // Use .fillMaxWidth(true) to stretch
    el.dataset.hypenType = "container";
    return el;
  },
};
