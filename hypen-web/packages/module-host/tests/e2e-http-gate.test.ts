/**
 * End-to-end: the wasi:http egress gate against the REAL fetcher_module.wasm
 * fixture (the same one the native tests use).
 *
 *   granted (`http: true`)  prepare + instantiate succeed and a `fetch`
 *                           dispatch against a local server lands the body
 *                           in module state (real egress via preview2-shim).
 *   denied (false/omitted)  prepare() FAILS, naming the missing wasi:http
 *                           imports, before any instantiation.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { JsModuleHost, MemoryStorageBackend, type ModuleManifest } from "../src/index.ts";
import { hasFixture, readFixture } from "./_fixtures.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const FIXTURE = "fetcher_module.wasm";
const missing = !hasFixture(FIXTURE);

const base: ModuleManifest = { name: "fetcher", version: "1.0.0", reads: [], dispatches: [] };

describe.skipIf(missing)("wasi:http gate (fetcher_module.wasm)", () => {
  let worker: Worker | null = null;
  afterAll(async () => {
    await worker?.terminate();
  });

  test("http: true links wasi:http and really egresses", async () => {
    const BODY = '{"greeting":"hello"}';
    worker = new Worker(new URL("./_http-server-worker.mjs", import.meta.url), {
      workerData: { body: BODY },
    });
    const w = worker;
    const hit = new Promise<string>((res) => w.on("message", (m) => m.hit !== undefined && res(m.hit)));
    const port = await new Promise<number>((res) =>
      w.on("message", (m) => m.port !== undefined && res(m.port)),
    );

    const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
    await host.prepare("fetcher", readFixture(FIXTURE), { ...base, http: true });
    const id = host.instantiate("fetcher");
    let state = host.init(id, enc.encode("{}"));

    const out = host.dispatch(
      id,
      state,
      { name: "fetch", payload: enc.encode(JSON.stringify({ url: `http://127.0.0.1:${port}/` })) },
      [],
    );
    if (out.state !== undefined) state = out.state;
    const parsed = JSON.parse(dec.decode(state));

    const hitUrl = await Promise.race([
      hit,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("server never hit")), 5000)),
    ]);
    expect(hitUrl).toBe("/");
    expect(parsed.error ?? null).toBeNull();
    expect(parsed.received?.status).toBe(200);
    expect(parsed.received?.body).toBe(BODY);
  }, 60_000);

  for (const [label, http] of [
    ["http: false", false],
    ["http omitted", undefined],
  ] as const) {
    test(`${label} fails prepare() naming the wasi:http imports`, async () => {
      const host = new JsModuleHost();
      const manifest: ModuleManifest = { ...base };
      if (http !== undefined) manifest.http = http;
      const err = await host.prepare("fetcher", readFixture(FIXTURE), manifest).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeNull();
      const msg = String((err as Error).message);
      expect(msg).toMatch(/http egress denied for module 'fetcher'/);
      expect(msg).toContain("wasi:http/outgoing-handler");
      expect(() => host.instantiate("fetcher")).toThrow(/not prepared/);
    }, 60_000);
  }
});
