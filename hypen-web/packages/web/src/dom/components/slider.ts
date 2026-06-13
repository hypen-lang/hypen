/**
 * Slider Component (Range Input)
 */

import type { ComponentHandler } from "./index.js";

export const sliderHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("input");
    el.type = "range";
    el.dataset.hypenType = "slider";
    return el as any as HTMLElement;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const input = el as HTMLInputElement;

    // Value
    if (props.value !== undefined) {
      input.value = String(props.value);
    }

    // Min
    if (props.min !== undefined) {
      input.min = String(props.min);
    }

    // Max
    if (props.max !== undefined) {
      input.max = String(props.max);
    }

    // Step
    if (props.step !== undefined) {
      input.step = String(props.step);
    }

    // Disabled
    if (props.disabled !== undefined) {
      input.disabled = Boolean(props.disabled);
    }
  },
};


