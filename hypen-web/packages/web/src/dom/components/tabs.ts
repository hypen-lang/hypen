/**
 * Composite-widget hosts: Tabs / Tab / TabPanel / Option.
 *
 * These exist so the composite element types render *focusable, styleable*
 * hosts instead of falling through to the unknown-component fallback (a
 * `display: contents` div, which cannot reliably hold keyboard focus). The
 * accessibility roles come from the engine-derived Semantics block
 * (tablist/tab/tabpanel/option), not from these handlers; keyboard roving is
 * wired by the renderer when it sees `role="tablist"` (see operability.ts).
 */

import type { ComponentHandler } from "./index.js";

/** Tabs → a plain row container; role="tablist" arrives via semantics. */
export const tabsHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.dataset.hypenType = "tabs";
    el.style.display = "flex";
    el.style.flexDirection = "row";
    return el;
  },
};

/**
 * Tab → a native `<button>` so focus and Enter/Space activation come free;
 * the engine's `role="tab"` overrides the implicit button role (see the
 * IMPLICIT_ROLE override logic in semantics.ts).
 */
export const tabHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("button");
    el.setAttribute("type", "button");
    el.dataset.hypenType = "tab";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const text = props["0"] ?? props.text;
    if (text !== undefined) {
      el.dataset.textTemplate = String(text);
      el.textContent = String(text);
    }
  },
};

/**
 * TabPanel → a focusable region (`tabindex=0`) so a Tab keypress from the
 * tablist lands inside the panel even when it has no focusable content
 * (WAI-ARIA APG recommendation).
 */
export const tabPanelHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.dataset.hypenType = "tabpanel";
    el.tabIndex = 0;
    return el;
  },
};

/** Option → a plain div host; role="option" arrives via semantics. */
export const optionHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.dataset.hypenType = "option";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const text = props["0"] ?? props.text;
    if (text !== undefined) {
      el.dataset.textTemplate = String(text);
      el.textContent = String(text);
    }
  },
};
