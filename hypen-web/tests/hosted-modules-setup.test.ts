/**
 * Hosted modules: every way a declaration can be wrong (each with a stable
 * code, the module / file / field, and a hint), `loadWasmModules`, hot
 * reload, and the hosts that cannot run hosted modules.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HypenApp } from "../packages/core/src/app";
import type { BaseEngine } from "../packages/core/src/engine-base";
import { ManagedRouter } from "../packages/core/src/managed-router";
import { RemoteServer } from "../packages/server/src/remote/server";
import {
  HostedModuleService,
  HostedModuleSetupError,
  formatHostedModuleSetupError,
  loadWasmModules,
  wasmModule,
} from "../packages/server/src/hosted";
import { assertNoHostedModules } from "../packages/cf/src/durable-object";
import {
  connect,
  failureLog,
  fixture,
  flush,
  hasFixtures,
  hasServerEngine,
} from "./hosted-modules-harness";

const skip =
  !hasServerEngine ||
  !hasFixtures("counter_module.wasm", "mirror_module.wasm", "limits_module.wasm", "seeded_module.wasm");

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hypen-hosted-setup-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setupError(run: () => unknown): HostedModuleSetupError {
  try {
    run();
  } catch (err) {
    if (err instanceof HostedModuleSetupError) return err;
    throw err;
  }
  throw new Error("expected a HostedModuleSetupError");
}

async function setupRejection(run: () => Promise<unknown>): Promise<HostedModuleSetupError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof HostedModuleSetupError) return err;
    throw err;
  }
  throw new Error("expected a HostedModuleSetupError");
}

const TALLY_UI = `Column {
  Text("Tally: @{state.count}")
  Button { Text("Tally +1") }.onClick(@actions.increment)
}`;

function appWith(ui = `module App { Column { Tally {} } }`) {
  const app = new HypenApp();
  const entry = app.module("App").defineState({ ready: true }).ui(ui);
  return { app, entry };
}

describe.skipIf(skip)("wasmModule(): declaration errors", () => {
  test("a missing component file", () => {
    const err = setupError(() => wasmModule({ name: "Pricing", component: "./nope/pricing.wasm", baseDir: "/tmp" }));
    expect(err).toMatchObject({
      code: "COMPONENT_MISSING",
      module: "Pricing",
      file: "/tmp/nope/pricing.wasm",
      field: 'wasmModule({ name: "Pricing" }).component',
    });
    expect(err.hint).toMatch(/relative paths resolve against the project root/);
    expect(formatHostedModuleSetupError(err)).toContain("file:    /tmp/nope/pricing.wasm");
  });

  test("a file that is not a component (not wasm, empty, a core module)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "text.wasm"), "definitely not wasm");
    writeFileSync(join(dir, "empty.wasm"), "");
    // `\0asm` + version 1, layer 0: a core module preamble.
    writeFileSync(join(dir, "core.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const of = (file: string) => setupError(() => wasmModule({ name: "Pricing", component: file, baseDir: dir }));
    expect(of("text.wasm")).toMatchObject({ code: "COMPONENT_INVALID" });
    expect(of("text.wasm").message).toMatch(/not a WebAssembly binary/);
    expect(of("empty.wasm").message).toMatch(/an empty file/);
    expect(of("core.wasm").message).toMatch(/core WebAssembly module, not a Component/);
    expect(of("core.wasm").hint).toMatch(/wasm32-wasip2/);
    // Bytes are checked the same way.
    expect(setupError(() => wasmModule({ name: "Pricing", component: new Uint8Array([1, 2, 3]) })).code).toBe(
      "COMPONENT_INVALID"
    );
  });

  test("a missing template, bad names, malformed grants", () => {
    const component = fixture("counter_module.wasm");
    expect(setupError(() => wasmModule({ name: "Pricing", component, template: "./Missing.hypen", baseDir: "/tmp" })))
      .toMatchObject({ code: "TEMPLATE_MISSING", file: "/tmp/Missing.hypen", field: 'wasmModule({ name: "Pricing" }).template' });
    for (const name of ["", "a:b", "__hypen_x", "9lives", "has space"]) {
      expect(setupError(() => wasmModule({ name, component })).code).toBe("INVALID_NAME");
    }
    expect(setupError(() => wasmModule({ name: "P", component, grants: { storage: ["disk" as never] } })))
      .toMatchObject({ code: "INVALID_OPTIONS", field: 'wasmModule({ name: "P" }).grants.storage' });
    expect(setupError(() => wasmModule({ name: "P", component, grants: { read: ["Cart"] } as never })))
      .toMatchObject({ code: "INVALID_OPTIONS", field: 'wasmModule({ name: "P" }).grants.read' });
    expect(setupError(() => wasmModule({ name: "P", component, ui: "Text(\"x\")", template: "x.hypen" })).code).toBe(
      "INVALID_OPTIONS"
    );
    // Grants are normalised to scopes; `local` is implicit.
    const ok = wasmModule({ name: "P", component, grants: { reads: ["Cart", "cart"], storage: ["local", "app"] as never } });
    expect(ok.hosted.grants).toEqual({ reads: ["cart"], dispatches: [], storage: ["app"], http: false });
  });
});

describe.skipIf(skip)("RemoteServer.prepare(): app-level errors", () => {
  test("an import the grants do not cover names the grant to add", async () => {
    const { app, entry } = appWith();
    // counter_module imports hypen:storage/cloud.
    const server = new RemoteServer()
      .app(app)
      .module("App", entry)
      .wasmModules(wasmModule({ name: "Tally", component: fixture("counter_module.wasm"), ui: TALLY_UI }));
    const err = await setupRejection(() => server.prepare());
    expect(err).toMatchObject({
      code: "UNGRANTED_IMPORT",
      module: "Tally",
      field: 'wasmModule({ name: "Tally" }).grants.storage',
    });
    expect(err.message).toContain("hypen:storage/cloud");
    expect(err.hint).toContain('add "cloud"');
  });

  test("a grant naming a module the app does not have", async () => {
    const { app, entry } = appWith();
    const server = new RemoteServer().app(app).module("App", entry).wasmModules(
      wasmModule({
        name: "Mirror",
        component: fixture("mirror_module.wasm"),
        grants: { reads: ["Counter"] },
      })
    );
    const err = await setupRejection(() => server.prepare());
    expect(err).toMatchObject({
      code: "UNKNOWN_GRANT_TARGET",
      module: "Mirror",
      field: 'wasmModule({ name: "Mirror" }).grants.reads',
    });
    expect(err.message).toMatch(/modules: App, Mirror/);
  });

  test("a hosted module sharing its name with a TypeScript module", async () => {
    const { app, entry } = appWith();
    app.module("tally").defineState({ count: 0 }).onAction("increment", () => {}).ui(`Text("ts")`);
    const server = new RemoteServer().app(app).module("App", entry).wasmModules(
      wasmModule({ name: "Tally", component: fixture("counter_module.wasm"), grants: { storage: ["cloud"] } })
    );
    const err = await setupRejection(() => server.prepare());
    expect(err).toMatchObject({ code: "DUPLICATE_MODULE", module: "Tally" });
    expect(err.message).toMatch(/a TypeScript module is named "tally"/);
  });

  test("a hosted entry module", async () => {
    const tally = wasmModule({
      name: "App",
      component: fixture("counter_module.wasm"),
      ui: TALLY_UI,
      grants: { storage: ["cloud"] },
    });
    const server = new RemoteServer().module("App", tally).wasmModules(tally);
    const err = await setupRejection(() => server.prepare());
    expect(err.code).toBe("ENTRY_HOSTED");
  });

  test("a component jco cannot transpile", async () => {
    const { app, entry } = appWith();
    // A component preamble with garbage behind it.
    const bytes = new Uint8Array(64);
    bytes.set([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]);
    bytes.fill(0xff, 8);
    const server = new RemoteServer()
      .app(app)
      .module("App", entry)
      .wasmModules(wasmModule({ name: "Tally", component: bytes, ui: TALLY_UI }));
    const err = await setupRejection(() => server.prepare());
    expect(err).toMatchObject({ code: "PREPARE_FAILED", module: "Tally" });
  });

  test("@hypen-space/module-host not installed", async () => {
    const { app, entry } = appWith();
    const server = new RemoteServer()
      .app(app)
      .module("App", entry)
      .wasmModules(wasmModule({ name: "Tally", component: fixture("counter_module.wasm"), grants: { storage: ["cloud"] } }))
      .hostedModules({
        loadModuleHost: async () => {
          throw new Error("Cannot find package '@hypen-space/module-host'");
        },
      });
    const err = await setupRejection(() => server.prepare());
    expect(err.code).toBe("MODULE_HOST_MISSING");
    expect(err.message).toMatch(/hosted \(WASM\) modules \(Tally\)/);
    expect(err.hint).toMatch(/bun add @hypen-space\/module-host/);
  });

  test("an engine build without hosted-module support", async () => {
    const service = new HostedModuleService();
    service.define([wasmModule({ name: "Tally", component: fixture("counter_module.wasm"), grants: { storage: ["cloud"] } })]);
    const browserLike = { init: async () => {}, supportsHostedModules: false } as unknown as BaseEngine;
    const err = await setupRejection(() => service.prepare(() => browserLike));
    expect(err.code).toBe("ENGINE_UNSUPPORTED");
    expect(err.hint).toMatch(/module-loader-bridged/);
    expect(err.hint).toMatch(/web-engine\) cannot run hosted modules/);
  });

  test("an app without hosted modules never loads the module host", async () => {
    let loads = 0;
    const { app, entry } = appWith(`module App { Text("plain") }`);
    const server = new RemoteServer()
      .app(app)
      .module("App", entry)
      .hostedModules({ loadModuleHost: async () => (loads++, {}) });
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());
    expect(loads).toBe(0);
    expect(client.session.hostedModules).toBeNull();
    expect(client.texts()).toContain("plain");
  });
});

describe.skipIf(skip)("loadWasmModules(): a `hypen build --target wasm` directory", () => {
  function buildOutput(): string {
    const dir = tempDir();
    copyFileSync(fixture("counter_module.wasm"), join(dir, "Tally.wasm"));
    writeFileSync(join(dir, "Tally.hypen"), TALLY_UI);
    writeFileSync(join(dir, "Header.hypen"), `Text("Header")`);
    writeFileSync(
      join(dir, "app.json"),
      JSON.stringify({
        entry: "Tally",
        modules: [
          { name: "Tally", wasm: "Tally.wasm", ui: "Tally.hypen", reads: [], dispatches: [], storage: ["cloud"], http: false },
          { name: "Header", ui: "Header.hypen" },
        ],
      })
    );
    return dir;
  }

  test("loads modules with the manifest's grants and runs them", async () => {
    const dir = buildOutput();
    for (const source of [dir, join(dir, "app.json")]) {
      const loaded = loadWasmModules(source);
      expect(loaded.entry).toBe("Tally");
      expect(loaded.modules.map((m) => m.name)).toEqual(["Tally"]);
      expect(loaded.modules[0]!.hosted.grants.storage).toEqual(["cloud"]);
      expect(loaded.modules[0]!.template).toBe(TALLY_UI);
      expect(loaded.templates).toEqual([{ name: "Header", template: `Text("Header")` }]);
    }
    const { app, entry } = appWith();
    const server = new RemoteServer().app(app).module("App", entry).wasmModules(loadWasmModules(dir).modules);
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());
    await client.click(client.button("Tally +1"), "increment");
    expect(client.state("tally")).toEqual({ count: 1 });
  });

  test("manifest errors", () => {
    const dir = buildOutput();
    expect(setupError(() => loadWasmModules(join(dir, "missing"))).code).toBe("MANIFEST_INVALID");
    writeFileSync(join(dir, "bad.json"), "{ nope");
    expect(setupError(() => loadWasmModules(join(dir, "bad.json"))).code).toBe("MANIFEST_INVALID");
    writeFileSync(
      join(dir, "escape.json"),
      JSON.stringify({ entry: "T", modules: [{ name: "T", wasm: "../outside.wasm" }] })
    );
    expect(setupError(() => loadWasmModules(join(dir, "escape.json"))).message).toMatch(/outside the manifest's directory/);
    expect(setupError(() => loadWasmModules(dir, { only: ["Nope"] })).code).toBe("UNKNOWN_MODULE");
  });
});

describe.skipIf(skip)("hot reload of a hosted module", () => {
  async function running() {
    const dir = tempDir();
    const wasm = join(dir, "tally.wasm");
    copyFileSync(fixture("counter_module.wasm"), wasm);
    const define = (grants: Record<string, unknown> = { storage: ["cloud"] }) =>
      wasmModule({ name: "Tally", component: wasm, ui: TALLY_UI, grants });
    const { app, entry } = appWith();
    const log = failureLog();
    const server = new RemoteServer()
      .app(app)
      .module("App", entry)
      .wasmModules(define())
      .hostedModules({ onError: log.onError });
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());
    await client.click(client.button("Tally +1"), "increment");
    await client.click(client.button("Tally +1"), "increment");
    return { server, client, wasm, define, failures: log.failures };
  }

  test("a new component replaces the running one in place and keeps its state", async () => {
    const { server, client, wasm, define, failures } = await running();
    const sentBefore = client.sent.length;
    // seeded_module: same state shape, different code (`increment`, `reset`).
    copyFileSync(fixture("seeded_module.wasm"), wasm);
    const result = await server.reloadWasmModule(define({}));
    expect(result).toEqual({ module: "Tally", sessions: 1, reloaded: 1, stateReset: 0, kept: 0, failed: 0 });
    // No reconnect, no re-render: the client keeps its tree and the state.
    expect(client.sent.slice(sentBefore).map((m) => m.type)).toEqual([]);
    expect(client.state("tally")).toEqual({ count: 2 });
    await client.click(client.button("Tally +1"), "increment");
    expect(client.state("tally")).toEqual({ count: 3 });
    expect((client.session.engine.hostedModules()[0] as { actions: string[] }).actions).toEqual(["increment", "reset"]);
    expect(failures).toEqual([]);

    // Sessions opened afterwards run the new component too.
    const later = await connect(server);
    cleanups.push(() => later.close());
    expect((later.session.engine.hostedModules()[0] as { actions: string[] }).actions).toEqual(["increment", "reset"]);
  });

  test("a component that no longer instantiates is refused; the old instance keeps running", async () => {
    const { server, client, wasm, define, failures } = await running();
    // Not a component any more.
    writeFileSync(wasm, "garbage");
    expect((await setupRejection(async () => server.reloadWasmModule(define()))).code).toBe("COMPONENT_INVALID");
    // A component whose imports the grants no longer cover.
    copyFileSync(fixture("limits_module.wasm"), wasm);
    const err = await setupRejection(async () => server.reloadWasmModule(define()));
    expect(err).toMatchObject({ code: "UNGRANTED_IMPORT", module: "Tally" });
    expect(err.hint).toContain('add "app"');

    expect(client.state("tally")).toEqual({ count: 2 });
    await client.click(client.button("Tally +1"), "increment");
    expect(client.state("tally")).toEqual({ count: 3 });
    expect(failures).toEqual([]);
  });

  test("a component that rejects the previous state is re-initialised, and says so", async () => {
    const { server, client, wasm, define, failures } = await running();
    // mirror_module's on_activated subscribes to a module it has no grant for: activation fails.
    copyFileSync(fixture("mirror_module.wasm"), wasm);
    const result = await server.reloadWasmModule(define({}));
    await flush();
    expect(result).toMatchObject({ sessions: 1, reloaded: 0, stateReset: 1 });
    expect(client.state("tally")).toEqual({ seen: 0 });
    expect(failures.some((f) => f.kind === "reload" && /re-initialised/.test(f.message))).toBe(true);
  });

  test("reloading an unknown module", async () => {
    const { server } = await running();
    const other = wasmModule({ name: "Other", component: fixture("seeded_module.wasm") });
    expect((await setupRejection(async () => server.reloadWasmModule(other))).code).toBe("UNKNOWN_MODULE");
  });
});

describe.skipIf(skip)("hosts that cannot run hosted modules", () => {
  const tally = () =>
    wasmModule({ name: "Tally", component: fixture("counter_module.wasm"), ui: TALLY_UI, grants: { storage: ["cloud"] } });

  test("Cloudflare Workers fail fast", () => {
    const { app, entry } = appWith();
    (app as unknown as { _registry: Map<string, unknown> })._registry.set("Tally", tally());
    expect(() => assertNoHostedModules({ module: entry, app })).toThrow(
      /Hosted WASM modules are not supported on Cloudflare Workers yet \(Tally\)/
    );
    const plain = appWith();
    expect(() => assertNoHostedModules({ module: plain.entry, app: plain.app })).not.toThrow();
  });

  test("a ManagedRouter without a hosted-instance factory leaves the route's module unmounted", async () => {
    const { HypenRouter } = await import("../packages/core/src/router");
    const { HypenGlobalContext } = await import("../packages/core/src/context");
    const { Engine } = await import("../packages/server/src/engine");
    const engine = new Engine();
    await engine.init();
    const registry = new HypenApp();
    (registry as unknown as { _registry: Map<string, unknown> })._registry.set("Tally", tally());
    const router = new HypenRouter();
    const managed = new ManagedRouter(router, engine, registry, new HypenGlobalContext());
    managed.addRoute({ path: "/tally", component: "Tally" });
    managed.start();
    router.push("/tally");
    await managed.waitForNavigation();
    expect(managed.getActiveInstance()).toBeNull();
    expect(managed.getActiveRoute()?.path).toBe("/tally");
    await managed.stop();
  });
});
