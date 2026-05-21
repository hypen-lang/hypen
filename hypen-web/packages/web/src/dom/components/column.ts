/**
 * Column Component - Vertical Stack
 *
 * Children stretch to the Column's cross-axis (width) by default — matches
 * Tailwind / CSS authors' expectations (`mx-4` on a button leaves 16px
 * gaps on each side, not a content-hugging pill). Override per-child with
 * `.alignSelf("flex-start")` or `.horizontalAlignment(...)`.
 *
 * This was `flex-start` originally to mirror iOS/Android "wrap to content"
 * defaults, but that made every `.tw("mx-4")`-padded child (e.g. the
 * social Edit Profile button) render at its content width and look wrong
 * against the native renderers — which DO stretch because SwiftUI /
 * Compose treat horizontal margin-only as a "pad the edges of a wide
 * element" intent.
 */

import type { ComponentHandler } from "./index.js";

export const columnHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.alignItems = "stretch";
    el.dataset.hypenType = "column";
    return el;
  },
};
