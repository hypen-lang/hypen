/**
 * Link Component
 */

import type { ComponentHandler } from "./index.js";
import { frameworkLoggers } from "@hypen-space/core/logger";
import { sanitizeHref } from "../../url.js";

const log = frameworkLoggers.renderer;

export { sanitizeHref };

export const linkHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("a");
    el.dataset.hypenType = "link";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const anchor = el as HTMLAnchorElement;

    // Support href or first positional argument
    const hrefKeyPresent = "0" in props || "href" in props || "href.0" in props;
    const href = props["0"] || props.href;
    if (href !== undefined && href !== null) {
      const safe = sanitizeHref(href);
      if (safe !== null) {
        anchor.href = safe;
      } else {
        anchor.removeAttribute("href");
        log.warn(`Link: refused unsafe href "${String(href).slice(0, 64)}"`);
      }
    } else if (hrefKeyPresent) {
      // Cleared (RemoveProp): the link no longer points anywhere.
      anchor.removeAttribute("href");
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
