/**
 * Checkbox Component
 */

import type { ComponentHandler } from "./index.js";

export const checkboxHandler: ComponentHandler = {
  create(): HTMLElement {
    const wrapper = document.createElement("label");
    wrapper.dataset.hypenType = "checkbox";
    wrapper.style.display = "inline-flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "8px";
    wrapper.style.cursor = "pointer";
    wrapper.style.minHeight = "20px";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.hypenCheckbox = "true";
    // Normalize the visual and layout footprint instead of inheriting each
    // browser's smaller checkbox size and default margins.
    input.style.width = "20px";
    input.style.height = "20px";
    input.style.margin = "0";
    input.style.flexShrink = "0";
    input.style.accentColor = "#3b82f6";
    
    wrapper.appendChild(input);
    
    return wrapper;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
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
      el.appendChild(document.createTextNode(String(label)));
    }
  },
};

