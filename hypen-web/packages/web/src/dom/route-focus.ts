/**
 * Route-change focus management.
 *
 * When the Router swaps routes, keyboard and screen-reader focus is left on
 * an element that just left the document — the user is stranded and AT
 * announces nothing. This module defines the focus contract for navigation
 * (design Open Question #4) and the DOM renderer applies it after each patch
 * batch:
 *
 * 1. A batch is a **navigation** when it contains at least one `detach` (the
 *    leaving route, unlinked but kept alive by the Router cache) and at least
 *    one incoming subtree root (an `attach` of a cached route, or a fresh
 *    `create`+`insert` route build).
 * 2. On navigation, focus moves to — in order of preference:
 *    a. the element that held focus when the incoming subtree was detached
 *       (**focus restore** on cached re-entry), if it is still inside the
 *       subtree;
 *    b. the subtree's first heading (`h1`–`h6` / `role="heading"`) or `main`
 *       landmark — the "start of the new page" for AT users;
 *    c. the subtree root itself.
 *    Non-natively-focusable targets get `tabindex="-1"` (programmatic focus
 *    only — they do not join the Tab order).
 * 3. Focus-restore memory is keyed by the detached subtree's root NodeId and
 *    is dropped the moment a `remove` arrives for that id (Router LRU
 *    eviction) — **focus restore never targets an evicted NodeId**, the
 *    invariant this contract exists to guarantee.
 *
 * The contract is opt-out: `DOMRendererOptions.routeFocus: "off"` disables it
 * for apps that own focus management themselves.
 */

/** Tags that are natively focusable without a tabindex. */
const NATIVELY_FOCUSABLE = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"]);

/** Heading hosts (`<h1>`–`<h6>`). */
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

type ElementLike = {
  tagName?: string;
  children?: ArrayLike<unknown>;
  getAttribute?(name: string): string | null;
};

const matches = (el: ElementLike, pred: (el: ElementLike) => boolean): boolean => {
  try {
    return pred(el);
  } catch {
    return false;
  }
};

const isHeading = (el: ElementLike): boolean =>
  HEADING_TAGS.has(el.tagName?.toUpperCase() ?? "") ||
  el.getAttribute?.("role") === "heading";

const isMain = (el: ElementLike): boolean =>
  el.tagName?.toUpperCase() === "MAIN" || el.getAttribute?.("role") === "main";

/**
 * Depth-first search over `children` (works on both real DOM collections and
 * test-double arrays) for the first element matching `pred`.
 */
function findFirst(root: ElementLike, pred: (el: ElementLike) => boolean): ElementLike | null {
  const children = Array.from((root.children ?? []) as ArrayLike<ElementLike>);
  for (const child of children) {
    if (matches(child, pred)) return child;
    const nested = findFirst(child, pred);
    if (nested) return nested;
  }
  return null;
}

/**
 * Pick the element that should receive focus inside a freshly-shown route
 * subtree: first heading, else first `main` landmark, else the root itself.
 */
export function findRouteFocusTarget(root: HTMLElement): HTMLElement {
  const heading = findFirst(root as ElementLike, isHeading);
  if (heading) return heading as HTMLElement;
  const main = findFirst(root as ElementLike, isMain);
  if (main) return main as HTMLElement;
  return root;
}

/**
 * Move focus to `target`, granting it programmatic focusability
 * (`tabindex="-1"`) when it is neither natively focusable nor already
 * carrying a tabindex. `-1` keeps it out of the Tab order — this is a
 * navigation landing point, not a new tab stop.
 */
export function focusRouteTarget(target: HTMLElement): void {
  const tag = target.tagName?.toUpperCase() ?? "";
  const hasTabindex = target.getAttribute?.("tabindex") != null;
  if (!NATIVELY_FOCUSABLE.has(tag) && !hasTabindex) {
    target.setAttribute?.("tabindex", "-1");
  }
  target.focus?.();
}
