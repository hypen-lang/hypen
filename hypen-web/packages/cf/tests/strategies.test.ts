import { describe, test, expect } from "bun:test";
import {
  global,
  session,
  withKey,
  durableObjectStore,
  type DurableObjectStorage,
} from "../src/index.js";

function createMockStorage(): DurableObjectStorage & {
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      return data.delete(key);
    },
  };
}

describe("KeyStrategy", () => {
  describe("global()", () => {
    test("resolveKey returns global:{moduleName} regardless of state/session", () => {
      const strategy = global();
      expect(strategy.resolve({ foo: 1 }, "Chat", "sess-123")).toBe(
        "global:Chat",
      );
      expect(strategy.resolve(null, "Counter", "sess-456")).toBe(
        "global:Counter",
      );
      expect(strategy.type).toBe("global");
    });
  });

  describe("session()", () => {
    test("resolveKey returns session:{sessionId} regardless of state", () => {
      const strategy = session();
      expect(strategy.resolve({ foo: 1 }, "Editor", "sess-abc")).toBe(
        "session:sess-abc",
      );
      expect(strategy.resolve(null, "Other", "sess-xyz")).toBe(
        "session:sess-xyz",
      );
      expect(strategy.type).toBe("session");
    });
  });

  describe("withKey(fn)", () => {
    test("resolveKey returns fn(state), or null when fn returns null/undefined", () => {
      const strategy = withKey<{ userId?: string | null }>(
        (state) => state.userId,
      );
      expect(strategy.resolve({ userId: "u-42" }, "App", "sess-1")).toBe(
        "u-42",
      );
      expect(strategy.resolve({ userId: null }, "App", "sess-1")).toBeNull();
      expect(strategy.resolve({}, "App", "sess-1")).toBeNull();
      expect(strategy.type).toBe("withKey");
    });

    test("key changes when state changes", () => {
      const strategy = withKey<{ userId?: string }>((state) => state.userId);
      expect(strategy.resolve({ userId: "u-1" }, "App", "s")).toBe("u-1");
      expect(strategy.resolve({ userId: "u-2" }, "App", "s")).toBe("u-2");
    });
  });
});

describe("durableObjectStore", () => {
  test("throws if storage not bound", async () => {
    const store = durableObjectStore(global());
    expect(() => store.load("key")).toThrow(
      "DurableObject storage not bound",
    );
    expect(() => store.save("key", {})).toThrow(
      "DurableObject storage not bound",
    );
    expect(() => store.delete("key")).toThrow(
      "DurableObject storage not bound",
    );
  });

  test("load/save/delete delegate to bound storage with hypen: prefix", async () => {
    const store = durableObjectStore<{ count: number }>(global());
    const mock = createMockStorage();
    store.__bindStorage(mock);

    await store.save("global:Counter", { count: 5 });
    expect(mock.data.get("hypen:global:Counter")).toEqual({ count: 5 });

    const loaded = await store.load("global:Counter");
    expect(loaded).toEqual({ count: 5 });

    await store.delete("global:Counter");
    expect(mock.data.has("hypen:global:Counter")).toBe(false);
  });

  test("load returns null for missing keys", async () => {
    const store = durableObjectStore(global());
    const mock = createMockStorage();
    store.__bindStorage(mock);

    const result = await store.load("nonexistent");
    expect(result).toBeNull();
  });

  test("resolveKey uses strategy", () => {
    const store = durableObjectStore<{ id?: string }>(
      withKey((state) => state.id),
    );
    const mock = createMockStorage();
    store.__bindStorage(mock);

    expect(store.resolveKey({ id: "abc" }, "Mod", "sess")).toBe("abc");
    expect(store.resolveKey({}, "Mod", "sess")).toBeNull();
  });
});
