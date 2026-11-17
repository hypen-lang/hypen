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
import { connect, eventually, failureLog, fixture, hasFixtures, hasServerEngine } from "./hosted-modules-harness";

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
    // Stamp is not exported: it is internal, so it is installed under the
    // package's namespace and Mirror's template is rewritten to match.
    expect(loaded.components).toEqual([{ name: "AcmeCounters__Stamp", template: `Text("from the counters package")` }]);
    expect(loaded.modules[0]!.template).toContain("AcmeCounters__Stamp()");
    expect(loaded.exports).toEqual(["Mirror", "Counter"]);

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

/** The counters package with a root module, `Board`, that composes the rest; only `Board` is exported. */
function writeRootedPackage(dir: string, patch: (m: PackageManifest) => void = () => {}): string {
  return writePackage(dir, (manifest) => {
    copyFileSync(fixture("seeded_module.wasm"), join(dir, "Board.wasm"));
    writeFileSync(
      join(dir, "Board.hypen"),
      `// Board composes Mirror and Counter\nmodule Board {\n  Column {\n    Text("Board: @{state.count} — uses Counter and Mirror")\n    Button { Text("Board +1") }.onClick(@actions.increment)\n    Mirror {}\n    Counter {}\n  }\n}`
    );
    const none = { reads: [], dispatches: [], storage: [], http: false, httpHosts: [] };
    manifest.modules.unshift({
      name: "Board",
      component: "Board.wasm",
      template: "Board.hypen",
      abi: "0.1",
      requests: asRequests(none),
      integrity: integrityOf(readFileSync(fixture("seeded_module.wasm"))),
    });
    manifest.entry = "Board";
    manifest.exports = ["Board"];
    patch(manifest);
  });
}

describe.skipIf(skip)("a package is self-contained: point at its root", () => {
  /** An app with its OWN `Counter` (a TypeScript module) next to the package. */
  function appWithOwnCounter(template = `module App { Column { Board {} Counter {} } }`) {
    const app = new HypenApp();
    app
      .module("Counter")
      .defineState({ count: 100 })
      .onAction("increment", ({ state }) => {
        state.count++;
      })
      .ui(`module Counter { Column { Text("Mine: @{state.count}") Button { Text("Mine +1") }.onClick(@actions.increment) } }`);
    const entry = app.module("App").defineState({ ready: true }).ui(template);
    return { app, entry };
  }

  test("internal modules are namespaced; the package's own names keep working inside it", async () => {
    const base = tempDir();
    writeRootedPackage(join(base, "pkg"));
    const loaded = loadWasmPackage("./pkg", { baseDir: base, grants: GRANTS });
    expect(loaded.namespace).toBe("AcmeCounters");
    expect(loaded.exports).toEqual(["Board"]);
    expect(loaded.modules.map((m) => m.name)).toEqual(["Board", "AcmeCounters__Mirror", "AcmeCounters__Counter"]);
    expect(loaded.modules.map((m) => m.hosted.label ?? m.name)).toEqual(["Board", "Mirror", "Counter"]);
    expect(loaded.names).toEqual([
      { name: "Board", installed: "Board", exported: true },
      { name: "Mirror", installed: "AcmeCounters__Mirror", exported: false },
      { name: "Counter", installed: "AcmeCounters__Counter", exported: false },
      { name: "Stamp", installed: "AcmeCounters__Stamp", exported: false },
    ]);
    // Mirror's code says "counter"; here that means the package's Counter.
    expect(loaded.modules[1]!.hosted.grants).toMatchObject({
      reads: ["counter"],
      dispatches: ["counter"],
      aliases: { counter: "acmecounters__counter" },
    });
    // Tags and the declaration are rewritten; the comment and the string are not.
    expect(loaded.modules[0]!.template).toBe(
      `// Board composes Mirror and Counter\nmodule Board {\n  Column {\n    Text("Board: @{state.count} — uses Counter and Mirror")\n    Button { Text("Board +1") }.onClick(@actions.increment)\n    AcmeCounters__Mirror {}\n    AcmeCounters__Counter {}\n  }\n}`
    );
    expect(loaded.modules[2]!.template).toStartWith("module AcmeCounters__Counter {");

    const { app, entry } = appWithOwnCounter();
    const log = failureLog();
    const server = new RemoteServer()
      .app(app)
      .module("App", entry)
      .wasmModules(loaded.modules)
      .components(loaded.components)
      .hostedModules({ onError: log.onError });
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());

    // ONE tag from the package in the app's template renders all of it.
    expect(client.texts()).toEqual(
      expect.arrayContaining(["Board: 0 — uses Counter and Mirror", "Seen: 0", "Count: 0", "from the counters package", "Mine: 100"])
    );

    // Mirror dispatches to "counter" and is subscribed to it: the package's
    // Counter moves, the app's own does not.
    await client.click(client.button("Bump"), "bump");
    expect(client.state("acmecounters__counter")).toEqual({ count: 1 });
    expect(client.state("acmecounters__mirror")).toMatchObject({ seen: 1 });
    expect(client.state("counter")).toEqual({ count: 100 });

    // A click inside the package's internal module reaches it (and its subscriber).
    await client.click(client.button("Count +1"), "increment");
    expect(client.state("acmecounters__counter")).toEqual({ count: 2 });
    expect(client.state("acmecounters__mirror")).toMatchObject({ seen: 2 });

    // The app's own Counter is the app's own.
    await client.click(client.button("Mine +1"), "increment");
    expect(client.state("counter")).toEqual({ count: 101 });
    expect(client.state("acmecounters__counter")).toEqual({ count: 2 });
    expect(client.state("acmecounters__mirror")).toMatchObject({ seen: 2 });

    await client.click(client.button("Board +1"), "increment");
    expect(client.texts()).toContain("Board: 1 — uses Counter and Mirror");
    expect(log.failures).toEqual([]);
  });

  test("map: a name the package expects the app to provide is pointed at the app's module", async () => {
    const base = tempDir();
    // A package with only Mirror: its "counter" is the app's to provide.
    writePackage(join(base, "pkg"), (manifest) => {
      manifest.modules = manifest.modules.filter((m) => m.name === "Mirror");
      manifest.exports = ["Mirror"];
    });
    const app = new HypenApp();
    app
      .module("Tally")
      .defineState({ count: 7 })
      .onAction("increment", ({ state }) => {
        state.count++;
      })
      .ui(`module Tally { Text("Tally: @{state.count}") }`);
    const entry = app.module("App").defineState({}).ui(`module App { Column { Mirror {} Tally {} } }`);
    const loaded = loadWasmPackage("./pkg", {
      baseDir: base,
      grants: { Mirror: { reads: ["Counter"], dispatches: ["Counter"] } },
      map: { Mirror: { Counter: "Tally" } },
    });
    expect(loaded.modules[0]!.hosted.grants).toMatchObject({ reads: ["counter"], aliases: { counter: "tally" } });
    const log = failureLog();
    const server = new RemoteServer()
      .app(app)
      .module("App", entry)
      .wasmModules(loaded.modules)
      .components(loaded.components)
      .hostedModules({ onError: log.onError });
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());
    await client.click(client.button("Bump"), "bump");
    await eventually(() => expect(client.state("tally")).toEqual({ count: 8 }));
    await eventually(() => expect(client.state("mirror")).toMatchObject({ seen: 8 }));
    expect(log.failures).toEqual([]);
  });

  test("as: an exported name is renamed, and siblings that name it still reach it", async () => {
    const base = tempDir();
    writePackage(join(base, "pkg"));
    const loaded = loadWasmPackage("./pkg", { baseDir: base, grants: GRANTS, as: { Counter: "Tally" } });
    expect(loaded.modules.map((m) => m.name)).toEqual(["Mirror", "Tally"]);
    expect(loaded.exports).toEqual(["Mirror", "Tally"]);
    expect(loaded.modules[0]!.hosted.grants.aliases).toEqual({ counter: "tally" });
    expect(loaded.modules[1]!.template).toStartWith("module Tally {");

    const { app, entry } = appWithOwnCounter(`module App { Column { Mirror {} Tally {} Counter {} } }`);
    const server = new RemoteServer().app(app).module("App", entry).wasmModules(loaded.modules).components(loaded.components);
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());
    await client.click(client.button("Bump"), "bump");
    expect(client.state("tally")).toEqual({ count: 1 });
    expect(client.state("mirror")).toMatchObject({ seen: 1 });
    expect(client.state("counter")).toEqual({ count: 100 });
  });

  test("two packages with the same internal names do not clash", async () => {
    const base = tempDir();
    writeRootedPackage(join(base, "a"));
    writeRootedPackage(join(base, "b"), (manifest) => {
      manifest.name = "@other/counters";
    });
    const a = loadWasmPackage("./a", { baseDir: base, grants: GRANTS });
    const b = loadWasmPackage("./b", { baseDir: base, grants: GRANTS, as: { Board: "Board2" } });
    expect(b.modules.map((m) => m.name)).toEqual(["Board2", "OtherCounters__Mirror", "OtherCounters__Counter"]);
    const app = new HypenApp();
    const entry = app.module("App").defineState({}).ui(`module App { Column { Board {} Board2 {} } }`);
    const server = new RemoteServer()
      .app(app)
      .module("App", entry)
      .wasmModules([...a.modules, ...b.modules])
      .components([...a.components, ...b.components]);
    await server.prepare();
    const client = await connect(server);
    cleanups.push(() => client.close());
    await client.click(client.button("Bump"), "bump"); // the first package's
    expect(client.state("acmecounters__counter")).toEqual({ count: 1 });
    expect(client.state("othercounters__counter")).toEqual({ count: 0 });
  });

  test("bad names are refused with the field to change", () => {
    const base = tempDir();
    writeRootedPackage(join(base, "pkg"));
    const load = (options: Parameters<typeof loadWasmPackage>[1]) => setupError(() => loadWasmPackage("./pkg", { baseDir: base, ...options }));

    // Only exported names are renamed; internal ones are namespaced.
    const internal = load({ as: { Counter: "Tally" } });
    expect(internal.code).toBe("NAMING_INVALID");
    expect(internal.message).toContain(`cannot install "Counter" as "Tally": it is internal to the package (exports: Board)`);
    expect(internal.hint).toContain("AcmeCounters__Counter");
    expect(load({ as: { Board: "not a name" } }).code).toBe("NAMING_INVALID");
    expect(load({ as: { Ghost: "X" } }).message).toContain("the package has nothing of that name");
    expect(load({ namespace: "acme_counters" }).message).toContain("is not a namespace");

    // A map points a name the APP provides somewhere: not a sibling, not an ungranted name.
    const sibling = load({ grants: GRANTS, map: { Mirror: { Counter: "Tally" } } });
    expect(sibling.code).toBe("NAMING_INVALID");
    expect(sibling.message).toContain(`"Counter" is a module of the package itself`);
    const ungranted = load({ grants: GRANTS, map: { Mirror: { Session: "Auth" } } });
    expect(ungranted.message).toContain(`Mirror is not granted "Session" (it may reach: Counter)`);
    expect(load({ map: { Ghost: {} } }).code).toBe("UNKNOWN_MODULE");
  });

  test("an alias to a module the app does not have stops the server with both names", async () => {
    const base = tempDir();
    writePackage(join(base, "pkg"), (manifest) => {
      manifest.modules = manifest.modules.filter((m) => m.name === "Mirror");
      manifest.exports = ["Mirror"];
    });
    const loaded = loadWasmPackage("./pkg", {
      baseDir: base,
      grants: { Mirror: { reads: ["Counter"] } },
      map: { Mirror: { Counter: "Nowhere" } },
    });
    const app = new HypenApp();
    const entry = app.module("App").defineState({}).ui(`module App { Mirror {} }`);
    const server = new RemoteServer().app(app).module("App", entry).wasmModules(loaded.modules).components(loaded.components);
    const error = await server.prepare().then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(HostedModuleSetupError);
    expect((error as HostedModuleSetupError).code).toBe("UNKNOWN_GRANT_TARGET");
    expect((error as HostedModuleSetupError).message).toContain(
      `Hosted module "Mirror" is granted reads on "counter", which here means "nowhere", but the app has no module "nowhere"`
    );
  });

  test("wasmModule(): explicit aliases are validated where they are written", () => {
    const bytes = readFileSync(fixture("mirror_module.wasm"));
    const define = (grants: Parameters<typeof wasmModule>[0]["grants"]) =>
      setupError(() => wasmModule({ name: "Mirror", component: bytes, ui: MIRROR_UI, grants }));
    const twice = define({ reads: ["Cart"], aliases: { Cart: "a", cart: "b" } });
    expect(twice.code).toBe("NAMING_INVALID");
    expect(twice.message).toContain(`aliases "cart" twice, to "a" and to "b"`);
    const same = define({ reads: ["Cart", "Basket"], aliases: { Cart: "Basket" } });
    expect(same.message).toContain(`reads names "cart" and "basket", which both mean the module "basket"`);
    expect(define({ reads: ["Cart"], aliases: { Cart: "a:b" } }).message).toContain(`"a:b" cannot be a module`);
    expect(define({ aliases: ["x"] as never }).code).toBe("INVALID_OPTIONS");

    const ok = wasmModule({ name: "Mirror", component: bytes, ui: MIRROR_UI, grants: { reads: ["Cart"], aliases: { Cart: "Basket", Other: "Other" } } });
    // An alias of a name to itself is no alias.
    expect(ok.hosted.grants.aliases).toEqual({ cart: "basket" });
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
