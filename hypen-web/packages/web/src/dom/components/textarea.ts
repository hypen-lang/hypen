/**
 * Textarea Component
 */

import { hasProp, toBool, type ComponentHandler } from "./index.js";

export const textareaHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("textarea");
    el.dataset.hypenType = "textarea";
    // Same user-agent reset as Input — otherwise `.tw(...)` styling draws
    // over a native dark border and inset shadow.
    el.style.border = "none";
    el.style.outline = "none";
    el.style.background = "transparent";
    el.style.font = "inherit";
    el.style.color = "inherit";
    el.style.resize = "none";
    return el as HTMLElement;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const textarea = el as HTMLTextAreaElement;

    // Value property - check named prop first, then positional (consistent with Input)
    const value = props.value ?? props["0"];
    if (value !== undefined) {
      textarea.value = String(value);
    }

    // Placeholder
    if (hasProp(props, "placeholder")) {
      textarea.placeholder = props.placeholder === undefined ? "" : String(props.placeholder);
    }

    // Rows
    if (props.rows !== undefined) {
      textarea.rows = Number(props.rows);
    }

    // Cols
    if (props.cols !== undefined) {
      textarea.cols = Number(props.cols);
    }

    // Disabled. `hasProp` rather than `!== undefined`: a RemoveProp arrives as
    // the key present and undefined, and must clear the attribute.
    if (hasProp(props, "disabled")) {
      textarea.disabled = toBool(props.disabled);
    }

    // Readonly
    if (hasProp(props, "readonly")) {
      textarea.readOnly = toBool(props.readonly);
    }

    // Listed in COMPONENT_HTML_ATTRS, so it never falls through to the
    // applicator — it has to be honoured here or not at all.
    if (props.name !== undefined) {
      textarea.name = String(props.name);
    }
  },
};


