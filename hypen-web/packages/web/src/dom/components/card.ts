/**
 * Card Component - Container with default styling
 */

import type { ComponentHandler } from "./index.js";

export const cardHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.dataset.hypenType = "card";
    el.style.backgroundColor = "#ffffff";
    el.style.borderRadius = "8px";
    el.style.boxShadow = "0 2px 4px rgba(0, 0, 0, 0.1)";
    el.style.padding = "16px";
    return el;
  },
};


