/**
 * End-to-end: the runtime jco pipeline against the REAL counter_module.wasm
 * fixture — register, `await prepare()` (in-memory bindgen -> compile ->
 * instantiate against the gated import map), then the synchronous host
 * surface exactly as the Rust BridgedHost drives it. Also covers the
 * link-time storage gate and module-private, persistent `local` storage.
 *
 * counter_module: `increment` bumps state.count, persists it to
 * hypen:storage/local and emits a log effect; `sync` writes to
 * hypen:storage/cloud via compare-and-set. It imports local + cloud.
 */

import { describe, expect, test } from "bun:test";
import {
  JsModuleHost,
  LocalStorageBackend,
  MemoryStorageBackend,
  type ModuleManifest,
  type StorageLike,
} from "../src/index.ts";
import { hasFixture, readFixture } from "./_fixtures.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const FIXTURE = "counter_module.wasm";
const missing = !hasFixture(FIXTURE);

const manifest: ModuleManifest = {
  name: "counter",
  version: "1.0.0",
  storage: ["local", "cloud"],
  reads: [],
  dispatches: [],
  http: false,
};

const count = (state: Uint8Array): number => JSON.parse(dec.decode(state)).count;

function increment(host: JsModuleHost, id: number, state: Uint8Array): Uint8Array {
  const out = host.dispatch(id, state, { name: "increment", payload: enc.encode("{}") }, []);
  expect(out.effects.some((e) => e.tag === "log")).toBe(true);
  return out.state ?? state;
}

describe.skipIf(missing)("runtime transpile pipeline (counter_module.wasm)", () => {
  test("register -> prepare -> instantiate/init/dispatch/actions", async () => {
    const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
    host.register("counter", readFixture(FIXTURE), manifest);
    // The async transpile work belongs to prepare(), not register().
    expect(() => host.instantiate("counter")).toThrow(/not prepared/);

    await host.prepare("counter");

    const id = host.instantiate("counter");
    expect(typeof id).toBe("number");
    const actions = host.actions(id);
    expect(actions).toContain("increment");
    expect(actions).toContain("sync");

    let state = host.init(id, enc.encode("{}"));
    expect(count(state)).toBe(0);
    for (let i = 1; i <= 3; i++) {
      state = increment(host, id, state);
      expect(count(state)).toBe(i);
    }

    // A second instance of the same prepared component: the counter
    // persisted to hypen:storage/local, so a warm init reads 3 back.
    const id2 = host.instantiate("counter");
    expect(id2).not.toBe(id);
    expect(count(host.init(id2, enc.encode("{}")))).toBe(3);

    // `sync` exercises the granted cloud compare-and-set path.
    const synced = host.dispatch(id, state, { name: "sync", payload: enc.encode("{}") }, []);
    expect(synced.effects.every((e) => e.tag !== "log" || !/err/i.test(String(e.message)))).toBe(true);
    const cloudEntries = Object.entries(host.storage.dump()).filter(([k]) => k.startsWith("cloud/"));
    expect(cloudEntries.length).toBeGreaterThan(0);
    expect(cloudEntries[0]![1].version).toBeGreaterThanOrEqual(1);

    host.destroy(id2);
    host.destroy(id);
    expect(() => host.actions(id)).toThrow(/dead instance/);
  }, 60_000);

  test("an ungranted storage scope fails prepare() at link time", async () => {
    const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
    // counter imports hypen:storage/cloud; omitting the grant must fail.
    const err = await host
      .prepare("counter", readFixture(FIXTURE), { ...manifest, storage: ["local"] })
      .then(() => null, (e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(/storage scope denied.*hypen:storage\/cloud.*'cloud'/);
    expect(() => host.instantiate("counter")).toThrow(/not prepared/);

    // Omitted storage is equally deny-by-default.
    const err2 = await new JsModuleHost()
      .prepare("counter", readFixture(FIXTURE), { name: "counter" })
      .then(() => null, (e: unknown) => e);
    expect(String((err2 as Error)?.message)).toMatch(/storage scope denied/);
  }, 60_000);

  test("local storage is module-private and isolated per host", async () => {
    const backend = new MemoryStorageBackend();
    const host = new JsModuleHost({ storage: backend });
    const bytes = readFixture(FIXTURE);
    await host.prepare("counter", bytes, manifest);
    await host.prepare("other", bytes, { ...manifest, name: "other" });

    const a = host.instantiate("counter");
    let s = host.init(a, enc.encode("{}"));
    s = increment(host, a, s);
    s = increment(host, a, s);

    // Same component, different registered name: its own local keyspace.
    const b = host.instantiate("other");
    expect(count(host.init(b, enc.encode("{}")))).toBe(0);
    // Same name on a second host with its own (default) backend: isolated.
    const host2 = new JsModuleHost({ storage: new MemoryStorageBackend() });
    await host2.prepare("counter", bytes, manifest);
    expect(count(host2.init(host2.instantiate("counter"), enc.encode("{}")))).toBe(0);
    // ...while a fresh instance on the original host warm-starts at 2.
    expect(count(host.init(host.instantiate("counter"), enc.encode("{}")))).toBe(2);
  }, 60_000);

  test("localStorage-backed local storage survives a host restart (page reload)", async () => {
    const backing = new Map<string, string>();
    const ls: StorageLike = {
      getItem: (k) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k, v) => void backing.set(k, String(v)),
      removeItem: (k) => void backing.delete(k),
      key: (i) => [...backing.keys()][i] ?? null,
      get length() {
        return backing.size;
      },
    };
    const bytes = readFixture(FIXTURE);

    const first = new JsModuleHost({ storage: new LocalStorageBackend(ls) });
    await first.prepare("counter", bytes, manifest);
    const id = first.instantiate("counter");
    let s = first.init(id, enc.encode("{}"));
    for (let i = 0; i < 4; i++) s = increment(first, id, s);
    expect([...backing.keys()].every((k) => k.startsWith("hypen-storage:v1/"))).toBe(true);
    expect(backing.size).toBeGreaterThan(0);

    const reloaded = new JsModuleHost({ storage: new LocalStorageBackend(ls) });
    await reloaded.prepare("counter", bytes, manifest);
    expect(count(reloaded.init(reloaded.instantiate("counter"), enc.encode("{}")))).toBe(4);
  }, 60_000);
});
