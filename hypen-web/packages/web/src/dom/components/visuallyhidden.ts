/**
 * VisuallyHidden Component
 *
 * Renders content that is invisible on screen but remains in the accessibility
 * tree for screen readers — the standard "sr-only" pattern. Useful for giving
 * an icon-only control readable text, announcing context, etc.
 */

import type { ComponentHandler } from "./index.js";

export const visuallyHiddenHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("span");
    el.dataset.hypenType = "visuallyhidden";

    // Standard visually-hidden (sr-only) styles: removed from the visual
    // layout but still read by assistive technology.
    el.style.position = "absolute";
    el.style.width = "1px";
    el.style.height = "1px";
    el.style.padding = "0";
    el.style.margin = "-1px";
    el.style.overflow = "hidden";
    el.style.clip = "rect(0, 0, 0, 0)";
    el.style.whiteSpace = "nowrap";
    el.style.border = "0";

    return el;
  },
};
