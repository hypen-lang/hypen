/**
 * Select Component
 */

import { hasProp, toBool, type ComponentHandler } from "./index.js";

export const selectHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("select");
    el.dataset.hypenType = "select";
    return el as any as HTMLElement;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const select = el as HTMLSelectElement;

    // Disabled
    if (hasProp(props, "disabled")) {
      select.disabled = toBool(props.disabled);
    }

    // Multiple
    if (hasProp(props, "multiple")) {
      select.multiple = toBool(props.multiple);
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

    // Value AFTER options: rebuilding the option list resets the selection,
    // so a merged prop set (SetProp on `options`) would otherwise lose it.
    if (props.value !== undefined) {
      select.value = String(props.value);
    }
  },
};


