/**
 * Image Component
 */

import type { ComponentHandler } from "./index.js";

export const imageHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("img");
    el.dataset.hypenType = "image";
    return el as any as HTMLElement;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const img = el as HTMLImageElement;

    // Support url, src, or first positional argument.
    // Skip null/empty — initial state often has src=null before the real
    // URL arrives in a follow-up SetProp patch, and `<img src="null">`
    // would trigger a spurious GET /null and block paint.
    const src = props["0"] ?? props.url ?? props.src;
    if (src != null && src !== "") {
      img.src = String(src);
    } else if (img.src) {
      img.removeAttribute("src");
    }

    if (props.alt !== undefined) {
      img.alt = String(props.alt);
    }
  },
};
