/**
 * Unit tests for `diffJsonPaths` / `diffStateJs` — the TS port of the
 * engine's canonical `portable/diff.rs`.
 *
 * Three layers of protection exist for this port; this file is the
 * first (deterministic semantics + JSON-coercion edge cases). The
 * others are `diff.fixtures.test.ts` (cross-SDK fixture byte-equality)
 * and `diff.fuzz.test.ts` (differential fuzzing against the WASM
 * implementation as oracle).
 *
 * The contract under test: `diffJsonPaths(a, b)` must produce exactly
 * what the old pipeline produced — `diff_paths(parse(stringify(a)),
 * parse(stringify(b)))` — including entry order (serde_json's BTreeMap
 * iterates keys in code-point order; removals/recursions for an
 * object's old keys precede its additions).
 */

import { describe, expect, test } from "bun:test";
import {
  diffJsonPaths,
  diffStateJs,
  compareCodePoints,
} from "@hypen-space/core/diff";
import { createObservableState } from "@hypen-space/core/state";

describe("diff.rs unit-test ports", () => {
  test("no change returns empty", () => {
    const a = { count: 0, name: "Alice" };
    expect(diffJsonPaths(a, structuredClone(a))).toEqual([]);
  });

  test("scalar change at top level", () => {
    expect(diffJsonPaths({ count: 0 }, { count: 1 })).toEqual([
      { path: "count", value: 1 },
    ]);
  });

  test("nested object change", () => {
    expect(
      diffJsonPaths(
        { user: { name: "Alice", age: 30 } },
        { user: { name: "Alice", age: 31 } },
      ),
    ).toEqual([{ path: "user.age", value: 31 }]);
  });

  test("added and removed keys", () => {
    expect(diffJsonPaths({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([
      { path: "b", value: null },
      { path: "c", value: 3 },
    ]);
  });

  test("array index past nine uses full decimal", () => {
    const oldItems = Array.from({ length: 12 }, (_, i) => ({ title: `t${i}` }));
    const newItems = structuredClone(oldItems);
    oldItems[10] = { title: "OLD" };
    expect(diffJsonPaths({ items: oldItems }, { items: newItems })).toEqual([
      { path: "items.10.title", value: "t10" },
    ]);
  });

  test("root array growth is granular", () => {
    expect(diffJsonPaths([1, 2], [1, 2, 3, 4])).toEqual([
      { path: "2", value: 3 },
      { path: "3", value: 4 },
    ]);
  });

  test("root array shrink stays granular (the !prefix.is_empty() guard)", () => {
    expect(diffJsonPaths([1, 2, 3], [1])).toEqual([
      { path: "1", value: null },
      { path: "2", value: null },
    ]);
  });

  test("nested array shrink emits one whole-array replacement", () => {
    const entries = diffJsonPaths(
      { foods: [{ id: "1", name: "A" }, { id: "2", name: "B" }, { id: "3", name: "C" }] },
      { foods: [{ id: "1", name: "A" }] },
    );
    expect(entries).toEqual([
      { path: "foods", value: [{ id: "1", name: "A" }] },
    ]);
  });

  test("same-length nested update stays granular", () => {
    expect(
      diffJsonPaths(
        { foods: [{ id: "1", name: "A" }, { id: "2", name: "B" }] },
        { foods: [{ id: "1", name: "A2" }, { id: "2", name: "B" }] },
      ),
    ).toEqual([{ path: "foods.0.name", value: "A2" }]);
  });

  test("nested array growth emits new index only", () => {
    expect(
      diffJsonPaths({ items: ["a", "b"] }, { items: ["a", "b", "c"] }),
    ).toEqual([{ path: "items.2", value: "c" }]);
  });

  test("type change emits new value", () => {
    expect(diffJsonPaths({ x: 1 }, { x: "one" })).toEqual([
      { path: "x", value: "one" },
    ]);
  });

  test("root scalar change emits nothing", () => {
    expect(diffJsonPaths(1, 2)).toEqual([]);
    expect(diffJsonPaths("a", { x: 1 })).toEqual([]);
    expect(diffJsonPaths(null, [1])).toEqual([]);
    expect(diffJsonPaths({ a: 1 }, 5)).toEqual([]);
  });
});

describe("structural permutations", () => {
  test("container type flips emit the new container", () => {
    expect(diffJsonPaths({ x: [1, 2] }, { x: { 0: 1, 1: 2 } })).toEqual([
      { path: "x", value: { 0: 1, 1: 2 } },
    ]);
    expect(diffJsonPaths({ x: { a: 1 } }, { x: [1] })).toEqual([
      { path: "x", value: [1] },
    ]);
    expect(diffJsonPaths({ x: { a: 1 } }, { x: null })).toEqual([
      { path: "x", value: null },
    ]);
    expect(diffJsonPaths({ x: null }, { x: { a: 1 } })).toEqual([
      { path: "x", value: { a: 1 } },
    ]);
  });

  test("empty containers", () => {
    expect(diffJsonPaths({}, {})).toEqual([]);
    expect(diffJsonPaths([], [])).toEqual([]);
    expect(diffJsonPaths({ a: {} }, { a: {} })).toEqual([]);
    expect(diffJsonPaths({ a: [] }, { a: {} })).toEqual([{ path: "a", value: {} }]);
    expect(diffJsonPaths({ a: {} }, { a: { b: 1 } })).toEqual([
      { path: "a.b", value: 1 },
    ]);
    // Nested [x] -> [] is a shrink: whole-array replacement.
    expect(diffJsonPaths({ a: [1] }, { a: [] })).toEqual([
      { path: "a", value: [] },
    ]);
  });

  test("explicit null is a value, not an absence", () => {
    // Both directions emit (a, null) — matching diff.rs, where a
    // removal and an addition-of-null are indistinguishable in output.
    expect(diffJsonPaths({ a: null }, {})).toEqual([{ path: "a", value: null }]);
    expect(diffJsonPaths({}, { a: null })).toEqual([{ path: "a", value: null }]);
    expect(diffJsonPaths({ a: null }, { a: null })).toEqual([]);
    expect(diffJsonPaths({ a: null }, { a: 1 })).toEqual([{ path: "a", value: 1 }]);
  });

  test("keys containing dots join ambiguously, like Rust", () => {
    expect(diffJsonPaths({ "a.b": 1 }, { "a.b": 2 })).toEqual([
      { path: "a.b", value: 2 },
    ]);
    expect(diffJsonPaths({ a: { b: 1 } }, { a: { b: 2 } })).toEqual([
      { path: "a.b", value: 2 },
    ]);
  });

  test("deep nesting, including past the cycle-check depth, without false positives", () => {
    const deep = (n: number, leaf: unknown): any =>
      n === 0 ? leaf : { d: deep(n - 1, leaf) };
    const a = deep(80, 1);
    const b = deep(80, 2);
    expect(diffJsonPaths(a, b)).toEqual([
      { path: Array(80).fill("d").join("."), value: 2 },
    ]);
    expect(diffJsonPaths(a, deep(80, 1))).toEqual([]);
  });

  test("mixed multi-change emission order: old-key events (sorted) then additions (sorted)", () => {
    const entries = diffJsonPaths(
      { z: 1, m: { x: 1 }, a: 1, removedB: 1, removedA: 1 },
      { z: 2, m: { x: 2 }, a: 1, addedB: 3, addedA: 4 },
    );
    expect(entries).toEqual([
      { path: "m.x", value: 2 },
      { path: "removedA", value: null },
      { path: "removedB", value: null },
      { path: "z", value: 2 },
      { path: "addedA", value: 4 },
      { path: "addedB", value: 3 },
    ]);
  });

  test("numeric-like object keys sort as strings, not numbers", () => {
    // BTreeMap<String> order: "10" < "2". JS insertion order would give
    // integer-like keys ascending numerically — the port must not.
    const entries = diffJsonPaths({ "10": 1, "2": 2 }, { "10": 9, "2": 9 });
    expect(entries).toEqual([
      { path: "10", value: 9 },
      { path: "2", value: 9 },
    ]);
  });

  test("astral-plane keys sort by code point (UTF-8 order), not UTF-16 units", () => {
    // U+FFFD (3-byte UTF-8) must sort BEFORE U+1F600 (4-byte), even
    // though its UTF-16 unit 0xFFFD is greater than the surrogate
    // 0xD83D that leads the emoji.
    expect(compareCodePoints("�", "😀")).toBeLessThan(0);
    const entries = diffJsonPaths(
      { "😀": 1, "�": 1 },
      { "😀": 2, "�": 2 },
    );
    expect(entries).toEqual([
      { path: "�", value: 2 },
      { path: "😀", value: 2 },
    ]);
  });

  test("array element replacement recurses per index", () => {
    expect(
      diffJsonPaths({ xs: [{ a: 1 }, { a: 2 }] }, { xs: [{ a: 1 }, { b: 3 }] }),
    ).toEqual([
      { path: "xs.1.a", value: null },
      { path: "xs.1.b", value: 3 },
    ]);
  });
});

describe("JSON-coercion fidelity (the stringify lens)", () => {
  test("Date compares as its ISO string", () => {
    const d1 = new Date("2026-01-02T03:04:05.000Z");
    const d2 = new Date("2026-01-02T03:04:05.000Z");
    const d3 = new Date("2027-01-01T00:00:00.000Z");
    expect(diffJsonPaths({ when: d1 }, { when: d2 })).toEqual([]);
    expect(diffJsonPaths({ when: d1 }, { when: d3 })).toEqual([
      { path: "when", value: "2027-01-01T00:00:00.000Z" },
    ]);
    expect(diffJsonPaths({ when: d1.toISOString() }, { when: d2 })).toEqual([]);
  });

  test("undefined / function / symbol object values are absent keys", () => {
    expect(diffJsonPaths({ a: undefined }, {})).toEqual([]);
    expect(diffJsonPaths({}, { a: undefined })).toEqual([]);
    expect(diffJsonPaths({ a: 1 }, { a: undefined })).toEqual([
      { path: "a", value: null },
    ]);
    expect(diffJsonPaths({ a: undefined }, { a: 1 })).toEqual([
      { path: "a", value: 1 },
    ]);
    expect(diffJsonPaths({ a: () => 1 }, { a: Symbol("x") as any })).toEqual([]);
  });

  test("undefined array elements and holes are null", () => {
    expect(diffJsonPaths({ xs: [undefined] }, { xs: [null] })).toEqual([]);
    // eslint-disable-next-line no-sparse-arrays
    expect(diffJsonPaths({ xs: [1, , 3] as any }, { xs: [1, null, 3] })).toEqual([]);
    expect(diffJsonPaths({ xs: [1] }, { xs: [1, undefined] as any })).toEqual([
      { path: "xs.1", value: null },
    ]);
  });

  test("NaN and Infinity compare as null", () => {
    expect(diffJsonPaths({ n: NaN }, { n: null })).toEqual([]);
    expect(diffJsonPaths({ n: Infinity }, { n: -Infinity })).toEqual([]);
    expect(diffJsonPaths({ n: 1 }, { n: NaN })).toEqual([
      { path: "n", value: null },
    ]);
  });

  test("-0 equals 0", () => {
    expect(diffJsonPaths({ n: 0 }, { n: -0 })).toEqual([]);
  });

  test("Map, Set and RegExp are their (empty) enumerable-property form", () => {
    expect(diffJsonPaths({ m: new Map([["k", 1]]) }, { m: {} })).toEqual([]);
    expect(diffJsonPaths({ s: new Set([1]) }, { s: {} })).toEqual([]);
    expect(diffJsonPaths({ r: /x/ }, { r: {} })).toEqual([]);
    expect(diffJsonPaths({ m: {} }, { m: new Map([["k", 1]]) })).toEqual([]);
  });

  test("class instances are their own enumerable properties", () => {
    class Point {
      constructor(public x: number, public y: number) {}
      len() { return 0; }
    }
    expect(diffJsonPaths({ p: new Point(1, 2) }, { p: { x: 1, y: 2 } })).toEqual([]);
    const entries = diffJsonPaths({ p: { x: 1, y: 2 } }, { p: new Point(1, 3) });
    expect(entries).toEqual([{ path: "p.y", value: 3 }]);
  });

  test("Number/String/Boolean wrapper objects unwrap", () => {
    expect(diffJsonPaths({ n: new Number(5) }, { n: 5 })).toEqual([]);
    expect(diffJsonPaths({ s: new String("x") }, { s: "x" })).toEqual([]);
    expect(diffJsonPaths({ b: new Boolean(true) }, { b: true })).toEqual([]);
  });

  test("custom toJSON is honoured, recursively", () => {
    const v = { toJSON: () => ({ inner: { toJSON: () => 42 } }) };
    expect(diffJsonPaths({ v }, { v: { inner: 42 } })).toEqual([]);
    expect(diffJsonPaths({ v }, { v: { inner: 43 } })).toEqual([
      { path: "v.inner", value: 43 },
    ]);
  });

  test("toJSON returning undefined makes the key absent", () => {
    const ghost = { toJSON: () => undefined };
    expect(diffJsonPaths({ a: ghost }, {})).toEqual([]);
    expect(diffJsonPaths({ a: ghost }, { a: 1 })).toEqual([
      { path: "a", value: 1 },
    ]);
    expect(diffJsonPaths({ a: 1 }, { a: ghost })).toEqual([
      { path: "a", value: null },
    ]);
  });

  test("hypen state proxies are unwrapped", () => {
    const state = createObservableState({ user: { name: "Ada" }, n: 1 });
    expect(diffJsonPaths(state, { user: { name: "Ada" }, n: 1 })).toEqual([]);
    expect(diffJsonPaths({ wrapped: (state as any).user }, { wrapped: { name: "Bo" } })).toEqual([
      { path: "wrapped.name", value: "Bo" },
    ]);
  });

  test("emitted container values are JSON-normalized", () => {
    const entries = diffJsonPaths(
      { x: 1 },
      { x: 1, added: { when: new Date("2026-01-01T00:00:00.000Z"), gone: undefined, n: NaN } },
    );
    expect(entries).toEqual([
      { path: "added", value: { when: "2026-01-01T00:00:00.000Z", n: null } },
    ]);
  });

  test("already-plain emitted containers pass by reference (copy-on-write)", () => {
    const added = { id: 1, tags: ["a"] };
    const entries = diffJsonPaths({ x: 1 }, { x: 1, added });
    expect(entries[0]!.value).toBe(added);
  });
});

describe("unserializable trees empty the diff (the stringify-throws contract)", () => {
  test("BigInt in the changed value", () => {
    expect(diffJsonPaths({ a: 1 }, { a: 2n as any })).toEqual([]);
  });

  test("BigInt in an UNCHANGED subtree still empties the diff", () => {
    const big = { deep: { huge: 9n as any } };
    expect(diffJsonPaths({ big, x: 1 }, { big, x: 2 })).toEqual([]);
  });

  test("BigInt in a removed subtree empties the diff", () => {
    expect(diffJsonPaths({ dying: { v: 1n as any }, x: 1 }, { x: 2 })).toEqual([]);
  });

  test("BigInt in an added subtree empties the diff", () => {
    expect(diffJsonPaths({ x: 1 }, { x: 2, born: { v: 1n as any } })).toEqual([]);
  });

  test("BigInt behind a shrinking array empties the diff", () => {
    expect(
      diffJsonPaths({ xs: [{ v: 1n as any }, 2] }, { xs: [1] }),
    ).toEqual([]);
  });

  test("circular structures empty the diff, on either side", () => {
    const a: any = { x: 1 };
    a.self = a;
    expect(diffJsonPaths(a, { x: 2, self: {} })).toEqual([]);
    expect(diffJsonPaths({ x: 1, self: {} }, a)).toEqual([]);
    const deepCycle: any = { l1: { l2: {} } };
    deepCycle.l1.l2.back = deepCycle;
    expect(diffJsonPaths({ c: deepCycle, x: 1 }, { c: {}, x: 2 })).toEqual([]);
  });

  test("shared (non-circular) references are fine", () => {
    const shared = { v: 1 };
    expect(
      diffJsonPaths({ a: shared, b: shared, x: 1 }, { a: { v: 1 }, b: { v: 1 }, x: 2 }),
    ).toEqual([{ path: "x", value: 2 }]);
  });
});

describe("diffStateJs wrapper", () => {
  test("maps entries into { paths, newValues } preserving order", () => {
    const change = diffStateJs({ b: 1, a: 1 }, { b: 2, a: 3 });
    expect(change.paths).toEqual(["a", "b"]);
    expect(change.newValues).toEqual({ a: 3, b: 2 });
  });

  test("null/undefined roots behave as null", () => {
    expect(diffStateJs(undefined, { a: 1 })).toEqual({ paths: [], newValues: {} });
    expect(diffStateJs(null, null)).toEqual({ paths: [], newValues: {} });
  });

  test("basePath is accepted and ignored, like the WASM impls", () => {
    const change = diffStateJs({ a: 1 }, { a: 2 }, "prefix");
    expect(change.paths).toEqual(["a"]);
  });
});

describe("performance guard", () => {
  test("1000-row single-leaf diff stays well under the serialization cost it replaced", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      label: `row ${i} label`,
      selected: false,
      meta: { rank: i % 7, tags: ["a", "b"] },
    }));
    const next = { rows: structuredClone(rows) } as any;
    next.rows[500].selected = true;
    const old = { rows };
    diffJsonPaths(old, next); // warm
    const t0 = performance.now();
    const entries = diffJsonPaths(old, next);
    const ms = performance.now() - t0;
    expect(entries).toEqual([{ path: "rows.500.selected", value: true }]);
    // Steady-state is ~0.5–1 ms; the old WASM round trip was ~10–17 ms.
    // Generous bound so CI variance can't flake it, tight enough to
    // catch an accidental O(n²) or serialization sneaking back in.
    expect(ms).toBeLessThan(25);
  });
});
