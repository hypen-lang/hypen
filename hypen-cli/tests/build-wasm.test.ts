/**
 * `hypen build --target wasm`: the pieces behind the build (config, discovery,
 * toolchain lookup, WIT provisioning) and — behind `HYPEN_WASM_E2E=1` — the
 * real pipelines end to end. The shims are tested in wasm-shims.test.ts, the
 * failure paths in wasm-errors.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawn, spawnSync } from "bun";
import {
  detectLanguage,
  collectGoComponents,
  collectRustComponents,
  rustCrateAbi,
  resolveJco,
  findJco,
  parseWasmConfig,
  parseModuleName,
  resolveModuleCapabilities,
  nodeStubSource,
  nodeStubPlugin,
  provisionRustWit,
  sameTree,
  cdylibWasmFromCargoMessages,
  tsBuildWorld,
  DEFERRED_HTTP_IMPORT,
  TS_BUILD_WORLD,
  buildWasm,
  BuildError,
  JCO_VERSION,
  PROVISIONED_MARKER,
} from "../src/build-wasm.js";

/** A fresh temp dir (mkdtemp); callers remove it. */
function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `hypen-${tag}-`));
}

/** The error a call throws (fails the test if it does not throw a BuildError). */
function buildErrorOf(fn: () => unknown): BuildError {
  try {
    fn();
  } catch (e) {
    if (e instanceof BuildError) return e;
    throw e;
  }
  throw new Error("expected a BuildError");
}

const names = (...raw: string[]) => raw.map(parseModuleName);

describe("build --target wasm: jco resolution", () => {
  test("jco resolves from the CLI's own pinned @bytecodealliance/jco", () => {
    // No project-local jco: falls back to the CLI's install (a pinned dev +
    // optional peer dependency), run with the current runtime — never an
    // unpinned bunx/npx download.
    const jco = resolveJco("/nonexistent-hypen-project");
    expect(jco.cmd).toBe(process.execPath);
    expect(jco.origin).toBe("cli");
    expect(jco.version).toBe(JCO_VERSION);
    expect(jco.pre).toHaveLength(1);
    expect(jco.pre[0]).toContain(join("node_modules", "@bytecodealliance", "jco"));
    expect(existsSync(jco.pre[0])).toBe(true);
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "node_modules", "@bytecodealliance", "jco", "package.json"), "utf8")
    );
    expect(pkg.version).toBe(JCO_VERSION);
    // package.json pins the same version.
    const cliPkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(cliPkg.peerDependencies["@bytecodealliance/jco"]).toBe(JCO_VERSION);
    expect(cliPkg.devDependencies["@bytecodealliance/jco"]).toBe(JCO_VERSION);
  });

  test("a project-local node_modules/.bin/jco overrides the CLI's", () => {
    const proj = tempDir("jco-local");
    try {
      mkdirSync(join(proj, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(proj, "node_modules", ".bin", "jco"), "#!/bin/sh\n");
      expect(resolveJco(proj)).toEqual({
        cmd: join(proj, "node_modules", ".bin", "jco"),
        pre: [],
        origin: "project",
        version: undefined,
      });
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  test("missing jco is a typed lookup result, and a BuildError with pinned install instructions", () => {
    // Resolve from a dir with no node_modules anywhere above it.
    const lookup = findJco("/nonexistent-hypen-project", "/");
    expect(lookup.status).toBe("missing");
    const err = buildErrorOf(() => resolveJco("/nonexistent-hypen-project", "/"));
    expect(err.code).toBe("TOOLCHAIN_MISSING");
    expect(err.message).toContain("@bytecodealliance/jco");
    expect(err.hint).toContain(`bun add -d @bytecodealliance/jco@${JCO_VERSION}`);
  });
});

describe("build --target wasm: TS componentize world", () => {
  const moduleWit = readFileSync(join(import.meta.dir, "..", "wit", "hypen-module.wit"), "utf8");

  test("drops ungranted storage imports, keeps exports + engine/state", () => {
    const world = tsBuildWorld(moduleWit, []);
    expect(world).toContain(`world ${TS_BUILD_WORLD} {`);
    for (const exp of ["export init:", "export dispatch:", "export on-activated:", "export on-deactivated:", "export on-destroyed:", "export actions:"]) {
      expect(world).toContain(exp);
    }
    expect(world).toContain("import hypen:storage/local@");
    expect(world).not.toContain("import hypen:storage/app@");
    expect(world).not.toContain("import hypen:storage/cloud@");
    expect(world).toContain("import hypen:engine/state@0.1.0;");
  });

  test("keeps granted storage imports", () => {
    const world = tsBuildWorld(moduleWit, ["cloud"]);
    expect(world).toContain("import hypen:storage/cloud@");
    expect(world).not.toContain("import hypen:storage/app@");
  });

  test("imports hypen:http/deferred only for a module granted http", () => {
    // componentize-js keeps every world import, and the host refuses an
    // ungranted one at instantiation: the import must not be in the world of
    // a module without the grant.
    for (const ungranted of [tsBuildWorld(moduleWit, []), tsBuildWorld(moduleWit, { storage: ["app"], http: false })]) {
      expect(ungranted).not.toContain("hypen:http");
    }
    const granted = tsBuildWorld(moduleWit, { storage: [], http: true });
    expect(granted).toContain(`    import ${DEFERRED_HTTP_IMPORT};\n}`);
    expect(granted).toContain("import hypen:engine/state@0.1.0;");
    expect(granted).not.toContain("import hypen:storage/app@");
    // The specifier's version is the vendored WIT package's.
    const httpWit = readFileSync(join(import.meta.dir, "..", "wit", "deps", "hypen-http", "http.wit"), "utf8");
    const pkg = httpWit.match(/^package\s+(hypen:http)@([\d.]+);/m)!;
    expect(DEFERRED_HTTP_IMPORT).toBe(`${pkg[1]}/deferred@${pkg[2]}`);
  });
});

describe("build --target wasm: Node built-in stubs", () => {
  test("named + default imports bind, and any use throws naming the module", async () => {
    const esbuild = await import("esbuild");
    const dir = tempDir("stub");
    try {
      writeFileSync(
        join(dir, "entry.mjs"),
        `import { join, sep } from "path";\n` +
          `import crypto, { randomUUID } from "node:crypto";\n` +
          `import * as fs from "fs";\n` +
          `export const imported = typeof join;\n` +
          `export const useJoin = () => join("a", "b");\n` +
          `export const useSep = () => "x" + sep;\n` +
          `export const useDefault = () => crypto.createHash("sha1");\n` +
          `export const useNamed = () => randomUUID();\n` +
          `export const useNs = () => fs.readFileSync("x");\n` +
          `export const useDynamic = async () => { const { readFile } = await import("fs/promises"); return readFile("x"); };\n`
      );
      await esbuild.build({
        entryPoints: [join(dir, "entry.mjs")],
        bundle: true,
        outfile: join(dir, "out.mjs"),
        format: "esm",
        platform: "neutral",
        logLevel: "silent",
        plugins: [nodeStubPlugin()],
      });
      const m = await import(join(dir, "out.mjs"));
      // Importing is harmless (lazy paths in core must still bundle + load).
      expect(m.imported).toBe("function");
      expect(() => m.useJoin()).toThrow("node:path is not available in the wasm target");
      expect(() => m.useSep()).toThrow("node:path is not available in the wasm target");
      expect(() => m.useDefault()).toThrow("node:crypto is not available in the wasm target");
      expect(() => m.useNamed()).toThrow("node:crypto is not available in the wasm target");
      expect(() => m.useNs()).toThrow("node:fs is not available in the wasm target");
      await expect(m.useDynamic()).rejects.toThrow("node:fs/promises is not available in the wasm target");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stub exports mirror the real built-in's export names", () => {
    const src = nodeStubSource("path");
    expect(src).toMatch(/as join\b/);
    expect(src).toMatch(/as resolve\b/);
    expect(src).toContain("export default stub(\"\")");
    // Explicit names are honored and non-identifiers dropped.
    const custom = nodeStubSource("zlib", ["gzip", "not-an-id", "default"]);
    expect(custom).toContain("as gzip");
    expect(custom).not.toContain("not-an-id");
  });
});

describe("build --target wasm: hypen.json wasm config", () => {
  test("parses language + module capabilities", () => {
    const cfg = parseWasmConfig({
      language: "rust",
      modules: { Cart: { reads: ["Catalog"], dispatches: ["Catalog"], storage: ["app", "app"], http: true } },
    });
    expect(cfg.language).toBe("rust");
    expect(cfg.modules.get("Cart")).toEqual({
      reads: ["Catalog"],
      dispatches: ["Catalog"],
      storage: ["app"],
      http: true,
      httpHosts: [],
    });
    // Parsing normalises: an absent section, and absent grant fields, become
    // explicit defaults, so nothing downstream handles "maybe missing".
    expect(parseWasmConfig(undefined)).toEqual({ language: undefined, modules: new Map() });
    expect(parseWasmConfig(null)).toEqual({ language: undefined, modules: new Map() });
    expect(parseWasmConfig({ modules: { Cart: {} } }).modules.get("Cart")).toEqual({
      reads: [],
      dispatches: [],
      storage: [],
      http: false,
      httpHosts: [],
    });
  });

  test("httpHosts: parsed with the engine's pattern grammar, stored canonically, deduplicated", () => {
    const cfg = parseWasmConfig({
      modules: { Weather: { http: true, httpHosts: ["API.Example.com", "*.example.org:8443", "api.example.com", "[0:0:0:0:0:0:0:1]:9"] } },
    });
    expect(cfg.modules.get("Weather")!.httpHosts).toEqual(["api.example.com", "*.example.org:8443", "[::1]:9"]);
    const caps = resolveModuleCapabilities(cfg, names("Weather"));
    expect(caps.get(names("Weather")[0]!)).toEqual({
      reads: [],
      dispatches: [],
      storage: [],
      http: true,
      httpHosts: ["api.example.com", "*.example.org:8443", "[::1]:9"],
    });
    // An explicit empty list is "any host", with or without the grant.
    expect(parseWasmConfig({ modules: { Weather: { http: true, httpHosts: [] } } }).modules.get("Weather")!.httpHosts).toEqual([]);
    expect(parseWasmConfig({ modules: { Weather: { httpHosts: [] } } }).modules.get("Weather")!.http).toBe(false);
  });

  test.each([
    [{ http: true, httpHosts: "api.example.com" }, "wasm.modules.Weather.httpHosts", /must be an array of host patterns \(strings\)/, /"httpHosts": \["api\.example\.com"/],
    [{ http: true, httpHosts: [42] }, "wasm.modules.Weather.httpHosts", /must be an array of host patterns \(strings\)/, /e\.g\./],
    [{ http: true, httpHosts: ["ok.example", "https://api.example.com/v1"] }, "wasm.modules.Weather.httpHosts[1]", /invalid host pattern 'https:\/\/api\.example\.com\/v1': a pattern names a host, not a URL — drop the scheme/, /names a host, not a URL/],
    [{ http: true, httpHosts: ["*"] }, "wasm.modules.Weather.httpHosts[0]", /leave the allowlist empty to allow any host/, /remove httpHosts to allow any host/],
    [{ http: true, httpHosts: ["ex*mple.com"] }, "wasm.modules.Weather.httpHosts[0]", /only allowed as the whole first label/, /\*\.example\.com/],
    [{ http: true, httpHosts: ["example.com:99999"] }, "wasm.modules.Weather.httpHosts[0]", /'99999' is not a port \(1-65535\)/, /localhost:8080/],
    [{ httpHosts: ["api.example.com"] }, "wasm.modules.Weather.httpHosts", /httpHosts narrows the http grant, but wasm\.modules\.Weather\.http is not true/, /add "http": true to wasm\.modules\.Weather, or remove "httpHosts"/],
    [{ http: false, httpHosts: ["api.example.com"] }, "wasm.modules.Weather.httpHosts", /http is not true/, /add "http": true/],
  ] as const)("a bad httpHosts is CONFIG_INVALID naming the entry: %j", (grants, field, message, hint) => {
    const err = buildErrorOf(() => parseWasmConfig({ modules: { Weather: grants } }));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.field).toBe(field);
    expect(err.message).toMatch(message);
    expect(err.hint).toMatch(hint);
  });

  test.each([
    [{ lang: "ts" }, /unknown key "wasm\.lang"/],
    [{ language: "python" }, /wasm\.language must be one of "ts", "go", "rust"/],
    ["rust", /"wasm" must be an object/],
    [{ modules: [] }, /wasm\.modules must be an object/],
    [{ modules: { Cart: true } }, /wasm\.modules\.Cart must be an object/],
    [{ modules: { Cart: { read: [] } } }, /unknown key "wasm\.modules\.Cart\.read"/],
    [{ modules: { Cart: { reads: "Catalog" } } }, /wasm\.modules\.Cart\.reads must be an array/],
    [{ modules: { Cart: { dispatches: [1] } } }, /wasm\.modules\.Cart\.dispatches must be an array/],
    [{ modules: { Cart: { storage: ["disk"] } } }, /wasm\.modules\.Cart\.storage has unknown tier "disk"/],
    [{ modules: { Cart: { storage: ["local"] } } }, /"local" is always granted/],
    [{ modules: { Cart: { http: "yes" } } }, /wasm\.modules\.Cart\.http must be true or false/],
  ])("rejects invalid config %p", (raw, message) => {
    expect(() => parseWasmConfig(raw)).toThrow(BuildError);
    expect(() => parseWasmConfig(raw)).toThrow(message);
  });

  test("every stateful module gets explicit deny-by-default capabilities", () => {
    const caps = resolveModuleCapabilities(
      parseWasmConfig({ modules: { Cart: { reads: ["Catalog"], dispatches: ["catalog"], storage: ["app"], http: true } } }),
      names("Cart", "Catalog"),
      names("Header")
    );
    // Targets are emitted as the host's lowercased state scopes.
    const [cart, catalog, header] = names("Cart", "Catalog", "Header");
    expect(caps.get(cart)).toEqual({ reads: ["catalog"], dispatches: ["catalog"], storage: ["app"], http: true, httpHosts: [] });
    expect(caps.get(catalog)).toEqual({ reads: [], dispatches: [], storage: [], http: false, httpHosts: [] });
    expect(caps.has(header)).toBe(false);
  });

  test("unknown module names are BuildErrors naming the offender", () => {
    const resolveWith = (modules: unknown) =>
      resolveModuleCapabilities(parseWasmConfig({ modules }), names("Cart", "Catalog"), names("Header"));
    expect(() => resolveWith({ Nope: {} })).toThrow(/wasm\.modules\.Nope: no module named "Nope"/);
    expect(() => resolveWith({ cart: {} })).toThrow(/did you mean "Cart"/);
    expect(() => resolveWith({ Header: {} })).toThrow(/"Header" is a stateless/);
    expect(() => resolveWith({ Cart: { reads: ["Ghost"] } })).toThrow(
      /wasm\.modules\.Cart\.reads names unknown module "Ghost"/
    );
    expect(() => resolveWith({ Cart: { dispatches: ["Ghost"] } })).toThrow(
      /wasm\.modules\.Cart\.dispatches names unknown module "Ghost"/
    );
  });

  test("wasm.language overrides file-based detection", () => {
    const rustFixture = join(import.meta.dir, "fixtures", "wasm-rust-app");
    expect(detectLanguage(rustFixture, "ts")).toBe("ts");
    expect(detectLanguage(rustFixture, "go")).toBe("go");
    expect(detectLanguage(join(import.meta.dir, "fixtures", "wasm-app"), "rust")).toBe("rust");
  });
});

describe("build --target wasm: buildWasm errors (no toolchain needed)", () => {
  const rustFixture = join(import.meta.dir, "fixtures", "wasm-rust-app");
  let proj: string;
  beforeAll(() => {
    proj = tempDir("wasm-errors");
    cpSync(rustFixture, proj, { recursive: true });
  });
  afterAll(() => rmSync(proj, { recursive: true, force: true }));

  test("missing entry throws BuildError instead of exiting", async () => {
    await expect(
      buildWasm({ root: proj, components: "./src/components", entry: "Nope" })
    ).rejects.toThrow(/Entry module "Nope" not found/);
    await expect(
      buildWasm({ root: proj, components: "./src/components", entry: "Nope" })
    ).rejects.toBeInstanceOf(BuildError);
  });

  test("invalid wasm config fails before compiling anything", async () => {
    await expect(
      buildWasm({
        root: proj,
        components: "./src/components",
        entry: "Counter",
        wasm: { modules: { Ghost: { http: true } } },
      })
    ).rejects.toThrow(/wasm\.modules\.Ghost: no module named "Ghost"/);
    await expect(
      buildWasm({ root: proj, components: "./src/components", entry: "Counter", wasm: { modules: { Banner: {} } } })
    ).rejects.toThrow(/"Banner" is a stateless/);
    // Nothing was compiled or provisioned.
    expect(existsSync(join(proj, "target"))).toBe(false);
    expect(existsSync(join(proj, "wit"))).toBe(false);
    expect(existsSync(join(proj, "dist"))).toBe(false);
  });
});

describe("build --target wasm: Rust WIT provisioning + artifact lookup", () => {
  const cliRoot = join(import.meta.dir, "..");
  const bundled = { "0.1": join(cliRoot, "wit"), "0.2": join(cliRoot, "wit-v0_2") };
  let crate: string;
  beforeAll(() => {
    crate = tempDir("rust-wit");
  });
  afterAll(() => rmSync(crate, { recursive: true, force: true }));

  const cargo = (meta: string) =>
    writeFileSync(join(crate, "Cargo.toml"), `[package]\nname = "x"\nversion = "0.1.0"\n${meta}`);

  test("provisions, then refreshes stale WIT on an ABI switch", () => {
    cargo("");
    expect(rustCrateAbi(crate)).toBe("0.1");
    expect(provisionRustWit(crate, "0.1", bundled)).toBe("provisioned");
    expect(existsSync(join(crate, "wit", PROVISIONED_MARKER))).toBe(true);
    expect(sameTree(join(crate, "wit"), bundled["0.1"])).toBe(true);
    expect(provisionRustWit(crate, "0.1", bundled)).toBe("unchanged");

    // Switch the crate to the CM-async ABI: the stale v0.1 copy is replaced.
    cargo(`\n[package.metadata.hypen]\nabi = "0.2"\n`);
    expect(rustCrateAbi(crate)).toBe("0.2");
    expect(provisionRustWit(crate, "0.2", bundled)).toBe("refreshed");
    expect(readFileSync(join(crate, "wit", "hypen-module.wit"), "utf8")).toContain("hypen:module@0.2");
    expect(sameTree(join(crate, "wit"), bundled["0.2"])).toBe(true);

    // ...and back: dropping the metadata means v0.1 again (a provisioned
    // @0.2 copy is not mistaken for author intent).
    cargo("");
    expect(rustCrateAbi(crate)).toBe("0.1");
    expect(provisionRustWit(crate, "0.1", bundled)).toBe("refreshed");
    expect(sameTree(join(crate, "wit"), bundled["0.1"])).toBe(true);
  });

  test("a pre-marker provisioned copy (identical to the bundled WIT) is refreshed too", () => {
    rmSync(join(crate, "wit"), { recursive: true, force: true });
    cpSync(bundled["0.1"], join(crate, "wit"), { recursive: true }); // no marker
    cargo(`\n[package.metadata.hypen]\nabi = "0.2"\n`);
    expect(rustCrateAbi(crate)).toBe("0.2");
    expect(provisionRustWit(crate, "0.2", bundled)).toBe("refreshed");
    expect(sameTree(join(crate, "wit"), bundled["0.2"])).toBe(true);
  });

  test("author-vendored WIT is left alone, but an ABI contradiction is an error", () => {
    rmSync(join(crate, "wit"), { recursive: true, force: true });
    mkdirSync(join(crate, "wit"));
    writeFileSync(join(crate, "wit", "hypen-module.wit"), "package hypen:module@0.1.0;\n// custom\n");
    cargo("");
    expect(provisionRustWit(crate, "0.1", bundled)).toBe("vendored");
    expect(readFileSync(join(crate, "wit", "hypen-module.wit"), "utf8")).toContain("// custom");
    cargo(`\n[package.metadata.hypen]\nabi = "0.2"\n`);
    expect(() => provisionRustWit(crate, "0.2", bundled)).toThrow(/declares hypen:module@0\.1 but the crate targets ABI 0\.2/);
  });

  test("an unknown abi value is a BuildError", () => {
    cargo(`\n[package.metadata.hypen]\nabi = "9"\n`);
    expect(() => rustCrateAbi(crate)).toThrow(BuildError);
  });

  test("cdylib .wasm comes from cargo's compiler-artifact messages", () => {
    const manifest = join(crate, "Cargo.toml");
    const msgs = [
      JSON.stringify({ reason: "compiler-artifact", manifest_path: "/elsewhere/dep/Cargo.toml", target: { kind: ["cdylib"] }, filenames: ["/t/dep.wasm"] }),
      "not json",
      JSON.stringify({ reason: "compiler-artifact", manifest_path: manifest, target: { kind: ["build-script"] }, filenames: ["/t/build"] }),
      JSON.stringify({ reason: "compiler-artifact", manifest_path: manifest, target: { kind: ["cdylib"] }, filenames: ["/custom-target/wasm32-wasip2/release/renamed_lib.wasm"] }),
      JSON.stringify({ reason: "build-finished", success: true }),
    ].join("\n");
    expect(cdylibWasmFromCargoMessages(msgs, manifest)).toBe("/custom-target/wasm32-wasip2/release/renamed_lib.wasm");
    expect(cdylibWasmFromCargoMessages(msgs, "/no/such/Cargo.toml")).toBeNull();
  });
});

describe("build --target wasm: language detection + Go discovery", () => {
  const goFixture = join(import.meta.dir, "fixtures", "wasm-go-app");

  const rustFixture = join(import.meta.dir, "fixtures", "wasm-rust-app");

  test("detects Rust (Cargo.toml), Go (go.mod), TypeScript otherwise", () => {
    expect(detectLanguage(rustFixture)).toBe("rust");
    expect(detectLanguage(goFixture)).toBe("go");
    expect(detectLanguage(join(import.meta.dir, "fixtures", "wasm-app"))).toBe("ts");
  });

  test("collectRustComponents (single-crate): entry is the root crate, rest stateless", () => {
    const { stateful: modules, stateless } = collectRustComponents(
      join(rustFixture, "src", "components"),
      "Counter",
      rustFixture
    );
    expect(modules.map((m) => m.name)).toEqual(["Counter"]);
    expect(modules[0].template).toContain("@{state.count}");
    // The root Cargo.toml is the entry crate.
    expect(modules[0].source.crateDir).toBe(rustFixture);
    // Banner has a .hypen but isn't the entry → stateless.
    expect(stateless.map((s) => s.name)).toContain("Banner");
  });

  test("rustCrateAbi: v0.2 via Cargo metadata or vendored @0.2 WIT, else v0.1", () => {
    // The sync fixture has no metadata and no vendored WIT → v0.1.
    expect(rustCrateAbi(rustFixture)).toBe("0.1");
    // The async fixture opts in via [package.metadata.hypen] abi = "0.2".
    const asyncFixture = join(import.meta.dir, "fixtures", "wasm-rust-app-async");
    expect(rustCrateAbi(asyncFixture)).toBe("0.2");
    // A crate-vendored @0.2 WIT wins even without metadata.
    const tmp = tempDir("abi-sniff");
    try {
      mkdirSync(join(tmp, "wit"), { recursive: true });
      writeFileSync(join(tmp, "wit", "hypen-module.wit"), "package hypen:module@0.2.0;\n");
      expect(rustCrateAbi(tmp)).toBe("0.2");
      // Explicit Cargo metadata beats the vendored WIT sniff.
      writeFileSync(
        join(tmp, "Cargo.toml"),
        `[package]\nname = "x"\n\n[package.metadata.hypen]\nabi = "0.1"\n`
      );
      expect(rustCrateAbi(tmp)).toBe("0.1");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("collectRustComponents (multi-module): each Cargo.toml dir is its own crate", () => {
    const multiFixture = join(import.meta.dir, "fixtures", "wasm-rust-multi");
    const { stateful: modules, stateless } = collectRustComponents(
      join(multiFixture, "src", "components"),
      "Counter",
      multiFixture
    );
    // Two crate-backed stateful modules, each built from its own component dir.
    expect(modules.map((m) => m.name).sort()).toEqual(["Counter", "Timer"]);
    const counter = modules.find((m) => m.name === "Counter")!;
    expect(counter.source.crateDir).toBe(join(multiFixture, "src", "components", "Counter"));
    expect(counter.template).toContain("@{state.count}");
    // Banner has a `.hypen` but no `Cargo.toml` → stateless building block.
    expect(stateless.map((s) => s.name)).toEqual(["Banner"]);
  });

  test("collectGoComponents finds Go packages with their templates", () => {
    const { stateful: modules, stateless } = collectGoComponents(
      join(goFixture, "src", "components")
    );
    expect(stateless).toHaveLength(0);
    const counter = modules.find((m) => m.name === "Counter");
    expect(counter).toBeDefined();
    // Stateful Go component: has a package dir + its .hypen template.
    expect(counter!.source.dir).toBe(join(goFixture, "src", "components", "Counter"));
    expect(counter!.template).toContain("@{state.count}");
  });

  test("classifies Go components: wit-mode (package main) vs app-mode", () => {
    // wit-mode fixture: main.go is `package main`.
    const wit = collectGoComponents(join(goFixture, "src", "components"));
    expect(wit.stateful.find((m) => m.name === "Counter")!.source.mode).toBe("wit");

    // app-mode fixture: counter.go is `package counter` (core.NewApp authoring).
    const apiFixture = join(import.meta.dir, "fixtures", "wasm-go-app-api");
    const app = collectGoComponents(join(apiFixture, "src", "components"));
    const counter = app.stateful.find((m) => m.name === "Counter")!;
    expect(counter.source.mode).toBe("app");
    // The shim imports the package by its directory (import path), so that
    // is what an app-mode module carries.
    expect(counter.source.dir).toBe(join(apiFixture, "src", "components", "Counter"));
  });
});

// Full pipelines (esbuild bundle → jco componentize; tinygo; cargo) are heavy
// (~30s+, ~14 MB output per TS module) and need toolchains. Gate them behind
// an env var so the default suite stays fast; they verify the real build when
// run with `HYPEN_WASM_E2E=1 bun test`. Every project is a copy of a fixture
// in a mkdtemp dir, removed in afterAll even when a test fails.
const E2E = process.env.HYPEN_WASM_E2E === "1";
const cliPath = join(import.meta.dir, "..", "bin", "hypen.ts");
const repoRoot = resolve(import.meta.dir, "..", "..");

/** True when `cmd args…` can be spawned and exits 0. */
function onPath(cmd: string, args: string[]): boolean {
  try {
    return spawnSync({ cmd: [cmd, ...args], stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

/** Run `hypen build --target wasm` in `cwd`. */
async function runWasmBuild(cwd: string, env: Record<string, string | undefined> = {}) {
  const proc = spawn({
    cmd: ["bun", cliPath, "build", "--target", "wasm"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** Copy a fixture into a fresh dir under `root`, optionally merging hypen.json. */
function copyFixture(root: string, fixture: string, hypenJson?: Record<string, unknown>): string {
  const proj = mkdtempSync(join(root, `${fixture}-`));
  cpSync(join(import.meta.dir, "fixtures", fixture), proj, { recursive: true });
  if (hypenJson) {
    const file = join(proj, "hypen.json");
    const base = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...base, ...hypenJson }, null, 2));
  }
  return proj;
}

const readManifest = (proj: string) =>
  JSON.parse(readFileSync(join(proj, "dist", "wasm", "app.json"), "utf8"));

describe.if(E2E)("build --target wasm: end-to-end", () => {
  const corePkg = join(repoRoot, "hypen-web", "packages", "core");
  const serverPkg = join(repoRoot, "hypen-web", "packages", "server");
  // jco comes from the CLI's own pinned install (resolveJco), not the project.
  const haveToolchain = existsSync(corePkg) && existsSync(serverPkg) && (() => {
    try {
      resolveJco("/nonexistent-hypen-project");
      return true;
    } catch {
      return false;
    }
  })();

  let root: string;
  beforeAll(() => {
    root = tempDir("wasm-e2e");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test.skipIf(!haveToolchain)(
    "builds a module to a runnable .wasm component + manifest",
    async () => {
      // tests/fixtures/wasm-app: Counter (stateful, 2 actions) + Header
      // (stateless .hypen referenced by Counter's template).
      const proj = copyFixture(root, "wasm-app");

      // Resolve the in-repo SDK the way a real install would (symlinks into
      // node_modules) so the bundle picks up the workspace sources.
      const nm = join(proj, "node_modules");
      mkdirSync(join(nm, "@hypen-space"), { recursive: true });
      symlinkSync(corePkg, join(nm, "@hypen-space", "core"));
      symlinkSync(serverPkg, join(nm, "@hypen-space", "server"));

      const { exitCode, stdout, stderr } = await runWasmBuild(proj);
      expect(exitCode, `build failed:\n${stderr}\n${stdout}`).toBe(0);

      const wasmDir = join(proj, "dist", "wasm");
      expect(existsSync(join(wasmDir, "Counter.wasm"))).toBe(true);
      expect(existsSync(join(wasmDir, "Counter.hypen"))).toBe(true);
      // Stateless component: UI emitted, but no wasm.
      expect(existsSync(join(wasmDir, "Header.hypen"))).toBe(true);
      expect(existsSync(join(wasmDir, "Header.wasm"))).toBe(false);
      // The intermediate build dir is cleaned up.
      expect(existsSync(join(proj, "dist", ".wasm-temp"))).toBe(false);

      const manifest = readManifest(proj);
      expect(manifest.entry).toBe("Counter");
      expect(manifest.modules).toHaveLength(2);
      const counter = manifest.modules.find((m: any) => m.name === "Counter");
      const header = manifest.modules.find((m: any) => m.name === "Header");
      // No wasm config → explicit deny-by-default capabilities.
      expect(counter).toEqual({
        name: "Counter",
        wasm: "Counter.wasm",
        ui: "Counter.hypen",
        reads: [],
        dispatches: [],
        storage: [],
        http: false,
      });
      // Stateless entry has a UI but no `wasm` key and no capabilities.
      expect(header).toEqual({ name: "Header", ui: "Header.hypen" });
    },
    180_000
  );
});

// TS-authored modules and deferred HTTP, all the way through: the CLI builds a
// module that calls `context.http` (the shim over `hypen:http/deferred`), the
// built component is loaded by `@hypen-space/module-host` behind a
// `RemoteServer`, the engine admits the request it queues, the server
// "performs" it with an injected fetch, and the completion comes back to the
// module as an action.
describe.if(E2E)("build --target wasm: TS module with deferred HTTP, end-to-end", () => {
  const web = join(repoRoot, "hypen-web");
  const corePkg = join(web, "packages", "core");
  const serverPkg = join(web, "packages", "server");
  const haveToolchain =
    existsSync(corePkg) &&
    existsSync(join(serverPkg, "wasm-node", "hypen_engine.js")) &&
    existsSync(join(web, "packages", "module-host", "src", "index.ts")) &&
    (() => {
      try {
        resolveJco("/nonexistent-hypen-project");
        return true;
      } catch {
        return false;
      }
    })();

  let root: string;
  beforeAll(() => {
    root = tempDir("wasm-http-e2e");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Build the fixture with the given grants for `Fetcher`; returns the output dir. */
  async function buildFetcher(grants: Record<string, unknown>): Promise<string> {
    const proj = copyFixture(root, "wasm-http-app", { wasm: { modules: { Fetcher: grants } } });
    const nm = join(proj, "node_modules");
    mkdirSync(join(nm, "@hypen-space"), { recursive: true });
    symlinkSync(corePkg, join(nm, "@hypen-space", "core"));
    symlinkSync(serverPkg, join(nm, "@hypen-space", "server"));
    const { exitCode, stdout, stderr } = await runWasmBuild(proj);
    expect(exitCode, `build failed:\n${stderr}\n${stdout}`).toBe(0);
    return join(proj, "dist", "wasm");
  }

  type Failure = { kind: string; message: string; hint?: string; missingGrant?: { field: string; value: string } };
  type Sent = { url: string; method: string; headers: Array<[string, string]>; body: string | null };

  /** A RemoteServer running the built module next to a TypeScript entry, with a fake network. */
  async function serve(wasmDir: string, respond: (sent: Sent) => Response) {
    const { HypenApp } = await import(join(corePkg, "src", "app.ts"));
    const { RemoteServer } = await import(join(serverPkg, "src", "remote", "server.ts"));
    const { loadWasmModules } = await import(join(serverPkg, "src", "hosted", "index.ts"));
    const { connect, eventually } = await import(join(web, "tests", "hosted-modules-harness.ts"));

    const loaded = loadWasmModules(wasmDir);
    const sent: Sent[] = [];
    const failures: Failure[] = [];
    const app = new HypenApp();
    const entry = app.module("App").defineState({}).ui(`module App { Column { Fetcher {} } }`);
    const server = new RemoteServer()
      .app(app)
      .module("App", entry)
      .wasmModules(loaded.modules)
      .hostedModules({
        onError: (failure: Failure) => failures.push(failure),
        fetch: async (url: string, init: { method: string; headers: Array<[string, string]>; body: Uint8Array | null }) => {
          const request = {
            url,
            method: init.method,
            headers: init.headers,
            body: init.body ? new TextDecoder().decode(init.body) : null,
          };
          sent.push(request);
          return respond(request);
        },
      });
    await server.prepare();
    const client = await connect(server);
    const dispatch = (action: string, payload?: unknown): Promise<void> =>
      (client.session.hostedModules as { dispatch(scope: string, action: string, payload: unknown): Promise<void> }).dispatch(
        "fetcher",
        action,
        payload ?? null
      );
    return { loaded, client, sent, failures, dispatch, eventually: eventually as <T>(check: () => T) => Promise<T> };
  }

  test.skipIf(!haveToolchain)(
    "granted http: context.http.get / send reach the network and the completion lands in state",
    async () => {
      const wasmDir = await buildFetcher({ http: true, httpHosts: ["api.example.test"] });
      expect(readManifest(join(wasmDir, "..", "..")).modules[0]).toEqual({
        name: "Fetcher",
        wasm: "Fetcher.wasm",
        ui: "Fetcher.hypen",
        reads: [],
        dispatches: [],
        storage: [],
        http: true,
        httpHosts: ["api.example.test"],
      });

      const { loaded, client, sent, failures, dispatch, eventually } = await serve(wasmDir, (request) =>
        request.url.endsWith("/echo")
          ? new Response(request.body, { status: 201, headers: { "content-type": "application/json" } })
          : Response.json({ greeting: "hello from the fake network" })
      );
      try {
        // app.json's allowlist reached the module's definition.
        expect(loaded.modules[0].hosted.grants).toMatchObject({ http: true, httpHosts: ["api.example.test"] });

        // GET: queued by the reducer, performed afterwards.
        await dispatch("load");
        expect(client.state("fetcher")).toMatchObject({ status: "loading", completions: 0 });
        await eventually(() => expect(client.state("fetcher").completions).toBe(1));
        expect(client.state("fetcher")).toMatchObject({
          status: "http 200",
          body: '{"greeting":"hello from the fake network"}',
          contentType: "application/json;charset=utf-8",
          tag: "get",
        });
        expect(sent[0]).toMatchObject({ url: "https://api.example.test/hello", method: "GET", body: null });
        expect(sent[0]!.headers).toContainEqual(["accept", "application/json"]);

        // POST with an object body: JSON + content-type, default method POST.
        await dispatch("post");
        await eventually(() => expect(client.state("fetcher").completions).toBe(2));
        expect(sent[1]).toMatchObject({
          url: "https://api.example.test/echo",
          method: "POST",
          body: '{"name":"kettle","qty":2}',
        });
        expect(sent[1]!.headers).toContainEqual(["content-type", "application/json"]);
        expect(client.state("fetcher")).toMatchObject({ status: "http 201", body: '{"name":"kettle","qty":2}', tag: "post" });
        expect(failures).toEqual([]);

        // Outside the allowlist: refused at `send`, as a typed error the handler caught.
        await dispatch("load", { url: "https://elsewhere.example.test/" });
        expect(client.state("fetcher")).toMatchObject({
          status: "refused",
          refused:
            "permission-denied: context.http.send: permission-denied: host 'elsewhere.example.test:443' is not in the " +
            "manifest's `httpHosts` allowlist — add the host to wasm.modules.Fetcher.httpHosts in hypen.json",
        });
        expect(sent).toHaveLength(2);
        expect(failures).toEqual([]);

        // The same refusal, uncaught: the action fails and the diagnostic names the field.
        await dispatch("load", { url: "https://elsewhere.example.test/", uncaught: true }).catch(() => {});
        await eventually(() => expect(failures).toHaveLength(1));
        expect(failures[0]).toMatchObject({
          kind: "action",
          missingGrant: { field: "httpHosts", value: "elsewhere.example.test:443" },
        });
        expect(failures[0]!.hint).toContain('add it to');
        expect(failures[0]!.hint).toContain(".httpHosts");
      } finally {
        await client.close();
      }
    },
    300_000
  );

  test.skipIf(!haveToolchain)(
    "no http grant: the component does not import the interface, loads ungranted, and the helper explains",
    async () => {
      const wasmDir = await buildFetcher({});
      expect(readManifest(join(wasmDir, "..", "..")).modules[0]).toMatchObject({ name: "Fetcher", http: false });
      expect(Object.keys(readManifest(join(wasmDir, "..", "..")).modules[0])).not.toContain("httpHosts");

      // Link-time proof: an ungranted host instantiates it (it would refuse a
      // component that imports hypen:http/deferred).
      const { prepareComponent } = await import(join(web, "packages", "module-host", "src", "index.ts"));
      const prepared = await prepareComponent("fetcher", new Uint8Array(readFileSync(join(wasmDir, "Fetcher.wasm"))));
      expect(prepared.requiredImports.filter((name: string) => name.includes("http"))).toEqual([]);

      const { client, sent, failures, dispatch, eventually } = await serve(wasmDir, () => new Response("unreachable"));
      try {
        await dispatch("load");
        expect(client.state("fetcher")).toMatchObject({
          status: "refused",
          refused:
            'not-granted: context.http: this module has no `http` grant — add "http": true under wasm.modules.Fetcher in hypen.json',
        });
        // Uncaught, it is the action's failure, with the grant to add.
        await dispatch("load", { uncaught: true }).catch(() => {});
        await eventually(() => expect(failures).toHaveLength(1));
        expect(failures[0]!.message).toContain("this module has no `http` grant");
        expect(failures[0]).toMatchObject({ kind: "action", missingGrant: { field: "http", value: "true" } });
        expect(sent).toEqual([]);
      } finally {
        await client.close();
      }
    },
    300_000
  );
});

// Go pipeline: wit-bindgen-go + tinygo. Needs the Go toolchain on PATH;
// reported as skipped (not passed) without it.
describe.if(E2E)("build --target wasm: Go end-to-end", () => {
  const haveGo =
    onPath("tinygo", ["version"]) && onPath("wit-bindgen-go", ["--help"]) && onPath("go", ["version"]);

  let root: string;
  beforeAll(() => {
    root = tempDir("go-e2e");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Copy a Go fixture and point its SDK `replace` at the in-repo Go SDK. */
  function copyGoFixture(fixture: string): string {
    const proj = copyFixture(root, fixture);
    const goModFile = join(proj, "go.mod");
    const goMod = readFileSync(goModFile, "utf8").replace(
      /replace github.com\/hypen-lang\/hypen\/hypen-golang => .*/,
      `replace github.com/hypen-lang/hypen/hypen-golang => ${join(repoRoot, "hypen-golang")}`
    );
    writeFileSync(goModFile, goMod);
    return proj;
  }

  test.skipIf(!haveGo)(
    "builds a Go module to a runnable .wasm component + manifest",
    async () => {
      // A copy, so the generated internal/bindings/ never lands in the fixture.
      const proj = copyGoFixture("wasm-go-app");
      const { exitCode, stdout, stderr } = await runWasmBuild(proj);
      expect(exitCode, `build failed:\n${stderr}`).toBe(0);
      expect(stdout).toContain("Go (tinygo)");

      const wasmDir = join(proj, "dist", "wasm");
      expect(existsSync(join(wasmDir, "Counter.wasm"))).toBe(true);
      expect(existsSync(join(wasmDir, "Counter.hypen"))).toBe(true);
      expect(readManifest(proj).modules[0]).toMatchObject({
        name: "Counter",
        wasm: "Counter.wasm",
        ui: "Counter.hypen",
        http: false,
      });
    },
    300_000
  );

  // App-mode parity: a Go module written with the high-level core.NewApp()
  // authoring API builds to wasm via the generated shim — same as the TS path.
  test.skipIf(!haveGo)(
    "builds a core.NewApp() Go module via the generated shim (app-mode)",
    async () => {
      const proj = copyGoFixture("wasm-go-app-api");
      const { exitCode, stderr } = await runWasmBuild(proj);
      expect(exitCode, `app-mode build failed:\n${stderr}`).toBe(0);

      const wasmDir = join(proj, "dist", "wasm");
      expect(existsSync(join(wasmDir, "Counter.wasm"))).toBe(true);
      expect(readManifest(proj).modules[0]).toMatchObject({ name: "Counter", wasm: "Counter.wasm" });
    },
    300_000
  );
});

// Rust pipeline: cargo + wit-bindgen. Needs the Rust toolchain + the
// wasm32-wasip2 target; reported as skipped without them. Both builds share
// one CARGO_TARGET_DIR under the temp root (keeps disk use + rebuilds down,
// and proves the artifact lookup honors CARGO_TARGET_DIR).
describe.if(E2E)("build --target wasm: Rust end-to-end", () => {
  const haveRust =
    onPath("cargo", ["--version"]) &&
    (() => {
      try {
        const r = spawnSync({ cmd: ["rustc", "--print", "sysroot"], stdout: "pipe" });
        const sysroot = new TextDecoder().decode(r.stdout).trim();
        return r.exitCode === 0 && existsSync(join(sysroot, "lib", "rustlib", "wasm32-wasip2"));
      } catch {
        return false;
      }
    })();

  let root: string;
  let targetDir: string;
  beforeAll(() => {
    root = tempDir("rust-e2e");
    targetDir = join(root, "cargo-target");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test.skipIf(!haveRust)(
    "builds a wit-authored Rust crate to a runnable component + manifest",
    async () => {
      const proj = copyFixture(root, "wasm-rust-app", {
        wasm: { modules: { Counter: { storage: ["app"], http: true } } },
      });
      const { exitCode, stdout, stderr } = await runWasmBuild(proj, { CARGO_TARGET_DIR: targetDir });
      expect(exitCode, `build failed:\n${stderr}\n${stdout}`).toBe(0);
      expect(stdout).toContain("Rust (cargo)");
      // cargo wrote into CARGO_TARGET_DIR, not the crate.
      expect(existsSync(join(proj, "target"))).toBe(false);

      const wasmDir = join(proj, "dist", "wasm");
      expect(existsSync(join(wasmDir, "Counter.wasm"))).toBe(true);
      expect(existsSync(join(wasmDir, "Counter.hypen"))).toBe(true);
      // Stateless Banner: UI only, no wasm.
      expect(existsSync(join(wasmDir, "Banner.hypen"))).toBe(true);
      expect(existsSync(join(wasmDir, "Banner.wasm"))).toBe(false);

      const manifest = readManifest(proj);
      const counter = manifest.modules.find((m: any) => m.name === "Counter");
      const banner = manifest.modules.find((m: any) => m.name === "Banner");
      // Capabilities come from hypen.json wasm.modules.Counter.
      expect(counter).toEqual({
        name: "Counter",
        wasm: "Counter.wasm",
        ui: "Counter.hypen",
        reads: [],
        dispatches: [],
        storage: ["app"],
        http: true,
      });
      expect(banner).toEqual({ name: "Banner", ui: "Banner.hypen" });
    },
    600_000
  );

  test.skipIf(!haveRust)(
    "builds a CM-async (abi = 0.2) Rust crate against the vendored wit-v0_2",
    async () => {
      const proj = copyFixture(root, "wasm-rust-app-async");
      // A stale v0.1 wit/ from an earlier (pre-switch) build must be refreshed.
      cpSync(join(import.meta.dir, "..", "wit"), join(proj, "wit"), { recursive: true });

      const { exitCode, stdout, stderr } = await runWasmBuild(proj, { CARGO_TARGET_DIR: targetDir });
      expect(exitCode, `build failed:\n${stderr}\n${stdout}`).toBe(0);
      // The CLI announced the ABI selection and provisioned the async WIT.
      expect(stdout).toContain("hypen:module@0.2.0 (CM-async)");
      expect(stdout).toContain("refreshed wit/ (hypen:module@0.2)");
      expect(readFileSync(join(proj, "wit", "hypen-module.wit"), "utf8")).toContain(
        "hypen:module@0.2.0"
      );

      const wasmDir = join(proj, "dist", "wasm");
      expect(existsSync(join(wasmDir, "AsyncCounter.wasm"))).toBe(true);
      expect(existsSync(join(wasmDir, "AsyncCounter.hypen"))).toBe(true);
      // The built bytes carry the @0.2.0 capability imports — exactly the
      // marker hypen-runtime's DualHost sniffs to route it to the async host.
      const bytes = readFileSync(join(wasmDir, "AsyncCounter.wasm"));
      expect(bytes.includes(Buffer.from("hypen:storage/local@0.2.0"))).toBe(true);
    },
    600_000
  );
});
