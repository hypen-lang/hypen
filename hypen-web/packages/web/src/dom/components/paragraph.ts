/**
 * Paragraph Component
 */

import type { ComponentHandler } from "./index.js";

export const paragraphHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("p");
    el.dataset.hypenType = "paragraph";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Text content
    const text = props["0"] || props.text;
    if (text !== undefined) {
      el.textContent = String(text);
    }
  },
};


