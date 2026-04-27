/**
 * Heading Component - Semantic headings (h1-h6)
 */

import type { ComponentHandler } from "./index.js";

export const headingHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("h2");
    el.dataset.hypenType = "heading";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const doc = el.ownerDocument as Document;
    // Level property (1-6)
    if (props.level !== undefined) {
      const level = Math.max(1, Math.min(6, Number(props.level)));
      const newEl = doc.createElement(`h${level}`);
      newEl.dataset.hypenType = "heading";
      
      // Copy content and attributes
      newEl.innerHTML = el.innerHTML;
      Array.from(el.attributes).forEach(attr => {
        newEl.setAttribute(attr.name, attr.value);
      });
      
      // Replace the element
      if (el.parentNode) {
        el.parentNode.replaceChild(newEl, el);
      }
    }

    // Text content
    const text = props["0"] || props.text;
    if (text !== undefined) {
      el.textContent = String(text);
    }
  },
};


