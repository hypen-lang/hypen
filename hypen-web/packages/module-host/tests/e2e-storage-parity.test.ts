/**
 * End-to-end storage parity with the native wasmtime host: drives the REAL
 * limits_module.wasm fixture — the same probe module and the same calls as
 * hypen-engine-rs/tests/test_module_host.rs (storage_writes_are_bounded_by_
 * quota, default_quota_caps_values_at_one_mebibyte, the kv-leak bound, the
 * namespace bound) — through the jco pipeline, and expects the native
 * results, down to the exact `quota-exceeded` byte counts.
 *
 * limits_module answers every probe through its state: "ok", "none",
 * "some:<value>", "quota-exceeded:<n>", or the Debug form of a storage error.
 * Probe payload fields are separated by U+001F.
 */

import { describe, expect, test } from "bun:test";
import { JsModuleHost, MemoryStorageBackend, entryCost, type JsModuleHostOptions } from "../src/index.ts";
import { hasFixture, readFixture } from "./_fixtures.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const FIXTURE = "limits_module.wasm";
const missing = !hasFixture(FIXTURE);

const manifest = (name: string) => ({ name, version: "1.0.0", storage: ["local", "app"], reads: [], dispatches: [], http: false });

async function probeHost(names: string[], options: JsModuleHostOptions = {}) {
  const host = new JsModuleHost({ storage: new MemoryStorageBackend(), ...options });
  const bytes = readFixture(FIXTURE);
  const ids: Record<string, number> = {};
  for (const name of names) {
    await host.prepare(name, bytes, manifest(name));
    ids[name] = host.instantiate(name);
    host.init(ids[name]!, enc.encode("{}"));
  }
  const call = (name: string, action: string, ...fields: string[]): string => {
    const out = host.dispatch(ids[name]!, enc.encode("{}"), { name: action, payload: enc.encode(fields.join("\u001f")) }, []);
    return dec.decode(out.state!);
  };
  return { host, ids, call };
}

describe.skipIf(missing)("storage parity with the native host (limits_module.wasm)", () => {
  test("storage_writes_are_bounded_by_quota: same results, same bytes-over", async () => {
    const { call } = await probeHost(["a", "b"], { quotas: { maxValueBytes: 1000, maxPartitionBytes: 2500 } });
    // Per-value cap.
    expect(call("a", "kv-fill", "local", "n", "big", "1001")).toBe("quota-exceeded:1");
    expect(call("a", "kv-get", "local", "n", "big")).toBe("none");
    // Partition budget: two 1000-byte values fit, the third does not. Each
    // costs 1000 + "persistent/1:nk1" (16) bytes, so the third is over by
    // 3 × 1016 - 2500 = 548 — the native host's exact answer.
    expect(entryCost("persistent", "n", "k1", 1000)).toBe(1016);
    expect(call("a", "kv-fill", "local", "n", "k1", "1000")).toBe("ok");
    expect(call("a", "kv-fill", "local", "n", "k2", "1000")).toBe("ok");
    expect(call("a", "kv-fill", "local", "n", "k3", "1000")).toBe("quota-exceeded:548");
    expect(call("a", "kv-get", "local", "n", "k3")).toBe("none");
    // Overwriting in place stays within budget.
    expect(call("a", "kv-fill", "local", "n", "k1", "900")).toBe("ok");
    // B has its own local budget; app has its own...
    expect(call("b", "kv-fill", "local", "n", "k1", "1000")).toBe("ok");
    expect(call("a", "kv-fill", "app", "n", "k1", "1000")).toBe("ok");
    // ...which is ONE budget for the whole app, whoever writes.
    expect(call("b", "kv-fill", "app", "n", "k2", "1000")).toBe("ok");
    expect(call("b", "kv-fill", "app", "n", "k3", "1000")).toBe("quota-exceeded:548");
    expect(call("a", "kv-fill", "app", "n", "k3", "1000")).toBe("quota-exceeded:548");
  }, 60_000);

  test("default_quota_caps_values_at_one_mebibyte", async () => {
    const { call } = await probeHost(["m"]);
    expect(call("m", "kv-fill", "local", "n", "k", "1048576")).toBe("ok");
    expect(call("m", "kv-fill", "local", "n", "k2", "1048577")).toBe("quota-exceeded:1");
  }, 60_000);

  test("bucket handles: dropped handles are released, leaked ones are bounded at 256", async () => {
    const { host, call } = await probeHost(["m"]);
    // Every kv-* probe opens a bucket and drops it: jco's resource drop
    // reaches the host (Symbol.dispose), so hundreds of probes never pile up.
    for (let i = 0; i < 300; i++) expect(call("m", "kv-set", "local", "ns", `k${i}`, "v")).toBe("ok");
    const reply = call("m", "kv-leak", "1000");
    expect(reply.startsWith("256/1000 ")).toBe(true);
    expect(reply).toContain("too many open buckets");
    // The leaked handles stay with the component instance.
    expect(call("m", "kv-set", "local", "ns", "k", "v")).toContain("too many open buckets");
    // Known difference: native gives every instantiate() a fresh store (and
    // budget); here instances of one prepared name share one component
    // instantiation, so only a fresh prepare() starts over.
    await host.prepare("m", readFixture(FIXTURE), manifest("m"));
    const fresh = host.instantiate("m");
    host.init(fresh, enc.encode("{}"));
    const out = host.dispatch(fresh, enc.encode("{}"), { name: "kv-set", payload: enc.encode("local\u001fns\u001fk\u001fv") }, []);
    expect(dec.decode(out.state!)).toBe("ok");
  }, 60_000);

  test("namespaces over 4 KiB are refused like the native host", async () => {
    const { call } = await probeHost(["m"]);
    expect(call("m", "kv-set", "local", "n".repeat(4096), "k", "v")).toBe("ok");
    expect(call("m", "kv-set", "local", "n".repeat(4097), "k", "v")).toBe(
      'Error::Unavailable("namespace of 4097 bytes exceeds the 4096-byte limit")',
    );
  }, 60_000);

  test("keys / info / clear answer like the native host", async () => {
    const { call } = await probeHost(["a", "b"]);
    for (const key of ["user/2", "user/1", "theme"]) expect(call("a", "kv-set", "local", "prefs", key, "v")).toBe("ok");
    expect(call("a", "kv-set", "local", "other", "user/9", "v")).toBe("ok");
    expect(call("b", "kv-set", "local", "prefs", "user/7", "v")).toBe("ok");
    expect(call("a", "kv-set", "app", "prefs", "shared", "value")).toBe("ok");
    expect(call("a", "kv-keys", "local", "prefs", "", "10")).toBe("theme,user/1,user/2");
    expect(call("a", "kv-keys", "local", "prefs", "user/", "1")).toBe("user/1");
    expect(call("a", "kv-info", "local", "prefs", "theme")).toBe("size:1,version:none");
    expect(call("b", "kv-info", "app", "prefs", "shared")).toBe("size:5,version:none");
    expect(call("a", "kv-info", "local", "prefs", "missing")).toBe("none");
    expect(call("a", "kv-clear", "local", "prefs")).toBe("ok");
    expect(call("a", "kv-keys", "local", "prefs", "", "10")).toBe("");
    expect(call("a", "kv-keys", "local", "other", "", "10")).toBe("user/9");
    expect(call("b", "kv-keys", "local", "prefs", "", "10")).toBe("user/7");
  }, 60_000);
});
