import { describe, expect, test } from "bun:test";
import {
  createObservableState,
  batchStateUpdates,
  getStateSnapshot,
  isStateProxy,
  unwrapProxy,
  type StateChange,
} from "../packages/core/src/state";
import { flushMicrotasks } from "./helpers";

describe("createObservableState", () => {
  test("emits paths for shallow mutations", async () => {
    const changes: StateChange[] = [];
    const state = createObservableState({ count: 0 }, {
      onChange: (change) => changes.push(change),
    });

    state.count = 2;
    await flushMicrotasks();

    expect(changes.length).toBe(1);
    expect(changes[0]!.paths).toEqual(["count"]);
    expect(changes[0]!.newValues).toEqual({ count: 2 });
  });

  test("does not emit when value stays the same", async () => {
    const changes: StateChange[] = [];
    const state = createObservableState({ count: 0 }, {
      onChange: (change) => changes.push(change),
    });

    state.count = 0;
    await flushMicrotasks();

    expect(changes.length).toBe(0);
  });

  test("tracks nested object updates", async () => {
    const changes: StateChange[] = [];
    const state = createObservableState({ user: { profile: { name: "" } } }, {
      onChange: (change) => changes.push(change),
    });

    state.user.profile.name = "Ada";
    await flushMicrotasks();

    expect(changes[0]!.paths).toEqual(["user.profile.name"]);
    expect(changes[0]!.newValues).toEqual({ "user.profile.name": "Ada" });
  });

  test("identifies array element and length changes", async () => {
    const changes: StateChange[] = [];
    const state = createObservableState({ items: ["a", "b"] }, {
      onChange: (change) => changes.push(change),
    });

    state.items[1] = "c";
    await flushMicrotasks();

    expect(changes[0]!.paths).toEqual(["items.1"]);
    expect(changes[0]!.newValues).toEqual({ "items.1": "c" });

    state.items.push("d");
    await flushMicrotasks();

    // Engine canonical behaviour: array-length changes emit a path
    // for each added/removed index, not the parent. This matches
    // Rust, Go, Kotlin, and Swift. TS used to emit the parent path
    // (`items`); that quirk has been removed.
    expect(changes[1]!.paths).toEqual(["items.2"]);
    expect(changes[1]!.newValues).toEqual({ "items.2": "d" });
  });

  test("reports added and deleted properties", async () => {
    const changes: StateChange[] = [];
    const state = createObservableState({ user: { age: 30 } }, {
      onChange: (change) => changes.push(change),
    });

    // Add property
    (state.user as any).name = "Ada";
    await flushMicrotasks();
    expect(changes[0]!.paths).toEqual(["user.name"]);
    expect(changes[0]!.newValues).toEqual({ "user.name": "Ada" });

    // Delete property — the engine canonical diff reports deletions
    // as JSON null (matching Rust, Go, Kotlin, Swift). TS used to
    // report `undefined`; that was drift, now removed.
    delete (state.user as any).age;
    await flushMicrotasks();
    expect(changes[1]!.paths).toEqual(["user.age"]);
    expect(changes[1]!.newValues).toEqual({ "user.age": null });
  });

  test("batches updates inside batchStateUpdates", async () => {
    const changes: StateChange[] = [];
    const state = createObservableState({ count: 0, nested: { flag: false } }, {
      onChange: (change) => changes.push(change),
    });

    batchStateUpdates(state, () => {
      state.count = 1;
      state.nested.flag = true;
    });

    await flushMicrotasks();

    expect(changes.length).toBe(1);
    expect(changes[0]!.paths.sort()).toEqual(["count", "nested.flag"]);
    expect(changes[0]!.newValues.count).toBe(1);
    expect(changes[0]!.newValues["nested.flag"]).toBe(true);
  });

  test("getStateSnapshot returns a defensive copy", () => {
    const state = createObservableState({ value: 1 }, {
      onChange: () => {},
    });

    const snapshot = getStateSnapshot(state);
    state.value = 2;

    expect(snapshot.value).toBe(1);
    expect(snapshot).not.toBe(state as any);
  });

  test("batchStateUpdates executes without proxy helpers", () => {
    const plain = { value: 0 };
    batchStateUpdates(plain, () => {
      plain.value = 5;
    });

    expect(plain.value).toBe(5);
  });
});

describe("Proxy optimization", () => {
  test("isStateProxy identifies proxied state", () => {
    const state = createObservableState({ value: 1 }, { onChange: () => {} });

    expect(isStateProxy(state)).toBe(true);
    expect(isStateProxy({})).toBe(false);
    expect(isStateProxy(null)).toBe(false);
    expect(isStateProxy(42)).toBe(false);
  });

  test("isStateProxy identifies nested proxied objects", () => {
    const state = createObservableState(
      { nested: { deep: { value: 1 } } },
      { onChange: () => {} }
    );

    expect(isStateProxy(state.nested)).toBe(true);
    expect(isStateProxy(state.nested.deep)).toBe(true);
  });

  test("unwrapProxy returns raw target", () => {
    const original = { value: 1 };
    const state = createObservableState(original, { onChange: () => {} });

    const unwrapped = unwrapProxy(state);
    expect(unwrapped).not.toBe(state);
    expect(unwrapped.value).toBe(1);
  });

  test("unwrapProxy returns non-proxy values as-is", () => {
    const obj = { value: 1 };
    expect(unwrapProxy(obj)).toBe(obj);
    expect(unwrapProxy(42)).toBe(42);
    expect(unwrapProxy(null)).toBe(null);
  });

  test("repeated access returns same proxy instance", () => {
    const state = createObservableState(
      { nested: { value: 1 } },
      { onChange: () => {} }
    );

    // Access the same nested object multiple times
    const access1 = state.nested;
    const access2 = state.nested;
    const access3 = state.nested;

    // Should be the exact same proxy instance
    expect(access1).toBe(access2);
    expect(access2).toBe(access3);
  });

  test("deeply nested repeated access returns same proxy", () => {
    const state = createObservableState(
      { a: { b: { c: { d: 1 } } } },
      { onChange: () => {} }
    );

    // Access deep nested object multiple times
    const path1 = state.a.b.c;
    const path2 = state.a.b.c;

    expect(path1).toBe(path2);
  });

  test("assigning proxy to state unwraps it", async () => {
    const changes: StateChange[] = [];
    const state = createObservableState(
      { source: { value: 1 }, target: null as any },
      { onChange: (c) => changes.push(c) }
    );

    // Assign a nested proxy to another property
    state.target = state.source;
    await flushMicrotasks();

    // The target should have the value, but be unwrapped
    expect(state.target.value).toBe(1);
  });

  test("array items are proxied consistently", () => {
    const state = createObservableState(
      { items: [{ id: 1 }, { id: 2 }] },
      { onChange: () => {} }
    );

    const item1a = state.items[0];
    const item1b = state.items[0];

    expect(item1a).toBe(item1b);
    expect(isStateProxy(item1a)).toBe(true);
  });

  test("new nested objects become proxied on access", async () => {
    const changes: StateChange[] = [];
    const state = createObservableState(
      { data: null as any },
      { onChange: (c) => changes.push(c) }
    );

    // Set a new nested object
    state.data = { nested: { value: 42 } };
    await flushMicrotasks();

    // Access the nested object - should become a proxy
    const nested = state.data.nested;
    expect(isStateProxy(nested)).toBe(true);

    // Mutate through the nested proxy
    nested.value = 100;
    await flushMicrotasks();

    expect(changes.length).toBe(2);
    expect(changes[1]!.paths).toContain("data.nested.value");
  });
});
