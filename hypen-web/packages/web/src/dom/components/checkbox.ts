/**
 * Checkbox Component
 */

import type { ComponentHandler } from "./index.js";

export const checkboxHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const wrapper = doc.createElement("label");
    wrapper.dataset.hypenType = "checkbox";
    wrapper.style.display = "inline-flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "8px";
    wrapper.style.cursor = "pointer";

    const input = doc.createElement("input");
    input.type = "checkbox";
    input.dataset.hypenCheckbox = "true";
    
    wrapper.appendChild(input);
    
    return wrapper;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const doc = el.ownerDocument as Document;
    const input = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (!input) return;

    // Checked state
    if (props.checked !== undefined) {
      input.checked = Boolean(props.checked);
    }

    // Disabled
    if (props.disabled !== undefined) {
      input.disabled = Boolean(props.disabled);
    }

    // Label text
    const label = props["0"] || props.label;
    if (label !== undefined) {
      // Remove existing text node if any
      const textNodes = Array.from(el.childNodes).filter(
        node => node.nodeType === Node.TEXT_NODE
      );
      textNodes.forEach(node => node.remove());
      
      // Add new label text
      el.appendChild(doc.createTextNode(String(label)));
    }
  },
};


