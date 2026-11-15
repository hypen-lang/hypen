/**
 * Unit tests for the storage layer: backends (in-memory, localStorage via a
 * shim), HostStorage policy (scope isolation, unambiguous keys, metadata,
 * quotas) and the jco-shaped bucket resources from createStorageImports.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STORAGE_QUOTAS,
  HostStorage,
  JsModuleHost,
  LS_PREFIX,
  LocalStorageBackend,
  MemoryStorageBackend,
  createStorageImports,
  defaultStorageBackend,
  type StorageLike,
} from "../src/index.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function catchThrown(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

function fakeLocalStorage(): { shim: StorageLike; backing: Map<string, string> } {
  const backing = new Map<string, string>();
  const shim: StorageLike = {
    getItem: (k) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k, v) => void backing.set(k, String(v)),
    removeItem: (k) => void backing.delete(k),
    key: (i) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
  return { shim, backing };
}

/** Bucket classes for `module` over a fresh in-memory HostStorage. */
function imports(module: string, storage = new HostStorage({ storage: new MemoryStorageBackend() })) {
  return { storage, ...createStorageImports(storage, module) };
}

describe("backends", () => {
  test("MemoryStorageBackend round-trips and copies on write", () => {
    const store = new MemoryStorageBackend();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    store.set("k", bytes);
    bytes[0] = 99;
    expect(store.get("k")).toEqual(new Uint8Array([0, 1, 2, 250, 255]));
    expect([...store.keys()]).toEqual(["k"]);
    expect(store.delete("k")).toBe(true);
    expect(store.delete("k")).toBe(false);
  });

  test("LocalStorageBackend base64-encodes under its prefix and ignores foreign keys", () => {
    const { shim, backing } = fakeLocalStorage();
    backing.set("unrelated", "x");
    const store = new LocalStorageBackend(shim);
    const payload = new Uint8Array([0, 1, 2, 250, 255, 104, 105]);
    store.set("a", payload);
    expect(backing.has(`${LS_PREFIX}a`)).toBe(true);
    expect(store.get("a")).toEqual(payload);
    expect([...store.keys()]).toEqual(["a"]);
    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
    expect(backing.has("unrelated")).toBe(true);
  });

  test("defaultStorageBackend picks localStorage when present, at call time", () => {
    expect(defaultStorageBackend()).toBeInstanceOf(MemoryStorageBackend);
    const { shim } = fakeLocalStorage();
    (globalThis as any).localStorage = shim;
    try {
      expect(defaultStorageBackend()).toBeInstanceOf(LocalStorageBackend);
    } finally {
      delete (globalThis as any).localStorage;
    }
  });

  test("hosts get independent default backends", () => {
    const a = new JsModuleHost();
    const b = new JsModuleHost();
    expect(a.storage.plain).not.toBe(b.storage.plain);
    expect(a.storage.cloud).not.toBe(b.storage.cloud);
  });

  test("an injected backend is used as-is", () => {
    const backend = new MemoryStorageBackend();
    const host = new JsModuleHost({ storage: backend });
    expect(host.storage.plain).toBe(backend);
  });
});

describe("local scope", () => {
  test("set/get/info/keys/delete/clear", () => {
    let now = 1_700_000_000_000;
    const storage = new HostStorage({ storage: new MemoryStorageBackend(), now: () => now });
    const { local } = createStorageImports(storage, "counter");
    const bucket = local.Bucket.open("persistent", "prefs");

    bucket.set("blob", new Uint8Array([1, 2, 3]));
    now += 5;
    bucket.set("a", enc.encode("1"));
    expect(bucket.get("blob")).toEqual(new Uint8Array([1, 2, 3]));
    expect(bucket.get("missing")).toBeUndefined();

    const info = bucket.info("blob")!;
    expect(info.size).toBe(3n);
    expect(info.modifiedMs).toBe(1_700_000_000_000n);
    expect(info.version).toBeUndefined();
    expect(bucket.info("a")!.modifiedMs).toBe(1_700_000_000_005n);
    expect(bucket.info("missing")).toBeUndefined();

    expect(bucket.keys("", 10)).toEqual(["a", "blob"]);
    expect(bucket.keys("b", 10)).toEqual(["blob"]);
    expect(bucket.keys("", 1)).toEqual(["a"]);
    expect(bucket.keys("", 0)).toEqual([]);

    expect(bucket.delete("a")).toBe(true);
    expect(bucket.delete("a")).toBe(false);
    bucket.clear();
    expect(bucket.get("blob")).toBeUndefined();
  });

  test("is module-private: same tier/namespace/key, different modules", () => {
    const storage = new HostStorage({ storage: new MemoryStorageBackend() });
    const a = createStorageImports(storage, "a").local.Bucket.open("persistent", "ns");
    const b = createStorageImports(storage, "b").local.Bucket.open("persistent", "ns");
    a.set("secret", enc.encode("from-a"));
    expect(b.get("secret")).toBeUndefined();
    expect(b.keys("", 10)).toEqual([]);
    b.clear();
    expect(dec.decode(a.get("secret")!)).toBe("from-a");
  });

  test("namespaces and tiers are isolated and clear is bucket-scoped", () => {
    const { local } = imports("m");
    const one = local.Bucket.open("persistent", "one");
    const two = local.Bucket.open("persistent", "two");
    const cache = local.Bucket.open("cache", "one");
    one.set("k", enc.encode("1"));
    two.set("k", enc.encode("2"));
    cache.set("k", enc.encode("3"));
    one.clear();
    expect(one.get("k")).toBeUndefined();
    expect(dec.decode(two.get("k")!)).toBe("2");
    expect(dec.decode(cache.get("k")!)).toBe("3");
  });

  test("composite keys are unambiguous ('/' and ':' in parts cannot collide)", () => {
    const { local } = imports("m");
    const x = local.Bucket.open("persistent", "a/b");
    const y = local.Bucket.open("persistent", "a");
    x.set("c", enc.encode("x"));
    y.set("b/c", enc.encode("y"));
    expect(dec.decode(x.get("c")!)).toBe("x");
    expect(dec.decode(y.get("b/c")!)).toBe("y");
    expect(x.keys("", 10)).toEqual(["c"]);
    expect(y.keys("", 10)).toEqual(["b/c"]);

    const p = local.Bucket.open("persistent", "1:x");
    const q = local.Bucket.open("persistent", "1");
    p.set("k", enc.encode("p"));
    q.set(":x1:k", enc.encode("q"));
    expect(dec.decode(p.get("k")!)).toBe("p");
    expect(q.keys("", 10)).toEqual([":x1:k"]);
  });

  test("module names cannot alias each other's local scope", () => {
    const storage = new HostStorage({ storage: new MemoryStorageBackend() });
    const ab = createStorageImports(storage, "a/b").local.Bucket.open("persistent", "c");
    const a = createStorageImports(storage, "a").local.Bucket.open("persistent", "b/c");
    ab.set("k", enc.encode("1"));
    expect(a.get("k")).toBeUndefined();
  });

  test("persists through a LocalStorageBackend across host instances", () => {
    const { shim } = fakeLocalStorage();
    const first = new HostStorage({ storage: new LocalStorageBackend(shim) });
    createStorageImports(first, "counter").local.Bucket.open("persistent", "c").set("n", enc.encode("3"));
    const second = new HostStorage({ storage: new LocalStorageBackend(shim) });
    const bucket = createStorageImports(second, "counter").local.Bucket.open("persistent", "c");
    expect(dec.decode(bucket.get("n")!)).toBe("3");
  });

  test("backend failures surface as the WIT backend error", () => {
    const broken = new MemoryStorageBackend();
    broken.set = () => {
      throw new Error("disk on fire");
    };
    const bucket = createStorageImports(new HostStorage({ storage: broken }), "m").local.Bucket.open(
      "persistent",
      "ns",
    );
    expect(catchThrown(() => bucket.set("k", enc.encode("v")))).toEqual({
      tag: "backend",
      val: "Error: disk on fire",
    });
  });
});

describe("app scope", () => {
  test("is shared between the app's modules", () => {
    const storage = new HostStorage({ storage: new MemoryStorageBackend() });
    const a = createStorageImports(storage, "a").app.Bucket.open("persistent", "shared");
    const b = createStorageImports(storage, "b").app.Bucket.open("persistent", "shared");
    a.set("theme", enc.encode("dark"));
    expect(dec.decode(b.get("theme")!)).toBe("dark");
  });

  test("does not overlap with local", () => {
    const { local, app } = imports("m");
    local.Bucket.open("persistent", "ns").set("k", enc.encode("local"));
    expect(app.Bucket.open("persistent", "ns").get("k")).toBeUndefined();
  });
});

describe("quotas", () => {
  test("values over maxValueBytes are rejected with quota-exceeded(bytes over)", () => {
    const { local } = imports("m");
    const bucket = local.Bucket.open("persistent", "ns");
    const big = new Uint8Array(DEFAULT_STORAGE_QUOTAS.maxValueBytes + 10);
    expect(catchThrown(() => bucket.set("k", big))).toEqual({ tag: "quota-exceeded", val: 10n });
    expect(bucket.get("k")).toBeUndefined();
  });

  test("per-module per-scope total, counting value + key bytes, with overwrite credit", () => {
    const storage = new HostStorage({
      storage: new MemoryStorageBackend(),
      quotas: { maxValueBytes: 100, maxBytesPerModulePerScope: 100 },
    });
    const bucket = createStorageImports(storage, "m").local.Bucket.open("persistent", "ns");
    bucket.set("a", new Uint8Array(49)); // 50
    bucket.set("b", new Uint8Array(49)); // 100
    expect(storage.usage("local", "m")).toBe(100);
    expect(catchThrown(() => bucket.set("c", new Uint8Array(0)))).toEqual({
      tag: "quota-exceeded",
      val: 1n,
    });
    // Overwriting reuses the old entry's budget.
    bucket.set("a", new Uint8Array(49));
    bucket.delete("b");
    bucket.set("c", new Uint8Array(10));
    expect(storage.usage("local", "m")).toBe(61);
  });

  test("shared scopes charge the writing module, separately per scope", () => {
    const storage = new HostStorage({
      storage: new MemoryStorageBackend(),
      quotas: { maxValueBytes: 100, maxBytesPerModulePerScope: 50 },
    });
    const a = createStorageImports(storage, "a");
    const b = createStorageImports(storage, "b");
    a.app.Bucket.open("persistent", "s").set("x", new Uint8Array(49));
    // b has its own budget in the same shared scope
    b.app.Bucket.open("persistent", "s").set("y", new Uint8Array(49));
    // and a's local budget is untouched by its app usage
    a.local.Bucket.open("persistent", "s").set("x", new Uint8Array(49));
    expect(storage.usage("app", "a")).toBe(50);
    expect(storage.usage("app", "b")).toBe(50);
    expect(storage.usage("local", "a")).toBe(50);
  });
});

describe("cloud scope (in-memory stand-in)", () => {
  test("versions are monotonic per key, info reports version and modified time", () => {
    let now = 1000;
    const storage = new HostStorage({ storage: new MemoryStorageBackend(), now: () => now });
    const bucket = createStorageImports(storage, "m").cloud.Bucket.open("persistent", "todo");
    bucket.set("list", enc.encode("[]"));
    expect(bucket.info("list")).toEqual({ size: 2n, modifiedMs: 1000n, version: 1n });
    now = 2000;
    bucket.set("list", enc.encode("[1]"));
    expect(bucket.info("list")).toEqual({ size: 3n, modifiedMs: 2000n, version: 2n });
    expect(dec.decode(bucket.get("list")!)).toBe("[1]");
  });

  test("compareAndSet: none = must not exist; some(N) = exact version; returns previous + 1", () => {
    const bucket = imports("m").cloud.Bucket.open("persistent", "cas");
    expect(bucket.compareAndSet("k", undefined, enc.encode("v1"))).toBe(1n);
    expect(catchThrown(() => bucket.compareAndSet("k", undefined, enc.encode("x")))).toEqual({
      tag: "unavailable",
      val: "version mismatch",
    });
    expect(bucket.compareAndSet("k", 1n, enc.encode("v2"))).toBe(2n);
    expect(catchThrown(() => bucket.compareAndSet("k", 1n, enc.encode("x")))).toEqual({
      tag: "unavailable",
      val: "version mismatch",
    });
    expect(catchThrown(() => bucket.compareAndSet("missing", 1n, enc.encode("x")))).toEqual({
      tag: "unavailable",
      val: "version mismatch",
    });
    expect(dec.decode(bucket.get("k")!)).toBe("v2");
    bucket.set("k", enc.encode("v3"));
    expect(bucket.compareAndSet("k", 3n, enc.encode("v4"))).toBe(4n);
  });

  test("is shared across modules, kept apart from app, and has no clear", () => {
    const storage = new HostStorage({ storage: new MemoryStorageBackend() });
    const a = createStorageImports(storage, "a");
    const b = createStorageImports(storage, "b");
    a.cloud.Bucket.open("persistent", "s").set("k", enc.encode("v"));
    expect(dec.decode(b.cloud.Bucket.open("persistent", "s").get("k")!)).toBe("v");
    expect(a.app.Bucket.open("persistent", "s").get("k")).toBeUndefined();
    expect("clear" in a.cloud.Bucket.open("persistent", "s")).toBe(false);
  });

  test("defaults to an in-memory backend even when local rides localStorage", () => {
    const { shim, backing } = fakeLocalStorage();
    const storage = new HostStorage({ storage: new LocalStorageBackend(shim) });
    createStorageImports(storage, "m").cloud.Bucket.open("persistent", "s").set("k", enc.encode("v"));
    expect(backing.size).toBe(0);
    expect(storage.cloud).toBeInstanceOf(MemoryStorageBackend);
  });
});

describe("blob resources", () => {
  test("are unimplemented stubs failing with unavailable", () => {
    const { local } = imports("m");
    expect(catchThrown(() => local.BlobBucket.open("persistent", "ns"))).toEqual({
      tag: "unavailable",
      val: "blob storage is not implemented by this host",
    });
  });
});

describe("dump", () => {
  test("lists entries with a readable path", () => {
    const { storage, local, cloud } = imports("counter");
    local.Bucket.open("persistent", "ns").set("greeting", enc.encode("hello"));
    cloud.Bucket.open("persistent", "ns").set("k", enc.encode("v"));
    const dump = storage.dump();
    expect(dump["local/counter/persistent/ns/greeting"]).toEqual({ value: "hello", writer: "counter" });
    expect(dump["cloud//persistent/ns/k"]).toEqual({ value: "v", version: 1, writer: "counter" });
  });
});
