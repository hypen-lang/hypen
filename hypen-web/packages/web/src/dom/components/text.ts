/**
 * Text Component
 */

import type { ComponentHandler } from "./index.js";

/**
 * A Text is an inline-block `<span>` with `white-space: normal`, where the
 * spaces at the start / end of its content collapse away: `Row {
 * Text("Results for ") Text("@{state.query}") }` rendered "Results
 * forPizza". The author's edge spaces are content (desktop and native
 * renderers keep them), so they are written as no-break spaces, which
 * never collapse and are as wide as a space. Inner spaces still collapse
 * and wrap as before.
 */
export function preserveEdgeSpaces(text: string): string {
  if (text.length === 0) return text;
  const first = text.charCodeAt(0);
  const last = text.charCodeAt(text.length - 1);
  if (first !== 32 && last !== 32) return text;
  return text.replace(/^ +| +$/g, (run) => "\u00a0".repeat(run.length));
}

export const textHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("span");
    // Use inline-block for proper flex child behavior
    el.style.display = "inline-block";
    // Tight line-height to match iOS/Android
    el.style.lineHeight = "1";
    // Align to top to remove descender space in flex containers
    el.style.verticalAlign = "top";
    el.style.margin = "0";
    el.style.padding = "0";
    el.dataset.hypenType = "text";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Text content from first positional arg or "text" prop. `??` (not
    // `||`): falsy-but-valid values like the number 0 must still render —
    // `Text("@{state.count}")` at count 0 was showing nothing.
    const text = props["0"] ?? props.text;
    if (text !== undefined) {
      // Store the original text template for state interpolation
      el.dataset.textTemplate = String(text);
      el.textContent = preserveEdgeSpaces(String(text));
    }
  },
};
