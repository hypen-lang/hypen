import { dispatchUIAction } from "@hypen-space/core";
/**
 * Canvas animation runtime for the `__anim.*` prop channel.
 *
 * The DOM renderer plays this channel with CSS transitions/animations; the
 * canvas renderer has no compositor, so this module is a numeric ticker:
 * every frame it advances in-flight animations and writes the interpolated
 * values into the REAL `VirtualNode.props` — the same props layout and
 * hit-testing read — never a paint-only presentation layer (the Android
 * View-animation lesson: pixels that move without their hit targets).
 * Curves come from the shared numeric easing layer in
 * `@hypen-space/core/animation` (`curveFunction`), so a canvas transition
 * eases identically to the DOM renderer's CSS twin.
 *
 * The engine never ticks (design constraint #1); the renderer's own
 * coalescing redraw scheduler is the clock. While anything is in flight the
 * renderer re-arms `scheduleRedraw` after each frame; when the last
 * animation settles, `hasActive()` goes false and the loop stands down —
 * no runaway rAF.
 *
 * Channel support (the canvas degradation matrix — anything below that says
 * "snap" or "no-op" is the spec-sanctioned degradation, applied silently):
 *
 * - `.transition` — on a whitelisted prop change: NUMERIC props (opacity,
 *   translateX/Y, scale, rotate, width, height, gap, fontSize, padding*,
 *   margin*) interpolate; COLOR props (color, backgroundColor, borderColor)
 *   interpolate in RGBA (hex / rgb() / basic named colors); everything else
 *   snaps to the target. `cornerRadius` snaps: the canvas paint/layout read
 *   `borderRadius`, not the whitelist's `cornerRadius` key, so there is
 *   nothing to interpolate honestly. Width/height/spacing/font animations
 *   mark layout dirty each tick so Taffy re-solves and hit-testing follows
 *   the animated geometry; `borderColor` also re-runs layout because the
 *   canvas keeps border styling on the layout object. Mid-flight retargets
 *   continue from the current interpolated value (the renderer hands us the
 *   last written value as `previous`).
 * - `.enter` — `fade` (opacity 0 → value), `slide` (translateX/Y ±24px →
 *   base, RTL-aware via `dir` props), `scale` (0.95× → base), played on
 *   nodes created-and-inserted in the same batch. The first-ever batch is
 *   suppressed and a cached Router `attach` never enter-animates (same
 *   contract as DOM). Original prop values are restored exactly on settle.
 *   Note: canvas transforms are paint-time only by platform design, so a
 *   sliding/scaling enter hit-tests at its (final) layout box — identical
 *   to what a static transform prop does on this renderer.
 * - `.exit` — a `remove` flagged `transition: true` whose root carries an
 *   exit spec defers teardown: the subtree stays in the tree (still
 *   painted), is excluded from hit-testing immediately (`node.exiting`),
 *   plays the inverse presets, and finalizes on settle — with a
 *   `duration + delay + 80ms` timeout backbone in case the ticker stalls.
 *   Descendant plain removes arriving while the root exits (the flagged
 *   root is emitted first per the wire contract) defer with it.
 * - `.layout` (FLIP on moves) — silent no-op on canvas v1: Taffy owns
 *   geometry, and a transform-based FLIP would move pixels away from the
 *   hit-tested box mid-reorder — exactly the divergence constraint #5
 *   forbids. Moves snap.
 * - `.animate` — `pulse` (opacity 1→0.5→1), `spin` (rotate 0→360),
 *   `shake` (translateX keyframes ±6/±4px) play as looping/finite
 *   timelines; `shimmer` is a silent no-op (on DOM it is a gradient
 *   `::after` overlay — the canvas has no honest prop-level equivalent, and
 *   faking it would clobber the node's real background). A changed spec
 *   restarts playback; a removed channel stops it and restores the touched
 *   props. Finite-repeat presets never replay on a cached `attach`
 *   (playback state is keyed by node id and survives detach). A preset
 *   whose props collide with an enter/exit playback on the same node is
 *   suspended for the playback (exits never resume it — the node is dying).
 *
 * Reduced motion (guarded `matchMedia`) snaps everything: transitions write
 * the target directly, enters are skipped, `.animate` never starts, and a
 * flagged remove finalizes immediately (`beginExit` returns false → the
 * caller tears down synchronously). The preference is LIVE (DOM parity with
 * the CSS media-query guard): toggling it on mid-session snaps all in-flight
 * work — including looping ambients — and toggling it off starts `.animate`
 * specs registered while it was on (exhausted finite presets never replay).
 * The `.motion(essential)` opt-out (#149, `__anim.motion` =
 * `{essential: true}`) exempts a node PER NODE from every one of those
 * shortcuts: essential nodes transition, enter, exit, and run presets
 * normally under reduced motion, survive the live toggle-on snap, and
 * revert to snapping the moment the flag is removed (their in-flight work
 * snaps then, matching the DOM stylesheet kill re-applying). Malformed or
 * unknown specs parse to `null` in `parseAnimProps` and are silent no-ops.
 *
 * Completion events (Option F, `.onAnimationComplete`): when a playback
 * settles NATURALLY the animator dispatches the node's stored completion
 * action through the host's action channel — the same `dispatchAction` path
 * the pointer/keyboard events use. Firing points and payloads (normative,
 * identical to the DOM renderer):
 *
 *   - finite `.animate` preset exhausts in `tick`  → `{ animation: "<preset>" }`
 *   - `.enter` playback group settles              → `{ animation: "enter" }`
 *   - `.exit` settles (tick fast path OR the timeout backbone), dispatched
 *     just before finalize                          → `{ animation: "exit" }`
 *   - `.states` pose switch settles (a tick-clock window of the node's
 *     `.transition` duration+delay, keyed off `__anim.states` label changes)
 *                                                   → `{ animation: "states", state: "<label>" }`
 *
 * Interrupted, superseded, reduced-motion-skipped, and `snapAll`-snapped
 * playbacks fire NOTHING — that contract removes most completion races by
 * construction. Looping presets never complete, exiting subtrees are
 * engine-side dead (only their own exit completion may fire), and nodes
 * without an `onAnimationComplete` prop dispatch nothing (one prop lookup is
 * the entire overhead).
 *
 * Coherence rules with the rest of the renderer:
 * - Engine writes win: a setProp/removeProp on a prop an enter playback or
 *   ambient preset currently owns refreshes the stored restore/settle
 *   snapshots, so the playback lands on the engine's value instead of
 *   resurrecting a stale one (`reconcileEngineWrite`).
 * - Variant bases stay synced: every animator write updates the node's
 *   `variantOriginals` snapshot for that base, so the per-frame variant pass
 *   (restore originals → resolve winners) doesn't clobber the interpolation.
 * - Router-detached subtrees hold their ambients: not painted → not ticked,
 *   not counted by `hasActive()` (no runaway rAF for invisible nodes);
 *   re-attach resumes on the next frame.
 * - Hosts without ANY frame clock (no rAF) snap via `snapAll()` — the
 *   sanctioned degradation is final-value, not freeze-at-first-frame.
 */

import {
  ANIM_TRANSITION_PROP,
  ANIM_ENTER_PROP,
  ANIM_EXIT_PROP,
  ANIM_LAYOUT_PROP,
  ANIM_PROP_ANIMATE,
  ANIM_MOTION_PROP,
  ANIM_STATES_PROP,
  ANIMATABLE_PROPS,
  SLIDE_OFFSET_PX,
  SCALE_HIDDEN_FACTOR,
  curveFunction,
  parseAnimProps,
  parseStatesLabel,
  parseMotionEssential,
  type AnimDirection,
  type AnimPreset,
  type AnimateSpec,
  type EasingFunction,
  type NodeAnimSpecs,
  type TransitionSpec,
} from "@hypen-space/core/animation";
import { frameworkLoggers } from "@hypen-space/core/logger";
import type { VirtualNode } from "./types.js";
import { resolveEventAction } from "./props.js";

const log = frameworkLoggers.canvas;

/**
 * Grace added to `duration + delay` before the timeout backbone finalizes
 * an exit whose ticker never reached settle (matches the DOM renderer).
 */
export const EXIT_SETTLE_GRACE_MS = 80;

/** Separator for `${nodeId}<SEP>${prop}` animation keys (ids never contain it). */
const KEY_SEP = " ";

const animKey = (id: string, prop: string): string => id + KEY_SEP + prop;

const defaultNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * What the animator needs from the renderer. All geometry/teardown authority
 * stays in the renderer — the animator only mutates props and reports.
 */
export interface CanvasAnimatorHost {
  /** Dirty-rect accounting for a node whose props just changed this tick. */
  markNodeDirty(node: VirtualNode): void;
  /** A layout-affecting prop was animated this tick — re-solve layout. */
  markLayoutDirty(): void;
  /** Re-arm the renderer's coalescing redraw (timeout-backbone finalizes). */
  scheduleRedraw(): void;
  /** Perform the real (immediate) teardown for a deferred remove. */
  removeNode(id: string): void;
  /** Node lookup for deferred restarts (reduced-motion toggled back off). */
  getNode(id: string): VirtualNode | undefined;
  /**
   * Whether the node is reachable from the live root. Router-detached
   * subtrees are not painted, so their ambient `.animate` timelines are held
   * (no writes, no dirty rects, no rAF re-arm) until re-attach.
   */
  isNodeAttached(node: VirtualNode): boolean;
  /**
   * Dispatch an engine action (Option F `.onAnimationComplete` completions).
   * Same channel the renderer's pointer/keyboard event paths use.
   */
  dispatchAction(name: string, payload?: unknown): void;
}

// ---------------------------------------------------------------------------
// Value parsing / interpolation
// ---------------------------------------------------------------------------

type Rgba = [number, number, number, number];

/**
 * Small named-color table for the DSL's bare color tokens (`color(blue)`).
 * Anything not listed (and not hex / rgb()) snaps — sanctioned degradation.
 */
const NAMED_COLORS: Record<string, Rgba> = {
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1],
  orange: [255, 165, 0, 1],
  purple: [128, 0, 128, 1],
  pink: [255, 192, 203, 1],
  gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1],
  cyan: [0, 255, 255, 1],
  magenta: [255, 0, 255, 1],
  teal: [0, 128, 128, 1],
  navy: [0, 0, 128, 1],
  silver: [192, 192, 192, 1],
  maroon: [128, 0, 0, 1],
  olive: [128, 128, 0, 1],
  lime: [0, 255, 0, 1],
  transparent: [0, 0, 0, 0],
};

/** Parse `#rgb[a]` / `#rrggbb[aa]` / `rgb()` / `rgba()` / basic named colors. */
export function parseColor(value: unknown): Rgba | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (raw in NAMED_COLORS) return [...NAMED_COLORS[raw]] as Rgba;
  if (raw.startsWith("#")) {
    const hex = raw.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return [r, g, b, a];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
    return null;
  }
  const fn = raw.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const parts = fn[1].split(",").map((p) => parseFloat(p.trim()));
    if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) return null;
    const [r, g, b] = parts;
    const a = parts.length >= 4 ? parts[3] : 1;
    return [r, g, b, a];
  }
  return null;
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Format an interpolated color. Components clamped (spring may overshoot). */
function formatColor(c: Rgba): string {
  const r = Math.round(clamp(c[0], 0, 255));
  const g = Math.round(clamp(c[1], 0, 255));
  const b = Math.round(clamp(c[2], 0, 255));
  const a = clamp(c[3], 0, 1);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/** Coerce a prop value to a finite number (bare numbers and `"16px"`-style). */
export function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d*\.?\d+(px)?$/.test(value.trim())) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Whitelist props whose values are colors (interpolated in RGBA space). */
const COLOR_PROPS = new Set(["color", "backgroundColor", "borderColor"]);

/**
 * Whitelist props that feed the canvas LAYOUT pass (Taffy styles or the
 * layout-held border object) rather than paint alone. Animating one of these
 * marks layout dirty every tick so geometry — and with it hit-testing —
 * follows the interpolated value.
 */
const LAYOUT_AFFECTING = new Set([
  "width",
  "height",
  "gap",
  "fontSize",
  "borderColor", // layout.border.color is derived during the layout pass
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "paddingHorizontal",
  "paddingVertical",
  "margin",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "marginHorizontal",
  "marginVertical",
]);

/**
 * Whitelist props the canvas renderer cannot animate honestly. The engine's
 * `cornerRadius` key is never consumed by canvas paint/layout (which read
 * `borderRadius`), so interpolating it would tick with zero visual effect.
 */
const CANVAS_SNAP_PROPS = new Set(["cornerRadius"]);

type Interp =
  | { kind: "number"; from: number; to: number }
  | { kind: "color"; from: Rgba; to: Rgba };

function makeInterp(prop: string, from: unknown, to: unknown): Interp | null {
  if (COLOR_PROPS.has(prop)) {
    const f = parseColor(from);
    const t = parseColor(to);
    return f && t ? { kind: "color", from: f, to: t } : null;
  }
  const f = parseNumeric(from);
  const t = parseNumeric(to);
  return f !== null && t !== null ? { kind: "number", from: f, to: t } : null;
}

function interpIsNoop(interp: Interp): boolean {
  if (interp.kind === "number") return interp.from === interp.to;
  return interp.from.every((c, i) => c === interp.to[i]);
}

// ---------------------------------------------------------------------------
// `.animate` preset timelines (shapes are renderer-owned; names/timing are
// normative — see ANIMATE_PRESETS in @hypen-space/core/animation)
// ---------------------------------------------------------------------------

/** Props each supported preset writes. Empty = unsupported → silent no-op. */
const AMBIENT_PRESET_PROPS: Record<AnimateSpec["preset"], readonly string[]> = {
  pulse: ["opacity"],
  spin: ["rotate"],
  shake: ["translateX"],
  shimmer: [], // DOM-only gradient overlay; no honest canvas equivalent
};

/** Piecewise-linear keyframe evaluation over eased iteration progress. */
function piecewise(stops: ReadonlyArray<readonly [number, number]>, p: number): number {
  if (p <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [t1, v1] = stops[i];
    if (p <= t1) {
      const [t0, v0] = stops[i - 1];
      const span = t1 - t0;
      return span > 0 ? v0 + ((p - t0) / span) * (v1 - v0) : v1;
    }
  }
  return stops[stops.length - 1][1];
}

/** Mirrors the DOM `@keyframes hypen-pulse` (opacity 1 → 0.5 → 1). */
const PULSE_STOPS = [
  [0, 1],
  [0.5, 0.5],
  [1, 1],
] as const;

/** Mirrors the DOM `@keyframes hypen-shake` translateX offsets. */
const SHAKE_STOPS = [
  [0, 0],
  [0.2, -6],
  [0.4, 6],
  [0.6, -4],
  [0.8, 4],
  [1, 0],
] as const;

// ---------------------------------------------------------------------------
// Internal records
// ---------------------------------------------------------------------------

/** Countdown shared by the prop animations of one enter playback. */
interface PlaybackGroup {
  remaining: number;
  /**
   * Set when ANY member animation ended non-naturally (cancelled, replaced,
   * snapped). The group still settles — its cleanup (`onSettled`) must run —
   * but a broken group never reports completion (natural settles only).
   */
  broken: boolean;
  onSettled: (broken: boolean) => void;
}

/**
 * A pending `.states` completion window (Option F): the pose switched to
 * `label` and the node's `.transition` is interpolating the overridden props;
 * when the animator clock passes `settleAt` the transition has settled and
 * `{ animation: "states", state: label }` dispatches. Superseding label
 * changes, exits, removal, reduced motion, and `snapAll` clear the window
 * without firing.
 */
interface StateSettle {
  node: VirtualNode;
  label: string;
  settleAt: number;
}

/**
 * Is `node` inside (or itself the root of) an exit-animating subtree?
 * Engine-side those ids are already dead — completions on them (other than
 * the exiting root's own exit completion) must not dispatch, mirroring the
 * hit-test pruning and the DOM renderer's exiting-subtree event drop.
 */
function inExitingSubtree(node: VirtualNode): boolean {
  let current: VirtualNode | null = node;
  while (current) {
    if (current.exiting) return true;
    current = current.parent;
  }
  return false;
}

interface PropAnim {
  node: VirtualNode;
  prop: string;
  startTime: number;
  delay: number;
  duration: number;
  ease: EasingFunction;
  interp: Interp;
  /**
   * Exact value written at settle when no `restore` is set — the raw target
   * a plain (non-animated) setProp would have left in place.
   */
  targetRaw: unknown;
  /**
   * Enter playbacks restore the pre-playback prop exactly (delete if absent).
   * Refreshed by `notePropSet` when the engine writes the same prop
   * mid-flight — the engine's value is the new ground truth to land on.
   */
  restore?: { present: boolean; value: unknown };
  /** Clamp interpolation results to [0,1] (opacity under overshoot curves). */
  clampUnit: boolean;
  affectsLayout: boolean;
  /** Delay-phase hold value has been written (write it once, not per frame). */
  holdWritten?: boolean;
  group?: PlaybackGroup;
}

interface Ambient {
  node: VirtualNode;
  spec: AnimateSpec;
  startTime: number;
  props: readonly string[];
  /**
   * Pre-playback prop values, restored on stop. Refreshed by `notePropSet` /
   * `notePropRemoved` when the engine writes an owned prop mid-loop, so stop
   * restores the engine's value rather than a stale start-time snapshot.
   */
  originals: Map<string, { present: boolean; value: unknown }>;
  /** Base opacity (pulse multiplies it). Refreshed on engine writes too. */
  baseOpacity: number;
  /** Suspended while a conflicting enter/exit playback owns the props. */
  suspended: boolean;
}

interface ExitRecord {
  id: string;
  node: VirtualNode;
  finalizeRoot: () => void;
  /**
   * Finalizers for descendant plain removes that arrived while this root was
   * exiting (root-first wire ordering). Run before the root's own teardown.
   */
  finalizes: Array<() => void>;
  /** Animator-clock time at which the exit settles (tick fast path). */
  settleAt: number;
  /** Real-time timeout backbone (duration + delay + grace). */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Resolve slide/scale/fade preset targets for one enter or exit playback. */
interface PlaybackTarget {
  prop: string;
  from: number;
  to: number;
  restore: { present: boolean; value: unknown };
}

/** Walk `dir` props up the tree (canvas has no DOM `dir` attribute). */
function isRtl(node: VirtualNode): boolean {
  let current: VirtualNode | null = node;
  while (current) {
    const dir = current.props.dir;
    if (dir === "rtl") return true;
    if (dir === "ltr") return false;
    current = current.parent;
  }
  return false;
}

/** WASM patches deliver nested prop values as Maps; the parser wants objects. */
function toPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      obj[String(key)] = toPlain(entry);
    }
    return obj;
  }
  if (Array.isArray(value)) return value.map(toPlain);
  return value;
}

function slideAxis(
  direction: AnimDirection | undefined,
  rtl: boolean
): { prop: "translateX" | "translateY"; offset: number } {
  switch (direction ?? "leading") {
    case "top":
      return { prop: "translateY", offset: -SLIDE_OFFSET_PX };
    case "bottom":
      return { prop: "translateY", offset: SLIDE_OFFSET_PX };
    case "trailing":
      return { prop: "translateX", offset: rtl ? -SLIDE_OFFSET_PX : SLIDE_OFFSET_PX };
    case "leading":
    default:
      return { prop: "translateX", offset: rtl ? SLIDE_OFFSET_PX : -SLIDE_OFFSET_PX };
  }
}

function playbackTargets(
  node: VirtualNode,
  presets: readonly AnimPreset[],
  direction: AnimDirection | undefined,
  rtl: boolean,
  phase: "enter" | "exit"
): PlaybackTarget[] {
  const out: PlaybackTarget[] = [];
  const seen = new Set<string>();
  for (const preset of presets) {
    let prop: string;
    let hidden: number;
    let base: number;
    if (preset === "fade") {
      prop = "opacity";
      base = parseNumeric(node.props.opacity) ?? 1;
      hidden = 0;
    } else if (preset === "slide") {
      const axis = slideAxis(direction, rtl);
      prop = axis.prop;
      base = parseNumeric(node.props[prop]) ?? 0;
      hidden = base + axis.offset;
    } else if (preset === "scale") {
      prop = "scale";
      base = parseNumeric(node.props.scale) ?? 1;
      hidden = base * SCALE_HIDDEN_FACTOR;
    } else {
      continue;
    }
    if (seen.has(prop)) continue;
    seen.add(prop);
    const original = node.props[prop];
    out.push({
      prop,
      from: phase === "enter" ? hidden : base,
      to: phase === "enter" ? base : hidden,
      restore: { present: original !== undefined, value: original },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Animator
// ---------------------------------------------------------------------------

export class CanvasAnimator {
  /** Clock — overridable for deterministic tests. */
  now: () => number = defaultNow;
  /** Test hook: force reduced-motion on/off (null = follow matchMedia). */
  reducedMotionOverride: boolean | null = null;
  /**
   * Test hook: frames are driven manually (fake clock + explicit `render()`
   * calls). Disables the rAF-less snap fallback the renderer applies in
   * hosts with no frame clock at all.
   */
  manualFrameDriver = false;

  private host: CanvasAnimatorHost;
  /** Parsed channel specs per node id (ids never recycle; dropped on forget). */
  private specs = new Map<string, NodeAnimSpecs>();
  /** In-flight prop animations keyed `${id}${KEY_SEP}${prop}`. */
  private anims = new Map<string, PropAnim>();
  /** Ambient `.animate` timelines keyed by node id. */
  private ambients = new Map<string, Ambient>();
  /**
   * Ids whose FINITE-repeat `.animate` preset already played to exhaustion.
   * A reduced-motion toggle-off restarts loops but never replays these
   * (mirrors "a cached attach never replays a finite preset").
   */
  private finishedAmbients = new Set<string>();
  /** Exit-animating subtree roots awaiting finalize, keyed by root id. */
  private exits = new Map<string, ExitRecord>();
  /**
   * Active `.states` pose label per node id, fed by the `__anim.states`
   * prop (`null` = default pose / no matched label). Tracked so a SetProp
   * can be recognized as a label CHANGE — only changes open a settle window.
   */
  private stateLabels = new Map<string, string | null>();
  /** Pending `.states` completion windows per node id (Option F). */
  private stateSettles = new Map<string, StateSettle>();
  /** Nodes inserted this batch whose enter should play at flush. */
  private pendingEnters = new Map<string, VirtualNode>();
  /** Ids created (with an enter spec) since the last flush. */
  private createdThisBatch = new Set<string>();
  /**
   * EVERY id created since the last flush (enter spec or not). A same-batch
   * SetProp on a freshly-created node never starts a transition: for an
   * enter-driven prop the rewind-to-previous write would corrupt the enter's
   * settle target (the enter plays at flush and owns the node's first
   * motion), and for a node without an enter the DOM renderer snaps too (no
   * previous computed style exists before first paint).
   */
  private createdNodesThisBatch = new Set<string>();
  /** The first-ever batch never enter-animates (no initial-render cascade). */
  private firstBatchDone = false;
  /**
   * Transaction-scoped animation spec for the CURRENT batch (Option D cheap
   * subset). Set by the batch's leading `batchAnimation` patch; while
   * present it is the interpolation spec for every whitelisted prop change
   * in the batch — nodes WITHOUT `__anim.transition` animate too, and nodes
   * WITH one get the transaction spec as an override (transaction > node
   * `.transition` > snap). Cleared at the end of every flush (it never
   * outlives its batch) and ignored entirely under reduced motion.
   */
  private transactionSpec: TransitionSpec | null = null;
  /**
   * Ids whose `__anim.motion` prop is `{essential: true}` — the
   * `.motion(essential)` reduced-motion opt-out (#149). Every reduced-motion
   * shortcut consults {@link motionAllowed} per node; the live toggle-on
   * snap skips essential nodes, and removing the flag while the preference
   * is on snaps that node's in-flight work (reverting it to the default).
   */
  private motionEssential = new Set<string>();
  private reducedMotionQuery: { matches: boolean } | null = null;
  private reducedMotionListenerApi: "modern" | "legacy" | null = null;

  /**
   * Live `prefers-reduced-motion` toggle (DOM parity: the CSS media-query
   * guard reacts instantly). Enabling reduce-motion mid-session snaps every
   * in-flight animation — including looping ambients, which would otherwise
   * spin forever — and disabling it starts `.animate` specs that were
   * registered while the preference was on.
   */
  private boundReducedMotionChange = (): void => {
    if (this.reducedMotionOverride === null) {
      if (this.reducedMotion) {
        // Per-node opt-out (#149): `.motion(essential)` nodes keep their
        // in-flight work through a live toggle-on; everything else snaps.
        this.snapSubset((id) => !this.motionEssential.has(id));
      } else {
        this.restartAmbients();
      }
      this.host.scheduleRedraw();
    }
  };

  constructor(host: CanvasAnimatorHost) {
    this.host = host;
    try {
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        const query = window.matchMedia("(prefers-reduced-motion: reduce)");
        this.reducedMotionQuery = query;
        const q = query as unknown as {
          addEventListener?: (type: string, cb: () => void) => void;
          addListener?: (cb: () => void) => void;
        };
        if (typeof q.addEventListener === "function") {
          q.addEventListener("change", this.boundReducedMotionChange);
          this.reducedMotionListenerApi = "modern";
        } else if (typeof q.addListener === "function") {
          // Older Safari: MediaQueryList without EventTarget.
          q.addListener(this.boundReducedMotionChange);
          this.reducedMotionListenerApi = "legacy";
        }
      }
    } catch {
      // matchMedia unavailable (tests, workers) — motion allowed.
    }
  }

  private get reducedMotion(): boolean {
    return this.reducedMotionOverride ?? this.reducedMotionQuery?.matches ?? false;
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
   * Track a node's `.motion(essential)` flag. Removing the flag while
   * reduced motion is active snaps that node's in-flight work immediately —
   * the DOM parity: un-stamping `data-hypen-motion-essential` re-applies the
   * stylesheet kill to running CSS transitions/animations at once.
   */
  private noteMotionEssential(id: string, essential: boolean): void {
    if (essential) {
      this.motionEssential.add(id);
      return;
    }
    const wasEssential = this.motionEssential.delete(id);
    if (wasEssential && this.reducedMotion) {
      this.snapSubset((other) => other === id);
    }
  }

  // -------------------------------------------------------------------------
  // Renderer entry points
  // -------------------------------------------------------------------------

  /**
   * Parse and cache a freshly-created node's `__anim.*` props, mark it
   * enter-eligible for this batch, and start any ambient `.animate` preset.
   */
  registerCreate(node: VirtualNode): void {
    const plain: Record<string, unknown> = {};
    for (const key of Object.keys(node.props)) {
      if (key.startsWith("__anim.")) plain[key] = toPlain(node.props[key]);
    }
    const specs = parseAnimProps(plain);
    this.specs.set(node.id, specs);
    this.createdNodesThisBatch.add(node.id);
    if (ANIM_MOTION_PROP in plain) {
      // Before startAmbient below — an essential preset must start even
      // under reduced motion.
      this.noteMotionEssential(node.id, parseMotionEssential(plain[ANIM_MOTION_PROP]));
    }
    if (specs.enter) this.createdThisBatch.add(node.id);
    if (specs.animate) this.startAmbient(node, specs.animate);
    if (ANIM_STATES_PROP in plain) {
      // Initial pose: record the label only. Create-time resolution is not a
      // transition — nothing animates, so nothing can settle or complete.
      this.stateLabels.set(node.id, parseStatesLabel(plain[ANIM_STATES_PROP]));
    }
  }

  /**
   * A `batchAnimation` patch opened this batch (Option D transaction-scoped
   * animation): hold its spec as the batch's interpolation spec. The wire
   * shape is the `.transition` channel's (`{curve, duration, delay?,
   * props?}`; the engine normalizes bare curve strings and fills `duration`
   * before emission), and a malformed spec degrades to `null` = unstamped.
   * Reduced motion ignores stamps entirely (prop changes snap as usual).
   */
  beginBatchAnimation(spec: unknown): void {
    // The spec is parsed even under reduced motion: stamps are ignored per
    // NODE in notePropSet (motionAllowed), so a `.motion(essential)` node
    // still glides while everything else snaps.
    this.transactionSpec = parseAnimProps({
      [ANIM_TRANSITION_PROP]: toPlain(spec),
    }).transition;
  }

  /** Route a `setProp` for one `__anim.*` channel; unknown channels ignored. */
  setAnimProp(node: VirtualNode, name: string, value: unknown): void {
    const specs = this.specsFor(node.id);
    const parsed = parseAnimProps({ [name]: toPlain(value) });
    switch (name) {
      case ANIM_TRANSITION_PROP:
        specs.transition = parsed.transition;
        break;
      case ANIM_ENTER_PROP:
        specs.enter = parsed.enter;
        break;
      case ANIM_EXIT_PROP:
        specs.exit = parsed.exit;
        break;
      case ANIM_LAYOUT_PROP:
        specs.layout = parsed.layout; // parsed for completeness; canvas FLIP is a sanctioned no-op
        break;
      case ANIM_PROP_ANIMATE: {
        // A changed spec restarts playback from the beginning; a cleared one
        // stops it and restores the touched props (DOM parity).
        const running = this.ambients.get(node.id);
        if (running) this.stopAmbient(node.id, running);
        this.finishedAmbients.delete(node.id); // a new spec may replay
        specs.animate = parsed.animate;
        if (parsed.animate) this.startAmbient(node, parsed.animate);
        break;
      }
      case ANIM_MOTION_PROP:
        this.noteMotionEssential(node.id, parseMotionEssential(toPlain(value)));
        break;
      case ANIM_STATES_PROP:
        this.noteStatesLabel(node, parseStatesLabel(toPlain(value)));
        break;
    }
  }

  /** Route a `removeProp` for one `__anim.*` channel. */
  removeAnimProp(node: VirtualNode, name: string): void {
    this.setAnimProp(node, name, undefined);
  }

  /**
   * `.transition` channel: called by the renderer AFTER a non-`__anim`
   * setProp landed (and any applicator aggregate was rebuilt). `prop` is the
   * flat base name layout/paint read; `previous` is the flat value before
   * the patch — for a mid-flight retarget that is the last interpolated
   * value we wrote, so the new animation continues from it seamlessly.
   */
  notePropSet(node: VirtualNode, prop: string, previous: unknown): void {
    if (!(prop in ANIMATABLE_PROPS)) return;
    // An engine write is the new ground truth for any playback that owns
    // this prop: refresh the enter-restore target and ambient originals so a
    // later settle/stop lands the engine's value, never a stale pre-playback
    // snapshot (DOM parity: an inline style set mid-animation survives the
    // animation's end and the animate-class removal).
    this.reconcileEngineWrite(node, prop, { present: true, value: node.props[prop] });
    // A node created THIS batch never starts a transition off a same-batch
    // SetProp: its enter (queued for flush) owns the first motion, and the
    // rewind-to-previous below would poison the enter's base/restore reads.
    // Nodes without an enter snap too (DOM parity: no pre-paint transition).
    if (this.createdNodesThisBatch.has(node.id)) return;
    // Transaction-scoped animation (Option D): a stamped batch's spec is the
    // interpolation spec for EVERY whitelisted prop change in the batch —
    // it overrides the node's own `.transition` and animates nodes that
    // have none (precedence: transaction > node `.transition` > snap).
    const spec = this.transactionSpec ?? this.specs.get(node.id)?.transition;
    if (!spec) return;
    if (spec.props && !spec.props.includes(prop)) return;
    const key = animKey(node.id, prop);
    if (
      !this.motionAllowed(node.id) ||
      spec.duration <= 0 ||
      CANVAS_SNAP_PROPS.has(prop) ||
      this.exits.has(node.id)
    ) {
      this.cancelAnim(key);
      return; // snap: the target is already in props
    }
    const target = node.props[prop];
    const interp = makeInterp(prop, previous, target);
    if (!interp || interpIsNoop(interp)) {
      this.cancelAnim(key);
      return; // non-interpolable or no-op change: sanctioned snap
    }
    // Paint must keep showing the previous value until the first tick.
    this.writeProp(node, prop, previous);
    this.setAnim(key, {
      node,
      prop,
      startTime: this.now(),
      delay: spec.delay ?? 0,
      duration: spec.duration,
      ease: curveFunction(spec.curve),
      interp,
      targetRaw: target,
      clampUnit: prop === "opacity",
      affectsLayout: LAYOUT_AFFECTING.has(prop),
    });
  }

  /** A whitelisted prop was removed: any in-flight animation on it snaps. */
  notePropRemoved(node: VirtualNode, prop: string): void {
    if (prop in ANIMATABLE_PROPS) {
      // The engine deleted the prop: an owning playback must restore
      // "absent", not the stale pre-playback value.
      this.reconcileEngineWrite(node, prop, { present: false, value: undefined });
    }
    this.cancelAnim(animKey(node.id, prop));
  }

  /**
   * A node just joined the tree. Queues its enter for the post-batch flush —
   * only when it was created in this same batch, so a cached Router `attach`
   * (routed through the same insert path) never enter-animates.
   */
  noteInsert(node: VirtualNode): void {
    if (this.createdThisBatch.has(node.id) && this.specs.get(node.id)?.enter) {
      this.pendingEnters.set(node.id, node);
    }
  }

  /**
   * Post-batch hook: play queued enters, reset per-batch state. The
   * first-ever batch (initial render) and reduced motion suppress playback.
   */
  flush(): void {
    const enters = this.pendingEnters;
    this.pendingEnters = new Map();
    const suppress = !this.firstBatchDone;
    this.firstBatchDone = true;
    this.createdThisBatch.clear();
    this.createdNodesThisBatch.clear();
    // The transaction-animation stamp is strictly batch-scoped: the batch's
    // SetProps have all been seen by now (in-flight interpolations continue
    // ticking; only the spec selection window closes).
    this.transactionSpec = null;
    if (suppress) return;
    for (const [id, node] of enters) {
      // Reduced motion is a per-node decision (#149): `.motion(essential)`
      // nodes still play their enters while everything else skips.
      if (!this.motionAllowed(id)) continue;
      this.playEnter(id, node);
    }
  }

  /**
   * Begin a deferred remove for a flagged root. Returns `true` when teardown
   * is deferred (exit spec present, motion allowed) — the animator runs
   * `finalize` when the exit settles or the timeout backbone fires. Returns
   * `false` for snap (no spec, or reduced motion → immediate finalize by the
   * caller).
   */
  beginExit(node: VirtualNode, finalize: () => void): boolean {
    const id = node.id;
    const existing = this.exits.get(id);
    if (existing) {
      // Duplicate flagged remove for an already-exiting id (defensive).
      existing.finalizes.push(finalize);
      return true;
    }
    const spec = this.specs.get(id)?.exit;
    if (!spec || !this.motionAllowed(id)) return false;

    // The node is leaving: any pending `.states` completion window is
    // superseded and must fire nothing (natural settles only).
    this.stateSettles.delete(id);

    // Excluded from hit-testing immediately — engine-side the id is dead.
    node.exiting = true;

    const totalMs = spec.duration + (spec.delay ?? 0);
    const record: ExitRecord = {
      id,
      node,
      finalizeRoot: finalize,
      finalizes: [],
      settleAt: this.now() + totalMs,
      timer: null,
    };
    this.exits.set(id, record);

    const targets = playbackTargets(node, spec.presets, spec.to, isRtl(node), "exit");
    if (targets.length > 0) {
      // A preset animating the same props would mask the exit motion; the
      // node is dying, so the suspension is never lifted.
      this.suspendConflictingAmbient(node, targets.map((t) => t.prop));
      const ease = curveFunction(spec.curve);
      for (const target of targets) {
        this.setAnim(animKey(id, target.prop), {
          node,
          prop: target.prop,
          startTime: this.now(),
          delay: spec.delay ?? 0,
          duration: spec.duration,
          ease,
          interp: { kind: "number", from: target.from, to: target.to },
          targetRaw: target.to,
          clampUnit: target.prop === "opacity",
          affectsLayout: false,
        });
      }
    }

    // Timeout backbone: even a stalled ticker (hidden page) finalizes. Like
    // the tick fast path this is a NATURAL settle — the playback ran its
    // course, only the settle signal differs (DOM parity: the settle timeout
    // dispatches the exit completion exactly as `transitionend` does).
    if (typeof setTimeout === "function") {
      record.timer = setTimeout(() => {
        this.finalizeExit(id, true);
        this.host.scheduleRedraw();
      }, totalMs + EXIT_SETTLE_GRACE_MS);
    }
    return true;
  }

  /**
   * Defer a plain (unflagged) remove whose node sits under an exiting root:
   * queue its finalize on that root so the subtree stays intact until the
   * exit settles. Returns `false` when no exiting ancestor exists.
   */
  deferToExitingAncestor(node: VirtualNode, finalize: () => void): boolean {
    if (this.exits.size === 0) return false;
    let current = node.parent;
    while (current) {
      const record = this.exits.get(current.id);
      if (record && record.node === current) {
        record.finalizes.push(finalize);
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Defensive: a `create` arrived for an id that is still exit-animating.
   * Finalizes the old subtree immediately so the corpse can't shadow the
   * new node. No-op for non-exiting ids.
   */
  finalizeNow(id: string): void {
    this.finalizeExit(id);
  }

  /** Drop all animator state for a torn-down id. */
  forget(id: string): void {
    this.specs.delete(id);
    this.motionEssential.delete(id);
    this.createdThisBatch.delete(id);
    this.createdNodesThisBatch.delete(id);
    this.pendingEnters.delete(id);
    this.ambients.delete(id); // no restore — the node is being torn down
    this.finishedAmbients.delete(id);
    this.stateLabels.delete(id);
    this.stateSettles.delete(id); // removal supersedes the window: fires nothing
    const prefix = id + KEY_SEP;
    for (const key of [...this.anims.keys()]) {
      if (key.startsWith(prefix)) this.cancelAnim(key);
    }
    const record = this.exits.get(id);
    if (record) {
      this.exits.delete(id);
      if (record.timer !== null) clearTimeout(record.timer);
    }
  }

  /** Whether anything needs further ticks (keeps the redraw loop armed). */
  hasActive(): boolean {
    if (
      this.anims.size > 0 ||
      this.exits.size > 0 ||
      this.pendingEnters.size > 0 ||
      // A pending `.states` completion window settles on the tick clock —
      // it must keep the ticker armed even when every per-prop animation of
      // the pose switch snapped (non-interpolable values).
      this.stateSettles.size > 0
    ) {
      return true;
    }
    // Ambients only keep the ticker armed while they can actually run: a
    // Router-detached subtree's looping preset must not re-arm rAF forever
    // for a node that is never painted. (Conflict-suspended ambients ride on
    // their suspending playback's `anims` entries; exit suspension rides on
    // `exits` until `forget` drops the ambient.)
    for (const ambient of this.ambients.values()) {
      if (!ambient.suspended && this.host.isNodeAttached(ambient.node)) return true;
    }
    return false;
  }

  /**
   * Advance every in-flight animation to the current clock and write the
   * interpolated values into the real node props. Called by the renderer at
   * the top of each frame — before layout and before the dirty region is
   * read — so animated geometry reaches layout and hit-testing this frame.
   */
  tick(): void {
    if (
      this.anims.size === 0 &&
      this.ambients.size === 0 &&
      this.exits.size === 0 &&
      this.stateSettles.size === 0
    ) {
      return;
    }
    const now = this.now();
    let layoutTouched = false;

    if (this.anims.size > 0) {
      const finished: string[] = [];
      for (const [key, anim] of this.anims) {
        const t =
          anim.duration > 0
            ? (now - anim.startTime - anim.delay) / anim.duration
            : 1;
        if (t < 0) {
          // Delay phase: hold the from-value — written ONCE. Re-writing the
          // identical value every frame would re-mark dirty rects and (for
          // layout props) force a full Taffy re-solve per frame of the
          // delay window with zero visual change.
          if (!anim.holdWritten) {
            anim.holdWritten = true;
            this.writeProp(anim.node, anim.prop, this.valueFor(anim, 0));
            if (anim.affectsLayout) layoutTouched = true;
          }
          continue;
        }
        if (anim.affectsLayout) layoutTouched = true;
        if (t >= 1) {
          if (anim.restore) {
            this.applyStored(anim.node, anim.prop, anim.restore);
          } else {
            this.writeProp(anim.node, anim.prop, anim.targetRaw);
          }
          finished.push(key);
          this.groupDone(anim, true); // ran to completion: natural settle
        } else {
          this.writeProp(anim.node, anim.prop, this.valueFor(anim, anim.ease(t)));
        }
      }
      for (const key of finished) this.anims.delete(key);
    }

    // Ambient presets run after transitions/playbacks so a looping preset
    // owns its props for the frame (the DOM cascade equivalent: a running
    // CSS animation outranks transitions). All ambient props are paint-only.
    for (const [id, ambient] of [...this.ambients]) {
      if (ambient.suspended) continue;
      // A Router-detached subtree is not painted: hold the ambient (no
      // writes, no stale dirty rects) until an `attach` brings it back —
      // the next attached frame resumes it, an exhausted finite repeat is
      // settled then.
      if (!this.host.isNodeAttached(ambient.node)) continue;
      const elapsed = now - ambient.startTime - (ambient.spec.delay ?? 0);
      if (elapsed < 0) continue;
      const { duration, repeat } = ambient.spec;
      const iterations = repeat === "loop" ? Infinity : repeat;
      const iteration = duration > 0 ? Math.floor(elapsed / duration) : Infinity;
      if (iteration >= iterations) {
        this.finishedAmbients.add(id);
        this.stopAmbient(id, ambient);
        // A finite preset exhausting its iterations IS its natural settle
        // (loops never reach here). Interruptions — spec change, channel
        // removal, reduced-motion snap — stop the ambient elsewhere and
        // fire nothing; an exiting subtree is engine-side dead.
        if (!inExitingSubtree(ambient.node)) {
          this.dispatchCompletion(ambient.node, { animation: ambient.spec.preset });
        }
        continue;
      }
      const p = duration > 0 ? (elapsed % duration) / duration : 0;
      this.applyAmbientFrame(ambient, curveFunction(ambient.spec.curve)(p));
    }

    for (const [id, record] of [...this.exits]) {
      if (now >= record.settleAt) this.finalizeExit(id, true); // natural settle
    }

    // `.states` completion windows: the pose transition has settled once the
    // clock passes the window's end — dispatch with the matched label.
    // Superseded mid-window without clearing the entry: an ancestor's exit
    // (engine-side dead subtree) or a Router detach (never painted) — both
    // fire nothing (DOM parity: the states timer re-checks at fire time).
    for (const [id, pending] of [...this.stateSettles]) {
      if (now < pending.settleAt) continue;
      this.stateSettles.delete(id);
      if (!inExitingSubtree(pending.node) && this.host.isNodeAttached(pending.node)) {
        this.dispatchCompletion(pending.node, { animation: "states", state: pending.label });
      }
    }

    if (layoutTouched) this.host.markLayoutDirty();
  }

  /** Cancel all in-flight work and drop all caches (renderer clear/destroy). */
  reset(): void {
    for (const record of this.exits.values()) {
      if (record.timer !== null) clearTimeout(record.timer);
    }
    this.exits.clear();
    this.anims.clear();
    this.ambients.clear();
    this.finishedAmbients.clear();
    this.specs.clear();
    this.motionEssential.clear();
    this.stateLabels.clear();
    this.stateSettles.clear();
    this.pendingEnters.clear();
    this.createdThisBatch.clear();
    this.createdNodesThisBatch.clear();
    this.transactionSpec = null;
    this.firstBatchDone = false;
  }

  /** `reset` plus teardown of the reduced-motion media-query listener. */
  destroy(): void {
    this.reset();
    const q = this.reducedMotionQuery as unknown as {
      removeEventListener?: (type: string, cb: () => void) => void;
      removeListener?: (cb: () => void) => void;
    } | null;
    if (q) {
      if (this.reducedMotionListenerApi === "modern") {
        q.removeEventListener?.("change", this.boundReducedMotionChange);
      } else if (this.reducedMotionListenerApi === "legacy") {
        q.removeListener?.(this.boundReducedMotionChange);
      }
    }
    this.reducedMotionListenerApi = null;
    this.reducedMotionQuery = null;
  }

  /**
   * Settle every in-flight animation at its FINAL value right now — the
   * sanctioned snap. Used when reduced motion flips on mid-session and by
   * the renderer's rAF-less fallback (a host with no frame clock would
   * otherwise freeze animations at their first-frame pose forever, an
   * entering node stuck invisible). Transitions land their targets, enter
   * playbacks restore, ambients stop and restore, exits finalize.
   */
  snapAll(): void {
    // Unconditional — even `.motion(essential)` nodes snap here: the rAF-less
    // fallback means there is NO frame clock at all, and final-value is the
    // only honest behavior a clockless host can offer.
    this.snapSubset(() => true);
  }

  /**
   * Settle the in-flight work of every id `shouldSnap` selects at its FINAL
   * value right now (see {@link snapAll}). The per-node form exists for the
   * `.motion(essential)` opt-out (#149): the live reduced-motion toggle-on
   * snaps only non-essential nodes, and removing a node's flag under
   * reduced motion snaps just that node.
   */
  private snapSubset(shouldSnap: (id: string) => boolean): void {
    for (const [key, anim] of [...this.anims]) {
      if (!shouldSnap(anim.node.id)) continue;
      this.anims.delete(key);
      if (anim.restore) {
        this.applyStored(anim.node, anim.prop, anim.restore);
      } else {
        this.writeProp(anim.node, anim.prop, anim.targetRaw);
      }
      // A snap is a skip, not a natural settle — completions fire nothing.
      this.groupDone(anim, false);
    }
    for (const [id, ambient] of [...this.ambients]) {
      if (!shouldSnap(id)) continue;
      this.stopAmbient(id, ambient);
    }
    for (const id of [...this.exits.keys()]) {
      if (!shouldSnap(id)) continue;
      this.finalizeExit(id);
    }
    for (const id of [...this.stateSettles.keys()]) {
      if (!shouldSnap(id)) continue;
      this.stateSettles.delete(id); // snapped pose switches complete silently
    }
    for (const id of [...this.pendingEnters.keys()]) {
      if (!shouldSnap(id)) continue;
      this.pendingEnters.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private specsFor(id: string): NodeAnimSpecs {
    let specs = this.specs.get(id);
    if (!specs) {
      specs = { transition: null, enter: null, exit: null, layout: null, animate: null };
      this.specs.set(id, specs);
    }
    return specs;
  }

  /**
   * Write an animated value into the REAL prop bag — the same entry layout,
   * paint, and hit-testing read — and keep the renderer's computed caches
   * coherent (`node.opacity` mirrors `deriveNodeComputed` semantics, so an
   * animated 0 stays 0 instead of snapping opaque).
   */
  private writeProp(node: VirtualNode, prop: string, value: unknown): void {
    node.props[prop] = value;
    this.syncVariantOriginal(node, prop, value);
    if (prop === "opacity") {
      const o = typeof value === "number" ? value : parseFloat(value as string);
      node.opacity = Number.isFinite(o) ? o : 1;
    }
    this.host.markNodeDirty(node);
  }

  /**
   * Keep the variant pass coherent with animator writes: `applyVariants`
   * restores `variantOriginals` over each variant base BEFORE resolving
   * winners every frame, so for a prop that also carries a variant key the
   * animated value IS the new original — without this sync the restore
   * clobbers every tick's write back to the pre-animation snapshot and the
   * prop freezes there permanently.
   */
  private syncVariantOriginal(node: VirtualNode, prop: string, value: unknown): void {
    const originals = node.variantOriginals;
    if (originals && prop in originals) {
      originals[prop] = value;
    }
  }

  /** Restore a captured original prop exactly (delete when it was absent). */
  private applyStored(
    node: VirtualNode,
    prop: string,
    stored: { present: boolean; value: unknown }
  ): void {
    if (stored.present) {
      this.writeProp(node, prop, stored.value);
      return;
    }
    delete node.props[prop];
    this.syncVariantOriginal(node, prop, undefined);
    if (prop === "opacity") node.opacity = 1;
    this.host.markNodeDirty(node);
  }

  /**
   * An engine patch wrote (or deleted) a prop a playback currently owns:
   * refresh every stored snapshot that would otherwise restore a stale value
   * over the engine's — the enter playback's settle target and the ambient
   * preset's originals/base. Exit playbacks carry no `restore` and their ids
   * are engine-dead, so they are unaffected by design.
   */
  private reconcileEngineWrite(
    node: VirtualNode,
    prop: string,
    stored: { present: boolean; value: unknown }
  ): void {
    const anim = this.anims.get(animKey(node.id, prop));
    if (anim?.restore) {
      anim.restore = stored;
      if (stored.present) {
        // Converge toward the engine's value (DOM parity: a fade enter's
        // implicit `to` keyframe is the element's current style, so a
        // mid-flight inline write retargets the animation's end pose).
        anim.targetRaw = stored.value;
        const n = parseNumeric(stored.value);
        if (n !== null && anim.interp.kind === "number") {
          anim.interp.to = n;
        }
      }
    }
    const ambient = this.ambients.get(node.id);
    if (ambient && ambient.props.includes(prop)) {
      ambient.originals.set(prop, stored);
      if (prop === "opacity") {
        ambient.baseOpacity = stored.present ? parseNumeric(stored.value) ?? 1 : 1;
      }
    }
  }

  private valueFor(anim: PropAnim, eased: number): unknown {
    if (anim.interp.kind === "number") {
      const v = anim.interp.from + (anim.interp.to - anim.interp.from) * eased;
      // Overshoot curves (spring) exceed 1; clamp the RESULT for unit props.
      return anim.clampUnit ? clamp(v, 0, 1) : v;
    }
    const { from, to } = anim.interp;
    const mixed: Rgba = [
      from[0] + (to[0] - from[0]) * eased,
      from[1] + (to[1] - from[1]) * eased,
      from[2] + (to[2] - from[2]) * eased,
      from[3] + (to[3] - from[3]) * eased,
    ];
    return formatColor(mixed);
  }

  /** Install an animation, retiring (and group-settling) any it replaces. */
  private setAnim(key: string, anim: PropAnim): void {
    const existing = this.anims.get(key);
    if (existing) this.groupDone(existing, false); // superseded: not natural
    this.anims.set(key, anim);
  }

  private cancelAnim(key: string): void {
    const anim = this.anims.get(key);
    if (anim) {
      this.anims.delete(key);
      this.groupDone(anim, false); // interrupted: not natural
    }
  }

  /**
   * Count one member animation out of its playback group. `natural` is true
   * only when the animation ran to completion in `tick` — cancellation,
   * replacement, and snap mark the whole group broken, so its settle still
   * runs cleanup but never reports completion.
   */
  private groupDone(anim: PropAnim, natural: boolean): void {
    const group = anim.group;
    if (!group) return;
    if (!natural) group.broken = true;
    group.remaining -= 1;
    if (group.remaining <= 0) group.onSettled(group.broken);
  }

  private playEnter(id: string, node: VirtualNode): void {
    const spec = this.specs.get(id)?.enter;
    if (!spec || this.exits.has(id)) return;
    const targets = playbackTargets(node, spec.presets, spec.from, isRtl(node), "enter");
    if (targets.length === 0) return;

    this.suspendConflictingAmbient(node, targets.map((t) => t.prop));
    const group: PlaybackGroup = {
      remaining: targets.length,
      broken: false,
      onSettled: (broken) => {
        this.resumeAmbient(id);
        // Natural settle only: an interrupted/superseded/snapped enter is
        // broken and fires nothing; an exiting subtree is engine-side dead;
        // a Router-detached one is never painted (DOM parity: the enter
        // settle checks isConnected).
        if (!broken && !inExitingSubtree(node) && this.host.isNodeAttached(node)) {
          this.dispatchCompletion(node, { animation: "enter" });
        }
      },
    };
    const ease = curveFunction(spec.curve);
    for (const target of targets) {
      // Hidden pose lands NOW so the batch's first paint shows it.
      this.writeProp(node, target.prop, target.from);
      this.setAnim(animKey(id, target.prop), {
        node,
        prop: target.prop,
        startTime: this.now(),
        delay: spec.delay ?? 0,
        duration: spec.duration,
        ease,
        interp: { kind: "number", from: target.from, to: target.to },
        targetRaw: target.to,
        restore: target.restore,
        clampUnit: target.prop === "opacity",
        affectsLayout: false,
        group,
      });
    }
  }

  private startAmbient(node: VirtualNode, spec: AnimateSpec): void {
    if (!this.motionAllowed(node.id)) return;
    const props = AMBIENT_PRESET_PROPS[spec.preset];
    if (!props || props.length === 0) return; // shimmer: sanctioned no-op
    const originals = new Map<string, { present: boolean; value: unknown }>();
    for (const prop of props) {
      const value = node.props[prop];
      originals.set(prop, { present: value !== undefined, value });
    }
    this.ambients.set(node.id, {
      node,
      spec,
      startTime: this.now(),
      props,
      originals,
      baseOpacity: parseNumeric(node.props.opacity) ?? 1,
      suspended: false,
    });
  }

  /**
   * Reduced motion toggled OFF: start every cached `.animate` spec that is
   * not already playing. Loops (and never-started finite presets) begin;
   * finite presets that already exhausted never replay.
   */
  private restartAmbients(): void {
    for (const [id, specs] of this.specs) {
      if (!specs.animate || this.ambients.has(id) || this.finishedAmbients.has(id)) {
        continue;
      }
      const node = this.host.getNode(id);
      if (node) this.startAmbient(node, specs.animate);
    }
  }

  /** Finite repeat exhausted or channel cleared: restore and drop. */
  private stopAmbient(id: string, ambient: Ambient): void {
    for (const [prop, stored] of ambient.originals) {
      this.applyStored(ambient.node, prop, stored);
    }
    this.ambients.delete(id);
  }

  private applyAmbientFrame(ambient: Ambient, eased: number): void {
    const node = ambient.node;
    switch (ambient.spec.preset) {
      case "pulse": {
        const factor = piecewise(PULSE_STOPS, eased);
        this.writeProp(node, "opacity", clamp(ambient.baseOpacity * factor, 0, 1));
        break;
      }
      case "spin":
        this.writeProp(node, "rotate", 360 * eased);
        break;
      case "shake":
        this.writeProp(node, "translateX", piecewise(SHAKE_STOPS, eased));
        break;
      default:
        break;
    }
  }

  /**
   * Suspend an ambient preset whose props collide with a playback's — the
   * per-frame last writer would otherwise fight the enter/exit pose.
   */
  private suspendConflictingAmbient(node: VirtualNode, touched: string[]): void {
    const ambient = this.ambients.get(node.id);
    if (!ambient || ambient.suspended) return;
    if (ambient.props.some((prop) => touched.includes(prop))) {
      ambient.suspended = true;
    }
  }

  private resumeAmbient(id: string): void {
    const ambient = this.ambients.get(id);
    if (ambient) ambient.suspended = false;
  }

  /**
   * `__anim.states` label update (Option F). A label CHANGE means the engine
   * switched poses and the node's `.transition` (the `.states`-synthesized
   * one, or an explicit `.transition` that beat it) is now interpolating the
   * overridden props — open a completion window of the spec's duration+delay
   * on the tick clock. Fires nothing when: the label did not change
   * (re-resolve to the same pose), the new pose is the default (`null` — no
   * matched label to report), reduced motion (pose switches snap), the node
   * is exiting, the node is Router-detached (ambient parity: a detached
   * subtree is never painted — "no writes, no dirty rects" — so a pose
   * switch reconciled into it owes no completion), or no transition spec
   * exists (non-animated switch snaps). A superseding label change clears
   * the pending window — natural settles only — and the exiting/detached
   * conditions are re-checked at dispatch time in `tick`.
   */
  private noteStatesLabel(node: VirtualNode, label: string | null): void {
    const id = node.id;
    const previous = this.stateLabels.get(id) ?? null;
    this.stateLabels.set(id, label);
    if (label === previous) return;
    this.stateSettles.delete(id); // superseded window fires nothing
    if (label === null) return;
    if (!this.motionAllowed(id)) return; // reduced motion: pose switch snaps (no .motion(essential))
    if (inExitingSubtree(node)) return;
    if (!this.host.isNodeAttached(node)) return;
    const spec = this.specs.get(id)?.transition;
    if (!spec) return;
    this.stateSettles.set(id, {
      node,
      label,
      settleAt: this.now() + spec.duration + (spec.delay ?? 0),
    });
  }

  /**
   * Fire the node's `.onAnimationComplete` action for a naturally-settled
   * playback. No-op when the node carries no such prop (the lookup below is
   * the entire overhead). The completion fields are written last so
   * `animation`/`state` can never be shadowed by custom payload args —
   * payload shape identical to the DOM renderer's `anim-complete.ts`.
   */
  private dispatchCompletion(
    node: VirtualNode,
    completion: { animation: string; state?: string }
  ): void {
    const spec = node.props.onAnimationComplete ?? node.props.onanimationcomplete;
    if (spec == null) return;
    const resolved = resolveEventAction(spec);
    if (!resolved) return;
    try {
      dispatchUIAction(this.host, node.id, resolved.actionName, { ...resolved.payload, ...completion });
    } catch (err) {
      log.error(`Error dispatching action "${resolved.actionName}":`, err);
    }
  }

  /**
   * Tear down a deferred exit. `natural` is true only for the two settle
   * paths (tick clock, timeout backbone) — those dispatch the exit
   * completion just before finalize, the only moment the subtree is both
   * done animating and still alive. Interruption (`finalizeNow`) and snaps
   * (`snapAll`, reduced-motion toggle) finalize silently.
   */
  private finalizeExit(id: string, natural = false): void {
    const record = this.exits.get(id);
    if (!record) return;
    this.exits.delete(id);
    if (record.timer !== null) clearTimeout(record.timer);
    // Drop this root's own exit prop animations before teardown.
    const prefix = id + KEY_SEP;
    for (const key of [...this.anims.keys()]) {
      if (key.startsWith(prefix)) this.anims.delete(key);
    }
    this.host.markNodeDirty(record.node);
    // Natural settle only, and only for an exit that could actually paint —
    // an exit reconciled into a Router-detached subtree finalizes silently
    // (DOM parity: the exit settle checks isConnected). The exiting node
    // itself is still parent-linked here (finalize runs below), so a normal
    // on-screen exit passes the attachment check.
    if (natural && this.host.isNodeAttached(record.node)) {
      this.dispatchCompletion(record.node, { animation: "exit" });
    }
    // Descendants first (their removes arrived after the flagged root),
    // the root's own teardown last — mirrors the DOM renderer.
    for (const finalize of record.finalizes) {
      finalize();
    }
    record.finalizeRoot();
  }
}
