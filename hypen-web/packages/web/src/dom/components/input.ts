/**
 * Input Component
 */

import { hasProp, toBool, type ComponentHandler } from "./index.js";

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

    if (hasProp(props, "placeholder")) {
      input.placeholder = props.placeholder === undefined ? "" : String(props.placeholder);
    }

    if (props.value !== undefined) {
      input.value = String(props.value);
    }

    // These reach the handler through COMPONENT_HTML_ATTRS, and that lookup
    // returns early — so anything listed there and not implemented here is
    // swallowed entirely rather than falling through to the applicator.
    // `hasProp` rather than `!== undefined`: a RemoveProp arrives as the key
    // present and undefined, and must clear the attribute, not skip it.
    if (hasProp(props, "disabled")) {
      input.disabled = toBool(props.disabled);
    }

    if (hasProp(props, "readonly")) {
      input.readOnly = toBool(props.readonly);
    }

    if (props.name !== undefined) {
      input.name = String(props.name);
    }

    if (hasProp(props, "checked")) {
      input.checked = toBool(props.checked);
    }
  },
};
