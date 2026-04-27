/**
 * Center Component - Centers content
 *
 * Center expands to fill available space by default (matching iOS/Android behavior).
 * This is because a Center that wraps to content can't meaningfully center anything.
 * The expansion is constrained by parent's layout rules.
 */

import type { ComponentHandler } from "./index.js";

export const centerHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("div");
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    // Center expands to fill available space by default
    // This matches iOS which has .frame(maxWidth: .infinity, maxHeight: .infinity)
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.alignSelf = "stretch"; // Needed for flex containers with alignItems: flex-start
    el.dataset.hypenType = "center";
    return el;
  },
};
