/**
 * Spinner Component (Loading Indicator)
 */

import type { ComponentHandler } from "./index.js";

export const spinnerHandler: ComponentHandler = {
  create(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.dataset.hypenType = "spinner";
    wrapper.style.display = "inline-block";

    const spinner = document.createElement("div");
    spinner.style.width = "40px";
    spinner.style.height = "40px";
    spinner.style.border = "4px solid #f3f3f3";
    spinner.style.borderTop = "4px solid #3498db";
    spinner.style.borderRadius = "50%";
    spinner.style.animation = "spin 1s linear infinite";

    // Add keyframe animation
    const style = document.createElement("style");
    style.textContent = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
    
    wrapper.appendChild(style);
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
      spinner.style.width = actualSize;
      spinner.style.height = actualSize;
    }

    // Color
    if (props.color !== undefined) {
      spinner.style.borderTopColor = String(props.color);
    }
  },
};


