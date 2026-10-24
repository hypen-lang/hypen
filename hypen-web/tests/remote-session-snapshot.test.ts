import { describe, expect, test } from "bun:test";
import {
  NodeShadow,
  mergeRestoredState,
  snapshotPath,
} from "../packages/core/src/remote/snapshot";
import { SessionManager } from "../packages/core/src/remote/session";

describe("mergeRestoredState (state-shape rule)", () => {
  test("keeps saved values for keys that still exist with the same kind", () => {
    expect(mergeRestoredState({ count: 0, name: "" }, { count: 5, name: "x" })).toEqual({ count: 5, name: "x" });
  });
  test("drops removed keys, adds new keys at their initial value", () => {
    expect(mergeRestoredState({ count: 0, added: true }, { count: 2, removed: 1 })).toEqual({ count: 2, added: true });
  });
  test("a changed kind falls back to the new initial value", () => {
    expect(
      mergeRestoredState({ count: "0", items: [] as unknown[], meta: {} }, { count: 3, items: {}, meta: [] })
    ).toEqual({ count: "0", items: [], meta: {} });
  });
  test("an initial null accepts any saved value; reserved __ keys carry over", () => {
    expect(mergeRestoredState({ user: null }, { user: { id: 1 }, __dnd: { b: 1 } })).toEqual({
      user: { id: 1 },
      __dnd: { b: 1 },
    });
  });
  test("non-object saved state leaves the initial state untouched", () => {
    const initial = { a: 1 };
    expect(mergeRestoredState(initial, null)).toBe(initial);
    expect(mergeRestoredState(initial, [1])).toBe(initial);
  });
});

describe("NodeShadow", () => {
  const build = (ids: [string, string][], parent = "root") => {
    const s = new NodeShadow();
    s.apply(ids.map(([id, t]) => ({ type: "create", id, elementType: t }) as any));
    s.apply(ids.map(([id]) => ({ type: "insert", id, parentId: parent }) as any));
    return s;
  };

  test("maps a node of one tree onto the same structural position of another", () => {
    const old = new NodeShadow();
    old.apply([
      { type: "create", id: "10", elementType: "Column" },
      { type: "create", id: "11", elementType: "Text" },
      { type: "create", id: "12", elementType: "Button" },
      { type: "insert", id: "10", parentId: "root" },
      { type: "insert", id: "12", parentId: "10" },
      { type: "insert", id: "11", parentId: "10", beforeId: "12" },
    ] as any);
    const tree = old.serialize()!;
    const path = snapshotPath(tree, "12")!;
    expect(path).toEqual([[0, "Column"], [1, "Button"]]);

    const fresh = new NodeShadow();
    fresh.apply([
      { type: "create", id: "a", elementType: "Column" },
      { type: "create", id: "b", elementType: "Text" },
      { type: "create", id: "c", elementType: "Button" },
      { type: "insert", id: "a", parentId: "root" },
      { type: "insert", id: "b", parentId: "a" },
      { type: "insert", id: "c", parentId: "a" },
    ] as any);
    expect(fresh.resolvePath(path)).toBe("c");
    // A type mismatch at any level never maps.
    expect(fresh.resolvePath([[0, "Column"], [1, "Text"]])).toBeNull();
  });

  test("detached and removed subtrees are not part of the snapshot", () => {
    const s = build([["1", "Text"], ["2", "Text"], ["3", "Text"]]);
    s.apply([{ type: "detach", id: "2" }, { type: "remove", id: "3" }] as any);
    expect(s.serialize()!.ids).toEqual(["1"]);
    s.apply([{ type: "attach", id: "2", parentId: "root", beforeId: "1" }] as any);
    expect(s.serialize()!.ids).toEqual(["2", "1"]);
  });
});

describe("SessionManager carries the full snapshot through suspend/resume", () => {
  test("resumeSession returns the snapshot passed to suspendSession", () => {
    const sm = new SessionManager();
    const s = sm.createSession();
    const snapshot = { v: 1, savedAt: Date.now(), modules: { app: { a: 1 }, home: { taps: 2 } } };
    sm.suspendSession(s.id, { a: 1 }, () => {}, snapshot);
    expect(sm.resumeSession(s.id)?.snapshot).toEqual(snapshot);
    sm.destroy();
  });
});
