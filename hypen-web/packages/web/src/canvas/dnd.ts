import { pinOffset } from "./pin-position";
import { dispatchUIAction } from "@hypen-space/core";
/**
 * Canvas drag-and-drop runtime (`__dnd.*` channel consumption).
 *
 * The engine lowers `.draggable` / `.dropZone` / `.sortable` / `.pinboard`
 * into reserved `__dnd.*` props (shapes in `@hypen-space/core/dnd`) and
 * stamps every `ForEach`-row draggable with its item key. This module is the
 * Canvas 2D side of that contract: a renderer-resident gesture that never
 * touches the engine while the pointer is down (plan §6 — zero engine
 * traffic except the opted-in `.onDragStart` / `.onDragOver` escalations);
 * only the drop crosses the boundary.
 *
 * The canvas owns the whole scene graph, so everything is geometry on the
 * `VirtualNode` tree the renderer already has:
 *
 * - ACTIVATION (§6.1): `mousedown` on (or inside) a source opens a PENDING
 *   drag that claims the pointer per the source's activation — `auto`/`slop`
 *   is a 6px any-axis slop, `press` a 300ms hold, `immediate` claims on the
 *   press. Below the threshold a release is a TOTAL no-op: no capture, no
 *   events, and the ordinary click path runs untouched. The canvas receives
 *   mouse events only, so the touch-specific rules (cross-axis slop in an
 *   axis-constrained sortable, press elsewhere) do not apply here.
 *
 * - GHOST (§6.2): the lifted item (the sortable's direct child containing
 *   the source, else the source itself) gets `dndGhost` + a `dndOffset` of
 *   the pointer delta. `paint.ts` skips it in tree order and the renderer
 *   paints it LAST through `paintDndGhost` (above every sibling, unclipped);
 *   hit-testing skips it so the pointer sees what is under it. The `lifted`
 *   pose of a header-less `.states` block (`__anim.statePoses`) is overlaid
 *   on the source through the renderer's ordinary setProp path and the base
 *   restored when the label clears (§2.1).
 *
 * - SORTABLE PREVIEW (§6.3): siblings shift via their own `dndOffset` (an
 *   outer translate on the subtree) to open the gap; rects are cached at
 *   lift from the untransformed layout so the insertion index is stable,
 *   and rebuilt from the live children after an engine insert/remove under
 *   ANY cached list mid-drag (origin included — the reserved write's `from`
 *   follows the item's live index, the EVENT payload's `from` stays the
 *   lift location; `noteStructural` / `noteLayout`). On
 *   drop the reserved write and events dispatch, then the local offsets are
 *   HELD until the engine's re-render lands — a `Move`/`Insert`/`Remove`
 *   under the origin or destination list, a `Remove` of the item, or
 *   (pinboards) the translate SetProp on the dragged node — or 500ms, then
 *   released. No flash.
 *
 * - ZONES (§6.4): the innermost enabled, group-compatible zone under the
 *   pointer wins — resolved by walking UP from the event manager's hit node
 *   (the ghost is excluded from that hit test). A zone on a sortable item
 *   applies the band rule (`resolveBand`); a source (and anything under the
 *   lifted item) is never a zone for itself. The `over` pose is overlaid on
 *   the hovered zone; `.onDragOver(dwell:)` fires once per entry.
 *
 * - PINBOARD (§6.5): `(x, y)` = the item's visual top-left minus the board's
 *   content-box origin in logical units, grid-snapped, clamped under
 *   `bounds: clamp`, divided by the content size under `units: fraction`.
 *   The ghost snaps to the resolved position for the hold.
 *
 * - PRECEDENCE (§6.6): engine SetProps to `translateX`/`translateY` on the
 *   dragged node — and to the pose-overridden keys of a node carrying a
 *   runtime label — are deferred until release ({@link deferEngineProp}).
 *   A `Remove`/`Detach` mid-drag cancels cleanly and dispatches NOTHING.
 *
 * - KEYBOARD (§6.8): the core `KeyboardDragMachine` drives Space (lift /
 *   drop), Arrow keys, Tab / Shift+Tab and Esc from the focus manager's
 *   mirror keydown path; drops go through the same commit as a pointer drop.
 */

import {
  DND_DEFAULT_DWELL_MS,
  DND_DRAG_OVER_DWELL_KEY,
  DND_KEY_PROP,
  DND_LABEL_LIFTED,
  DND_LABEL_OVER,
  DND_PIN_ACTION,
  DND_PIN_PROP,
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
import { ACTION_ANIMATE_KEY } from "@hypen-space/core/types";
import { frameworkLoggers } from "@hypen-space/core/logger";
import type { Point, VirtualNode } from "./types.js";
import { resolveEventAction } from "./props.js";

const log = frameworkLoggers.canvas;

/**
 * `__anim.statePoses` — the header-less `.states` pose table
 * (`{ "<label>": { "<loweredPropKey>": value } }`, plan §2.1). Emitted only
 * on nodes carrying a `__dnd.*` prop; its labels are driven by this runtime.
 */
export const ANIM_STATE_POSES_PROP = "__anim.statePoses";

/** Pointer travel (px) below which a gesture is a tap, not a drag claim. */
export const DND_SLOP_PX = 6;
/** `activation: press` hold before the lift. */
export const DND_PRESS_MS = 300;
/** Hold window after a drop before local offsets are released (no-flash fallback). */
const DEFAULT_CLEANUP_TIMEOUT_MS = 500;

const TRANSLATE_BASES = new Set(["translateX", "translateY"]);

/** What the runtime needs from the renderer. */
export interface CanvasDndHost {
  dispatchAction(name: string, payload?: unknown): void;
  /** Repaint. A drag frame moves subtrees, so the renderer marks everything dirty. */
  scheduleRedraw(): void;
  /**
   * Apply one prop through the renderer's ordinary setProp path (applicator
   * aggregate refresh, computed props, transition channel) — BYPASSING the
   * DnD deferral gate, since the runtime itself is writing.
   */
  applyProp(node: VirtualNode, name: string, value: unknown): void;
  /** Remove one prop through the ordinary removeProp path, bypassing deferral. */
  removeProp(node: VirtualNode, name: string): void;
  /** Optional: set/clear an attribute on the node's accessibility-mirror element. */
  setMirrorAttribute?(id: string, name: string, value: string | null): void;
  /**
   * Optional: the renderer's hit test at a pointer-space point (the ghost
   * excluded). Used to re-resolve the target at the last pointer position
   * after a mid-drag engine insert/remove rebuilt a cached list.
   */
  hitTest?(point: Point): VirtualNode | null;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type StatePoses = Record<string, Record<string, unknown>>;

/** Cached geometry + live shifts of one sortable list during a drag. */
interface ListPreview {
  container: VirtualNode;
  axis: DndAxis;
  items: VirtualNode[];
  /** Visual rects at cache time (own DnD offset excluded — the unshifted slot). */
  rects: Rect[];
  /** Estimated inter-item gap along the axis. */
  gap: number;
  shifts: number[];
  /**
   * An engine insert/remove touched this list mid-drag: its slots are
   * rebuilt from the live children once the next layout has run
   * ({@link CanvasDnd.noteLayout}) — the inserted nodes have no layout
   * before that.
   */
  stale: boolean;
}

type DropTarget =
  | { kind: "sort"; container: VirtualNode; index: number }
  | { kind: "zone"; node: VirtualNode }
  | { kind: "pin"; container: VirtualNode };

/** A runtime pose overlay on one node. */
interface PoseState {
  label: string;
  /** Base value per lowered key before the overlay (`present: false` = absent). */
  saved: Map<string, { present: boolean; value: unknown }>;
  /** Deferred engine writes to overridden keys, flushed when the label clears. */
  deferred: Map<string, { remove: boolean; value: unknown }>;
}

interface ActiveDrag {
  mode: "pointer" | "keyboard";
  phase: "pending" | "dragging" | "holding";
  source: VirtualNode;
  /** The node that moves (sortable row, or the source itself). */
  item: VirtualNode;
  /** Enclosing sortable / pinboard, if any. */
  origin: VirtualNode | null;
  originIndex: number | null;
  from: DndLocation;
  startX: number;
  startY: number;
  activation: "immediate" | "slop" | "press";
  pressTimer: ReturnType<typeof setTimeout> | null;
  dx: number;
  dy: number;
  /** Item visual rect at lift (before the ghost offset). */
  itemRect: Rect;
  /**
   * The item's live (unshifted) slot minus its lift slot: after an engine
   * insert/remove above it, the item's own layout box moved, and the ghost
   * — painted at the live box plus `dndOffset` — must NOT jump under a
   * still pointer. `updateGhost` subtracts this so the ghost stays at
   * `itemRect + (dx, dy)`.
   */
  anchor: { x: number; y: number };
  /** Last pointer position (pointer mode): the target is re-resolved here after a list rebuild. */
  lastPoint: Point | null;
  target: DropTarget | null;
  overNode: VirtualNode | null;
  dwellTimer: ReturnType<typeof setTimeout> | null;
  lists: Map<string, ListPreview>;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** Deferred engine writes to the dragged node's translate keys. */
  deferred: Map<string, Map<string, { remove: boolean; value: unknown }>>;
  machine: KeyboardDragMachine | null;
  /** Keyboard zone order, parallel to the machine's zones. */
  zoneNodes: VirtualNode[];
}

const baseOf = (name: string): string => {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
};

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

const axisStart = (rect: Rect, axis: DndAxis): number => (axis === "x" ? rect.x : rect.y);
const axisLength = (rect: Rect, axis: DndAxis): number => (axis === "x" ? rect.width : rect.height);

/** Estimated inter-item gap along the axis from the first two slots. */
function gapOf(rects: Rect[], axis: DndAxis): number {
  if (rects.length < 2) return 0;
  const a = rects[0]!;
  const b = rects[1]!;
  return Math.max(0, axisStart(b, axis) - (axisStart(a, axis) + axisLength(a, axis)));
}

/** WASM patches can carry nested Maps; the channel parsers want plain values. */
function toPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) obj[String(key)] = toPlain(entry);
    return obj;
  }
  if (Array.isArray(value)) return value.map(toPlain);
  return value;
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

function isWithin(node: VirtualNode | null, root: VirtualNode): boolean {
  let cur: VirtualNode | null = node;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Channel readers (specs are read off the live node props — the canvas keeps
// the whole tree, so no parallel cache is needed)
// ---------------------------------------------------------------------------

export function dndSourceOf(node: VirtualNode): DndSourceSpec | null {
  const raw = node.props[DND_SOURCE_PROP];
  return raw === undefined ? null : parseDndSource(toPlain(raw));
}
export function dndSourceEnabled(node: VirtualNode): boolean {
  return parseDndEnabled(toPlain(node.props[DND_SOURCE_ENABLED_PROP]));
}
export function dndZoneOf(node: VirtualNode): DndZoneSpec | null {
  const raw = node.props[DND_ZONE_PROP];
  return raw === undefined ? null : parseDndZone(toPlain(raw));
}
export function dndZoneEnabled(node: VirtualNode): boolean {
  return parseDndEnabled(toPlain(node.props[DND_ZONE_ENABLED_PROP]));
}
export function dndSortOf(node: VirtualNode): DndSortSpec | null {
  const raw = node.props[DND_SORT_PROP];
  return raw === undefined ? null : parseDndSort(toPlain(raw));
}
export function dndPinOf(node: VirtualNode): DndPinSpec | null {
  const raw = node.props[DND_PIN_PROP];
  return raw === undefined ? null : parseDndPin(toPlain(raw));
}
/** `__dnd.key`, else the node id (plan §2). */
export function dndKeyOf(node: VirtualNode): string {
  return parseDndString(toPlain(node.props[DND_KEY_PROP])) ?? node.id;
}
function bindOf(node: VirtualNode): string | null {
  const raw = node.props.bind;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}
function idPropOf(node: VirtualNode): string | null {
  return parseDndString(toPlain(node.props["id.0"] ?? node.props.id));
}
/** Is this node any kind of zone (dropZone / sortable / pinboard)? */
function isZoneNode(node: VirtualNode): boolean {
  return (
    node.props[DND_ZONE_PROP] !== undefined ||
    node.props[DND_SORT_PROP] !== undefined ||
    node.props[DND_PIN_PROP] !== undefined
  );
}
/** Does this subtree contain (or is it) a draggable source? */
function containsSource(node: VirtualNode): boolean {
  if (node.props[DND_SOURCE_PROP] !== undefined) return true;
  for (const child of node.children) {
    if (containsSource(child)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Geometry in pointer space (the hit-test coordinate system)
// ---------------------------------------------------------------------------

/**
 * A node's visual box in canvas coordinates: the layout box shifted by every
 * ancestor's scroll, by the author `translateX/translateY` of the node and
 * its ancestors (paint scopes transforms to the subtree; `null` translate is
 * 0), and by the ancestors' DnD offsets. The node's OWN DnD offset is
 * excluded unless asked — a sortable row's cached slot is its unshifted box.
 */
export function visualRect(node: VirtualNode, includeOwnOffset = false): Rect {
  const layout = node.layout!;
  let dx = (parseFloat(node.props.translateX) || 0) + pinOffset(node).x + (includeOwnOffset ? node.dndOffset?.x ?? 0 : 0);
  let dy = (parseFloat(node.props.translateY) || 0) + pinOffset(node).y + (includeOwnOffset ? node.dndOffset?.y ?? 0 : 0);
  for (let a = node.parent; a; a = a.parent) {
    const ss = a.scrollState;
    if (ss) {
      dx -= ss.scrollX;
      dy -= ss.scrollY;
    }
    dx += (parseFloat(a.props.translateX) || 0) + pinOffset(a).x + (a.dndOffset?.x ?? 0);
    dy += (parseFloat(a.props.translateY) || 0) + pinOffset(a).y + (a.dndOffset?.y ?? 0);
  }
  return { x: layout.x + dx, y: layout.y + dy, width: layout.width, height: layout.height };
}

/** The node's content box (inside padding/border) in the same space. */
function contentBox(node: VirtualNode): Rect {
  const layout = node.layout!;
  const rect = visualRect(node);
  return {
    x: rect.x + (layout.contentX - layout.x),
    y: rect.y + (layout.contentY - layout.y),
    width: layout.contentWidth,
    height: layout.contentHeight,
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class CanvasDnd {
  /** Hold window after a drop before local offsets are released (no-flash fallback). */
  public cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS;
  /** `activation: press` delay. */
  public pressDelayMs = DND_PRESS_MS;
  /** Slop threshold (px) for slop-style activations. */
  public slopPx = DND_SLOP_PX;

  private host: CanvasDndHost;
  private drag: ActiveDrag | null = null;
  /** Active runtime pose per node id. */
  private poses = new Map<string, PoseState>();
  private warnedMixedBind = false;
  /** The `files: true` zone lit by an OS file drag (one at a time). */
  private filesOver: VirtualNode | null = null;
  /** `.onFileDragEnter` nodes the OS file drag is currently inside (fired once per entry). */
  private fileEntered = new Set<VirtualNode>();

  constructor(host: CanvasDndHost) {
    this.host = host;
  }

  // --------------------------------------------------------------------------
  // State queries
  // --------------------------------------------------------------------------

  /** A press landed on a source and awaits activation. */
  isPending(): boolean {
    return this.drag?.phase === "pending";
  }

  /** The pointer is claimed (dragging) — hover/click handling stands down. */
  isDragging(): boolean {
    return this.drag?.phase === "dragging";
  }

  /** Any drag phase, including the post-drop hold. */
  isActive(): boolean {
    return this.drag !== null;
  }

  /** The lifted item while dragging/holding (painted by the ghost pass). */
  ghostNode(): VirtualNode | null {
    const drag = this.drag;
    if (!drag || drag.phase === "pending") return null;
    return drag.item;
  }

  /**
   * Does the drag own `id` — the dragged item/source (dragging or holding),
   * or a sibling holding a preview shift?
   */
  ownsNode(id: string): boolean {
    const drag = this.drag;
    if (!drag || drag.phase === "pending") return false;
    if (id === drag.source.id || id === drag.item.id) return true;
    for (const list of drag.lists.values()) {
      for (let i = 0; i < list.items.length; i++) {
        if (list.shifts[i] !== 0 && list.items[i]!.id === id) return true;
      }
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Renderer surface: engine writes and structure
  // --------------------------------------------------------------------------

  /**
   * Deferral gate (drag wins, §6.6): while a drag or its post-drop hold owns
   * a node, engine SetProps to its `translateX`/`translateY` keys are
   * swallowed — latest value stored, applied at release. A translate write
   * landing on the dragged node DURING the hold is the engine's re-render
   * (a pin position): it releases the hold and flows through the flush.
   * Engine writes to the pose-overridden keys of a node carrying a runtime
   * label are deferred until the label clears. Returns `true` when deferred.
   */
  deferEngineProp(node: VirtualNode, name: string, value: unknown): boolean {
    return this.defer(node, name, { remove: false, value });
  }

  /** `removeProp` twin of {@link deferEngineProp}. */
  deferEngineRemoveProp(node: VirtualNode, name: string): boolean {
    return this.defer(node, name, { remove: true, value: undefined });
  }

  private defer(node: VirtualNode, name: string, write: { remove: boolean; value: unknown }): boolean {
    const base = baseOf(name);
    const drag = this.drag;
    if (drag && drag.phase !== "pending" && (TRANSLATE_BASES.has(base) || name === "__dnd.pinX" || name === "__dnd.pinY")) {
      if (node === drag.source || node === drag.item) {
        let bucket = drag.deferred.get(node.id);
        if (!bucket) drag.deferred.set(node.id, (bucket = new Map()));
        bucket.set(name, write);
        if (drag.phase === "holding") {
          // The engine's re-render landed on the dragged node: release now
          // and let this very write apply through the flush.
          this.release();
        }
        return true;
      }
    }
    const pose = this.poses.get(node.id);
    if (pose) {
      const table = parsePoses(node.props[ANIM_STATE_POSES_PROP]);
      const entry = table?.[pose.label];
      const overridden = entry
        ? Object.keys(entry).some((key) => baseOf(key) === base)
        : [...pose.saved.keys()].some((key) => baseOf(key) === base);
      if (overridden) {
        pose.deferred.set(name, write);
        return true;
      }
    }
    return false;
  }

  /**
   * A `__dnd.*` channel prop on `node` changed (set or removed). A source
   * going away or disabled mid-drag cancels cleanly with NO dispatch.
   */
  noteChannelChange(node: VirtualNode): void {
    // A lit files zone that stopped being one (or was disabled) goes dark;
    // the next dragover re-resolves outward.
    if (this.filesOver === node) {
      const zone = dndZoneOf(node);
      if (!zone?.files || !dndZoneEnabled(node)) this.setFilesOver(null);
    }
    const drag = this.drag;
    if (!drag || drag.phase === "holding") return;
    if (drag.source === node && (dndSourceOf(node) === null || !dndSourceEnabled(node))) {
      this.cancelDrag(false);
    }
  }

  /** `__anim.statePoses` changed on `node`: an active overlay is cleared (its base restored). */
  notePosesChanged(node: VirtualNode): void {
    if (this.poses.has(node.id)) this.clearPose(node);
  }

  /**
   * The engine moved `id` out from under `parent`: the re-render for a
   * dropped reorder landed — release the held offsets.
   */
  noteMove(parent: VirtualNode | null, id: string): void {
    this.noteStructural(parent, id);
  }

  /**
   * A structural change (insert/move/remove) touched `parent`. During a
   * hold under the origin or destination list this is the re-render
   * landing. During a live drag it marks every cached sortable whose
   * container is (or contains) `parent` — the ORIGIN included — for a
   * rebuild from the live children once the next layout has run
   * ({@link noteLayout}): spring-loaded folders insert rows mid-drag, and
   * the new rows become live targets while the reserved write's `from`
   * tracks the dragged item's live index (plan §6, DOM parity).
   *
   * The ancestor walk matters because the engine inserts top-down: a
   * draggable Text inserted under an already-inserted Row reaches this
   * with the ROW as `parent`, and it is that insert which makes the row a
   * sortable item at all.
   */
  noteStructural(parent: VirtualNode | null, id: string): void {
    const drag = this.drag;
    if (!drag || drag.phase === "pending") return;
    if (drag.phase === "holding") {
      if (id === drag.item.id || id === drag.source.id) {
        this.release();
        return;
      }
      const targetNode = this.targetNode(drag.target);
      if (parent !== null && (parent === drag.origin || parent === targetNode)) {
        this.release();
      }
      return;
    }
    if (parent === null) return;
    for (const list of drag.lists.values()) {
      if (isWithin(parent, list.container)) list.stale = true;
    }
  }

  /**
   * Layout ran (the renderer calls this right after its layout pass).
   * Cached lists an engine insert/remove touched mid-drag are rebuilt from
   * the now laid-out children and the target re-resolved at the last
   * pointer position (or the keyboard preview replayed).
   */
  noteLayout(): void {
    const drag = this.drag;
    if (!drag || drag.phase !== "dragging") return;
    let rebuilt = false;
    for (const list of drag.lists.values()) {
      if (!list.stale) continue;
      this.rebuildList(list);
      rebuilt = true;
    }
    if (!rebuilt) return;
    if (drag.mode === "pointer") {
      if (drag.lastPoint) this.resolveTarget(drag.lastPoint, this.host.hitTest?.(drag.lastPoint) ?? null);
    } else {
      this.keyboardPreview(drag, false);
    }
  }

  /**
   * A subtree is leaving the tree (Remove, exit-flagged Remove, Router
   * Detach): if the drag's source or item is at-or-under `root`, cancel the
   * interaction cleanly and dispatch NOTHING (§6.6). An `over` overlay on a
   * node inside the subtree is cleared.
   */
  cancelSubtree(root: VirtualNode): void {
    const drag = this.drag;
    if (!drag) return;
    if (isWithin(drag.source, root) || isWithin(drag.item, root)) {
      this.cancelDrag(false);
      return;
    }
    // The hovered zone (not the source) is leaving: drop its overlay and
    // the target; the next move re-resolves against what remains.
    if (drag.overNode && isWithin(drag.overNode, root)) {
      this.clearPose(drag.overNode);
      this.clearDwell(drag);
      drag.overNode = null;
      drag.target = null;
    }
  }

  /** A removed node: cancel any drag it participates in, drop all state for it. */
  forget(node: VirtualNode): void {
    this.cancelSubtree(node);
    // The node is gone: nothing to restore into, just drop bookkeeping.
    this.poses.delete(node.id);
    if (this.filesOver && isWithin(this.filesOver, node)) this.filesOver = null;
    for (const entered of this.fileEntered) {
      if (isWithin(entered, node)) this.fileEntered.delete(entered);
    }
  }

  /** Cancel any in-flight drag and drop all state (renderer `clear()`). */
  reset(): void {
    if (this.drag) this.cancelDrag(false);
    this.poses.clear();
    this.filesOver = null;
    this.fileEntered.clear();
  }

  // --------------------------------------------------------------------------
  // OS file drags onto `.dropZone(files: true)` (docs/dnd.md, "Files from the OS")
  // --------------------------------------------------------------------------

  /**
   * An OS file drag entered / moved over the canvas at `hit` (the event
   * manager's hit test). Lights the innermost enabled files zone whose
   * `accept:` matches `types` with the runtime `over` pose, and fires
   * `.onFileDragEnter` once per entry on every files zone under the pointer
   * that carries it and can light. Returns `true` when the default must be
   * swallowed (an enabled files zone is under the pointer) — the caller then
   * shows `dropEffect: "none"` so a release never opens the file.
   */
  fileDragOver(hit: VirtualNode | null, types: string[] | null, items: number): boolean {
    let zone: VirtualNode | null = null;
    let swallow = false;
    const chain = new Set<VirtualNode>();
    for (let cur = hit; cur; cur = cur.parent) {
      chain.add(cur);
      const spec = cur.props[DND_ZONE_PROP] !== undefined ? dndZoneOf(cur) : null;
      if (spec?.files && dndZoneEnabled(cur)) {
        swallow = true;
        if (zone === null && fileDragMatchesAccept(spec.accept, types)) zone = cur;
      }
    }
    this.setFilesOver(zone);
    for (const entered of [...this.fileEntered]) {
      if (!chain.has(entered)) this.fileEntered.delete(entered);
    }
    for (const node of chain) {
      const binding = this.fileDragEnterBinding(node);
      if (!binding) continue;
      swallow = true;
      if (this.fileEntered.has(node)) continue;
      this.fileEntered.add(node);
      const spec = node.props[DND_ZONE_PROP] !== undefined ? dndZoneOf(node) : null;
      if (spec?.files && !(dndZoneEnabled(node) && fileDragMatchesAccept(spec.accept, types))) continue;
      const payload =
        Object.keys(binding.customPayload).length > 0
          ? { ...binding.customPayload }
          : { type: "filedragenter", timestamp: Date.now(), items };
      this.dispatch(binding.actionName, payload, node);
    }
    return swallow;
  }

  /** The OS file drag left the canvas, was cancelled or ended: the pose clears, entries reset. */
  fileDragEnd(): void {
    this.setFilesOver(null);
    this.fileEntered.clear();
  }

  /**
   * Files released on the canvas at `hit`: nothing is delivered. Returns
   * `true` when the drop must be swallowed (it landed on an enabled files
   * zone or an `.onFileDragEnter` node) so the browser never navigates.
   */
  fileDrop(hit: VirtualNode | null): boolean {
    let swallow = false;
    for (let cur = hit; cur; cur = cur.parent) {
      const spec = cur.props[DND_ZONE_PROP] !== undefined ? dndZoneOf(cur) : null;
      if ((spec?.files && dndZoneEnabled(cur)) || this.fileDragEnterBinding(cur)) {
        swallow = true;
        break;
      }
    }
    this.fileDragEnd();
    return swallow;
  }

  /** `.onFileDragEnter` on a `.dropZone(files: true)` node; inert anywhere else (as on every renderer). */
  private fileDragEnterBinding(node: VirtualNode): { actionName: string; customPayload: Record<string, unknown> } | null {
    if (node.props[DND_ZONE_PROP] === undefined || !dndZoneOf(node)?.files) return null;
    const spec = node.props.onFileDragEnter ?? node.props.onfiledragenter;
    if (spec == null) return null;
    const resolved = resolveEventAction(toPlain(spec));
    return resolved ? { actionName: resolved.actionName, customPayload: resolved.payload } : null;
  }

  private setFilesOver(next: VirtualNode | null): void {
    const prev = this.filesOver;
    if (prev === next) return;
    this.filesOver = next;
    // An in-app drag owns the `over` label while it is live (the two never
    // overlap in practice; the in-app one wins if they do).
    const inAppLive = this.drag !== null && this.drag.phase !== "pending";
    if (inAppLive) return;
    if (prev && this.poses.get(prev.id)?.label === DND_LABEL_OVER) this.clearPose(prev);
    if (next) this.applyPose(next, DND_LABEL_OVER);
    this.host.scheduleRedraw();
  }

  destroy(): void {
    this.reset();
  }

  // --------------------------------------------------------------------------
  // Pose overlay (§2.1 runtime labels)
  // --------------------------------------------------------------------------

  private applyPose(node: VirtualNode, label: string): void {
    const current = this.poses.get(node.id);
    if (current?.label === label) return;
    if (current) this.clearPose(node);
    const table = parsePoses(node.props[ANIM_STATE_POSES_PROP]);
    const pose = table?.[label];
    if (!pose) return;
    const state: PoseState = { label, saved: new Map(), deferred: new Map() };
    for (const key of Object.keys(pose)) {
      const present = Object.prototype.hasOwnProperty.call(node.props, key);
      state.saved.set(key, { present, value: present ? node.props[key] : undefined });
    }
    this.poses.set(node.id, state);
    for (const [key, value] of Object.entries(pose)) {
      this.host.applyProp(node, key, value);
    }
  }

  private clearPose(node: VirtualNode): void {
    const state = this.poses.get(node.id);
    if (!state) return;
    this.poses.delete(node.id);
    for (const [key, base] of state.saved) {
      if (base.present) this.host.applyProp(node, key, base.value);
      else this.host.removeProp(node, key);
    }
    for (const [name, write] of state.deferred) {
      if (write.remove) this.host.removeProp(node, name);
      else this.host.applyProp(node, name, write.value);
    }
  }

  // --------------------------------------------------------------------------
  // Pointer path (driven by CanvasEventManager)
  // --------------------------------------------------------------------------

  /** Nearest enabled source at-or-above `hit` (innermost wins). */
  private sourceAt(hit: VirtualNode | null): VirtualNode | null {
    for (let cur = hit; cur; cur = cur.parent) {
      if (cur.props[DND_SOURCE_PROP] === undefined) continue;
      const spec = dndSourceOf(cur);
      if (spec === null) {
        log.warn(`dnd: malformed __dnd.source on node ${cur.id}; not draggable`);
        continue;
      }
      if (!dndSourceEnabled(cur)) return null;
      return cur;
    }
    return null;
  }

  /**
   * Press. Opens a pending drag when the hit lands on a source. Returns
   * `true` when the gesture claimed the pointer immediately
   * (`activation: immediate`) — the caller then skips its own press handling.
   */
  pointerDown(hit: VirtualNode | null, point: Point, button = 0): boolean {
    if (this.drag || button !== 0) return false;
    const source = this.sourceAt(hit);
    if (!source || !source.layout) return false;
    const spec = dndSourceOf(source)!;
    const origin = this.findOrigin(source);
    let activation: ActiveDrag["activation"];
    switch (spec.activation) {
      case "immediate":
        activation = "immediate";
        break;
      case "press":
        activation = "press";
        break;
      default:
        // `auto` and `slop`: mouse semantics (the canvas sees mouse events).
        activation = "slop";
    }
    const drag = this.openDrag(source, origin, "pointer");
    drag.startX = point.x;
    drag.startY = point.y;
    drag.lastPoint = point;
    drag.activation = activation;
    if (activation === "immediate") {
      this.claim();
      return true;
    }
    if (activation === "press") {
      drag.pressTimer = setTimeout(() => {
        drag.pressTimer = null;
        if (this.drag === drag && drag.phase === "pending") {
          this.claim();
          this.host.scheduleRedraw();
        }
      }, this.pressDelayMs);
    }
    return false;
  }

  /**
   * Move. `hit` is the caller's hit-test at `point` (the ghost excluded).
   * Returns `true` when the move was consumed by a drag (pending claim or a
   * live drag) so hover handling stands down. `buttons === 0` on a live
   * drag means the release was missed: it drops where the pointer is.
   */
  pointerMove(point: Point, hit: VirtualNode | null, buttons?: number): boolean {
    const drag = this.drag;
    if (!drag || drag.mode !== "pointer") return false;
    if (drag.phase === "holding") return false;
    drag.lastPoint = point;
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    if (drag.phase === "pending") {
      const travel = Math.max(Math.abs(dx), Math.abs(dy));
      if (drag.activation === "slop") {
        if (travel < this.slopPx) return false;
      } else if (drag.activation === "press") {
        // Travel before the press fires is a pan: abandon silently.
        if (travel >= this.slopPx) this.abandon();
        return false;
      } else {
        return false; // immediate already claimed
      }
      this.claim();
      if (this.drag !== drag) return false;
    }
    if (drag.phase !== "dragging") return false;
    if (buttons === 0) {
      this.pointerUp(point, hit);
      return true;
    }
    this.updateGhost(dx, dy);
    this.resolveTarget(point, hit);
    this.host.scheduleRedraw();
    return true;
  }

  /**
   * Release. A pending (unclaimed) drag is abandoned: a tap is a total
   * no-op and the caller's click path runs. A live drag drops (`true`).
   */
  pointerUp(point: Point, hit: VirtualNode | null): boolean {
    const drag = this.drag;
    if (!drag || drag.mode !== "pointer") return false;
    if (drag.phase === "pending") {
      this.abandon();
      return false;
    }
    if (drag.phase !== "dragging") return false;
    drag.lastPoint = point;
    this.updateGhost(point.x - drag.startX, point.y - drag.startY);
    this.resolveTarget(point, hit);
    this.drop();
    return true;
  }

  /** Esc during a pointer drag. Returns `true` when a drag was cancelled. */
  cancelPointer(): boolean {
    const drag = this.drag;
    if (!drag || drag.mode !== "pointer" || drag.phase !== "dragging") return false;
    this.cancelDrag(true);
    return true;
  }

  /** A pending drag that never claimed: keep silent. */
  private abandon(): void {
    const drag = this.drag;
    if (!drag) return;
    this.clearPressTimer(drag);
    this.drag = null;
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

  private openDrag(source: VirtualNode, origin: VirtualNode | null, mode: ActiveDrag["mode"]): ActiveDrag {
    const item =
      origin && dndSortOf(origin) !== null ? this.itemOf(origin, source) ?? source : source;
    const originIndex = origin ? this.indexOf(origin, item) : null;
    const from: DndLocation = origin
      ? { zone: this.containerLabel(origin), index: originIndex }
      : { zone: this.looseZoneLabel(source), index: null };
    const drag: ActiveDrag = {
      mode,
      phase: "pending",
      source,
      item,
      origin,
      originIndex,
      from,
      startX: 0,
      startY: 0,
      activation: "slop",
      pressTimer: null,
      dx: 0,
      dy: 0,
      itemRect: visualRect(item),
      anchor: { x: 0, y: 0 },
      lastPoint: null,
      target: null,
      overNode: null,
      dwellTimer: null,
      lists: new Map(),
      holdTimer: null,
      deferred: new Map(),
      machine: null,
      zoneNodes: [],
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
    drag.itemRect = visualRect(drag.item);
    drag.item.dndGhost = true;
    drag.item.dndOffset = { x: 0, y: 0 };
    this.applyPose(drag.source, DND_LABEL_LIFTED);
    if (drag.origin && dndSortOf(drag.origin) !== null) this.listFor(drag.origin); // cache before any shift
    this.host.setMirrorAttribute?.(drag.source.id, "aria-grabbed", "true");
    this.dispatchEvent([drag.source, drag.origin], "onDragStart", this.payload(drag, drag.from));
  }

  private updateGhost(dx: number, dy: number): void {
    const drag = this.drag;
    if (!drag) return;
    drag.dx = dx;
    drag.dy = dy;
    // The ghost paints at the item's LIVE layout box plus this offset; the
    // anchor cancels any flow shift the box picked up mid-drag so the ghost
    // stays at `itemRect + (dx, dy)` (under the pointer).
    drag.item.dndOffset = { x: dx - drag.anchor.x, y: dy - drag.anchor.y };
  }

  // --------------------------------------------------------------------------
  // Geometry: origins, items, lists
  // --------------------------------------------------------------------------

  /** Nearest enclosing sortable / pinboard container of a source. */
  private findOrigin(source: VirtualNode): VirtualNode | null {
    for (let cur = source.parent; cur; cur = cur.parent) {
      if (dndSortOf(cur) !== null || dndPinOf(cur) !== null) return cur;
    }
    return null;
  }

  /** The container's direct child that contains (or is) `node`. */
  private itemOf(container: VirtualNode, node: VirtualNode): VirtualNode | null {
    let cur: VirtualNode | null = node;
    while (cur) {
      if (cur.parent === container) return cur;
      cur = cur.parent;
    }
    return null;
  }

  /** Direct children of a container that carry (or contain) a source, in tree order. */
  private draggableItems(container: VirtualNode): VirtualNode[] {
    return container.children.filter((child) => containsSource(child));
  }

  private indexOf(container: VirtualNode, item: VirtualNode): number | null {
    const idx = this.draggableItems(container).indexOf(item);
    return idx === -1 ? null : idx;
  }

  private listFor(container: VirtualNode): ListPreview {
    const drag = this.drag!;
    let list = drag.lists.get(container.id);
    if (list) return list;
    const axis = dndSortOf(container)?.axis ?? "y";
    const items = this.draggableItems(container).filter((item) => item.layout);
    // Every slot is the item's unshifted live box (the dragged item's own
    // offset is excluded too — at claim this IS its lift rect).
    const rects = items.map((item) => visualRect(item));
    list = { container, axis, items, rects, gap: gapOf(rects, axis), shifts: items.map(() => 0), stale: false };
    drag.lists.set(container.id, list);
    return list;
  }

  /**
   * Re-derive a cached list from the container's live (laid-out) children
   * after an engine insert/remove mid-drag. `visualRect` excludes an
   * item's own preview shift, so every surviving sibling's slot is its
   * unshifted box — the dragged item's slot included, so the gap estimate
   * and the keyboard slide see the list as it is now; shifts follow their
   * items to the new indices and items that left the list drop their
   * preview offset. For the origin list the dragged item's live position
   * becomes the reserved write's `from`, and the ghost anchor absorbs the
   * item's own flow shift so it does not jump (`itemRect` stays the lift
   * rect the ghost and the pin math are expressed against).
   */
  private rebuildList(list: ListPreview): void {
    const drag = this.drag!;
    const items = this.draggableItems(list.container).filter((item) => item.layout);
    const rects: Rect[] = [];
    const shifts: number[] = [];
    for (const item of items) {
      const prev = list.items.indexOf(item);
      shifts.push(prev === -1 ? 0 : list.shifts[prev]!);
      rects.push(visualRect(item));
    }
    for (const item of list.items) {
      if (item !== drag.item && !items.includes(item)) delete item.dndOffset;
    }
    list.items = items;
    list.rects = rects;
    list.shifts = shifts;
    list.gap = gapOf(rects, list.axis);
    list.stale = false;
    if (list.container === drag.origin) {
      const live = items.indexOf(drag.item);
      if (live !== -1) {
        drag.originIndex = live;
        const slot = visualRect(drag.item);
        drag.anchor = { x: slot.x - drag.itemRect.x, y: slot.y - drag.itemRect.y };
        this.updateGhost(drag.dx, drag.dy);
      }
    }
  }

  /**
   * The reserved write's `from` is the dragged item's LIVE index in the
   * origin sortable (tree order — no geometry needed), so a drop that lands
   * between a mid-drag insert/remove and the next layout still moves the
   * right element.
   */
  private refreshOriginIndex(drag: ActiveDrag): void {
    if (!drag.origin || dndSortOf(drag.origin) === null) return;
    const live = this.indexOf(drag.origin, drag.item);
    if (live !== null) drag.originIndex = live;
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
    list.shifts[i] = shift;
    const item = list.items[i]!;
    if (shift === 0) {
      delete item.dndOffset;
    } else {
      item.dndOffset = list.axis === "x" ? { x: shift, y: 0 } : { x: 0, y: shift };
    }
  }

  private restoreList(list: ListPreview): void {
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i]!;
      if (item !== this.drag?.item) delete item.dndOffset;
      list.shifts[i] = 0;
    }
  }

  // --------------------------------------------------------------------------
  // Zone resolution (§6.4)
  // --------------------------------------------------------------------------

  private containerLabel(node: VirtualNode): string {
    return dndSortOf(node)?.group ?? dndPinOf(node)?.group ?? idPropOf(node) ?? node.id;
  }

  private zoneLabel(node: VirtualNode): string {
    return parseDndString(toPlain(node.props[DND_ZONE_ID_PROP])) ?? idPropOf(node) ?? node.id;
  }

  /**
   * `to.zone` for a plain "into" target: a foreign compatible sortable/
   * pinboard hit as "into" follows the §4.2 sortable rule (group → resolved
   * `id` → node id, §6.11); a `.dropZone` uses its `__dnd.zoneId` label.
   */
  private intoLabel(node: VirtualNode): string {
    return dndSortOf(node) !== null || dndPinOf(node) !== null ? this.containerLabel(node) : this.zoneLabel(node);
  }

  /** `from.zone` for a source outside any sortable/pinboard: the nearest zone, else the parent. */
  private looseZoneLabel(source: VirtualNode): string {
    for (let cur = source.parent; cur; cur = cur.parent) {
      if (dndZoneOf(cur) !== null) return this.zoneLabel(cur);
    }
    return source.parent?.id ?? source.id;
  }

  /**
   * A source's effective group: its own `group`, else the group of its
   * enclosing sortable/pinboard (design §4.2 — a bare `.draggable()` inside
   * `.sortable(group: "board")` inherits `"board"`).
   */
  private effectiveGroup(source: VirtualNode): string | null {
    const own = dndSourceOf(source)?.group ?? null;
    if (own !== null) return own;
    const origin = this.findOrigin(source);
    if (!origin) return null;
    return dndSortOf(origin)?.group ?? dndPinOf(origin)?.group ?? null;
  }

  private accepts(zone: VirtualNode, source: VirtualNode): boolean {
    const sourceGroup = this.effectiveGroup(source);
    const isDescendant = isWithin(source, zone);
    const sort = dndSortOf(zone);
    const pin = dndPinOf(zone);
    if (sort || pin) {
      // A sortable/pinboard ALWAYS accepts its own direct draggable children
      // regardless of the child's own group (§6.11); a foreign container only
      // when both groups are non-null and equal.
      if (isDescendant) return true;
      const group = sort?.group ?? pin?.group ?? null;
      return group !== null && sourceGroup === group;
    }
    const spec = dndZoneOf(zone);
    if (!spec || !dndZoneEnabled(zone)) return false;
    return spec.group !== null ? sourceGroup === spec.group : sourceGroup === null || isDescendant;
  }

  /** Every zone a drag from `source` may target, in tree (paint) order. */
  private candidateZones(source: VirtualNode): VirtualNode[] {
    const drag = this.drag!;
    let root: VirtualNode = source;
    while (root.parent) root = root.parent;
    const out: VirtualNode[] = [];
    const walk = (node: VirtualNode): void => {
      if (node === drag.item) return; // nothing under the lifted item
      if (node !== source && isZoneNode(node) && this.accepts(node, source)) out.push(node);
      for (const child of node.children) walk(child);
    };
    walk(root);
    return out;
  }

  /**
   * Innermost enabled, group-compatible zone under the pointer: walk up
   * from the hit node. The lifted item is excluded from the hit test, so
   * nothing under it can win; the source subtree is skipped explicitly for
   * the keyboard/first-frame paths.
   */
  private resolveTarget(point: Point, hit: VirtualNode | null): void {
    const drag = this.drag!;
    let target: DropTarget | null = null;
    for (let cur = hit; cur; cur = cur.parent) {
      if (cur === drag.item || isWithin(cur, drag.item)) continue;
      if (!isZoneNode(cur) || !this.accepts(cur, drag.source)) continue;
      if (dndSortOf(cur) !== null) {
        const list = this.listFor(cur);
        target = {
          kind: "sort",
          container: cur,
          index: this.insertionIndex(list, list.axis === "x" ? point.x : point.y),
        };
      } else if (dndPinOf(cur) !== null) {
        target = cur === drag.origin ? { kind: "pin", container: cur } : { kind: "zone", node: cur };
      } else {
        target = this.resolveBandTarget(cur, point);
      }
      break;
    }
    this.setTarget(target);
  }

  /** A dropZone on a sortable item: band rule; elsewhere a plain "into". */
  private resolveBandTarget(zone: VirtualNode, point: Point): DropTarget {
    const drag = this.drag!;
    let sortable: VirtualNode | null = null;
    for (let cur = zone.parent; cur; cur = cur.parent) {
      if (dndSortOf(cur) !== null && this.accepts(cur, drag.source)) {
        sortable = cur;
        break;
      }
    }
    if (!sortable) return { kind: "zone", node: zone };
    const list = this.listFor(sortable);
    const item = this.itemOf(sortable, zone);
    const i = item ? list.items.indexOf(item) : -1;
    if (i === -1) return { kind: "zone", node: zone };
    const rect = list.rects[i]!;
    const pos = list.axis === "x" ? point.x : point.y;
    const band = resolveBand(
      pos,
      axisStart(rect, list.axis),
      axisLength(rect, list.axis),
      dndZoneOf(zone)!.band
    );
    if (band === "into") return { kind: "zone", node: zone };
    let others = 0;
    for (let k = 0; k < i; k++) if (list.items[k] !== drag.item) others += 1;
    return { kind: "sort", container: sortable, index: band === "before" ? others : others + 1 };
  }

  private targetNode(target: DropTarget | null): VirtualNode | null {
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
        return { zone: this.intoLabel(target.node), index: null };
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
      } else if (list.container === drag.origin && dndSortOf(drag.origin) !== null) {
        // Leaving the origin list closes its gap only when hovering a
        // foreign target; hovering nothing keeps the last preview.
        if (target !== null) this.previewList(list, drag.originIndex ?? 0);
      } else {
        this.previewList(list, Number.POSITIVE_INFINITY);
      }
    }
    if (nextNode !== prevNode) {
      if (prevNode && this.poses.get(prevNode.id)?.label === DND_LABEL_OVER) this.clearPose(prevNode);
      this.clearDwell(drag);
      if (nextNode) {
        this.applyPose(nextNode, DND_LABEL_OVER);
        this.armDwell(drag, nextNode);
      }
    }
    drag.target = target;
    drag.overNode = nextNode;
  }

  private armDwell(drag: ActiveDrag, zone: VirtualNode): void {
    const binding = this.eventBinding(zone, "onDragOver");
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
  // Events (§4.2) and reserved actions (§4.1)
  // --------------------------------------------------------------------------

  private payload(drag: ActiveDrag, to: DndLocation): DndEventPayload {
    const out: DndEventPayload = { item: dndKeyOf(drag.source) } as DndEventPayload;
    if (Object.prototype.hasOwnProperty.call(drag.source.props, DND_SOURCE_PAYLOAD_PROP)) {
      out.payload = toPlain(drag.source.props[DND_SOURCE_PAYLOAD_PROP]);
    }
    out.from = { zone: drag.from.zone, index: drag.from.index };
    out.to = { zone: to.zone, index: to.index };
    return out;
  }

  /**
   * A node's `.on<DndEvent>` binding: the generic `onX` prop (string action
   * ref or `{ "0": "@a", ...namedArgs }`). `dwell` is reserved on
   * `onDragOver` and stripped from the custom payload (like `animate:`).
   */
  private eventBinding(
    node: VirtualNode,
    name: DndEventName
  ): { actionName: string; customPayload: Record<string, unknown>; animate?: unknown; dwell: number | null } | null {
    const spec = node.props[name] ?? node.props[name.toLowerCase()];
    if (spec == null) return null;
    const resolved = resolveEventAction(toPlain(spec));
    if (!resolved) return null;
    const customPayload: Record<string, unknown> = { ...resolved.payload };
    let dwell: number | null = null;
    if (name === "onDragOver" && Object.prototype.hasOwnProperty.call(customPayload, DND_DRAG_OVER_DWELL_KEY)) {
      const raw = customPayload[DND_DRAG_OVER_DWELL_KEY];
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (Number.isFinite(n) && n >= 0) dwell = n;
      else log.warn(`dnd: onDragOver dwell must be a non-negative number, got:`, raw);
      delete customPayload[DND_DRAG_OVER_DWELL_KEY];
    }
    return resolved.animate !== undefined
      ? { actionName: resolved.actionName, customPayload, animate: resolved.animate, dwell }
      : { actionName: resolved.actionName, customPayload, dwell };
  }

  /** Dispatch `name` to the first candidate node carrying that binding. */
  private dispatchEvent(
    candidates: ReadonlyArray<VirtualNode | null>,
    name: DndEventName,
    payload: DndEventPayload
  ): void {
    for (const node of candidates) {
      if (!node) continue;
      const binding = this.eventBinding(node, name);
      if (!binding) continue;
      const merged: Record<string, unknown> = { ...binding.customPayload, ...payload };
      if (binding.animate !== undefined) merged[ACTION_ANIMATE_KEY] = binding.animate;
      this.dispatch(binding.actionName, merged, node, name === "onSort" ? this.drag?.origin ?? undefined : undefined);
      return;
    }
  }

  private dispatch(name: string, payload: Record<string, unknown>, node?: VirtualNode, from?: VirtualNode): void {
    try {
      const owner = node ?? (this.drag?.target?.kind === "sort" ? this.drag.target.container : (this.drag?.origin && bindOf(this.drag.origin) ? this.drag.origin : this.drag?.source));
      dispatchUIAction(this.host, owner?.id, name, payload, (from ?? this.drag?.origin)?.id);
    } catch (err) {
      log.error(`dnd: error dispatching action "${name}":`, err);
    }
  }

  // --------------------------------------------------------------------------
  // Drop / cancel / release
  // --------------------------------------------------------------------------

  /** Pointer released over the current target (none ⇒ cancel with `.onDragEnd {dropped:false}`). */
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
   * {dropped: true}`; then hold the local offsets until the engine's
   * re-render lands (or the timeout).
   */
  private commit(target: DropTarget): void {
    const drag = this.drag!;
    this.clearDwell(drag);
    this.refreshOriginIndex(drag);
    const to = this.targetLocation(target);
    const base = this.payload(drag, to);
    // Enter the hold BEFORE dispatching: a synchronous engine may re-render
    // inside the dispatch, and its Move/SetProp must find the hold to release.
    drag.phase = "holding";
    drag.target = target;
    let wroteOrChanged = true;
    switch (target.kind) {
      case "sort": {
        const dest = target.container;
        const sameList = dest === drag.origin;
        if (sameList && drag.originIndex === target.index) {
          wroteOrChanged = false;
          break;
        }
        const fromPath = drag.origin ? bindOf(drag.origin) : null;
        const toPath = bindOf(dest);
        if (sameList && toPath !== null && drag.originIndex !== null) {
          this.dispatch(DND_REORDER_ACTION, { path: toPath, from: drag.originIndex, to: target.index });
        } else if (!sameList && fromPath !== null && toPath !== null && drag.originIndex !== null) {
          this.dispatch(DND_REORDER_ACTION, {
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
        const spec = dndPinOf(board)!;
        const box = contentBox(board);
        const rawX = drag.itemRect.x + drag.dx - box.x;
        const rawY = drag.itemRect.y + drag.dy - box.y;
        let px = snapToGrid(rawX, spec.grid);
        let py = snapToGrid(rawY, spec.grid);
        if (spec.bounds === "clamp") {
          px = Math.min(Math.max(0, px), Math.max(0, box.width - drag.itemRect.width));
          py = Math.min(Math.max(0, py), Math.max(0, box.height - drag.itemRect.height));
        }
        // Snap the ghost to the resolved position so the hold shows it.
        this.updateGhost(px + box.x - drag.itemRect.x, py + box.y - drag.itemRect.y);
        const x = round3(spec.units === "fraction" ? (box.width > 0 ? px / box.width : 0) : px);
        const y = round3(spec.units === "fraction" ? (box.height > 0 ? py / box.height : 0) : py);
        let path: string | null = null;
        const bind = bindOf(board);
        if (bind !== null) {
          if (drag.originIndex !== null) path = userPinPath(bind, drag.originIndex);
        } else if (spec.group !== null) {
          path = reservedPinPath(spec.group, dndKeyOf(drag.source));
        }
        if (path !== null) {
          this.dispatch(DND_PIN_ACTION, { path, x, y, xKey: spec.xKey, yKey: spec.yKey });
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
    this.host.scheduleRedraw();
  }

  /**
   * Abandon a claimed drag: restore everything. With `dispatchEnd` (user
   * cancel: Esc, drop outside every zone) only `.onDragEnd {dropped: false}`
   * fires; without it (Remove/Detach) nothing.
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
    this.release();
    if (end) this.dispatchEvent([drag.source, drag.origin], "onDragEnd", end);
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
    for (const list of drag.lists.values()) this.restoreList(list);
    if (drag.overNode && this.poses.get(drag.overNode.id)?.label === DND_LABEL_OVER) {
      this.clearPose(drag.overNode);
    }
    delete drag.item.dndOffset;
    delete drag.item.dndGhost;
    if (this.poses.get(drag.source.id)?.label === DND_LABEL_LIFTED) this.clearPose(drag.source);
    this.host.setMirrorAttribute?.(drag.source.id, "aria-grabbed", "false");
    // Deferred translate writes flow through the renderer's path now that
    // the runtime is idle for these nodes.
    for (const [id, bucket] of drag.deferred) {
      const node = id === drag.source.id ? drag.source : drag.item;
      for (const [name, write] of bucket) {
        if (write.remove) this.host.removeProp(node, name);
        else this.host.applyProp(node, name, write.value);
      }
    }
    drag.deferred.clear();
    this.host.scheduleRedraw();
  }

  // --------------------------------------------------------------------------
  // Keyboard (§6.8) — driven from the focus manager's mirror keydown path
  // --------------------------------------------------------------------------

  /**
   * Keydown while `node` (the focused node, or a node inside a source) has
   * focus. Returns `true` when consumed: Space lifts an idle source; while
   * lifted, Space/Enter drops, Esc cancels, Arrow keys move within the
   * sortable, Tab / Shift+Tab cycle zones.
   */
  keyDown(node: VirtualNode, event: { key?: string; shiftKey?: boolean; preventDefault?: () => void }): boolean {
    const key = event.key;
    const drag = this.drag;
    if (!drag) {
      if (key !== " " && key !== "Spacebar") return false;
      const source = this.sourceAt(node);
      if (!source) return false;
      event.preventDefault?.();
      this.keyboardLift(source);
      return true;
    }
    if (drag.mode !== "keyboard" || drag.phase !== "dragging") return false;
    if (!isWithin(node, drag.source) && node !== drag.source) return false;
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
          // Dropped where it started: nothing changed — release and report
          // the drop, no write, no onSort.
          const end: DndEventPayload = { ...this.payload(drag, drag.from), dropped: true };
          this.release();
          this.dispatchEvent([drag.source, drag.origin], "onDragEnd", end);
          return true;
        }
        const target: DropTarget =
          dndSortOf(zoneNode) !== null
            ? { kind: "sort", container: zoneNode, index: current.index ?? 0 }
            : { kind: "zone", node: zoneNode };
        drag.target = target;
        this.commit(target);
        return true;
      }
      case "Escape":
        event.preventDefault?.();
        machine.cancel();
        this.cancelDrag(true);
        return true;
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
        return false;
    }
    this.keyboardPreview(drag);
    return true;
  }

  /** Focus left the lifted source during a keyboard drag: cancel (`.onDragEnd {dropped:false}`). */
  noteFocusChange(next: VirtualNode | null): void {
    const drag = this.drag;
    if (!drag || drag.mode !== "keyboard" || drag.phase !== "dragging") return;
    if (next && (next === drag.source || isWithin(next, drag.source))) return;
    this.cancelDrag(true);
  }

  /** Screen-reader description of the keyboard drag position, or null when idle. */
  describeKeyboard(): string | null {
    return this.drag?.machine?.describe() ?? null;
  }

  private keyboardLift(source: VirtualNode): void {
    if (!source.layout) return;
    const origin = this.findOrigin(source);
    if (origin && dndPinOf(origin) !== null) {
      log.warn(`dnd: keyboard drag is not supported on pinboard items (node ${source.id})`);
      return;
    }
    const drag = this.openDrag(source, origin, "keyboard");
    const zones: KeyboardDragZone[] = [];
    const zoneNodes: VirtualNode[] = [];
    let originZone = 0;
    const originIsSort = origin !== null && dndSortOf(origin) !== null;
    // Machine zones are identified by the zone NODE id (unique — two
    // sortables sharing a group are distinct zones, §6.11); the §4.2 label is
    // only produced when the payload / reserved paths are built
    // (`targetLocation`), so the machine's `zone` maps back to exactly one
    // node in `zoneNodes`.
    if (origin && originIsSort) {
      zones.push({ id: origin.id, count: this.draggableItems(origin).length });
      zoneNodes.push(origin);
    }
    for (const zone of this.candidateZones(source)) {
      if (zone === origin || dndPinOf(zone) !== null) continue;
      if (dndSortOf(zone) !== null) {
        zones.push({ id: zone.id, count: this.draggableItems(zone).length });
      } else {
        zones.push({ id: zone.id, count: null });
      }
      zoneNodes.push(zone);
    }
    if (!originIsSort) {
      if (zones.length === 0) {
        this.drag = null;
        return; // nowhere to go
      }
      // A loose draggable: its origin is a pseudo-zone the machine needs.
      zones.unshift({ id: source.id, count: null });
      zoneNodes.unshift(source);
      originZone = 0;
    }
    const machine = new KeyboardDragMachine();
    if (!machine.lift(dndKeyOf(source), zones, drag.originIndex ?? 0, originZone)) {
      this.drag = null;
      return;
    }
    drag.machine = machine;
    drag.zoneNodes = zoneNodes;
    this.claim();
    this.host.scheduleRedraw();
  }

  /** The machine's zone (a node id) back to its node; the source pseudo-zone is "no target". */
  private keyboardZoneNode(drag: ActiveDrag, loc: DndLocation): VirtualNode | null {
    for (const node of drag.zoneNodes) {
      if (node.id === loc.zone) return node === drag.source ? null : node;
    }
    return null;
  }

  /**
   * Mirror the machine's position visually. `redraw: false` when called
   * from inside the renderer's frame ({@link noteLayout}), where the paint
   * that follows already picks the result up.
   */
  private keyboardPreview(drag: ActiveDrag, redraw = true): void {
    const machine = drag.machine!;
    const current = machine.current()!;
    const zoneNode = this.keyboardZoneNode(drag, current);
    let target: DropTarget | null = null;
    if (zoneNode && dndSortOf(zoneNode) !== null) {
      // Register the destination list (the pointer path does so in
      // resolveTarget) so setTarget previews it, not only the origin.
      this.listFor(zoneNode);
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
      // Against the LIFT rect: `updateGhost` paints at `itemRect + offset`
      // whatever flow shift the item's live box picked up mid-drag.
      const lift = drag.itemRect;
      let offset = 0;
      if (to < from) {
        offset = axisStart(list.rects[to]!, list.axis) - axisStart(lift, list.axis);
      } else if (to > from) {
        const a = list.rects[to]!;
        offset =
          axisStart(a, list.axis) + axisLength(a, list.axis) - (axisStart(lift, list.axis) + axisLength(lift, list.axis));
      }
      this.updateGhost(list.axis === "x" ? offset : 0, list.axis === "x" ? 0 : offset);
    } else {
      this.updateGhost(0, 0);
    }
    if (redraw) this.host.scheduleRedraw();
  }
}
