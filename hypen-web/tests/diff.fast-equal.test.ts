/**
 * The diff skips element pairs it can cheaply prove equal (`certainlyEqual`
 * in packages/core/src/diff.ts). That shortcut must be invisible: for every
 * pair below, the result has to be exactly what the WASM reference
 * implementation (`diff_paths`) returns for the same two trees.
 */
import { describe, expect, test } from "bun:test";
import { canonicalDiffJson, diffJsonPaths } from "../packages/core/src/diff";
import * as wasm from "../packages/server/wasm-node/hypen_engine.js";

/** The old pipeline: stringify both live trees, diff them in WASM. */
const reference = (a: unknown, b: unknown) =>
  canonicalDiffJson(
    JSON.parse(wasm.diffPaths(JSON.stringify(a ?? null), JSON.stringify(b ?? null))),
  );

const row = (i: number) => ({
  id: i,
  name: `row ${i}`,
  tags: ["a", "b"],
  meta: { ok: true, score: i / 3, nothing: null },
});
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));

describe("diff: unchanged elements are skipped without changing the result", () => {
  const cases: Array<[string, () => [unknown, unknown]]> = [
    ["identical list", () => [{ rows: rows(50) }, { rows: rows(50) }]],
    ["one field of one row", () => {
      const next = rows(50);
      next[17] = { ...next[17]!, name: "changed" };
      return [{ rows: rows(50) }, { rows: next }];
    }],
    ["nested change deep in one row", () => {
      const next = rows(20);
      next[3] = { ...next[3]!, meta: { ...next[3]!.meta, ok: false } };
      return [{ rows: rows(20) }, { rows: next }];
    }],
    ["two rows swapped", () => {
      const next = rows(20);
      [next[1], next[18]] = [next[18]!, next[1]!];
      return [{ rows: rows(20) }, { rows: next }];
    }],
    ["appended rows", () => [{ rows: rows(10) }, { rows: rows(15) }]],
    ["removed row (shrink)", () => [{ rows: rows(10) }, { rows: rows(10).filter((r) => r.id !== 4) }]],
    ["key added to one row", () => {
      const next: any[] = rows(5);
      next[2] = { ...next[2], extra: 1 };
      return [{ rows: rows(5) }, { rows: next }];
    }],
    ["key removed from one row", () => {
      const next: any[] = rows(5);
      const { name: _dropped, ...rest } = next[2];
      next[2] = rest;
      return [{ rows: rows(5) }, { rows: next }];
    }],
    ["same keys, different order", () => [{ r: [{ a: 1, b: 2 }] }, { r: [{ b: 2, a: 1 }] }]],
    ["array vs object at the same slot", () => [{ r: [[1, 2]] }, { r: [{ 0: 1, 1: 2 }] }]],
    ["number vs numeric string", () => [{ r: [{ v: 1 }] }, { r: [{ v: "1" }] }]],
    ["null vs missing", () => [{ r: [{ v: null }] }, { r: [{}] }]],
    ["undefined values on both sides", () => [{ r: [{ v: undefined, w: 1 }] }, { r: [{ v: undefined, w: 1 }] }]],
    ["undefined vs null in an array", () => [{ r: [undefined, 1] }, { r: [null, 1] }]],
    ["NaN and Infinity", () => [{ r: [{ v: NaN, w: Infinity }] }, { r: [{ v: NaN, w: -Infinity }] }]],
    ["negative zero", () => [{ r: [{ v: -0 }] }, { r: [{ v: 0 }] }]],
    ["dates (toJSON)", () => [{ r: [{ at: new Date(5) }] }, { r: [{ at: new Date(5) }] }]],
    ["dates that differ", () => [{ r: [{ at: new Date(5) }] }, { r: [{ at: new Date(6) }] }]],
    ["class instance vs plain object", () => {
      class Box { v = 1; }
      return [{ r: [new Box()] }, { r: [{ v: 1 }] }];
    }],
    ["wrapper objects", () => [{ r: [{ v: new Number(1) }] }, { r: [{ v: 1 }] }]],
    ["function-valued key", () => [{ r: [{ v: 1, f() {} }] }, { r: [{ v: 1 }] }]],
    ["sparse array", () => {
      const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
      return [{ r: [sparse] }, { r: [[1, null, 3]] }];
    }],
    ["empty containers", () => [{ r: [{}, [], { a: {} }] }, { r: [{}, [], { a: [] }] }]],
  ];

  for (const [name, make] of cases) {
    test(name, () => {
      const [a, b] = make();
      expect(canonicalDiffJson(diffJsonPaths(a, b))).toBe(reference(a, b));
    });
  }

  test("a BigInt hidden behind an otherwise-equal prefix still empties the diff", () => {
    const a = { rows: [row(0), { id: 1, big: 1n }] };
    const b = { rows: [row(0), { id: 1, big: 2n }] };
    expect(diffJsonPaths(a, b)).toEqual([]);
  });

  test("a 1,000-row list with one changed row reports just that row's field", () => {
    const next = rows(1000);
    next[500] = { ...next[500]!, name: "changed" };
    expect(diffJsonPaths({ rows: rows(1000) }, { rows: next })).toEqual([
      { path: "rows.500.name", value: "changed" },
    ]);
  });
});
