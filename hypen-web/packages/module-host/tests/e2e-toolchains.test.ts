/**
 * End-to-end: modules from other toolchains load through the runtime jco
 * pipeline. Both TinyGo (`wasip2`) and componentize-js import
 * wasi:filesystem unconditionally; the host links it as an EMPTY filesystem
 * (no preopens), exactly like the native host's empty WasiCtx, so they run
 * but cannot touch any file. Also checks the onPrepare report.
 */

import { describe, expect, test } from "bun:test";
import { JsModuleHost, MemoryStorageBackend, type PrepareInfo } from "../src/index.ts";
import { hasFixture, readFixture } from "./_fixtures.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const cases = [
  // componentize-js links every interface of its world, wasi:http/types included.
  { file: "ts_counter_module.wasm", name: "ts_counter", grants: { storage: ["local", "app", "cloud"], http: true } },
  { file: "go_counter_module.wasm", name: "go_counter", grants: {} },
] as const;

for (const c of cases) {
  describe.skipIf(!hasFixture(c.file))(`${c.file}`, () => {
    test("prepares, reports via onPrepare, and runs init + dispatch", async () => {
      const reports: PrepareInfo[] = [];
      const host = new JsModuleHost({ storage: new MemoryStorageBackend(), onPrepare: (i) => reports.push(i) });
      await host.prepare(c.name, readFixture(c.file), { name: c.name, ...c.grants });

      expect(reports).toHaveLength(1);
      const info = reports[0]!;
      expect(info.module).toBe(c.name);
      expect(["blob", "data"]).toContain(info.loadedVia);
      expect(info.componentBytes).toBe(readFixture(c.file).byteLength);
      expect(info.coreWasmBytes).toBeGreaterThan(0);
      expect(info.timings.totalMs).toBeGreaterThanOrEqual(info.timings.transpileMs);

      const id = host.instantiate(c.name);
      expect(host.actions(id)).toContain("increment");
      let state = host.init(id, enc.encode("{}"));
      for (let i = 0; i < 2; i++) {
        state = host.dispatch(id, state, { name: "increment", payload: enc.encode("{}") }, []).state ?? state;
      }
      expect(JSON.parse(dec.decode(state)).count).toBe(2);
    }, 120_000);
  });
}
