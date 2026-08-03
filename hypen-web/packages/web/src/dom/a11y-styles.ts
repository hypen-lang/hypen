/**
 * Global accessibility stylesheet.
 *
 * Injects a single <style> element (idempotent, guarded by id) that:
 *  - honours `prefers-reduced-motion: reduce` by disabling transitions,
 *    animations and smooth scrolling on Hypen-rendered nodes — EXCEPT nodes
 *    carrying the `data-hypen-motion-essential` attribute, the DOM face of
 *    the `.motion(essential)` opt-out (#149): the renderer stamps it when a
 *    node's `__anim.motion` prop is `{essential: true}`, and those nodes
 *    keep animating (their motion carries meaning);
 *  - renders a visible `:focus-visible` outline so keyboard users can see
 *    which element is focused;
 *  - keeps that focus indicator visible under `forced-colors: active`
 *    (Windows High Contrast), which strips box-shadow but honours outline; and
 *  - strengthens the outline under `prefers-contrast: more`.
 *
 * Scoped to `[data-hypen-id]` so it only affects Hypen-rendered elements and
 * never the host page.
 */

const STYLE_ID = "hypen-a11y-styles";

const A11Y_CSS = `
@media (prefers-reduced-motion: reduce) {
  [data-hypen-id]:not([data-hypen-motion-essential]) {
    transition: none !important;
    animation: none !important;
    scroll-behavior: auto !important;
  }
}
[data-hypen-id]:focus-visible {
  outline: 2px solid #1a73e8;
  outline-offset: 2px;
}
@media (forced-colors: active) {
  /* Forced-colors mode removes box-shadow and author colors but honours
     outline: pin the focus indicator to an outline in the system Highlight
     color, and drop any box-shadow-based indicator a component style set. */
  [data-hypen-id]:focus-visible {
    outline: 2px solid Highlight;
    box-shadow: none;
  }
}
@media (prefers-contrast: more) {
  /* A thicker outline for users who asked for higher contrast. */
  [data-hypen-id]:focus-visible {
    outline-width: 3px;
  }
}
`;

/**
 * Inject the accessibility stylesheet once. Safe to call repeatedly and in
 * non-DOM environments (server/tests without `document`), where it no-ops.
 */
export function ensureA11yStyles(): void {
  if (typeof document === "undefined" || !document.head) {
    return;
  }

  if (typeof document.getElementById === "function" && document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = A11Y_CSS;
  document.head.appendChild(style);
}
