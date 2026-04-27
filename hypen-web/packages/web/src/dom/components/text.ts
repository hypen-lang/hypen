/**
 * Text Component
 */

import type { ComponentHandler } from "./index.js";

export const textHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("span");
    // Use inline-block for proper flex child behavior
    el.style.display = "inline-block";
    // Tight line-height to match iOS/Android
    el.style.lineHeight = "1";
    // Align to top to remove descender space in flex containers
    el.style.verticalAlign = "top";
    el.style.margin = "0";
    el.style.padding = "0";
    el.dataset.hypenType = "text";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Text content from first positional arg or "text" prop
    const text = props["0"] || props.text;
    if (text !== undefined) {
      // Store the original text template for state interpolation
      el.dataset.textTemplate = String(text);
      el.textContent = String(text);
    }
  },
};
