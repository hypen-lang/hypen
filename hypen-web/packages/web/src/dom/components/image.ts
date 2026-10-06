/**
 * Image Component
 */

import type { ComponentHandler } from "./index.js";

/** Resolve child-app relative media against the child server, not its host page. */
export function resolveImageSource(src: unknown, assetBaseUrl?: string): string {
  const value = String(src);
  if (!assetBaseUrl) return value;
  try {
    return new URL(value, assetBaseUrl).href;
  } catch {
    return value;
  }
}

export function createImageHandler(assetBaseUrl?: string): ComponentHandler {
  return {
    create(): HTMLElement {
      const el = document.createElement("img");
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
        img.src = resolveImageSource(src, assetBaseUrl);
      } else if (img.src) {
        img.removeAttribute("src");
      }

      if (props.alt !== undefined) {
        img.alt = String(props.alt);
      }
    },
  };
}

export const imageHandler: ComponentHandler = createImageHandler();
