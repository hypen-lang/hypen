/**
 * Link Component
 */

import type { ComponentHandler } from "./index.js";

export const linkHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("a");
    el.dataset.hypenType = "link";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const anchor = el as HTMLAnchorElement;

    // Support href or first positional argument
    const href = props["0"] || props.href;
    if (href !== undefined) {
      anchor.href = String(href);
    }

    // Target property
    if (props.target !== undefined) {
      anchor.target = String(props.target);
    }

    // Rel property
    if (props.rel !== undefined) {
      anchor.rel = String(props.rel);
    }
  },
};


