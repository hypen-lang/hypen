/**
 * Keyboard operability for actionable elements.
 *
 * Native interactive elements (`<button>`, `<a href>`) are keyboard-operable
 * for free — the browser activates them on Enter/Space. But Hypen's actionable
 * `Card` renders a plain `<div>`, which is neither focusable nor
 * keyboard-activatable. This module closes that gap: a non-native actionable
 * host is given a `button` role, made focusable (`tabindex=0`), and wired so
 * Enter/Space dispatch the same action as a click.
 *
 * This is intentionally client-side: focus and key handling are synchronous
 * interactions the streaming engine cannot mediate.
 */

import { triggerElementAction } from "./applicators/events.js";
import { focusRouteTarget } from "./route-focus.js";

/** Host tags that the browser already makes keyboard-operable. */
const NATIVE_INTERACTIVE = new Set(["BUTTON", "A"]);

/**
 * Make a non-native actionable element keyboard-operable. Idempotent across
 * re-renders (guarded by a dataset flag). No-op for native interactive tags.
 */
export function makeKeyboardActivatable(element: HTMLElement, actionValue: unknown): void {
  const tag = element.tagName?.toUpperCase();
  if (tag && NATIVE_INTERACTIVE.has(tag)) return;

  // Wire the keydown listener only once.
  if (element.dataset?.hypenKbd) return;
  if (element.dataset) element.dataset.hypenKbd = "1";

  // Announce as a button, make it reachable, and activate on Enter/Space.
  element.setAttribute("role", "button");
  element.tabIndex = 0;

  element.addEventListener("keydown", (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter" || key === " " || key === "Spacebar") {
      // Space would otherwise scroll the page.
      event.preventDefault?.();
      triggerElementAction(element, actionValue);
    }
  });
}

/** CSS selector for the elements that can hold keyboard focus. */
const FOCUSABLE_SELECTOR = "a,button,input,textarea,select,[tabindex]";

/**
 * Pick the focus target for a Tab keypress within a trapped container, wrapping
 * at the ends.
 *
 * Pure over the ordered list of focusable descendants so it is testable without
 * a real DOM: given the currently-focused element (`active`) and the Shift
 * state, returns the element that should receive focus next, or `null` when
 * there is nothing to focus. Tab past the last element wraps to the first;
 * Shift+Tab past the first wraps to the last. When focus is outside the set,
 * Tab lands on the first element and Shift+Tab on the last.
 */
export function nextTrapFocus<T>(focusable: T[], active: T | null, shift: boolean): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const index = active == null ? -1 : focusable.indexOf(active);

  if (index === -1) return shift ? last : first;
  if (shift) return index === 0 ? last : focusable[index - 1]!;
  return index === focusable.length - 1 ? first : focusable[index + 1]!;
}

/**
 * Pick the tab that should receive focus for a keypress inside a roving
 * tablist (WAI-ARIA APG "Tabs" keyboard contract). Pure over the ordered tab
 * list so it is testable without a real DOM: Arrow Right/Down move to the
 * next tab (wrapping), Arrow Left/Up to the previous (wrapping), Home/End to
 * the first/last. Any other key — or an empty list — returns `null` (leave
 * focus alone).
 */
export function nextRovingFocus<T>(tabs: T[], active: T | null, key: string): T | null {
  if (tabs.length === 0) return null;
  const first = tabs[0]!;
  const last = tabs[tabs.length - 1]!;
  if (key === "Home") return first;
  if (key === "End") return last;

  const forward = key === "ArrowRight" || key === "ArrowDown";
  const backward = key === "ArrowLeft" || key === "ArrowUp";
  if (!forward && !backward) return null;

  const index = active == null ? -1 : tabs.indexOf(active);
  if (index === -1) return first;
  if (forward) return index === tabs.length - 1 ? first : tabs[index + 1]!;
  return index === 0 ? last : tabs[index - 1]!;
}

/**
 * Pick the item typeahead should move focus to (WAI-ARIA APG first-character
 * navigation). Pure over the ordered item list so it is testable without a
 * real DOM: the search is a case-insensitive `startsWith` over `textOf(item)`,
 * starting from the item AFTER `active` and wrapping; `active` itself is the
 * last candidate, so a query the current item already matches keeps focus in
 * place (multi-char accumulation refining onto the same item). Returns `null`
 * when nothing matches or the query is empty. Query accumulation and its
 * timeout live at the caller.
 */
export function nextTypeaheadFocus<T>(
  items: T[],
  active: T | null,
  query: string,
  textOf: (item: T) => string,
): T | null {
  if (items.length === 0 || query.length === 0) return null;
  const q = query.toLowerCase();
  const start = active == null ? -1 : items.indexOf(active);
  for (let step = 1; step <= items.length; step++) {
    const item = items[(start + step + items.length) % items.length]!;
    if (textOf(item).trim().toLowerCase().startsWith(q)) return item;
  }
  return null;
}

/** Pause after which an accumulated typeahead query starts over. */
const TYPEAHEAD_RESET_MS = 500;

/**
 * Shared roving-tabindex installer for composite widgets (tablist, listbox):
 * arrow keys move focus among the `itemSelector` descendants (wrapping),
 * Home/End jump to the ends, and only the focused item stays in the page Tab
 * order (`tabindex=0`; the rest drop to `-1`) so a single Tab keypress leaves
 * the widget. Printable characters accumulate into a short-lived typeahead
 * query (reset after a 500ms pause, tracked by timestamp — no timers) that
 * roves to the next item whose text starts with the query. Space is excluded:
 * it activates the focused item, and stealing it would break native Button
 * hosts. Activation stays with the item's own click/Enter handling —
 * selection is app state, not focus state. Idempotent across re-renders,
 * guarded by a dataset flag.
 */
function installRovingWidget(container: HTMLElement, itemSelector: string): void {
  if (container.dataset?.hypenRoving) return;
  if (container.dataset) container.dataset.hypenRoving = "1";

  const itemsOf = (): HTMLElement[] =>
    Array.from(container.querySelectorAll(itemSelector)) as unknown as HTMLElement[];

  const rove = (target: HTMLElement, items: HTMLElement[]): void => {
    for (const item of items) {
      item.tabIndex = item === target ? 0 : -1;
    }
    target.focus?.();
  };

  let typeahead = "";
  let typeaheadAt = 0;

  container.addEventListener("keydown", (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    const key = keyEvent.key;
    const items = itemsOf();
    const focused = (container.ownerDocument?.activeElement ?? null) as HTMLElement | null;
    const active = focused && items.includes(focused) ? focused : null;

    let target = nextRovingFocus(items, active, key);

    if (
      !target &&
      key.length === 1 &&
      key !== " " &&
      !keyEvent.ctrlKey &&
      !keyEvent.metaKey &&
      !keyEvent.altKey
    ) {
      const now = Date.now();
      if (now - typeaheadAt > TYPEAHEAD_RESET_MS) typeahead = "";
      typeaheadAt = now;
      typeahead += key;
      target = nextTypeaheadFocus(items, active, typeahead, (item) => item.textContent ?? "");
    }

    if (target) {
      event.preventDefault?.();
      rove(target, items);
    }
  });

  // First entry into the widget establishes the roving state (focused item
  // reachable, siblings parked at -1) without needing any keydown first.
  container.addEventListener("focusin", (event: Event) => {
    const items = itemsOf();
    const focused = (event as FocusEvent).target as HTMLElement | null;
    if (focused && items.includes(focused)) {
      for (const item of items) {
        item.tabIndex = item === focused ? 0 : -1;
      }
    }
  });
}

/**
 * Install the WAI-ARIA APG "Tabs" keyboard contract on a tablist container:
 * roving tabindex over the `role="tab"` descendants plus first-character
 * typeahead (see `installRovingWidget`).
 */
export function makeRovingTablist(container: HTMLElement): void {
  installRovingWidget(container, '[role="tab"]');
}

/**
 * Install the WAI-ARIA APG "Listbox" keyboard contract on a listbox
 * container: roving tabindex over the `role="option"` descendants plus
 * first-character typeahead (see `installRovingWidget`). No-op for a native
 * `<select>` host (Hypen's `Select`), where the browser already owns arrow
 * and typeahead behaviour.
 */
export function makeRovingListbox(container: HTMLElement): void {
  if (container.tagName?.toUpperCase() === "SELECT") return;
  installRovingWidget(container, '[role="option"]');
}

/**
 * Install a focus trap on a dialog-like container: Tab / Shift+Tab cycle focus
 * among the container's focusable descendants and wrap at the ends. Closing is
 * app state: Escape is handled by `installDialogEscape` only when the dialog
 * declares an `onClose` action. Idempotent across re-renders, guarded by a
 * dataset flag.
 */
export function makeFocusTrap(container: HTMLElement): void {
  if (container.dataset?.hypenTrap) return;
  if (container.dataset) container.dataset.hypenTrap = "1";

  container.addEventListener("keydown", (event: Event) => {
    if ((event as KeyboardEvent).key !== "Tab") return;
    const focusable = Array.from(
      container.querySelectorAll(FOCUSABLE_SELECTOR),
    ) as unknown as HTMLElement[];
    const active = (container.ownerDocument?.activeElement ?? null) as HTMLElement | null;
    const target = nextTrapFocus(focusable, active, (event as KeyboardEvent).shiftKey === true);
    if (target) {
      event.preventDefault?.();
      target.focus?.();
    }
  });
}

/** Tags that can hold focus without a tabindex — the DFS twin of `FOCUSABLE_SELECTOR`. */
const FOCUSABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"]);

/**
 * First focusable descendant of `root` in document order, or `null`. Matches
 * the focus trap's element set (`FOCUSABLE_SELECTOR`) but walks `children`
 * recursively instead of `querySelectorAll`, so it works on hosts without
 * selector support (test doubles) — document order is exactly child order.
 */
export function findFirstFocusable(root: HTMLElement): HTMLElement | null {
  const children = Array.from((root.children ?? []) as unknown as ArrayLike<HTMLElement>);
  for (const child of children) {
    const tag = child.tagName?.toUpperCase() ?? "";
    if (FOCUSABLE_TAGS.has(tag) || child.getAttribute?.("tabindex") != null) return child;
    const nested = findFirstFocusable(child);
    if (nested) return nested;
  }
  return null;
}

/**
 * Dialog auto-focus on mount (WAI-ARIA APG "Dialog (Modal)"): focus the
 * dialog's first focusable descendant, else the dialog itself (granted
 * programmatic focusability by `focusRouteTarget`). Returns the element that
 * held focus before the dialog opened, so the caller can restore it on close.
 */
export function focusDialogOnOpen(dialog: HTMLElement): HTMLElement | null {
  const doc = dialog.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  const previous = (doc?.activeElement ?? null) as HTMLElement | null;
  focusRouteTarget(findFirstFocusable(dialog) ?? dialog);
  return previous;
}

/**
 * Restore focus to the element that had it before a dialog opened. Skipped
 * when the opener is gone: no longer connected to the document, or living
 * inside the (now closed) dialog itself.
 */
export function restoreDialogFocus(dialog: HTMLElement, opener: HTMLElement | null): void {
  if (!opener) return;
  if (dialog === opener || dialog.contains?.(opener)) return;
  if ((opener as { isConnected?: boolean }).isConnected === false) return;
  opener.focus?.();
}

/**
 * Escape-to-close for a dialog that declares an `onClose` action: Escape
 * dispatches the action; the actual close (state flip, unmount) stays with
 * the app. A dialog without `onClose` gets no Escape behaviour — the renderer
 * cannot know how to close it. Idempotent across re-renders, guarded by a
 * dataset flag.
 */
export function installDialogEscape(dialog: HTMLElement, onCloseValue: unknown): void {
  if (dialog.dataset?.hypenDialogEsc) return;
  if (dialog.dataset) dialog.dataset.hypenDialogEsc = "1";

  dialog.addEventListener("keydown", (event: Event) => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    event.preventDefault?.();
    triggerElementAction(dialog, onCloseValue);
  });
}
