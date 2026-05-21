/**
 * App Component - Root application container
 *
 * Full-screen vertical flex container. This is the default root component
 * created by `hypen init` and referenced in docs/examples.
 */

import type { ComponentHandler } from "./index.js";

export const appHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.minHeight = "100vh";
    el.style.height = "100%";
    el.style.width = "100%";
    el.dataset.hypenType = "app";
    return el;
  },
};
