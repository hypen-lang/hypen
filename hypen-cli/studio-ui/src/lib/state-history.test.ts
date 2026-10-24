import { describe, expect, test } from "bun:test";
import {
  appendHistory,
  changedModules,
  describeEntry,
  diffStates,
  makeHistoryEntry,
  statePanelData,
  timeTravelPayload,
  type StateHistoryEntry,
} from "./state-history";

const primary = { location: "/" };

describe("state history (per-module timeline)", () => {
  test("records one entry per change with the changed module paths", () => {
    let h: StateHistoryEntry[] = [];
    h = appendHistory(h, primary, { app: primary, home: { taps: 0 } }, null, 1);
    h = appendHistory(h, primary, { app: primary, home: { taps: 1 } }, "tap", 2);
    h = appendHistory(h, primary, { app: primary, home: { taps: 2 } }, "tap", 3);
    expect(h).toHaveLength(3);
    expect(h.map((e) => e.changes)).toEqual([[], ["home.taps"], ["home.taps"]]);
    expect(h[1]!.action).toBe("tap");
    expect(describeEntry(h[0]!)).toBe("initial state");
    expect(describeEntry(h[2]!, h[1])).toBe("home.taps 1 → 2");
    expect(changedModules(h[2]!)).toEqual(["home"]);
  });

  test("an update that changed nothing adds no entry", () => {
    const h = appendHistory([], primary, { app: primary, home: { taps: 0 } }, null, 1);
    expect(appendHistory(h, primary, { app: primary, home: { taps: 0 } })).toBe(h);
  });

  test("the first module snapshot upgrades the primary-only initial entry", () => {
    let h = appendHistory([], primary, undefined, null, 1);
    h = appendHistory(h, primary, { app: primary, home: { taps: 0 } }, null, 2);
    expect(h).toHaveLength(1);
    expect(h[0]!.modules).toEqual({ app: primary, home: { taps: 0 } });
  });

  test("a route module joining is reported by its id", () => {
    const prev = makeHistoryEntry(undefined, primary, { app: primary, home: { taps: 2 } }, 1)!;
    const next = makeHistoryEntry(prev, { location: "/counter" }, {
      app: { location: "/counter" },
      home: { taps: 2 },
      counter: { count: 0 },
    }, 2)!;
    expect(next.changes).toEqual(["app.location", "counter"]);
    expect(changedModules(next).sort()).toEqual(["app", "counter"]);
  });

  test("legacy servers (no modules) diff the primary's state", () => {
    expect(diffStates({ count: 1, x: 1 }, { count: 2, x: 1 }, 1)).toEqual(["count"]);
    const a = makeHistoryEntry(undefined, { count: 1 }, undefined, 1)!;
    const b = makeHistoryEntry(a, { count: 2 }, undefined, 2)!;
    expect(describeEntry(b, a)).toBe("count 1 → 2");
    expect(timeTravelPayload(b)).toEqual({ state: { count: 2 } });
  });

  test("time-travel restores every module of the entry", () => {
    const e = makeHistoryEntry(undefined, primary, { app: primary, home: { taps: 1 } }, 1)!;
    expect(timeTravelPayload(e)).toEqual({ state: primary, modules: { app: primary, home: { taps: 1 } } });
  });

  test("the State panel shows each module, falling back to the primary", () => {
    expect(statePanelData(primary, { app: primary, home: { taps: 2 } })).toEqual({
      kind: "modules",
      modules: { app: primary, home: { taps: 2 } },
    });
    expect(statePanelData(primary, undefined)).toEqual({ kind: "primary", state: primary });
  });
});
