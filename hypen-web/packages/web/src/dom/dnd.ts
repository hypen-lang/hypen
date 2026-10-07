/**
 * DOM drag-and-drop runtime (`__dnd.*` channel consumption).
 *
 * The engine lowers `.draggable` / `.dropZone` / `.sortable` / `.pinboard`
 * into reserved `__dnd.*` props (see `@hypen-space/core/dnd` for the exact
 * shapes) and stamps every `ForEach`-row draggable with its item key. This
 * module is the DOM side of that contract — the renderer-resident gesture
 * that NEVER touches the engine while the pointer is down (plan §6: zero
 * engine traffic during the drag except the opted-in `.onDragStart` /
 * `.onDragOver` escalations; only meaning — the drop — crosses the boundary).
 *
 * - ACTIVATION (§6.1): `pointerdown` on a source opens a PENDING drag; the
 *   pointer is claimed only per the source's activation rule — `auto` is a
 *   6px any-axis slop for mouse/pen, a 6px CROSS-axis slop for touch inside
 *   an axis-constrained sortable (main-axis travel is a scroll and abandons
 *   the drag), and a 300ms press for touch elsewhere; `slop` / `press` /
 *   `immediate` override. Below the threshold a release is a TOTAL no-op —
 *   no capture, no styles, no events, child clicks untouched. Only the
 *   drag's own `pointerId` drives move/up/cancel.
 *
 *   Browsers latch `touch-action` when a touch STARTS, so the source's
 *   `touch-action` is written at ARM time (`none` for `press` / `slop` /
 *   `immediate` and for `auto` outside an axis-constrained sortable;
 *   `pan-<axis>` for `auto` inside one, so main-axis travel still scrolls
 *   while cross-axis slop can claim) and restored on disarm. The `click`
 *   that follows a claimed pointer drag's `pointerup` is swallowed (a
 *   capture-phase guard on the source), so `.onClick` never fires on a
 *   drop; a below-threshold tap keeps its click.
 *
 * - GHOST (§6.2): the dragged element itself is translated (a `translate()`
 *   PREPENDED to its inline transform, so a pinned `translateX(40px)` or a
 *   `lifted` pose `scale(1.04)` survives), raised with `z-index`, and given
 *   the §6.7 lift CSS (`touch-action:none`, `user-select:none`,
 *   `cursor:grabbing`, `will-change:transform`); prior inline values are
 *   restored on release/cancel. The `lifted` pose of a header-less
 *   `.states` block (`__anim.statePoses`) is overlaid on the source through
 *   the ordinary per-prop applicator path and the base restored when the
 *   label clears (§2.1). Inside a sortable the ghost is the sortable's
 *   DIRECT child that contains the source (a `Row { Text().draggable() }`
 *   row moves as one); elsewhere it is the source itself.
 *
 * - SORTABLE PREVIEW (§6.3): siblings shift with transforms to open the
 *   gap; rects are cached at lift (before any shift) so the insertion index
 *   is stable, and rebuilt from the live children when an engine
 *   insert/remove lands under a cached list mid-drag (origin included, so
 *   the reserved write's `from`/`to` track the re-render) — lists are
 *   marked dirty per patch and rebuilt ONCE per batch
 *   ({@link flushStructural}), never interleaved with the batch's DOM
 *   writes. On drop the reserved write and events are dispatched and the
 *   local transforms are HELD until the engine's re-render lands — a `Move`
 *   (or insert) under the origin/destination list, a `Remove` of the item,
 *   or (pinboards) the deferred `translateX/Y` SetProp — or 500ms, then
 *   released. No flash, and the `.layout()` FLIP sees the ghost's on-screen
 *   rect as First, so the item settles into its slot.
 *
 * - ZONES (§6.4): the innermost enabled, group-compatible zone under the
 *   pointer wins, hit-tested against layout rects (never `elementFromPoint`
 *   — the ghost is under the pointer). A zone on a sortable item uses the
 *   band rule (`resolveBand`): the middle `band` fraction is "into", the
 *   outer parts fall through to the sortable's before/after slot. A source
 *   (and its subtree) is never a zone for itself. The `over` pose is
 *   overlaid on the hovered zone; `.onDragOver(dwell:)` fires once per zone
 *   entry after the dwell, coalesced.
 *
 * - PINBOARD (§6.5): `(x, y)` = the source's top-left minus the container's
 *   content-box origin plus the container's own scroll offset (a board that
 *   scrolls its content pins in content space), grid-snapped, clamped to
 *   the content box (the scrollable content size when the board scrolls)
 *   under `bounds: clamp`, divided by the content size under `units:
 *   fraction`.
 *   The ghost snaps to the resolved position at drop.
 *
 * - PRECEDENCE (§6.6): `dnd > scrub > structural playbacks > transaction >
 *   .transition`. The DomAnimator consults {@link ownsNode}; engine
 *   SetProps / RemoveProps to any transform-kind prop (`translateX/Y/Z`,
 *   `rotate*`, `scale*`, `skew*`, `transform`) on the dragged node — and to
 *   the pose-overridden props of a node carrying a runtime label — are
 *   deferred until release ({@link deferEngineProp},
 *   {@link deferEngineRemoveProp}). A `Remove`/`Detach` mid-drag
 *   cancels cleanly and dispatches NOTHING.
 *
 * - KEYBOARD (§6.8): the core `KeyboardDragMachine` drives Space (lift /
 *   drop), Arrow keys (slot within a sortable), Tab / Shift+Tab (between
 *   zones) and Esc (cancel) with `aria-grabbed` and a polite live region
 *   (created eagerly on the first arm so AT sees the region before its
 *   first change); drops go through the exact same commit path as a
 *   pointer drop. Space lifts only when the draggable ITSELF is the key
 *   target — a Space typed into a child Input / pressed on a child Button
 *   is theirs.
 */

import {
  DND_DEFAULT_DWELL_MS,
  DND_KEY_PROP,
  DND_LABEL_LIFTED,
  DND_LABEL_OVER,
  DND_PIN_ACTION,
  DND_PIN_GROUP_PROP,
  DND_PIN_PROP,
  DND_PROP_PREFIX,
  DND_REORDER_ACTION,
  DND_SORT_PROP,
  DND_SOURCE_ENABLED_PROP,
  DND_SOURCE_PAYLOAD_PROP,
  DND_SOURCE_PROP,
  DND_ZONE_ENABLED_PROP,
  DND_ZONE_ID_PROP,
  DND_ZONE_PROP,
  KeyboardDragMachine,
  fileDragMatchesAccept,
  parseDndEnabled,
  parseDndPin,
  parseDndSort,
  parseDndSource,
  parseDndString,
  parseDndZone,
  reservedPinPath,
  resolveBand,
  snapToGrid,
  userPinPath,
  type DndAxis,
  type DndEventName,
  type DndEventPayload,
  type DndLocation,
  type DndPinSpec,
  type DndSortSpec,
  type DndSourceSpec,
  type DndZoneSpec,
  type KeyboardDragZone,
} from "@hypen-space/core/dnd";
import { ANIMATABLE_PROPS } from "@hypen-space/core/animation";
import { frameworkLoggers } from "@hypen-space/core/logger";
import {
  FILE_DRAG_GATE_META,
  dispatchElementAction,
  getDndEventBinding,
  markDndWriteTarget,
} from "./applicators/events.js";
import { setMeta } from "./element-data.js";
import { dragCarriesFiles, dragFileTypes, transferOf } from "../file-drag.js";
import {
  capturePointer,
  isWithinSubtree,
  releasePointer,
  round3,
  subtreeDepth,
  toPlain,
  type PointerEventLike,
} from "./gesture-utils.js";

const log = frameworkLoggers.renderer;

/**
 * `__anim.statePoses` — the header-less `.states` pose table
 * (`{ "<label>": { "<loweredPropKey>": value } }`, plan §2.1). Emitted by the
 * engine only on nodes carrying a `__dnd.*` prop; its labels (`lifted`,
 * `over`) are driven by this runtime. Mirrors `anim::ANIM_STATE_POSES_PROP`.
 */
export const ANIM_STATE_POSES_PROP = "__anim.statePoses";

/** Pointer travel (px) below which a gesture is a tap, not a drag claim. */
export const DND_SLOP_PX = 6;
/** Default long-press activation delay (touch outside axis-constrained sorts). */
export const DND_PRESS_MS = 300;
/** Default hold window after a drop (the no-flash fallback). */
const DEFAULT_CLEANUP_TIMEOUT_MS = 500;
/** Sibling gap-opening transition. */
const SHIFT_TRANSITION = "transform 150ms ease-out";
/** Inline CSS properties saved on lift and restored on release (§6.7). */
const LIFT_CSS = ["touch-action", "user-select", "cursor", "will-change", "z-index"] as const;
const TRANSITION_CSS = [
  "transition",
  "transition-property",
  "transition-duration",
  "transition-timing-function",
  "transition-delay",
] as const;
const TRANSLATE_FNS = new Set(["translateX", "translateY"]);
/**
 * Every prop that writes the inline `transform` lane the ghost owns during a
 * drag (the transform applicators + the raw `transform` string). Engine
 * writes to any of them on the dragged item/source are deferred until
 * release — otherwise the release would overwrite them with the stale base
 * captured at lift.
 */
const TRANSFORM_FNS = new Set([
  "transform",
  "translateX",
  "translateY",
  "translateZ",
  "rotate",
  "rotateX",
  "rotateY",
  "rotateZ",
  "scale",
  "scaleX",
  "scaleY",
  "skew",
  "skewX",
  "skewY",
]);
/** Deferred-write marker for a `RemoveProp` (flushed through `host.removeProp`). */
const REMOVED: unique symbol = Symbol("dnd.removed");
/** Marker attribute of the shared polite live region (one per document). */
export const LIVE_REGION_ATTR = "data-hypen-dnd-live";

/** What the runtime needs from the renderer. */
export interface DomDndHost {
  /**
   * Re-apply a deferred engine prop write through the renderer's normal
   * SetProp path (the runtime is idle for that node first, so nothing
   * re-defers).
   */
  applyProp(id: string, name: string, value: unknown): void;
  /** Re-apply a deferred engine `RemoveProp` through the renderer's normal path. */
  removeProp(id: string, name: string): void;
  /**
   * Apply one lowered prop key (`opacity.0`, `scale.0`, …) to an element
   * through the ordinary per-prop applicator path — the pose overlay of a
   * runtime `.states` label (§2.1).
   */
  applyApplicator(element: HTMLElement, name: string, value: unknown): void;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

type StatePoses = Record<string, Record<string, unknown>>;

interface DndNode {
  id: string;
  element: HTMLElement;
  source: DndSourceSpec | null;
  hasPayload: boolean;
  payload: unknown;
  sourceEnabled: boolean;
  key: string | null;
  zone: DndZoneSpec | null;
  zoneId: string | null;
  zoneEnabled: boolean;
  sort: DndSortSpec | null;
  pin: DndPinSpec | null;
  pinGroup: string | null;
  /** The node's own `bind` prop (the reorder / pin write target). */
  bind: string | null;
  /** The node's resolved `id` prop (zone-label fallback). */
  idProp: string | null;
  poses: StatePoses | null;
  /** Runtime label currently overlaid (`lifted` / `over`), if any. */
  poseLabel: string | null;
  /** Inline CSS captured before the overlay, restored when the label clears. */
  poseSaved: Map<string, string>;
  /** Deferred engine writes to pose-overridden keys, flushed at clear. */
  poseDeferred: Map<string, unknown>;
  pointerDown: ((event: PointerEventLike) => void) | null;
  keyDown: ((event: KeyboardEventLike) => void) | null;
  blur: (() => void) | null;
  contextMenu: ((event: { preventDefault?: () => void }) => void) | null;
  click: ((event: ClickEventLike) => void) | null;
  /** The next `click` on the source is the tail of a completed drag: swallow it. */
  suppressClick: boolean;
  /** Inline `touch-action` before the runtime wrote its own (`null` = never written). */
  savedTouchAction: string | null;
  /** The runtime added `tabindex="0"` (removed again on disarm). */
  addedTabindex: boolean;
  warnedVariantPose: boolean;
  /** Native drag listeners of a `files: true` zone (OS file drags), when armed. */
  fileListeners: FileDragListeners | null;
  /**
   * Balanced dragenter/dragleave count of an OS file drag inside this zone's
   * subtree (children's enter/leave pairs included) — `> 0` ⇒ the drag is in it.
   */
  fileDepth: number;
}

interface FileDragListeners {
  enter: (event: Event) => void;
  leave: (event: Event) => void;
  over: (event: Event) => void;
  drop: (event: Event) => void;
}

interface KeyboardEventLike {
  key?: string;
  shiftKey?: boolean;
  target?: unknown;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

interface ClickEventLike {
  preventDefault?: () => void;
  stopPropagation?: () => void;
  stopImmediatePropagation?: () => void;
}

/** Cached geometry + live shifts of one sortable list during a drag. */
interface ListPreview {
  container: DndNode;
  axis: DndAxis;
  items: HTMLElement[];
  rects: Rect[];
  /** Estimated inter-item gap along the axis. */
  gap: number;
  shifts: number[];
  saved: Map<HTMLElement, Record<string, string>>;
  /** An engine insert/remove landed under this list; rebuilt lazily (once per batch). */
  dirty: boolean;
}

type DropTarget =
  | { kind: "sort"; container: DndNode; index: number }
  | { kind: "zone"; node: DndNode }
  | { kind: "pin"; container: DndNode };

interface ActiveDrag {
  mode: "pointer" | "keyboard";
  phase: "pending" | "dragging" | "holding";
  source: DndNode;
  /** The element that moves (sortable row, or the source itself). */
  item: HTMLElement;
  itemId: string | null;
  /** Enclosing sortable / pinboard, if any. */
  origin: DndNode | null;
  originIndex: number | null;
  from: DndLocation;
  pointerId: number | null;
  /** Pointer capture taken at claim and not yet released. */
  captured: boolean;
  startX: number;
  startY: number;
  /** Last pointer position seen while dragging (re-resolve after a re-render). */
  lastX: number;
  lastY: number;
  activation: "immediate" | "slop" | "press" | { crossAxis: DndAxis };
  pressTimer: ReturnType<typeof setTimeout> | null;
  dx: number;
  dy: number;
  /** Item rect at lift (before the ghost transform). */
  itemRect: Rect;
  /** Item inline transform after the lifted pose landed (ghost frames prepend to it). */
  ghostBase: string;
  savedCss: Map<string, string>;
  ghostEngaged: boolean;
  target: DropTarget | null;
  overNode: DndNode | null;
  dwellTimer: ReturnType<typeof setTimeout> | null;
  lists: Map<string, ListPreview>;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** Deferred engine writes to the dragged node's translate keys. */
  deferred: Map<string, Map<string, unknown>>;
  move: ((event: PointerEventLike) => void) | null;
  up: ((event: PointerEventLike) => void) | null;
  cancel: ((event: PointerEventLike) => void) | null;
  /** Pre-claim abandonment (`pointerleave` / `lostpointercapture`, §6.11). */
  leave: ((event: PointerEventLike) => void) | null;
  docKey: ((event: KeyboardEventLike) => void) | null;
  machine: KeyboardDragMachine | null;
  /**
   * Keyboard zone order, parallel to the machine's zones. The machine is
   * fed NODE ids (unique — two sortables sharing a group are distinct
   * zones, §6.11); entry `i` here is the node behind machine zone `i`, and
   * the pseudo-origin of a loose draggable is the source node itself.
   */
  zoneNodes: DndNode[];
  /** Slot counts per keyboard zone (parallel to `zoneNodes`), for announcements. */
  zoneCounts: Array<number | null>;
  /** Index of the origin entry in `zoneNodes`. */
  originZone: number;
}

const baseOf = (name: string): string => {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
};

const isQualified = (base: string): boolean => base.includes("@") || base.includes(":");

const toKebab = (name: string): string => name.replace(/([A-Z])/g, "-$1").toLowerCase();

const axisStart = (rect: Rect, axis: DndAxis): number => (axis === "x" ? rect.left : rect.top);
const axisLength = (rect: Rect, axis: DndAxis): number => (axis === "x" ? rect.width : rect.height);

const measure = (element: HTMLElement): Rect => {
  const el = element as HTMLElement & { getBoundingClientRect?: () => Rect };
  if (typeof el.getBoundingClientRect !== "function") {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right ?? r.left + r.width,
    bottom: r.bottom ?? r.top + r.height,
    width: r.width ?? r.right - r.left,
    height: r.height ?? r.bottom - r.top,
  };
};

/** Estimated inter-item gap along the axis from the first two rects. */
const gapOf = (rects: Rect[], axis: DndAxis): number => {
  if (rects.length < 2) return 0;
  const a = rects[0]!;
  const b = rects[1]!;
  return Math.max(0, axisStart(b, axis) - (axisStart(a, axis) + axisLength(a, axis)));
};

const contains = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;

const isNativelyFocusable = (element: HTMLElement): boolean => {
  const tag = element.tagName?.toUpperCase();
  return tag === "A" || tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

export class DomDnd {
  /** Hold window after a drop before local transforms are released (no-flash fallback). */
  public cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS;
  /** Long-press activation delay. */
  public pressDelayMs = DND_PRESS_MS;
  /** Slop threshold (px) for slop-style activations. */
  public slopPx = DND_SLOP_PX;

  private nodes = new Map<string, DndNode>();
  private drag: ActiveDrag | null = null;
  private host: DomDndHost;
  private liveRegion: HTMLElement | null = null;
  private lastAnnouncement = "";
  private reducedMotionQuery: { matches: boolean } | null = null;
  private warnedMixedBind = false;
  private pinFractions = new Map<string, { x?: number; y?: number }>();
  private pinResizeObserver: ResizeObserver | null = null;
  /** Armed `files: true` zones. */
  private fileZones = new Set<DndNode>();
  /** The zone currently lit by an OS file drag (one at a time). */
  private filesOver: DndNode | null = null;
  /** File-item MIME types of the live OS file drag (`null` = unknown). */
  private fileTypes: string[] | null = null;
  /** Document-level self-heal listeners while an OS file drag is live. */
  private fileDocListeners: { doc: Document; over: (e: Event) => void; end: (e: Event) => void } | null = null;

  private projectPins(): void {
    for (const [id, position] of this.pinFractions) {
      const node = this.nodes.get(id);
      if (!node) continue;
      let parent = node.element.parentElement;
      while (parent && !this.nodes.get(parent.dataset.hypenId ?? "")?.pin) parent = parent.parentElement;
      if (!parent) continue;
      const box = this.contentBox(parent);
      node.element.style.translate = `${(position.x ?? 0) * box.width}px ${(position.y ?? 0) * box.height}px`;
    }
  }


  constructor(host: DomDndHost) {
    this.host = host;
    try {
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        this.reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      }
    } catch {
      // matchMedia unavailable (tests, non-browser hosts) — motion allowed.
    }
  }

  // --------------------------------------------------------------------------
  // Renderer surface
  // --------------------------------------------------------------------------

  /**
   * Does the drag own `id` — the dragged item/source (dragging or holding),
   * or a sibling holding a preview shift? The DomAnimator consults this to
   * exclude the node from transaction application and enter/FLIP
   * participation (precedence: dnd > scrub > playbacks > transaction).
   */
  ownsNode(id: string): boolean {
    const drag = this.drag;
    if (!drag || drag.phase === "pending") return false;
    if (id === drag.source.id || id === drag.itemId) return true;
    for (const list of drag.lists.values()) {
      for (let i = 0; i < list.items.length; i++) {
        if (list.shifts[i] !== 0 && list.items[i]!.dataset?.hypenId === id) return true;
      }
    }
    return false;
  }

  /**
   * Is `id` the source or item of a drag in ANY phase (including pending)?
   * The scrubber consults this to stand down on the same pointerdown.
   */
  isInteracting(id: string): boolean {
    const drag = this.drag;
    return !!drag && (id === drag.source.id || id === drag.itemId);
  }

  /**
   * Cache a freshly-created node's `__dnd.*` channels (plus its `bind` /
   * `id` props and `__anim.statePoses`) and arm its sources. Runs BEFORE the
   * create-time applicators so the `bind` applicator sees the write-target
   * marker.
   */
  registerCreate(
    id: string,
    element: HTMLElement,
    props: Record<string, unknown>,
    animProps: Record<string, unknown> | null
  ): void {
    let hasDnd = false;
    for (const key of Object.keys(props)) {
      if (key.startsWith(DND_PROP_PREFIX)) {
        hasDnd = true;
        break;
      }
    }
    const poses = animProps ? animProps[ANIM_STATE_POSES_PROP] : undefined;
    if (!hasDnd && poses === undefined) return;
    const node = this.nodeFor(id, element);
    node.bind = typeof props.bind === "string" ? props.bind : null;
    node.idProp = parseDndString(props["id.0"] ?? props.id);
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith(DND_PROP_PREFIX)) this.assignChannel(node, key, value);
    }
    if (poses !== undefined) node.poses = parsePoses(poses);
    this.reconfigure(node);
  }

  /** Route a `setProp` for one `__dnd.*` channel (re-resolved bindable pieces). */
  setDndProp(id: string, element: HTMLElement, name: string, value: unknown): void {
    const node = this.nodeFor(id, element);
    this.assignChannel(node, name, value);
    this.reconfigure(node);
    if (name === DND_SORT_PROP || name === DND_PIN_PROP) {
      // The container's kind/axis drives the arm-time `touch-action` of
      // every armed source under it.
      for (const source of this.nodes.values()) {
        if (source.pointerDown && source !== this.drag?.source && isWithinSubtree(source.element, node.element)) {
          this.applyTouchAction(source);
        }
      }
    }
  }

  /** Route a `removeProp` for one `__dnd.*` channel. */
  removeDndProp(id: string, element: HTMLElement, name: string): void {
    this.setDndProp(id, element, name, undefined);
  }

  /** Route a `setProp` for `__anim.statePoses` (other `__anim.*` names are ignored). */
  setAnimProp(id: string, element: HTMLElement, name: string, value: unknown): void {
    if (name !== ANIM_STATE_POSES_PROP) return;
    const node = this.nodes.get(id) ?? (value !== undefined ? this.nodeFor(id, element) : null);
    if (!node) return;
    if (node.poseLabel !== null) this.clearPose(node);
    node.poses = parsePoses(value);
  }

  /**
   * Track a plain prop the runtime reads off DnD nodes: `bind` (write
   * target) and `id` / `id.0` (zone-label fallback). No-op for nodes without
   * DnD channels.
   */
  noteProp(id: string, name: string, value: unknown): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (name === "bind") {
      node.bind = typeof value === "string" ? value : null;
    } else if (name === "id" || name === "id.0") {
      node.idProp = parseDndString(value);
    }
  }

  /**
   * Deferral gate (drag wins): while a drag or its post-drop hold owns a
   * node, engine SetProps to any of its transform-kind keys (the inline
   * `transform` lane the ghost owns) are swallowed — latest value stored,
   * applied at release. A `translateX`/`translateY` write landing on the
   * dragged node DURING the hold is the engine's re-render (a pin position)
   * — it releases the hold and flows through the flush.
   * Engine writes to the pose-overridden keys of a node carrying a runtime
   * label are deferred until the label clears. Returns `true` when deferred.
   */
  deferEngineProp(id: string, name: string, value: unknown): boolean {
    return this.defer(id, name, value);
  }

  /**
   * `RemoveProp` twin of {@link deferEngineProp}: a removal of a transform
   * key on the dragged node, or of a pose-overridden key on a labelled node,
   * is deferred the same way and replayed through `host.removeProp`.
   */
  deferEngineRemoveProp(id: string, name: string): boolean {
    return this.defer(id, name, REMOVED);
  }

  private defer(id: string, name: string, value: unknown): boolean {
    const base = baseOf(name);
    const drag = this.drag;
    if (drag && drag.phase !== "pending" && (TRANSFORM_FNS.has(base) || name === "__dnd.pinX" || name === "__dnd.pinY")) {
      if (id === drag.source.id || id === drag.itemId) {
        if (drag.phase === "holding" && (TRANSLATE_FNS.has(base) || name === "__dnd.pinX" || name === "__dnd.pinY")) {
          // The engine's re-render landed on the dragged node: release now
          // and let this very write apply through the flush.
          let bucket = drag.deferred.get(id);
          if (!bucket) drag.deferred.set(id, (bucket = new Map()));
          bucket.set(name, value);
          this.release();
          return true;
        }
        let bucket = drag.deferred.get(id);
        if (!bucket) drag.deferred.set(id, (bucket = new Map()));
        bucket.set(name, value);
        return true;
      }
    }
    const node = this.nodes.get(id);
    if (node && node.poseLabel !== null && node.poses) {
      const pose = node.poses[node.poseLabel];
      if (pose && Object.keys(pose).some((key) => baseOf(key) === base)) {
        node.poseDeferred.set(name, value);
        return true;
      }
    }
    return false;
  }

  /**
   * The engine moved `id` under `parentId`: the re-render for a dropped
   * reorder landed — release the held transforms (before the animator's
   * flush measures Last, so the `.layout()` FLIP animates from the ghost).
   */
  noteMove(parentId: string, id: string): void {
    this.noteStructural(parentId, id);
  }

  /**
   * A structural change (insert/move/remove) touched `parentId`. During a
   * hold under the origin or destination list this is the re-render
   * landing; during a live drag it invalidates that list's cached rects
   * (spring-loaded folders insert rows mid-drag — the new rows become live
   * targets on the next move).
   */
  noteStructural(parentId: string | null, id: string): void {
    // An armed source now lives under its (possibly new) origin: its
    // arm-time `touch-action` depends on that origin's sort axis.
    const inserted = this.nodes.get(id);
    if (inserted?.pointerDown && inserted !== this.drag?.source) this.applyTouchAction(inserted);
    const drag = this.drag;
    if (!drag || drag.phase === "pending") return;
    if (drag.phase === "holding") {
      if (id === drag.itemId || id === drag.source.id) {
        this.release();
        return;
      }
      const targetId =
        drag.target?.kind === "sort" || drag.target?.kind === "pin"
          ? drag.target.container.id
          : drag.target?.kind === "zone"
            ? drag.target.node.id
            : null;
      if (parentId !== null && (parentId === drag.origin?.id || parentId === targetId)) {
        this.release();
      }
      return;
    }
    if (parentId !== null) {
      // The changed list: the parent itself, or — for a draggable inserted
      // under an already-inserted row (the engine inserts top-down) — the
      // cached container the node now lives in.
      let list = drag.lists.get(parentId);
      if (!list) {
        const node = this.nodes.get(id);
        if (node) {
          for (const candidate of drag.lists.values()) {
            if (isWithinSubtree(node.element, candidate.container.element)) {
              list = candidate;
              break;
            }
          }
        }
      }
      if (list) {
        // A cached list (origin included) changed shape mid-drag: mark it
        // and rebuild ONCE at the end of the batch ({@link flushStructural})
        // — a batch of K inserts must not re-measure the whole list K
        // times between its own DOM writes (read/write thrash).
        list.dirty = true;
      }
    }
  }

  /**
   * End-of-batch hook (the renderer calls it after every `applyPatches`,
   * before the animator's flush; the pointer path calls it before
   * resolving): rebuild every list an insert/remove dirtied — slots from
   * the live children, so the insertion index and the reserved write's
   * `from` track the re-render — then re-resolve the target once.
   */
  flushStructural(): void {
    this.projectPins();
    const drag = this.drag;
    if (!drag || drag.phase !== "dragging") return;
    let rebuilt = false;
    for (const list of drag.lists.values()) {
      if (!list.dirty) continue;
      list.dirty = false;
      this.rebuildList(list);
      rebuilt = true;
    }
    if (!rebuilt) return;
    if (drag.mode === "pointer") this.resolveTarget(drag.lastX, drag.lastY);
    else this.keyboardPreview(drag);
  }

  /**
   * A detach (Router cache) or an exit-flagged remove: if `id` is the
   * dragged source/item — or the node is a live drag participant — cancel
   * the interaction cleanly and dispatch NOTHING. The entry survives (the
   * subtree may come back via `attach`).
   */
  cancel(id: string): void {
    const drag = this.drag;
    if (!drag) return;
    if (id === drag.source.id || id === drag.itemId) {
      this.cancelDrag(false);
    }
  }

  /** Cancel a drag whose source lives at-or-under `root` (a detaching subtree). */
  cancelSubtree(root: HTMLElement): void {
    const drag = this.drag;
    if (!drag) return;
    const el = drag.source.element;
    if (el === root || isWithinSubtree(el, root) || drag.item === root || isWithinSubtree(drag.item, root)) {
      this.cancelDrag(false);
    }
  }

  /** A removed node: cancel any drag it participates in, drop all state. */
  forget(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.cancel(id);
    this.disarmFiles(node);
    if (node.poseLabel !== null) this.clearPose(node);
    this.disarm(node);
    this.pinFractions.delete(id);
    this.pinResizeObserver?.unobserve(node.element);
    this.nodes.delete(id);
  }

  /** Cancel any in-flight drag and drop all caches (renderer `clear()`). */
  reset(): void {
    if (this.drag) this.cancelDrag(false);
    for (const id of [...this.nodes.keys()]) this.forget(id);
    this.pinResizeObserver?.disconnect();
  }

  // --------------------------------------------------------------------------
  // Channel plumbing
  // --------------------------------------------------------------------------

  private nodeFor(id: string, element: HTMLElement): DndNode {
    let node = this.nodes.get(id);
    if (!node) {
      node = {
        id,
        element,
        source: null,
        hasPayload: false,
        payload: undefined,
        sourceEnabled: true,
        key: null,
        zone: null,
        zoneId: null,
        zoneEnabled: true,
        sort: null,
        pin: null,
        pinGroup: null,
        bind: null,
        idProp: null,
        poses: null,
        poseLabel: null,
        poseSaved: new Map(),
        poseDeferred: new Map(),
        pointerDown: null,
        keyDown: null,
        blur: null,
        contextMenu: null,
        click: null,
        suppressClick: false,
        savedTouchAction: null,
        addedTabindex: false,
        warnedVariantPose: false,
        fileListeners: null,
        fileDepth: 0,
      };
      this.nodes.set(id, node);
    }
    node.element = element;
    return node;
  }

  private assignChannel(node: DndNode, name: string, raw: unknown): void {
    const value = toPlain(raw);
    switch (name) {
      case "__dnd.pinX":
      case "__dnd.pinY": {
        const position = this.pinFractions.get(node.id) ?? {};
        const axis = name === "__dnd.pinX" ? "x" : "y";
        if (value === undefined) delete position[axis];
        else position[axis] = typeof value === "number" && Number.isFinite(value) ? value : 0;
        if (position.x === undefined && position.y === undefined) {
          this.pinFractions.delete(node.id);
          node.element.style.translate = "";
        } else this.pinFractions.set(node.id, position);
        this.projectPins();
        break;
      }
      case DND_SOURCE_PROP:
        node.source = value === undefined ? null : parseDndSource(value);
        if (value !== undefined && node.source === null) {
          log.warn(`dnd: malformed __dnd.source on node ${node.id}; not draggable`);
        }
        break;
      case DND_SOURCE_PAYLOAD_PROP:
        node.hasPayload = value !== undefined;
        node.payload = value;
        break;
      case DND_SOURCE_ENABLED_PROP:
        node.sourceEnabled = parseDndEnabled(value);
        break;
      case DND_KEY_PROP:
        node.key = parseDndString(value);
        break;
      case DND_ZONE_PROP:
        node.zone = value === undefined ? null : parseDndZone(value);
        if (value !== undefined && node.zone === null) {
          log.warn(`dnd: malformed __dnd.zone on node ${node.id}; not a drop zone`);
        }
        break;
      case DND_ZONE_ID_PROP:
        node.zoneId = parseDndString(value);
        break;
      case DND_ZONE_ENABLED_PROP:
        node.zoneEnabled = parseDndEnabled(value);
        break;
      case DND_SORT_PROP:
        node.sort = value === undefined ? null : parseDndSort(value);
        if (value !== undefined && node.sort === null) {
          log.warn(`dnd: malformed __dnd.sort on node ${node.id}; not sortable`);
        }
        break;
      case DND_PIN_PROP:
        node.pin = value === undefined ? null : parseDndPin(value);
        if (node.pin && typeof ResizeObserver !== "undefined") {
          this.pinResizeObserver ??= new ResizeObserver(() => this.projectPins());
          this.pinResizeObserver.observe(node.element);
        }
        if (value !== undefined && node.pin === null) {
          log.warn(`dnd: malformed __dnd.pin on node ${node.id}; not a pinboard`);
        }
        break;
      case DND_PIN_GROUP_PROP:
        node.pinGroup = parseDndString(value);
        break;
      default:
        // Unknown `__dnd.*` channel (version drift): ignored, static UI.
        break;
    }
  }

  /** Re-arm listeners and markers after any channel change. */
  private reconfigure(node: DndNode): void {
    markDndWriteTarget(node.element, node.sort !== null || node.pin !== null);
    if (node.source && node.sourceEnabled) {
      this.arm(node);
    } else {
      // A source going away (or disabled) mid-drag cancels cleanly.
      if (this.drag && this.drag.source === node && this.drag.phase !== "holding") {
        this.cancelDrag(false);
      }
      // Gone OR disabled: no listeners, no runtime tab stop, no
      // `aria-grabbed` — a disabled draggable must not announce itself as
      // grabbable and then ignore Space.
      this.disarm(node);
    }
    if (node.zone?.files) this.armFiles(node);
    else this.disarmFiles(node);
    // A zone disabled (or its accept changed) while lit re-resolves.
    if (this.filesOver !== null) this.resolveFilesOver();
  }

  // --------------------------------------------------------------------------
  // OS file drags onto `.dropZone(files: true)` (docs/dnd.md, "Files from the OS")
  // --------------------------------------------------------------------------

  /** Can this zone light up for the live OS file drag (enabled + `accept` match)? */
  private fileZoneLive(node: DndNode, types: string[] | null): boolean {
    return !!node.zone?.files && node.zoneEnabled && fileDragMatchesAccept(node.zone.accept, types);
  }

  private armFiles(node: DndNode): void {
    if (node.fileListeners) return;
    const element = node.element;
    const listeners: FileDragListeners = {
      enter: (event) => this.onFileEnter(node, event),
      leave: (event) => this.onFileLeave(node, event),
      over: (event) => this.onFileOver(node, event),
      drop: (event) => this.onFileDrop(node, event),
    };
    node.fileListeners = listeners;
    node.fileDepth = 0;
    element.addEventListener("dragenter", listeners.enter);
    element.addEventListener("dragleave", listeners.leave);
    element.addEventListener("dragover", listeners.over);
    element.addEventListener("drop", listeners.drop);
    this.fileZones.add(node);
    // `.onFileDragEnter` on this same node fires through this gate: one entry
    // signal per zone, never a second dispatch from the runtime.
    setMeta(element, FILE_DRAG_GATE_META, (event: Event) => this.fileZoneLive(node, dragFileTypes(event)));
  }

  private disarmFiles(node: DndNode): void {
    const listeners = node.fileListeners;
    if (!listeners) return;
    const element = node.element;
    element.removeEventListener("dragenter", listeners.enter);
    element.removeEventListener("dragleave", listeners.leave);
    element.removeEventListener("dragover", listeners.over);
    element.removeEventListener("drop", listeners.drop);
    node.fileListeners = null;
    node.fileDepth = 0;
    this.fileZones.delete(node);
    setMeta(element, FILE_DRAG_GATE_META, undefined);
    if (this.filesOver === node) this.setFilesOver(null);
  }

  private onFileEnter(node: DndNode, event: Event): void {
    if (!dragCarriesFiles(event)) return;
    node.fileDepth += 1;
    this.fileTypes = dragFileTypes(event);
    if (node.zoneEnabled) event.preventDefault?.();
    this.resolveFilesOver();
  }

  private onFileLeave(node: DndNode, event: Event): void {
    if (!dragCarriesFiles(event)) return;
    node.fileDepth = Math.max(0, node.fileDepth - 1);
    this.resolveFilesOver();
  }

  private onFileOver(node: DndNode, event: Event): void {
    if (!dragCarriesFiles(event) || !node.zone?.files || !node.zoneEnabled) return;
    // Not a drop target for the bytes: "none", and the default (open the
    // file / navigate) never runs.
    event.preventDefault?.();
    const dt = transferOf(event);
    if (dt) dt.dropEffect = "none";
    // A missed dragenter (the drag started over the zone) still counts.
    if (node.fileDepth === 0) node.fileDepth = 1;
    this.fileTypes = dragFileTypes(event);
    this.resolveFilesOver();
  }

  private onFileDrop(node: DndNode, event: Event): void {
    if (!dragCarriesFiles(event)) return;
    // Swallowed, never delivered, never navigates.
    if (node.zone?.files && node.zoneEnabled) event.preventDefault?.();
    this.endFileDrag();
  }

  /** The OS file drag ended (drop, dragend, cancel): every zone resets, the pose clears. */
  private endFileDrag(): void {
    for (const zone of this.fileZones) zone.fileDepth = 0;
    this.fileTypes = null;
    this.setFilesOver(null);
  }

  /** Innermost live files zone the drag is inside wins; one at a time. */
  private resolveFilesOver(): void {
    let best: DndNode | null = null;
    let bestDepth = -1;
    for (const zone of this.fileZones) {
      if (zone.fileDepth <= 0 || !this.fileZoneLive(zone, this.fileTypes)) continue;
      const depth = subtreeDepth(zone.element);
      if (depth > bestDepth) {
        best = zone;
        bestDepth = depth;
      }
    }
    this.setFilesOver(best);
  }

  private setFilesOver(next: DndNode | null): void {
    const prev = this.filesOver;
    if (prev === next) return;
    this.filesOver = next;
    // An in-app drag owns the `over` label while it is live (the two never
    // overlap in practice; the in-app one wins if they do).
    const inAppLive = this.drag !== null && this.drag.phase !== "pending";
    if (prev && !inAppLive && prev.poseLabel === DND_LABEL_OVER) this.clearPose(prev);
    if (next && !inAppLive) this.applyPose(next, DND_LABEL_OVER);
    if (next) this.watchFileDocument(next.element);
    else this.unwatchFileDocument();
  }

  /**
   * While a zone is lit, a document-level `dragover` (capture) re-derives
   * which zones the drag is really inside — a dragleave lost to a re-render
   * or a browser quirk can never leave a zone lit — and a document `drop` /
   * `dragend` ends the drag wherever it lands.
   */
  private watchFileDocument(element: HTMLElement): void {
    if (this.fileDocListeners) return;
    const doc =
      (element as { ownerDocument?: Document | null }).ownerDocument ??
      (typeof document !== "undefined" ? document : null);
    if (!doc || typeof doc.addEventListener !== "function") return;
    const over = (event: Event) => {
      if (!dragCarriesFiles(event)) return;
      const target = event.target as HTMLElement | null;
      let changed = false;
      for (const zone of this.fileZones) {
        const inside = !!target && (target === zone.element || isWithinSubtree(target, zone.element));
        if (!inside && zone.fileDepth > 0) {
          zone.fileDepth = 0;
          changed = true;
        }
      }
      if (changed) this.resolveFilesOver();
    };
    const end = (event: Event) => {
      if (event.type === "drop" && !dragCarriesFiles(event)) return;
      this.endFileDrag();
    };
    doc.addEventListener("dragover", over, true);
    doc.addEventListener("drop", end, true);
    doc.addEventListener("dragend", end, true);
    this.fileDocListeners = { doc, over, end };
  }

  private unwatchFileDocument(): void {
    const l = this.fileDocListeners;
    if (!l) return;
    this.fileDocListeners = null;
    l.doc.removeEventListener("dragover", l.over, true);
    l.doc.removeEventListener("drop", l.end, true);
    l.doc.removeEventListener("dragend", l.end, true);
  }

  private arm(node: DndNode): void {
    if (node.pointerDown) return;
    const element = node.element;
    const down = (event: PointerEventLike) => this.onPointerDown(node, event);
    node.pointerDown = down;
    element.addEventListener("pointerdown", down as EventListener);
    const key = (event: KeyboardEventLike) => this.onKeyDown(node, event);
    node.keyDown = key;
    element.addEventListener("keydown", key as EventListener);
    const blur = () => {
      // Re-parenting a focused element (the engine's `Move` of the lifted
      // row) fires a blur in Chromium while the node is off the document;
      // the renderer restores focus right after the move — not a
      // focus-loss. Only a blur of a connected node cancels.
      if ((element as { isConnected?: boolean }).isConnected === false) return;
      if (this.drag && this.drag.mode === "keyboard" && this.drag.source === node) {
        this.cancelDrag(true);
      }
    };
    node.blur = blur;
    element.addEventListener("blur", blur as EventListener);
    // A long press (the touch activation) must not open the context menu /
    // iOS callout while the press timer or the drag is live.
    const contextMenu = (event: { preventDefault?: () => void }) => {
      const drag = this.drag;
      if (drag && drag.mode === "pointer" && drag.source === node && (drag.pressTimer !== null || drag.phase === "dragging")) {
        event.preventDefault?.();
      }
    };
    node.contextMenu = contextMenu;
    element.addEventListener("contextmenu", contextMenu as EventListener);
    // The browser dispatches a `click` after the `pointerup` that ends a
    // claimed drag (capture makes down and up share a target). Swallow it
    // — capture phase, so neither the source's own `.onClick` nor a child's
    // sees it. Armed before the create-time applicators, so it runs first.
    const click = (event: ClickEventLike) => {
      if (!node.suppressClick) return;
      node.suppressClick = false;
      event.stopImmediatePropagation?.();
      event.stopPropagation?.();
      event.preventDefault?.();
    };
    node.click = click;
    element.addEventListener("click", click as EventListener, true);
    // Keyboard reachability: a draggable that is not natively focusable and
    // has no author tabindex joins the Tab order; `aria-grabbed="false"`
    // announces it as grabbable.
    if (!isNativelyFocusable(element) && element.getAttribute?.("tabindex") === null) {
      element.setAttribute("tabindex", "0");
      node.addedTabindex = true;
    }
    element.setAttribute("aria-grabbed", "false");
    this.applyTouchAction(node);
    // The live region must exist BEFORE its first change: AT announces
    // changes to a region already in the accessibility tree, not a region
    // inserted with content in the same tick.
    this.ensureLiveRegion();
  }

  private disarm(node: DndNode): void {
    const element = node.element;
    if (node.pointerDown) {
      element.removeEventListener("pointerdown", node.pointerDown as EventListener);
      node.pointerDown = null;
    }
    if (node.keyDown) {
      element.removeEventListener("keydown", node.keyDown as EventListener);
      node.keyDown = null;
    }
    if (node.blur) {
      element.removeEventListener("blur", node.blur as EventListener);
      node.blur = null;
    }
    if (node.contextMenu) {
      element.removeEventListener("contextmenu", node.contextMenu as EventListener);
      node.contextMenu = null;
    }
    if (node.click) {
      element.removeEventListener("click", node.click as EventListener, true);
      node.click = null;
    }
    node.suppressClick = false;
    if (node.addedTabindex) {
      node.addedTabindex = false;
      element.removeAttribute?.("tabindex");
    }
    if (node.savedTouchAction !== null) {
      const prior = node.savedTouchAction;
      node.savedTouchAction = null;
      if (prior) element.style.setProperty("touch-action", prior);
      else element.style.removeProperty("touch-action");
    }
    element.removeAttribute?.("aria-grabbed");
  }

  /**
   * The `touch-action` a source needs BEFORE any touch starts (browsers
   * latch it at touchstart; writing it at lift is too late — the UA pan
   * would `pointercancel` the first move). `none` for `press` / `slop` /
   * `immediate` and for `auto` outside an axis-constrained sortable (the
   * 300ms press); `pan-<axis>` for `auto` inside one, so main-axis travel
   * still scrolls the list while cross-axis slop keeps delivering moves.
   */
  private touchActionFor(node: DndNode): string {
    if (node.source?.activation !== "auto") return "none";
    const origin = this.findOrigin(node);
    if (origin?.sort) return origin.sort.axis === "x" ? "pan-x" : "pan-y";
    return "none";
  }

  private applyTouchAction(node: DndNode): void {
    const style = node.element.style;
    if (node.savedTouchAction === null) node.savedTouchAction = style.getPropertyValue("touch-action") ?? "";
    style.setProperty("touch-action", this.touchActionFor(node));
  }

  // --------------------------------------------------------------------------
  // Pose overlay (§2.1 runtime labels)
  // --------------------------------------------------------------------------

  /** CSS properties a lowered pose key writes (for the save/restore set). */
  private poseCss(node: DndNode, key: string): string[] | null {
    const base = baseOf(key);
    if (isQualified(base)) {
      // Variant-qualified pose keys (`padding@md.0`) lower to stylesheet
      // rules, not inline styles — no inline base to restore. Skipped.
      if (!node.warnedVariantPose) {
        node.warnedVariantPose = true;
        log.warn(`dnd: variant-qualified pose key "${key}" on node ${node.id} is not applied by the runtime`);
      }
      return null;
    }
    const known = ANIMATABLE_PROPS[base];
    return known ? [...known] : [toKebab(base)];
  }

  private applyPose(node: DndNode, label: string): void {
    if (node.poseLabel === label) return;
    if (node.poseLabel !== null) this.clearPose(node);
    const pose = node.poses?.[label];
    if (!pose) return;
    const style = node.element.style;
    node.poseSaved.clear();
    const entries: Array<[string, unknown]> = [];
    for (const [key, value] of Object.entries(pose)) {
      const css = this.poseCss(node, key);
      if (!css) continue;
      for (const prop of css) {
        if (!node.poseSaved.has(prop)) node.poseSaved.set(prop, style.getPropertyValue(prop) ?? "");
      }
      entries.push([key, value]);
    }
    node.poseLabel = label;
    for (const [key, value] of entries) {
      this.host.applyApplicator(node.element, key, value);
    }
  }

  private clearPose(node: DndNode): void {
    if (node.poseLabel === null) return;
    const style = node.element.style;
    for (const [prop, value] of node.poseSaved) {
      if (value) style.setProperty(prop, value);
      else style.removeProperty(prop);
    }
    node.poseSaved.clear();
    node.poseLabel = null;
    if (node.poseDeferred.size > 0) {
      const deferred = [...node.poseDeferred.entries()];
      node.poseDeferred.clear();
      for (const [name, value] of deferred) this.flushDeferred(node.id, name, value);
    }
  }

  private flushDeferred(id: string, name: string, value: unknown): void {
    if (value === REMOVED) this.host.removeProp(id, name);
    else this.host.applyProp(id, name, value);
  }

  // --------------------------------------------------------------------------
  // Pointer source
  // --------------------------------------------------------------------------

  private samePointer(drag: ActiveDrag, event: PointerEventLike): boolean {
    if (drag.pointerId === null) return true;
    return typeof event.pointerId !== "number" || event.pointerId === drag.pointerId;
  }

  private onPointerDown(node: DndNode, event: PointerEventLike): void {
    if (this.drag || !node.source || !node.sourceEnabled) return;
    if (typeof event.button === "number" && event.button !== 0) return;
    const origin = this.findOrigin(node);
    const touch = event.pointerType === "touch";
    let activation: ActiveDrag["activation"];
    switch (node.source.activation) {
      case "immediate":
        activation = "immediate";
        break;
      case "slop":
        activation = "slop";
        break;
      case "press":
        activation = "press";
        break;
      default:
        if (!touch) activation = "slop";
        else if (origin?.sort) activation = { crossAxis: origin.sort.axis === "x" ? "y" : "x" };
        else activation = "press";
    }
    const drag = this.openDrag(node, origin, "pointer");
    drag.pointerId = typeof event.pointerId === "number" ? event.pointerId : null;
    drag.startX = drag.lastX = event.clientX ?? 0;
    drag.startY = drag.lastY = event.clientY ?? 0;
    drag.activation = activation;
    const move = (e: PointerEventLike) => this.onPointerMove(e);
    const up = (e: PointerEventLike) => this.onPointerUp(e);
    const cancel = (e: PointerEventLike) => this.onPointerCancel(e);
    const leave = (e: PointerEventLike) => this.onPointerLeave(e);
    drag.move = move;
    drag.up = up;
    drag.cancel = cancel;
    drag.leave = leave;
    node.element.addEventListener("pointermove", move as EventListener);
    node.element.addEventListener("pointerup", up as EventListener);
    node.element.addEventListener("pointercancel", cancel as EventListener);
    // Before the claim there is no capture: a mouse that leaves the source
    // (or an implicit touch capture that is lost) never delivers its `up`
    // here, so the pending drag must abandon now or it would wedge the
    // runtime (§6.11). After the claim these are removed with the rest.
    node.element.addEventListener("pointerleave", leave as EventListener);
    node.element.addEventListener("lostpointercapture", leave as EventListener);
    if (activation === "immediate") {
      this.claim();
    } else if (activation === "press") {
      drag.pressTimer = setTimeout(() => {
        drag.pressTimer = null;
        if (this.drag === drag && drag.phase === "pending") this.claim();
      }, this.pressDelayMs);
    }
  }

  private onPointerMove(event: PointerEventLike): void {
    const drag = this.drag;
    if (!drag || drag.mode !== "pointer" || !this.samePointer(drag, event)) return;
    const dx = (event.clientX ?? 0) - drag.startX;
    const dy = (event.clientY ?? 0) - drag.startY;
    if (drag.phase === "pending") {
      const act = drag.activation;
      if (act === "slop") {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < this.slopPx) return;
      } else if (act === "press") {
        // Travel before the press fires is a scroll/pan: abandon silently.
        if (Math.max(Math.abs(dx), Math.abs(dy)) >= this.slopPx) this.abandon();
        return;
      } else if (typeof act === "object") {
        const cross = act.crossAxis === "x" ? dx : dy;
        const main = act.crossAxis === "x" ? dy : dx;
        if (Math.abs(cross) >= this.slopPx) {
          // fall through to claim
        } else {
          if (Math.abs(main) >= this.slopPx) this.abandon(); // main-axis travel scrolls
          return;
        }
      } else {
        return; // immediate already claimed
      }
      this.claim();
      if (this.drag !== drag) return;
    }
    if ((drag.phase as ActiveDrag["phase"]) !== "dragging") return;
    drag.lastX = event.clientX ?? 0;
    drag.lastY = event.clientY ?? 0;
    this.updateGhost(dx, dy);
    this.flushStructural(); // a structural change not yet flushed by the renderer
    if (this.drag !== drag) return;
    this.resolveTarget(drag.lastX, drag.lastY);
  }

  private onPointerUp(event: PointerEventLike): void {
    const drag = this.drag;
    if (!drag || drag.mode !== "pointer" || !this.samePointer(drag, event)) return;
    if (drag.phase === "pending") {
      // Below-slop tap / released before the press: TOTAL no-op.
      this.abandon();
      return;
    }
    if (drag.phase !== "dragging") return;
    // The browser's `click` for this up follows synchronously (same input
    // task); it is the tail of the drag, not a tap. Arm the guard, and let
    // it lapse in case no click comes (a later genuine click must fire).
    const source = drag.source;
    source.suppressClick = true;
    setTimeout(() => {
      source.suppressClick = false;
    }, 0);
    this.endPointerListeners(drag);
    this.drop();
  }

  /** `pointerleave` / `lostpointercapture` before the claim: abandon silently. */
  private onPointerLeave(event: PointerEventLike): void {
    const drag = this.drag;
    if (!drag || drag.mode !== "pointer" || !this.samePointer(drag, event)) return;
    if (drag.phase === "pending") this.abandon();
  }

  private onPointerCancel(event: PointerEventLike): void {
    const drag = this.drag;
    if (!drag || drag.mode !== "pointer" || !this.samePointer(drag, event)) return;
    if (drag.phase === "pending") {
      this.abandon();
      return;
    }
    if (drag.phase === "dragging") this.cancelDrag(true);
  }

  /** A pending drag that never claimed: remove listeners, keep silent. */
  private abandon(): void {
    const drag = this.drag;
    if (!drag) return;
    this.clearPressTimer(drag);
    this.endPointerListeners(drag);
    this.drag = null;
  }

  private endPointerListeners(drag: ActiveDrag): void {
    const element = drag.source.element;
    if (drag.move) element.removeEventListener("pointermove", drag.move as EventListener);
    if (drag.up) element.removeEventListener("pointerup", drag.up as EventListener);
    if (drag.cancel) element.removeEventListener("pointercancel", drag.cancel as EventListener);
    if (drag.leave) {
      element.removeEventListener("pointerleave", drag.leave as EventListener);
      element.removeEventListener("lostpointercapture", drag.leave as EventListener);
    }
    drag.move = drag.up = drag.cancel = drag.leave = null;
    if (drag.captured) {
      drag.captured = false;
      releasePointer(element, drag.pointerId);
    }
    this.endDocKey(drag);
  }

  private endDocKey(drag: ActiveDrag): void {
    if (!drag.docKey) return;
    const doc = (drag.source.element as { ownerDocument?: unknown }).ownerDocument as
      | { removeEventListener?: (type: string, l: EventListener, capture?: boolean) => void }
      | undefined;
    doc?.removeEventListener?.("keydown", drag.docKey as EventListener, true);
    drag.docKey = null;
  }

  private clearPressTimer(drag: ActiveDrag): void {
    if (drag.pressTimer !== null) {
      clearTimeout(drag.pressTimer);
      drag.pressTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Lift / ghost
  // --------------------------------------------------------------------------

  private openDrag(source: DndNode, origin: DndNode | null, mode: ActiveDrag["mode"]): ActiveDrag {
    const item = origin?.sort ? this.itemOf(origin, source.element) ?? source.element : source.element;
    const itemId = item.dataset?.hypenId ?? null;
    const originIndex = origin ? this.indexOf(origin, item) : null;
    const from: DndLocation = origin
      ? { zone: this.containerLabel(origin), index: originIndex }
      : { zone: this.looseZoneLabel(source), index: null };
    const drag: ActiveDrag = {
      mode,
      phase: "pending",
      source,
      item,
      itemId,
      origin,
      originIndex,
      from,
      pointerId: null,
      captured: false,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      activation: "slop",
      pressTimer: null,
      dx: 0,
      dy: 0,
      itemRect: measure(item),
      ghostBase: "",
      savedCss: new Map(),
      ghostEngaged: false,
      target: null,
      overNode: null,
      dwellTimer: null,
      lists: new Map(),
      holdTimer: null,
      deferred: new Map(),
      move: null,
      up: null,
      cancel: null,
      leave: null,
      docKey: null,
      machine: null,
      zoneNodes: [],
      zoneCounts: [],
      originZone: 0,
    };
    this.drag = drag;
    return drag;
  }

  /** Activation threshold met: the gesture claims the node. */
  private claim(): void {
    const drag = this.drag;
    if (!drag || drag.phase !== "pending") return;
    this.clearPressTimer(drag);
    drag.phase = "dragging";
    if (drag.mode === "pointer") {
      capturePointer(drag.source.element, drag.pointerId);
      drag.captured = true;
      // Esc cancels a pointer drag (document-level, CAPTURE phase so the
      // drag consumes the key before a Dialog's bubbling Escape-to-close
      // sees it; fake-dom documents have no listener surface, so this is
      // best-effort).
      const doc = (drag.source.element as { ownerDocument?: unknown }).ownerDocument as
        | { addEventListener?: (type: string, l: EventListener, capture?: boolean) => void }
        | undefined;
      if (doc && typeof doc.addEventListener === "function") {
        const key = (event: KeyboardEventLike) => {
          if (event.key === "Escape" && this.drag === drag && drag.phase === "dragging") {
            event.preventDefault?.();
            event.stopPropagation?.();
            this.cancelDrag(true);
          }
        };
        drag.docKey = key;
        doc.addEventListener("keydown", key as EventListener, true);
      }
    }
    this.engageGhost(drag);
    if (drag.origin?.sort) this.listFor(drag.origin); // cache rects before any shift
    drag.source.element.setAttribute("aria-grabbed", "true");
    this.dispatchEvent([drag.source, drag.origin], "onDragStart", this.payload(drag, drag.from));
  }

  /** §6.7 lift CSS + z-raise + `lifted` pose, then capture the ghost base. */
  private engageGhost(drag: ActiveDrag): void {
    const item = drag.item;
    const style = item.style;
    for (const prop of LIFT_CSS) drag.savedCss.set(prop, style.getPropertyValue(prop) ?? "");
    for (const prop of TRANSITION_CSS) drag.savedCss.set(prop, style.getPropertyValue(prop) ?? "");
    style.setProperty("touch-action", "none");
    style.setProperty("user-select", "none");
    style.setProperty("cursor", "grabbing");
    style.setProperty("will-change", "transform");
    style.setProperty("z-index", "1000");
    this.applyPose(drag.source, DND_LABEL_LIFTED);
    // A `transition-property` covering `transform` (the `.states`-synthesized
    // transition of a `scale` pose, or a `.transition(translateX)`) would lag
    // the ghost behind the pointer: drop `transform` from it for the drag.
    const tp = style.getPropertyValue("transition-property") ?? "";
    if (tp) {
      const kept = tp
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "transform" && s !== "all");
      style.setProperty("transition-property", kept.length > 0 ? kept.join(", ") : "none");
    }
    drag.ghostBase = style.transform || "";
    drag.ghostEngaged = true;
  }

  private updateGhost(dx: number, dy: number): void {
    const drag = this.drag;
    if (!drag) return;
    drag.dx = dx;
    drag.dy = dy;
    const translate = `translate(${round3(dx)}px, ${round3(dy)}px)`;
    drag.item.style.transform = drag.ghostBase ? `${translate} ${drag.ghostBase}` : translate;
  }

  // --------------------------------------------------------------------------
  // Geometry: origins, items, lists
  // --------------------------------------------------------------------------

  /** Nearest enclosing sortable / pinboard container of a source. */
  private findOrigin(source: DndNode): DndNode | null {
    let best: DndNode | null = null;
    let bestDepth = -1;
    for (const node of this.nodes.values()) {
      if (!node.sort && !node.pin) continue;
      if (!isWithinSubtree(source.element, node.element)) continue;
      const depth = subtreeDepth(node.element);
      if (depth > bestDepth) {
        best = node;
        bestDepth = depth;
      }
    }
    return best;
  }

  /** The container's direct child that contains (or is) `element`. */
  private itemOf(container: DndNode, element: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = element;
    while (node) {
      const parent = (node as { parentNode?: unknown }).parentNode as HTMLElement | null | undefined;
      if (parent === container.element) return node;
      node = parent ?? null;
    }
    return null;
  }

  /** Direct children of a container that carry (or contain) a source. */
  private draggableItems(container: DndNode): HTMLElement[] {
    const items = new Set<HTMLElement>();
    for (const node of this.nodes.values()) {
      if (!node.source) continue;
      if (node.element === container.element) continue;
      if (!isWithinSubtree(node.element, container.element)) continue;
      const item = this.itemOf(container, node.element);
      if (item) items.add(item);
    }
    const kids = container.element.children as unknown as ArrayLike<HTMLElement> | undefined;
    const ordered: HTMLElement[] = [];
    if (kids) {
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i]!;
        if (items.has(kid)) ordered.push(kid);
      }
    }
    return ordered;
  }

  private indexOf(container: DndNode, item: HTMLElement): number | null {
    const idx = this.draggableItems(container).indexOf(item);
    return idx === -1 ? null : idx;
  }

  private listFor(container: DndNode): ListPreview {
    const drag = this.drag!;
    let list = drag.lists.get(container.id);
    if (list) return list;
    const axis = container.sort?.axis ?? "y";
    const items = this.draggableItems(container);
    const rects = items.map((item) => (item === drag.item ? drag.itemRect : measure(item)));
    list = {
      container,
      axis,
      items,
      rects,
      gap: gapOf(rects, axis),
      shifts: items.map(() => 0),
      saved: new Map(),
      dirty: false,
    };
    drag.lists.set(container.id, list);
    return list;
  }

  /**
   * Re-derive a cached list from the container's live children after an
   * engine insert/remove mid-drag. Layout rects are the live rects minus
   * the preview shift each surviving item still carries (so an in-flight
   * shift transition cannot skew them); shifts follow their items to the
   * new indices, items that left the list get their inline CSS back, and
   * the dragged item keeps its lift rect. For the origin list the live
   * position of the dragged item becomes the reserved write's `from`.
   */
  private rebuildList(list: ListPreview): void {
    const drag = this.drag!;
    const axis = list.axis;
    const items = this.draggableItems(list.container);
    const rects: Rect[] = [];
    const shifts: number[] = [];
    for (const item of items) {
      const prev = list.items.indexOf(item);
      const shift = prev === -1 ? 0 : list.shifts[prev]!;
      shifts.push(shift);
      if (item === drag.item) {
        rects.push(drag.itemRect);
        continue;
      }
      const rect = measure(item);
      if (shift === 0) rects.push(rect);
      else if (axis === "x") rects.push({ ...rect, left: rect.left - shift, right: rect.right - shift });
      else rects.push({ ...rect, top: rect.top - shift, bottom: rect.bottom - shift });
    }
    for (const [item, saved] of list.saved) {
      if (items.includes(item)) continue;
      item.style.transform = saved.transform ?? "";
      this.restoreCss(item, saved);
      list.saved.delete(item);
    }
    list.items = items;
    list.rects = rects;
    list.shifts = shifts;
    list.gap = gapOf(rects, axis);
    if (list.container === drag.origin) {
      const live = items.indexOf(drag.item);
      if (live !== -1) drag.originIndex = live;
    }
  }

  /** Final insertion index of the dragged item for a pointer position along the axis. */
  private insertionIndex(list: ListPreview, pos: number): number {
    const drag = this.drag!;
    let index = 0;
    for (let i = 0; i < list.items.length; i++) {
      if (list.items[i] === drag.item) continue;
      const rect = list.rects[i]!;
      const mid = axisStart(rect, list.axis) + axisLength(rect, list.axis) / 2;
      if (pos >= mid) index += 1;
    }
    return index;
  }

  /** Shift siblings to open the gap for the dragged item at `to`. */
  private previewList(list: ListPreview, to: number): void {
    const drag = this.drag!;
    const size = axisLength(drag.itemRect, list.axis) + list.gap;
    const from = list.items.indexOf(drag.item);
    let others = 0;
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i]!;
      if (item === drag.item) continue;
      let shift = 0;
      if (from === -1) {
        if (others >= to) shift = size;
      } else if (from < to) {
        if (i > from && others < to) shift = -size;
      } else if (to < from) {
        if (i < from && others >= to) shift = size;
      }
      others += 1;
      this.shiftItem(list, i, shift);
    }
  }

  private shiftItem(list: ListPreview, i: number, shift: number): void {
    if (list.shifts[i] === shift) return;
    const item = list.items[i]!;
    let saved = list.saved.get(item);
    if (!saved) {
      saved = {};
      saved.transform = item.style.transform || "";
      for (const prop of TRANSITION_CSS) saved[prop] = item.style.getPropertyValue(prop) ?? "";
      list.saved.set(item, saved);
      if (!this.reducedMotion) item.style.setProperty("transition", SHIFT_TRANSITION);
    }
    list.shifts[i] = shift;
    const fn = list.axis === "x" ? "translateX" : "translateY";
    const base = saved.transform ?? "";
    item.style.transform = shift === 0 ? base : base ? `${fn}(${round3(shift)}px) ${base}` : `${fn}(${round3(shift)}px)`;
  }

  private restoreList(list: ListPreview): void {
    for (const [item, saved] of list.saved) {
      item.style.transform = saved.transform ?? "";
      this.restoreCss(item, saved);
    }
    list.saved.clear();
    list.shifts.fill(0);
  }

  private restoreCss(element: HTMLElement, saved: Record<string, string> | Map<string, string>): void {
    const entries = saved instanceof Map ? saved.entries() : Object.entries(saved);
    for (const [prop, value] of entries) {
      if (prop === "transform") continue;
      if (value) element.style.setProperty(prop, value);
      else element.style.removeProperty(prop);
    }
  }

  private get reducedMotion(): boolean {
    return this.reducedMotionQuery?.matches ?? false;
  }

  // --------------------------------------------------------------------------
  // Zone resolution (§6.4)
  // --------------------------------------------------------------------------

  private containerLabel(node: DndNode): string {
    return node.sort?.group ?? node.pin?.group ?? node.idProp ?? node.id;
  }

  private zoneLabel(node: DndNode): string {
    return node.zoneId ?? node.idProp ?? node.id;
  }

  /** `from.zone` for a source outside any sortable/pinboard: the nearest zone, else the parent. */
  private looseZoneLabel(source: DndNode): string {
    let best: DndNode | null = null;
    let bestDepth = -1;
    for (const node of this.nodes.values()) {
      if (!node.zone || node === source) continue;
      if (!isWithinSubtree(source.element, node.element)) continue;
      const depth = subtreeDepth(node.element);
      if (depth > bestDepth) {
        best = node;
        bestDepth = depth;
      }
    }
    if (best) return this.zoneLabel(best);
    const parent = (source.element as { parentNode?: unknown }).parentNode as HTMLElement | null | undefined;
    return parent?.dataset?.hypenId ?? source.id;
  }

  /**
   * A bare `.draggable()` inside a `.sortable` / `.pinboard` inherits the
   * container's group (design §4.2): the source's own group wins when set.
   */
  private effectiveGroup(source: DndNode, origin: DndNode | null): string | null {
    return source.source?.group ?? origin?.sort?.group ?? origin?.pin?.group ?? null;
  }

  /**
   * Group compatibility. A sortable/pinboard always accepts its own
   * children (self-only when its group is null) and, with a group, any
   * source of that group. A drop zone with a group accepts that group; an
   * ungrouped zone accepts ungrouped sources and its own descendants.
   */
  private accepts(zone: DndNode, source: DndNode): boolean {
    const isDescendant = isWithinSubtree(source.element, zone.element);
    const sourceGroup = this.effectiveGroup(source, this.drag?.origin ?? null);
    if (zone.sort || zone.pin) {
      const group = zone.sort?.group ?? zone.pin?.group ?? null;
      return isDescendant || (group !== null && sourceGroup === group);
    }
    if (!zone.zoneEnabled) return false;
    const group = zone.zone!.group;
    return group !== null ? sourceGroup === group : sourceGroup === null || isDescendant;
  }

  /** Every zone (dropZone / sortable / pinboard) a drag from `source` may target. */
  private candidateZones(source: DndNode): DndNode[] {
    const drag = this.drag!;
    const out: DndNode[] = [];
    for (const node of this.nodes.values()) {
      if (!node.zone && !node.sort && !node.pin) continue;
      if (node === source) continue;
      // A source is never a zone for itself — nor is anything under the
      // dragged item.
      if (node.element === drag.item || isWithinSubtree(node.element, drag.item)) continue;
      if (!this.accepts(node, source)) continue;
      out.push(node);
    }
    return out;
  }

  private resolveTarget(x: number, y: number): void {
    const drag = this.drag!;
    let innermost: DndNode | null = null;
    let bestDepth = -1;
    for (const zone of this.candidateZones(drag.source)) {
      if (!contains(measure(zone.element), x, y)) continue;
      const depth = subtreeDepth(zone.element);
      if (depth > bestDepth) {
        innermost = zone;
        bestDepth = depth;
      }
    }
    let target: DropTarget | null = null;
    if (innermost) {
      if (innermost.sort) {
        const list = this.listFor(innermost);
        target = { kind: "sort", container: innermost, index: this.insertionIndex(list, list.axis === "x" ? x : y) };
      } else if (innermost.pin) {
        target = innermost === drag.origin ? { kind: "pin", container: innermost } : { kind: "zone", node: innermost };
      } else {
        target = this.resolveBandTarget(innermost, x, y);
      }
    }
    this.setTarget(target);
  }

  /** A dropZone on a sortable item: band rule; elsewhere a plain "into". */
  private resolveBandTarget(zone: DndNode, x: number, y: number): DropTarget {
    const drag = this.drag!;
    let sortable: DndNode | null = null;
    let bestDepth = -1;
    for (const node of this.nodes.values()) {
      if (!node.sort || !this.accepts(node, drag.source)) continue;
      if (!isWithinSubtree(zone.element, node.element)) continue;
      const depth = subtreeDepth(node.element);
      if (depth > bestDepth) {
        sortable = node;
        bestDepth = depth;
      }
    }
    if (!sortable) return { kind: "zone", node: zone };
    const list = this.listFor(sortable);
    const item = this.itemOf(sortable, zone.element);
    const i = item ? list.items.indexOf(item) : -1;
    if (i === -1) return { kind: "zone", node: zone };
    const rect = list.rects[i]!;
    const pos = list.axis === "x" ? x : y;
    const band = resolveBand(pos, axisStart(rect, list.axis), axisLength(rect, list.axis), zone.zone!.band);
    if (band === "into") return { kind: "zone", node: zone };
    let others = 0;
    for (let k = 0; k < i; k++) if (list.items[k] !== drag.item) others += 1;
    return { kind: "sort", container: sortable, index: band === "before" ? others : others + 1 };
  }

  private targetNode(target: DropTarget | null): DndNode | null {
    if (!target) return null;
    return target.kind === "zone" ? target.node : target.container;
  }

  private targetLocation(target: DropTarget | null): DndLocation {
    const drag = this.drag!;
    if (!target) return drag.from;
    switch (target.kind) {
      case "sort":
        return { zone: this.containerLabel(target.container), index: target.index };
      case "zone":
        // A foreign compatible sortable/pinboard hit as a plain "into"
        // target is labelled by the §4.2 sortable rule (group → resolved
        // `id` → node id), never by its dropZone id (§6.11).
        return {
          zone: target.node.sort || target.node.pin ? this.containerLabel(target.node) : this.zoneLabel(target.node),
          index: null,
        };
      case "pin":
        return { zone: this.containerLabel(target.container), index: drag.originIndex };
    }
  }

  private setTarget(target: DropTarget | null): void {
    const drag = this.drag!;
    const prevNode = this.targetNode(drag.target);
    const nextNode = this.targetNode(target);
    // Sortable preview: shift the hovered list; reset lists no longer hovered.
    for (const list of drag.lists.values()) {
      if (target?.kind === "sort" && target.container === list.container) {
        this.previewList(list, target.index);
      } else if (list.container === drag.origin && drag.origin.sort) {
        // Leaving the origin list closes its gap only when hovering a
        // foreign target; hovering nothing keeps the last preview.
        if (target !== null) this.previewList(list, drag.originIndex ?? 0);
      } else {
        this.previewList(list, Number.POSITIVE_INFINITY);
      }
    }
    if (nextNode !== prevNode) {
      if (prevNode && prevNode.poseLabel === DND_LABEL_OVER) this.clearPose(prevNode);
      this.clearDwell(drag);
      if (nextNode) {
        this.applyPose(nextNode, DND_LABEL_OVER);
        this.armDwell(drag, nextNode);
      }
    }
    drag.target = target;
    drag.overNode = nextNode;
  }

  private armDwell(drag: ActiveDrag, zone: DndNode): void {
    const binding = getDndEventBinding(zone.element, "onDragOver");
    if (!binding) return;
    const dwell = binding.dwell ?? DND_DEFAULT_DWELL_MS;
    drag.dwellTimer = setTimeout(() => {
      drag.dwellTimer = null;
      if (this.drag !== drag || drag.phase !== "dragging" || drag.overNode !== zone) return;
      this.dispatchEvent([zone], "onDragOver", this.payload(drag, this.targetLocation(drag.target)));
    }, dwell);
  }

  private clearDwell(drag: ActiveDrag): void {
    if (drag.dwellTimer !== null) {
      clearTimeout(drag.dwellTimer);
      drag.dwellTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Drop / cancel / release
  // --------------------------------------------------------------------------

  private payload(drag: ActiveDrag, to: DndLocation): DndEventPayload {
    const item = drag.source.key ?? drag.source.id;
    const out: DndEventPayload = { item } as DndEventPayload;
    if (drag.source.hasPayload) out.payload = drag.source.payload;
    out.from = { zone: drag.from.zone, index: drag.from.index };
    out.to = { zone: to.zone, index: to.index };
    return out;
  }

  /** Dispatch `name` to the first candidate node carrying that binding. */
  private dispatchEvent(
    candidates: ReadonlyArray<DndNode | null>,
    name: DndEventName,
    payload: DndEventPayload
  ): void {
    for (const node of candidates) {
      if (!node) continue;
      const binding = getDndEventBinding(node.element, name);
      if (!binding) continue;
      const merged: Record<string, unknown> = { ...binding.customPayload, ...payload };
      dispatchElementAction(node.element, binding.actionName, merged, binding.animate, name === "onSort" ? this.drag?.origin?.id : undefined);
      return;
    }
  }

  private dispatchReserved(drag: ActiveDrag, name: string, payload: Record<string, unknown>): void {
    const owner = drag.target?.kind === "sort" ? drag.target.container : (drag.origin?.bind ? drag.origin : drag.source);
    if (!dispatchElementAction(owner.element, name, payload, undefined, drag.origin?.id)) {
      log.warn(`dnd: no engine bound to node ${drag.source.id}; ${name} dropped`);
    }
  }

  /** Pointer released (or keyboard Space) over the current target. */
  private drop(): void {
    const drag = this.drag;
    if (!drag || drag.phase !== "dragging") return;
    const target = drag.target;
    if (!target) {
      this.cancelDrag(true);
      return;
    }
    this.commit(target);
  }

  /**
   * Resolve a drop (§4.2 ordering): (1) the reserved write when a write
   * target exists, (2) `.onSort` / `.onPin` / `.onDrop`, (3) `.onDragEnd
   * {dropped: true}`; then hold the local transforms until the engine's
   * re-render lands (or the timeout).
   */
  private commit(target: DropTarget): void {
    const drag = this.drag!;
    this.clearDwell(drag);
    const to = this.targetLocation(target);
    const base = this.payload(drag, to);
    // Enter the hold BEFORE dispatching: a synchronous engine may re-render
    // inside the dispatch, and its Move/SetProp must find the hold to release.
    drag.phase = "holding";
    drag.target = target;
    this.endPointerListeners(drag);
    let wroteOrChanged = true;
    switch (target.kind) {
      case "sort": {
        const dest = target.container;
        const sameList = dest === drag.origin;
        if (sameList && drag.originIndex === target.index) {
          wroteOrChanged = false;
          break;
        }
        const fromPath = drag.origin?.bind ?? null;
        const toPath = dest.bind;
        if (sameList && toPath !== null && drag.originIndex !== null) {
          this.dispatchReserved(drag, DND_REORDER_ACTION, {
            path: toPath,
            from: drag.originIndex,
            to: target.index,
          });
        } else if (!sameList && fromPath !== null && toPath !== null && drag.originIndex !== null) {
          this.dispatchReserved(drag, DND_REORDER_ACTION, {
            fromPath,
            from: drag.originIndex,
            toPath,
            to: target.index,
          });
        } else if (!sameList && (fromPath !== null) !== (toPath !== null) && !this.warnedMixedBind) {
          this.warnedMixedBind = true;
          log.warn("dnd: cross-list reorder between a bound and an unbound sortable; no reserved write dispatched");
        }
        this.dispatchEvent([dest], "onSort", base);
        break;
      }
      case "zone":
        this.dispatchEvent([target.node], "onDrop", base);
        break;
      case "pin": {
        const board = target.container;
        const spec = board.pin!;
        const box = this.contentBox(board.element);
        // The content box is the VISIBLE scrollport: a board that scrolls
        // its own content positions children in content space, so the
        // board's scroll offset is added back (and the clamp/fraction size
        // is the scrollable content size).
        const scroller = board.element as HTMLElement & {
          scrollLeft?: number;
          scrollTop?: number;
          scrollWidth?: number;
          scrollHeight?: number;
        };
        const scrollX = typeof scroller.scrollLeft === "number" ? scroller.scrollLeft : 0;
        const scrollY = typeof scroller.scrollTop === "number" ? scroller.scrollTop : 0;
        const contentW = spec.units === "fraction" ? box.width : Math.max(
          box.width,
          (typeof scroller.scrollWidth === "number" ? scroller.scrollWidth : 0) - box.padX
        );
        const contentH = spec.units === "fraction" ? box.height : Math.max(
          box.height,
          (typeof scroller.scrollHeight === "number" ? scroller.scrollHeight : 0) - box.padY
        );
        const rawX = drag.itemRect.left + drag.dx - box.left + scrollX;
        const rawY = drag.itemRect.top + drag.dy - box.top + scrollY;
        let px = snapToGrid(rawX, spec.grid);
        let py = snapToGrid(rawY, spec.grid);
        if (spec.bounds === "clamp") {
          px = Math.min(Math.max(0, px), Math.max(0, contentW - drag.itemRect.width));
          py = Math.min(Math.max(0, py), Math.max(0, contentH - drag.itemRect.height));
        }
        // Snap the ghost to the resolved position so the hold shows it.
        this.updateGhost(px - scrollX + box.left - drag.itemRect.left, py - scrollY + box.top - drag.itemRect.top);
        const x = round3(spec.units === "fraction" ? (contentW > 0 ? px / contentW : 0) : px);
        const y = round3(spec.units === "fraction" ? (contentH > 0 ? py / contentH : 0) : py);
        let path: string | null = null;
        if (board.bind !== null) {
          if (drag.originIndex !== null) path = userPinPath(board.bind, drag.originIndex);
        } else if (spec.group !== null) {
          path = reservedPinPath(spec.group, drag.source.key ?? drag.source.id);
        }
        if (path !== null) {
          this.dispatchReserved(drag, DND_PIN_ACTION, { path, x, y, xKey: spec.xKey, yKey: spec.yKey });
        }
        const pinPayload: DndEventPayload = { ...base, x, y };
        this.dispatchEvent([board], "onPin", pinPayload);
        break;
      }
    }
    const end: DndEventPayload = { ...base, dropped: true };
    if (this.drag === drag) {
      if (wroteOrChanged) {
        drag.holdTimer = setTimeout(() => {
          drag.holdTimer = null;
          if (this.drag === drag) this.release();
        }, this.cleanupTimeoutMs);
      } else {
        this.release();
      }
    }
    this.dispatchEvent([drag.source, drag.origin], "onDragEnd", end);
    this.announce(drag.mode === "keyboard" ? `${base.item}, dropped` : "");
  }

  private contentBox(element: HTMLElement): {
    left: number;
    top: number;
    width: number;
    height: number;
    /** Horizontal padding (both sides) — `scrollWidth` includes it, the content box does not. */
    padX: number;
    padY: number;
  } {
    const rect = measure(element);
    let pl = 0;
    let pt = 0;
    let pr = 0;
    let pb = 0;
    let bl = 0;
    let bt = 0;
    let br = 0;
    let bb = 0;
    try {
      const cs =
        typeof window !== "undefined" && typeof window.getComputedStyle === "function"
          ? (window.getComputedStyle(element) as Partial<CSSStyleDeclaration>)
          : null;
      const num = (v: unknown): number => {
        const n = typeof v === "string" ? parseFloat(v) : NaN;
        return Number.isFinite(n) ? n : 0;
      };
      if (cs) {
        pl = num(cs.paddingLeft);
        pt = num(cs.paddingTop);
        pr = num(cs.paddingRight);
        pb = num(cs.paddingBottom);
        bl = num(cs.borderLeftWidth);
        bt = num(cs.borderTopWidth);
        br = num(cs.borderRightWidth);
        bb = num(cs.borderBottomWidth);
      }
    } catch {
      // No computed style (tests): the border box is the content box.
    }
    return {
      left: rect.left + bl + pl,
      top: rect.top + bt + pt,
      width: Math.max(0, rect.width - bl - br - pl - pr),
      height: Math.max(0, rect.height - bt - bb - pt - pb),
      padX: pl + pr,
      padY: pt + pb,
    };
  }

  /**
   * Abandon a claimed drag: restore everything, release capture. With
   * `dispatchEnd` (user cancel: Esc, pointercancel, drop outside) only
   * `.onDragEnd {dropped: false}` fires; without it (Remove/Detach) nothing.
   */
  private cancelDrag(dispatchEnd: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.phase === "pending") {
      this.abandon();
      return;
    }
    const end: DndEventPayload | null =
      dispatchEnd && drag.phase === "dragging"
        ? { ...this.payload(drag, this.targetLocation(drag.target)), dropped: false }
        : null;
    this.endPointerListeners(drag);
    this.release();
    if (end) {
      this.dispatchEvent([drag.source, drag.origin], "onDragEnd", end);
      this.announce(drag.mode === "keyboard" ? `${end.item}, cancelled` : "");
    }
  }

  /** Hand every touched node back to the engine and forget the drag. */
  private release(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.clearPressTimer(drag);
    this.clearDwell(drag);
    if (drag.holdTimer !== null) {
      clearTimeout(drag.holdTimer);
      drag.holdTimer = null;
    }
    this.endPointerListeners(drag);
    for (const list of drag.lists.values()) this.restoreList(list);
    if (drag.overNode && drag.overNode.poseLabel === DND_LABEL_OVER) this.clearPose(drag.overNode);
    if (drag.ghostEngaged) {
      drag.item.style.transform = drag.ghostBase;
      this.clearPose(drag.source); // restores the pre-pose transform when the pose touched it
      this.restoreCss(drag.item, drag.savedCss);
    }
    drag.source.element.setAttribute("aria-grabbed", "false");
    // Deferred translate writes flow through the renderer's path now that
    // the node is released; the transform applicators compose each function
    // kind in place, so the restored base is simply updated.
    for (const [id, bucket] of drag.deferred) {
      for (const [name, value] of bucket) this.flushDeferred(id, name, value);
    }
    drag.deferred.clear();
  }

  // --------------------------------------------------------------------------
  // Keyboard (§6.8)
  // --------------------------------------------------------------------------

  private onKeyDown(node: DndNode, event: KeyboardEventLike): void {
    const key = event.key;
    const drag = this.drag;
    if (!drag) {
      // Space lifts only when the draggable ITSELF is the key target: a
      // Space typed into a child Input / Textarea, or pressed on a child
      // Button, belongs to that child (bubbling brings it here too).
      const target = event.target;
      const own = target === undefined || target === null || target === node.element;
      if ((key === " " || key === "Spacebar") && own && node.source && node.sourceEnabled) {
        event.preventDefault?.();
        this.keyboardLift(node);
      }
      return;
    }
    if (drag.mode !== "keyboard" || drag.source !== node || drag.phase !== "dragging") return;
    const machine = drag.machine!;
    switch (key) {
      case " ":
      case "Spacebar":
      case "Enter": {
        event.preventDefault?.();
        const current = machine.current()!;
        const moved = machine.hasMoved();
        const zoneNode = this.keyboardZoneNode(drag, current);
        machine.drop();
        if (!moved || !zoneNode) {
          // Dropped where it started (or on the loose origin): nothing
          // changed — release and report the drop, no write, no onSort.
          const end: DndEventPayload = { ...this.payload(drag, drag.from), dropped: true };
          this.release();
          this.dispatchEvent([drag.source, drag.origin], "onDragEnd", end);
          this.announce(`${end.item}, dropped`);
          return;
        }
        const target: DropTarget = zoneNode.sort
          ? { kind: "sort", container: zoneNode, index: current.index ?? 0 }
          : { kind: "zone", node: zoneNode };
        drag.target = target;
        this.commit(target);
        return;
      }
      case "Escape":
        // Consumed: a Dialog's Escape-to-close must not also fire.
        event.preventDefault?.();
        event.stopPropagation?.();
        machine.cancel();
        this.cancelDrag(true);
        return;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault?.();
        machine.move("prev");
        break;
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault?.();
        machine.move("next");
        break;
      case "Tab":
        event.preventDefault?.();
        machine.moveZone(event.shiftKey ? "prev" : "next");
        break;
      default:
        return;
    }
    this.keyboardPreview(drag);
  }

  private keyboardLift(node: DndNode): void {
    const origin = this.findOrigin(node);
    if (origin?.pin) {
      log.warn(`dnd: keyboard drag is not supported on pinboard items (node ${node.id})`);
      return;
    }
    const drag = this.openDrag(node, origin, "keyboard");
    // Zones are identified by NODE id (§6.11): two sortables sharing a
    // group are distinct keyboard targets; labels are resolved only for
    // the payload and the announcement.
    const zones: KeyboardDragZone[] = [];
    const zoneNodes: DndNode[] = [];
    let originZone = 0;
    if (origin?.sort) {
      zones.push({ id: origin.id, count: this.draggableItems(origin).length });
      zoneNodes.push(origin);
    }
    for (const zone of this.candidateZones(node)) {
      if (zone === origin || zone.pin) continue;
      zones.push({ id: zone.id, count: zone.sort ? this.draggableItems(zone).length : null });
      zoneNodes.push(zone);
    }
    if (!origin?.sort) {
      if (zones.length === 0) {
        this.drag = null;
        return; // nowhere to go
      }
      // A loose draggable: its origin is a pseudo-zone the machine needs,
      // keyed by the source node itself; `from` in the payload stays the
      // runtime's own location.
      zones.unshift({ id: node.id, count: null });
      zoneNodes.unshift(node);
      originZone = 0;
    }
    const machine = new KeyboardDragMachine();
    if (!machine.lift(drag.source.key ?? drag.source.id, zones, drag.originIndex ?? 0, originZone)) {
      this.drag = null;
      return;
    }
    drag.machine = machine;
    drag.zoneNodes = zoneNodes;
    drag.zoneCounts = zones.map((z) => z.count);
    drag.originZone = originZone;
    this.claim();
    this.announce(this.describeKeyboard(drag));
  }

  /** Index into `zoneNodes` of the machine's current zone (a node id). */
  private keyboardZoneIndex(drag: ActiveDrag, loc: DndLocation): number {
    return drag.zoneNodes.findIndex((node) => node.id === loc.zone);
  }

  /** The node behind the machine's current zone; `null` for the loose pseudo-origin. */
  private keyboardZoneNode(drag: ActiveDrag, loc: DndLocation): DndNode | null {
    const i = this.keyboardZoneIndex(drag, loc);
    if (i === -1) return null;
    const node = drag.zoneNodes[i]!;
    return node === drag.source ? null : node;
  }

  /** §4.2 label of a keyboard zone node (the source stands in for a loose origin). */
  private keyboardZoneLabel(drag: ActiveDrag, node: DndNode): string {
    if (node === drag.source) return drag.from.zone;
    return node.sort ? this.containerLabel(node) : this.zoneLabel(node);
  }

  /**
   * Live-region text for the machine's position — the same sentences as
   * `KeyboardDragMachine.describe()`, with zone LABELS in place of the node
   * ids the machine is keyed by.
   */
  private describeKeyboard(drag: ActiveDrag): string {
    const current = drag.machine?.current();
    if (!current) return "";
    const i = this.keyboardZoneIndex(drag, current);
    if (i === -1) return "";
    const item = drag.source.key ?? drag.source.id;
    const label = this.keyboardZoneLabel(drag, drag.zoneNodes[i]!);
    if (current.index === null) return `${item}, over ${label}`;
    const atOrigin = i === drag.originZone;
    const count = drag.zoneCounts[i] ?? null;
    const total = atOrigin ? count : count === null ? null : count + 1;
    const position = `position ${current.index + 1}${total === null ? "" : ` of ${total}`}`;
    return atOrigin ? `${item}, ${position}` : `${item}, ${label}, ${position}`;
  }

  /** Mirror the machine's position visually and announce it. */
  private keyboardPreview(drag: ActiveDrag): void {
    const machine = drag.machine!;
    const current = machine.current()!;
    const zoneNode = this.keyboardZoneNode(drag, current);
    let target: DropTarget | null = null;
    if (zoneNode?.sort) {
      this.listFor(zoneNode); // a foreign list opens its gap like a hovered one
      target = { kind: "sort", container: zoneNode, index: current.index ?? 0 };
    } else if (zoneNode) {
      target = { kind: "zone", node: zoneNode };
    }
    this.setTarget(target);
    // Ghost: slide the item to its target slot within the origin list.
    if (target?.kind === "sort" && target.container === drag.origin && drag.originIndex !== null) {
      const list = this.listFor(drag.origin);
      const from = drag.originIndex;
      const to = Math.min(target.index, list.rects.length - 1);
      let offset = 0;
      if (to < from) offset = axisStart(list.rects[to]!, list.axis) - axisStart(list.rects[from]!, list.axis);
      else if (to > from) {
        const a = list.rects[to]!;
        const b = list.rects[from]!;
        offset = axisStart(a, list.axis) + axisLength(a, list.axis) - (axisStart(b, list.axis) + axisLength(b, list.axis));
      }
      this.updateGhost(list.axis === "x" ? offset : 0, list.axis === "x" ? 0 : offset);
    } else {
      this.updateGhost(0, 0);
    }
    this.announce(this.describeKeyboard(drag));
  }

  // --------------------------------------------------------------------------
  // Live region
  // --------------------------------------------------------------------------

  private announce(text: string): void {
    if (!text) return;
    const region = this.ensureLiveRegion();
    if (!region) return;
    // Repeating the same string would not re-announce; toggle a suffix.
    const value = text === this.lastAnnouncement ? `${text}​` : text;
    this.lastAnnouncement = value;
    region.textContent = value;
  }

  /**
   * The shared polite live region — created EAGERLY (first arm) and left
   * empty, so the first announcement is a change to an existing region
   * rather than a region inserted with content (which AT tends to skip).
   */
  private ensureLiveRegion(): HTMLElement | null {
    if (this.liveRegion) return this.liveRegion;
    if (typeof document === "undefined" || !document.body) return null;
    // One region per document: a second renderer (or a re-mounted one)
    // reuses the existing announcer instead of stacking live regions.
    const kids = document.body.children as unknown as ArrayLike<HTMLElement> | undefined;
    if (kids) {
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i]!;
        if (kid.getAttribute?.(LIVE_REGION_ATTR) != null) {
          this.liveRegion = kid;
          return kid;
        }
      }
    }
    const region = document.createElement("div");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("role", "status");
    region.setAttribute(LIVE_REGION_ATTR, "");
    const s = region.style;
    s.setProperty("position", "absolute");
    s.setProperty("width", "1px");
    s.setProperty("height", "1px");
    s.setProperty("margin", "-1px");
    s.setProperty("padding", "0");
    s.setProperty("border", "0");
    s.setProperty("overflow", "hidden");
    s.setProperty("clip", "rect(0 0 0 0)");
    s.setProperty("white-space", "nowrap");
    document.body.appendChild(region);
    this.liveRegion = region;
    return region;
  }
}

/** Parse `__anim.statePoses` defensively: `{ label: { key: value } }` or null. */
function parsePoses(raw: unknown): StatePoses | null {
  const value = toPlain(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: StatePoses = {};
  for (const [label, pose] of Object.entries(value as Record<string, unknown>)) {
    if (typeof pose !== "object" || pose === null || Array.isArray(pose)) continue;
    out[label] = pose as Record<string, unknown>;
  }
  return out;
}
