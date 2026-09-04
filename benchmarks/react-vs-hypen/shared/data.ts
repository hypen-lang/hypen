/**
 * Deterministic dataset shared by both apps.
 *
 * Both implementations call `buildRows(n, seed)` with the same arguments, so
 * every string that ends up in the DOM — names, initials, team, status,
 * formatted value — is byte-identical on both sides. Nothing is formatted at
 * render time: any `toLocaleString`/`toFixed` work would otherwise show up as
 * framework cost on whichever side happened to do it in the render path.
 */

export interface Row {
  id: number;
  name: string;
  initials: string;
  team: string;
  meta: string;
  status: string;
  statusColor: string;
  value: string;
  selected: boolean;
}

import { STATUS_COLOR } from "./theme";

const ADJECTIVES = [
  "swift", "quiet", "amber", "hollow", "brisk", "vivid", "lunar", "molten",
  "silent", "crimson", "arctic", "gilded", "rapid", "hidden", "solar", "iron",
];

const NOUNS = [
  "pipeline", "gateway", "ingest", "shard", "cluster", "runtime", "buffer",
  "scheduler", "index", "digest", "router", "cache", "stream", "compiler",
  "planner", "worker",
];

const TEAMS = [
  "Platform", "Runtime", "Edge", "Data", "Growth", "Infra", "Mobile", "Core",
];

const STATUSES = Object.keys(STATUS_COLOR);

/** mulberry32 — small, fast, and identical across both apps. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 1;

/** Reset the id counter so a run is reproducible across reloads. */
export function resetIds(): void {
  nextId = 1;
}

export function buildRows(count: number, seed = 1): Row[] {
  const rand = rng(seed + nextId);
  const rows: Row[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const adj = ADJECTIVES[(rand() * ADJECTIVES.length) | 0];
    const noun = NOUNS[(rand() * NOUNS.length) | 0];
    const team = TEAMS[(rand() * TEAMS.length) | 0];
    const status = STATUSES[(rand() * STATUSES.length) | 0];
    const id = nextId++;
    rows[i] = {
      id,
      name: `${adj} ${noun} #${id}`,
      initials: (adj[0] + noun[0]).toUpperCase(),
      team,
      meta: `${1 + ((rand() * 48) | 0)}m ago`,
      status,
      statusColor: STATUS_COLOR[status],
      value: `${(rand() * 900 + 100) | 0} ops/s`,
      selected: false,
    };
  }
  return rows;
}

/**
 * The row mutations the benchmark drives. Kept here — rather than inline in
 * each app — so React and Hypen perform exactly the same data work and the
 * measurement isolates the *rendering* difference.
 */
export const ops = {
  updateEveryTenth(rows: Row[]): Row[] {
    const next = rows.slice();
    for (let i = 0; i < next.length; i += 10) {
      next[i] = { ...next[i], name: next[i].name + " !!!" };
    }
    return next;
  },

  updateAll(rows: Row[]): Row[] {
    const next = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      next[i] = { ...rows[i], name: rows[i].name + " !!!" };
    }
    return next;
  },

  select(rows: Row[], index: number): Row[] {
    const next = rows.slice();
    for (let i = 0; i < next.length; i++) {
      if (next[i].selected && i !== index) next[i] = { ...next[i], selected: false };
    }
    if (next[index]) next[index] = { ...next[index], selected: true };
    return next;
  },

  swap(rows: Row[], a: number, b: number): Row[] {
    if (rows.length <= Math.max(a, b)) return rows;
    const next = rows.slice();
    const tmp = next[a];
    next[a] = next[b];
    next[b] = tmp;
    return next;
  },

  removeAt(rows: Row[], index: number): Row[] {
    const next = rows.slice();
    next.splice(index, 1);
    return next;
  },
};
