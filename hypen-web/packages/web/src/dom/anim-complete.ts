/**
 * `.onAnimationComplete(@actions.x)` — completion-event dispatch (Option F).
 *
 * The applicator (`applicators/events.ts`) STORES the action on the element
 * instead of attaching a DOM listener; the `DomAnimator` calls
 * {@link dispatchAnimationComplete} when a playback settles NATURALLY.
 * Interrupted, superseded, and reduced-motion-skipped playbacks fire nothing
 * — that contract removes most completion races by construction. Firing
 * points and payloads (normative, .notes/ANIMATION_API_DESIGN.md §3 Option F):
 *
 *   - finite `.animate` preset completes → `{ animation: "<presetName>" }`
 *   - `.enter` settles                   → `{ animation: "enter" }`
 *   - `.exit` settles (before finalize)  → `{ animation: "exit" }`
 *   - `.states` transition settles       → `{ animation: "states", state: "<label>" }`
 *
 * Looping presets never complete. Nodes without an `onAnimationComplete`
 * prop dispatch nothing (the meta lookup below is the entire overhead).
 * Dispatch goes through the element's engine handle exactly like the other
 * event applicators (`getEngine` + `dispatchAction`).
 *
 * Lives in its own module (not `applicators/events.ts`) because both the
 * applicator layer and `anim.ts` need it, and `applicators/events.ts`
 * already imports from `anim.ts` — routing through here avoids the cycle.
 */

import { frameworkLoggers } from "@hypen-space/core/logger";
import { getEngine, getMeta, setMeta } from "./element-data.js";

const log = frameworkLoggers.events;

/** Element-meta key the stored completion action lives under. */
const ANIMATION_COMPLETE_META = "event:animationComplete";

/** The action an `.onAnimationComplete` applicator stored on an element. */
export interface AnimationCompleteAction {
  actionName: string;
  /** Extra named args from the applicator, merged under the payload. */
  customPayload: Record<string, unknown>;
}

/** What settled: the fixed channel names, or a finite `.animate` preset name. */
export interface AnimationCompletion {
  animation: string;
  /** The matched pose label — present only for `animation: "states"`. */
  state?: string;
}

/**
 * Store (or clear, with `null`) the completion action for an element.
 * Called by the `onAnimationComplete` applicator handler; re-applying with a
 * different action retargets future dispatches, mirroring how the persistent
 * DOM-event listeners re-read their meta per event.
 */
export function setAnimationCompleteAction(
  element: HTMLElement,
  action: AnimationCompleteAction | null
): void {
  setMeta(element, ANIMATION_COMPLETE_META, action);
}

/**
 * Fire the element's stored completion action for a naturally-settled
 * playback. No-op when the node carries no `onAnimationComplete` prop or the
 * element has no engine handle. The completion fields are written last so
 * `animation`/`state` can never be shadowed by custom payload args.
 */
export function dispatchAnimationComplete(
  element: HTMLElement,
  completion: AnimationCompletion
): void {
  const action = getMeta<AnimationCompleteAction | null>(element, ANIMATION_COMPLETE_META);
  if (!action) return;
  const engine = getEngine(element);
  if (!engine) return;
  const payload: Record<string, unknown> = { ...action.customPayload, ...completion };
  try {
    engine.dispatchAction(action.actionName, payload);
  } catch (err) {
    log.error(`Error dispatching action "${action.actionName}":`, err);
  }
}
