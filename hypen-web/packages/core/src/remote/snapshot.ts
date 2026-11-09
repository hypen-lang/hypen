/**
 * Session snapshots — everything a `RemoteSession` needs to come back as the
 * SAME session in a fresh process / engine:
 *
 *   - the state of every module instance on the connection (the primary,
 *     template-mounted nested modules, and auto-routed route modules, live
 *     or cached), keyed by the lowercase module id the session's global
 *     context registers them under. The primary's `location` key carries the
 *     router location, so restoring it restores the active route too.
 *   - a compact shape of the element tree the client is currently showing
 *     (node ids by structural position), so a message the client sent
 *     against the PREVIOUS engine's node ids can be re-targeted onto the
 *     rebuilt tree instead of failing as a "stale UI action target".
 *
 * Two consumers:
 *   - Cloudflare Durable Object hibernation: the DO persists the snapshot in
 *     its storage after every change, and a woken DO rebuilds the session
 *     from it (module state, route, node identity).
 *   - Hot reload / reconnect (`RemoteServer`): a suspended session keeps its
 *     snapshot in the `SessionManager`, and the resumed session restores
 *     every module from it against the freshly loaded code.
 */

import type { Patch } from "../types.js";

/** Bumped when the snapshot layout changes incompatibly. */
export const SESSION_SNAPSHOT_VERSION = 1;

/**
 * Element tree shape as the client sees it: attached nodes in depth-first
 * pre-order, each with its parent's index in these arrays (-1 = "root").
 */
export interface SnapshotTree {
  ids: string[];
  types: string[];
  parents: number[];
}

export interface SessionSnapshot {
  v: number;
  /** `Date.now()` when the snapshot was taken (stale snapshots are ignored). */
  savedAt: number;
  /** Lowercase module id → plain state snapshot. */
  modules: Record<string, unknown>;
  /** The client-visible tree, for re-targeting in-flight messages. */
  tree?: SnapshotTree;
  /**
   * The session negotiated a device plane: its resume requires the resume
   * token (RFC 001 §5), which a persisted snapshot cannot vouch for — a
   * client-supplied id alone never restores such a session from storage.
   */
  device?: true;
}

/** Above this many nodes the tree is not snapshotted (re-targeting is skipped). */
const MAX_SNAPSHOT_NODES = 5000;

export function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<SessionSnapshot>;
  return (
    v.v === SESSION_SNAPSHOT_VERSION &&
    typeof v.savedAt === "number" &&
    v.modules !== null &&
    typeof v.modules === "object"
  );
}

type Kind = "null" | "array" | "object" | "string" | "number" | "boolean" | "other";

function kindOf(value: unknown): Kind {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "other";
  }
}

/**
 * Merge a module's saved state onto its (possibly new) initial state.
 *
 * The state-shape compatibility rule, shared by hibernation wake and hot
 * reload (where the module's `.ts` — and so its `initialState` — may have
 * changed since the state was saved):
 *
 *   1. Only top-level keys that still exist in the current `initialState`
 *      are restored; a key the new code removed is dropped, and a key the
 *      new code added starts from its initial value.
 *   2. A saved value is kept only when it has the same kind as the initial
 *      value (string / number / boolean / array / object); a changed kind
 *      (e.g. `count: 0` became `count: "0"` or `items: {}` became `[]`)
 *      falls back to the new initial value. An initial `null`/`undefined`
 *      ("not loaded yet") accepts any saved value.
 *   3. Reserved framework keys (`__*`, e.g. the drag-and-drop `__dnd`
 *      positions), which are added at runtime and never declared in
 *      `initialState`, are always carried over.
 *
 * Nested objects are restored as a whole (no deep shape check): a key whose
 * value kind matches keeps its saved value verbatim.
 */
export function mergeRestoredState<T>(initial: T, saved: unknown): T {
  if (saved === null || typeof saved !== "object" || Array.isArray(saved)) return initial;
  if (initial === null || typeof initial !== "object" || Array.isArray(initial)) return initial;
  const base = initial as Record<string, unknown>;
  const from = saved as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(from)) {
    if (key.startsWith("__")) {
      out[key] = value;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(base, key)) continue;
    const want = kindOf(base[key]);
    if (want === "null" || want === kindOf(value)) out[key] = value;
  }
  return out as T;
}

/**
 * A shadow of the client's element tree, maintained from the patches the
 * session sends (after template lowering). Only structure is kept — ids,
 * element types and child order — which is enough to address a node by its
 * structural position and find the same position in another tree.
 */
export class NodeShadow {
  private readonly types = new Map<string, string>();
  private readonly parent = new Map<string, string>();
  private readonly children = new Map<string, string[]>();

  reset(): void {
    this.types.clear();
    this.parent.clear();
    this.children.clear();
  }

  apply(patches: readonly Patch[]): void {
    for (const p of patches) {
      try {
        this.applyOne(p);
      } catch {
        /* a malformed patch never breaks the session; the shadow is best-effort */
      }
    }
  }

  private applyOne(p: Patch): void {
    switch (p.type) {
      case "create":
        if (p.id) this.types.set(p.id, p.elementType ?? "");
        break;
      case "insert":
      case "move":
      case "attach":
        if (p.id && p.parentId) this.link(p.id, p.parentId, p.beforeId);
        break;
      case "detach":
        if (p.id) this.unlink(p.id);
        break;
      case "remove":
        if (p.id) this.drop(p.id);
        break;
      default:
        break;
    }
  }

  private unlink(id: string): void {
    const parentId = this.parent.get(id);
    if (parentId === undefined) return;
    this.parent.delete(id);
    const list = this.children.get(parentId);
    if (!list) return;
    const at = list.indexOf(id);
    if (at >= 0) list.splice(at, 1);
  }

  private link(id: string, parentId: string, beforeId?: string): void {
    this.unlink(id);
    let list = this.children.get(parentId);
    if (!list) {
      list = [];
      this.children.set(parentId, list);
    }
    const at = beforeId ? list.indexOf(beforeId) : -1;
    if (at >= 0) list.splice(at, 0, id);
    else list.push(id);
    this.parent.set(id, parentId);
  }

  private drop(id: string): void {
    this.unlink(id);
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const kids = this.children.get(cur);
      if (kids) for (const k of kids) stack.push(k);
      this.children.delete(cur);
      this.parent.delete(cur);
      this.types.delete(cur);
    }
  }

  /** Attached nodes (reachable from "root") in DFS pre-order; undefined when too big. */
  serialize(): SnapshotTree | undefined {
    const ids: string[] = [];
    const types: string[] = [];
    const parents: number[] = [];
    const walk = (parentId: string, parentIndex: number): boolean => {
      for (const id of this.children.get(parentId) ?? []) {
        if (ids.length >= MAX_SNAPSHOT_NODES) return false;
        const index = ids.length;
        ids.push(id);
        types.push(this.types.get(id) ?? "");
        parents.push(parentIndex);
        if (!walk(id, index)) return false;
      }
      return true;
    };
    if (!walk("root", -1)) return undefined;
    return { ids, types, parents };
  }

  /** Follow a structural path (child index + element type per level) from "root". */
  resolvePath(path: ReadonlyArray<readonly [number, string]>): string | null {
    let cur = "root";
    for (const [index, type] of path) {
      const next = this.children.get(cur)?.[index];
      if (next === undefined) return null;
      if ((this.types.get(next) ?? "") !== type) return null;
      cur = next;
    }
    return cur === "root" ? null : cur;
  }

  /** Whether `id` is currently attached under "root". */
  isAttached(id: string): boolean {
    let cur: string | undefined = id;
    for (let guard = 0; cur !== undefined && guard < 100000; guard++) {
      if (cur === "root") return true;
      cur = this.parent.get(cur);
    }
    return false;
  }
}

/** Structural path (child index + element type per level) of `id` in a snapshot tree. */
export function snapshotPath(
  tree: SnapshotTree,
  id: string
): Array<[number, string]> | null {
  const index = tree.ids.indexOf(id);
  if (index < 0) return null;
  // Child position = order among siblings sharing the same parent (pre-order
  // keeps sibling order).
  const path: Array<[number, string]> = [];
  let cur = index;
  while (cur >= 0) {
    const parent = tree.parents[cur]!;
    let position = 0;
    for (let i = 0; i < cur; i++) if (tree.parents[i] === parent) position++;
    path.push([position, tree.types[cur] ?? ""]);
    cur = parent;
  }
  return path.reverse();
}
