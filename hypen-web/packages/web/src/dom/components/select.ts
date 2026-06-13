/**
 * Select Component
 */

import type { ComponentHandler } from "./index.js";

export const selectHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("select");
    el.dataset.hypenType = "select";
    return el as any as HTMLElement;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const select = el as HTMLSelectElement;

    // Value property
    if (props.value !== undefined) {
      select.value = String(props.value);
    }

    // Disabled
    if (props.disabled !== undefined) {
      select.disabled = Boolean(props.disabled);
    }

    // Multiple
    if (props.multiple !== undefined) {
      select.multiple = Boolean(props.multiple);
    }

    // Options array
    if (props.options && Array.isArray(props.options)) {
      // Clear existing options
      select.innerHTML = "";
      
      // Add new options
      props.options.forEach((opt: any) => {
        const option = document.createElement("option");
        
        if (typeof opt === "string") {
          option.value = opt;
          option.textContent = opt;
        } else if (typeof opt === "object") {
          option.value = String(opt.value ?? opt.label ?? "");
          option.textContent = String(opt.label ?? opt.value ?? "");
          if (opt.disabled) option.disabled = true;
        }
        
        select.appendChild(option);
      });
    }
  },
};


