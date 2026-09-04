/**
 * List Component - Scrollable stack
 */

import type { ComponentHandler } from "./index.js";

export const listHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.style.display = "flex";
    el.style.flexDirection = "column"; // Default to vertical (like Android)
    // List tracks span their finite cross axis. Explicit child widths still
    // win over flex-item stretch, while ordinary styled rows fill the list.
    el.style.alignItems = "stretch";
    el.style.overflow = "auto";
    el.dataset.hypenType = "list";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Direction: vertical or horizontal
    const direction = props.direction || props["1"] || "vertical";
    if (direction === "vertical") {
      el.style.flexDirection = "column";
    } else {
      el.style.flexDirection = "row";
    }

    // Gap between items
    if (props.gap !== undefined) {
      el.style.gap = typeof props.gap === "number" ? `${props.gap}px` : String(props.gap);
    }
  },
};
