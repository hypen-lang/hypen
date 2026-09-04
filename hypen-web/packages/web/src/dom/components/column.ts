/**
 * Column Component - Vertical Stack
 *
 * Children wrap to their intrinsic width on the cross-axis by default,
 * matching SwiftUI VStack and Compose Column. Width expansion is explicit:
 * use `.fillMaxWidth(true)` on a child or
 * `.horizontalAlignment("stretch")` on the Column.
 */

import type { ComponentHandler } from "./index.js";

export const columnHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.alignItems = "flex-start";
    el.dataset.hypenType = "column";
    return el;
  },
};
