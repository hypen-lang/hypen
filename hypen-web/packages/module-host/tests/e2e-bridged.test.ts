/**
 * End-to-end: the engine's Rust BridgedHost (inside engine.wasm) driving this
 * package's JsModuleHost, which drives a jco-loaded component:
 *
 *   test -> engine.wasm (WasmHostedEngine) -> BridgedHost (Rust)
 *        -> JsModuleHost (this package) -> counter component (wasm)
 *
 * Needs a Node-target wasm-pack build of the engine with the bridged module
 * loader, which this suite does NOT build (slow, large). Skipped unless
 * present. To build it (from the repo root):
 *
 *   cd hypen-engine-rs && wasm-pack build --target nodejs \
 *     --out-dir pkg-bridged --features module-loader-bridged
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { JsModuleHost, MemoryStorageBackend, type ModuleManifest } from "../src/index.ts";
import { REPO_ROOT, hasFixture, readFixture } from "./_fixtures.ts";

const enc = new TextEncoder();
const ENGINE_JS = resolve(REPO_ROOT, "hypen-engine-rs", "pkg-bridged", "hypen_engine.js");
const FIXTURE = "counter_module.wasm";
const skip = !existsSync(ENGINE_JS) || !hasFixture(FIXTURE);

describe.skipIf(skip)("BridgedHost round-trip (engine.wasm -> JsModuleHost)", () => {
  test("register/instantiate/dispatch and subscribe flow through the bridge", async () => {
    const { WasmHostedEngine } = await import(ENGINE_JS);
    const manifest: ModuleManifest = {
      name: "counter",
      version: "1.0.0",
      storage: ["local", "cloud"],
      reads: [],
      dispatches: [],
      // Explicit: the Rust ModuleManifest still defaults an omitted `http`
      // to true when it deserialises this object.
      http: false,
    };

    const engine = new WasmHostedEngine();
    const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
    // The async half up front; the engine's later register() (empty bytes)
    // keeps these prepared bindings.
    await host.prepare("counter", readFixture(FIXTURE), manifest);

    // Observe what the engine drives through the host, and inject a
    // subscribe request into one output (the counter targets world `module`
    // and cannot import hypen:engine/state itself).
    const seen: string[] = [];
    let inject: { module: string; path: string; onChange: string } | null = null;
    const raw = host.dispatch.bind(host);
    host.dispatch = (id, state, action, siblings) => {
      seen.push(action.name);
      const out = raw(id, state, action, siblings);
      if (inject) {
        out.subscribeRequests.push(inject);
        inject = null;
      }
      return out;
    };

    engine.setModuleHost(host);
    // null actions => discovered from the module's own `actions` export.
    engine.registerAndInstantiate("counter", new Uint8Array(0), manifest, null, enc.encode("{}"));
    expect(engine.getModuleState("counter")?.count).toBe(0);

    engine.dispatchAction("increment", {});
    engine.dispatchAction("increment", {});
    engine.dispatchAction("increment", {});
    expect(engine.getModuleState("counter")?.count).toBe(3);

    // Self-subscription: when counter.count changes, re-dispatch `sync`.
    inject = { module: "counter", path: "count", onChange: "sync" };
    engine.dispatchAction("increment", {}); // registers the sub (never self-fires)
    const before = seen.length;
    engine.dispatchAction("increment", {}); // this change fires it
    expect(engine.getModuleState("counter")?.count).toBe(5);
    expect(seen.slice(before)).toContain("sync");
  }, 60_000);
});
