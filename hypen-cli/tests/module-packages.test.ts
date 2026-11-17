/**
 * Module packages: the `hypen-modules.json` manifest, `hypen build --target
 * wasm` emitting it, `hypen pack`, `hypen add` / `remove` / `modules`,
 * `wasm.packages` in hypen.json (installed and `source` packages), consent,
 * drift and integrity.
 *
 * Components are the committed fixtures of hypen-engine-rs/tests/fixtures;
 * "module projects" here declare their modules prebuilt, so `hypen build
 * --target wasm` / `hypen pack` / a `source` package build run with no
 * toolchain at all. Package-manager tests use Bun offline (`file:` specs).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import {
  BuildError,
  PACKAGE_MANIFEST_FILE,
  ModulePackageError,
  addCommand,
  addPackage,
  asGrant,
  asRequests,
  buildWasm,
  capabilitiesOf,
  capabilityId,
  checkDeclaredImports,
  classifySpec,
  decideGrant,
  describeCapability,
  detectPackageManager,
  extractTarball,
  formatPackages,
  integrityOf,
  linkRequirements,
  listPackages,
  locateModulePackage,
  packProject,
  packageDrift,
  parseCapabilitySet,
  parseModuleName,
  parsePackageManifest,
  parseWasmConfig,
  readComponentImports,
  readModuleLock,
  readModulePackage,
  removeJsonPath,
  removePackage,
  resolveHosted,
  scriptedPrompter,
  setJsonPath,
  tarballOf,
  templateRefs,
} from "../src/build-wasm";
import { build as buildSpa } from "../src/build";
import { dev } from "../src/dev-bun";
import {
  COUNTER_UI,
  MIRROR_UI,
  STAMP_UI,
  countersPackage,
  fixture,
  haveFixtures,
  write,
  writeApp,
  writePackage,
} from "./helpers/module-package";

const CLI = join(import.meta.dir, "..", "bin", "hypen.ts");
const skip = !haveFixtures("counter_module.wasm", "mirror_module.wasm", "seeded_module.wasm", "deferred_http_module.wasm");

let root: string;
let n = 0;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hypen-packages-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
const fresh = (tag: string): string => {
  const dir = join(root, `${tag}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

async function failure(run: () => unknown): Promise<BuildError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof BuildError) return err;
    throw err;
  }
  throw new Error("expected a BuildError");
}

function packageError(run: () => unknown): ModulePackageError {
  try {
    run();
  } catch (err) {
    if (err instanceof ModulePackageError) return err;
    throw err;
  }
  throw new Error("expected a ModulePackageError");
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const silent = () => scriptedPrompter([], false);

/** An app with the counters package vendored at ./vendor/counters. */
function appWithPackage(tag: string, body = `Text("App: @{state.title}")\n    Mirror {}\n    Counter {}`, pkg = countersPackage()) {
  const dir = fresh(tag);
  writeApp(dir, body);
  writePackage(join(dir, "vendor/counters"), pkg);
  return dir;
}

// ---------------------------------------------------------------------------
// the manifest
// ---------------------------------------------------------------------------

describe.skipIf(skip)("hypen-modules.json: parse and verify", () => {
  test("a good package reads back typed, with absolute paths, sizes and verified integrity", () => {
    const dir = fresh("good");
    writePackage(dir, countersPackage());
    const pkg = readModulePackage(join(dir, PACKAGE_MANIFEST_FILE));
    expect(pkg.manifest).toMatchObject({ name: "@acme/counters", version: "1.2.0", entry: "Mirror", exports: ["Mirror", "Counter"] });
    expect(pkg.modules.map((m) => m.name)).toEqual(["Mirror", "Counter"]);
    expect(pkg.modules[0]!.componentPath).toBe(join(dir, "Mirror.wasm"));
    expect(pkg.modules[0]!.size).toBeGreaterThan(1000);
    expect({ ...pkg.modules[0]!.requests }).toEqual({ reads: ["Counter"], dispatches: ["Counter"], storage: [], http: false, httpHosts: [] });
    expect(pkg.components).toEqual([{ name: "Stamp", template: "Stamp.hypen", templatePath: join(dir, "Stamp.hypen") }]);
  });

  test("exports default to the entry; without an entry, to everything", () => {
    const base = { hypenModules: 1, name: "p", version: "1.0.0", modules: [{ name: "A", component: "A.wasm", integrity: `sha256-${"A".repeat(43)}=` }], components: [{ name: "B", template: "B.hypen" }] };
    expect(parsePackageManifest({ ...base, entry: "A" }, "m.json").exports).toEqual(["A"]);
    expect(parsePackageManifest(base, "m.json").exports).toEqual(["A", "B"]);
  });

  const cases: Array<[string, (m: any) => void, string, string | undefined]> = [
    ["a newer format version", (m) => (m.hypenModules = 2), "MANIFEST_VERSION_UNSUPPORTED", "hypenModules"],
    ["not a module manifest at all", (m) => delete m.hypenModules, "MANIFEST_INVALID", "hypenModules"],
    ["a component path that escapes the package", (m) => (m.modules[0].component = "../secret.wasm"), "MANIFEST_PATH_ESCAPES", "modules[0].component"],
    ["an absolute template path", (m) => (m.modules[0].template = "/etc/passwd"), "MANIFEST_PATH_ESCAPES", "modules[0].template"],
    ["a component template that escapes", (m) => (m.components[0].template = "a/../../x.hypen"), "MANIFEST_PATH_ESCAPES", "components[0].template"],
    ["a name that cannot be an engine scope", (m) => (m.modules[0].name = "a:b"), "MANIFEST_INVALID", "modules[0].name"],
    ["a reserved name", (m) => (m.components[0].name = "__hypen_x"), "MANIFEST_INVALID", "components[0].name"],
    ["two names that differ only by case", (m) => (m.components[0].name = "mirror"), "MANIFEST_INVALID", "components[0].name"],
    ["an unknown requested capability", (m) => (m.modules[0].requests.filesystem = true), "MANIFEST_INVALID", "modules[0].requests.filesystem"],
    ["a bad http host pattern", (m) => (m.modules[0].requests = { http: true, httpHosts: ["https://x.com/path"] }), "MANIFEST_INVALID", "modules[0].requests.httpHosts[0]"],
    ["httpHosts without http", (m) => (m.modules[0].requests = { httpHosts: ["x.com"] }), "MANIFEST_INVALID", "modules[0].requests.httpHosts"],
    ["an unknown storage tier", (m) => (m.modules[0].requests = { storage: ["disk"] }), "MANIFEST_INVALID", "modules[0].requests.storage"],
    ["a malformed integrity", (m) => (m.modules[0].integrity = "md5-abc"), "MANIFEST_INVALID", "modules[0].integrity"],
    ["an entry that names nothing", (m) => (m.entry = "Ghost"), "MANIFEST_INVALID", "entry"],
    ["an export that names nothing", (m) => (m.exports = ["Ghost"]), "MANIFEST_INVALID", "exports[0]"],
    ["no version", (m) => delete m.version, "MANIFEST_INVALID", "version"],
    ["an empty package", (m) => ((m.modules = []), (m.components = []), delete m.entry, delete m.exports), "MANIFEST_INVALID", "modules"],
  ];
  for (const [what, mutate, code, field] of cases) {
    test(`rejects ${what} (${code})`, () => {
      const dir = fresh("bad");
      writePackage(dir, countersPackage());
      const file = join(dir, PACKAGE_MANIFEST_FILE);
      const manifest = json(file);
      mutate(manifest);
      writeFileSync(file, JSON.stringify(manifest));
      const err = packageError(() => readModulePackage(file));
      expect(err.code).toBe(code as ModulePackageError["code"]);
      expect(err.field).toBe(field);
      expect(err.file).toBe(file);
      expect(err.hint).toBeTruthy();
    });
  }

  test("integrity: a component changed after the manifest was written is refused", () => {
    const dir = fresh("integrity");
    writePackage(dir, countersPackage());
    copyFileSync(fixture("seeded_module.wasm"), join(dir, "Mirror.wasm"));
    const err = packageError(() => readModulePackage(join(dir, PACKAGE_MANIFEST_FILE)));
    expect(err.code).toBe("INTEGRITY_MISMATCH");
    expect(err.module).toBe("Mirror");
    expect(err.message).toContain(integrityOf(readFileSync(fixture("seeded_module.wasm"))));
    expect(err.hint).toContain("do not edit the manifest to match");
  });

  test("a component that is not a Component, a missing file, a missing or unparsable manifest", () => {
    const dir = fresh("files");
    writePackage(dir, countersPackage());
    const file = join(dir, PACKAGE_MANIFEST_FILE);
    writeFileSync(join(dir, "Mirror.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    expect(packageError(() => readModulePackage(file))).toMatchObject({ code: "COMPONENT_INVALID", module: "Mirror" });
    rmSync(join(dir, "Mirror.wasm"));
    expect(packageError(() => readModulePackage(file))).toMatchObject({ code: "MODULE_FILE_MISSING", field: "modules[0].component" });
    writeFileSync(file, "{ not json");
    expect(packageError(() => readModulePackage(file)).code).toBe("MANIFEST_INVALID");
    expect(packageError(() => readModulePackage(join(dir, "nope.json"))).code).toBe("MANIFEST_NOT_FOUND");
  });

  test("locating a package: directory, npm package with the marker, and what is not a package", () => {
    const app = fresh("locate");
    writePackage(join(app, "vendor/c"), countersPackage());
    expect(locateModulePackage("./vendor/c", app)).toEqual({ kind: "path", manifestPath: join(app, "vendor/c", PACKAGE_MANIFEST_FILE) });
    writePackage(join(app, "node_modules/@acme/counters"), countersPackage({ npm: true }));
    expect(locateModulePackage("@acme/counters", app)).toMatchObject({ kind: "npm", packageVersion: "1.2.0" });
    // Found from a nested directory too (walks up).
    mkdirSync(join(app, "a/b"), { recursive: true });
    expect(locateModulePackage("@acme/counters", join(app, "a/b")).kind).toBe("npm");

    write(join(app, "node_modules/left-pad/package.json"), JSON.stringify({ name: "left-pad", version: "1.0.0" }));
    expect(packageError(() => locateModulePackage("left-pad", app))).toMatchObject({ code: "PACKAGE_NOT_HYPEN", package: "left-pad" });
    expect(packageError(() => locateModulePackage("@acme/missing", app)).code).toBe("PACKAGE_NOT_FOUND");
    expect(packageError(() => locateModulePackage("./nowhere", app)).code).toBe("MANIFEST_NOT_FOUND");
    // A package whose marker points outside its own directory.
    write(join(app, "node_modules/evil/package.json"), JSON.stringify({ name: "evil", hypen: { modules: "../../vendor/c/hypen-modules.json" } }));
    expect(packageError(() => locateModulePackage("evil", app))).toMatchObject({ code: "MANIFEST_PATH_ESCAPES", field: "hypen.modules" });
  });

  test("requests follow the same grammar as hypen.json grants", () => {
    const samples: Array<Record<string, unknown>> = [
      { reads: ["Cart"], dispatches: ["Cart", "cart"] },
      { storage: ["app", "cloud", "app"] },
      { http: true, httpHosts: ["API.example.com", "*.example.org:8443"] },
      { http: true },
      { storage: ["local"] },
      { storage: "app" },
      { http: "yes" },
      { httpHosts: ["x.com"] },
      { http: true, httpHosts: ["http://x.com"] },
      { reads: "Cart" },
    ];
    for (const sample of samples) {
      const parsed = parseCapabilitySet(sample, "x");
      let config: { reads: string[]; dispatches: string[]; storage: string[]; http: boolean; httpHosts: string[] } | null = null;
      try {
        const grants = parseWasmConfig({ modules: { M: sample } }).modules.get("M")!;
        config = { reads: grants.reads, dispatches: grants.dispatches, storage: grants.storage, http: grants.http, httpHosts: grants.httpHosts };
      } catch {
        config = null;
      }
      if (config === null) {
        expect("message" in parsed).toBe(true);
      } else {
        // The manifest additionally folds case-duplicate module names.
        expect(parsed).toMatchObject({ storage: config.storage, http: config.http, httpHosts: config.httpHosts });
      }
    }
  });
});

describe("capabilities: requests, grants, one rendering", () => {
  const requests = asRequests({ reads: ["Cart"], dispatches: ["Cart"], storage: ["cloud"], http: true, httpHosts: [] });

  test("ids and descriptions; the notable ones are flagged", () => {
    const caps = capabilitiesOf(requests);
    expect(caps.map(capabilityId)).toEqual(["reads:Cart", "dispatches:Cart", "storage:cloud", "http"]);
    expect(caps.map((c) => describeCapability(c))).toEqual([
      { text: "read the state of the Cart module", notable: null },
      { text: "dispatch actions to the Cart module", notable: "it can run Cart's action handlers" },
      { text: "read and write cloud storage (synced off this device)", notable: "data leaves the device" },
      { text: "make HTTP requests to any host", notable: "no host allowlist" },
    ]);
    expect(describeCapability({ kind: "http", hosts: ["api.acme.com"] })).toEqual({ text: "make HTTP requests to api.acme.com", notable: null });
  });

  test("a grant only ever comes from an explicit decision per capability", () => {
    const grant = decideGrant(requests, (c) => c.kind !== "http" && c.kind !== "dispatches");
    expect({ ...grant }).toEqual({ reads: ["Cart"], dispatches: [], storage: ["cloud"], http: false, httpHosts: [] });
    // Type-level: requests are not grants (and vice versa).
    // @ts-expect-error a ModuleRequests is not assignable to a ModuleGrant
    const wrong: ReturnType<typeof asGrant> = requests;
    void wrong;
  });

  test("drift: more requests, changed bytes, harmless updates", () => {
    const dir = fresh("drift-unit");
    writePackage(dir, countersPackage());
    const pkg = readModulePackage(join(dir, PACKAGE_MANIFEST_FILE));
    const locked = {
      name: "@acme/counters",
      version: "1.2.0",
      modules: Object.fromEntries(pkg.modules.map((m) => [m.name, { integrity: m.integrity, requests: m.requests }])),
    };
    expect(packageDrift(pkg, undefined)).toEqual({ status: "unrecorded" });
    expect(packageDrift(pkg, locked)).toEqual({ status: "current" });
    expect(packageDrift(pkg, { ...locked, version: "1.1.0" })).toEqual({ status: "updated", from: "1.1.0", to: "1.2.0" });
    const tampered = { ...locked, modules: { ...locked.modules, Mirror: { ...locked.modules.Mirror!, integrity: `sha256-${"B".repeat(43)}=` } } };
    expect(packageDrift(pkg, tampered)).toEqual({ status: "integrity", version: "1.2.0", modules: ["Mirror"] });
    const fewer = { ...locked, version: "1.1.0", modules: { ...locked.modules, Mirror: { ...locked.modules.Mirror!, requests: asRequests({ reads: ["Counter"], dispatches: [], storage: [], http: false, httpHosts: [] }) } } };
    expect(packageDrift(pkg, fewer)).toEqual({
      status: "requests",
      from: "1.1.0",
      to: "1.2.0",
      added: [{ module: "Mirror", capabilities: [{ kind: "dispatches", target: "Counter" }] }],
    });
  });
});

describe.skipIf(skip)("reading a component's imports from its bytes", () => {
  test("maps imports to link-time capabilities", () => {
    const of = (name: string) => linkRequirements(readComponentImports(readFileSync(fixture(name)))!);
    expect(of("counter_module.wasm")).toEqual({ storage: ["cloud"], http: null, engineState: false });
    expect(of("mirror_module.wasm")).toEqual({ storage: [], http: null, engineState: true });
    expect(of("deferred_http_module.wasm")).toMatchObject({ http: "hypen:http/deferred" });
    expect(of("seeded_module.wasm")).toEqual({ storage: [], http: null, engineState: false });
    expect(readComponentImports(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readComponentImports(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toBeNull();
  });

  test("build cross-check: an undeclared import is an error, an unused declaration a warning", async () => {
    const counter = readFileSync(fixture("counter_module.wasm"));
    const name = parseModuleName("Counter");
    const none = asRequests({ reads: [], dispatches: [], storage: [], http: false, httpHosts: [] });
    const err = await failure(() => checkDeclaredImports(name, counter, none));
    expect(err).toMatchObject({ code: "UNDECLARED_IMPORT", module: "Counter", field: "wasm.modules.Counter.storage" });
    expect(err.message).toContain("hypen:storage/cloud");
    expect(err.hint).toContain(`"storage": ["cloud"]`);

    const http = readFileSync(fixture("deferred_http_module.wasm"));
    expect(await failure(() => checkDeclaredImports(name, http, none))).toMatchObject({ code: "UNDECLARED_IMPORT", field: "wasm.modules.Counter.http" });

    const exact = asRequests({ reads: [], dispatches: [], storage: ["cloud"], http: false, httpHosts: [] });
    expect(checkDeclaredImports(name, counter, exact)).toEqual([]);
    const tooMuch = asRequests({ reads: ["Cart"], dispatches: [], storage: ["cloud", "app"], http: true, httpHosts: [] });
    const warnings = checkDeclaredImports(name, counter, tooMuch);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain(`declares storage "app" but its component does not import hypen:storage/app`);
    expect(warnings.join("\n")).toContain("declares http");
    expect(warnings.join("\n")).toContain("declares reads/dispatches");
  });
});

// ---------------------------------------------------------------------------
// build + pack
// ---------------------------------------------------------------------------

/**
 * A module project that needs no toolchain: its two stateful modules are
 * declared prebuilt, its `Stamp` is a template-only component. Building it
 * (`hypen build --target wasm`, `hypen pack`, or as a `source` package)
 * copies the components and writes app.json + hypen-modules.json.
 */
function moduleProject(dir: string, wasm: Record<string, unknown> = {}) {
  copyFileSync(fixture("mirror_module.wasm"), join(mkdirs(dir, "prebuilt"), "mirror.wasm"));
  copyFileSync(fixture("counter_module.wasm"), join(dir, "prebuilt", "counter.wasm"));
  write(join(dir, "ui/Mirror/component.hypen"), MIRROR_UI);
  write(join(dir, "ui/Counter/component.hypen"), COUNTER_UI);
  write(join(dir, "ui/Stamp/component.hypen"), STAMP_UI);
  write(join(dir, "package.json"), JSON.stringify({ name: "counters-src", version: "1.2.0", description: "from package.json", license: "MIT" }));
  write(
    join(dir, "hypen.json"),
    JSON.stringify(
      {
        components: "./ui",
        entry: "Mirror",
        wasm: {
          exports: ["Mirror", "Counter"],
          modules: {
            Mirror: { component: "./prebuilt/mirror.wasm", reads: ["Counter"], dispatches: ["Counter"] },
            Counter: { component: "./prebuilt/counter.wasm", storage: ["cloud"] },
          },
          ...wasm,
        },
      },
      null,
      2
    )
  );
  return dir;
}
function mkdirs(...parts: string[]): string {
  const dir = join(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const quietBuild = (dir: string) => {
  const cfg = json(join(dir, "hypen.json"));
  return buildWasm({ root: dir, components: cfg.components, entry: cfg.entry, wasm: cfg.wasm, log: () => {} });
};

describe.skipIf(skip)("hypen build --target wasm emits hypen-modules.json", () => {
  test("one manifest for the whole output: every module with its requests and integrity, the components, entry and exports", async () => {
    const dir = moduleProject(fresh("build"));
    await quietBuild(dir);
    const out = join(dir, "dist/wasm");
    expect(readdirSync(out).sort()).toEqual(["Counter.hypen", "Counter.wasm", "Mirror.hypen", "Mirror.wasm", "Stamp.hypen", "app.json", "hypen-modules.json"]);
    const manifest = json(join(out, PACKAGE_MANIFEST_FILE));
    expect(manifest).toEqual({
      hypenModules: 1,
      name: "counters-src",
      version: "1.2.0",
      description: "from package.json",
      entry: "Mirror",
      exports: ["Mirror", "Counter"],
      modules: [
        { name: "Mirror", component: "Mirror.wasm", template: "Mirror.hypen", abi: "0.1", requests: { reads: ["Counter"], dispatches: ["Counter"] }, integrity: integrityOf(readFileSync(fixture("mirror_module.wasm"))) },
        { name: "Counter", component: "Counter.wasm", template: "Counter.hypen", abi: "0.1", requests: { storage: ["cloud"] }, integrity: integrityOf(readFileSync(fixture("counter_module.wasm"))) },
      ],
      components: [{ name: "Stamp", template: "Stamp.hypen" }],
    });
    // The same build's app.json (for hypen-runtime) lists the same modules.
    expect(json(join(out, "app.json")).modules.map((m: any) => m.name)).toEqual(["Mirror", "Counter", "Stamp"]);
    // And it reads back as a verified package.
    expect(readModulePackage(join(out, PACKAGE_MANIFEST_FILE)).modules).toHaveLength(2);
  });

  test("name / version / description: hypen.json wasm.* wins over package.json; exports must exist", async () => {
    const dir = moduleProject(fresh("identity"), { name: "@acme/counters", version: "9.9.9" });
    await quietBuild(dir);
    expect(json(join(dir, "dist/wasm", PACKAGE_MANIFEST_FILE))).toMatchObject({ name: "@acme/counters", version: "9.9.9", description: "from package.json" });

    const bad = moduleProject(fresh("exports"), { exports: ["Ghost"] });
    expect(await failure(() => quietBuild(bad))).toMatchObject({ code: "CONFIG_UNKNOWN_MODULE", field: "wasm.exports" });
  });

  test("wasm.external: a target the installing app provides is requested, but not granted in this project's own app.json", async () => {
    const dir = moduleProject(fresh("external"));
    const cfg = json(join(dir, "hypen.json"));
    cfg.wasm.modules.Mirror.reads = ["Counter", "Cart"];
    writeFileSync(join(dir, "hypen.json"), JSON.stringify(cfg));
    const err = await failure(() => quietBuild(dir));
    expect(err).toMatchObject({ code: "CONFIG_UNKNOWN_MODULE", field: "wasm.modules.Mirror.reads" });
    expect(err.hint).toContain(`"wasm.external"`);

    cfg.wasm.external = ["Cart"];
    writeFileSync(join(dir, "hypen.json"), JSON.stringify(cfg));
    await quietBuild(dir);
    expect(json(join(dir, "dist/wasm", PACKAGE_MANIFEST_FILE)).modules[0].requests.reads).toEqual(["Counter", "Cart"]);
    expect(json(join(dir, "dist/wasm/app.json")).modules[0].reads).toEqual(["counter"]);
  });
});

describe.skipIf(skip)("hypen pack", () => {
  test("packs the whole build into one npm package directory, with a README of requested capabilities", async () => {
    const dir = moduleProject(fresh("pack"));
    const lines: string[] = [];
    const result = await packProject({ projectDir: dir, name: "@acme/counters", log: (l) => lines.push(l) });
    expect(result.dir).toBe(join(dir, "dist/pack"));
    expect(result.files).toEqual(["Counter.hypen", "Counter.wasm", "Mirror.hypen", "Mirror.wasm", "README.md", "Stamp.hypen", "hypen-modules.json", "package.json"]);
    const pkg = json(join(result.dir, "package.json"));
    expect(pkg).toMatchObject({ name: "@acme/counters", version: "1.2.0", license: "MIT", hypen: { modules: "hypen-modules.json" } });
    expect(pkg.scripts).toBeUndefined();
    expect(pkg.files).toContain("Mirror.wasm");
    expect(json(join(result.dir, PACKAGE_MANIFEST_FILE)).name).toBe("@acme/counters");
    const readme = readFileSync(join(result.dir, "README.md"), "utf8");
    expect(readme).toContain("hypen add @acme/counters");
    expect(readme).toContain("- dispatch actions to the Counter module — **it can run Counter's action handlers**");
    expect(readme).toContain("- read and write cloud storage (synced off this device) — **data leaves the device**");
    expect(readme).toContain("`Stamp` (internal)");
    expect(lines.join("\n")).toContain("hypen pack publishes nothing");
  });

  test("--only packs a closed subset; a subset whose template needs something left out is refused", async () => {
    const dir = moduleProject(fresh("pack-only"));
    const result = await packProject({ projectDir: dir, name: "counters-lite", only: ["Counter"], log: () => {} });
    expect(result.manifest.modules.map((m) => m.name)).toEqual(["Counter"]);
    expect(result.manifest.components).toEqual([]);
    expect(result.manifest.exports).toEqual(["Counter"]);
    expect(result.manifest.entry).toBeUndefined();
    // Mirror's template uses Stamp.
    const err = await failure(() => packProject({ projectDir: dir, name: "x", only: ["Mirror"], build: false, log: () => {} }));
    expect(err).toMatchObject({ code: "ONLY_INCOMPLETE", module: "Mirror" });
    expect(err.hint).toContain("--only Mirror,Stamp");
  });

  test("needs a valid npm name, and never replaces a directory it did not write", async () => {
    const dir = moduleProject(fresh("pack-name"), { name: "Not A Name" });
    expect(await failure(() => packProject({ projectDir: dir, log: () => {} }))).toMatchObject({ code: "PACK_NAME_MISSING", field: "wasm.npm" });
    write(join(dir, "dist/pack/notes.txt"), "mine");
    expect(await failure(() => packProject({ projectDir: dir, name: "ok-name", build: false, log: () => {} }))).toMatchObject({ code: "OUTDIR_UNSAFE" });
    expect(existsSync(join(dir, "dist/pack/notes.txt"))).toBe(true);
  });

  test("the packed directory installs with the package manager, offline, and `hypen add` finds it by its marker", async () => {
    const dir = moduleProject(fresh("pack-install"));
    const packed = await packProject({ projectDir: dir, name: "@acme/counters", log: () => {} });
    const app = fresh("pack-app");
    writeApp(app, `Mirror {}\n    Counter {}`);
    write(join(app, "package.json"), JSON.stringify({ name: "app", private: true }));
    const prompter = silent();
    const result = await addPackage({ projectDir: app, spec: `file:${packed.dir}`, yes: true, prompter });
    expect(result).toMatchObject({ from: "@acme/counters", name: "@acme/counters", version: "1.2.0", exports: ["Mirror", "Counter"] });
    expect(prompter.screen.join("\n")).toContain("bun add --ignore-scripts file:");
    expect(existsSync(join(app, "node_modules/@acme/counters/hypen-modules.json"))).toBe(true);
    expect(json(join(app, "package.json")).dependencies["@acme/counters"]).toContain("file:");
    expect(json(join(app, "hypen.json")).wasm.packages["@acme/counters"]).toEqual({
      grants: { Mirror: { reads: ["Counter"], dispatches: ["Counter"] }, Counter: { storage: ["cloud"] } },
    });
    // It loads.
    const hosted = resolveHosted(parseWasmConfig(json(join(app, "hypen.json")).wasm), app);
    expect(hosted.modules.map((m) => m.name)).toEqual(["Mirror", "Counter"]);

    // Removing it can take the dependency out too.
    const removed = await removePackage({ projectDir: app, target: "@acme/counters", uninstall: true, prompter: silent() });
    expect(removed).toMatchObject({ removedPackage: true, uninstalled: true });
    expect(json(join(app, "package.json")).dependencies?.["@acme/counters"]).toBeUndefined();
    expect(json(join(app, "hypen.json")).wasm).toBeUndefined();
    expect(existsSync(join(app, "hypen.lock.json"))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// hypen add
// ---------------------------------------------------------------------------

describe.skipIf(skip)("hypen add", () => {
  test("from a directory, non-interactive --yes: one hypen.json entry, the lock, and what to write in a template", async () => {
    const app = appWithPackage("add-dir");
    const before = readFileSync(join(app, "hypen.json"), "utf8");
    const prompter = silent();
    const result = await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter });
    expect(result).toMatchObject({ from: "./vendor/counters", modules: ["Mirror", "Counter"], components: ["Stamp"], exports: ["Mirror", "Counter"], updated: false });
    expect(result.granted.map((g) => g.id)).toEqual(["Mirror.reads:Counter", "Mirror.dispatches:Counter", "Counter.storage:cloud"]);

    // The file changed by exactly the inserted entry.
    const after = readFileSync(join(app, "hypen.json"), "utf8");
    expect(after).toBe(
      before.replace(
        `  "port": 3000\n}`,
        `  "port": 3000,\n  "wasm": {\n    "packages": {\n      "./vendor/counters": {\n        "grants": {\n          "Mirror": {\n            "reads": ["Counter"],\n            "dispatches": ["Counter"]\n          },\n          "Counter": {\n            "storage": ["cloud"]\n          }\n        }\n      }\n    }\n  }\n}`
      )
    );
    const lock = readModuleLock(app);
    expect(Object.keys(lock)).toEqual(["./vendor/counters"]);
    expect(lock["./vendor/counters"]).toMatchObject({ name: "@acme/counters", version: "1.2.0" });
    expect(Object.keys(lock["./vendor/counters"]!.modules)).toEqual(["Counter", "Mirror"]);

    const screen = prompter.screen.join("\n");
    expect(screen).toContain("@acme/counters 1.2.0");
    expect(screen).toContain("2 modules, 1 template-only component");
    expect(screen).toContain("read the state of the Counter module (same package)");
    expect(screen).toContain("dispatch actions to the Counter module (same package)  ! it can run Counter's action handlers");
    expect(screen).toContain("read and write cloud storage (synced off this device)  ! data leaves the device");
    expect(screen).toContain("Stamp template-only component");
    expect(screen).toContain("Use it:   Mirror {}, Counter {} in a template");
  });

  test("keeps the file's own formatting and key order", async () => {
    const app = appWithPackage("add-format");
    const original = `{\n\t"entry": "App",\n\n\t"components": "./src/components",\n\t"wasm": { "language": "ts" },\n\t"port": 3000\n}\n`;
    writeFileSync(join(app, "hypen.json"), original);
    await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() });
    const after = readFileSync(join(app, "hypen.json"), "utf8");
    expect(after.startsWith(`{\n\t"entry": "App",\n\n\t"components": "./src/components",\n\t"wasm": { "language": "ts",\n\t"packages": {\n\t\t"./vendor/counters": {`)).toBe(true);
    expect(after.endsWith(`},\n\t"port": 3000\n}\n`)).toBe(true);
    expect(JSON.parse(after).wasm.language).toBe("ts");
  });

  test("non-interactive without flags fails and lists the flags; nothing is written", async () => {
    const app = appWithPackage("add-noflags");
    const before = readFileSync(join(app, "hypen.json"), "utf8");
    const err = await failure(() => addPackage({ projectDir: app, spec: "./vendor/counters", prompter: silent() }));
    expect(err.code).toBe("CONSENT_REQUIRED");
    expect(err.message).toContain("Mirror.reads:Counter, Mirror.dispatches:Counter, Counter.storage:cloud");
    expect(err.hint).toContain("--yes");
    expect(err.hint).toContain("--grant Mirror.reads:Counter");
    expect(readFileSync(join(app, "hypen.json"), "utf8")).toBe(before);
    expect(existsSync(join(app, "hypen.lock.json"))).toBe(false);
  });

  test("--grant / --deny decide capability by capability; a module name or a kind selects several", async () => {
    const app = appWithPackage("add-flags");
    const result = await addPackage({
      projectDir: app,
      spec: "./vendor/counters",
      grant: ["Mirror.reads", "Counter"],
      deny: ["Mirror.dispatches:Counter"],
      prompter: silent(),
    });
    expect(result.granted.map((g) => g.id)).toEqual(["Mirror.reads:Counter", "Counter.storage:cloud"]);
    expect(result.withheld.map((g) => g.id)).toEqual(["Mirror.dispatches:Counter"]);
    expect(json(join(app, "hypen.json")).wasm.packages["./vendor/counters"].grants).toEqual({
      Mirror: { reads: ["Counter"] },
      Counter: { storage: ["cloud"] },
    });

    // --deny wins over --yes; a flag that matches nothing is an error.
    const app2 = appWithPackage("add-flags2");
    const r2 = await addPackage({ projectDir: app2, spec: "./vendor/counters", yes: true, deny: ["dispatches"], prompter: silent() });
    expect(r2.withheld.map((g) => g.id)).toEqual(["Mirror.dispatches:Counter"]);
    const err = await failure(() => addPackage({ projectDir: app2, spec: "./vendor/counters", grant: ["Mirror.http"], prompter: silent() }));
    expect(err.code).toBe("FLAG_INVALID");
    expect(err.hint).toContain("Mirror.reads:Counter");
  });

  test("a module that cannot start without a withheld link-time capability is refused, with the two ways out", async () => {
    const app = appWithPackage("add-startable");
    const err = await failure(() =>
      addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, deny: ["Counter.storage:cloud"], prompter: silent() })
    );
    expect(err).toMatchObject({ code: "UNGRANTED_IMPORT", module: "Counter" });
    expect(err.hint).toContain("--grant Counter.storage:cloud");
    expect(err.hint).toContain("--only Mirror");
    expect(json(join(app, "hypen.json")).wasm).toBeUndefined();
  });

  test("interactive: accept all", async () => {
    const app = appWithPackage("add-tty-all");
    const prompter = scriptedPrompter(["a"]);
    const result = await addPackage({ projectDir: app, spec: "./vendor/counters", prompter });
    expect(result.granted).toHaveLength(3);
    expect(prompter.screen.join("\n")).toContain("Grant: [a] all of the above   [m] choose per module   [c] choose per capability   [n] cancel");
  });

  test("interactive: per module, per capability, and cancel", async () => {
    const perModule = appWithPackage("add-tty-m");
    const m = scriptedPrompter(["m", "y", "y"]);
    expect((await addPackage({ projectDir: perModule, spec: "./vendor/counters", prompter: m })).granted).toHaveLength(3);
    expect(m.screen.join("\n")).toContain("Grant Mirror everything it requests (reads:Counter, dispatches:Counter)? [y/N] y");

    const perCap = appWithPackage("add-tty-c");
    const c = scriptedPrompter(["c", "y", "n", "y"]);
    const result = await addPackage({ projectDir: perCap, spec: "./vendor/counters", prompter: c });
    expect(result.granted.map((g) => g.id)).toEqual(["Mirror.reads:Counter", "Counter.storage:cloud"]);
    expect(c.screen.join("\n")).toContain("Let Mirror dispatch actions to the Counter module? [y/N] n");
    expect(c.screen.join("\n")).toContain("Withheld: Mirror.dispatches:Counter");

    const cancelled = appWithPackage("add-tty-n");
    const before = readFileSync(join(cancelled, "hypen.json"), "utf8");
    const err = await failure(() => addPackage({ projectDir: cancelled, spec: "./vendor/counters", prompter: scriptedPrompter(["n"]) }));
    expect(err.code).toBe("CANCELLED");
    expect(readFileSync(join(cancelled, "hypen.json"), "utf8")).toBe(before);
  });

  test("a requested target the app does not have is surfaced and never granted; one it has is", async () => {
    const lonely = countersPackage({
      name: "@acme/pricing",
      entry: "Mirror",
      exports: ["Mirror"],
      modules: [{ name: "Mirror", wasm: "mirror_module.wasm", template: `module Mirror {\n  Text("Seen: @{state.seen}")\n}`, requests: { reads: ["Counter"], dispatches: ["Counter"] } }],
      components: [],
    });
    const app = appWithPackage("add-target", `Mirror {}`, lonely);
    const prompter = silent();
    const result = await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter });
    expect(result.granted).toEqual([]);
    expect(result.withheld.map((w) => [w.id, w.status])).toEqual([
      ["Mirror.reads:Counter", "missing"],
      ["Mirror.dispatches:Counter", "missing"],
    ]);
    expect(prompter.screen.join("\n")).toContain("read the state of the Counter module — this app has no `Counter` module, so this cannot be granted");
    expect(json(join(app, "hypen.json")).wasm.packages["./vendor/counters"]).toEqual({});

    // Give the app a Counter module of its own: now it resolves, and is granted.
    write(join(app, "src/components/Counter/component.hypen"), `module Counter {\n  Text("mine")\n}`);
    write(join(app, "src/components/Counter/component.ts"), `export default {};`);
    const again = await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() });
    expect(again.updated).toBe(true);
    expect(again.granted.map((g) => [g.id, g.status])).toEqual([
      ["Mirror.reads:Counter", "app"],
      ["Mirror.dispatches:Counter", "app"],
    ]);
  });

  test("--only installs a closed subset; one that leaves out what a template needs is refused", async () => {
    const app = appWithPackage("add-only", `Counter {}`);
    const result = await addPackage({ projectDir: app, spec: "./vendor/counters", only: ["Counter"], yes: true, prompter: silent() });
    expect(result).toMatchObject({ modules: ["Counter"], components: [], exports: ["Counter"] });
    expect(json(join(app, "hypen.json")).wasm.packages["./vendor/counters"]).toEqual({ only: ["Counter"], grants: { Counter: { storage: ["cloud"] } } });
    expect(Object.keys(readModuleLock(app)["./vendor/counters"]!.modules)).toEqual(["Counter"]);

    const app2 = appWithPackage("add-only2");
    expect(await failure(() => addPackage({ projectDir: app2, spec: "./vendor/counters", only: ["Mirror"], yes: true, prompter: silent() }))).toMatchObject({
      code: "ONLY_INCOMPLETE",
    });
    expect(await failure(() => addPackage({ projectDir: app2, spec: "./vendor/counters", only: ["Ghost"], yes: true, prompter: silent() }))).toMatchObject({
      code: "UNKNOWN_PACKAGE_MODULE",
    });
  });

  test("name collisions with the app are errors that say how to resolve them", async () => {
    // The app has its own Counter component; the package's Counter is read by its sibling, so it cannot be renamed.
    const app = appWithPackage("add-collide");
    write(join(app, "src/components/Counter/component.hypen"), `Text("mine")`);
    const err = await failure(() => addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() }));
    expect(err).toMatchObject({ code: "MODULE_NAME_COLLISION", module: "Counter" });
    expect(err.message).toContain(`the app has its own "Counter"`);
    expect(json(join(app, "hypen.json")).wasm).toBeUndefined();
    expect(await failure(() => addPackage({ projectDir: app, spec: "./vendor/counters", as: ["Counter=Tally"], yes: true, prompter: silent() }))).toMatchObject({
      code: "RENAME_UNSOUND",
    });

    // A template-only component of the package that collides cannot be renamed either.
    const app2 = appWithPackage("add-collide2");
    write(join(app2, "src/components/Stamp/component.hypen"), `Text("mine")`);
    const err2 = await failure(() => addPackage({ projectDir: app2, spec: "./vendor/counters", yes: true, prompter: silent() }));
    expect(err2).toMatchObject({ code: "MODULE_NAME_COLLISION", module: "Stamp" });
    expect(err2.hint).toContain("rename the app's own Stamp");
  });

  test("--as renames an exported module nothing else in the package refers to", async () => {
    // The app already has a Mirror; the package's Mirror is exported and unreferenced by its sibling.
    const app = appWithPackage("add-as", `Looking {}\n    Counter {}`);
    write(join(app, "src/components/Mirror/component.hypen"), `Text("the app's own Mirror")`);
    const collision = await failure(() => addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() }));
    expect(collision.code).toBe("MODULE_NAME_COLLISION");
    expect(collision.hint).toContain("--as Mirror=<NewName>");

    const result = await addPackage({ projectDir: app, spec: "./vendor/counters", as: ["Mirror=Looking"], yes: true, prompter: silent() });
    expect(result.modules).toEqual(["Looking", "Counter"]);
    expect(result.exports).toEqual(["Looking", "Counter"]);
    expect(json(join(app, "hypen.json")).wasm.packages["./vendor/counters"].as).toEqual({ Mirror: "Looking" });
    // Grants stay keyed by the module's name in the package.
    expect(json(join(app, "hypen.json")).wasm.packages["./vendor/counters"].grants.Mirror).toEqual({ reads: ["Counter"], dispatches: ["Counter"] });
    // Loaded under the new name, with its template's `module` declaration renamed.
    const hosted = resolveHosted(parseWasmConfig(json(join(app, "hypen.json")).wasm), app, { componentsDir: join(app, "src/components") });
    const looking = hosted.modules.find((m) => m.name === "Looking")!;
    expect(looking.template!.startsWith("module Looking {")).toBe(true);
    expect(looking.package).toMatchObject({ name: "Mirror", from: "./vendor/counters" });

    // An internal name, or a malformed flag, is refused.
    expect(await failure(() => addPackage({ projectDir: app, spec: "./vendor/counters", as: ["Stamp=Seal"], yes: true, prompter: silent() }))).toMatchObject({ code: "RENAME_UNSOUND" });
    expect(await failure(() => addPackage({ projectDir: app, spec: "./vendor/counters", as: ["Mirror"], yes: true, prompter: silent() }))).toMatchObject({ code: "FLAG_INVALID" });
  });

  test("two packages cannot bring the same name", async () => {
    const app = appWithPackage("add-two");
    await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() });
    writePackage(join(app, "vendor/other"), countersPackage({ name: "@acme/other" }));
    const err = await failure(() => addPackage({ projectDir: app, spec: "./vendor/other", yes: true, prompter: silent() }));
    expect(err).toMatchObject({ code: "MODULE_NAME_COLLISION" });
    expect(err.message).toContain("./vendor/counters");
    expect(err.message).toContain("./vendor/other");
    expect(Object.keys(json(join(app, "hypen.json")).wasm.packages)).toEqual(["./vendor/counters"]);
  });

  test("specs: what each kind of argument is", () => {
    const app = appWithPackage("spec");
    const config = parseWasmConfig({ packages: { "@acme/installed": {} } });
    write(join(app, "pkg.tgz"), "x");
    expect(classifySpec("./vendor/counters", app, config)).toEqual({ kind: "dir", path: join(app, "vendor/counters") });
    expect(classifySpec("vendor/counters/hypen-modules.json", app, config)).toEqual({ kind: "manifest", path: join(app, "vendor/counters/hypen-modules.json") });
    expect(classifySpec("pkg.tgz", app, config)).toEqual({ kind: "tarball", path: join(app, "pkg.tgz") });
    expect(classifySpec("@acme/checkout@^1.2", app, config)).toEqual({ kind: "npm", spec: "@acme/checkout@^1.2" });
    expect(classifySpec("file:../x", app, config)).toEqual({ kind: "npm", spec: "file:../x" });
    expect(classifySpec("@acme/installed", app, config)).toEqual({ kind: "installed", from: "@acme/installed" });
  });

  test("bad paths: nothing there, not a package, not a project, unparsable or unwritable config", async () => {
    const app = appWithPackage("add-bad");
    expect(await failure(() => addPackage({ projectDir: app, spec: "./nope", yes: true, prompter: silent() }))).toMatchObject({ code: "SPEC_NOT_FOUND" });
    expect(await failure(() => addPackage({ projectDir: app, spec: "", yes: true, prompter: silent() }))).toMatchObject({ code: "SPEC_NOT_FOUND" });
    expect(await failure(() => addPackage({ projectDir: app, spec: "./src", yes: true, prompter: silent() }))).toMatchObject({ code: "PACKAGE_NOT_HYPEN" });
    expect(await failure(() => addPackage({ projectDir: fresh("empty"), spec: "./x", yes: true, prompter: silent() }))).toMatchObject({ code: "CONFIG_INVALID" });

    // hypen.lock.json cannot be written (something else is in its place): hypen.json is written first only if both can be.
    mkdirSync(join(app, "hypen.lock.json", "x"), { recursive: true });
    const unwritable = await failure(() => addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() }));
    expect(["CONFIG_NOT_WRITABLE", "LOCK_INVALID"]).toContain(unwritable.code);
    rmSync(join(app, "hypen.lock.json"), { recursive: true });

    writeFileSync(join(app, "hypen.json"), `{ "entry": "App", }`);
    const unparsable = await failure(() => addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() }));
    expect(unparsable).toMatchObject({ code: "CONFIG_INVALID", file: join(app, "hypen.json") });
    expect(unparsable.hint).toContain("plain JSON");

    writeFileSync(join(app, "hypen.json"), `{ "entry": "App", "wasm": [] }`);
    expect(await failure(() => addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("a package manager that fails: its stderr is shown and hypen.json is untouched", async () => {
    const app = appWithPackage("add-pm");
    write(join(app, "package.json"), JSON.stringify({ name: "app" }));
    write(join(app, "yarn.lock"), "");
    expect(detectPackageManager(app)).toBe("yarn");
    expect(addCommand("yarn", "x", app)).toEqual(["yarn", "add", "--ignore-scripts", "x"]);
    expect(addCommand("npm", "x", app)).toContain("--ignore-scripts");
    expect(addCommand("pnpm", "x", app)).toContain("--ignore-scripts");
    expect(addCommand("bun", "x", app)).toContain("--ignore-scripts");
    const bin = join(fresh("fake-bin"));
    write(join(bin, "yarn"), `#!/bin/sh\necho "error Couldn't find package \\"@acme/nope\\" on the registry." >&2\nexit 1\n`);
    chmodSync(join(bin, "yarn"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    try {
      const err = await failure(() => addPackage({ projectDir: app, spec: "@acme/nope", yes: true, prompter: silent() }));
      expect(err.code).toBe("TOOL_FAILED");
      expect(err.tool?.command).toEqual(["yarn", "add", "--ignore-scripts", "@acme/nope"]);
      expect(err.tool?.stderrTail).toContain("Couldn't find package");
    } finally {
      process.env.PATH = path;
    }
    expect(json(join(app, "hypen.json")).wasm).toBeUndefined();
  });

  test("an installed npm package without a Hypen manifest says so (and that the dependency stays)", async () => {
    const app = appWithPackage("add-nothypen");
    write(join(app, "package.json"), JSON.stringify({ name: "app" }));
    const plain = fresh("plain-pkg");
    write(join(plain, "package.json"), JSON.stringify({ name: "plain-pkg", version: "1.0.0" }));
    const err = await failure(() => addPackage({ projectDir: app, spec: `file:${plain}`, yes: true, prompter: silent() }));
    expect(err.code).toBe("PACKAGE_NOT_HYPEN");
    expect(err.detail.join("\n")).toContain("plain-pkg was added to package.json but is NOT used by hypen.json");
  }, 60_000);
});

describe.skipIf(skip)("hypen add <tarball>", () => {
  /** A .tgz of the counters package the way `npm pack` lays it out. */
  function tarball(dir: string, extra: Parameters<typeof tarballOf>[0] = []): string {
    const src = fresh("tar-src");
    writePackage(src, countersPackage({ npm: true }));
    const files = readdirSync(src).map((f) => ({ path: `package/${f}`, data: new Uint8Array(readFileSync(join(src, f))) }));
    const path = join(dir, "acme-counters-1.2.0.tgz");
    writeFileSync(path, tarballOf([...files, ...extra]));
    return path;
  }

  test("is extracted into a fresh directory under hypen_modules/ and installed from there", async () => {
    const app = fresh("tar-app");
    writeApp(app, `Mirror {}\n    Counter {}`);
    const prompter = silent();
    const result = await addPackage({ projectDir: app, spec: tarball(app), yes: true, prompter });
    expect(result.from).toBe("./hypen_modules/acme-counters");
    expect(readdirSync(join(app, "hypen_modules"))).toEqual(["acme-counters"]);
    expect(existsSync(join(app, "hypen_modules/acme-counters/Mirror.wasm"))).toBe(true);
    expect(prompter.screen.join("\n")).toContain("Extracted acme-counters-1.2.0.tgz → ./hypen_modules/acme-counters (commit this directory)");
    expect(resolveHosted(parseWasmConfig(json(join(app, "hypen.json")).wasm), app).modules).toHaveLength(2);
  });

  test("zip-slip: an entry that escapes the extraction directory is refused before anything is written", async () => {
    const app = fresh("tar-slip");
    writeApp(app);
    for (const evil of ["../../outside.txt", "package/../../outside.txt", "/tmp/hypen-abs-evil.txt"]) {
      const path = tarball(app, [{ path: evil, data: "pwned" }]);
      const err = await failure(() => addPackage({ projectDir: app, spec: path, yes: true, prompter: silent() }));
      expect(err.code).toBe("TARBALL_UNSAFE");
      expect(err.message).toContain(evil);
    }
    expect(existsSync(join(app, "outside.txt"))).toBe(false);
    expect(existsSync(join(app, "..", "outside.txt"))).toBe(false);
    expect(existsSync("/tmp/hypen-abs-evil.txt")).toBe(false);
    // Nothing half-extracted is left behind.
    expect(readdirSync(join(app, "hypen_modules"))).toEqual([]);
    expect(json(join(app, "hypen.json")).wasm).toBeUndefined();
  });

  test("links are refused; garbage is not a tarball; extraction never merges into an existing directory", async () => {
    const app = fresh("tar-link");
    writeApp(app);
    const link = tarball(app, [{ path: "package/escape", data: "", type: "2", link: "/etc" }]);
    expect(await failure(() => addPackage({ projectDir: app, spec: link, yes: true, prompter: silent() }))).toMatchObject({ code: "TARBALL_UNSAFE" });
    write(join(app, "bad.tgz"), "definitely not gzip");
    expect(await failure(() => addPackage({ projectDir: app, spec: "./bad.tgz", yes: true, prompter: silent() }))).toMatchObject({ code: "TARBALL_INVALID" });

    const target = join(fresh("tar-existing"), "there");
    mkdirSync(target);
    expect(await failure(() => extractTarball(tarball(app), target))).toMatchObject({ code: "CONFIG_NOT_WRITABLE" });
  });
});

// ---------------------------------------------------------------------------
// remove / modules / drift
// ---------------------------------------------------------------------------

describe.skipIf(skip)("hypen remove, hypen modules", () => {
  test("modules lists by package: granted, requested, withheld, exports", async () => {
    const app = appWithPackage("list");
    expect(formatPackages(listPackages(app)).join("\n")).toContain("No hosted modules");
    await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, deny: ["Mirror.dispatches"], prompter: silent() });
    const listed = listPackages(app);
    expect(listed).toEqual([
      {
        from: "./vendor/counters",
        kind: "installed",
        name: "@acme/counters",
        version: "1.2.0",
        status: "current",
        problem: undefined,
        modules: [
          { name: "Mirror", granted: ["reads:Counter"], requested: ["reads:Counter", "dispatches:Counter"], withheld: ["dispatches:Counter"] },
          { name: "Counter", granted: ["storage:cloud"], requested: ["storage:cloud"], withheld: [] },
        ],
        components: ["Stamp"],
        exports: ["Mirror", "Counter"],
      },
    ]);
    const text = formatPackages(listed).join("\n");
    expect(text).toContain("./vendor/counters (@acme/counters) 1.2.0  current");
    expect(text).toContain("withheld:  dispatches:Counter");
    expect(text).toContain("use: Mirror {}, Counter {}");
  });

  test("remove a package: the entry and the lock record go, the files stay", async () => {
    const app = appWithPackage("remove");
    const before = readFileSync(join(app, "hypen.json"), "utf8");
    await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() });
    const prompter = silent();
    const result = await removePackage({ projectDir: app, target: "./vendor/counters", prompter });
    expect(result).toEqual({ from: "./vendor/counters", removedPackage: true, removed: ["Mirror", "Counter", "Stamp"], uninstalled: false });
    // Byte for byte what it was before the add.
    expect(readFileSync(join(app, "hypen.json"), "utf8")).toBe(before);
    expect(existsSync(join(app, "hypen.lock.json"))).toBe(false);
    expect(existsSync(join(app, "vendor/counters/Mirror.wasm"))).toBe(true);
    expect(prompter.screen.join("\n")).toContain("The files at ./vendor/counters were left in place");

    expect(await failure(() => removePackage({ projectDir: app, target: "./vendor/counters", prompter: silent() }))).toMatchObject({ code: "NOT_INSTALLED" });
  });

  test("remove one module: allowed when nothing that stays uses it", async () => {
    const app = appWithPackage("remove-one");
    await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() });
    // Mirror's template uses Stamp: Stamp cannot go while Mirror stays.
    expect(await failure(() => removePackage({ projectDir: app, target: "Stamp", prompter: silent() }))).toMatchObject({ code: "ONLY_INCOMPLETE" });
    const result = await removePackage({ projectDir: app, target: "Mirror", prompter: silent() });
    expect(result).toMatchObject({ removedPackage: false, removed: ["Mirror"] });
    const entry = json(join(app, "hypen.json")).wasm.packages["./vendor/counters"];
    expect(entry).toEqual({ grants: { Counter: { storage: ["cloud"] } }, only: ["Counter", "Stamp"] });
    expect(Object.keys(readModuleLock(app)["./vendor/counters"]!.modules)).toEqual(["Counter"]);
  });

  test("json edits: remove prunes empty parents, set creates missing ones", () => {
    const text = `{\n  "a": 1,\n  "wasm": {\n    "packages": {\n      "x": {}\n    }\n  }\n}\n`;
    expect(removeJsonPath(text, ["wasm", "packages", "x"], 1)).toBe(`{\n  "a": 1,\n  "wasm": {}\n}\n`);
    expect(removeJsonPath(text, ["wasm", "packages", "x"], 0)).toBe(`{\n  "a": 1\n}\n`);
    expect(removeJsonPath(text, ["wasm", "nope"])).toBe(text);
    expect(JSON.parse(setJsonPath(`{}`, ["wasm", "packages", "x"], { only: ["A"] }))).toEqual({ wasm: { packages: { x: { only: ["A"] } } } });
    expect(setJsonPath(text, ["a"], 2)).toBe(text.replace(`"a": 1`, `"a": 2`));
  });
});

describe.skipIf(skip)("drift: the grant is a recorded decision", () => {
  async function installed(tag: string) {
    const app = appWithPackage(tag);
    await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() });
    const load = () => resolveHosted(parseWasmConfig(json(join(app, "hypen.json")).wasm), app, { componentsDir: join(app, "src/components") });
    return { app, load, manifestFile: join(app, "vendor/counters", PACKAGE_MANIFEST_FILE) };
  }

  test("a package that now requests more stops the load until it is reviewed again", async () => {
    const { app, load, manifestFile } = await installed("drift");
    expect(load().notes).toEqual([]);
    const manifest = json(manifestFile);
    manifest.version = "1.3.0";
    manifest.modules[0].requests = { ...manifest.modules[0].requests, http: true, httpHosts: ["api.acme.com"] };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    const err = await failure(load);
    expect(err.code).toBe("REQUESTS_CHANGED");
    expect(err.message).toBe(
      "./vendor/counters 1.3.0: Mirror now also requests: make HTTP requests to api.acme.com. Review and run `hypen add ./vendor/counters` to update the grant."
    );
    expect(err.hint).toContain("reviewed at 1.2.0");
    expect(listPackages(app)[0]).toMatchObject({ status: "requests more than was reviewed (1.2.0 → 1.3.0)" });

    // Reviewing it again shows what is new and records the decision.
    const prompter = scriptedPrompter(["c", "y", "y", "n", "y"]);
    const result = await addPackage({ projectDir: app, spec: "./vendor/counters", prompter });
    expect(result.updated).toBe(true);
    const screen = prompter.screen.join("\n");
    expect(screen).toContain("@acme/counters 1.3.0 (reviewed: 1.2.0)");
    expect(screen).toContain("make HTTP requests to api.acme.com  NEW");
    expect(result.withheld.map((w) => w.id)).toEqual(["Mirror.http"]);
    expect(load().modules).toHaveLength(2);
    expect(readModuleLock(app)["./vendor/counters"]!.version).toBe("1.3.0");
  });

  test("a version bump that asks for nothing new loads, with a note", async () => {
    const { load, manifestFile } = await installed("drift-ok");
    const manifest = json(manifestFile);
    manifest.version = "1.2.1";
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    expect(load().notes).toEqual([
      "./vendor/counters changed since it was reviewed (1.2.0 → 1.2.1) without asking for anything new; run `hypen add ./vendor/counters --yes` to record it",
    ]);
  });

  test("integrity: bytes swapped under the reviewed version are refused, with or without a matching manifest", async () => {
    const { app, load, manifestFile } = await installed("drift-bytes");
    // The .wasm alone changes: it no longer matches its own manifest.
    copyFileSync(fixture("seeded_module.wasm"), join(app, "vendor/counters/Mirror.wasm"));
    expect(await failure(load)).toMatchObject({ code: "INTEGRITY_MISMATCH", module: "Mirror" });
    // The manifest is "fixed up" to match: now it no longer matches what was reviewed.
    const manifest = json(manifestFile);
    manifest.modules[0].integrity = integrityOf(readFileSync(fixture("seeded_module.wasm")));
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const err = await failure(load);
    expect(err.code).toBe("INTEGRITY_MISMATCH");
    expect(err.message).toContain("is not the one that was reviewed (same version, different bytes)");
    expect(listPackages(app)[0]!.problem).toContain("not the bytes that were reviewed");
  });

  test("a package in hypen.json that was never reviewed, a grant for a link-time capability removed by hand", async () => {
    const { app, load } = await installed("drift-unrecorded");
    rmSync(join(app, "hypen.lock.json"));
    const unrecorded = await failure(load);
    expect(unrecorded).toMatchObject({ code: "NOT_RECORDED", field: `wasm.packages["./vendor/counters"]` });
    expect(unrecorded.hint).toContain("hypen add ./vendor/counters");

    await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() });
    const cfg = json(join(app, "hypen.json"));
    delete cfg.wasm.packages["./vendor/counters"].grants.Counter;
    writeFileSync(join(app, "hypen.json"), JSON.stringify(cfg, null, 2));
    const ungranted = await failure(load);
    expect(ungranted).toMatchObject({
      code: "UNGRANTED_IMPORT",
      module: "Counter",
      field: `wasm.packages["./vendor/counters"].grants.Counter.storage`,
    });
    expect(ungranted.hint).toContain("hypen add ./vendor/counters --grant Counter.storage:cloud");
    expect(ungranted.hint).toContain(`"storage": ["cloud"]`);
  });

  test("a grant for a module the package does not install, and config mistakes, name the field", async () => {
    const { app, load } = await installed("drift-config");
    const cfg = json(join(app, "hypen.json"));
    cfg.wasm.packages["./vendor/counters"].grants.mirror = {};
    writeFileSync(join(app, "hypen.json"), JSON.stringify(cfg));
    const err = await failure(load);
    expect(err).toMatchObject({ code: "CONFIG_UNKNOWN_MODULE", field: `wasm.packages["./vendor/counters"].grants.mirror` });
    expect(err.message).toContain(`did you mean "Mirror"?`);

    const bad = (pkg: unknown) => failure(() => parseWasmConfig({ packages: { "@acme/x": pkg } }));
    expect(await bad({ trust: "requested" })).toMatchObject({ code: "CONFIG_INVALID", field: `wasm.packages["@acme/x"].trust` });
    expect(await bad({ fallback: "./x" })).toMatchObject({ code: "CONFIG_INVALID", field: `wasm.packages["@acme/x"].fallback` });
    expect(await bad({ grant: {} })).toMatchObject({ code: "CONFIG_INVALID", field: `wasm.packages["@acme/x"].grant` });
    expect((await bad({ grant: {} })).hint).toContain("grants");
    expect(await bad({ grants: { A: { component: "./a.wasm" } } })).toMatchObject({ field: `wasm.packages["@acme/x"].grants.A.component` });
  });

  test("the app's templates may use only what a package exports", async () => {
    const { app, load } = await installed("exports");
    write(join(app, "src/components/App/component.hypen"), `module App {\n  Column {\n    Mirror {}\n    Stamp()\n  }\n}`);
    const err = await failure(load);
    expect(err).toMatchObject({ code: "NOT_EXPORTED", module: "Stamp" });
    expect(err.message).toContain("which ./vendor/counters does not export (it exports: Mirror, Counter)");
  });

  test("templateRefs sees tags, not strings, comments, or the declared name", () => {
    expect([...templateRefs(`module App {\n  // Hidden {}\n  Column {\n    Text("Not {} @{state.Title}")\n    Cart {}\n    Header()\n    Divider\n  }.color(Red)\n}`)].sort()).toEqual(
      ["Cart", "Column", "Divider", "Header", "Red", "Text"]
    );
  });

  test("the browser SPA build refuses an app with module packages", async () => {
    const { app } = await installed("spa");
    const err = await failure(() =>
      buildSpa({ root: app, components: "./src/components", entry: "App", wasm: json(join(app, "hypen.json")).wasm, log: () => {} })
    );
    expect(err).toMatchObject({ code: "PREBUILT_UNSUPPORTED_TARGET", field: `wasm.packages["./vendor/counters"]` });
  });

  test("hypen build --target wasm of the app ships the package's modules and components with the recorded grants", async () => {
    const { app } = await installed("app-wasm");
    const cfg = json(join(app, "hypen.json"));
    // The app's own entry must be a module the wasm build can compile; make it prebuilt too.
    copyFileSync(fixture("seeded_module.wasm"), join(app, "app.wasm"));
    rmSync(join(app, "src/components/App/component.ts"));
    cfg.wasm.modules = { App: { component: "./app.wasm" } };
    writeFileSync(join(app, "hypen.json"), JSON.stringify(cfg, null, 2));
    await buildWasm({ root: app, components: cfg.components, entry: "App", wasm: cfg.wasm, log: () => {} });
    const appJson = json(join(app, "dist/wasm/app.json"));
    expect(appJson.modules).toEqual([
      { name: "App", wasm: "App.wasm", ui: "App.hypen", reads: [], dispatches: [], storage: [], http: false },
      { name: "Mirror", wasm: "Mirror.wasm", ui: "Mirror.hypen", reads: ["counter"], dispatches: ["counter"], storage: [], http: false },
      { name: "Counter", wasm: "Counter.wasm", ui: "Counter.hypen", reads: [], dispatches: [], storage: ["cloud"], http: false },
      { name: "Stamp", ui: "Stamp.hypen" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe.skipIf(skip)("the commands, through bin/hypen.ts", () => {
  async function hypen(cwd: string, ...args: string[]) {
    const proc = Bun.spawn({
      cmd: ["bun", CLI, ...args],
      cwd,
      env: { ...process.env, HYPEN_NO_ONBOARDING: "1", NO_COLOR: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, out, err };
  }

  test("add (refused without flags, then --yes), modules, remove", async () => {
    const app = appWithPackage("cli");
    const refused = await hypen(app, "add", "./vendor/counters");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Error: ./vendor/counters requests capabilities, and nothing is granted without a decision.");
    expect(refused.err).toContain("code:    CONSENT_REQUIRED");
    expect(refused.err).toContain("Hint: decide each one with flags: --yes");

    const added = await hypen(app, "add", "./vendor/counters", "--yes");
    expect(added.code).toBe(0);
    expect(added.out).toContain("Added ./vendor/counters");
    expect(added.out).toContain("Use it:   Mirror {}, Counter {} in a template");

    const listed = await hypen(app, "modules");
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("granted:   reads:Counter, dispatches:Counter");
    expect((await hypen(app, "list")).out).toBe(listed.out);

    const removed = await hypen(app, "remove", "./vendor/counters");
    expect(removed.code).toBe(0);
    expect(removed.out).toContain("Removed ./vendor/counters");
    expect((await hypen(app, "remove", "Ghost")).err).toContain("code:    NOT_INSTALLED");
  }, 60_000);

  test("pack, then add the packed directory with granular flags; help documents the commands", async () => {
    const project = moduleProject(fresh("cli-pack"));
    const packed = await hypen(project, "pack", "--name", "@acme/counters");
    expect(packed.code).toBe(0);
    expect(packed.out).toContain("Packed @acme/counters 1.2.0 → dist/pack");
    const app = fresh("cli-pack-app");
    writeApp(app, `Mirror {}\n    Counter {}`);
    const added = await hypen(app, "add", join(project, "dist/pack"), "--grant", "all", "--deny", "Mirror.dispatches:Counter", "--only", "Mirror,Counter,Stamp");
    expect(added.code).toBe(0);
    expect(added.out).toContain("Withheld: Mirror.dispatches:Counter");

    for (const command of ["add", "remove", "modules", "pack"]) {
      const help = await hypen(app, command, "--help");
      expect(help.code).toBe(0);
      expect(help.out).toContain(`hypen ${command}`);
    }
    expect((await hypen(app, "--help")).out).toContain("Install a WASM module package");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// hypen dev
// ---------------------------------------------------------------------------

type Patch = Record<string, any>;

async function client(port: number) {
  const socket = new WebSocket(`ws://localhost:${port}`);
  const patches: Patch[] = [];
  const types: string[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    types.push(message.type);
    if (message.type === "initialTree" || message.type === "patch") patches.push(...message.patches);
  });
  await new Promise<void>((done, fail) => {
    socket.addEventListener("open", () => done());
    socket.addEventListener("error", () => fail(new Error("connect failed")));
  });
  socket.send(JSON.stringify({ type: "hello" }));
  const texts = (): string[] => {
    const byNode = new Map<string, string>();
    for (const p of patches) {
      if (p.type === "create" && typeof p.props?.["0"] === "string") byNode.set(p.id, p.props["0"]);
      if (p.type === "setProp" && typeof p.value === "string") byNode.set(p.id, p.value);
    }
    return [...byNode.values()];
  };
  const until = async (check: () => void, timeout = 8000): Promise<void> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        return check();
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  };
  await until(() => expect(types).toContain("initialTree"));
  return {
    texts,
    until,
    click(label: string, action: string) {
      const button = [...patches].reverse().find((p) => p.type === "create" && p.elementType === "Button" && p.semantics?.name === label);
      if (!button) throw new Error(`no button ${label}`);
      socket.send(JSON.stringify({ type: "dispatchAction", module: "App", action: "__hypen_dispatch", payload: { node: button.id, action, payload: {} } }));
    },
    close: () => socket.close(),
  };
}

let nextPort = 19975;

describe.skipIf(skip)("hypen dev with module packages", () => {
  async function start(app: string, lines: string[]) {
    const port = nextPort++;
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    console.error = (...args: unknown[]) => lines.push(args.join(" "));
    stops.push(() => {
      console.log = log;
      console.error = error;
    });
    const server = await dev({
      components: join(app, "src/components"),
      entry: "App",
      port,
      hot: true,
      wasm: json(join(app, "hypen.json")).wasm,
      configFile: join(app, "hypen.json"),
      root: app,
    });
    stops.push(() => server.stop());
    return port;
  }

  test("an installed package: both modules and the template-only component render; one module reads and drives the other", async () => {
    const app = appWithPackage("dev");
    await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() });
    const lines: string[] = [];
    const port = await start(app, lines);
    expect(lines.join("\n")).toContain("./vendor/counters (v1.2.0): Mirror, Counter, Stamp — use Mirror {}, Counter {}");
    const c = await client(port);
    stops.push(() => c.close());
    expect(c.texts()).toEqual(expect.arrayContaining(["App: mixed", "Seen: 0", "Count: 0", "from the counters package"]));
    // Mirror dispatches `increment` to Counter (dispatches), then follows it (reads).
    c.click("Bump the counter", "bump");
    await c.until(() => expect(c.texts()).toEqual(expect.arrayContaining(["Count: 1", "Seen: 1"])));
  });

  test("startup stops on drift, with the package named", async () => {
    const app = appWithPackage("dev-drift");
    await addPackage({ projectDir: app, spec: "./vendor/counters", yes: true, prompter: silent() });
    const manifestFile = join(app, "vendor/counters", PACKAGE_MANIFEST_FILE);
    const manifest = json(manifestFile);
    manifest.version = "2.0.0";
    manifest.modules[1].requests = { storage: ["cloud", "app"] };
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const err = await failure(() => start(app, []));
    expect(err.code).toBe("REQUESTS_CHANGED");
    expect(err.message).toContain("./vendor/counters 2.0.0: Counter now also requests: read and write app storage");
  });

  test("a source package is built at startup, granted what it declares, and rebuilt + hot-reloaded when its sources change", async () => {
    const app = fresh("dev-source");
    writeApp(app, `Text("App: @{state.title}")\n    Mirror {}\n    Counter {}`, { packages: { "./modules/counters": { source: true } } });
    const project = moduleProject(join(app, "modules/counters"));
    const lines: string[] = [];
    const port = await start(app, lines);
    expect(lines.join("\n")).toContain("Building ./modules/counters");
    expect(lines.join("\n")).toContain("./modules/counters (built from source): Mirror, Counter, Stamp");
    expect(existsSync(join(project, "dist/wasm", PACKAGE_MANIFEST_FILE))).toBe(true);
    // No lock is written for a source package: nothing was "reviewed".
    expect(existsSync(join(app, "hypen.lock.json"))).toBe(false);

    const c = await client(port);
    stops.push(() => c.close());
    expect(c.texts()).toEqual(expect.arrayContaining(["Seen: 0", "Count: 0"]));
    c.click("Bump the counter", "bump");
    await c.until(() => expect(c.texts()).toEqual(expect.arrayContaining(["Count: 1", "Seen: 1"])));

    // Edit a source file of the module project: it is rebuilt and reloaded in place.
    writeFileSync(join(project, "ui/Counter/component.hypen"), COUNTER_UI.replace("Count:", "Total:"));
    await c.until(() => expect(lines.join("\n")).toContain("Rebuilding ./modules/counters"), 10_000);
    await c.until(() => expect(lines.join("\n")).toMatch(/Reloaded Counter/), 10_000);
    const again = await client(port);
    stops.push(() => again.close());
    await again.until(() => expect(again.texts().some((t) => t.startsWith("Total: "))).toBe(true));

    // A broken edit: the build error is printed, the running modules stay.
    const good = readFileSync(join(project, "hypen.json"), "utf8");
    writeFileSync(join(project, "hypen.json"), good.replace(`"./prebuilt/counter.wasm"`, `"./prebuilt/missing.wasm"`));
    await c.until(() => expect(lines.join("\n")).toContain("./modules/counters did not build — the running modules keep their previous build:"), 10_000);
    expect(lines.join("\n")).toContain("PREBUILT_COMPONENT_MISSING");
    again.click("Count +1", "increment");
    await again.until(() => expect(again.texts().some((t) => /^Total: [1-9]/.test(t))).toBe(true));
  }, 60_000);

  test("a source package that cannot be built does not take the dev server down; with a fallback it is used and announced", async () => {
    const app = fresh("dev-source-broken");
    writeApp(app, `Text("App: @{state.title}")`, { packages: { "./modules/counters": { source: true } } });
    const project = moduleProject(join(app, "modules/counters"));
    rmSync(join(project, "prebuilt/mirror.wasm"));
    const lines: string[] = [];
    const port = await start(app, lines);
    expect(lines.join("\n")).toContain("./modules/counters was not built — its modules are missing from this session until it builds:");
    expect(lines.join("\n")).toContain("PREBUILT_COMPONENT_MISSING");
    const c = await client(port);
    stops.push(() => c.close());
    expect(c.texts()).toContain("App: mixed");

    // HYPEN_NO_SOURCE_BUILD: no toolchain is run; the committed fallback is used, loudly.
    const app2 = fresh("dev-fallback");
    writeApp(app2, `Mirror {}\n    Counter {}`, { packages: { "./modules/counters": { source: true, fallback: "./modules/counters/prebuilt-pkg" } } });
    const project2 = moduleProject(join(app2, "modules/counters"));
    writePackage(join(project2, "prebuilt-pkg"), countersPackage());
    process.env.HYPEN_NO_SOURCE_BUILD = "1";
    stops.push(() => delete process.env.HYPEN_NO_SOURCE_BUILD);
    const lines2: string[] = [];
    await start(app2, lines2);
    expect(lines2.join("\n")).toContain("using the prebuilt fallback ./modules/counters/prebuilt-pkg. Changes to its sources are NOT picked up until it is built.");
    expect(lines2.join("\n")).toContain("./modules/counters (prebuilt fallback): Mirror, Counter, Stamp");
    expect(existsSync(join(project2, "dist"))).toBe(false);
  }, 60_000);
});
