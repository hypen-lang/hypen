/**
 * Router Component - Container for routes
 */

import type { ComponentHandler } from "./index.js";

export const routerHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.width = "100%";
    el.dataset.hypenType = "router";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Router doesn't need special prop handling
    // The routing logic is handled by the Router module
  },
};

