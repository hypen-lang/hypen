/**
 * Avatar Component
 */

import type { ComponentHandler } from "./index.js";

export const avatarHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("div");
    el.dataset.hypenType = "avatar";
    el.style.display = "inline-flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.width = "40px";
    el.style.height = "40px";
    el.style.borderRadius = "50%";
    el.style.backgroundColor = "#9e9e9e";
    el.style.color = "#fff";
    el.style.fontSize = "16px";
    el.style.fontWeight = "600";
    el.style.overflow = "hidden";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const doc = el.ownerDocument as Document;
    // Image source - support named arg with .0 suffix, positional arg, or plain name
    const src = props["src.0"] || props["0"] || props.src || props.source;
    if (src !== undefined) {
      const img = doc.createElement("img");
      img.src = String(src);
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      el.innerHTML = "";
      el.appendChild(img);
    } else if (props.initials !== undefined) {
      // Show initials
      el.textContent = String(props.initials).toUpperCase();
    }

    // Size
    if (props.size !== undefined) {
      const size = typeof props.size === "number" ? `${props.size}px` : String(props.size);
      el.style.width = size;
      el.style.height = size;
    }
  },
};


