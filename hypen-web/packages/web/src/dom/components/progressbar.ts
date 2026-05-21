/**
 * ProgressBar Component
 */

import type { ComponentHandler } from "./index.js";

export const progressBarHandler: ComponentHandler = {
  create(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.dataset.hypenType = "progressbar";
    wrapper.style.width = "100%";
    wrapper.style.height = "8px";
    wrapper.style.backgroundColor = "#e0e0e0";
    wrapper.style.borderRadius = "4px";
    wrapper.style.overflow = "hidden";

    const bar = document.createElement("div");
    bar.dataset.hypenBar = "true";
    bar.style.height = "100%";
    bar.style.backgroundColor = "#2196F3";
    bar.style.transition = "width 0.3s ease";
    bar.style.width = "0%";

    wrapper.appendChild(bar);
    return wrapper;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const bar = el.querySelector('[data-hypen-bar="true"]') as HTMLElement;
    if (!bar) return;

    // Value and max
    const value = Number(props.value || 0);
    const max = Number(props.max || 100);
    const percentage = Math.min(100, Math.max(0, (value / max) * 100));
    bar.style.width = `${percentage}%`;

    // Color
    if (props.color !== undefined) {
      bar.style.backgroundColor = String(props.color);
    }

    // Height
    if (props.height !== undefined) {
      const height = typeof props.height === "number" ? `${props.height}px` : String(props.height);
      el.style.height = height;
    }
  },
};


