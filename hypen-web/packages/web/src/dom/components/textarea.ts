/**
 * Textarea Component
 */

import type { ComponentHandler } from "./index.js";

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
    if (props.placeholder !== undefined) {
      textarea.placeholder = String(props.placeholder);
    }

    // Rows
    if (props.rows !== undefined) {
      textarea.rows = Number(props.rows);
    }

    // Cols
    if (props.cols !== undefined) {
      textarea.cols = Number(props.cols);
    }

    // Disabled
    if (props.disabled !== undefined) {
      textarea.disabled = Boolean(props.disabled);
    }

    // Readonly
    if (props.readonly !== undefined) {
      textarea.readOnly = Boolean(props.readonly);
    }
  },
};


