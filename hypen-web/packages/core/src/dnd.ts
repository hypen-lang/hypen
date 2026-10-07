/**
 * Shared drag-and-drop vocabulary for the `__dnd.*` prop channel.
 *
 * The engine lowers `.draggable` / `.dropZone` / `.sortable` / `.pinboard`
 * into reserved `__dnd.*` props (one static JSON object per role, bindable
 * pieces split into their own props) carried on `create` patches and kept
 * live via `setProp`. This module is the renderer-agnostic half of that
 * contract: prop keys, the two reserved outcome actions the SDK applies,
 * event applicator names, spec types, defensive parsers, the band and grid
 * arithmetic every renderer needs, a DOM-free keyboard drag state machine,
 * and the TS mirror of `portable::path_move`. DOM, Canvas, and native
 * renderers all consume these; nothing here touches the DOM.
 *
 * Normative source: `hypen-web/docs/dnd.md` (§2 props, §4
 * actions + event payload, §5 `path_move`). The Rust lowering in
 * `hypen-engine-rs/src/ir/dnd.rs` must emit exactly the shapes parsed here.
 */

// ============================================================================
// CHANNEL KEYS (§2)
// ============================================================================

/**
 * Prefix shared by every DnD channel prop. Renderer routing is a single
 * `name.startsWith(DND_PROP_PREFIX)` check; renderers that don't understand
 * `__dnd.*` ignore the props and render static UI (sanctioned degradation).
 */
export const DND_PROP_PREFIX = "__dnd.";

/** `.draggable(...)` → static `{ group, handle, activation }`. */
export const DND_SOURCE_PROP = "__dnd.source";
/** `.draggable(payload:)` → bindable value; absent if not given. */
export const DND_SOURCE_PAYLOAD_PROP = "__dnd.sourcePayload";
/** `.draggable(enabled:)` → bindable bool; absent ⇒ true. */
export const DND_SOURCE_ENABLED_PROP = "__dnd.sourceEnabled";
/**
 * Static string — the `ForEach` item key, filled by item expansion on any
 * element carrying `__dnd.source`. Absent outside a `ForEach` ⇒ renderers
 * fall back to the node id.
 */
export const DND_KEY_PROP = "__dnd.key";
/** `.dropZone(...)` → static `{ group, band }`. */
export const DND_ZONE_PROP = "__dnd.zone";
/** `.dropZone(id:)` → bindable string; absent ⇒ resolved `id` prop, else node id. */
export const DND_ZONE_ID_PROP = "__dnd.zoneId";
/** `.dropZone(enabled:)` → bindable bool; absent ⇒ true. */
export const DND_ZONE_ENABLED_PROP = "__dnd.zoneEnabled";
/** `.sortable(...)` → static `{ group, axis }`; write target is the node's own `bind` prop. */
export const DND_SORT_PROP = "__dnd.sort";
/** `.pinboard(...)` → static `{ group, xKey, yKey, grid, bounds, units }`. */
export const DND_PIN_PROP = "__dnd.pin";
/**
 * Static string propagated from a reserved-mode `.pinboard` onto every
 * descendant `__dnd.source` element; item expansion uses it to inject the
 * position bindings to `__dnd.<group>.<key>.<xKey>/<yKey>`.
 */
export const DND_PIN_GROUP_PROP = "__dnd.pinGroup";

/** Every reserved prop key, for exhaustive routing / tests. */
export const DND_PROPS: readonly string[] = [
  DND_SOURCE_PROP,
  DND_SOURCE_PAYLOAD_PROP,
  DND_SOURCE_ENABLED_PROP,
  DND_KEY_PROP,
  DND_ZONE_PROP,
  DND_ZONE_ID_PROP,
  DND_ZONE_ENABLED_PROP,
  DND_SORT_PROP,
  DND_PIN_PROP,
  DND_PIN_GROUP_PROP,
  "__dnd.pinX", "__dnd.pinY", "__dnd.pinItem", "__dnd.pinGeneratedX", "__dnd.pinGeneratedY",
];

// ============================================================================
// RESERVED OUTCOME ACTIONS (§4.1)
// ============================================================================

/**
 * `__hypen_reorder { fromPath, from, toPath, to }` — `path` accepted as
 * shorthand for `fromPath == toPath`. Semantics = {@link applyPathMove}.
 * Applied by the SDK through the module's tracked state Proxy.
 *
 * Renderers wrap this outcome with live node identity. The engine resolves
 * the owner and calls its scoped host handler; payload paths stay relative
 * to that module. Cross-module transfers require an application handler.
 */
export const DND_REORDER_ACTION = "__hypen_reorder";
/**
 * `__hypen_pin { path, x, y, xKey, yKey }` — two path sets on
 * `path + "." + xKey` / `path + "." + yKey`, auto-vivifying intermediates.
 */
export const DND_PIN_ACTION = "__hypen_pin";

/** Root key of the reserved pin-position subtree in module state (§3). */
export const DND_RESERVED_STATE_KEY = "__dnd";

// ============================================================================
// EVENT APPLICATORS (§2.2 / §4.2)
// ============================================================================

export type DndEventName =
  | "onDragStart"
  | "onDragOver"
  | "onDrop"
  | "onSort"
  | "onPin"
  | "onDragEnd";

/**
 * The six event applicators. They lower through the generic `onX` prop
 * path (string action ref, or `{ "0": "@actions.x", ...namedArgs }`).
 */
export const DND_EVENT_NAMES: readonly DndEventName[] = [
  "onDragStart",
  "onDragOver",
  "onDrop",
  "onSort",
  "onPin",
  "onDragEnd",
];

/**
 * Reserved named argument on `.onDragOver(@a, dwell:)`: renderers read it
 * and strip it from the dispatched payload (like `animate:` on click).
 */
export const DND_DRAG_OVER_DWELL_KEY = "dwell";
/** Default hover-dwell before `.onDragOver` fires, in ms. */
export const DND_DEFAULT_DWELL_MS = 500;

// ============================================================================
// RUNTIME STATE LABELS (§2.1)
// ============================================================================

/** `.states { onState(lifted) … }` — on the dragged source while lifted. */
export const DND_LABEL_LIFTED = "lifted";
/** `.states { onState(over) … }` — on a zone while a compatible drag hovers it. */
export const DND_LABEL_OVER = "over";

// ============================================================================
// VOCABULARY + SPEC TYPES (§2)
// ============================================================================

export type DndActivation = "auto" | "slop" | "press" | "immediate";
export type DndAxis = "x" | "y";
export type DndBounds = "clamp" | "free";
export type DndUnits = "px" | "fraction";

export const DND_ACTIVATIONS: readonly DndActivation[] = [
  "auto",
  "slop",
  "press",
  "immediate",
];
export const DND_AXES: readonly DndAxis[] = ["x", "y"];
export const DND_BOUNDS: readonly DndBounds[] = ["clamp", "free"];
export const DND_UNITS: readonly DndUnits[] = ["px", "fraction"];

/** Default `band` for `.dropZone` — the middle 50% along the sort axis means "into". */
export const DND_DEFAULT_BAND = 0.5;

/** `__dnd.source` — `.draggable`. */
export type DndSourceSpec = {
  group: string | null;
  /** This subtree is the only lift surface. */
  handle: boolean;
  activation: DndActivation;
};

/** `__dnd.zone` — `.dropZone`. */
export type DndZoneSpec = {
  group: string | null;
  /** Fraction (0..1) of the item along the sort axis that resolves to "into". */
  band: number;
  /**
   * `files: true` — the zone also reacts while files dragged in from outside
   * the app (the OS, another app) hover it: the runtime `over` pose and
   * `.onFileDragEnter`. The files are never delivered (docs/dnd.md, "Files
   * from the OS"). Absent on the wire ⇒ `false`.
   */
  files: boolean;
  /** `accept:` filter (`<input accept>` syntax) for a files zone; `null` = any. */
  accept: string | null;
};

/** `__dnd.sort` — `.sortable`. */
export type DndSortSpec = {
  group: string | null;
  axis: DndAxis;
};

/** `__dnd.pin` — `.pinboard`. */
export type DndPinSpec = {
  group: string | null;
  xKey: string;
  yKey: string;
  grid: number | null;
  bounds: DndBounds;
  units: DndUnits;
};

// ============================================================================
// PAYLOAD TYPES (§4)
// ============================================================================

/** One end of a drag: which zone, and the slot within it (`null` = "into"). */
export type DndLocation = {
  zone: string;
  index: number | null;
};

/** The single payload shape every `.on*` event receives (§4.2). */
export type DndEventPayload = {
  /** `__dnd.key` of the dragged node (or node id fallback). */
  item: string;
  /** Resolved `__dnd.sourcePayload`. */
  payload?: unknown;
  from: DndLocation;
  to: DndLocation;
  /** `onPin` only — container content-box units (after grid/units). */
  x?: number;
  y?: number;
  /** `onDragEnd` only. */
  dropped?: boolean;
};

/** `__hypen_reorder` payload, long form. */
export type DndReorderPayload = {
  fromPath: string;
  from: number;
  toPath: string;
  to: number;
};

/** `__hypen_reorder` payload, `path` shorthand (`fromPath == toPath`). */
export type DndReorderShorthandPayload = {
  path: string;
  from: number;
  to: number;
};

/** `__hypen_pin` payload. */
export type DndPinPayload = {
  /** Item base path: `"<bindPath>.<index>"` or `"__dnd.<group>.<key>"`. */
  path: string;
  x: number;
  y: number;
  xKey: string;
  yKey: string;
};

// ============================================================================
// DEFENSIVE PARSING
// ============================================================================

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A channel value normally arrives as an object (WASM patches deserialize
// props to plain JS values), but a stringified object is tolerated for
// hosts that pass raw JSON through (e.g. the Remote UI wire).
const channelObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isPlainObject(value) ? value : null;
};

const parseGroup = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const oneOf = <T extends string>(
  value: unknown,
  vocabulary: readonly T[],
  fallback: T
): T =>
  typeof value === "string" && (vocabulary as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Parse an `__dnd.source` channel value. Malformed channel (not an object)
 * → `null`, the node is not draggable. Missing or invalid fields degrade to
 * the §2 defaults (`group: null`, `handle: false`, `activation: "auto"`) —
 * the engine always fills them, so a hole here is version drift, not
 * author error.
 */
export function parseDndSource(value: unknown): DndSourceSpec | null {
  const obj = channelObject(value);
  if (!obj) return null;
  return {
    group: parseGroup(obj.group),
    handle: obj.handle === true,
    activation: oneOf(obj.activation, DND_ACTIVATIONS, "auto"),
  };
}

/**
 * Parse an `__dnd.zone` channel value. Malformed → `null` (not a zone).
 * `band` outside `[0,1]` clamps; a non-number degrades to
 * {@link DND_DEFAULT_BAND}.
 */
export function parseDndZone(value: unknown): DndZoneSpec | null {
  const obj = channelObject(value);
  if (!obj) return null;
  return {
    group: parseGroup(obj.group),
    band: finiteNumber(obj.band) ? clamp01(obj.band) : DND_DEFAULT_BAND,
    files: obj.files === true,
    accept: typeof obj.accept === "string" && obj.accept.trim().length > 0 ? obj.accept : null,
  };
}

/**
 * Does an OS file drag match a files zone's `accept:` filter?
 *
 * `accept` is `<input accept>` syntax: comma-separated MIME types
 * (`application/pdf`), `type/*` wildcards (`image/*`) and extensions
 * (`.pdf`). `types` are the MIME types of the drag's FILE items as the
 * platform reports them before the drop (`""` for an item whose type it
 * cannot tell), or `null` when the platform exposes no per-item types.
 *
 * Unknown is a match: `accept` null/empty, `types` null or empty, or any
 * item with an empty type. File names are never visible before the drop,
 * so an extension token can never be ruled out — any `.ext` token matches.
 * Otherwise at least one item must match one MIME / wildcard token
 * (case-insensitive).
 */
export function fileDragMatchesAccept(accept: string | null, types: readonly string[] | null): boolean {
  if (accept === null) return true;
  const tokens = accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  if (types === null || types.length === 0) return true;
  if (tokens.some((t) => t.startsWith(".") || t === "*" || t === "*/*")) return true;
  for (const raw of types) {
    const type = raw.trim().toLowerCase();
    if (type === "") return true;
    for (const token of tokens) {
      if (token.endsWith("/*")) {
        if (type.startsWith(token.slice(0, -1))) return true;
      } else if (token === type) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parse an `__dnd.sort` channel value. Malformed → `null` (not sortable).
 * `axis` defaults to `"y"`.
 */
export function parseDndSort(value: unknown): DndSortSpec | null {
  const obj = channelObject(value);
  if (!obj) return null;
  return {
    group: parseGroup(obj.group),
    axis: oneOf(obj.axis, DND_AXES, "y"),
  };
}

/**
 * Parse an `__dnd.pin` channel value. Malformed → `null` (not a pinboard).
 * Defaults: `xKey "x"`, `yKey "y"`, `grid null` (also for a non-positive or
 * non-finite grid), `bounds "clamp"`, `units "px"`.
 */
export function parseDndPin(value: unknown): DndPinSpec | null {
  const obj = channelObject(value);
  if (!obj) return null;
  const key = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  return {
    group: parseGroup(obj.group),
    xKey: key(obj.xKey, "x"),
    yKey: key(obj.yKey, "y"),
    grid: finiteNumber(obj.grid) && obj.grid > 0 ? obj.grid : null,
    bounds: oneOf(obj.bounds, DND_BOUNDS, "clamp"),
    units: oneOf(obj.units, DND_UNITS, "px"),
  };
}

/**
 * Parse a bindable enabled flag (`__dnd.sourceEnabled` / `__dnd.zoneEnabled`).
 * Absent (`undefined`/`null`) ⇒ `true`; only an explicit `false` (or the
 * string `"false"`, for raw-JSON hosts) disables.
 */
export function parseDndEnabled(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (value === false || value === "false") return false;
  return true;
}

/**
 * Parse `__dnd.key` / `__dnd.zoneId` / `__dnd.pinGroup` — a nonempty string,
 * else `null` so callers apply their documented fallback (node id, etc.).
 * Numbers are tolerated (a `ForEach` keyed by a numeric id) and stringified.
 */
export function parseDndString(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (finiteNumber(value)) return String(value);
  return null;
}

// ============================================================================
// GEOMETRY HELPERS (§6.4 / §6.5)
// ============================================================================

export type DndBandResult = "before" | "into" | "after";

/**
 * Band rule for a `.dropZone` on a sortable item (§6.4): the middle `band`
 * fraction of the item along the sort axis resolves to `"into"`; the outer
 * `(1 - band) / 2` on either side fall through to the sortable's
 * before/after insertion. `band` clamps to `[0,1]` (non-finite → default):
 * `0` never yields `"into"` (split at the midpoint), `1` yields `"into"`
 * anywhere inside `[start, start + length)`. Pointers outside the item
 * resolve to `"before"` / `"after"` by side. Boundaries are half-open:
 * a pointer exactly at the start of a band belongs to that band.
 */
export function resolveBand(
  pointerAlongAxis: number,
  itemStart: number,
  itemLength: number,
  band: number
): DndBandResult {
  const b = finiteNumber(band) ? clamp01(band) : DND_DEFAULT_BAND;
  const length = finiteNumber(itemLength) && itemLength > 0 ? itemLength : 0;
  const outer = (1 - b) / 2;
  const beforeEnd = itemStart + length * outer;
  const afterStart = itemStart + length * (1 - outer);
  if (pointerAlongAxis < beforeEnd) return "before";
  if (pointerAlongAxis >= afterStart) return "after";
  return "into";
}

/**
 * Snap a coordinate to the nearest multiple of `grid`. A `null`,
 * non-finite, or non-positive grid leaves `v` unchanged (no grid).
 */
export function snapToGrid(v: number, grid: number | null): number {
  if (!finiteNumber(v)) return v;
  if (grid === null || !finiteNumber(grid) || grid <= 0) return v;
  return Math.round(v / grid) * grid;
}

// ============================================================================
// PATH HELPERS (§4.1)
// ============================================================================

/** Reserved-mode pin base path: `"__dnd.<group>.<key>"`. */
export function reservedPinPath(group: string, key: string): string {
  return `${DND_RESERVED_STATE_KEY}.${group}.${key}`;
}

/** User-field-mode pin base path: `"<bindPath>.<index>"`. */
export function userPinPath(bindPath: string, index: number): string {
  return `${bindPath}.${index}`;
}

const isIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const resolvePath = (root: unknown, path: string): unknown => {
  if (path === "") return root;
  let cur: any = root;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
};

/**
 * `true` when `toPath` addresses the element `fromPath[from]` or anything
 * below it — by path prefix (mirrors Rust's `destination_index_in_source`)
 * or structurally, for a spelling that aliases the same containers: the
 * destination array is reachable from the moved element.
 */
const destinationInsideMovedElement = (
  fromPath: string,
  from: number,
  toPath: string,
  item: unknown,
  dst: unknown[]
): boolean => {
  const self = fromPath === "" ? String(from) : `${fromPath}.${from}`;
  if (toPath === self || toPath.startsWith(`${self}.`)) return true;
  if (item === null || typeof item !== "object") return false;
  // Structural fallback: bounded walk of the moved element's subtree.
  const seen = new Set<object>();
  const stack: object[] = [item as object];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === dst) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const v of Object.values(cur)) {
      if (v !== null && typeof v === "object") stack.push(v);
    }
  }
  return false;
};

/**
 * TS mirror of `portable::path_move` (§5). Move element `from` of the array
 * at `fromPath` to become index `to` of the array at `toPath` (may be the
 * same path). Returns `false` and leaves `root` untouched unless both paths
 * resolve to arrays and `from` is an in-range index. `to` is clamped to
 * `[0, dest.length]` AFTER removal. A same-array move with `from === to` is
 * a no-op returning `true`.
 *
 * Tree DnD: a destination INSIDE the source array (`entries` →
 * `entries.2.children`) is fine — the destination array is resolved by
 * identity before the removal, so it naturally tracks the element the Rust
 * side re-addresses after the index shift. A destination inside the moved
 * element itself (`items` → `items.0.children` when moving index 0) is
 * refused (`false`, untouched) exactly like Rust: splicing the element into
 * its own detached subtree would drop it from reachable state.
 *
 * Works on raw JSON and on the observable state Proxy alike — `splice` is
 * invoked on whatever array the path resolves to, so proxied arrays report
 * their mutations through the normal change-tracking path.
 */
export function applyPathMove(
  root: any,
  fromPath: string,
  from: number,
  toPath: string,
  to: number
): boolean {
  if (typeof fromPath !== "string" || typeof toPath !== "string") return false;
  if (!isIndex(from) || !isIndex(to)) return false;
  const src = resolvePath(root, fromPath);
  const dst = resolvePath(root, toPath);
  if (!Array.isArray(src) || !Array.isArray(dst)) return false;
  if (from >= src.length) return false;

  // Same array (by path or by identity — a proxied array resolves to the
  // same cached proxy from either path spelling).
  const same = fromPath === toPath || src === dst;
  if (same && from === to) return true;

  // Destination inside the element being moved (Rust:
  // `destination_index_in_source(...) == Some((from, _))` → refuse).
  if (!same && destinationInsideMovedElement(fromPath, from, toPath, src[from], dst)) {
    return false;
  }

  const [item] = src.splice(from, 1);
  const target: unknown[] = same ? src : dst;
  const clampedTo = Math.min(to, target.length);
  target.splice(clampedTo, 0, item);
  return true;
}

// ============================================================================
// KEYBOARD DRAG STATE MACHINE (§6 item 8)
// ============================================================================

export type KeyboardDragState = "idle" | "lifted";

/**
 * A zone the keyboard drag may visit. `count` is the number of draggable
 * slots (a sortable's children); `null` marks a plain drop zone whose only
 * target is "into" (`index: null`). A bare string in `zoneOrder` is a
 * sortable with unknown length (moves clamp only at 0).
 */
export type KeyboardDragZone = {
  id: string;
  count: number | null;
};

export type KeyboardDragDirection = "prev" | "next";

// Normalized zone: a bare-string entry is a sortable of unknown length and
// must stay distinct from a `{ id, count: null }` plain drop zone.
type NormalizedZone = KeyboardDragZone & { bare: boolean };

/**
 * Pure keyboard drag state machine (no DOM) shared by every renderer:
 * focus a draggable → Space lifts → Arrow keys move within a sortable /
 * Tab moves between zones → Space drops → Esc cancels. It emits the exact
 * `{ item, from, to }` shape of §4.2, so the renderer dispatches the same
 * `__hypen_reorder` / `.onSort` / `.onDragEnd` it would for a pointer drop.
 *
 * Index semantics match `__hypen_reorder.to`: the FINAL index of the moved
 * item in the destination — `[0, count - 1]` inside the origin zone,
 * `[0, count]` in a foreign zone (`count` = append).
 */
export class KeyboardDragMachine {
  private _state: KeyboardDragState = "idle";
  private item = "";
  private zones: NormalizedZone[] = [];
  private originZone = 0;
  private originIndex = 0;
  private zoneIndex = 0;
  private index: number | null = 0;

  get state(): KeyboardDragState {
    return this._state;
  }

  /** `true` between `lift()` and `drop()`/`cancel()`. */
  get lifted(): boolean {
    return this._state === "lifted";
  }

  /**
   * Lift `item`, currently at `index` within its zone. `zoneOrder` lists the
   * zones Tab may cycle through (ids or {@link KeyboardDragZone}); the origin
   * is `zoneOrder[originZone]` (default the first entry). An empty
   * `zoneOrder` or an out-of-range origin/index is malformed: the machine
   * stays idle and returns `false` (warn-and-degrade — the renderer simply
   * has no keyboard drag for that node).
   */
  lift(
    item: string,
    zoneOrder: readonly (string | KeyboardDragZone)[],
    index: number,
    originZone = 0
  ): boolean {
    if (this._state !== "idle") return false;
    if (typeof item !== "string" || item.length === 0) return false;
    const zones = zoneOrder
      .map((z): NormalizedZone | null => {
        if (typeof z === "string") return z.length > 0 ? { id: z, count: null, bare: true } : null;
        if (!isPlainObject(z) || typeof z.id !== "string" || z.id.length === 0) return null;
        const count = isIndex(z.count) ? z.count : null;
        return { id: z.id, count, bare: false };
      })
      .filter((z): z is NormalizedZone => z !== null);
    if (zones.length === 0) return false;
    if (!isIndex(originZone) || originZone >= zones.length) return false;
    if (!isIndex(index)) return false;
    const origin = zones[originZone]!;
    if (origin.count !== null && index >= origin.count) return false;

    this.item = item;
    this.zones = zones;
    this.originZone = originZone;
    this.originIndex = index;
    this.zoneIndex = originZone;
    this.index = index;
    this._state = "lifted";
    return true;
  }

  /**
   * Arrow key: step the target slot within the current zone. Clamps at the
   * zone's edges; a plain drop zone (`count: null`, foreign) has no slots
   * so this is a no-op. Returns the new position, or `null` when idle.
   */
  move(dir: KeyboardDragDirection): DndLocation | null {
    if (this._state !== "lifted") return null;
    const zone = this.zones[this.zoneIndex]!;
    if (this.index === null) return this.current();
    const max = this.maxIndex(zone, this.zoneIndex);
    const next = dir === "prev" ? this.index - 1 : this.index + 1;
    this.index = Math.max(0, max === null ? next : Math.min(max, next));
    return this.current();
  }

  /**
   * Tab / Shift+Tab: cycle to the adjacent zone (wrapping). Re-entering the
   * origin zone restores the lifted item's original slot; entering a
   * foreign sortable appends (`index = count`, or `0` when unknown);
   * entering a plain drop zone targets "into" (`index: null`). Returns the
   * new position, or `null` when idle.
   */
  moveZone(dir: KeyboardDragDirection): DndLocation | null {
    if (this._state !== "lifted") return null;
    const n = this.zones.length;
    this.zoneIndex = (this.zoneIndex + (dir === "prev" ? n - 1 : 1)) % n;
    const zone = this.zones[this.zoneIndex]!;
    if (this.zoneIndex === this.originZone) {
      this.index = this.originIndex;
    } else if (zone.count === null && !zone.bare) {
      this.index = null;
    } else {
      this.index = zone.count ?? 0;
    }
    return this.current();
  }

  /** Where the lifted item started. `null` when idle. */
  origin(): DndLocation | null {
    if (this._state !== "lifted") return null;
    return { zone: this.zones[this.originZone]!.id, index: this.originIndex };
  }

  /** Current target slot. `null` when idle. */
  current(): DndLocation | null {
    if (this._state !== "lifted") return null;
    return { zone: this.zones[this.zoneIndex]!.id, index: this.index };
  }

  /** `true` when the current target differs from the origin. */
  hasMoved(): boolean {
    if (this._state !== "lifted") return false;
    return this.zoneIndex !== this.originZone || this.index !== this.originIndex;
  }

  /**
   * Space while lifted: commit. Returns the §4.2 `{ item, from, to }`
   * payload (the renderer dispatches `__hypen_reorder` when `to.index` is
   * numeric and a write target exists, then `.onSort`/`.onDrop`, then
   * `.onDragEnd { dropped: true }`) and returns to idle. `null` when idle.
   */
  drop(): DndEventPayload | null {
    if (this._state !== "lifted") return null;
    const payload = this.snapshot();
    this.reset();
    return payload;
  }

  /**
   * Esc while lifted: abandon. Returns the `{ item, from, to }` payload for
   * `.onDragEnd { dropped: false }` (`to` = where the item was hovering) and
   * returns to idle. Nothing else is dispatched on cancel. `null` when idle.
   */
  cancel(): DndEventPayload | null {
    if (this._state !== "lifted") return null;
    const payload = this.snapshot();
    this.reset();
    return payload;
  }

  /**
   * Screen-reader announcement for the current position (renderers feed it
   * to their live region). `null` when idle.
   */
  describe(): string | null {
    if (this._state !== "lifted") return null;
    const zone = this.zones[this.zoneIndex]!;
    if (this.index === null) return `${this.item}, over ${zone.id}`;
    const total = this.zoneIndex === this.originZone ? zone.count : zone.count === null ? null : zone.count + 1;
    const position = `position ${this.index + 1}${total === null ? "" : ` of ${total}`}`;
    return this.zoneIndex === this.originZone
      ? `${this.item}, ${position}`
      : `${this.item}, ${zone.id}, ${position}`;
  }

  private snapshot(): DndEventPayload {
    return { item: this.item, from: this.origin()!, to: this.current()! };
  }

  private reset(): void {
    this._state = "idle";
    this.item = "";
    this.zones = [];
    this.index = 0;
  }

  private maxIndex(zone: NormalizedZone, zoneIndex: number): number | null {
    if (zone.count === null) return null;
    return zoneIndex === this.originZone ? Math.max(0, zone.count - 1) : zone.count;
  }
}
