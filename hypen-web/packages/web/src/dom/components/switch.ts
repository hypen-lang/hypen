/**
 * Switch Component (Toggle)
 */

import { hasProp, toBool, type ComponentHandler } from "./index.js";

export const switchHandler: ComponentHandler = {
  create(): HTMLElement {
    const wrapper = document.createElement("label");
    wrapper.dataset.hypenType = "switch";
    wrapper.style.display = "inline-flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "8px";
    wrapper.style.cursor = "pointer";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.hypenSwitch = "true";

    // Style the switch
    input.style.appearance = "none";
    input.style.width = "44px";
    input.style.height = "24px";
    input.style.borderRadius = "12px";
    input.style.position = "relative";
    input.style.cursor = "pointer";
    input.style.transition = "background-color 0.2s";

    // Add pseudo-element styling via CSS
    const style = document.createElement("style");
    style.textContent = `
      input[data-hypen-switch="true"] {
        background-color: #ccc;
      }
      input[data-hypen-switch="true"]::before {
        content: "";
        position: absolute;
        width: 20px;
        height: 20px;
        background-color: white;
        border-radius: 50%;
        top: 2px;
        left: 2px;
        transition: transform 0.2s;
      }
      input[data-hypen-switch="true"]:checked {
        background-color: #4CAF50;
      }
      input[data-hypen-switch="true"]:checked::before {
        transform: translateX(20px);
      }
    `;
    wrapper.appendChild(style);
    wrapper.appendChild(input);

    return wrapper;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Match on the marker `create` stamps rather than on the tag+type pair:
    // it is the same element, and it survives the `cloneNode` template path.
    const input = el.querySelector('[data-hypen-switch="true"]') as HTMLInputElement;
    if (!input) return;

    // On state (checked). Any of the three spellings being *mentioned* is a
    // write, so removing the one in play resets the toggle instead of
    // leaving it stuck on.
    if (hasProp(props, "checked") || hasProp(props, "on") || hasProp(props, "value")) {
      input.checked = toBool(props.checked ?? props.on ?? props.value);
    }

    // Disabled
    if (hasProp(props, "disabled")) {
      input.disabled = toBool(props.disabled);
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
