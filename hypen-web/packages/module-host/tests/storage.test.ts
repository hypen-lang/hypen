/**
 * Unit tests for the storage backends: the in-memory store, the
 * localStorage-backed store (via a shim installed at call time), and the
 * LocalBucket/CloudBucket WIT-resource surface.
 *
 * Note the default backend is chosen at import time — in bun test there is
 * no localStorage global, so LocalBucket rides the memory backend here. The
 * BrowserLocalStore is tested directly against a shimmed localStorage (its
 * methods read `globalThis.localStorage` at call time).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  BrowserLocalStore,
  CloudBucket,
  LocalBucket,
  LS_PREFIX,
  MemoryLocalStore,
  dumpStores,
} from "../src/storage.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("MemoryLocalStore", () => {
  test("set/get/delete/keys round-trip", () => {
    const store = new MemoryLocalStore();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    store.set("a/b/k", bytes);
    expect(store.get("a/b/k")).toEqual(bytes);
    expect([...store.keys()]).toEqual(["a/b/k"]);
    expect(store.delete("a/b/k")).toBe(true);
    expect(store.delete("a/b/k")).toBe(false);
    expect(store.get("a/b/k")).toBeUndefined();
  });
});

describe("BrowserLocalStore (localStorage shim)", () => {
  const backing = new Map<string, string>();
  const shim = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };

  afterEach(() => {
    backing.clear();
    delete (globalThis as any).localStorage;
  });

  test("bytes round-trip through base64 under the prefix", () => {
    (globalThis as any).localStorage = shim;
    const store = new BrowserLocalStore();
    const payload = new Uint8Array([0, 1, 2, 250, 255, 104, 105]);
    store.set("persistent/counter/blob", payload);

    // It landed in the (shimmed) localStorage, prefixed and base64-encoded.
    const rawKeys = [...backing.keys()];
    expect(rawKeys).toHaveLength(1);
    expect(rawKeys[0]).toBe(`${LS_PREFIX}persistent/counter/blob`);

    expect(store.get("persistent/counter/blob")).toEqual(payload);
  });

  test("keys/delete are prefix-scoped", () => {
    (globalThis as any).localStorage = shim;
    backing.set("unrelated", "x"); // foreign key must never surface
    const store = new BrowserLocalStore();
    store.set("t/ns/a", enc.encode("1"));
    store.set("t/ns/b", enc.encode("2"));

    expect([...store.keys()].sort()).toEqual(["t/ns/a", "t/ns/b"]);
    expect(store.delete("t/ns/a")).toBe(true);
    expect(store.delete("t/ns/a")).toBe(false);
    expect([...store.keys()]).toEqual(["t/ns/b"]);
    expect(backing.has("unrelated")).toBe(true);
  });
});

describe("LocalBucket (memory backend in bun test)", () => {
  test("open/set/get/info/namespace isolation/clear", () => {
    const bucket = LocalBucket.open("persistent", "counter");
    const other = LocalBucket.open("persistent", "other");

    const payload = new Uint8Array([1, 2, 3]);
    bucket.set("blob", payload);
    bucket.set("a", enc.encode("1"));
    other.set("a", enc.encode("2"));

    expect(bucket.get("blob")).toEqual(payload);
    expect(dec.decode(other.get("a")!)).toBe("2");

    const keys = bucket.keys("", 10);
    expect(keys.sort()).toEqual(["a", "blob"]);
    expect(keys.some((k) => k.includes("other"))).toBe(false);

    const info = bucket.info("blob")!;
    expect(info.size).toBe(3n);
    expect(info.version).toBeUndefined();
    expect(bucket.info("missing")).toBeUndefined();

    expect(bucket.delete("a")).toBe(true);
    expect(bucket.get("a")).toBeUndefined();

    bucket.clear();
    expect(bucket.get("blob")).toBeUndefined();
    // clear is namespace-scoped.
    expect(other.get("a")).not.toBeUndefined();
  });

  test("keys() respects the limit", () => {
    const bucket = LocalBucket.open("persistent", "limited");
    for (let i = 0; i < 5; i++) bucket.set(`k${i}`, enc.encode(String(i)));
    expect(bucket.keys("", 3)).toHaveLength(3);
  });

  test("dumpStores exposes decoded local values", () => {
    const bucket = LocalBucket.open("persistent", "dump");
    bucket.set("greeting", enc.encode("hello"));
    const dump = dumpStores();
    expect(dump.local["persistent/dump/greeting"]).toBe("hello");
  });
});

describe("CloudBucket", () => {
  test("versions are monotonic per key and surfaced via info()", () => {
    const bucket = CloudBucket.open("synced", "todo");
    bucket.set("list", enc.encode("[]"));
    expect(bucket.info("list")!.version).toBe(1n);
    bucket.set("list", enc.encode("[1]"));
    expect(bucket.info("list")!.version).toBe(2n);
    expect(dec.decode(bucket.get("list")!)).toBe("[1]");
  });

  test("compareAndSet succeeds on matching version and bumps it", () => {
    const bucket = CloudBucket.open("synced", "cas-ok");
    bucket.set("k", enc.encode("v1")); // version 1
    const next = bucket.compareAndSet("k", 1n, enc.encode("v2"));
    expect(next).toBe(2n);
    expect(dec.decode(bucket.get("k")!)).toBe("v2");
    // undefined expected-version means "create only".
    const first = bucket.compareAndSet("fresh", undefined, enc.encode("v0"));
    expect(first).toBe(1n);
  });

  test("compareAndSet throws unavailable on version mismatch", () => {
    const bucket = CloudBucket.open("synced", "cas-bad");
    bucket.set("k", enc.encode("v1")); // version 1
    let err: any = null;
    try {
      bucket.compareAndSet("k", 7n, enc.encode("v2"));
    } catch (e) {
      err = e;
    }
    expect(err).toEqual({ tag: "unavailable", val: "version mismatch" });
    // And the value is untouched.
    expect(dec.decode(bucket.get("k")!)).toBe("v1");
  });

  test("delete + dumpStores cloud view", () => {
    const bucket = CloudBucket.open("synced", "dump");
    bucket.set("k", enc.encode("v"));
    const dump = dumpStores();
    expect(dump.cloud["synced/dump/k"]).toEqual({ value: "v", version: "1" });
    expect(bucket.delete("k")).toBe(true);
    expect(bucket.delete("k")).toBe(false);
  });
});
