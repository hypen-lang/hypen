
// Contract tests for `normalizeForWasm`, the copy-on-write walk behind
// the browser engine's `unwrapForWasm`. Two properties matter:
// already-plain data crosses the WASM boundary by reference (the hot
// sparse-update path pays no clone), and anything not plain comes out
// exactly as the old `JSON.parse(JSON.stringify())` round-trip shaped it.

import { describe, expect, test } from "bun:test";
import { normalizeForWasm } from "@hypen-space/core/engine-base";
import { createObservableState } from "@hypen-space/core/state";

describe("normalizeForWasm", () => {
  test("returns already-plain data by reference, allocation-free", () => {
    const value = {
      rows: [
        { id: 1, label: "a", selected: false },
        { id: 2, label: "b", selected: true },
      ],
      count: 2,
      title: null,
    };
    expect(normalizeForWasm(value)).toBe(value);
  });

  test("matches the JSON round-trip on exotic values", () => {
    const value = {
      when: new Date("2026-01-02T03:04:05.000Z"),
      missing: undefined,
      fn: () => {},
      nan: NaN,
      inf: Infinity,
      arr: [undefined, NaN, "keep"],
      map: new Map([["k", "v"]]),
      set: new Set([1, 2]),
      re: /x/,
    };
    expect(normalizeForWasm(value)).toEqual(JSON.parse(JSON.stringify(value)));
  });

  test("copies only the spine above a converted value", () => {
    const untouched = { deep: [1, 2, 3] };
    const value = { untouched, dated: { when: new Date() } };
    const out = normalizeForWasm(value) as any;
    expect(out).not.toBe(value);
    expect(out.untouched).toBe(untouched);
    expect(typeof out.dated.when).toBe("string");
  });

  test("unwraps Hypen state proxies without cloning their raw target", () => {
    const state = createObservableState({ user: { name: "Ada" }, tags: ["x"] });
    const out = normalizeForWasm(state) as any;
    expect(out).toEqual({ user: { name: "Ada" }, tags: ["x"] });
    // The result is the raw target, not a proxy and not a copy.
    expect(out.user.name).toBe("Ada");
    state.user.name = "Grace";
    expect(out.user.name).toBe("Grace");
  });

  test("unwraps a proxy nested inside a fresh plain object", () => {
    const state = createObservableState({ user: { name: "Ada" } });
    const out = normalizeForWasm({ wrapped: state.user }) as any;
    expect(out.wrapped).toEqual({ name: "Ada" });
  });

  test("class instances reduce to own enumerable properties", () => {
    class Point {
      constructor(public x: number, public y: number) {}
      length() {
        return Math.hypot(this.x, this.y);
      }
    }
    const out = normalizeForWasm({ p: new Point(3, 4) }) as any;
    expect(out.p).toEqual({ x: 3, y: 4 });
    expect(Object.getPrototypeOf(out.p)).toBe(Object.prototype);
  });

  test("throws on circular structures, like JSON.stringify", () => {
    const a: any = { name: "a" };
    a.self = a;
    expect(() => normalizeForWasm(a)).toThrow(TypeError);
  });

  test("throws on BigInt, like JSON.stringify", () => {
    expect(() => normalizeForWasm({ big: 1n })).toThrow(TypeError);
  });
});
