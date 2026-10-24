/**
 * Studio State panel + Timeline bookkeeping.
 *
 * The preview subscribes with `subscribeState({ modules: true })`, so every
 * `stateUpdate` carries the state of EVERY module on the session — the
 * primary, nested modules and route modules (active or cached) — keyed by
 * lowercase module id. Each update that changes something becomes one
 * timeline entry recording which modules (and top-level keys) changed;
 * time-travel replays the whole entry (`timeTravelPayload`), so the preview
 * re-renders that moment for every module, not only the primary.
 *
 * Older servers send no `modules`: entries then carry the primary's state
 * only, exactly like before.
 */

export type ModuleStates = Record<string, unknown>;

export type StateHistoryEntry = {
  id: string;
  timestamp: number;
  action?: string;
  /** The primary module's state (what legacy servers stream). */
  state: Record<string, any>;
  /** Every module's state (lowercase module id → state), when streamed. */
  modules?: ModuleStates;
  /** What changed since the previous entry, e.g. `["home.taps"]`. */
  changes?: string[];
};

/** What the preview applies when time-travelling to an entry. */
export type StateOverride = {
  state: Record<string, any>;
  modules?: ModuleStates;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Paths that differ between two snapshots: `module.key` for module maps
 * (a module that appeared or disappeared as a whole is reported by its id),
 * or `key` for a primary-only state.
 */
export function diffStates(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  depth: 1 | 2
): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next)]);
  for (const key of keys) {
    const a = prev?.[key];
    const b = next[key];
    if (same(a, b)) continue;
    if (depth === 2 && isRecord(a) && isRecord(b)) {
      for (const sub of diffStates(a, b, 1)) out.push(`${key}.${sub}`);
    } else {
      out.push(key);
    }
  }
  return out;
}

/**
 * The timeline entry for a streamed update, or `null` when nothing changed
 * since `previous` (a re-render that left every module's state alone).
 */
export function makeHistoryEntry(
  previous: StateHistoryEntry | undefined,
  state: Record<string, any>,
  modules: ModuleStates | undefined,
  now: number = Date.now()
): StateHistoryEntry | null {
  const changes = modules
    ? diffStates(previous?.modules, modules, 2)
    : diffStates(previous?.state, state, 1);
  if (previous && changes.length === 0) return null;
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: now,
    state,
    ...(modules ? { modules } : {}),
    ...(previous ? { changes } : { changes: [] }),
  };
}

/** Short timeline label: `home.taps 1 → 2`, or the changed paths. */
export function describeEntry(entry: StateHistoryEntry, previous?: StateHistoryEntry): string {
  const changes = entry.changes ?? [];
  if (!previous || changes.length === 0) return "initial state";
  if (changes.length === 1) {
    const path = changes[0]!;
    const from = readPath(previous.modules ?? previous.state, path, !!previous.modules);
    const to = readPath(entry.modules ?? entry.state, path, !!entry.modules);
    if (isScalar(from) && isScalar(to)) return `${path} ${fmt(from)} → ${fmt(to)}`;
    return path;
  }
  const shown = changes.slice(0, 3).join(", ");
  return changes.length > 3 ? `${shown} +${changes.length - 3}` : shown;
}

/** Module ids that changed in an entry (for per-module badges). */
export function changedModules(entry: StateHistoryEntry): string[] {
  if (!entry.modules) return [];
  const ids = new Set<string>();
  for (const path of entry.changes ?? []) ids.add(path.split(".")[0]!);
  return [...ids];
}

/** The override to send when time-travelling to `entry`. */
export function timeTravelPayload(entry: StateHistoryEntry): StateOverride {
  return entry.modules ? { state: entry.state, modules: entry.modules } : { state: entry.state };
}

/** What the State panel shows: every module, or the primary's state alone. */
export function statePanelData(
  state: Record<string, any>,
  modules: ModuleStates | undefined
): { kind: "modules"; modules: ModuleStates } | { kind: "primary"; state: Record<string, any> } {
  if (modules && Object.keys(modules).length > 0) return { kind: "modules", modules };
  return { kind: "primary", state };
}

function readPath(root: unknown, path: string, modules: boolean): unknown {
  const parts = modules ? path.split(".") : [path];
  let cur: unknown = root;
  for (const part of parts) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
}

function fmt(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v.length > 24 ? `${v.slice(0, 21)}...` : v);
  return String(v);
}

/**
 * `history` with the streamed update appended — or the same array when the
 * update changed nothing. The first per-module update upgrades a leading
 * primary-only entry (the initial tree arrives before the subscription's
 * module snapshot) instead of adding a spurious "everything changed" step.
 */
export function appendHistory(
  history: StateHistoryEntry[],
  state: Record<string, any>,
  modules: ModuleStates | undefined,
  action?: string | null,
  now: number = Date.now()
): StateHistoryEntry[] {
  const last = history[history.length - 1];
  if (last && !last.modules && modules && same(last.state, state)) {
    return [...history.slice(0, -1), { ...last, modules }];
  }
  const entry = makeHistoryEntry(last, state, modules, now);
  if (!entry) return history;
  if (action) entry.action = action;
  return [...history, entry];
}
