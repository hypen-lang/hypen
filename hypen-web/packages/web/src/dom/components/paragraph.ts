/**
 * Paragraph Component
 */

import type { ComponentHandler } from "./index.js";

export const paragraphHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("p");
    el.dataset.hypenType = "paragraph";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Text content
    const text = props["0"] ?? props.text;
    if (text !== undefined) {
      el.textContent = String(text);
    }
  },
};


