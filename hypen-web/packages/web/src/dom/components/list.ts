/**
 * List Component - Scrollable stack
 */

import type { ComponentHandler } from "./index.js";

export const listHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("div");
    el.style.display = "flex";
    el.style.flexDirection = "column"; // Default to vertical (like Android)
    // Default to flex-start to match Android/iOS behavior
    el.style.alignItems = "flex-start";
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
