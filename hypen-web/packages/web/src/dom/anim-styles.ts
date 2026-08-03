/**
 * Global `.animate` preset stylesheet (Option E — presets-only).
 *
 * Injects a single <style> element (idempotent, guarded by id — the
 * `ensureA11yStyles` pattern) defining the `@keyframes` and one class per
 * built-in timeline preset (`pulse` / `spin` / `shimmer` / `shake`). The
 * classes read their timing from CSS custom properties the `DomAnimator`
 * writes per node, with the preset's normative defaults (see
 * `ANIMATE_PRESETS` in `@hypen-space/core/animation`) as `var()` fallbacks —
 * a class with no vars set still plays correctly.
 *
 * A stylesheet (not inline `el.style.animation`) is load-bearing here:
 * `shimmer` is a gradient `::after` overlay, which only a stylesheet can
 * express. The sweep animates `background-position` on that overlay rather
 * than translating the overlay box itself: backgrounds always clip to their
 * element's box, so the gradient can never escape the node — no
 * `overflow: hidden` is required, which means an author's inline
 * `.overflow(visible)` (applicators write inline styles, which would beat
 * any class rule) can neither leak the sweep outside the element nor is any
 * intentionally-overflowing child clipped while shimmer runs.
 *
 * One containment side effect remains and is deliberate: the shimmer class
 * sets `position: relative` so the `::after` overlay anchors to the node
 * itself. Any *positioned* inline value the author writes (`relative`,
 * `absolute`, `fixed`, `sticky`) also anchors the overlay correctly and
 * wins over the class as usual; while shimmer is active on a statically
 * positioned node, absolutely-positioned descendants re-anchor to it — the
 * documented cost of the overlay approach.
 *
 * Reduced motion: the global a11y stylesheet's `animation: none !important`
 * rule already neutralizes playback on `[data-hypen-id]` elements; this
 * sheet only has to extend that to the shimmer overlay pseudo-element,
 * which the element-scoped a11y selector cannot reach.
 */

import type { AnimatePreset } from "@hypen-space/core/animation";

const STYLE_ID = "hypen-anim-styles";

/** CSS custom properties the animator writes; classes read them via `var()`. */
export const ANIM_VAR_DURATION = "--hypen-anim-duration";
export const ANIM_VAR_CURVE = "--hypen-anim-curve";
export const ANIM_VAR_DELAY = "--hypen-anim-delay";
export const ANIM_VAR_ITERATIONS = "--hypen-anim-iterations";

/** The class the stylesheet defines for one preset. */
export const animateClassFor = (preset: AnimatePreset): string =>
  `hypen-anim-${preset}`;

/**
 * CSS properties each preset's keyframes animate ON THE ELEMENT ITSELF.
 * A running CSS animation sits above inline styles in the cascade for the
 * properties it animates, so a preset that keyframes `opacity`/`transform`
 * would silently defeat the inline poses the `DomAnimator` writes for
 * enter/exit/FLIP playback on the same node. The animator consults this map
 * to suspend the preset (inline `animation: none`, which beats the class
 * rule) for the duration of a conflicting playback. `shimmer` is empty: its
 * keyframes run on the `::after` overlay, never on the element.
 */
export const ANIMATE_PRESET_ELEMENT_PROPS: Record<AnimatePreset, readonly string[]> = {
  pulse: ["opacity"],
  spin: ["transform"],
  shimmer: [],
  shake: ["transform"],
};

/**
 * One `animation` shorthand per preset, reading the per-node vars with that
 * preset's normative defaults as fallbacks. Shorthand time-value order
 * matters: the first time is `duration`, the second is `delay`.
 */
const playback = (fallbackDuration: string, fallbackCurve: string, fallbackIterations: string, name: string): string =>
  `animation: ${name} var(${ANIM_VAR_DURATION}, ${fallbackDuration}) var(${ANIM_VAR_CURVE}, ${fallbackCurve}) var(${ANIM_VAR_DELAY}, 0ms) var(${ANIM_VAR_ITERATIONS}, ${fallbackIterations});`;

const ANIM_CSS = `
@keyframes hypen-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
@keyframes hypen-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes hypen-shimmer {
  from { background-position-x: 200%; }
  to { background-position-x: -100%; }
}
@keyframes hypen-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-6px); }
  40% { transform: translateX(6px); }
  60% { transform: translateX(-4px); }
  80% { transform: translateX(4px); }
}
.hypen-anim-pulse {
  ${playback("1200ms", "ease-in-out", "infinite", "hypen-pulse")}
}
.hypen-anim-spin {
  ${playback("800ms", "linear", "infinite", "hypen-spin")}
}
.hypen-anim-shake {
  ${playback("400ms", "ease-in-out", "1", "hypen-shake")}
}
.hypen-anim-shimmer {
  /* Anchors the ::after overlay. Deliberately the ONLY containment rule:
     the sweep animates background-position on an inset:0 overlay, and
     backgrounds self-clip to their box — no clipping declaration exists
     here, so an author's inline overflow value can neither leak the sweep
     outside the element nor be clobbered while shimmer runs. */
  position: relative;
}
.hypen-anim-shimmer::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position-x: 200%;
  ${playback("1500ms", "linear", "infinite", "hypen-shimmer")}
}
@media (prefers-reduced-motion: reduce) {
  /* The a11y sheet's [data-hypen-id] { animation: none !important } covers
     the element itself but cannot select the shimmer overlay pseudo. */
  .hypen-anim-shimmer::after {
    animation: none !important;
    content: none;
  }
}
`;

/**
 * Inject the `.animate` preset stylesheet once. Safe to call repeatedly and
 * in non-DOM environments (server/tests without `document`), where it no-ops.
 */
export function ensureAnimStyles(): void {
  if (typeof document === "undefined" || !document.head) {
    return;
  }

  if (typeof document.getElementById === "function" && document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = ANIM_CSS;
  document.head.appendChild(style);
}
