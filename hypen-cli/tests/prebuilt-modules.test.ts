/**
 * Prebuilt (hosted) modules — hypen.json `wasm.modules.<Name>.component`:
 * config validation, `hypen build --target wasm`, the SPA build's refusal,
 * the server-based build's file copy, and the dev server (load, diagnostics,
 * hot reload).
 *
 * Components are the committed fixtures of hypen-engine-rs/tests/fixtures.
 * No toolchain is needed: nothing here compiles a module.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  BuildError,
  buildWasm,
  classifyWasm,
  copyPrebuiltModules,
  declaredPrebuiltNames,
  parseWasmConfig,
  prebuiltNames,
  resolvePrebuiltModules,
} from "../src/build-wasm";
import { build as buildSpa } from "../src/build";
import { dev } from "../src/dev-bun";
import {
  DevPrebuiltModules,
  formatHostedFailure,
  formatHostedSetupError,
  isHostedSetupError,
} from "../src/dev-hosted";

const FIXTURES = resolve(import.meta.dir, "..", "..", "hypen-engine-rs", "tests", "fixtures");
const fixture = (name: string) => join(FIXTURES, name);
const skip = !["counter_module.wasm", "seeded_module.wasm", "mirror_module.wasm", "limits_module.wasm"].every((f) =>
  existsSync(fixture(f))
);

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hypen-prebuilt-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function buildError(run: () => unknown): Promise<BuildError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof BuildError) return err;
    throw err;
  }
  throw new Error("expected a BuildError");
}

const TALLY_UI = `Column {
  Text("Tally: @{state.count}")
  Button { Text("Tally +1") }.onClick(@actions.increment)
}`;

/** A project whose entry `App` is template-only and whose module is prebuilt. */
function project(tag: string): string {
  const dir = mkdtempSync(join(root, `${tag}-`));
  write(join(dir, "src/components/Header/component.hypen"), `Text("Header")`);
  write(join(dir, "modules/tally/tally.wasm"), readFileSync(fixture("counter_module.wasm")));
  write(join(dir, "modules/tally/Tally.hypen"), TALLY_UI);
  return dir;
}

const TALLY = { component: "./modules/tally/tally.wasm", template: "./modules/tally/Tally.hypen", storage: ["cloud"] };

describe("hypen.json: wasm.modules.<Name>.component / template", () => {
  test("parses a prebuilt declaration next to its grants", () => {
    const config = parseWasmConfig({ modules: { Pricing: { component: "./p.wasm", template: "./P.hypen", reads: ["Cart"] }, Cart: {} } });
    expect(config.modules.get("Pricing")).toEqual({
      reads: ["Cart"],
      dispatches: [],
      storage: [],
      http: false,
      httpHosts: [],
      prebuilt: { component: "./p.wasm", template: "./P.hypen" },
    });
    expect(config.modules.get("Cart")!.prebuilt).toBeUndefined();
    expect([...prebuiltNames(config)]).toEqual(["Pricing"]);
    expect(parseWasmConfig({ modules: { P: { component: "./p.wasm" } } }).modules.get("P")!.prebuilt).toEqual({
      component: "./p.wasm",
      template: undefined,
    });
    expect(declaredPrebuiltNames({ modules: { P: { component: 3 }, Q: {} } })).toEqual(["P"]);
    expect(declaredPrebuiltNames("nonsense")).toEqual([]);
  });

  test.each([
    [{ modules: { P: { component: 7 } } }, "wasm.modules.P.component"],
    [{ modules: { P: { component: "" } } }, "wasm.modules.P.component"],
    [{ modules: { P: { component: "./p.wasm", template: [] } } }, "wasm.modules.P.template"],
    [{ modules: { P: { template: "./P.hypen" } } }, "wasm.modules.P.template"],
    [{ modules: { P: { componnt: "./p.wasm" } } }, "wasm.modules.P.componnt"],
  ])("rejects %j at %s", async (raw, field) => {
    const err = await buildError(() => parseWasmConfig(raw));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.field).toBe(field);
    expect(err.hint).toBeTruthy();
  });

  test("a typo of `component` suggests it", async () => {
    const err = await buildError(() => parseWasmConfig({ modules: { P: { componnt: "./p.wasm" } } }));
    expect(err.hint).toContain('did you mean "wasm.modules.P.component"');
  });

  test.skipIf(skip)("resolves files against the project root", () => {
    const dir = project("resolve");
    const [module] = resolvePrebuiltModules(parseWasmConfig({ modules: { Tally: TALLY } }), dir);
    expect(module).toMatchObject({
      kind: "prebuilt",
      name: "Tally",
      componentPath: join(dir, "modules/tally/tally.wasm"),
      templatePath: join(dir, "modules/tally/Tally.hypen"),
      template: TALLY_UI,
      field: "wasm.modules.Tally",
    });
  });

  test.skipIf(skip)("missing file / not a component / core module / missing template / case collision", async () => {
    const dir = project("bad");
    const resolveWith = (entry: Record<string, unknown>, more: Record<string, unknown> = {}) =>
      buildError(() => resolvePrebuiltModules(parseWasmConfig({ modules: { Tally: entry, ...more } }), dir));

    const missing = await resolveWith({ component: "./modules/tally/nope.wasm" });
    expect(missing).toMatchObject({
      code: "PREBUILT_COMPONENT_MISSING",
      module: "Tally",
      file: join(dir, "modules/tally/nope.wasm"),
      field: "wasm.modules.Tally.component",
    });
    expect(missing.hint).toContain("relative to the project root");

    write(join(dir, "modules/tally/text.wasm"), "not wasm at all");
    const notWasm = await resolveWith({ component: "./modules/tally/text.wasm" });
    expect(notWasm.code).toBe("PREBUILT_COMPONENT_INVALID");
    expect(notWasm.message).toContain("not a WebAssembly binary");

    write(join(dir, "modules/tally/core.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    expect(classifyWasm(readFileSync(join(dir, "modules/tally/core.wasm")))).toEqual({ kind: "core-module" });
    const core = await resolveWith({ component: "./modules/tally/core.wasm" });
    expect(core.code).toBe("PREBUILT_COMPONENT_INVALID");
    expect(core.message).toContain("core WebAssembly module, not a Component");
    expect(core.hint).toContain("wasm32-wasip2");

    const noTemplate = await resolveWith({ ...TALLY, template: "./modules/tally/Missing.hypen" });
    expect(noTemplate).toMatchObject({ code: "PREBUILT_TEMPLATE_MISSING", field: "wasm.modules.Tally.template" });

    const collision = await resolveWith(TALLY, { tally: TALLY });
    expect(collision.code).toBe("MODULE_NAME_COLLISION");
    expect(collision.message).toContain("differ only by case");
  });
});

describe.skipIf(skip)("hypen build --target wasm with prebuilt modules", () => {
  const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
    const log = console.log;
    console.log = () => {};
    try {
      return await run();
    } finally {
      console.log = log;
    }
  };

  test("a prebuilt module is copied into the output and listed with its grants; no toolchain is needed", async () => {
    const dir = project("build");
    // `App` exists only as a template: the declaration without `template` adopts it.
    write(join(dir, "src/components/App/component.hypen"), `Column { Header {} Tally {} }`);
    write(join(dir, "modules/app/app.wasm"), readFileSync(fixture("seeded_module.wasm")));
    const manifest = await quiet(() =>
      buildWasm({
        root: dir,
        components: "./src/components",
        entry: "App",
        wasm: {
          modules: {
            App: { component: "./modules/app/app.wasm", reads: ["Tally"] },
            Tally: { ...TALLY, dispatches: ["App"] },
          },
        },
      })
    );
    expect(manifest).toEqual({
      entry: "App",
      modules: [
        { name: "App", wasm: "App.wasm", ui: "App.hypen", reads: ["tally"], dispatches: [], storage: [], http: false },
        { name: "Tally", wasm: "Tally.wasm", ui: "Tally.hypen", reads: [], dispatches: ["app"], storage: ["cloud"], http: false },
        { name: "Header", ui: "Header.hypen" },
      ],
    });
    const out = join(dir, "dist/wasm");
    expect(JSON.parse(readFileSync(join(out, "app.json"), "utf8"))).toEqual(manifest);
    expect(readFileSync(join(out, "Tally.wasm")).equals(readFileSync(fixture("counter_module.wasm")))).toBe(true);
    expect(readFileSync(join(out, "App.wasm")).equals(readFileSync(fixture("seeded_module.wasm")))).toBe(true);
    expect(readFileSync(join(out, "Tally.hypen"), "utf8")).toBe(TALLY_UI);
    expect(readFileSync(join(out, "App.hypen"), "utf8")).toBe(`Column { Header {} Tally {} }`);
  });

  test("a prebuilt module's own sources do not trip the single-language checks", async () => {
    const dir = project("lang");
    // A Rust crate beside the template, in a TypeScript project.
    write(join(dir, "src/components/Tally/component.hypen"), TALLY_UI);
    write(join(dir, "src/components/Tally/Cargo.toml"), `[package]\nname = "tally"\n`);
    write(join(dir, "src/components/Tally/tally.wasm"), readFileSync(fixture("counter_module.wasm")));
    const build = (wasm: unknown) =>
      quiet(() => buildWasm({ root: dir, components: "./src/components", entry: "Tally", wasm }));

    // Undeclared, the build refuses to drop the Rust module silently...
    expect((await buildError(() => build({}))).code).toBe("LANGUAGE_MIXED");
    // ...declared prebuilt, the directory supplies the template and the declared .wasm is the module.
    const manifest = await build({
      modules: { Tally: { component: "./src/components/Tally/tally.wasm", storage: ["cloud"] } },
    });
    expect(manifest.modules.map((m) => m.name)).toEqual(["Tally", "Header"]);
  });

  test("a prebuilt module that is also a source module is a collision", async () => {
    const dir = project("collide");
    write(join(dir, "src/components/Tally/component.hypen"), TALLY_UI);
    write(
      join(dir, "src/components/Tally/component.ts"),
      `export default { name: "Tally", actions: ["increment"], stateKeys: ["count"], initialState: { count: 0 }, handlers: { onAction: new Map([["increment", () => {}]]) } };`
    );
    const err = await buildError(() =>
      quiet(() => buildWasm({ root: dir, components: "./src/components", entry: "Tally", wasm: { modules: { Tally: TALLY } } }))
    );
    expect(err).toMatchObject({ code: "MODULE_NAME_COLLISION", module: "Tally", field: "wasm.modules.Tally.component" });
    expect(err.message).toContain("is also a source module");
  });

  test("two templates, no template, and an unknown grant target", async () => {
    const dir = project("templates");
    write(join(dir, "src/components/Tally/component.hypen"), TALLY_UI);
    const build = (modules: Record<string, unknown>) =>
      buildError(() => quiet(() => buildWasm({ root: dir, components: "./src/components", entry: "Tally", wasm: { modules } })));

    const twice = await build({ Tally: TALLY });
    expect(twice).toMatchObject({ code: "MODULE_NAME_COLLISION", field: "wasm.modules.Tally.template" });
    expect(twice.message).toContain("has two templates");

    rmSync(join(dir, "src/components/Tally"), { recursive: true });
    const none = await build({ Tally: { component: TALLY.component } });
    expect(none).toMatchObject({ code: "PREBUILT_TEMPLATE_MISSING", field: "wasm.modules.Tally.template" });

    const unknown = await build({ Tally: { ...TALLY, reads: ["Cart"] } });
    expect(unknown).toMatchObject({ code: "CONFIG_UNKNOWN_MODULE", field: "wasm.modules.Tally.reads" });
  });
});

describe.skipIf(skip)("other build targets", () => {
  test("the browser SPA build refuses a project with prebuilt modules", async () => {
    const dir = project("spa");
    write(join(dir, "src/components/App/component.hypen"), `Text("App")`);
    const err = await buildError(() =>
      buildSpa({ root: dir, components: "./src/components", entry: "App", log: false, wasm: { modules: { Tally: TALLY } } })
    );
    expect(err).toMatchObject({
      code: "PREBUILT_UNSUPPORTED_TARGET",
      module: "Tally",
      field: "wasm.modules.Tally.component",
    });
    expect(err.message).toContain("browser engine has no hosted-module support");
    expect(err.hint).toContain("--target wasm");
    expect(existsSync(join(dir, "dist"))).toBe(false);
  });

  test("a server-based build mirrors the modules' files under the output directory", () => {
    const dir = project("server");
    const modules = resolvePrebuiltModules(parseWasmConfig({ modules: { Tally: TALLY } }), dir);
    const { copied, outside } = copyPrebuiltModules(modules, dir, join(dir, "dist"));
    expect(outside).toEqual([]);
    expect(copied).toEqual([
      { name: "Tally", files: [join(dir, "dist/modules/tally/tally.wasm"), join(dir, "dist/modules/tally/Tally.hypen")] },
    ]);
    expect(existsSync(join(dir, "dist/modules/tally/tally.wasm"))).toBe(true);

    // A module outside the project cannot be mirrored: reported, not copied.
    const elsewhere = resolvePrebuiltModules(
      parseWasmConfig({ modules: { Tally: { component: fixture("counter_module.wasm") } } }),
      dir
    );
    expect(copyPrebuiltModules(elsewhere, dir, join(dir, "dist")).outside).toEqual([
      { name: "Tally", files: [fixture("counter_module.wasm")] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// dev server
// ---------------------------------------------------------------------------

type Patch = Record<string, any>;

/** A minimal renderer: a WebSocket client that tracks the tree's texts and can click buttons. */
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
  const until = async (check: () => void, timeout = 5000): Promise<void> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        return check();
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  };
  await until(() => expect(types).toContain("initialTree"));
  return {
    types,
    texts,
    until,
    click(label: string, action: string) {
      const button = patches.find((p) => p.type === "create" && p.elementType === "Button" && p.semantics?.name === label);
      if (!button) throw new Error(`no button ${label}`);
      socket.send(
        JSON.stringify({ type: "dispatchAction", module: "App", action: "__hypen_dispatch", payload: { node: button.id, action, payload: {} } })
      );
    },
    close: () => socket.close(),
  };
}

let nextPort = 19930;

describe.skipIf(skip)("hypen dev with prebuilt modules", () => {
  /** A TS entry + a prebuilt module, with absolute paths (the dev server's project root is the cwd). */
  function devProject(tag: string) {
    const dir = project(tag);
    write(join(dir, "src/components/App/component.hypen"), `module App {\n  Column {\n    Text("App: @{state.title}")\n    Tally {}\n  }\n}`);
    write(
      join(dir, "src/components/App/component.ts"),
      `export default { actions: [], stateKeys: ["title"], initialState: { title: "mixed" }, handlers: { onAction: new Map() } };`
    );
    const wasmPath = join(dir, "modules/tally/tally.wasm");
    const templatePath = join(dir, "modules/tally/Tally.hypen");
    const configFile = join(dir, "hypen.json");
    const config = (grants: Record<string, unknown> = { storage: ["cloud"] }) => ({
      components: "./src/components",
      entry: "App",
      wasm: { modules: { Tally: { component: wasmPath, template: templatePath, ...grants } } },
    });
    writeFileSync(configFile, JSON.stringify(config()));
    return { dir, wasmPath, templatePath, configFile, config };
  }

  async function start(p: ReturnType<typeof devProject>, lines: string[]) {
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
      components: join(p.dir, "src/components"),
      entry: "App",
      port,
      hot: true,
      wasm: p.config().wasm,
      configFile: p.configFile,
    });
    stops.push(() => server.stop());
    return port;
  }

  test("loads the module next to the TS entry; a client click reaches it", async () => {
    const p = devProject("dev");
    const lines: string[] = [];
    const port = await start(p, lines);
    expect(lines.join("\n")).toContain("Prebuilt:");
    const c = await client(port);
    stops.push(() => c.close());
    expect(c.texts()).toEqual(expect.arrayContaining(["App: mixed", "Tally: 0"]));
    c.click("Tally +1", "increment");
    await c.until(() => expect(c.texts()).toContain("Tally: 1"));
  });

  test("hot reload: a rebuilt .wasm replaces the running module in place, state kept", async () => {
    const p = devProject("reload");
    const lines: string[] = [];
    const port = await start(p, lines);
    const c = await client(port);
    stops.push(() => c.close());
    c.click("Tally +1", "increment");
    c.click("Tally +1", "increment");
    await c.until(() => expect(c.texts()).toContain("Tally: 2"));
    const messages = c.types.length;

    // "Rebuild": another component with the same state shape. Written to a
    // temp name and renamed over, as toolchains do.
    copyFileSync(fixture("seeded_module.wasm"), `${p.wasmPath}.tmp`);
    const { renameSync } = await import("fs");
    renameSync(`${p.wasmPath}.tmp`, p.wasmPath);
    await c.until(() => expect(lines.join("\n")).toMatch(/Reloaded.*Tally.*1 session\(s\) kept their state/));

    // Same connection (no reconnect), same state, new code.
    expect(c.types.slice(messages)).not.toContain("initialTree");
    c.click("Tally +1", "increment");
    await c.until(() => expect(c.texts()).toContain("Tally: 3"));
  });

  test("hot reload of a component that no longer instantiates keeps the old instance and says why", async () => {
    const p = devProject("broken");
    const lines: string[] = [];
    const port = await start(p, lines);
    const c = await client(port);
    stops.push(() => c.close());
    c.click("Tally +1", "increment");
    await c.until(() => expect(c.texts()).toContain("Tally: 1"));

    // limits_module imports hypen:storage/app, which hypen.json does not grant.
    copyFileSync(fixture("limits_module.wasm"), p.wasmPath);
    await c.until(() => expect(lines.join("\n")).toContain("Not reloaded: Tally keeps running its previous build."));
    const output = lines.join("\n");
    expect(output).toContain("hypen:storage/app");
    expect(output).toContain("field:   hypen.json wasm.modules.Tally.storage");
    expect(output).toContain('add "app" to hypen.json wasm.modules.Tally.storage');
    c.click("Tally +1", "increment");
    await c.until(() => expect(c.texts()).toContain("Tally: 2"));

    // Granting it in hypen.json is picked up without a restart.
    lines.length = 0;
    writeFileSync(p.configFile, JSON.stringify(p.config({ storage: ["cloud", "app"] })));
    await c.until(() => expect(lines.join("\n")).toMatch(/Reloaded.*Tally/));
  });

  test("startup errors name the hypen.json field", async () => {
    const p = devProject("startup");
    const run = (wasm: unknown) =>
      buildError(() => dev({ components: join(p.dir, "src/components"), entry: "App", port: nextPort++, hot: false, wasm }));
    expect(await run({ modules: { Tally: { component: join(p.dir, "nope.wasm") } } })).toMatchObject({
      code: "PREBUILT_COMPONENT_MISSING",
      field: "wasm.modules.Tally.component",
    });

    // A grant the component needs is missing: the server refuses to start.
    let thrown: unknown;
    try {
      await dev({
        components: join(p.dir, "src/components"),
        entry: "App",
        port: nextPort++,
        hot: false,
        wasm: p.config({}).wasm,
      });
    } catch (err) {
      thrown = err;
    }
    expect(isHostedSetupError(thrown)).toBe(true);
    const lines = formatHostedSetupError(thrown as never).join("\n");
    expect(lines).toContain("hypen:storage/cloud");
    expect(lines).toContain("field:   hypen.json wasm.modules.Tally.storage");
    expect(lines).toContain('Hint: grant the "cloud" storage tier: add "cloud" to hypen.json wasm.modules.Tally.storage');
  });

  test("a project's @hypen-space/server without hosted-module support is an error, not a silent skip", async () => {
    const p = devProject("oldserver");
    const err = await buildError(
      () => new DevPrebuiltModules({ wasm: p.config().wasm, projectRoot: p.dir, serverPackage: {} })
    );
    expect(err.code).toBe("PREBUILT_UNSUPPORTED_TARGET");
    expect(err.hint).toContain("@hypen-space/module-host");
    // No prebuilt modules: nothing is required of the server package.
    expect(new DevPrebuiltModules({ wasm: undefined, projectRoot: p.dir, serverPackage: {} }).size).toBe(0);
  });
});

describe.skipIf(skip)("httpHosts for a prebuilt module", () => {
  test("is written to app.json only when it names hosts", async () => {
    const dir = project("http-hosts");
    write(join(dir, "src/components/App/component.hypen"), `Column { Tally {} }`);
    write(join(dir, "modules/app/app.wasm"), readFileSync(fixture("seeded_module.wasm")));
    const log = console.log;
    console.log = () => {};
    let manifest: Awaited<ReturnType<typeof buildWasm>>;
    try {
      manifest = await buildWasm({
        root: dir,
        components: "./src/components",
        entry: "App",
        wasm: {
          modules: {
            App: { component: "./modules/app/app.wasm", http: true, httpHosts: ["API.example.com", "*.example.org:8443"] },
            Tally: { ...TALLY, http: true },
          },
        },
      });
    } finally {
      console.log = log;
    }
    expect(manifest.modules.slice(0, 2)).toEqual([
      {
        name: "App",
        wasm: "App.wasm",
        ui: "App.hypen",
        reads: [],
        dispatches: [],
        storage: [],
        http: true,
        httpHosts: ["api.example.com", "*.example.org:8443"],
      },
      // No allowlist: no key (an empty list would read as "no hosts" and mean "any").
      { name: "Tally", wasm: "Tally.wasm", ui: "Tally.hypen", reads: [], dispatches: [], storage: ["cloud"], http: true },
    ]);
    const onDisk = JSON.parse(readFileSync(join(dir, "dist/wasm/app.json"), "utf8"));
    expect(onDisk).toEqual(manifest);
    expect(Object.keys(onDisk.modules[0])).toEqual(["name", "wasm", "ui", "reads", "dispatches", "storage", "http", "httpHosts"]);
  });
});

describe("dev diagnostics rendering", () => {
  test("a failed HTTP request shows the request, how it ended, and the field to change", () => {
    const lines = formatHostedFailure({
      kind: "http",
      module: "Weather",
      scope: "weather",
      action: "loaded",
      message:
        "GET http://127.0.0.1:8080/forecast refused (denied): request to 127.0.0.1:8080 refused: it is a loopback address",
      hint: 'add "127.0.0.1:8080" to hypen.json wasm.modules.Weather.httpHosts',
      missingGrant: { field: "httpHosts", value: "127.0.0.1:8080" },
      http: { method: "GET", url: "http://127.0.0.1:8080/forecast", errorKind: "denied", refusedBy: "policy" },
    });
    expect(lines).toEqual([
      'Weather "loaded": HTTP request did not complete',
      "  GET http://127.0.0.1:8080/forecast refused (denied): request to 127.0.0.1:8080 refused: it is a loopback address",
      "  request: GET http://127.0.0.1:8080/forecast → denied; refused by policy",
      '  missing grant: httpHosts ← "127.0.0.1:8080"',
      '  Hint: add "127.0.0.1:8080" to hypen.json wasm.modules.Weather.httpHosts',
    ]);
  });

  test("an engine-side HTTP refusal in a cascade names the request it was about", () => {
    const lines = formatHostedFailure({
      kind: "cascade",
      module: "Weather",
      scope: "weather",
      action: "refresh",
      message: "[weather] http request GET https://api.example.com/ dropped: too many requests in flight (limit 32)",
      hint: '"Weather" already has 32 requests in flight',
      report: {
        root: { kind: "dispatch", scope: "weather", action: "refresh" },
        rootFailed: false,
        failureCount: 2,
        failures: [
          {
            scope: "weather",
            action: "loaded",
            outcome: "dropped",
            isRoot: false,
            origin: { kind: "httpRequest", method: "GET", url: "https://api.example.com/" },
            cause: { code: "httpLimit", limit: 32, per: "module" },
            message: "dropped",
          },
          {
            scope: "weather",
            action: "loaded",
            outcome: "refused",
            isRoot: false,
            origin: { kind: "httpRequest", method: "GET", url: "https://api.example.com/" },
            cause: { code: "httpNotGranted", grant: "http" },
            message: "refused",
          },
        ],
        message: "",
      },
      missingGrant: { field: "http", value: "true" },
    });
    expect(lines).toEqual([
      'Weather "refresh": action ran, but its follow-ups failed',
      "  [weather] http request GET https://api.example.com/ dropped: too many requests in flight (limit 32)",
      "  cascade: weather refresh — 2 failures (applied state stands)",
      "    - weather loaded [dropped; http request GET https://api.example.com/] httpLimit",
      "    - weather loaded [refused; http request GET https://api.example.com/] httpNotGranted",
      "  missing grant: http ← true",
      '  Hint: "Weather" already has 32 requests in flight',
    ]);
  });

  test("a cascade failure shows module, action, cause and the missing grant", () => {
    const lines = formatHostedFailure({
      kind: "cascade",
      module: "Pricing",
      scope: "pricing",
      action: "quote",
      message: "[cart] 'applyDiscount' refused: 'pricing' may not dispatch to 'cart'",
      hint: '"Pricing" may not dispatch to "cart": add "cart" to hypen.json wasm.modules.Pricing.dispatches',
      missingGrant: { field: "dispatches", value: "cart" },
      report: {
        root: { kind: "dispatch", scope: "pricing", action: "quote" },
        rootFailed: false,
        failureCount: 1,
        failures: [
          {
            scope: "cart",
            action: "applyDiscount",
            outcome: "refused",
            isRoot: false,
            origin: { kind: "crossDispatch", from: "pricing" },
            cause: { code: "dispatchDenied", grant: "dispatches", missingGrant: "cart" },
            message: "refused",
          },
        ],
        message: "",
      },
    });
    expect(lines).toEqual([
      'Pricing "quote": action ran, but its follow-ups failed',
      "  [cart] 'applyDiscount' refused: 'pricing' may not dispatch to 'cart'",
      "  cascade: pricing quote — 1 failure (applied state stands)",
      '    - cart applyDiscount [refused; dispatched by "pricing"] dispatchDenied',
      '  missing grant: dispatches ← "cart"',
      '  Hint: "Pricing" may not dispatch to "cart": add "cart" to hypen.json wasm.modules.Pricing.dispatches',
    ]);
  });
});
