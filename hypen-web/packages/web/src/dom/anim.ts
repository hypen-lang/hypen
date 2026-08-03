/**
 * DOM animation runtime for the `__anim.*` prop channel.
 *
 * The engine lowers `.transition` / `.enter` / `.exit` / `.layout` into four
 * reserved props (see `@hypen-space/core/animation`); this module is the DOM
 * side of that contract:
 *
 * - `.transition` → inline `transition-*` longhands over the shared
 *   animatable-prop whitelist, so subsequent `setProp` patches interpolate
 *   natively (interruption = CSS transition semantics for free).
 * - `.enter` → post-batch queue: hidden pose → forced reflow → transition to
 *   the node's real styles. Only nodes created in the same batch enter-animate
 *   (a cached `attach` never does), and the first-ever batch is suppressed so
 *   initial render doesn't cascade.
 * - `.exit` → deferred remove: a flagged `remove` whose root carries an exit
 *   spec marks the root (`data-hypen-exiting`, `inert`, `pointer-events:none`),
 *   plays the inverse presets, and finalizes teardown afterwards. The timeout
 *   (duration + delay + grace) is the finalize backbone; `transitionend` is
 *   the fast path (it doesn't fire under reduced motion or hidden ancestors).
 * - `.layout` → FLIP on `move` patches: First rects recorded in a pre-pass,
 *   Last measured post-batch, inverted with transitions off, then played.
 * - `.animate` → class + CSS-variable playback against the injected preset
 *   stylesheet (`anim-styles.ts`): set the timing vars and the preset class
 *   on create, restart on SetProp change (remove class → forced reflow →
 *   re-add), clear class + vars on RemoveProp. Exiting nodes keep playing.
 *   Two coordination rules keep `.animate` honest against the rest of the
 *   system: (1) a cached Router `attach` never replays a FINITE-repeat
 *   preset — the class is stripped on `noteAttach`, mirroring the
 *   "a cached attach never enter-animates" contract (looping presets resume,
 *   as they must); (2) a preset whose keyframes animate `opacity`/`transform`
 *   on the element is suspended (inline `animation: none`) while an
 *   enter/exit/FLIP playback targets the same properties — a running CSS
 *   animation outranks inline styles in the cascade and would otherwise
 *   silently defeat the playback pose. Enters/FLIPs resume the preset when
 *   they settle; exits leave it suspended (the corpse is being torn down).
 *
 * Reduced motion snaps everything: transitions and `.animate` playback are
 * already neutralized by the global stylesheets (`animation: none
 * !important`), enters/FLIPs are skipped, and exits finalize on the next
 * microtask.
 */

import {
  ANIM_TRANSITION_PROP,
  ANIM_ENTER_PROP,
  ANIM_EXIT_PROP,
  ANIM_LAYOUT_PROP,
  ANIM_PROP_ANIMATE,
  CURVE_TO_CSS,
  cssPropertiesFor,
  presetHiddenStyles,
  parseAnimProps,
  type AnimCurve,
  type AnimateSpec,
  type NodeAnimSpecs,
  type TransitionSpec,
  type PresetHiddenStyle,
} from "@hypen-space/core/animation";
import {
  ANIM_VAR_DURATION,
  ANIM_VAR_CURVE,
  ANIM_VAR_DELAY,
  ANIM_VAR_ITERATIONS,
  ANIMATE_PRESET_ELEMENT_PROPS,
  animateClassFor,
} from "./anim-styles.js";

/**
 * Marker attribute set on an exit-animating subtree root. Renderer-internal,
 * but also the hook the event layer uses to drop dispatches from exiting
 * subtrees (engine-side those ids are already dead).
 */
export const EXITING_ATTR = "data-hypen-exiting";

/**
 * Grace added to `duration + delay` before the timeout backbone finalizes a
 * playback that never saw `transitionend`.
 */
const SETTLE_GRACE_MS = 80;

/** The timing core every channel spec shares. */
type Timing = { duration: number; curve: AnimCurve; delay?: number };

interface ExitingRoot {
  element: HTMLElement;
  finalizeRoot: () => void;
  /**
   * Finalizers for descendant `remove` patches that arrived while this root
   * was exiting (root-first ordering: the flagged root Remove precedes its
   * descendants' plain Removes). Run before the root's own finalize.
   */
  descendantFinalizes: Array<() => void>;
}

interface PendingFlip {
  element: HTMLElement;
  first: { left: number; top: number };
}

/** Minimal patch shape the FLIP pre-pass needs (avoids a core type import cycle). */
interface MovePatchLike {
  type: string;
  id?: string;
}

/**
 * Is `element` inside (or itself) an exit-animating subtree? Walks
 * `parentNode` links — fake-dom (tests) has no `closest`.
 */
export function isInExitingSubtree(element: HTMLElement): boolean {
  let node: unknown = element;
  while (node) {
    const el = node as { getAttribute?: (name: string) => string | null; parentNode?: unknown };
    if (typeof el.getAttribute !== "function") return false;
    if (el.getAttribute(EXITING_ATTR) != null) return true;
    node = el.parentNode ?? null;
  }
  return false;
}

/**
 * Is `element` a strict descendant of `root`? Walks `parentNode` links —
 * fake-dom (tests) has no `closest`, and detached subtrees keep their
 * internal links.
 */
function isWithinSubtree(element: HTMLElement, root: HTMLElement): boolean {
  let node: unknown = (element as { parentNode?: unknown }).parentNode ?? null;
  while (node) {
    if (node === root) return true;
    node = (node as { parentNode?: unknown }).parentNode ?? null;
  }
  return false;
}

/**
 * Resolve the layout direction for slide presets by walking `dir` attributes
 * up the tree (the semantics layer writes `dir` as a native attribute).
 */
function isRtl(element: HTMLElement): boolean {
  let node: unknown = element;
  while (node) {
    const el = node as { getAttribute?: (name: string) => string | null; parentNode?: unknown };
    if (typeof el.getAttribute !== "function") break;
    const dir = el.getAttribute("dir");
    if (dir === "rtl") return true;
    if (dir === "ltr") return false;
    node = el.parentNode ?? null;
  }
  return false;
}

/**
 * WASM patches deliver nested prop values as Maps; the core parser expects
 * plain objects (or JSON strings). Normalize before parsing.
 */
function toPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      obj[String(key)] = toPlain(entry);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  return value;
}

/**
 * Reading a layout property flushes pending style writes, so the transition
 * that follows starts from the pose just written instead of coalescing.
 */
function forceReflow(element: HTMLElement): void {
  void (element as { offsetWidth?: number }).offsetWidth;
}

/** CSS properties a hidden pose animates (`transition-property` targets). */
function poseProperties(pose: PresetHiddenStyle): string[] {
  const props: string[] = [];
  if (pose.opacity !== undefined) props.push("opacity");
  if (pose.transform !== undefined) props.push("transform");
  return props;
}

function settleBudget(timing: Timing): number {
  return timing.duration + (timing.delay ?? 0) + SETTLE_GRACE_MS;
}

export class DomAnimator {
  /** Parsed channel specs per node id (ids never recycle; forgotten on finalize). */
  private specs = new Map<string, NodeAnimSpecs>();
  /**
   * Elements carrying a live `.animate` spec, so `noteAttach` can find the
   * finite-repeat presets inside a re-attached (cached Router) subtree —
   * the attach patch names only the subtree ROOT, but any descendant's
   * one-shot animation would also restart on document re-entry.
   */
  private animateElements = new Map<string, HTMLElement>();
  /** Exit-animating subtree roots awaiting finalize. */
  private exitingRoots = new Map<string, ExitingRoot>();
  /** Nodes created this batch whose enter should play at flush. */
  private pendingEnters = new Map<string, HTMLElement>();
  /** First rects recorded by the FLIP pre-pass, measured against at flush. */
  private pendingFlips = new Map<string, PendingFlip>();
  /** Ids created (with anim props) since the last flush — enter eligibility. */
  private createdThisBatch = new Set<string>();
  /**
   * Pending settle canceller per node id. At most one playback settles per
   * element at a time: starting a new playback (enter, FLIP, exit) cancels
   * the previous settle, so a superseded playback's deferred
   * `restoreBaseTransition` can never clobber the transition styles of the
   * one now in flight (which would snap it mid-animation).
   */
  private settles = new Map<string, () => void>();
  /** The first-ever batch never enter-animates (no initial-render cascade). */
  private firstBatchDone = false;
  private reducedMotionQuery: { matches: boolean } | null = null;

  constructor() {
    try {
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        this.reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      }
    } catch {
      // matchMedia unavailable (tests, non-browser hosts) — motion allowed.
    }
  }

  private get reducedMotion(): boolean {
    return this.reducedMotionQuery?.matches ?? false;
  }

  /**
   * Cache and apply a freshly-created node's `__anim.*` props (already
   * stripped from the props the applicators see). Transition styles land now
   * — before insert — so first paint never animates.
   */
  registerCreate(id: string, element: HTMLElement, animProps: Record<string, unknown>): void {
    const plain: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(animProps)) {
      plain[key] = toPlain(value);
    }
    const specs = parseAnimProps(plain);
    this.specs.set(id, specs);
    if (specs.transition) {
      this.applyTransitionStyles(element, specs.transition);
    }
    if (specs.animate) {
      this.applyAnimateStyles(id, element, specs.animate, null);
    }
    if (specs.enter) {
      this.createdThisBatch.add(id);
    }
  }

  /** Route a `setProp` for one `__anim.*` channel; unknown channels are ignored. */
  setAnimProp(id: string, element: HTMLElement, name: string, value: unknown): void {
    const specs = this.specsFor(id);
    const parsed = parseAnimProps({ [name]: toPlain(value) });
    switch (name) {
      case ANIM_TRANSITION_PROP:
        specs.transition = parsed.transition;
        this.applyTransitionStyles(element, specs.transition);
        break;
      case ANIM_ENTER_PROP:
        specs.enter = parsed.enter;
        break;
      case ANIM_EXIT_PROP:
        specs.exit = parsed.exit;
        break;
      case ANIM_LAYOUT_PROP:
        specs.layout = parsed.layout;
        break;
      case ANIM_PROP_ANIMATE: {
        const previous = specs.animate;
        specs.animate = parsed.animate;
        this.applyAnimateStyles(id, element, specs.animate, previous);
        break;
      }
    }
  }

  /** Route a `removeProp` for one `__anim.*` channel. */
  removeAnimProp(id: string, element: HTMLElement, name: string): void {
    this.setAnimProp(id, element, name, undefined);
  }

  /**
   * A node just entered the document. Queues its enter for the post-batch
   * flush — but only when it was created in this same batch, so a cached
   * `attach` (same code path) never enter-animates.
   */
  noteInsert(id: string, element: HTMLElement): void {
    if (this.createdThisBatch.has(id) && this.specs.get(id)?.enter) {
      this.pendingEnters.set(id, element);
    }
  }

  /**
   * A cached subtree just re-entered the document via an `attach` patch.
   * Re-insertion restarts every CSS animation in the subtree from iteration
   * 0, which is correct for looping presets (they must resume) but replays
   * FINITE-repeat `.animate` presets (`shake`, `repeat: 3`, …) on every
   * navigation back to a cached route — the same surprise the
   * `createdThisBatch` gate prevents for `.enter`. Strip the preset class
   * from finite-repeat nodes at-or-under the attached root; a later
   * `__anim.animate` SetProp still restarts playback normally.
   */
  noteAttach(root: HTMLElement): void {
    if (this.animateElements.size === 0) return;
    for (const [id, element] of this.animateElements) {
      const spec = this.specs.get(id)?.animate;
      if (!spec || spec.repeat === "loop") continue;
      if (this.createdThisBatch.has(id)) continue; // fresh create, not a cached attach
      if (element !== root && !isWithinSubtree(element, root)) continue;
      element.classList.remove(animateClassFor(spec.preset));
    }
  }

  /**
   * FLIP pre-pass: before the batch mutates the DOM, record First rects for
   * `move` patches whose nodes carry a `.layout` spec.
   */
  prepareMoves(patches: readonly MovePatchLike[], getNode: (id: string) => HTMLElement | undefined): void {
    for (const patch of patches) {
      if (patch.type !== "move" || !patch.id) continue;
      if (!this.specs.get(patch.id)?.layout) continue;
      if (this.exitingRoots.has(patch.id)) continue; // exit wins over FLIP
      const element = getNode(patch.id);
      const first = this.measure(element);
      if (element && first) {
        this.pendingFlips.set(patch.id, { element, first });
      }
    }
  }

  /**
   * Post-batch hook: play queued enters and FLIPs, then reset per-batch
   * state. Runs at the end of every `applyPatches`.
   */
  flush(): void {
    const enters = this.pendingEnters;
    const flips = this.pendingFlips;
    const suppressEnters = !this.firstBatchDone;
    this.pendingEnters = new Map();
    this.pendingFlips = new Map();
    this.createdThisBatch.clear();
    this.firstBatchDone = true;

    if (!this.reducedMotion) {
      if (!suppressEnters) {
        for (const [id, element] of enters) {
          this.playEnter(id, element);
        }
      }
      for (const [id, flip] of flips) {
        this.playFlip(id, flip);
      }
    }
  }

  /**
   * Begin a deferred remove for a flagged root. Returns `true` when the
   * teardown is deferred (exit spec present) — the animator runs `finalize`
   * when the exit settles. Returns `false` for a flagged root without a
   * cached exit spec: sanctioned snap, caller removes instantly.
   */
  beginExit(id: string, element: HTMLElement, finalize: () => void): boolean {
    const existing = this.exitingRoots.get(id);
    if (existing) {
      // Duplicate flagged remove for an already-exiting id (defensive):
      // fold the finalize into the in-flight exit.
      existing.descendantFinalizes.push(finalize);
      return true;
    }
    const spec = this.specs.get(id)?.exit;
    if (!spec) return false;

    // An in-flight enter/FLIP settle on this element must not fire mid-exit
    // (its restore would retarget `transition-property` and snap the exit).
    this.cancelSettle(id);

    element.setAttribute(EXITING_ATTR, "");
    element.setAttribute("inert", "");
    element.style.pointerEvents = "none";

    const record: ExitingRoot = {
      element,
      finalizeRoot: finalize,
      descendantFinalizes: [],
    };
    this.exitingRoots.set(id, record);

    if (this.reducedMotion) {
      // Snap: no playback, but teardown still defers one microtask so the
      // descendant Removes in this batch can queue on the root first.
      queueMicrotask(() => this.finalizeExit(id));
      return true;
    }

    const pose = presetHiddenStyles(spec.presets, spec.to, isRtl(element));
    const targets = poseProperties(pose);
    if (targets.length === 0) {
      queueMicrotask(() => this.finalizeExit(id));
      return true;
    }

    // A preset animating the pose properties would mask the exit motion (the
    // corpse would keep pulsing/spinning, fully visible, until the timeout
    // backbone snapped it out). Suspended for good — the node is on its way
    // out, so there is nothing to resume.
    this.suspendConflictingAnimate(id, element, targets);

    this.applyPlaybackTransition(element, targets, spec);
    forceReflow(element);
    if (pose.opacity !== undefined) element.style.opacity = pose.opacity;
    if (pose.transform !== undefined) element.style.transform = pose.transform;
    this.beginSettle(id, element, settleBudget(spec), () => this.finalizeExit(id));
    return true;
  }

  /**
   * Defer a plain (unflagged) remove whose element sits under an exiting
   * root: queue its finalize on that root so the subtree stays intact until
   * the exit settles. Returns `false` when no exiting ancestor exists.
   */
  deferToExitingAncestor(element: HTMLElement, finalize: () => void): boolean {
    if (this.exitingRoots.size === 0) return false;
    let node: unknown = (element as { parentNode?: unknown }).parentNode ?? null;
    while (node) {
      for (const record of this.exitingRoots.values()) {
        if (record.element === node) {
          record.descendantFinalizes.push(finalize);
          return true;
        }
      }
      node = (node as { parentNode?: unknown }).parentNode ?? null;
    }
    return false;
  }

  /**
   * Defensive: a `create` arrived for an id that is still exit-animating
   * (engine ids never recycle, but the corpse must not shadow a new node).
   * Finalizes the old subtree immediately. No-op for non-exiting ids.
   */
  finalizeNow(id: string): void {
    this.finalizeExit(id);
  }

  /** Drop cached specs for a finalized id. */
  forget(id: string): void {
    this.cancelSettle(id);
    this.specs.delete(id);
    this.animateElements.delete(id);
    this.createdThisBatch.delete(id);
    this.pendingEnters.delete(id);
    this.pendingFlips.delete(id);
  }

  /** Cancel all in-flight work and drop all caches (renderer `clear()`). */
  reset(): void {
    for (const cancel of this.settles.values()) {
      cancel();
    }
    this.settles.clear();
    this.exitingRoots.clear();
    this.specs.clear();
    this.animateElements.clear();
    this.pendingEnters.clear();
    this.pendingFlips.clear();
    this.createdThisBatch.clear();
    this.firstBatchDone = false;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private specsFor(id: string): NodeAnimSpecs {
    let specs = this.specs.get(id);
    if (!specs) {
      specs = { transition: null, enter: null, exit: null, layout: null, animate: null };
      this.specs.set(id, specs);
    }
    return specs;
  }

  /**
   * Longhands (not the `transition` shorthand) so the legacy string
   * passthrough applicator and these styles can't silently clobber each
   * other's sub-properties.
   */
  private applyTransitionStyles(element: HTMLElement, spec: TransitionSpec | null): void {
    if (spec) {
      element.style.transitionProperty = cssPropertiesFor(spec.props).join(", ");
      element.style.transitionDuration = `${spec.duration}ms`;
      element.style.transitionTimingFunction = CURVE_TO_CSS[spec.curve];
      element.style.transitionDelay = spec.delay ? `${spec.delay}ms` : "";
    } else {
      element.style.transitionProperty = "";
      element.style.transitionDuration = "";
      element.style.transitionTimingFunction = "";
      element.style.transitionDelay = "";
    }
  }

  /**
   * Apply, update, or clear `.animate` preset playback. The stylesheet
   * (`anim-styles.ts`) owns the keyframes; this only writes the per-node
   * timing vars and the preset class. `previous` is the spec in effect
   * before this call: when one exists the class is removed and a reflow
   * forced before re-adding, so an updated spec restarts playback from the
   * beginning (re-adding the same class without the reflow would let the
   * running animation coast on unchanged).
   */
  private applyAnimateStyles(
    id: string,
    element: HTMLElement,
    spec: AnimateSpec | null,
    previous: AnimateSpec | null
  ): void {
    if (previous) {
      element.classList.remove(animateClassFor(previous.preset));
    }
    // Any playback suspension (see suspendConflictingAnimate) is stale the
    // moment the channel changes: a cleared channel needs no suspension, and
    // a fresh spec must not start masked by a leftover `animation: none`.
    element.style.removeProperty("animation");
    if (!spec) {
      this.animateElements.delete(id);
      element.style.removeProperty(ANIM_VAR_DURATION);
      element.style.removeProperty(ANIM_VAR_CURVE);
      element.style.removeProperty(ANIM_VAR_DELAY);
      element.style.removeProperty(ANIM_VAR_ITERATIONS);
      return;
    }
    if (previous) {
      forceReflow(element);
    }
    this.animateElements.set(id, element);
    element.style.setProperty(ANIM_VAR_DURATION, `${spec.duration}ms`);
    element.style.setProperty(ANIM_VAR_CURVE, CURVE_TO_CSS[spec.curve]);
    element.style.setProperty(ANIM_VAR_DELAY, spec.delay ? `${spec.delay}ms` : "0ms");
    element.style.setProperty(
      ANIM_VAR_ITERATIONS,
      spec.repeat === "loop" ? "infinite" : String(spec.repeat)
    );
    element.classList.add(animateClassFor(spec.preset));
  }

  /**
   * A running `.animate` preset whose keyframes animate one of `targets` ON
   * THE ELEMENT would outrank the inline poses a playback writes (CSS
   * animations beat inline styles for the properties they animate), so the
   * fade/slide/FLIP motion would never render. Suspend it with an inline
   * `animation: none` — inline beats the preset class — for the playback's
   * lifetime. No-op when there is no preset or no property overlap (e.g.
   * `shimmer`, whose keyframes live on the `::after` overlay).
   */
  private suspendConflictingAnimate(id: string, element: HTMLElement, targets: string[]): void {
    const spec = this.specs.get(id)?.animate;
    if (!spec) return;
    const owned = ANIMATE_PRESET_ELEMENT_PROPS[spec.preset];
    if (!owned.some((prop) => targets.includes(prop))) return;
    element.style.setProperty("animation", "none");
  }

  /** Lift a playback-time preset suspension (enter/FLIP settle). */
  private resumeAnimate(element: HTMLElement): void {
    element.style.removeProperty("animation");
  }

  private applyPlaybackTransition(element: HTMLElement, targets: string[], timing: Timing): void {
    element.style.transitionProperty = targets.join(", ");
    element.style.transitionDuration = `${timing.duration}ms`;
    element.style.transitionTimingFunction = CURVE_TO_CSS[timing.curve];
    element.style.transitionDelay = timing.delay ? `${timing.delay}ms` : "";
  }

  /** After a playback settles, hand the longhands back to the node's `.transition`. */
  private restoreBaseTransition(id: string, element: HTMLElement): void {
    this.applyTransitionStyles(element, this.specs.get(id)?.transition ?? null);
  }

  private playEnter(id: string, element: HTMLElement): void {
    const spec = this.specs.get(id)?.enter;
    if (!spec || this.exitingRoots.has(id)) return;
    const pose = presetHiddenStyles(spec.presets, spec.from, isRtl(element));
    const targets = poseProperties(pose);
    if (targets.length === 0) return;

    const finalOpacity = element.style.opacity ?? "";
    const finalTransform = element.style.transform ?? "";

    // A preset animating the same properties would mask the pose entirely.
    this.suspendConflictingAnimate(id, element, targets);

    // Jump to the hidden pose without animating…
    element.style.transitionProperty = "none";
    if (pose.opacity !== undefined) element.style.opacity = pose.opacity;
    if (pose.transform !== undefined) element.style.transform = pose.transform;
    forceReflow(element);

    // …then transition back to the node's real styles.
    this.applyPlaybackTransition(element, targets, spec);
    if (pose.opacity !== undefined) element.style.opacity = finalOpacity;
    if (pose.transform !== undefined) element.style.transform = finalTransform;
    this.beginSettle(id, element, settleBudget(spec), () => {
      this.restoreBaseTransition(id, element);
      this.resumeAnimate(element);
    });
  }

  private playFlip(id: string, flip: PendingFlip): void {
    const spec = this.specs.get(id)?.layout;
    if (!spec || this.exitingRoots.has(id)) return; // exit wins over FLIP
    const { element, first } = flip;
    const last = this.measure(element);
    if (!last) return;
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

    const finalTransform = element.style.transform ?? "";
    const invert = `translate(${dx}px, ${dy}px)`;

    // A transform-keyframing preset (spin/shake) would mask the invert.
    this.suspendConflictingAnimate(id, element, ["transform"]);

    // Invert: place the node back at its First position, transitions off…
    element.style.transitionProperty = "none";
    element.style.transform = finalTransform ? `${finalTransform} ${invert}` : invert;
    forceReflow(element);

    // …then Play back to identity.
    this.applyPlaybackTransition(element, ["transform"], spec);
    element.style.transform = finalTransform;
    this.beginSettle(id, element, settleBudget(spec), () => {
      this.restoreBaseTransition(id, element);
      this.resumeAnimate(element);
    });
  }

  private measure(element: HTMLElement | undefined): { left: number; top: number } | null {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    try {
      const rect = element.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
      return { left: rect.left, top: rect.top };
    } catch {
      return null;
    }
  }

  private finalizeExit(id: string): void {
    const record = this.exitingRoots.get(id);
    if (!record) return;
    this.exitingRoots.delete(id);
    this.cancelSettle(id);
    // Descendants first (their Removes arrived after the flagged root), the
    // root's own teardown last.
    for (const finalize of record.descendantFinalizes) {
      finalize();
    }
    record.finalizeRoot();
  }

  /**
   * Start the (single) tracked settle for `id`, cancelling any settle a
   * previous playback on the same node left pending — see {@link settles}.
   */
  private beginSettle(id: string, element: HTMLElement, totalMs: number, done: () => void): void {
    this.cancelSettle(id);
    this.settles.set(
      id,
      this.settle(element, totalMs, () => {
        this.settles.delete(id);
        done();
      })
    );
  }

  /** Stand down the pending settle for `id`, if any, without running it. */
  private cancelSettle(id: string): void {
    const cancel = this.settles.get(id);
    if (cancel) {
      this.settles.delete(id);
      cancel();
    }
  }

  /**
   * Finalize backbone: the timeout always fires; `transitionend` on the
   * element itself is the fast path (bubbled descendant transitions are
   * ignored). Returns a canceller that stands the settle down without
   * running `done`.
   */
  private settle(element: HTMLElement, totalMs: number, done: () => void): () => void {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      element.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
      done();
    };
    const onEnd = (event: Event) => {
      if (event.target && event.target !== element) return;
      finish();
    };
    element.addEventListener("transitionend", onEnd);
    const timer = setTimeout(finish, totalMs);
    return () => {
      if (finished) return;
      finished = true;
      element.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
    };
  }
}
