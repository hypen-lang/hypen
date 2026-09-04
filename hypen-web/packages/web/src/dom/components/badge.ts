/**
 * Badge Component
 */

import type { ComponentHandler } from "./index.js";

export const BADGE_DEFAULTS = Object.freeze({
  backgroundColor: "#e0e0e0",
  color: "#333",
  borderRadius: "4px",
  padding: "4px 8px",
  fontSize: "12px",
  fontWeight: "600",
});

const BADGE_PADDING_PROPS = new Set([
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "paddingStart",
  "paddingEnd",
  "paddingLeading",
  "paddingTrailing",
  "paddingHorizontal",
  "paddingVertical",
]);

function hasBaseProp(props: Record<string, any>, name: string): boolean {
  return Object.keys(props).some((key) => key.split(".", 1)[0] === name);
}

export const badgeHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("span");
    el.dataset.hypenType = "badge";
    // Badges remain inline-sized, while flex layout makes the shared
    // horizontal/vertical alignment applicators effective for nested content
    // (notably fixed-size count badges).
    el.style.display = "inline-flex";
    el.style.flexDirection = "row";
    el.style.boxSizing = "border-box";
    el.style.padding = BADGE_DEFAULTS.padding;
    el.style.borderRadius = BADGE_DEFAULTS.borderRadius;
    el.style.fontSize = BADGE_DEFAULTS.fontSize;
    el.style.fontWeight = BADGE_DEFAULTS.fontWeight;
    el.style.backgroundColor = BADGE_DEFAULTS.backgroundColor;
    el.style.color = BADGE_DEFAULTS.color;
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const hasFixedBox = hasBaseProp(props, "width") && hasBaseProp(props, "height");
    const hasCustomPadding = [...BADGE_PADDING_PROPS].some((name) => hasBaseProp(props, name));
    if (hasFixedBox && !hasCustomPadding) {
      // Width/height describe the whole border box. A fixed count badge owns
      // that box and must not lose its text area to intrinsic label padding.
      el.style.padding = "0px";
    }

    // Theme
    if (props.theme !== undefined) {
      const theme = String(props.theme);
      const themeColors: Record<string, { bg: string; color: string }> = {
        success: { bg: "#4CAF50", color: "#fff" },
        error: { bg: "#f44336", color: "#fff" },
        warning: { bg: "#ff9800", color: "#fff" },
        info: { bg: "#2196F3", color: "#fff" },
        default: { bg: "#e0e0e0", color: "#333" },
      };
      const colors = themeColors[theme] || themeColors.default;
      el.style.backgroundColor = colors.bg;
      el.style.color = colors.color;
    }

    // Text content
    const text = props["0"] ?? props.text;
    if (text !== undefined) {
      el.textContent = String(text);
    }
  },
};
