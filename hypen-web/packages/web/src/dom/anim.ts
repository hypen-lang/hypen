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
 *   Removals generalize the same machinery (#146): when a batch removes a
 *   node, the pre-pass also snapshots the First rects of the removed node's
 *   connected siblings that carry `.layout` — a plain remove reflows them
 *   within the batch, so the post-batch flush FLIPs them from their old
 *   positions. A FLAGGED remove (exit) leaves the element in flow until the
 *   exit settles, so the real sibling shift happens at finalize: the
 *   finalize path re-snapshots the exiting root's `.layout` siblings just
 *   before teardown and FLIPs them immediately after it. Exit-wins and
 *   scrub exclusions apply exactly as for move-FLIPs; non-layout siblings
 *   snap. (Canvas: out of scope — `.layout` is a sanctioned no-op there.)
 * - `.sharedElement` (Option H) → cross-route FLIP: when a batch has
 *   navigation shape (a `detach` plus an `attach`/`insert`), a pre-pass
 *   snapshots the rect of every connected node carrying `__anim.sharedKey`
 *   that sits at-or-under one of the batch's detach roots (outgoing routes
 *   only — a persistent app-shell node sharing a key must never source a
 *   FLIP out of a still-visible element); after the batch, incoming nodes
 *   whose key matches a snapshot FLIP from the source rect (an inverted
 *   translate+scale PREPENDED to the node's base transform, transform-origin
 *   top left) with their `__anim.shared` timing, and their own `.enter` is
 *   suppressed for the batch. A zero-delta match still suppresses enter and
 *   dispatches its completion immediately (instant natural settle).
 *   Unmatched/unmeasurable keys degrade to a plain navigation; exiting
 *   nodes never participate as targets; interruption retargets for free
 *   because a mid-flight second navigation snapshots the animated
 *   presentation rect. Per-batch shared state is reset at the START of the
 *   next pre-pass as well as at the end of every flush, so a batch that
 *   throws mid-apply cannot leak stale snapshots forward.
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
 * microtask. The `.motion(essential)` opt-out (#149) exempts a node from
 * ALL of that per node: the renderer stamps `data-hypen-motion-essential`
 * (so the stylesheet kill's `:not()` passes it by) and every reduced-motion
 * shortcut in this module consults {@link DomAnimator.motionAllowed} —
 * essential nodes enter, exit, glide, and pulse exactly as if the
 * preference were off. Shared-element FLIPs remain globally skipped under
 * reduced motion (cross-route continuity is inherently decorative).
 *
 * Completion events (Option F, `.onAnimationComplete`): when a playback
 * settles NATURALLY this module dispatches the element's stored completion
 * action (see `anim-complete.ts`) — enter/exit via their settle callbacks
 * (cancelled settles fire nothing), finite `.animate` presets via a real
 * `animationend` listener (interruption — restart, class strip, suspension,
 * reduced motion — never fires one), and `.states` transitions via a timer
 * keyed off `__anim.states` label changes and sized by the node's
 * `__anim.transition` duration+delay (per-prop `transitionend` is not a
 * reliable settle signal for a multi-prop pose switch). Interrupted,
 * superseded, and reduced-motion-skipped playbacks fire NOTHING. Two
 * suppression rules extend that contract beyond cancelled settles:
 * (1) a DISCONNECTED element — a Router-detached (cached) subtree keeps
 * reconciling engine-side, but CSS transitions cannot run outside the
 * document, so enter/exit/states settles on one dispatch nothing (checked
 * at open AND fire time; canvas parity: `host.isNodeAttached`); (2) a node
 * inside an EXITING subtree is engine-side dead — settles that survive an
 * ancestor's `beginExit` (their finalize is deferred, not cancelled)
 * re-check `isInExitingSubtree` at fire time and dispatch nothing. The
 * exit completion itself fires on the exiting ROOT by design.
 */

import {
  ANIM_TRANSITION_PROP,
  ANIM_ENTER_PROP,
  ANIM_EXIT_PROP,
  ANIM_LAYOUT_PROP,
  ANIM_PROP_ANIMATE,
  ANIM_MOTION_PROP,
  ANIM_STATES_PROP,
  ANIM_SHARED_KEY_PROP,
  ANIM_SHARED_PROP,
  ANIMATABLE_PROPS,
  CURVE_TO_CSS,
  cssPropertiesFor,
  presetHiddenStyles,
  parseAnimProps,
  parseStatesLabel,
  parseMotionEssential,
  parseSharedKey,
  parseSharedSpec,
  type AnimCurve,
  type AnimateSpec,
  type NodeAnimSpecs,
  type SharedSpec,
  type TransitionSpec,
  type PresetHiddenStyle,
} from "@hypen-space/core/animation";
import { frameworkLoggers } from "@hypen-space/core/logger";
import {
  ANIM_VAR_DURATION,
  ANIM_VAR_CURVE,
  ANIM_VAR_DELAY,
  ANIM_VAR_ITERATIONS,
  ANIMATE_PRESET_ELEMENT_PROPS,
  animateClassFor,
  animateKeyframesFor,
} from "./anim-styles.js";
import { dispatchAnimationComplete } from "./anim-complete.js";

const log = frameworkLoggers.renderer;

/**
 * Marker attribute set on an exit-animating subtree root. Renderer-internal,
 * but also the hook the event layer uses to drop dispatches from exiting
 * subtrees (engine-side those ids are already dead).
 */
export const EXITING_ATTR = "data-hypen-exiting";

/**
 * Attribute stamped on nodes whose `__anim.motion` prop is
 * `{essential: true}` (the `.motion(essential)` opt-out, #149). It is the
 * CSS face of the flag: the global reduced-motion kill in `a11y-styles.ts`
 * selects `[data-hypen-id]:not([data-hypen-motion-essential])`, so stamped
 * nodes keep their CSS transitions/animations under
 * `prefers-reduced-motion: reduce`. Set on create/SetProp when the prop is
 * present (and truthy), removed on RemoveProp.
 */
export const MOTION_ESSENTIAL_ATTR = "data-hypen-motion-essential";

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

/** A measured frame — position AND size, so shared FLIPs can scale. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Per-node shared-element identity + timing (Option H). */
interface SharedEntry {
  element: HTMLElement;
  key: string | null;
  spec: SharedSpec | null;
}

/** A matched shared-element FLIP, decided at flush and played after enters. */
interface SharedPlay {
  id: string;
  element: HTMLElement;
  first: Rect;
  last: Rect;
  spec: SharedSpec;
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
 * Is `element` provably outside the document — a Router-detached (cached)
 * subtree or an already-unlinked node? CSS transitions cannot run on a
 * disconnected element, so a "settle" there never reflects motion the user
 * saw: completion dispatches are suppressed. Real DOM's `isConnected` is
 * authoritative; fake-dom (tests) doesn't implement it, so only an explicit
 * `false` counts — `undefined` means "unknown, assume connected".
 */
function isDisconnected(element: HTMLElement): boolean {
  return (element as { isConnected?: boolean }).isConnected === false;
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
  /**
   * Active `.states` pose label per node id, fed by the `__anim.states`
   * prop (`null` = default pose / no matched label). Tracked so a SetProp
   * can be recognized as a label CHANGE — only changes open a settle window.
   */
  private stateLabels = new Map<string, string | null>();
  /**
   * Pending states-settle cancellers per node id (Option F). Separate from
   * {@link settles}: a states transition runs on the node's base
   * `.transition` longhands, so its settle must not restore/retarget any
   * transition styles — it only times the completion dispatch. A superseding
   * label change cancels the pending one (which then fires nothing).
   */
  private stateSettles = new Map<string, () => void>();
  /**
   * `animationend` completion listeners for finite-repeat `.animate` presets
   * (Option F), one per node id. The listener is the natural-settle signal:
   * interruption (restart, class strip, suspension, reduced motion) never
   * produces an `animationend`, so nothing extra is needed to suppress
   * non-natural completions.
   */
  private presetEnds = new Map<string, { element: HTMLElement; listener: (event: Event) => void }>();
  /**
   * Shared-element identity/timing per node id (Option H). An entry exists
   * while the node carries `__anim.sharedKey` and/or `__anim.shared`; the
   * key is what navigation matching runs on.
   */
  private shared = new Map<string, SharedEntry>();
  /**
   * Source-side snapshots for the current navigation batch: shared key →
   * the on-screen rect (and owning id) measured in the pre-pass, BEFORE the
   * batch mutated the DOM. Interruption retargeting falls out of this for
   * free — mid-flight, `getBoundingClientRect` reflects the animated
   * transform, so a second navigation snapshots the current presentation
   * rect, never the original source. Cleared at the end of EVERY flush.
   */
  private sharedSnapshots = new Map<string, { rect: Rect; sourceId: string }>();
  /** Ids created this batch that carry a shared key (incoming candidates). */
  private sharedCreatedThisBatch = new Set<string>();
  /**
   * Roots re-attached this batch (Router cache): nodes inside them are the
   * other kind of incoming shared-element candidate. Cleared every flush.
   */
  private attachedRootsThisBatch: HTMLElement[] = [];
  /** Whether the current batch had navigation shape (detach + attach/insert). */
  private navigationBatch = false;
  /**
   * Elements whose `transform-origin` is pinned ("top left") by an in-flight
   * shared FLIP. The pin must be cleared on EVERY path that supersedes or
   * tears down the flight — the flight's own natural settle, a superseding
   * playback (enter/exit/`.layout` FLIP), `forget`, and `reset` — or the
   * element keeps the pinned origin permanently and every later transform
   * animation on it is corrupted.
   */
  private pinnedOrigins = new Map<string, HTMLElement>();
  /**
   * Shared-element dev-warning dedup (kind-prefixed keys). A persistent
   * authoring mistake (typo'd key, duplicate key) warns on the first
   * navigation that exposes it, not on every one. Cleared only by reset().
   */
  private warnedShared = new Set<string>();
  /** The first-ever batch never enter-animates (no initial-render cascade). */
  private firstBatchDone = false;
  /**
   * Transaction-scoped animation spec for the CURRENT batch (Option D cheap
   * subset). Set by the batch's leading `batchAnimation` patch, honoured by
   * {@link noteTransactionProp} for every whitelisted prop change in the same
   * batch, and cleared at the end of every flush — it never outlives its
   * batch. Precedence rule (normative): structural playbacks
   * (enter/exit/FLIP/shared) > transaction spec > node `.transition` > snap
   * — a node with an active playback settle is excluded from transaction
   * application entirely, so a stamped batch can never retarget an in-flight
   * playback's `transition-property` and snap it.
   */
  private transactionSpec: TransitionSpec | null = null;
  /**
   * Ids whose CURRENT {@link settles} entry is a transaction settle (as
   * opposed to a structural playback's). Lets the precedence check above
   * distinguish "a playback owns this node" (exclude the transaction) from
   * "an earlier transaction glide is still settling" (a new stamped batch
   * retargets it; an unstamped write snaps it — see noteTransactionProp).
   * Maintained by cancelSettle/beginSettle so a playback takeover always
   * clears the marker.
   */
  private transactionSettleIds = new Set<string>();
  /**
   * Per-node css properties written under the current/last transaction
   * stamp, tagged with the stamping batch's ordinal. `transition-property`
   * is scoped to exactly these properties (accumulated as the batch's
   * SetProps land) — never the whole whitelist — so props the stamped batch
   * did NOT write keep snapping while the settle window is open.
   */
  private transactionProps = new Map<string, { batch: number; css: string[] }>();
  /** Ordinal of the current stamped batch (bumped per beginBatchAnimation). */
  private transactionBatch = 0;
  /**
   * Inline transition longhand/shorthand values captured from the element
   * the FIRST time a transaction overwrites them, restored VERBATIM on
   * settle for nodes without an `__anim.transition` spec. This is what
   * keeps legacy string `.transition("...")` inline styling alive across a
   * stamped batch — recomputing from the (absent) spec would erase it.
   */
  private savedTransitions = new Map<
    string,
    { shorthand: string; property: string; duration: string; timing: string; delay: string }
  >();
  private reducedMotionQuery: { matches: boolean } | null = null;
  /**
   * Ids whose `__anim.motion` prop is `{essential: true}` — the
   * `.motion(essential)` reduced-motion opt-out (#149). Every reduced-motion
   * shortcut in this animator (enter skip, immediate exit finalize, states
   * settle suppression, transaction ignore) consults the flag per node via
   * {@link motionAllowed} and behaves normally for essential nodes; the
   * stylesheet side (transitions/`.animate` playback) is handled by the
   * `:not([data-hypen-motion-essential])` exemption in `a11y-styles.ts`.
   */
  private motionEssential = new Set<string>();
  /**
   * Scrub-ownership check (Option G), installed by the renderer. Precedence
   * (normative): scrub > structural playbacks > transaction > node
   * `.transition` — a scrub-active node (dragging, settling, or holding its
   * post-settle styles) is excluded from transaction application and from
   * enter/FLIP/shared-FLIP participation entirely: the scrubber owns its
   * inline styles, and a playback or transaction retargeting them would
   * fight the user's finger.
   */
  private scrubActive: (id: string) => boolean = () => false;

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
   * May `id` play motion right now? True unless reduced motion is on AND the
   * node lacks the `.motion(essential)` opt-out — the per-node form of every
   * reduced-motion check in this animator.
   */
  private motionAllowed(id: string): boolean {
    return !this.reducedMotion || this.motionEssential.has(id);
  }

  /**
   * Track a node's `.motion(essential)` flag and mirror it onto the DOM as
   * the {@link MOTION_ESSENTIAL_ATTR} attribute (the a11y stylesheet's
   * reduced-motion kill exempts stamped nodes). Clearing the flag (RemoveProp,
   * malformed value) removes the attribute — the node reverts to snapping.
   */
  private setMotionEssential(id: string, element: HTMLElement, essential: boolean): void {
    if (essential) {
      this.motionEssential.add(id);
      element.setAttribute(MOTION_ESSENTIAL_ATTR, "");
    } else {
      this.motionEssential.delete(id);
      element.removeAttribute(MOTION_ESSENTIAL_ATTR);
    }
  }

  /** Install the scrub-ownership check (see {@link scrubActive}). */
  setScrubActiveCheck(check: (id: string) => boolean): void {
    this.scrubActive = check;
  }

  /**
   * Option G × `.animate`: scrub engagement suspends a preset whose
   * keyframes animate one of the scrub's CSS targets on the element — a
   * running CSS animation outranks the scrub's inline styles and would make
   * the drag appear dead. Same machinery the structural playbacks use.
   */
  suspendPresetsForScrub(id: string, element: HTMLElement, cssTargets: string[]): void {
    this.suspendConflictingAnimate(id, element, cssTargets);
  }

  /** Scrub cleanup lifts the engagement's preset suspension. */
  resumePresetsAfterScrub(element: HTMLElement): void {
    this.resumeAnimate(element);
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
    if (ANIM_MOTION_PROP in plain) {
      this.setMotionEssential(id, element, parseMotionEssential(plain[ANIM_MOTION_PROP]));
    }
    if (ANIM_STATES_PROP in plain) {
      // Initial pose: record the label only. Create-time resolution is not a
      // transition — nothing animates, so nothing can settle or complete.
      this.stateLabels.set(id, parseStatesLabel(plain[ANIM_STATES_PROP]));
    }
    if (ANIM_SHARED_KEY_PROP in plain || ANIM_SHARED_PROP in plain) {
      const key = parseSharedKey(plain[ANIM_SHARED_KEY_PROP]);
      const spec = parseSharedSpec(plain[ANIM_SHARED_PROP]);
      if (key !== null || spec !== null) {
        this.shared.set(id, { element, key, spec });
        if (key !== null) {
          this.sharedCreatedThisBatch.add(id);
        }
      }
    }
  }

  /**
   * A `batchAnimation` patch opened this batch (Option D transaction-scoped
   * animation): parse and hold its spec so the batch's whitelisted prop
   * changes glide with it. The spec shape is the `.transition` channel's
   * (`{curve, duration, delay?, props?}` — the engine normalizes a bare
   * curve string and fills `duration` before it reaches the wire); a
   * malformed spec degrades to `null` = unstamped (sanctioned snap). Under
   * reduced motion stamps are ignored entirely.
   */
  beginBatchAnimation(spec: unknown): void {
    this.transactionBatch += 1;
    // The spec is parsed even under reduced motion: stamps are ignored
    // per NODE in noteTransactionProp (motionAllowed), so a
    // `.motion(essential)` node still glides while everything else snaps.
    this.transactionSpec = parseAnimProps({
      [ANIM_TRANSITION_PROP]: toPlain(spec),
    }).transition;
  }

  /**
   * A non-`__anim` setProp is about to land on `element`. During a STAMPED
   * batch, if the (base) prop is whitelisted, apply the TRANSACTION
   * transition longhands first — scoped to exactly the props this batch has
   * written on this node so far, never the whole whitelist — so the write
   * that follows interpolates with the batch's spec on ANY node, including
   * nodes without a `.transition` of their own AND nodes whose own
   * `.transition` already covers the prop (the transaction overrides).
   * The glide settles back to the node's base transition — its
   * `__anim.transition` styles, or the inline values captured before the
   * transaction overwrote them (legacy string `.transition("...")`), or
   * none — on the usual timeout-backbone settle.
   *
   * Precedence (normative): structural playbacks > transaction > node
   * `.transition` > snap. A node whose ACTIVE settle belongs to an
   * enter/exit/FLIP/shared playback is excluded entirely — the playback's
   * `transition-property` and settle contract are untouched. A node whose
   * active settle is a previous TRANSACTION's is retargeted (back-to-back
   * stamped batches glide seamlessly).
   *
   * During an UNSTAMPED batch: a whitelisted write to a node whose
   * transaction settle window is still open, on a prop the stamped batch
   * had written, restores the base transition FIRST so the write snaps —
   * Option D's snap-on-refresh guarantee. All other unstamped writes are
   * untouched.
   */
  noteTransactionProp(id: string, element: HTMLElement, name: string): void {
    // Applicator-namespaced names (`backgroundColor.0`) resolve to their
    // base; variant-marked names (`backgroundColor@md`, `color:hover`) are
    // not plain prop changes and never glide.
    const dot = name.indexOf(".");
    const base = dot === -1 ? name : name.slice(0, dot);
    if (base.includes("@") || base.includes(":")) return;
    if (!(base in ANIMATABLE_PROPS)) return;
    if (this.exitingRoots.has(id)) return; // exit owns the element's styles
    if (this.scrubActive(id)) return; // scrub owns the element (Option G precedence)
    // Reduced motion ignores stamps per node — only a `.motion(essential)`
    // node participates in a transaction glide while the preference is on.
    if (!this.motionAllowed(id)) return;

    const spec = this.transactionSpec;
    if (!spec) {
      // Unstamped write inside an open transaction settle window: if the
      // stamped batch had written this prop, its longhand is still in
      // `transition-property` and this write would glide with the stale
      // spec. Restore base NOW so it snaps (sanctioned Option D semantic).
      if (this.transactionSettleIds.has(id)) {
        const written = this.transactionProps.get(id);
        const css = ANIMATABLE_PROPS[base] ?? [];
        if (written && css.some((prop) => written.css.includes(prop))) {
          this.cancelSettle(id); // clears the transaction markers too
          this.restoreBaseTransition(id, element);
        }
      }
      return;
    }
    if (spec.props && !spec.props.includes(base)) return;
    // Structural playbacks win over the transaction: an active NON-transaction
    // settle means an enter/FLIP/shared/exit playback owns this element's
    // transition styles — leave the node out of the transaction entirely.
    if (this.settles.has(id) && !this.transactionSettleIds.has(id)) return;

    // Capture the element's ACTUAL inline transition values the first time a
    // transaction touches it (before the overwrite below), so settle can
    // restore legacy string `.transition("...")` styling verbatim. Not
    // re-captured while a window is open — mid-window values are ours.
    if (!this.savedTransitions.has(id)) {
      this.savedTransitions.set(id, {
        shorthand: element.style.transition ?? "",
        property: element.style.transitionProperty ?? "",
        duration: element.style.transitionDuration ?? "",
        timing: element.style.transitionTimingFunction ?? "",
        delay: element.style.transitionDelay ?? "",
      });
    }

    // Accumulate this batch's written props for the node — the transition
    // targets only ever cover props the stamped batch actually wrote.
    let written = this.transactionProps.get(id);
    if (!written || written.batch !== this.transactionBatch) {
      written = { batch: this.transactionBatch, css: [] };
    }
    for (const css of cssPropertiesFor([base])) {
      if (!written.css.includes(css)) written.css.push(css);
    }

    this.applyPlaybackTransition(element, written.css, spec);
    this.beginSettle(id, element, settleBudget(spec), () => {
      // Hand the longhands back to the node's own `.transition` (or the
      // captured inline values, or none) once the glide settles.
      this.restoreBaseTransition(id, element);
    });
    // beginSettle cleared the transaction markers (settle takeover path) —
    // re-mark this settle as transaction-owned.
    this.transactionProps.set(id, written);
    this.transactionSettleIds.add(id);
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
      case ANIM_MOTION_PROP:
        this.setMotionEssential(id, element, parseMotionEssential(toPlain(value)));
        break;
      case ANIM_STATES_PROP:
        this.noteStatesLabel(id, element, parseStatesLabel(toPlain(value)));
        break;
      case ANIM_SHARED_KEY_PROP:
        this.setSharedField(id, element, "key", parseSharedKey(toPlain(value)));
        break;
      case ANIM_SHARED_PROP:
        this.setSharedField(id, element, "spec", parseSharedSpec(toPlain(value)));
        break;
    }
  }

  /**
   * Update one half of a node's shared-element entry (`__anim.sharedKey`
   * re-resolves as an ordinary SetProp when its driving state changes).
   * When both halves are gone the entry is dropped entirely.
   */
  private setSharedField(
    id: string,
    element: HTMLElement,
    field: "key" | "spec",
    value: string | SharedSpec | null
  ): void {
    const entry = this.shared.get(id) ?? { element, key: null, spec: null };
    entry.element = element;
    if (field === "key") {
      entry.key = value as string | null;
    } else {
      entry.spec = value as SharedSpec | null;
    }
    if (entry.key === null && entry.spec === null) {
      this.shared.delete(id);
    } else {
      this.shared.set(id, entry);
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
    // Shared-element matching: nodes at-or-under a re-attached (cached
    // Router) root are incoming candidates for this batch's flush.
    this.attachedRootsThisBatch.push(root);
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
   * `move` patches whose nodes carry a `.layout` spec — and (#146) for the
   * `.layout`-carrying siblings of every `remove` patch's node, so the
   * reflow a plain removal causes FLIPs them instead of snapping. Flagged
   * (exit) removes keep the element in flow through the batch, so their
   * sibling snapshots here measure a zero delta at flush (skipped); the
   * real sibling FLIP for those runs at exit finalize (see finalizeExit).
   */
  prepareMoves(patches: readonly MovePatchLike[], getNode: (id: string) => HTMLElement | undefined): void {
    for (const patch of patches) {
      if (!patch.id) continue;
      if (patch.type === "move") {
        if (!this.specs.get(patch.id)?.layout) continue;
        if (this.exitingRoots.has(patch.id)) continue; // exit wins over FLIP
        const element = getNode(patch.id);
        const first = this.measure(element);
        if (element && first) {
          this.pendingFlips.set(patch.id, { element, first });
        }
      } else if (patch.type === "remove") {
        const removed = getNode(patch.id);
        if (!removed || isDisconnected(removed)) continue;
        for (const [id, flip] of this.collectRemovalSiblingFlips(removed)) {
          // A move snapshot (or an earlier remove's) for the same id wins —
          // the earliest First is the pre-batch truth.
          if (!this.pendingFlips.has(id)) {
            this.pendingFlips.set(id, flip);
          }
        }
      }
    }
  }

  /**
   * Snapshot the First rects of `removed`'s siblings that carry a `.layout`
   * spec (#146 sibling-shift): the nodes that will reflow when `removed`
   * leaves the parent's flow. Exit-animating siblings are excluded (exit
   * wins); unmeasurable siblings skip silently. Shared by the batch
   * pre-pass (plain removes) and the exit-finalize path (flagged removes).
   */
  private collectRemovalSiblingFlips(removed: HTMLElement): Map<string, PendingFlip> {
    const flips = new Map<string, PendingFlip>();
    const parent = (removed as { parentNode?: unknown }).parentNode as
      | { children?: ArrayLike<HTMLElement> }
      | null;
    const siblings = parent?.children;
    if (!siblings) return flips;
    for (const sibling of Array.from(siblings)) {
      if (sibling === removed) continue;
      const id = (sibling as { dataset?: Record<string, string | undefined> }).dataset?.hypenId;
      if (!id || flips.has(id)) continue;
      if (!this.specs.get(id)?.layout) continue;
      if (this.exitingRoots.has(id)) continue; // exit wins over FLIP
      const first = this.measure(sibling);
      if (first) {
        flips.set(id, { element: sibling, first });
      }
    }
    return flips;
  }

  /**
   * Shared-element pre-pass (Option H, protocol step 1): when the batch has
   * navigation shape — BOTH a `detach` (route leaving) AND an
   * `attach`/`insert` (route arriving) — snapshot the on-screen rect of
   * every currently-connected node carrying a shared key that sits
   * at-or-under one of the batch's detach roots, keyed by that key, BEFORE
   * the batch mutates the DOM. Sources are restricted to the leaving
   * subtree(s): a persistent app-shell node sharing a key stays visible
   * after the navigation, so it must neither produce a FLIP out of a
   * still-on-screen element nor shadow the real outgoing source via the
   * first-wins guard. Non-navigation batches never snapshot. Disconnected
   * or unmeasurable (zero-rect) sources are skipped silently; duplicate
   * source keys keep the first (dev warn, once per key). Under reduced
   * motion no snapshot is taken — no FLIP will play.
   */
  prepareShared(
    patches: readonly MovePatchLike[],
    getNode: (id: string) => HTMLElement | undefined
  ): void {
    // Per-batch shared state resets HERE, not only at the end of flush(): a
    // batch that throws mid-apply skips flush(), and a stale snapshot left
    // behind would win the first-wins duplicate guard over the fresh one on
    // the next navigation.
    this.sharedSnapshots.clear();
    this.sharedCreatedThisBatch.clear();
    this.attachedRootsThisBatch = [];
    this.navigationBatch = false;
    if (this.reducedMotion) return;
    const detachRoots: HTMLElement[] = [];
    let hasDetach = false;
    let hasIncoming = false;
    for (const patch of patches) {
      if (patch.type === "detach") {
        hasDetach = true;
        const root = patch.id ? getNode(patch.id) : undefined;
        if (root) detachRoots.push(root);
      } else if (patch.type === "attach" || patch.type === "insert") {
        hasIncoming = true;
      }
    }
    if (!hasDetach || !hasIncoming) return;
    this.navigationBatch = true;

    const duplicates: string[] = [];
    for (const [id, entry] of this.shared) {
      if (entry.key === null) continue;
      const element = entry.element;
      // Outgoing sources only: the node must be leaving the screen with a
      // detached subtree. Still-visible keyed nodes are not sources.
      if (!detachRoots.some((root) => element === root || isWithinSubtree(element, root))) {
        continue;
      }
      if (isDisconnected(element)) continue;
      const rect = this.measureRect(element);
      if (!rect) continue;
      if (this.sharedSnapshots.has(entry.key)) {
        duplicates.push(entry.key);
        continue; // first wins
      }
      this.sharedSnapshots.set(entry.key, { rect, sourceId: id });
    }
    this.warnSharedOnce(
      "duplicate-source",
      duplicates,
      (fresh) =>
        `Duplicate shared-element source keys in one navigation (first wins): ${fresh.join(", ")}`
    );
  }

  /**
   * Shared-element dev diagnostics: emitted at WARN — visible at the
   * logger's default "info" level so authoring mistakes (typo'd keys,
   * duplicates) surface without opting into debug mode, and still silent in
   * production "error"-level builds — and deduplicated per kind-prefixed
   * key for the renderer's lifetime (see {@link warnedShared}).
   */
  private warnSharedOnce(
    kind: string,
    keys: string[],
    message: (fresh: string[]) => string
  ): void {
    const fresh = keys.filter((key) => !this.warnedShared.has(`${kind}:${key}`));
    if (fresh.length === 0) return;
    for (const key of fresh) {
      this.warnedShared.add(`${kind}:${key}`);
    }
    log.warn(message(fresh));
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
    // The transaction-animation stamp is strictly batch-scoped: whatever
    // SetProps it was going to glide have already been applied by now.
    this.transactionSpec = null;

    // Shared-element matching runs before enters play: a matched node's own
    // enter is suppressed for this batch (one motion, not two). The collect
    // also drains the per-batch shared state — snapshot maps never leak
    // across batches.
    const { plays, suppressed } = this.collectSharedFlips();
    this.sharedSnapshots.clear();
    this.sharedCreatedThisBatch.clear();
    this.attachedRootsThisBatch = [];
    this.navigationBatch = false;

    // Reduced motion is a per-node decision (#149): `.motion(essential)`
    // nodes still play their enters and FLIPs while everything else skips.
    // (Shared-element FLIPs stay globally skipped — prepareShared takes no
    // snapshots under reduced motion, so `plays` is empty then.)
    if (!suppressEnters) {
      for (const [id, element] of enters) {
        if (suppressed.has(id)) continue;
        if (!this.motionAllowed(id)) continue;
        this.playEnter(id, element);
      }
    }
    for (const [id, flip] of flips) {
      if (!this.motionAllowed(id)) continue;
      this.playFlip(id, flip);
    }
    for (const play of plays) {
      this.playSharedFlip(play);
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
    // A cancelled settle also never dispatches its completion — interrupted
    // playbacks fire nothing. Likewise any pending states settle: the node
    // is leaving, its states transition is superseded.
    this.cancelSettle(id);
    this.cancelStateSettle(id);
    // A superseded shared FLIP's pinned transform-origin must not survive
    // into (or past) the exit — its cancelled settle never clears it.
    this.clearPinnedOrigin(id);

    element.setAttribute(EXITING_ATTR, "");
    element.setAttribute("inert", "");
    element.style.pointerEvents = "none";

    const record: ExitingRoot = {
      element,
      finalizeRoot: finalize,
      descendantFinalizes: [],
    };
    this.exitingRoots.set(id, record);

    if (!this.motionAllowed(id)) {
      // Reduced motion (and no `.motion(essential)` opt-out): no playback,
      // but teardown still defers one microtask so the descendant Removes in
      // this batch can queue on the root first.
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
    this.beginSettle(id, element, settleBudget(spec), () => {
      // Natural settle: the completion fires just before finalize (the only
      // moment the element is both done animating and still alive). The
      // reduced-motion and zero-target snap paths above finalize without a
      // settle and fire nothing, as does finalizeNow (interruption). An exit
      // reconciled into a Router-detached subtree (disconnected element)
      // finalizes silently — no transition ever played. This is deliberately
      // NOT an isInExitingSubtree guard: the exit root itself carries
      // EXITING_ATTR and its completion must fire.
      if (!isDisconnected(element)) {
        dispatchAnimationComplete(element, { animation: "exit" });
      }
      this.finalizeExit(id);
    });
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
    this.cancelStateSettle(id);
    this.clearPinnedOrigin(id);
    this.removePresetEndListener(id);
    this.savedTransitions.delete(id);
    this.specs.delete(id);
    this.animateElements.delete(id);
    this.motionEssential.delete(id);
    this.stateLabels.delete(id);
    this.createdThisBatch.delete(id);
    this.pendingEnters.delete(id);
    this.pendingFlips.delete(id);
    this.shared.delete(id);
    this.sharedCreatedThisBatch.delete(id);
  }

  /** Cancel all in-flight work and drop all caches (renderer `clear()`). */
  reset(): void {
    for (const cancel of this.settles.values()) {
      cancel();
    }
    this.settles.clear();
    for (const cancel of this.stateSettles.values()) {
      cancel();
    }
    this.stateSettles.clear();
    for (const { element, listener } of this.presetEnds.values()) {
      element.removeEventListener("animationend", listener);
    }
    this.presetEnds.clear();
    this.stateLabels.clear();
    this.exitingRoots.clear();
    this.specs.clear();
    this.animateElements.clear();
    this.motionEssential.clear();
    this.pendingEnters.clear();
    this.pendingFlips.clear();
    this.createdThisBatch.clear();
    this.shared.clear();
    this.sharedSnapshots.clear();
    this.sharedCreatedThisBatch.clear();
    this.attachedRootsThisBatch = [];
    for (const element of this.pinnedOrigins.values()) {
      element.style.transformOrigin = "";
    }
    this.pinnedOrigins.clear();
    this.warnedShared.clear();
    this.navigationBatch = false;
    this.transactionSpec = null;
    this.transactionSettleIds.clear();
    this.transactionProps.clear();
    this.savedTransitions.clear();
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
      this.removePresetEndListener(id);
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
    this.ensurePresetEndListener(id, element);
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

  /**
   * Install the (single) `animationend` completion listener for a node with
   * a live `.animate` spec. `animationend` IS the natural-settle signal:
   * looping presets never emit one, and every interruption path — restart
   * (class removed before re-add), `removeProp` (class stripped), playback
   * suspension (`animation: none`), reduced motion (`animation: none
   * !important`) — cancels the CSS animation without firing it. The listener
   * re-reads the current spec per event, so it needs no reinstalling when
   * the spec changes.
   */
  private ensurePresetEndListener(id: string, element: HTMLElement): void {
    if (this.presetEnds.has(id)) return;
    const listener = (event: Event) => {
      if (event.target && event.target !== element) return; // bubbled descendant
      const spec = this.specs.get(id)?.animate;
      if (!spec || spec.repeat === "loop") return; // no spec / loops never complete
      // Only the preset's own keyframes count — a foreign CSS animation
      // ending on the element must not masquerade as the preset completing.
      const animationName = (event as { animationName?: unknown }).animationName;
      if (typeof animationName === "string" && animationName !== animateKeyframesFor(spec.preset)) {
        return;
      }
      // Exit-animating subtrees are engine-side dead (the event layer drops
      // their dispatches too) — a preset finishing on a corpse fires nothing.
      if (isInExitingSubtree(element)) return;
      dispatchAnimationComplete(element, { animation: spec.preset });
    };
    element.addEventListener("animationend", listener);
    this.presetEnds.set(id, { element, listener });
  }

  /** Remove a node's preset completion listener (spec cleared / forget). */
  private removePresetEndListener(id: string): void {
    const entry = this.presetEnds.get(id);
    if (entry) {
      this.presetEnds.delete(id);
      entry.element.removeEventListener("animationend", entry.listener);
    }
  }

  /**
   * `__anim.states` label update. A label CHANGE means the engine switched
   * poses and the node's `.transition` (the `.states`-synthesized one, or an
   * explicit `.transition` that beat it) is now interpolating the overridden
   * props — open a settle window of the spec's duration+delay and dispatch
   * `{ animation: "states", state: label }` when it expires. Per-prop
   * `transitionend` is useless here (a pose switches many props; some may
   * not visibly change), so the timer is the settle signal. Fires nothing
   * when: the label did not change (re-resolve to the same pose), the new
   * pose is the default (`null` — no matched label to report), reduced
   * motion (transitions snap), the node is exiting (itself or under an
   * exiting ancestor — engine-side dead), the element is disconnected (a
   * Router-detached cached subtree: no CSS transition can play off-document),
   * an enter/FLIP/exit playback is in flight (it owns `transition-property`,
   * so the pose props SNAP), or no transition spec exists (non-animated pose
   * switch snaps). A superseding label change cancels the pending window —
   * natural settles only — and the exiting/disconnected conditions are
   * re-checked at fire time, since an ancestor's exit or a detach can begin
   * mid-window without cancelling this node's timer.
   */
  private noteStatesLabel(id: string, element: HTMLElement, label: string | null): void {
    const previous = this.stateLabels.get(id) ?? null;
    this.stateLabels.set(id, label);
    if (label === previous) return;
    this.cancelStateSettle(id);
    if (label === null) return;
    if (!this.motionAllowed(id)) return; // reduced motion: pose switch snaps (no .motion(essential))
    if (this.exitingRoots.has(id) || isInExitingSubtree(element)) return;
    if (isDisconnected(element)) return;
    if (this.settles.has(id)) return; // active playback retargeted transition-property: the pose snaps
    const spec = this.specs.get(id)?.transition;
    if (!spec) return;
    const timer = setTimeout(() => {
      this.stateSettles.delete(id);
      // Re-check at fire time: beginExit only cancels the window for the
      // exit ROOT's own id — a descendant's window survives the ancestor's
      // exit (its finalize is deferred, not cancelled) and must fire
      // nothing, as must a node detached (Router cache) mid-window.
      if (isInExitingSubtree(element) || isDisconnected(element)) return;
      dispatchAnimationComplete(element, { animation: "states", state: label });
    }, spec.duration + (spec.delay ?? 0));
    this.stateSettles.set(id, () => clearTimeout(timer));
  }

  /** Stand down the pending states settle for `id`, if any (fires nothing). */
  private cancelStateSettle(id: string): void {
    const cancel = this.stateSettles.get(id);
    if (cancel) {
      this.stateSettles.delete(id);
      cancel();
    }
  }

  private applyPlaybackTransition(element: HTMLElement, targets: string[], timing: Timing): void {
    element.style.transitionProperty = targets.join(", ");
    element.style.transitionDuration = `${timing.duration}ms`;
    element.style.transitionTimingFunction = CURVE_TO_CSS[timing.curve];
    element.style.transitionDelay = timing.delay ? `${timing.delay}ms` : "";
  }

  /**
   * After a playback settles, hand the longhands back to the node's
   * `.transition` spec — or, for a node with no spec whose inline values
   * were captured before a transaction overwrote them (legacy string
   * `.transition("...")`), restore the captured values verbatim.
   */
  private restoreBaseTransition(id: string, element: HTMLElement): void {
    const saved = this.savedTransitions.get(id);
    this.savedTransitions.delete(id);
    const spec = this.specs.get(id)?.transition ?? null;
    if (spec || !saved) {
      this.applyTransitionStyles(element, spec);
      return;
    }
    if (saved.shorthand) element.style.transition = saved.shorthand;
    element.style.transitionProperty = saved.property;
    element.style.transitionDuration = saved.duration;
    element.style.transitionTimingFunction = saved.timing;
    element.style.transitionDelay = saved.delay;
  }

  private playEnter(id: string, element: HTMLElement): void {
    const spec = this.specs.get(id)?.enter;
    if (!spec || this.exitingRoots.has(id)) return;
    if (this.scrubActive(id)) return; // scrub owns the element (Option G precedence)
    const pose = presetHiddenStyles(spec.presets, spec.from, isRtl(element));
    const targets = poseProperties(pose);
    if (targets.length === 0) return;

    const finalOpacity = element.style.opacity ?? "";
    const finalTransform = element.style.transform ?? "";

    // A preset animating the same properties would mask the pose entirely.
    this.suspendConflictingAnimate(id, element, targets);

    // Superseding a shared FLIP cancels its settle without running it —
    // the pinned transform-origin must be cleared here instead.
    this.clearPinnedOrigin(id);

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
      // Natural settle only: a superseded enter's settle is cancelled
      // (beginSettle/beginExit), and reduced motion never queues playback —
      // neither ever reaches this dispatch. Two conditions can still arise
      // mid-flight WITHOUT cancelling this settle and must fire nothing: an
      // ANCESTOR began exiting (this node's own remove was deferred via
      // deferToExitingAncestor — engine-side dead; canvas parity: playEnter's
      // onSettled checks inExitingSubtree) or the node was Router-detached
      // (disconnected: the transition stopped playing off-document).
      if (isInExitingSubtree(element) || isDisconnected(element)) return;
      dispatchAnimationComplete(element, { animation: "enter" });
    });
  }

  private playFlip(id: string, flip: PendingFlip): void {
    const spec = this.specs.get(id)?.layout;
    if (!spec || this.exitingRoots.has(id)) return; // exit wins over FLIP
    if (this.scrubActive(id)) return; // scrub owns the element (Option G precedence)
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

    // Retargeting `transition-property` to "transform" snaps any in-flight
    // states pose transition — its pending completion window is superseded
    // and must fire nothing.
    this.cancelStateSettle(id);

    // This playback owns the transform now: a superseded shared FLIP's
    // pinned transform-origin must not survive into it (its cancelled
    // settle will never clear the pin).
    this.clearPinnedOrigin(id);

    // Invert: place the node back at its First position, transitions off.
    // The invert PREPENDS: the viewport-measured delta must apply before
    // (outside) the node's base transform — translations prepend exactly
    // under any base.
    element.style.transitionProperty = "none";
    element.style.transform = finalTransform ? `${invert} ${finalTransform}` : invert;
    forceReflow(element);

    // …then Play back to identity.
    this.applyPlaybackTransition(element, ["transform"], spec);
    element.style.transform = finalTransform;
    this.beginSettle(id, element, settleBudget(spec), () => {
      this.restoreBaseTransition(id, element);
      this.resumeAnimate(element);
    });
  }

  /**
   * Decide this batch's shared-element FLIPs (Option H, protocol step 3).
   * Incoming nodes — created this batch, or at/under a re-attached root —
   * whose key matches a pre-pass snapshot become FLIP targets. Exiting
   * nodes never participate as targets (exit wins); a snapshot whose source
   * is the target itself (a cached subtree matching its own stale snapshot)
   * is no match; unmeasurable targets skip silently; duplicate target keys
   * keep the first (dev warn, once per key). Every match — even a
   * zero-delta one — suppresses the node's own enter for this batch: the
   * element visually persisted across the navigation, so entering would be
   * a second motion. A zero-delta match additionally dispatches
   * `{ animation: "sharedElement" }` immediately — nothing plays, which IS
   * an instant natural settle, and a module machine waiting on
   * `.onAnimationComplete` must not stall geometry-dependently. Keys
   * present on only one side of the navigation warn once per key; a
   * matched target with no timing spec (sanctioned snap) and a snapshot
   * matching its own node (the node persisted) are neither matches nor
   * typos and are excluded from that warning.
   */
  private collectSharedFlips(): { plays: SharedPlay[]; suppressed: Set<string> } {
    const plays: SharedPlay[] = [];
    const suppressed = new Set<string>();
    if (!this.navigationBatch) return { plays, suppressed };

    const matchedKeys = new Set<string>();
    /** Keys excluded from the unmatched warning without being FLIP matches. */
    const unreportable = new Set<string>();
    const targetOnly: string[] = [];
    const duplicateTargets: string[] = [];

    for (const [id, entry] of this.shared) {
      const { element, key, spec } = entry;
      if (key === null) continue;
      const incoming =
        this.sharedCreatedThisBatch.has(id) ||
        this.attachedRootsThisBatch.some(
          (root) => element === root || isWithinSubtree(element, root)
        );
      if (!incoming) continue;
      if (this.exitingRoots.has(id) || isInExitingSubtree(element)) continue; // exit wins
      const snapshot = this.sharedSnapshots.get(key);
      if (!snapshot) {
        targetOnly.push(key);
        continue;
      }
      if (snapshot.sourceId === id) {
        // Self-snapshot (a cached subtree matching its own stale snapshot):
        // the node persisted across the navigation — no match, but present
        // on both sides, so not a typo either.
        unreportable.add(key);
        continue;
      }
      if (matchedKeys.has(key)) {
        duplicateTargets.push(key);
        continue; // first match wins
      }
      if (spec === null) {
        // Matched, but no timing spec — sanctioned snap, not an unmatched key.
        unreportable.add(key);
        continue;
      }
      const last = this.measureRect(element);
      if (!last) continue; // unmeasurable target — plain navigation
      matchedKeys.add(key);
      suppressed.add(id);
      const first = snapshot.rect;
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      const sx = first.width / last.width;
      const sy = first.height / last.height;
      if (
        Math.abs(dx) < 0.5 &&
        Math.abs(dy) < 0.5 &&
        Math.abs(sx - 1) < 0.005 &&
        Math.abs(sy - 1) < 0.005
      ) {
        // Zero delta: already in place, nothing to play — an INSTANT
        // natural settle. The completion still fires (nothing was
        // interrupted; consistency with the natural-settle-only contract).
        dispatchAnimationComplete(element, { animation: "sharedElement" });
        continue;
      }
      plays.push({ id, element, first, last, spec });
    }

    const sourceOnly: string[] = [];
    for (const key of this.sharedSnapshots.keys()) {
      if (!matchedKeys.has(key) && !unreportable.has(key)) sourceOnly.push(key);
    }
    const freshSource = sourceOnly.filter((key) => !this.warnedShared.has(`unmatched:${key}`));
    const freshTarget = targetOnly.filter((key) => !this.warnedShared.has(`unmatched:${key}`));
    if (freshSource.length > 0 || freshTarget.length > 0) {
      for (const key of freshSource) this.warnedShared.add(`unmatched:${key}`);
      for (const key of freshTarget) this.warnedShared.add(`unmatched:${key}`);
      log.warn(
        "Shared-element keys matched nothing this navigation " +
          `(source-only: [${freshSource.join(", ")}], target-only: [${freshTarget.join(", ")}])`
      );
    }
    this.warnSharedOnce(
      "duplicate-target",
      duplicateTargets,
      (fresh) =>
        `Duplicate shared-element target keys in one navigation (first wins): ${fresh.join(", ")}`
    );

    return { plays, suppressed };
  }

  /**
   * Play one shared-element FLIP (Option H, protocol step 3): pose the
   * incoming node over the source rect by PREPENDING an inverted
   * translate+scale to the node's base transform. CSS transforms compose
   * left-to-right, so the correction must come FIRST to apply in viewport
   * space — appended after a non-identity base (a `.states` scale pose, a
   * translateX applicator) the viewport-measured delta would be distorted
   * by the base's coordinate space and the FLIP would start off-target.
   * Prepending is exact for translate bases and the identity case;
   * rotation (and, combined with the origin pin, scale) bases remain
   * approximate — accepted v1 degradation. The transform-origin is pinned
   * to top left so the inverted scale math is exact; the pin is tracked in
   * {@link pinnedOrigins} and cleared on EVERY superseding/teardown path,
   * not just this playback's own settle. The detached source is not
   * resurrected — no overlay proxies in v1. Settling naturally hands the
   * base transition back, restores the base transform and unpins the
   * origin in the same synchronous update (no intermediate pinned frame),
   * and dispatches `{ animation: "sharedElement" }` via the completion
   * channel (natural-settle-only, like every other playback).
   */
  private playSharedFlip(play: SharedPlay): void {
    const { id, element, first, last, spec } = play;
    if (this.exitingRoots.has(id)) return; // exit wins (defensive re-check)
    if (this.scrubActive(id)) return; // scrub owns the element (Option G precedence)
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sx = first.width / last.width;
    const sy = first.height / last.height;

    const finalTransform = element.style.transform ?? "";
    const invert = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;

    // A transform-keyframing preset (spin/shake) would mask the invert.
    this.suspendConflictingAnimate(id, element, ["transform"]);

    // Retargeting `transition-property` to "transform" snaps any in-flight
    // states pose transition — its pending completion fires nothing.
    this.cancelStateSettle(id);

    // Inverted scale math is only exact from a known origin: pin top left
    // explicitly for the playback. A stale pin from an interrupted earlier
    // flight is replaced, not stacked.
    this.clearPinnedOrigin(id);
    element.style.transformOrigin = "top left";
    this.pinnedOrigins.set(id, element);

    // Invert: pose the node over the source rect, transitions off…
    element.style.transitionProperty = "none";
    element.style.transform = finalTransform ? `${invert} ${finalTransform}` : invert;
    forceReflow(element);

    // …then play back to the base transform with the node's shared timing.
    this.applyPlaybackTransition(element, ["transform"], spec);
    element.style.transform = finalTransform;
    this.beginSettle(id, element, settleBudget(spec), () => {
      this.restoreBaseTransition(id, element);
      this.resumeAnimate(element);
      // Base transform and origin unpin land in the same synchronous
      // update, after the playback transition is handed back — no frame
      // renders the base transform still pinned to top left.
      element.style.transform = finalTransform;
      this.clearPinnedOrigin(id);
      // Natural settle only (enter parity): superseded settles are
      // cancelled and fire nothing; a node that began exiting under an
      // ancestor or was Router-detached mid-flight dispatches nothing.
      if (isInExitingSubtree(element) || isDisconnected(element)) return;
      dispatchAnimationComplete(element, { animation: "sharedElement" });
    });
  }

  /**
   * Unpin an element's shared-FLIP transform-origin, if one is tracked.
   * Called from the flight's own settle AND from every path that
   * supersedes or tears the flight down (playEnter/playFlip/beginExit via
   * their beginSettle takeover, forget, reset) — a cancelled settle never
   * runs, so it can never be the one to clear the pin.
   */
  private clearPinnedOrigin(id: string): void {
    const element = this.pinnedOrigins.get(id);
    if (element) {
      this.pinnedOrigins.delete(id);
      element.style.transformOrigin = "";
    }
  }

  /**
   * Measure a full frame (position AND size) for shared-element FLIPs. A
   * zero-area rect — a disconnected or unlaid-out element — is
   * unmeasurable and returns `null` (protocol step 4: silent skip).
   */
  private measureRect(element: HTMLElement | undefined): Rect | null {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    try {
      const rect = element.getBoundingClientRect();
      if (
        !rect ||
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.top) ||
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height) ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        return null;
      }
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    } catch {
      return null;
    }
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
    // Sibling-shift FLIP for flagged removes (#146): the exiting root held
    // its place in flow for the whole playback — its siblings shift only
    // NOW, when teardown actually unlinks it. Snapshot the `.layout`
    // siblings' First rects before the teardown below... (Skipped for a
    // disconnected root — a Router-detached subtree reflows nothing
    // on-screen — and for reduced motion, per node, via motionAllowed.)
    const siblingFlips = isDisconnected(record.element)
      ? new Map<string, PendingFlip>()
      : this.collectRemovalSiblingFlips(record.element);
    // Descendants first (their Removes arrived after the flagged root), the
    // root's own teardown last.
    for (const finalize of record.descendantFinalizes) {
      finalize();
    }
    record.finalizeRoot();
    // ...and play them immediately — no batch flush follows an exit settle.
    // playFlip re-measures Last (post-teardown), skips zero deltas, and
    // applies the exit-wins/scrub exclusions itself.
    for (const [flipId, flip] of siblingFlips) {
      if (!this.motionAllowed(flipId)) continue;
      this.playFlip(flipId, flip);
    }
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
        this.transactionSettleIds.delete(id);
        this.transactionProps.delete(id);
        done();
      })
    );
  }

  /**
   * Stand down the pending settle for `id`, if any, without running it.
   * Also drops the transaction-settle markers: whatever supersedes the
   * settle (a structural playback, an unstamped snap, forget) ends the
   * transaction's ownership of the node. The captured inline transition
   * values (savedTransitions) survive — a superseding playback's own settle
   * consumes them via restoreBaseTransition.
   */
  private cancelSettle(id: string): void {
    this.transactionSettleIds.delete(id);
    this.transactionProps.delete(id);
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
