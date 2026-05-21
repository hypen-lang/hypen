/**
 * Input Component
 */

import type { ComponentHandler } from "./index.js";

export const inputHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("input");
    el.dataset.hypenType = "input";
    // Reset the default user-agent chrome so `.tw("bg-gray-100 rounded-lg")`
    // on an Input reads the same as any other styled element. Without
    // this the native black 2px inset border shows through the Tailwind
    // background (the social Search bar rendered as a dark-bordered
    // rectangle instead of a pill). The author can still opt back in
    // via explicit `border-*` applicators.
    el.style.border = "none";
    el.style.outline = "none";
    el.style.background = "transparent";
    el.style.font = "inherit";
    el.style.color = "inherit";
    return el as any as HTMLElement;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const input = el as HTMLInputElement;

    if (props.type !== undefined) {
      input.type = String(props.type);
    }

    if (props.placeholder !== undefined) {
      input.placeholder = String(props.placeholder);
    }

    if (props.value !== undefined) {
      input.value = String(props.value);
    }
  },
};
