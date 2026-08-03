/**
 * DOM scrub-binding runtime (Option G — `__anim.scrub*` channel consumption).
 *
 * The engine lowers a valid `.scrub`/`.settle` pair into FOUR static props
 * (see `@hypen-space/core/animation`): `__anim.scrub` (source spec),
 * `__anim.scrubSettle` (release timing), `__anim.scrubBind` (dotted state
 * path) and `__anim.scrubPoses` (materialized `[fromValue, toValue]`
 * endpoints per pose-overridden prop key). This module is the DOM side of
 * that contract — the renderer-resident per-frame loop that NEVER touches
 * the engine while the source is live (§6.1: raw high-frequency input stays
 * local; only meaning — the settle write — crosses the boundary).
 *
 * - GESTURE source: `pointerdown` on the element opens a PENDING drag; the
 *   gesture is claimed (pointer captured, phase `dragging`) only once travel
 *   along the axis exceeds a small slop (~6px), so a plain tap is a TOTAL
 *   no-op — no capture, no settle, no bind write, child clicks unaffected.
 *   (Catching a mid-settle element claims immediately: the settle must not
 *   fight the finger, and a frozen settle could not survive a no-op release.)
 *   The mapping is RELATIVE to the pose the finger grabbed:
 *   `p = pAtGrab + travel / (over[1] - over[0])`, rubber-banded on the
 *   RESULT beyond `[0,1]` (`p' = bound + (p - bound) * rubberBand`). The
 *   anchor `pAtGrab` is the node's live progress at grab — a settled-open
 *   sheet re-drags from 1, a mid-settle catch continues from the settle's
 *   current progress, and `over` ranges that don't start at 0 never jump.
 *   The anchor progress is seeded from the engine's `__anim.states` label
 *   (label == from → 0, label == to → 1) at create and on every label feed
 *   that lands while no interaction owns the node. Only the drag's own
 *   pointer (`pointerId`) drives move/up/cancel — a second finger is noise.
 *   Interpolated inline styles per `__anim.scrubPoses` key: numeric lerp,
 *   the core RGBA color interpolation for color props, CSS property names
 *   via the animatable whitelist, transform-ish props composed into one
 *   `transform` string PREFIXED by the element's base transform minus the
 *   scrub-owned function kinds (a static `rotate(45)` applicator survives
 *   the drag). Zero engine traffic during the drag.
 *
 * - VELOCITY + SETTLE (gesture): the last ~5 pointer samples (timestamps
 *   from the injectable clock) yield a progress velocity; samples older
 *   than ~100ms at release are discarded (drag-hold-release must not
 *   project a stale burst; an empty window is v = 0). On `pointerup` the
 *   projected `p* = p + v · 150ms` picks the target (`p* >= 0.5` → to,
 *   else from). The settle is a rAF-driven inline-style animation over
 *   `scrubSettle.duration` with the shared numeric curve function — NOT a
 *   CSS transition, deliberately: (1) it re-drives the exact interpolation
 *   path the drag used, so drag and settle are pixel-consistent (including
 *   the transform composition this module owns); (2) arrival must be an
 *   exact observable event — the bind write fires ON arrival, and
 *   `transitionend` neither fires reliably (off-document, reduced motion)
 *   nor reports multi-prop completion; (3) a grab mid-settle needs the
 *   current progress, which only the tick loop knows; (4) the clock and rAF
 *   are injectable, so tests drive frames deterministically (the canvas
 *   animator's tick approach, ported to inline styles).
 *
 * - On arrival the winning pose LABEL is dispatched through the exact
 *   `.bind` write channel — `dispatchAction("__hypen_bind", {path, value})`
 *   on the element's engine — and the final inline styles are KEPT until
 *   the engine's re-render lands (no flash): cleanup runs on the FIRST
 *   `__anim.states` label SetProp, matching or not — any label proves the
 *   engine re-render landed, and a raced different label must not hold
 *   stale visuals until the ~500ms timeout fallback and then snap.
 *
 * - SCROLL source: a scroll listener on the container — the ancestor whose
 *   resolved `id` prop equals `of:` when given (one-time dev warn + nearest
 *   scrollable fallback when it matches nothing), else the nearest
 *   scrollable ancestor. `scrollTop`/`scrollLeft` maps through `over`
 *   (absolute — scroll offsets are absolute input). There is no release:
 *   progress tracks continuously, and the bind write fires when progress
 *   crosses AND RESTS at an endpoint (debounced ~150ms at p == 0 / p == 1).
 *   Deferral and ownership are bounded by ACTIVE input: after ~150ms of
 *   scroll quiescence mid-range, deferred engine writes flush (concede —
 *   engine values land; the next scroll event re-derives scrub styles from
 *   current progress) and ownership (transaction/FLIP exclusion) releases,
 *   re-claimed by the next scroll event. Cleanup that lands while the
 *   scroll rests MID-RANGE flushes deferred state but re-derives the scrub
 *   styles from live progress instead of removing them — styles drop only
 *   at an endpoint rest or teardown.
 *
 * - CONFLICTS (gesture wins): while a drag/settle/cleanup-window is active,
 *   engine SetProps to scrubbed prop keys on the node are deferred (latest
 *   value stored, applied at cleanup); other props flow normally. The
 *   renderer routes that through {@link deferEngineProp}. A remove/detach
 *   mid-drag cancels everything and releases pointer capture cleanly — an
 *   exiting node's scrub sources detach immediately, BEFORE any exit
 *   playback, and a cancelled settle never dispatches its bind write.
 *   Precedence (normative): scrub > structural playbacks > transaction >
 *   node `.transition` — a scrub-active node is excluded from transaction
 *   application and enter/FLIP participation (the DomAnimator consults
 *   {@link ownsNode}), and scrub engagement suspends a conflicting
 *   `.animate` preset via the animator's suspend machinery (a running CSS
 *   animation would beat the scrub's inline styles); cleanup resumes it.
 *
 * - REDUCED MOTION: dragging works unchanged — direct manipulation is the
 *   user's own hand, exempt by spec rule. Release settles INSTANTLY (no
 *   animation) and then writes.
 */

import {
  ANIM_SCRUB_PROP,
  ANIM_SCRUB_SETTLE_PROP,
  ANIM_SCRUB_BIND_PROP,
  ANIM_SCRUB_POSES_PROP,
  ANIM_MOTION_PROP,
  ANIM_STATES_PROP,
  ANIMATABLE_PROPS,
  animatableBaseProp,
  curveFunction,
  interpolateColor,
  parseColorValue,
  parseMotionEssential,
  parseScrubBind,
  parseScrubPoses,
  parseScrubSettle,
  parseScrubSpec,
  parseStatesLabel,
  scrubProgress,
  type RgbaColor,
  type ScrubPoses,
  type ScrubSettleSpec,
  type ScrubSpec,
} from "@hypen-space/core/animation";
import { frameworkLoggers } from "@hypen-space/core/logger";
import { getEngine } from "./element-data.js";

const log = frameworkLoggers.renderer;

/** Milliseconds of velocity projection applied to the release progress. */
export const SCRUB_PROJECTION_MS = 150;
/** Axis travel (px) below which a gesture is a tap, not a drag claim. */
export const SCRUB_SLOP_PX = 6;
/** Pointer samples kept for the velocity estimate. */
const VELOCITY_SAMPLES = 5;
/** Samples older than this at release are stale — never projected. */
const VELOCITY_WINDOW_MS = 100;
/** Default cleanup timeout after the settle write (the no-flash fallback). */
const DEFAULT_CLEANUP_TIMEOUT_MS = 500;
/** Default rest debounce for the scroll source's endpoint write. */
const DEFAULT_REST_DEBOUNCE_MS = 150;

/** What the scrubber needs from the renderer. */
export interface DomScrubberHost {
  /**
   * Re-apply a deferred engine prop write through the renderer's normal
   * SetProp path (the scrubber marks the node idle first, so the write is
   * not re-deferred).
   */
  applyProp(id: string, name: string, value: unknown): void;
  /**
   * Scrub engagement: suspend a `.animate` preset whose keyframes animate
   * one of `cssTargets` on the element (the DomAnimator's suspend
   * machinery — a running CSS animation beats inline styles and would make
   * the drag appear dead).
   */
  suspendPresets(id: string, element: HTMLElement, cssTargets: string[]): void;
  /** Scrub cleanup: lift the preset suspension. */
  resumePresets(element: HTMLElement): void;
}

/** One interpolation lane derived from a `__anim.scrubPoses` entry. */
type PropPlan =
  | {
      kind: "transform";
      fn: "translateX" | "translateY" | "scale" | "rotate";
      from: number;
      to: number;
    }
  | { kind: "numeric"; css: readonly string[]; unit: "px" | ""; from: number; to: number }
  | { kind: "color"; css: readonly string[]; from: RgbaColor; to: RgbaColor }
  | { kind: "discrete"; css: readonly string[]; from: string; to: string };

/** Fixed composition order for scrubbed transform functions. */
const TRANSFORM_ORDER = ["translateX", "translateY", "scale", "rotate"] as const;
type TransformFn = (typeof TRANSFORM_ORDER)[number];

const TRANSFORM_UNITS: Record<TransformFn, string> = {
  translateX: "px",
  translateY: "px",
  scale: "",
  rotate: "deg",
};

/** Whitelist props whose values are colors. */
const COLOR_PROPS = new Set(["color", "backgroundColor", "borderColor"]);
/** CSS properties written without a unit. */
const UNITLESS_CSS = new Set(["opacity"]);

/** Coerce a pose endpoint to a finite number (`16`, `"16"`, `"16px"`). */
function parseNumericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d*\.?\d+(px)?$/.test(value.trim())) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Rubber-band a RELATIVE progress result beyond `[0, 1]`. */
function rubberBandProgress(raw: number, rubberBand: number): number {
  if (raw < 0) return raw * rubberBand;
  if (raw > 1) return 1 + (raw - 1) * rubberBand;
  return raw;
}

/**
 * Remove the transform functions named in `fns` from a CSS transform
 * string, keeping everything else in order. Used to compose the scrub's
 * transform lanes with the element's static base transform (the base minus
 * the scrub-owned kinds is prepended), and to restore the base minus the
 * kinds a deferred engine write is about to re-append.
 */
function stripTransformFns(transform: string, fns: ReadonlySet<string>): string {
  if (!transform || fns.size === 0) return transform;
  const parts = transform.match(/[a-zA-Z][a-zA-Z0-9]*\([^)]*\)/g);
  if (!parts) return transform;
  return parts.filter((part) => !fns.has(part.slice(0, part.indexOf("(")))).join(" ");
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

interface DragState {
  pointerId: number | null;
  /** Pointer position along the axis at `pointerdown`. */
  startPos: number;
  /** Clock reading at `pointerdown` (anchors the velocity seed sample). */
  downT: number;
  /** Progress anchor the relative mapping drags FROM (live at grab). */
  pAtGrab: number;
  /** Slop exceeded — the gesture owns the pointer. */
  claimed: boolean;
  samples: Array<{ t: number; p: number }>;
  move: (event: PointerEventLike) => void;
  up: (event: PointerEventLike) => void;
  cancel: (event: PointerEventLike) => void;
}

/** The pointer-event surface the scrubber reads (fake-dom friendly). */
interface PointerEventLike {
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  target?: unknown;
}

interface ScrubEntry {
  id: string;
  element: HTMLElement;
  scrub: ScrubSpec | null;
  settle: ScrubSettleSpec | null;
  bind: string | null;
  poses: ScrubPoses | null;
  /** Interpolation lanes derived from `poses` (rebuilt on channel change). */
  plans: PropPlan[];
  /** Scrubbed prop keys (exact engine keys) — the deferral filter. */
  scrubbedKeys: Set<string>;

  phase: "idle" | "dragging" | "settling" | "awaitingCleanup";
  /** Inline scrub styles are applied and not yet cleaned up. */
  engaged: boolean;
  /**
   * Scroll-source quiescence (no scroll events for ~restDebounceMs while
   * engaged mid-range): ownership and deferral release until the next
   * scroll event re-claims them. Never set for gesture entries.
   */
  quiescent: boolean;
  progress: number;
  drag: DragState | null;
  pointerDown: ((event: PointerEventLike) => void) | null;

  /** rAF handle of the running settle loop. */
  settleHandle: unknown;
  /** The label the settle wrote, awaited in the `__anim.states` feed. */
  pendingLabel: string | null;
  cleanupTimer: unknown;

  scrollContainer: (HTMLElement & { scrollTop?: number; scrollLeft?: number }) | null;
  scrollListener: (() => void) | null;
  restTimer: unknown;
  /** Endpoint (0|1) the rest debounce is currently timing, if any. */
  restEndpoint: 0 | 1 | null;
  /** Timer bounding scroll-source deferral/ownership to active input. */
  quiescenceTimer: unknown;
  /** Last label written by the scroll rest debounce (suppress rewrites). */
  lastScrollWrite: string | null;
  ofWarned: boolean;

  /** `element.style.transform` captured before the first scrub write. */
  baseTransform: string;
  /** Base transform minus scrub-owned function kinds (prepended per frame). */
  basePrefix: string;
  /** CSS properties written inline by the scrub (cleanup set). */
  touchedCss: Set<string>;
  touchedTransform: boolean;
  /** Latest deferred engine writes per prop key, applied at cleanup. */
  deferred: Map<string, unknown>;
}

export class DomScrubber {
  /**
   * Injectable clock/scheduler — public fields so tests can override them
   * (the canvas animator's `animator.now` pattern). `raf` defaults to
   * `requestAnimationFrame` when the host has one, else a 16ms timeout.
   */
  public now: () => number =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now();
  public raf: (cb: () => void) => unknown = (cb) => {
    const g = globalThis as { requestAnimationFrame?: (cb: () => void) => unknown };
    if (typeof g.requestAnimationFrame === "function") return g.requestAnimationFrame(cb);
    return setTimeout(cb, 16);
  };
  public caf: (handle: unknown) => void = (handle) => {
    const g = globalThis as { cancelAnimationFrame?: (h: unknown) => void };
    if (typeof g.cancelAnimationFrame === "function" && typeof handle === "number") {
      g.cancelAnimationFrame(handle);
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  };
  /** Cleanup fallback window after the settle write (no-flash contract). */
  public cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS;
  /**
   * Scroll-source endpoint rest debounce; also the quiescence window that
   * bounds mid-range deferral/ownership to active input.
   */
  public restDebounceMs = DEFAULT_REST_DEBOUNCE_MS;

  private entries = new Map<string, ScrubEntry>();
  private host: DomScrubberHost;
  private reducedMotionQuery: { matches: boolean } | null = null;
  /**
   * Ids carrying the `.motion(essential)` opt-out (#149): their release
   * settle animates normally under reduced motion instead of snapping.
   * Tracked independently of {@link entries} — the flag arrives on the same
   * `__anim.*` channel but a node may carry it without scrub channels.
   */
  private motionEssential = new Set<string>();

  constructor(host: DomScrubberHost) {
    this.host = host;
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

  // --------------------------------------------------------------------------
  // Renderer surface
  // --------------------------------------------------------------------------

  /**
   * Is `id` scrub-active — dragging, settling, or holding its post-settle
   * styles under ACTIVE input? The DomAnimator consults this to exclude the
   * node from transaction application and enter/FLIP participation
   * (precedence: scrub > playbacks > transaction > `.transition`). A
   * quiescent scroll entry (engaged, but the scroll has rested mid-range)
   * does NOT own the node — ownership re-claims on the next scroll event.
   */
  ownsNode(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.phase !== "idle") return true;
    return entry.engaged && !entry.quiescent;
  }

  /** Cache a freshly-created node's scrub channels and arm the gesture source. */
  registerCreate(id: string, element: HTMLElement, animProps: Record<string, unknown>): void {
    if (ANIM_MOTION_PROP in animProps) {
      this.noteMotionEssential(id, parseMotionEssential(toPlain(animProps[ANIM_MOTION_PROP])));
    }
    if (
      !(ANIM_SCRUB_PROP in animProps) &&
      !(ANIM_SCRUB_SETTLE_PROP in animProps) &&
      !(ANIM_SCRUB_BIND_PROP in animProps) &&
      !(ANIM_SCRUB_POSES_PROP in animProps)
    ) {
      return;
    }
    const entry = this.entryFor(id, element);
    entry.scrub = parseScrubSpec(toPlain(animProps[ANIM_SCRUB_PROP]));
    entry.settle = parseScrubSettle(toPlain(animProps[ANIM_SCRUB_SETTLE_PROP]));
    entry.bind = parseScrubBind(animProps[ANIM_SCRUB_BIND_PROP]);
    entry.poses = parseScrubPoses(toPlain(animProps[ANIM_SCRUB_POSES_PROP]));
    this.reconfigure(entry);
    // Seed the gesture anchor from the node's initial pose label: a node
    // created in its `to` pose must drag FROM progress 1, not 0.
    const label = parseStatesLabel(toPlain(animProps[ANIM_STATES_PROP]));
    this.seedProgressFromLabel(entry, label);
  }

  /** Route a `setProp` for one `__anim.*` channel; unknown channels are ignored. */
  setAnimProp(id: string, element: HTMLElement, name: string, value: unknown): void {
    if (name === ANIM_MOTION_PROP) {
      this.noteMotionEssential(id, parseMotionEssential(toPlain(value)));
      return;
    }
    if (name === ANIM_STATES_PROP) {
      this.noteStatesLabel(id, parseStatesLabel(toPlain(value)));
      return;
    }
    if (
      name !== ANIM_SCRUB_PROP &&
      name !== ANIM_SCRUB_SETTLE_PROP &&
      name !== ANIM_SCRUB_BIND_PROP &&
      name !== ANIM_SCRUB_POSES_PROP
    ) {
      return;
    }
    const entry = this.entryFor(id, element);
    switch (name) {
      case ANIM_SCRUB_PROP:
        entry.scrub = parseScrubSpec(toPlain(value));
        break;
      case ANIM_SCRUB_SETTLE_PROP:
        entry.settle = parseScrubSettle(toPlain(value));
        break;
      case ANIM_SCRUB_BIND_PROP:
        entry.bind = parseScrubBind(value);
        break;
      case ANIM_SCRUB_POSES_PROP:
        entry.poses = parseScrubPoses(toPlain(value));
        break;
    }
    this.reconfigure(entry);
  }

  /** Route a `removeProp` for one `__anim.*` channel. */
  removeAnimProp(id: string, element: HTMLElement, name: string): void {
    this.setAnimProp(id, element, name, undefined);
  }

  /**
   * A node just entered the document — resolve and attach the scroll
   * container for scroll-source entries (ancestors are unknowable before
   * insertion). Re-inserts re-resolve, so a moved node tracks its new
   * ancestors.
   */
  noteInsert(id: string, element: HTMLElement): void {
    const entry = this.entries.get(id);
    if (!entry || entry.scrub?.source !== "scroll") return;
    entry.element = element;
    this.attachScroll(entry);
  }

  /**
   * A cached (Router) subtree just re-entered the document via an `attach`
   * patch. The patch names only the subtree ROOT — re-arm the scroll source
   * of EVERY scrubbed node inside the attached subtree (their entries
   * survived the detach; their listeners were detached by
   * {@link cancelSubtree}).
   */
  noteAttach(root: HTMLElement): void {
    for (const entry of this.entries.values()) {
      if (entry.scrub?.source !== "scroll") continue;
      if (entry.element === root || isWithinSubtree(entry.element, root)) {
        this.attachScroll(entry);
      }
    }
  }

  /**
   * Deferral gate (gesture wins): during an active drag/settle/cleanup
   * window — or an engaged scroll scrub under ACTIVE input — an engine
   * SetProp to one of the node's SCRUBBED prop keys is swallowed here:
   * latest value stored, applied at cleanup (or at scroll quiescence).
   * Every other write flows normally. Returns `true` when deferred.
   */
  deferEngineProp(id: string, name: string, value: unknown): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (!entry.scrubbedKeys.has(name)) return false;
    if (entry.phase === "idle" && (!entry.engaged || entry.quiescent)) return false;
    entry.deferred.set(name, value);
    return true;
  }

  /**
   * A detach (Router cache) or an exit-flagged remove mid-interaction:
   * cancel the gesture/settle, release capture, detach the scroll source
   * (its container may be a PERSISTENT app-shell scroller that would keep
   * driving an off-document subtree), restore the node's styles and apply
   * any deferred writes — never dispatching the bind write. The entry
   * itself survives (the subtree may come back via `attach`).
   */
  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (entry) this.cancelEntry(entry);
  }

  /**
   * Cancel every scrubbed node at-or-under `root` (a detaching subtree —
   * the detach patch names only the root, but any descendant's scroll
   * source would keep scrubbing via a persistent ancestor scroller).
   */
  cancelSubtree(root: HTMLElement): void {
    for (const entry of this.entries.values()) {
      if (entry.element === root || isWithinSubtree(entry.element, root)) {
        this.cancelEntry(entry);
      }
    }
  }

  private cancelEntry(entry: ScrubEntry): void {
    this.stopInteraction(entry);
    this.detachScroll(entry);
    if (entry.engaged || entry.phase !== "idle") {
      this.cleanup(entry);
    }
    entry.phase = "idle";
  }

  /** A removed node: cancel everything, release capture, drop all state. */
  forget(id: string): void {
    this.motionEssential.delete(id);
    const entry = this.entries.get(id);
    if (!entry) return;
    this.stopInteraction(entry);
    this.clearTimers(entry);
    this.detachSources(entry);
    this.entries.delete(id);
  }

  /** Cancel all in-flight work and drop all caches (renderer `clear()`). */
  reset(): void {
    for (const id of [...this.entries.keys()]) {
      this.forget(id);
    }
    this.motionEssential.clear();
  }

  /** Track the `.motion(essential)` flag for `id` (see {@link motionEssential}). */
  private noteMotionEssential(id: string, essential: boolean): void {
    if (essential) {
      this.motionEssential.add(id);
    } else {
      this.motionEssential.delete(id);
    }
  }

  // --------------------------------------------------------------------------
  // Channel plumbing
  // --------------------------------------------------------------------------

  private entryFor(id: string, element: HTMLElement): ScrubEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        id,
        element,
        scrub: null,
        settle: null,
        bind: null,
        poses: null,
        plans: [],
        scrubbedKeys: new Set(),
        phase: "idle",
        engaged: false,
        quiescent: false,
        progress: 0,
        drag: null,
        pointerDown: null,
        settleHandle: null,
        pendingLabel: null,
        cleanupTimer: null,
        scrollContainer: null,
        scrollListener: null,
        restTimer: null,
        restEndpoint: null,
        quiescenceTimer: null,
        lastScrollWrite: null,
        ofWarned: false,
        baseTransform: "",
        basePrefix: "",
        touchedCss: new Set(),
        touchedTransform: false,
        deferred: new Map(),
      };
      this.entries.set(id, entry);
    }
    entry.element = element;
    return entry;
  }

  /** Is the entry fully specified — all four channels valid? */
  private complete(entry: ScrubEntry): boolean {
    return !!(entry.scrub && entry.settle && entry.bind && entry.poses);
  }

  /**
   * Rebuild plans + listeners after any channel change. A channel going
   * away (RemoveProp, branch swap) MID-INTERACTION runs the same full
   * cleanup a cancel does — engaged styles, deferred writes, and node
   * ownership must not leak past the spec that authorized them.
   */
  private reconfigure(entry: ScrubEntry): void {
    this.buildPlans(entry);
    // Source listeners follow the current spec: gesture arms on the element
    // immediately; scroll waits for noteInsert (needs ancestors). A channel
    // going away tears the listeners down.
    if (!this.complete(entry)) {
      this.stopInteraction(entry);
      this.detachSources(entry);
      if (entry.engaged || entry.phase !== "idle") {
        this.cleanup(entry);
      }
      entry.phase = "idle";
      return;
    }
    if (entry.scrub!.source === "gesture") {
      this.detachScroll(entry);
      this.attachGesture(entry);
    } else {
      this.detachGesture(entry);
      // scroll attaches on noteInsert; if already inserted, try now.
      this.attachScroll(entry);
    }
  }

  /**
   * Derive the interpolation lanes from `__anim.scrubPoses`. Keys resolve
   * through the animatable whitelist (variant-scoped and off-whitelist keys
   * cannot interpolate and are skipped — they were only materialized for
   * completeness); transform-ish props become composition lanes; color
   * props parse to RGBA (unparseable colors fall back to a discrete swap at
   * p 0.5, as does any non-numeric endpoint pair).
   */
  private buildPlans(entry: ScrubEntry): void {
    entry.plans = [];
    entry.scrubbedKeys = new Set();
    if (!entry.poses) return;
    for (const [key, [from, to]] of Object.entries(entry.poses)) {
      const base = animatableBaseProp(key);
      if (!base) continue;
      entry.scrubbedKeys.add(key);
      const css = ANIMATABLE_PROPS[base]!;
      if ((TRANSFORM_ORDER as readonly string[]).includes(base)) {
        const f = parseNumericValue(from);
        const t = parseNumericValue(to);
        if (f !== null && t !== null) {
          entry.plans.push({ kind: "transform", fn: base as TransformFn, from: f, to: t });
        }
        continue;
      }
      if (COLOR_PROPS.has(base)) {
        const f = parseColorValue(from);
        const t = parseColorValue(to);
        if (f && t) {
          entry.plans.push({ kind: "color", css, from: f, to: t });
        } else {
          entry.plans.push({ kind: "discrete", css, from: String(from), to: String(to) });
        }
        continue;
      }
      const f = parseNumericValue(from);
      const t = parseNumericValue(to);
      if (f !== null && t !== null) {
        entry.plans.push({
          kind: "numeric",
          css,
          unit: css.some((prop) => UNITLESS_CSS.has(prop)) ? "" : "px",
          from: f,
          to: t,
        });
      } else {
        entry.plans.push({ kind: "discrete", css, from: String(from), to: String(to) });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Interpolation
  // --------------------------------------------------------------------------

  /** Write the interpolated inline styles for progress `p` (may overshoot). */
  private applyProgress(entry: ScrubEntry, p: number): void {
    if (entry.plans.length === 0) return;
    if (!entry.engaged) {
      entry.engaged = true;
      entry.baseTransform = entry.element.style.transform ?? "";
      const scrubFns = new Set<string>();
      const cssTargets: string[] = [];
      for (const plan of entry.plans) {
        if (plan.kind === "transform") {
          scrubFns.add(plan.fn);
          if (!cssTargets.includes("transform")) cssTargets.push("transform");
        } else {
          for (const css of plan.css) {
            if (!cssTargets.includes(css)) cssTargets.push(css);
          }
        }
      }
      // Static transform applicators the scrub does NOT own (rotate(45) on
      // a translateY scrub) survive the interaction: the base minus the
      // scrub-owned function kinds is prepended to every frame's write.
      entry.basePrefix = stripTransformFns(entry.baseTransform, scrubFns);
      entry.touchedCss.clear();
      entry.touchedTransform = false;
      // A running `.animate` preset animating the same properties would
      // outrank these inline writes — suspend it for the engagement.
      this.host.suspendPresets(entry.id, entry.element, cssTargets);
    }
    entry.progress = p;
    const transforms: string[] = [];
    for (const plan of entry.plans) {
      switch (plan.kind) {
        case "transform": {
          const v = plan.from + (plan.to - plan.from) * p;
          transforms.push(`${plan.fn}(${round(v)}${TRANSFORM_UNITS[plan.fn]})`);
          break;
        }
        case "numeric": {
          const v = plan.from + (plan.to - plan.from) * p;
          for (const css of plan.css) {
            const clamped = css === "opacity" ? Math.min(1, Math.max(0, v)) : v;
            entry.element.style.setProperty(css, `${round(clamped)}${plan.unit}`);
            entry.touchedCss.add(css);
          }
          break;
        }
        case "color": {
          const value = interpolateColor(plan.from, plan.to, p);
          for (const css of plan.css) {
            entry.element.style.setProperty(css, value);
            entry.touchedCss.add(css);
          }
          break;
        }
        case "discrete": {
          const value = p < 0.5 ? plan.from : plan.to;
          for (const css of plan.css) {
            entry.element.style.setProperty(css, value);
            entry.touchedCss.add(css);
          }
          break;
        }
      }
    }
    if (transforms.length > 0) {
      const scrubTransform = transforms.join(" ");
      entry.element.style.transform = entry.basePrefix
        ? `${entry.basePrefix} ${scrubTransform}`
        : scrubTransform;
      entry.touchedTransform = true;
    }
  }

  // --------------------------------------------------------------------------
  // Gesture source
  // --------------------------------------------------------------------------

  private attachGesture(entry: ScrubEntry): void {
    if (entry.pointerDown) return;
    const down = (event: PointerEventLike) => this.onPointerDown(entry, event);
    entry.pointerDown = down;
    entry.element.addEventListener("pointerdown", down as EventListener);
  }

  private detachGesture(entry: ScrubEntry): void {
    if (entry.pointerDown) {
      entry.element.removeEventListener("pointerdown", entry.pointerDown as EventListener);
      entry.pointerDown = null;
    }
    this.endDragListeners(entry);
  }

  private axisPos(entry: ScrubEntry, event: PointerEventLike): number {
    return (entry.scrub!.axis === "x" ? event.clientX : event.clientY) ?? 0;
  }

  /** Does `event` belong to the drag's own pointer? A second finger is noise. */
  private samePointer(drag: DragState, event: PointerEventLike): boolean {
    if (drag.pointerId === null) return true;
    return typeof event.pointerId !== "number" || event.pointerId === drag.pointerId;
  }

  private onPointerDown(entry: ScrubEntry, event: PointerEventLike): void {
    // One drag at a time: a second finger's pointerdown is noise.
    if (!this.complete(entry) || entry.drag) return;
    const pointerId = typeof event.pointerId === "number" ? event.pointerId : null;
    const move = (moveEvent: PointerEventLike) => this.onPointerMove(entry, moveEvent);
    const up = (upEvent: PointerEventLike) => this.onPointerUp(entry, upEvent);
    const cancel = (cancelEvent: PointerEventLike) => this.onPointerUp(entry, cancelEvent);
    const drag: DragState = {
      pointerId,
      startPos: this.axisPos(entry, event),
      downT: this.now(),
      pAtGrab: entry.progress,
      claimed: false,
      samples: [],
      move,
      up,
      cancel,
    };
    entry.drag = drag;
    entry.element.addEventListener("pointermove", move as EventListener);
    entry.element.addEventListener("pointerup", up as EventListener);
    entry.element.addEventListener("pointercancel", cancel as EventListener);

    // Catching a MOVING element claims immediately — the settle must stop
    // fighting the finger, and a frozen settle could not survive a no-op
    // below-slop release. A resting element waits for slop: a plain tap is
    // a total no-op and child clicks survive.
    if (entry.phase === "settling") {
      this.claimDrag(entry, drag);
    }
  }

  /**
   * Slop exceeded (or a mid-settle catch): the gesture claims the node —
   * stop any settle/cleanup-window, capture the pointer, anchor the
   * relative mapping and the velocity window at the LIVE progress.
   */
  private claimDrag(entry: ScrubEntry, drag: DragState): void {
    this.stopSettle(entry);
    this.clearCleanupTimer(entry);
    entry.pendingLabel = null;
    entry.phase = "dragging";
    entry.quiescent = false;
    drag.claimed = true;
    drag.pAtGrab = entry.progress;
    drag.samples = [{ t: drag.downT, p: drag.pAtGrab }];
    const element = entry.element as HTMLElement & {
      setPointerCapture?: (pointerId: number) => void;
    };
    if (drag.pointerId !== null && typeof element.setPointerCapture === "function") {
      try {
        element.setPointerCapture(drag.pointerId);
      } catch {
        // Capture is best-effort (the pointer may already be gone).
      }
    }
  }

  private onPointerMove(entry: ScrubEntry, event: PointerEventLike): void {
    const drag = entry.drag;
    if (!drag || !this.samePointer(drag, event)) return;
    const scrub = entry.scrub;
    if (!scrub) return;
    const travel = this.axisPos(entry, event) - drag.startPos;
    if (!drag.claimed) {
      if (Math.abs(travel) < SCRUB_SLOP_PX) return;
      this.claimDrag(entry, drag);
    }
    if (entry.phase !== "dragging") return;
    // RELATIVE mapping: the drag moves the node from the pose it grabbed —
    // never an absolute re-derivation from over[0] (which would snap an
    // open sheet closed at pointerdown).
    const raw = drag.pAtGrab + travel / (scrub.over[1] - scrub.over[0]);
    const p = rubberBandProgress(raw, scrub.rubberBand);
    this.applyProgress(entry, p);
    drag.samples.push({ t: this.now(), p });
    if (drag.samples.length > VELOCITY_SAMPLES) {
      drag.samples.splice(0, drag.samples.length - VELOCITY_SAMPLES);
    }
  }

  private onPointerUp(entry: ScrubEntry, event: PointerEventLike): void {
    const drag = entry.drag;
    if (!drag || !this.samePointer(drag, event)) return;
    if (!drag.claimed) {
      // Below-slop tap: TOTAL no-op — no capture was taken, no settle, no
      // bind write; the child's click proceeds untouched.
      this.endDragListeners(entry);
      return;
    }
    this.endDragListeners(entry);
    if (entry.phase !== "dragging") return;

    // Velocity in progress/ms over the RECENT sample window: samples older
    // than ~100ms are stale (drag, hold, release must not fling on the old
    // burst); an empty window is v = 0.
    const nowT = this.now();
    const recent = drag.samples.filter((sample) => nowT - sample.t <= VELOCITY_WINDOW_MS);
    let velocity = 0;
    if (recent.length >= 2) {
      const first = recent[0]!;
      const last = recent[recent.length - 1]!;
      const dt = last.t - first.t;
      if (dt > 0) velocity = (last.p - first.p) / dt;
    }
    const projected = entry.progress + velocity * SCRUB_PROJECTION_MS;
    const target: 0 | 1 = projected >= 0.5 ? 1 : 0;
    this.beginSettle(entry, target);
  }

  /** Remove drag listeners and release pointer capture (if claimed). */
  private endDragListeners(entry: ScrubEntry): void {
    const drag = entry.drag;
    if (!drag) return;
    entry.drag = null;
    entry.element.removeEventListener("pointermove", drag.move as EventListener);
    entry.element.removeEventListener("pointerup", drag.up as EventListener);
    entry.element.removeEventListener("pointercancel", drag.cancel as EventListener);
    const element = entry.element as HTMLElement & {
      releasePointerCapture?: (pointerId: number) => void;
    };
    if (
      drag.claimed &&
      drag.pointerId !== null &&
      typeof element.releasePointerCapture === "function"
    ) {
      try {
        element.releasePointerCapture(drag.pointerId);
      } catch {
        // Already released (e.g. the element left the document).
      }
    }
  }

  // --------------------------------------------------------------------------
  // Settle (gesture release)
  // --------------------------------------------------------------------------

  private beginSettle(entry: ScrubEntry, target: 0 | 1): void {
    const settle = entry.settle!;
    const label = target === 1 ? entry.scrub!.to : entry.scrub!.from;

    // Reduced motion: direct manipulation was exempt, the release is not —
    // settle INSTANTLY, then write. A `.motion(essential)` node (#149) is
    // exempt per node: its release settle animates normally.
    if ((this.reducedMotion && !this.motionEssential.has(entry.id)) || settle.duration <= 0) {
      this.applyProgress(entry, target);
      this.arrive(entry, label);
      return;
    }

    entry.phase = "settling";
    const from = entry.progress;
    const start = this.now();
    const ease = curveFunction(settle.curve);
    const step = () => {
      if (entry.phase !== "settling") return;
      const t = Math.min(1, (this.now() - start) / settle.duration);
      const eased = ease(t);
      this.applyProgress(entry, from + (target - from) * eased);
      if (t >= 1) {
        entry.settleHandle = null;
        this.arrive(entry, label);
      } else {
        entry.settleHandle = this.raf(step);
      }
    };
    entry.settleHandle = this.raf(step);
  }

  private stopSettle(entry: ScrubEntry): void {
    if (entry.settleHandle !== null) {
      this.caf(entry.settleHandle);
      entry.settleHandle = null;
    }
    if (entry.phase === "settling") entry.phase = "idle";
  }

  /**
   * The settle arrived at an endpoint: dispatch the winning pose LABEL
   * through the exact `.bind` write channel, keep the final inline styles,
   * and await the engine's re-render (any states-label SetProp or the
   * timeout fallback) before cleaning up — the no-flash contract.
   */
  private arrive(entry: ScrubEntry, label: string): void {
    entry.phase = "awaitingCleanup";
    entry.pendingLabel = label;
    const engine = getEngine(entry.element);
    if (engine) {
      engine.dispatchAction("__hypen_bind", { path: entry.bind, value: label });
    } else {
      log.warn(`scrub: no engine bound to element ${entry.id}; settle write dropped`);
    }
    this.armCleanupTimer(entry);
  }

  private armCleanupTimer(entry: ScrubEntry): void {
    this.clearCleanupTimer(entry);
    entry.cleanupTimer = setTimeout(() => {
      entry.cleanupTimer = null;
      this.cleanup(entry, true);
    }, this.cleanupTimeoutMs);
  }

  private clearCleanupTimer(entry: ScrubEntry): void {
    if (entry.cleanupTimer !== null) {
      clearTimeout(entry.cleanupTimer as ReturnType<typeof setTimeout>);
      entry.cleanupTimer = null;
    }
  }

  /**
   * `__anim.states` label feed (routed here by the renderer). During
   * `awaitingCleanup`, ANY label SetProp — matching the settle's winning
   * label or not — IS the engine re-render landing: clean up now. (A raced
   * different label must not hold stale visuals for the timeout window and
   * then snap.) A label landing while no interaction owns the node re-seeds
   * the gesture anchor: the next drag starts from the engine's pose.
   */
  private noteStatesLabel(id: string, label: string | null): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.phase === "awaitingCleanup" && label !== null) {
      this.clearCleanupTimer(entry);
      this.cleanup(entry, true);
    }
    if (entry.phase === "idle" && !entry.engaged) {
      this.seedProgressFromLabel(entry, label);
    }
  }

  /** `label == from` anchors at 0, `label == to` at 1, others don't move it. */
  private seedProgressFromLabel(entry: ScrubEntry, label: string | null): void {
    if (label === null || !entry.scrub) return;
    if (label === entry.scrub.from) entry.progress = 0;
    else if (label === entry.scrub.to) entry.progress = 1;
  }

  /**
   * Clear the scrub's inline styles and hand the node back to the engine:
   * deferred writes are applied through the renderer's normal path (the
   * entry is idle first, so nothing re-defers). The transform restore
   * composes with the applicator convention (transform applicators APPEND):
   * the captured base transform minus the function kinds the deferred
   * writes are about to re-append is restored FIRST, then the deferred
   * writes append their fresh values — a static `rotate(45)` survives a
   * deferred `translateY` write.
   *
   * `allowRederive` (the label-arrival and timeout paths): a SCROLL-source
   * entry resting MID-RANGE does not snap to the settled pose — deferred
   * state flushes, then the scrub styles are re-derived from live progress
   * (styles drop only at an endpoint rest or teardown), with the quiescence
   * clock re-armed so the re-engagement stays bounded.
   */
  private cleanup(entry: ScrubEntry, allowRederive = false): void {
    this.clearCleanupTimer(entry);
    this.clearRestTimer(entry);
    this.clearQuiescenceTimer(entry);
    const rederive =
      allowRederive &&
      entry.scrub?.source === "scroll" &&
      entry.scrollListener !== null &&
      entry.progress > 0 &&
      entry.progress < 1;
    entry.phase = "idle";
    entry.pendingLabel = null;
    entry.quiescent = false;

    if (entry.engaged) {
      for (const css of entry.touchedCss) {
        entry.element.style.removeProperty(css);
      }
      if (entry.touchedTransform) {
        const deferredFns = new Set<string>();
        for (const key of entry.deferred.keys()) {
          const base = animatableBaseProp(key);
          if (base !== null && (TRANSFORM_ORDER as readonly string[]).includes(base)) {
            deferredFns.add(base);
          }
        }
        entry.element.style.transform =
          deferredFns.size > 0
            ? stripTransformFns(entry.baseTransform, deferredFns)
            : entry.baseTransform;
      }
      entry.touchedCss.clear();
      entry.touchedTransform = false;
      entry.engaged = false;
      this.host.resumePresets(entry.element);
    }

    this.flushDeferred(entry);

    if (rederive) {
      this.applyProgress(entry, entry.progress);
      this.armQuiescence(entry);
    }
  }

  /** Apply pending deferred engine writes through the renderer's path. */
  private flushDeferred(entry: ScrubEntry): void {
    if (entry.deferred.size === 0) return;
    const deferred = [...entry.deferred.entries()];
    entry.deferred.clear();
    for (const [name, value] of deferred) {
      this.host.applyProp(entry.id, name, value);
    }
  }

  // --------------------------------------------------------------------------
  // Scroll source
  // --------------------------------------------------------------------------

  private attachScroll(entry: ScrubEntry): void {
    if (!this.complete(entry) || entry.scrub!.source !== "scroll") return;
    // Ancestors exist only once the node is in a tree — before its insert
    // patch, resolution would spuriously warn and find nothing. noteInsert
    // retries.
    if (!(entry.element as { parentNode?: unknown }).parentNode) return;
    const container = this.resolveScrollContainer(entry);
    if (!container) return;
    if (entry.scrollContainer === container && entry.scrollListener) return;
    this.detachScroll(entry);
    const listener = () => this.onScroll(entry);
    entry.scrollContainer = container;
    entry.scrollListener = listener;
    container.addEventListener("scroll", listener as EventListener, { passive: true } as never);
  }

  private detachScroll(entry: ScrubEntry): void {
    if (entry.scrollContainer && entry.scrollListener) {
      entry.scrollContainer.removeEventListener(
        "scroll",
        entry.scrollListener as EventListener
      );
    }
    entry.scrollContainer = null;
    entry.scrollListener = null;
    this.clearRestTimer(entry);
    this.clearQuiescenceTimer(entry);
  }

  /**
   * `of:` matches the nearest ancestor whose resolved `id` prop equals the
   * string; when it matches nothing, fall back to the nearest scrollable
   * ancestor with a ONE-TIME dev warn. Without `of:`, the nearest
   * scrollable ancestor (overflow/overflow-<axis> of `auto`/`scroll`) wins.
   */
  private resolveScrollContainer(entry: ScrubEntry): HTMLElement | null {
    const { of, axis } = entry.scrub!;
    if (of) {
      let node: unknown = (entry.element as { parentNode?: unknown }).parentNode ?? null;
      while (node) {
        const el = node as HTMLElement & { getAttribute?: (name: string) => string | null };
        if (typeof el.getAttribute !== "function") break;
        if (el.getAttribute("id") === of || (el as { id?: string }).id === of) {
          return el;
        }
        node = (el as { parentNode?: unknown }).parentNode ?? null;
      }
      if (!entry.ofWarned) {
        entry.ofWarned = true;
        log.warn(
          `scrub: of: "${of}" matched no ancestor of node ${entry.id}; ` +
            "falling back to the nearest scrollable ancestor"
        );
      }
    }
    let node: unknown = (entry.element as { parentNode?: unknown }).parentNode ?? null;
    while (node) {
      const el = node as HTMLElement;
      if (typeof (el as { getAttribute?: unknown }).getAttribute !== "function") break;
      const style = el.style as CSSStyleDeclaration | undefined;
      const overflow = style?.overflow ?? "";
      const axisOverflow = (axis === "x" ? style?.overflowX : style?.overflowY) ?? "";
      if (
        overflow === "auto" ||
        overflow === "scroll" ||
        axisOverflow === "auto" ||
        axisOverflow === "scroll"
      ) {
        return el;
      }
      node = (el as { parentNode?: unknown }).parentNode ?? null;
    }
    return null;
  }

  /**
   * Scroll tick: absolute progress mapping (scroll offsets are absolute
   * input), continuous tracking (no release exists). The bind write fires
   * only when progress crosses AND RESTS at an endpoint — a ~150ms debounce
   * opened at raw p <= 0 / >= 1 and cancelled the moment progress moves
   * back inside. Every event re-claims ownership and re-arms the
   * quiescence clock that bounds deferral to active input.
   */
  private onScroll(entry: ScrubEntry): void {
    const container = entry.scrollContainer;
    if (!container || !this.complete(entry)) return;
    const scrub = entry.scrub!;
    entry.quiescent = false; // active input re-claims ownership
    const offset =
      (scrub.axis === "x" ? container.scrollLeft : container.scrollTop) ?? 0;
    const raw = (offset - scrub.over[0]) / (scrub.over[1] - scrub.over[0]);
    const p = scrubProgress(offset, scrub.over, scrub.rubberBand);
    this.applyProgress(entry, p);
    if (entry.phase === "idle" && entry.engaged) {
      this.armQuiescence(entry);
    }

    const endpoint: 0 | 1 | null = raw <= 0 ? 0 : raw >= 1 ? 1 : null;
    if (endpoint === null) {
      this.clearRestTimer(entry);
      entry.lastScrollWrite = null;
      return;
    }
    const label = endpoint === 1 ? scrub.to : scrub.from;
    if (entry.lastScrollWrite === label) return; // already written for this rest
    if (entry.restEndpoint === endpoint && entry.restTimer !== null) return; // debounce running
    this.clearRestTimer(entry);
    entry.restEndpoint = endpoint;
    entry.restTimer = setTimeout(() => {
      entry.restTimer = null;
      entry.restEndpoint = null;
      entry.lastScrollWrite = label;
      this.arrive(entry, label);
    }, this.restDebounceMs);
  }

  private clearRestTimer(entry: ScrubEntry): void {
    if (entry.restTimer !== null) {
      clearTimeout(entry.restTimer as ReturnType<typeof setTimeout>);
      entry.restTimer = null;
    }
    entry.restEndpoint = null;
  }

  /**
   * (Re)arm the scroll quiescence clock: after ~restDebounceMs without a
   * scroll event, deferred engine writes flush (concede — the next scroll
   * event re-derives scrub styles from current progress) and ownership
   * releases until the next scroll event re-claims it.
   */
  private armQuiescence(entry: ScrubEntry): void {
    this.clearQuiescenceTimer(entry);
    entry.quiescenceTimer = setTimeout(() => {
      entry.quiescenceTimer = null;
      this.onQuiescence(entry);
    }, this.restDebounceMs);
  }

  private onQuiescence(entry: ScrubEntry): void {
    if (entry.phase !== "idle" || !entry.engaged || entry.quiescent) return;
    entry.quiescent = true; // releases ownership + deferral first…
    this.flushDeferred(entry); // …so the flush is not re-deferred
  }

  private clearQuiescenceTimer(entry: ScrubEntry): void {
    if (entry.quiescenceTimer !== null) {
      clearTimeout(entry.quiescenceTimer as ReturnType<typeof setTimeout>);
      entry.quiescenceTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Teardown helpers
  // --------------------------------------------------------------------------

  /** Stop any live interaction: drag listeners + capture, settle loop. */
  private stopInteraction(entry: ScrubEntry): void {
    this.endDragListeners(entry);
    this.stopSettle(entry);
    if (entry.phase === "dragging") entry.phase = "idle";
  }

  private clearTimers(entry: ScrubEntry): void {
    this.clearCleanupTimer(entry);
    this.clearRestTimer(entry);
    this.clearQuiescenceTimer(entry);
  }

  private detachSources(entry: ScrubEntry): void {
    this.detachGesture(entry);
    this.detachScroll(entry);
  }
}

/** Trim interpolation noise: 3 decimal places is sub-pixel on any display. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * WASM patches deliver nested prop values as Maps; the core parsers expect
 * plain objects. Normalize before parsing (DomAnimator parity).
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
