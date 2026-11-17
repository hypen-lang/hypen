/**
 * Module packages on the server: `loadWasmPackage()` / `wasmModule({ from })`
 * / `wasmModuleFromManifest()` read a `hypen-modules.json` package (what
 * `hypen build --target wasm`, `hypen pack` and `hypen add` deal in),
 * verify it, and refuse one that drifted from what was reviewed
 * (`hypen.lock.json`). `RemoteServer.components()` registers the package's
 * template-only components.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HypenApp } from "../packages/core/src/app";
import { RemoteServer } from "../packages/server/src/remote/server";
import {
  HostedModuleSetupError,
  loadWasmPackage,
  wasmModule,
  wasmModuleFromManifest,
} from "../packages/server/src/hosted";
import {
  PACKAGE_MANIFEST_FILE,
  asRequests,
  integrityOf,
  lockEntryOf,
  readModulePackage,
  serializeModuleLock,
  serializePackageManifest,
  type PackageManifest,
} from "../packages/server/src/hosted/module-package";
import { connect, fixture, hasFixtures, hasServerEngine } from "./hosted-modules-harness";

const skip = !hasServerEngine || !hasFixtures("counter_module.wasm", "mirror_module.wasm", "seeded_module.wasm");

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hypen-hosted-pkg-"));
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

const COUNTER_UI = `module Counter {\n  Column {\n    Text("Count: @{state.count}")\n    Button { Text("Count +1") }.onClick(@actions.increment)\n  }\n}`;
const MIRROR_UI = `module Mirror {\n  Column {\n    Text("Seen: @{state.seen}")\n    Button { Text("Bump") }.onClick(@actions.bump)\n    Stamp()\n  }\n}`;

/** Write the two-module counters package into `dir`. */
function writePackage(dir: string, patch: (m: PackageManifest) => void = () => {}): string {
  mkdirSync(dir, { recursive: true });
  copyFileSync(fixture("mirror_module.wasm"), join(dir, "Mirror.wasm"));
  copyFileSync(fixture("counter_module.wasm"), join(dir, "Counter.wasm"));
  writeFileSync(join(dir, "Mirror.hypen"), MIRROR_UI);
  writeFileSync(join(dir, "Counter.hypen"), COUNTER_UI);
  writeFileSync(join(dir, "Stamp.hypen"), `Text("from the counters package")`);
  const none = { reads: [], dispatches: [], storage: [], http: false, httpHosts: [] };
  const manifest: PackageManifest = {
    name: "@acme/counters",
    version: "1.2.0",
    description: undefined,
    entry: "Mirror",
    exports: ["Mirror", "Counter"],
    modules: [
      { name: "Mirror", component: "Mirror.wasm", template: "Mirror.hypen", abi: "0.1", requests: asRequests({ ...none, reads: ["Counter"], dispatches: ["Counter"] }), integrity: integrityOf(readFileSync(fixture("mirror_module.wasm"))) },
      { name: "Counter", component: "Counter.wasm", template: "Counter.hypen", abi: "0.1", requests: asRequests({ ...none, storage: ["cloud"] }), integrity: integrityOf(readFileSync(fixture("counter_module.wasm"))) },
    ],
    components: [{ name: "Stamp", template: "Stamp.hypen" }],
  };
  patch(manifest);
  writeFileSync(join(dir, PACKAGE_MANIFEST_FILE), serializePackageManifest(manifest));
  return dir;
}

const GRANTS = { Mirror: { reads: ["Counter"], dispatches: ["Counter"] }, Counter: { storage: ["cloud" as const] } };

describe.skipIf(skip)("loadWasmPackage()", () => {
  test("loads every module with the grants the app gives, and the template-only components; they run together", async () => {
    const base = tempDir();
    writePackage(join(base, "vendor/counters"));
    const loaded = loadWasmPackage("./vendor/counters", { baseDir: base, grants: GRANTS });
    expect(loaded.manifest).toMatchObject({ name: "@acme/counters", version: "1.2.0", entry: "Mirror" });
    expect(loaded.modules.map((m) => m.name)).toEqual(["Mirror", "Counter"]);
    expect(loaded.modules[0]!.hosted.grants).toMatchObject({ reads: ["counter"], dispatches: ["counter"] });
    expect(loaded.modules[1]!.hosted.grants.storage).toEqual(["cloud"]);
    expect(loaded.components).toEqual([{ name: "Stamp", template: `Text("from the counters package")` }]);

    const app = new HypenApp();
    const entry = app.module("App").defineState({ ready: true }).ui(`module App { Column { Mirror {} Counter {} } }`);
    const server = new RemoteServer().app(app).module("App", entry).wasmModules(loaded.modules).components(loaded.components);
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());
    expect(client.texts()).toContain("from the counters package");
    await client.click(client.button("Bump"), "bump");
    expect(client.state("counter")).toEqual({ count: 1 });
    expect(client.state("mirror")).toMatchObject({ seen: 1 });
  });

  test("requests are never applied by themselves: without grants a module gets nothing", async () => {
    const base = tempDir();
    writePackage(join(base, "pkg"));
    const loaded = loadWasmPackage("./pkg", { baseDir: base, only: ["Mirror", "Stamp"] });
    expect(loaded.modules.map((m) => m.name)).toEqual(["Mirror"]);
    expect(loaded.modules[0]!.hosted.grants).toMatchObject({ reads: [], dispatches: [], storage: [], http: false });
    // Counter imports hypen:storage/cloud: left ungranted, the server refuses to start it.
    const all = loadWasmPackage("./pkg", { baseDir: base });
    const app = new HypenApp();
    const entry = app.module("App").defineState({}).ui(`module App { Counter {} }`);
    const server = new RemoteServer().app(app).module("App", entry).wasmModules(all.modules).components(all.components);
    let error: unknown;
    try {
      await server.prepare();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HostedModuleSetupError);
    expect((error as HostedModuleSetupError).code).toBe("UNGRANTED_IMPORT");
    expect((error as HostedModuleSetupError).field).toBe(`loadWasmPackage("./pkg").grants.Counter.storage`);
  });

  test("an npm package is found through its package.json marker", () => {
    const base = tempDir();
    const dir = writePackage(join(base, "node_modules/@acme/counters"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/counters", version: "1.2.0", hypen: { modules: PACKAGE_MANIFEST_FILE } }));
    expect(loadWasmPackage("@acme/counters", { baseDir: base, grants: GRANTS }).modules).toHaveLength(2);
    expect(setupError(() => loadWasmPackage("@acme/nope", { baseDir: base })).code).toBe("PACKAGE_NOT_FOUND");
  });

  test("bad packages: tampered bytes, a manifest that escapes its directory, a newer format, unknown names", () => {
    const base = tempDir();
    const dir = writePackage(join(base, "pkg"));
    copyFileSync(fixture("seeded_module.wasm"), join(dir, "Mirror.wasm"));
    const tampered = setupError(() => loadWasmPackage("./pkg", { baseDir: base }));
    expect(tampered).toMatchObject({ code: "INTEGRITY_MISMATCH", module: "Mirror" });

    writePackage(dir, (m) => (m.modules[0]!.component = "../../outside.wasm"));
    expect(setupError(() => loadWasmPackage("./pkg", { baseDir: base }))).toMatchObject({ code: "MANIFEST_INVALID", field: "modules[0].component" });

    writePackage(dir);
    const file = join(dir, PACKAGE_MANIFEST_FILE);
    writeFileSync(file, readFileSync(file, "utf8").replace(`"hypenModules": 1`, `"hypenModules": 7`));
    expect(setupError(() => loadWasmPackage("./pkg", { baseDir: base })).message).toContain("format 7 manifest");

    writePackage(dir);
    expect(setupError(() => loadWasmPackage("./pkg", { baseDir: base, only: ["Ghost"] })).code).toBe("UNKNOWN_MODULE");
    expect(setupError(() => loadWasmPackage("./pkg", { baseDir: base, grants: { Stamp: {} } })).code).toBe("UNKNOWN_MODULE");
    expect(setupError(() => loadWasmPackage("./missing", { baseDir: base })).code).toBe("MANIFEST_INVALID");
  });

  test("hypen.lock.json: a package that requests more than was reviewed is refused; a harmless update is not", () => {
    const base = tempDir();
    const dir = writePackage(join(base, "pkg"));
    const reviewed = lockEntryOf(readModulePackage(join(dir, PACKAGE_MANIFEST_FILE)));
    writeFileSync(join(base, "hypen.lock.json"), serializeModuleLock({ "./pkg": reviewed }));
    expect(loadWasmPackage("./pkg", { baseDir: base, grants: GRANTS }).modules).toHaveLength(2);

    writePackage(dir, (m) => {
      m.version = "1.3.0";
      m.modules[0]!.requests = asRequests({ ...m.modules[0]!.requests, http: true, httpHosts: ["api.acme.com"] });
    });
    const err = setupError(() => loadWasmPackage("./pkg", { baseDir: base, grants: GRANTS }));
    expect(err.code).toBe("REQUESTS_CHANGED");
    expect(err.message).toBe(
      "./pkg 1.3.0: Mirror now also requests: make HTTP requests to api.acme.com. Review and run `hypen add ./pkg` to update the grant."
    );
    // The check can be turned off explicitly, and demanded explicitly.
    expect(loadWasmPackage("./pkg", { baseDir: base, grants: GRANTS, checkLock: false }).modules).toHaveLength(2);

    writePackage(dir, (m) => (m.version = "1.2.1"));
    expect(loadWasmPackage("./pkg", { baseDir: base, grants: GRANTS }).manifest.version).toBe("1.2.1");

    rmSync(join(base, "hypen.lock.json"));
    expect(loadWasmPackage("./pkg", { baseDir: base, grants: GRANTS }).modules).toHaveLength(2);
    expect(setupError(() => loadWasmPackage("./pkg", { baseDir: base, checkLock: true })).message).toContain("is not recorded");
  });
});

describe.skipIf(skip)("wasmModule({ from }) / wasmModuleFromManifest()", () => {
  test("one module of a package: by name, or the entry by default", () => {
    const base = tempDir();
    writePackage(join(base, "pkg"));
    const entry = wasmModule({ from: "./pkg", baseDir: base, grants: GRANTS.Mirror });
    expect(entry.name).toBe("Mirror");
    expect(entry.hosted.grants.reads).toEqual(["counter"]);
    expect(entry.template).toBe(MIRROR_UI);
    const counter = wasmModuleFromManifest(join(base, "pkg", PACKAGE_MANIFEST_FILE), { storage: ["cloud"] }, { name: "Counter" });
    expect(counter.name).toBe("Counter");
    expect(counter.hosted.grants.storage).toEqual(["cloud"]);

    expect(setupError(() => wasmModule({ from: "./pkg", name: "Ghost", baseDir: base })).code).toBe("UNKNOWN_MODULE");
    expect(setupError(() => wasmModule({ from: "./pkg", component: "./x.wasm", baseDir: base })).code).toBe("INVALID_OPTIONS");
  });
});

describe.skipIf(skip)("RemoteServer.components()", () => {
  test("a name the source directory also has is an error", async () => {
    const base = tempDir();
    mkdirSync(join(base, "components/App"), { recursive: true });
    mkdirSync(join(base, "components/Stamp"), { recursive: true });
    writeFileSync(join(base, "components/App/component.hypen"), `module App { Stamp() }`);
    writeFileSync(join(base, "components/Stamp/component.hypen"), `Text("the app's own")`);
    const server = new RemoteServer().source(join(base, "components")).components({ Stamp: `Text("the package's")` });
    let error: unknown;
    try {
      await server.prepare();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HostedModuleSetupError);
    expect((error as HostedModuleSetupError).code).toBe("DUPLICATE_MODULE");
  });
});
