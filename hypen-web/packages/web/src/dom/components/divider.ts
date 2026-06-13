/**
 * Divider Component - Visual separator
 */

import type { ComponentHandler } from "./index.js";

export const dividerHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("hr");
    el.dataset.hypenType = "divider";
    el.style.border = "none";
    el.style.borderTop = "1px solid #e0e0e0";
    el.style.margin = "0";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Thickness
    if (props.thickness !== undefined) {
      const thickness = typeof props.thickness === "number" 
        ? `${props.thickness}px` 
        : String(props.thickness);
      el.style.borderTopWidth = thickness;
    }

    // Orientation
    if (props.orientation === "vertical") {
      el.style.borderTop = "none";
      el.style.borderLeft = "1px solid #e0e0e0";
      el.style.height = "100%";
      el.style.width = "0";
      el.style.display = "inline-block";
    }
  },
};


