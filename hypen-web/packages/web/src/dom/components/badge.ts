/**
 * Badge Component
 */

import type { ComponentHandler } from "./index.js";

export const badgeHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("span");
    el.dataset.hypenType = "badge";
    el.style.display = "inline-block";
    el.style.padding = "4px 8px";
    el.style.borderRadius = "4px";
    el.style.fontSize = "12px";
    el.style.fontWeight = "600";
    el.style.backgroundColor = "#e0e0e0";
    el.style.color = "#333";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
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
    const text = props["0"] || props.text;
    if (text !== undefined) {
      el.textContent = String(text);
    }
  },
};


