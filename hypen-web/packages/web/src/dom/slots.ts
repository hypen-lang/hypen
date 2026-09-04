/**
 * Slot visibility helpers (shared by native container components).
 *
 * Components that compose author-provided children into their own chrome
 * (HypenApp's loading/error slots, Video's controls/loading/error/poster
 * slots) all need the same two primitives:
 *
 * - find the direct children tagged with `.slot(name)` (lowered by the
 *   engine to the `slot.0` prop, mirrored onto `data-hypen-slot` by the
 *   DOM renderer), and
 * - show/hide one of them WITHOUT unmounting it, so the subtree keeps its
 *   DOM state (scroll, focus, form values, running animations) across
 *   visibility flips.
 */

/** Direct children of `element` tagged with `.slot(name)`. */
export function slotChildren(element: HTMLElement, name: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const child of Array.from(element.children)) {
    if ((child as HTMLElement).dataset?.hypenSlot === name) {
      out.push(child as HTMLElement);
    }
  }
  return out;
}

/**
 * Hide/show an element while preserving its inline display value —
 * applicators set `display: flex` etc. inline, so a plain `display = ""`
 * on re-show would lose the element's layout.
 */
export function setVisible(el: HTMLElement, visible: boolean): void {
  const hidden = el.dataset.hypenSlotHidden === "true";
  if (visible && hidden) {
    el.style.display = el.dataset.hypenPrevDisplay ?? "";
    delete el.dataset.hypenPrevDisplay;
    delete el.dataset.hypenSlotHidden;
  } else if (!visible && !hidden) {
    el.dataset.hypenPrevDisplay = el.style.display;
    el.dataset.hypenSlotHidden = "true";
    el.style.display = "none";
  }
}
