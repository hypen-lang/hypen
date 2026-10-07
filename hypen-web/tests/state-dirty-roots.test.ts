/**
 * Dirty-root scoped diffing: `createObservableState`'s traps record
 * which paths were written, and the flush diffs ONLY those subtrees
 * against the snapshot (O(edit), not O(state)). The emitted
 * `StateChange` must be indistinguishable from the full-state diff the
 * flush used to run.
 *
 * Layers:
 *  - deterministic cases for every mutation shape (array methods,
 *    deletes, wholesale replacement, subsumption, batching, escalation
 *    fallbacks, JSON-invisible writes);
 *  - a pipeline fuzzer: seeded random mutation sequences through the
 *    proxy, every flush compared against `diffJsonPaths` of the
 *    before/after snapshots.
 *
 * `HYPEN_DIFF_ORACLE=1` additionally cross-checks every flush in every
 * OTHER test in this repo at runtime — this file is the targeted
 * battery, the oracle is the dragnet.
 */

import { describe, expect, test } from "bun:test";
import {
  createObservableState,
  getStateSnapshot,
  type StateChange,
} from "@hypen-space/core/state";
import { diffJsonPaths, compareCodePoints } from "@hypen-space/core/diff";

const flush = () => new Promise((r) => setTimeout(r, 0));

function observe<T extends object>(initial: T) {
  const changes: StateChange[] = [];
  const state = createObservableState<T>(structuredClone(initial), {
    onChange: (c) => changes.push(c),
  });
  return { state: state as any, changes };
}

/** All changes since the last call, folded into path→value entries. */
function entriesOf(changes: StateChange[]): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const c of changes) for (const p of c.paths) out.push([p, c.newValues[p]]);
  return out;
}

function sortEntries(xs: Array<[string, unknown]>): Array<[string, unknown]> {
  return [...xs].sort((a, b) => compareCodePoints(a[0], b[0]));
}

describe("array mutation shapes emit exactly what the full diff would", () => {
  const base = { items: ["a", "b", "c"], n: 0 };

  const cases: Array<[string, (s: any) => void, Array<[string, unknown]>]> = [
    ["push", (s) => s.items.push("d"), [["items.3", "d"]]],
    // pop shrinks: whole-array replacement per the diff contract.
    ["pop", (s) => s.items.pop(), [["items", ["a", "b"]]]],
    ["shift", (s) => s.items.shift(), [["items", ["b", "c"]]]],
    [
      "unshift",
      (s) => s.items.unshift("z"),
      [
        ["items.0", "z"],
        ["items.1", "a"],
        ["items.2", "b"],
        ["items.3", "c"],
      ],
    ],
    ["splice remove", (s) => s.items.splice(1, 1), [["items", ["a", "c"]]]],
    [
      "splice replace",
      (s) => s.items.splice(1, 1, "B"),
      [["items.1", "B"]],
    ],
    ["direct index", (s) => (s.items[1] = "B"), [["items.1", "B"]]],
    [
      "past-the-end index write fills holes with null",
      (s) => (s.items[5] = "f"),
      [
        ["items.3", null],
        ["items.4", null],
        ["items.5", "f"],
      ],
    ],
    ["length truncate", (s) => (s.items.length = 1), [["items", ["a"]]]],
    [
      "reverse",
      (s) => s.items.reverse(),
      [
        ["items.0", "c"],
        ["items.2", "a"],
      ],
    ],
    [
      "sort",
      (s) => {
        s.items[0] = "x";
        s.items.sort();
      },
      [
        ["items.0", "b"],
        ["items.1", "c"],
        ["items.2", "x"],
      ],
    ],
    [
      "delete element leaves a null hole",
      (s) => delete s.items[1],
      [["items.1", null]],
    ],
    ["fill", (s) => s.items.fill("q", 1), [["items.1", "q"], ["items.2", "q"]]],
  ];

  for (const [name, mutateState, expected] of cases) {
    test(name, async () => {
      const { state, changes } = observe(base);
      const before = getStateSnapshot(state);
      mutateState(state);
      await flush();
      const got = entriesOf(changes);
      expect(sortEntries(got)).toEqual(sortEntries(expected));
      // And the ground truth: identical to a full-state diff.
      const full = diffJsonPaths(before, getStateSnapshot(state)).map(
        (e) => [e.path, e.value] as [string, unknown],
      );
      expect(sortEntries(got)).toEqual(sortEntries(full));
    });
  }
});

describe("object mutation shapes", () => {
  test("nested leaf write emits one leaf", async () => {
    const { state, changes } = observe({ user: { profile: { name: "A", age: 1 } } });
    state.user.profile.name = "B";
    await flush();
    expect(entriesOf(changes)).toEqual([["user.profile.name", "B"]]);
  });

  test("wholesale container replacement is re-granularized by the scoped diff", async () => {
    const { state, changes } = observe({
      rows: [{ id: 1, sel: false }, { id: 2, sel: false }],
    });
    // Immutable-update style: brand-new array, one field different —
    // the trap only knows "rows" changed; the scoped diff must still
    // emit the single changed leaf.
    state.rows = state.rows.map((r: any, i: number) =>
      i === 1 ? { ...r, sel: true } : { ...r },
    );
    await flush();
    expect(entriesOf(changes)).toEqual([["rows.1.sel", true]]);
  });

  test("add and delete keys", async () => {
    const { state, changes } = observe<Record<string, unknown>>({ keep: 1, gone: 2 });
    delete state.gone;
    state.born = { deep: true };
    await flush();
    expect(sortEntries(entriesOf(changes))).toEqual([
      ["born", { deep: true }],
      ["gone", null],
    ]);
  });

  test("subsumption: child write then parent replacement collapses to the parent", async () => {
    const { state, changes } = observe({ a: { x: 1, y: 2 }, b: 0 });
    state.a.x = 99; // child root recorded… (mutates the live tree)
    state.a = { x: 99, y: 3 }; // …then the parent replaces it
    state.b = 1;
    await flush();
    // The snapshot still holds x: 1 (the in-place write and the
    // replacement land in the same flush), so both leaves report.
    expect(sortEntries(entriesOf(changes))).toEqual([
      ["a.x", 99],
      ["a.y", 3],
      ["b", 1],
    ]);
  });

  test("parent replacement then child write on the NEW object", async () => {
    const { state, changes } = observe({ a: { x: 1 } });
    state.a = { x: 1, y: 2 };
    state.a.y = 3; // fresh proxy under the correct path
    await flush();
    expect(entriesOf(changes)).toEqual([["a.y", 3]]);
  });

  test("re-parented object records under its new path", async () => {
    const { state, changes } = observe({ src: { obj: { v: 1 } }, dst: null as any });
    // Touch through src first so the nested proxy gets cached there.
    void state.src.obj.v;
    state.dst = state.src.obj;
    state.src = { obj: null } as any;
    await flush();
    changes.length = 0;
    state.dst.v = 2; // must record dst.v, not src.obj.v
    await flush();
    expect(entriesOf(changes)).toEqual([["dst.v", 2]]);
  });

  test("write-then-overwrite same path in one flush: last value wins, one entry", async () => {
    const { state, changes } = observe({ n: 0 });
    state.n = 1;
    state.n = 2;
    state.n = 3;
    await flush();
    expect(entriesOf(changes)).toEqual([["n", 3]]);
  });

  test("no-op writes emit nothing", async () => {
    const { state, changes } = observe({ n: 1, o: { x: 1 } });
    state.n = 1;
    const sameRef = (state.o as any)["__raw" as any];
    await flush();
    expect(changes.length).toBe(0);
    // Reference-unequal but value-equal container: trap fires, scoped
    // diff proves nothing changed, no notification.
    state.o = { x: 1 };
    await flush();
    expect(changes.length).toBe(0);
    void sameRef;
  });
});

describe("escalation fallbacks stay correct", () => {
  test("dotted key falls back to the full diff", async () => {
    const { state, changes } = observe<Record<string, unknown>>({ "a.b": 1, a: { b: 1 } });
    state["a.b"] = 2;
    await flush();
    // Ambiguous path space — but the emitted change must still match
    // the full diff (which emits the ambiguous path once per side).
    const full = diffJsonPaths({ "a.b": 1, a: { b: 1 } }, getStateSnapshot(state));
    expect(sortEntries(entriesOf(changes))).toEqual(
      sortEntries(full.map((e) => [e.path, e.value] as [string, unknown])),
    );
  });

  test("more than 64 distinct roots escalates to a full diff, output unchanged", async () => {
    const initial: Record<string, number> = {};
    for (let i = 0; i < 100; i++) initial[`k${i}`] = i;
    const { state, changes } = observe(initial);
    for (let i = 0; i < 100; i++) state[`k${i}`] = i + 1000;
    await flush();
    const got = sortEntries(entriesOf(changes));
    expect(got.length).toBe(100);
    expect(got[0]).toEqual(["k0", 1000]);
  });

  test("mass in-place leaf mutation across a large list", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ id: i, sel: false }));
    const { state, changes } = observe({ rows });
    for (const r of state.rows) r.sel = true;
    await flush();
    const got = entriesOf(changes);
    expect(got.length).toBe(300);
    expect(got).toContainEqual(["rows.299.sel", true]);
  });
});

describe("JSON-invisible writes notify nothing", () => {
  test("symbol keys", async () => {
    const { state, changes } = observe({ n: 1 });
    (state as any)[Symbol("side")] = "car";
    await flush();
    expect(changes.length).toBe(0);
  });

  test("named properties on arrays", async () => {
    const { state, changes } = observe({ items: [1, 2] });
    (state.items as any).total = 99;
    (state.items as any)["01"] = "not-an-index";
    await flush();
    expect(changes.length).toBe(0);
  });

  test("BigInt under the written root suppresses that root (stringify-throws contract)", async () => {
    const { state, changes } = observe<Record<string, any>>({ a: 1 });
    state.big = { v: 1n };
    await flush();
    expect(changes.length).toBe(0);
  });

  test("a BigInt elsewhere no longer freezes unrelated updates (scoped improvement)", async () => {
    const { state, changes } = observe<Record<string, any>>({ a: 1 });
    state.big = { v: 1n }; // suppressed root
    await flush();
    state.a = 2; // unrelated root must still flow
    await flush();
    expect(entriesOf(changes)).toEqual([["a", 2]]);
  });
});

describe("batching and flush control", () => {
  test("batch coalesces into one notification with scoped entries", async () => {
    const { state, changes } = observe({ a: 1, b: { c: 1 } });
    (state as any).__beginBatch();
    state.a = 2;
    state.b.c = 3;
    (state as any).__endBatch();
    expect(changes.length).toBe(1);
    expect(sortEntries(entriesOf(changes))).toEqual([
      ["a", 2],
      ["b.c", 3],
    ]);
  });

  test("__flushNow drains synchronously", async () => {
    const { state, changes } = observe({ a: 1 });
    state.a = 2;
    (state as any).__flushNow();
    expect(entriesOf(changes)).toEqual([["a", 2]]);
    await flush();
    expect(changes.length).toBe(1); // stale microtask stood down
  });

  test("values are JSON-normalized in newValues", async () => {
    const { state, changes } = observe<Record<string, any>>({ a: 1 });
    state.when = new Date("2026-05-06T07:08:09.000Z");
    await flush();
    expect(entriesOf(changes)).toEqual([["when", "2026-05-06T07:08:09.000Z"]]);
  });
});

describe("pipeline fuzz: random trapped mutations vs full-diff oracle", () => {
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  type Rng = () => number;
  const int = (rng: Rng, n: number) => Math.floor(rng() * n);
  const pick = <T,>(rng: Rng, xs: T[]): T => xs[int(rng, xs.length)]!;

  const KEYS = ["a", "b", "list", "user", "n", "k10", "k2"];

  function randValue(rng: Rng, depth: number): unknown {
    if (depth <= 0 || rng() < 0.4) {
      return pick(rng, [0, 1, -1, true, false, null, "s", "t", 3.5] as unknown[]);
    }
    if (rng() < 0.5) {
      return Array.from({ length: int(rng, 4) }, () => randValue(rng, depth - 1));
    }
    const o: Record<string, unknown> = {};
    for (let i = 0, n = int(rng, 4); i < n; i++) o[pick(rng, KEYS)] = randValue(rng, depth - 1);
    return o;
  }

  /** Pick a random container REACHED THROUGH THE PROXY (so nested
   * proxies and their cached paths participate) and mutate it. */
  function randomMutation(rng: Rng, stateProxy: any): void {
    let target: any = stateProxy;
    for (let hops = int(rng, 3); hops > 0; hops--) {
      const keys = Array.isArray(target)
        ? target.map((_: unknown, i: number) => i)
        : Object.keys(target);
      const candidates = keys.filter(
        (k: any) => target[k] && typeof target[k] === "object",
      );
      if (candidates.length === 0) break;
      target = target[pick(rng, candidates)];
    }
    if (Array.isArray(target)) {
      switch (int(rng, 6)) {
        case 0: target.push(randValue(rng, 1)); break;
        case 1: if (target.length) target.pop(); break;
        case 2: if (target.length) target[int(rng, target.length)] = randValue(rng, 1); break;
        case 3: if (target.length > 1) target.splice(int(rng, target.length), 1); break;
        case 4: target.length = int(rng, target.length + 2); break;
        case 5: if (target.length > 1) target.reverse(); break;
      }
    } else {
      const key = pick(rng, KEYS);
      switch (int(rng, 4)) {
        case 0: target[key] = randValue(rng, 2); break;
        case 1: delete target[key]; break;
        case 2: target[key] = null; break;
        case 3: target[key] = target[key]; break; // no-op
      }
    }
  }

  test("120 sequences × 4 flushes each match the full diff exactly", async () => {
    const rng = mulberry32(0xd127b007);
    for (let round = 0; round < 120; round++) {
      const initial = {
        a: randValue(rng, 2),
        list: Array.from({ length: 2 + int(rng, 4) }, () => randValue(rng, 2)),
        user: { name: "x", meta: randValue(rng, 2) },
      };
      const { state, changes } = observe(initial as object);
      for (let f = 0; f < 4; f++) {
        const before = getStateSnapshot(state);
        changes.length = 0;
        const mutations = 1 + int(rng, 5);
        for (let m = 0; m < mutations; m++) randomMutation(rng, state);
        await flush();
        const after = getStateSnapshot(state);
        const got = sortEntries(entriesOf(changes));
        const want = sortEntries(
          diffJsonPaths(before, after).map((e) => [e.path, e.value] as [string, unknown]),
        );
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          throw new Error(
            `pipeline fuzz mismatch: round ${round} flush ${f} (seed 0xd127b007)\n` +
              `before: ${JSON.stringify(before)}\nafter:  ${JSON.stringify(after)}\n` +
              `got:    ${JSON.stringify(got)}\nwant:   ${JSON.stringify(want)}`,
          );
        }
      }
    }
    expect(true).toBe(true);
  });
});
