/**
 * Link Component
 */

import type { ComponentHandler } from "./index.js";
import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.renderer;

/** Schemes a Link may navigate to. Anything else with a scheme is refused. */
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * Return `value` as a safe `href`, or `null` when it must not become one.
 *
 * Link targets often come from state (user profiles, CMS content, remote
 * sessions), so `javascript:` / `vbscript:` / `data:` / `blob:` / `file:`
 * and any other non-web scheme are refused — a `javascript:` href runs script
 * in the app's origin on click. Allowed: `http(s):`, `mailto:`, `tel:`, and
 * scheme-less references (relative paths, `/abs`, `//host`, `?q`, `#frag`).
 *
 * The scheme is read the way the URL parser reads it: leading C0 controls and
 * spaces are stripped and tab/newline are ignored anywhere, so obfuscations
 * like `" java\tscript:…"` or `"JaVaScRiPt:…"` are caught.
 */
export function sanitizeHref(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  // eslint-disable-next-line no-control-regex
  const normalized = raw.replace(/^[\u0000- ]+/, "").replace(/[\t\n\r]/g, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized);
  if (!scheme) {
    // No scheme: relative reference. A colon before any `/`, `?` or `#`
    // that did not form a valid scheme (e.g. `1javascript:`) is still
    // resolved as a path by the URL parser, so it is safe.
    return raw;
  }
  return ALLOWED_SCHEMES.has(scheme[1].toLowerCase()) ? raw : null;
}

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
