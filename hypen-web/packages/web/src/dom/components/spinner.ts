/**
 * Spinner Component (Loading Indicator)
 */

import type { ComponentHandler } from "./index.js";

const STYLE_ID = "hypen-spinner-styles";

/**
 * Inject the shared spin keyframes once (same singleton pattern as
 * ensureA11yStyles). Safe to call repeatedly and in non-DOM environments.
 */
function ensureSpinnerStyles(): void {
  if (typeof document === "undefined" || !document.head) {
    return;
  }

  if (typeof document.getElementById === "function" && document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes hypen-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

export const spinnerHandler: ComponentHandler = {
  create(): HTMLElement {
    ensureSpinnerStyles();

    const wrapper = document.createElement("div");
    wrapper.dataset.hypenType = "spinner";
    wrapper.style.display = "inline-block";
    wrapper.style.width = "40px";
    wrapper.style.height = "40px";

    const spinner = document.createElement("div");
    spinner.style.width = "100%";
    spinner.style.height = "100%";
    spinner.style.boxSizing = "border-box";
    spinner.style.border = "4px solid #f3f3f3";
    spinner.style.borderTop = "4px solid #3b82f6";
    spinner.style.borderRadius = "50%";
    spinner.style.animation = "hypen-spin 1s linear infinite";

    wrapper.appendChild(spinner);

    return wrapper;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const spinner = el.querySelector("div:not(style)") as HTMLElement;
    if (!spinner) return;

    // Size
    if (props.size !== undefined) {
      const size = String(props.size);
      const sizeMap: Record<string, string> = {
        small: "24px",
        medium: "40px",
        large: "60px",
      };
      const actualSize = sizeMap[size] || size;
      el.style.width = actualSize;
      el.style.height = actualSize;
    }

    // Color
    if (props.color !== undefined) {
      spinner.style.borderTopColor = String(props.color);
    }

    if (props.animated === false || props["animated.0"] === false) {
      spinner.style.animation = "none";
      spinner.style.transform = "rotate(0deg)";
    } else {
      spinner.style.animation = "hypen-spin 1s linear infinite";
      spinner.style.transform = "";
    }
  },
};
