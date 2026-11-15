/**
 * `hypen build --target wasm`: the bad paths. Every failure a user can hit
 * should be a `BuildError` with a stable code, the thing it concerns, and a
 * next step — and should leave the project and any previous output intact.
 *
 * None of this needs a real wasm toolchain: tinygo / wit-bindgen-go / go /
 * jco / rustc are replaced by small shell scripts that behave (or misbehave)
 * on demand, which also exercises the whole orchestration — staging,
 * artifact checks, manifest, publish — in milliseconds.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { delimiter, dirname, join, resolve } from "path";
import { spawn, spawnSync } from "bun";
import {
  BuildError,
  buildWasm,
  classifyWasm,
  detectProjectLanguage,
  formatBuildError,
  parseModuleName,
  parseWasmConfig,
  provisionRustWit,
  resolveModuleCapabilities,
  type BuildErrorCode,
  type BuildWasmOptions,
} from "../src/build-wasm.js";
import { expectSuccess, runTool } from "../src/wasm/process.js";
import { findGoToolchain, findRustToolchain } from "../src/wasm/toolchain.js";
import { vendoredWitDeclaresModule } from "../src/wasm/wit.js";

const fixtures = join(import.meta.dir, "fixtures");
const repoRoot = resolve(import.meta.dir, "..", "..");
const cliPath = join(import.meta.dir, "..", "bin", "hypen.ts");

let root: string;
let logSpy: ReturnType<typeof spyOn>;
const realPath = process.env.PATH ?? "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hypen-wasm-bad-"));
  // The build's progress output is not under test here.
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  logSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  process.env.PATH = realPath;
});

/** A fresh directory under the suite's temp root. */
const scratch = (tag: string) => mkdtempSync(join(root, `${tag}-`));

/** Write files (path → content) under `dir`, creating directories. */
function write(dir: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** Copy a fixture into a fresh directory. */
function copyFixture(fixture: string): string {
  const proj = scratch(fixture);
  cpSync(join(fixtures, fixture), proj, { recursive: true });
  return proj;
}

const build = (proj: string, options: Partial<BuildWasmOptions> = {}) =>
  buildWasm({ root: proj, components: "./src/components", entry: "Counter", ...options });

/** The BuildError a promise rejects with (fails on anything else). */
async function failure(promise: Promise<unknown>): Promise<BuildError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof BuildError) return e;
    throw e;
  }
  throw new Error("expected the build to fail");
}

/** Private build directories left in `<proj>/dist` (there should be none). */
const leftovers = (proj: string, outDir = "dist") =>
  existsSync(join(proj, outDir))
    ? readdirSync(join(proj, outDir)).filter((f) => f.startsWith(".wasm-"))
    : [];

// ── Fake toolchains ──────────────────────────────────────────────────────────

/** What a fake compiler does when asked to produce `-o <path>`. */
type FakeOutput =
  | "component" // a valid component preamble
  | "core-module" // valid wasm, but a core module
  | "empty" // a zero-byte file
  | "garbage" // not wasm at all
  | "nothing" // exit 0, write nothing
  | "fail" // diagnostics on stderr, exit 2
  | "hang"; // never finish (until killed)

const OUTPUT_SCRIPT: Record<FakeOutput, string> = {
  component: `printf '\\000asm\\015\\000\\001\\000' > "$out"`,
  "core-module": `printf '\\000asm\\001\\000\\000\\000' > "$out"`,
  empty: `: > "$out"`,
  garbage: `echo "this is not wasm" > "$out"`,
  nothing: `:`,
  fail: `echo "counter.go:12:3: undefined: nope" >&2; echo "compilation failed" >&2; exit 2`,
  // Bounded, so a test that fails to kill it cannot leak a process forever.
  hang: `echo started >&2; i=0; while [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done`,
};

/** A script that finds its `-o <path>` argument and then runs `body`. */
const compilerScript = (preamble: string, output: FakeOutput) =>
  `#!/bin/sh\n${preamble}\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\n${OUTPUT_SCRIPT[output]}\n`;

function installScripts(dir: string, scripts: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/** A bin dir with fake `tinygo`, `wit-bindgen-go` and `go`. */
function fakeGoToolchain(
  options: { output?: FakeOutput; version?: string; omit?: Array<"tinygo" | "wit-bindgen-go" | "go"> } = {}
): string {
  const { output = "component", version = "0.39.0", omit = [] } = options;
  const scripts: Record<string, string> = {
    tinygo: compilerScript(
      `if [ "$1" = "version" ]; then echo "tinygo version ${version} linux/amd64 (using go version go1.25.0 and LLVM version 19.1.2)"; exit 0; fi`,
      output
    ),
    "wit-bindgen-go": `#!/bin/sh\nexit 0\n`,
    go: `#!/bin/sh\nexit 0\n`,
  };
  for (const name of omit) delete scripts[name];
  return installScripts(scratch("gobin"), scripts);
}

/** A Go project (wit-mode Counter + stateless Banner) that needs no SDK. */
function goProject(): string {
  return write(scratch("goproj"), {
    "go.mod": "module example.com/app\n\ngo 1.25.0\n",
    "hypen.json": JSON.stringify({ components: "./src/components", entry: "Counter" }),
    "src/components/Counter/component.hypen": "Text(\"@{state.count}\")\n",
    "src/components/Counter/main.go": "package main\n\nfunc main() {}\n",
    "src/components/Banner/component.hypen": "Text(\"hi\")\n",
  });
}

/** Run `fn` with PATH replaced by `bin` (so only the fake tools resolve). */
async function withPath<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  process.env.PATH = bin;
  try {
    return await fn();
  } finally {
    process.env.PATH = realPath;
  }
}

/** The TS fixture with the in-repo SDK linked in and a fake project-local jco. */
function tsProject(jco: FakeOutput | null, files: Record<string, string> = {}): string {
  const proj = copyFixture("wasm-app");
  const scope = join(proj, "node_modules", "@hypen-space");
  mkdirSync(scope, { recursive: true });
  symlinkSync(join(repoRoot, "hypen-web", "packages", "core"), join(scope, "core"));
  symlinkSync(join(repoRoot, "hypen-web", "packages", "server"), join(scope, "server"));
  if (jco !== null) {
    installScripts(join(proj, "node_modules", ".bin"), { jco: compilerScript("", jco) });
  }
  return write(proj, files);
}

const haveCargo = (() => {
  try {
    return spawnSync({ cmd: ["cargo", "--version"], stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
})();

// ── Project layout ───────────────────────────────────────────────────────────

describe("wasm build errors: project layout", () => {
  test("a missing components directory", async () => {
    const proj = write(scratch("nocomp"), { "Cargo.toml": "[package]\nname = \"x\"\n" });
    const err = await failure(build(proj));
    expect(err.code).toBe("COMPONENTS_DIR_MISSING");
    expect(err.message).toBe(`Components directory not found: ${join(proj, "src", "components")}`);
    expect(err.field).toBe("components");
    expect(err.hint).toContain(`"components" in hypen.json`);
    // Failing this early touches nothing.
    expect(existsSync(join(proj, "dist"))).toBe(false);
  });

  test("a components path that is a file", async () => {
    const proj = write(scratch("filecomp"), { "go.mod": "module x\n", "src/components": "oops" });
    const err = await failure(build(proj));
    expect(err.code).toBe("COMPONENTS_DIR_MISSING");
    expect(err.message).toContain("is not a directory");
  });

  test("an empty components directory", async () => {
    const proj = write(scratch("empty"), { "go.mod": "module x\n" });
    mkdirSync(join(proj, "src", "components"), { recursive: true });
    const err = await failure(build(proj));
    expect(err.code).toBe("NO_COMPONENTS");
    expect(err.message).toBe(`No components found in ${join(proj, "src", "components")}.`);
    expect(existsSync(join(proj, "dist"))).toBe(false);
  });

  test("only template-only components: nothing to compile", async () => {
    // A TypeScript project (no marker file) whose entry has no module.
    const proj = write(scratch("stateless"), {
      "src/components/Counter/component.hypen": "Text(\"static\")\n",
      "src/components/Header/component.hypen": "Text(\"head\")\n",
    });
    const err = await failure(build(proj));
    expect(err.code).toBe("NO_STATEFUL_MODULES");
    expect(err.message).toContain("every component is template-only");
    expect(err.hint).toContain("Counter.ts with app.defineState(...).build()");
  });

  test("an entry that names nothing", async () => {
    const err = await failure(build(goProject(), { entry: "Nope" }));
    expect(err.code).toBe("ENTRY_NOT_FOUND");
    expect(err.message).toBe(`Entry module "Nope" not found among stateful components (Counter).`);
    expect(err.field).toBe("entry");
    expect(err.hint).toContain("Nope/ to contain Go source");
  });

  test("an entry that names a stateless component says so", async () => {
    const err = await failure(build(goProject(), { entry: "Banner" }));
    expect(err.code).toBe("ENTRY_NOT_FOUND");
    expect(err.hint).toContain(`"Banner" is a stateless (template-only) component`);
  });

  test("module names differing only by case collide on the lowercased scope", async () => {
    const proj = goProject();
    write(proj, {
      "src/components/counter/component.hypen": "Text(\"x\")\n",
      "src/components/counter/main.go": "package main\n",
    });
    const err = await failure(build(proj));
    expect(err.code).toBe("MODULE_NAME_COLLISION");
    expect(err.message).toBe(
      `Components "Counter" and "counter" differ only by case: both would use the state scope "counter".`
    );
    expect(existsSync(join(proj, "dist"))).toBe(false);
  });

  test("a name the engine cannot use as a scope", async () => {
    const proj = goProject();
    write(proj, { "src/components/Cart:Items/component.hypen": "Text(\"x\")\n" });
    const err = await failure(build(proj));
    expect(err.code).toBe("MODULE_NAME_INVALID");
    expect(err.module).toBe("Cart:Items");
    expect(err.message).toContain(`must not contain ":"`);
    expect(() => parseModuleName("")).toThrow(BuildError);
    expect(parseModuleName("Counter") as string).toBe("Counter");
  });
});

describe("wasm build errors: language", () => {
  test("Cargo.toml and go.mod together are ambiguous until wasm.language says which", async () => {
    const proj = goProject();
    write(proj, { "Cargo.toml": "[package]\nname = \"x\"\n" });
    const err = await failure(build(proj));
    expect(err.code).toBe("LANGUAGE_AMBIGUOUS");
    expect(err.message).toContain("has both Cargo.toml and go.mod");
    expect(err.hint).toContain(`"wasm": { "language": "rust" } (or "go")`);
    // The override settles it.
    expect(detectProjectLanguage(proj, "go")).toEqual({ language: "go", from: "config" });
    expect(detectProjectLanguage(goProject())).toEqual({ language: "go", from: "marker", file: "go.mod" });
    expect(detectProjectLanguage(scratch("plain"))).toEqual({ language: "ts", from: "default" });
  });

  test("a component with another language's module is not silently demoted to stateless", async () => {
    const proj = goProject();
    write(proj, {
      "src/components/Cart/component.hypen": "Text(\"cart\")\n",
      "src/components/Cart/component.ts": "export default {};\n",
    });
    const err = await failure(build(proj));
    expect(err.code).toBe("LANGUAGE_MIXED");
    expect(err.module).toBe("Cart");
    expect(err.message).toContain(`Component "Cart" has TypeScript module sources, but this is a Go build`);
    expect(err.hint).toContain(`"wasm": { "language": "ts" }`);
  });

  test("a Rust project's stateless component may not carry Go sources either", async () => {
    const proj = copyFixture("wasm-rust-app");
    write(proj, { "src/components/Banner/banner.go": "package banner\n" });
    const err = await failure(build(proj));
    expect(err.code).toBe("LANGUAGE_MIXED");
    expect(err.message).toContain(`"Banner" has Go module sources, but this is a Rust build`);
  });
});

describe("wasm build errors: output directory", () => {
  test("an output directory inside the components directory", async () => {
    const proj = goProject();
    const err = await failure(build(proj, { outDir: "src/components" }));
    expect(err.code).toBe("OUTDIR_UNSAFE");
    expect(err.message).toContain("is inside the components directory");
    expect(err.field).toBe("outDir");
  });

  test("an output directory that contains the sources", async () => {
    // components at <out>/wasm/components: publishing would delete them.
    const proj = write(scratch("inside"), {
      "go.mod": "module x\n",
      "build/wasm/components/Counter/component.hypen": "Text(\"x\")\n",
      "build/wasm/components/Counter/main.go": "package main\n",
    });
    const err = await failure(build(proj, { components: "build/wasm/components", outDir: "build" }));
    expect(err.code).toBe("OUTDIR_UNSAFE");
    expect(err.message).toContain("contains the project's sources");
    expect(existsSync(join(proj, "build/wasm/components/Counter/main.go"))).toBe(true);
  });

  test("an existing <outDir>/wasm that is not build output is not replaced", async () => {
    const proj = goProject();
    write(proj, { "dist/wasm/notes.txt": "mine", "dist/wasm/Old.wasm": "x" });
    const err = await failure(build(proj));
    expect(err.code).toBe("OUTDIR_UNSAFE");
    expect(err.message).toContain("holds files that are not wasm build output (notes.txt)");
    expect(readFileSync(join(proj, "dist/wasm/notes.txt"), "utf8")).toBe("mine");
  });

  test("an output directory that cannot be created", async () => {
    const proj = goProject();
    // A path beneath a regular file can never be a directory (this holds for
    // root too, unlike a permission bit).
    const err = await failure(build(proj, { outDir: "hypen.json/out" }));
    expect(err.code).toBe("OUTDIR_NOT_WRITABLE");
    expect(err.message).toContain("Cannot write to the output directory");
    expect(err.hint).toContain("--out-dir");
  });

  test("a Go app-mode build needs its work directory inside the Go module", async () => {
    const proj = copyFixture("wasm-go-app-api");
    const outside = scratch("outside");
    const err = await withPath(fakeGoToolchain(), () => failure(build(proj, { outDir: outside })));
    expect(err.code).toBe("OUTDIR_UNSAFE");
    expect(err.message).toContain("outside the Go module");
    expect(leftovers(outside, ".")).toEqual([]);
  });
});

// ── Config ───────────────────────────────────────────────────────────────────

describe("wasm build errors: hypen.json wasm config", () => {
  const configError = (raw: unknown): BuildError => {
    try {
      parseWasmConfig(raw);
    } catch (e) {
      if (e instanceof BuildError) return e;
      throw e;
    }
    throw new Error("expected a config error");
  };

  test.each([
    [{ lang: "ts" }, "wasm.lang", `did you mean "wasm.language"?`],
    [{ module: {} }, "wasm.module", `did you mean "wasm.modules"?`],
    [{ zzz: 1 }, "wasm.zzz", `remove "zzz" from wasm in hypen.json`],
    [{ language: "python" }, "wasm.language", `set "language" to "ts", "go" or "rust"`],
    [{ language: 3 }, "wasm.language", `set "language"`],
    [[], "wasm", `"wasm": {`],
    [{ modules: "Cart" }, "wasm.modules", `"modules": {`],
    [{ modules: { Cart: null } }, "wasm.modules.Cart", `"reads"`],
    [{ modules: { Cart: { read: [] } } }, "wasm.modules.Cart.read", `did you mean "wasm.modules.Cart.reads"?`],
    [{ modules: { Cart: { dispatch: [] } } }, "wasm.modules.Cart.dispatch", `did you mean "wasm.modules.Cart.dispatches"?`],
    [{ modules: { Cart: { HTTP: true } } }, "wasm.modules.Cart.HTTP", `did you mean "wasm.modules.Cart.http"?`],
    [{ modules: { Cart: { reads: "Catalog" } } }, "wasm.modules.Cart.reads", `"reads": ["Catalog"]`],
    [{ modules: { Cart: { dispatches: [1] } } }, "wasm.modules.Cart.dispatches", `"dispatches": ["Catalog"]`],
    [{ modules: { Cart: { storage: "app" } } }, "wasm.modules.Cart.storage", `"storage": ["app"]`],
    [{ modules: { Cart: { storage: ["local"] } } }, "wasm.modules.Cart.storage", `remove "local"`],
    [{ modules: { Cart: { storage: [1] } } }, "wasm.modules.Cart.storage", `use "app" and/or "cloud"`],
    [{ modules: { Cart: { http: "true" } } }, "wasm.modules.Cart.http", `"http": true`],
  ])("%j → CONFIG_INVALID at the offending field, with a fix", (raw, field, hint) => {
    const err = configError(raw);
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.file).toBe("hypen.json");
    expect(err.field).toBe(field);
    expect(err.hint).toContain(hint);
    expect(err.message.startsWith("hypen.json: ")).toBe(true);
  });

  test("grants naming unknown, miscased or stateless modules", () => {
    const stateful = ["Cart", "Catalog"].map(parseModuleName);
    const stateless = ["Header"].map(parseModuleName);
    const resolveError = (modules: unknown): BuildError => {
      try {
        resolveModuleCapabilities(parseWasmConfig({ modules }), stateful, stateless);
      } catch (e) {
        if (e instanceof BuildError) return e;
        throw e;
      }
      throw new Error("expected an error");
    };
    const ghost = resolveError({ Ghost: {} });
    expect(ghost.code).toBe("CONFIG_UNKNOWN_MODULE");
    expect(ghost.field).toBe("wasm.modules.Ghost");
    expect(ghost.message).toBe(
      `hypen.json: wasm.modules.Ghost: no module named "Ghost". Stateful modules: Cart, Catalog`
    );
    expect(resolveError({ cart: {} }).hint).toBe(`rename the key to "Cart" (wasm.modules keys are case-sensitive)`);
    const header = resolveError({ Header: { http: true } });
    expect(header.code).toBe("CONFIG_UNKNOWN_MODULE");
    expect(header.message).toContain(`"Header" is a stateless (template-only) component`);
    const reads = resolveError({ Cart: { reads: ["Header"] } });
    expect(reads.field).toBe("wasm.modules.Cart.reads");
    expect(reads.message).toContain(`names unknown module "Header"`);
    expect(reads.hint).toContain(`"Header" is stateless (it has no state to read)`);
    expect(resolveError({ Cart: { dispatches: ["Ghost"] } }).field).toBe("wasm.modules.Cart.dispatches");
  });

  test("a bad config fails the build before anything is discovered or written", async () => {
    const proj = goProject();
    const err = await failure(build(proj, { wasm: { modules: { Counter: { htpp: true } } } }));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.hint).toBe(`did you mean "wasm.modules.Counter.http"?`);
    expect(existsSync(join(proj, "dist"))).toBe(false);
  });
});

// ── Toolchains ───────────────────────────────────────────────────────────────

describe("wasm build errors: Go toolchain", () => {
  test("lookups report found / missing / outdated as values", async () => {
    const cwd = scratch("cwd");
    await withPath(fakeGoToolchain(), async () => {
      expect(await findGoToolchain(cwd)).toEqual({ status: "found", tool: { tinygoVersion: "0.39.0" } });
    });
    await withPath(fakeGoToolchain({ version: "0.38.9" }), async () => {
      expect(await findGoToolchain(cwd)).toMatchObject({ status: "outdated", name: "tinygo", found: "0.38.9", required: "0.39" });
    });
    await withPath(fakeGoToolchain({ version: "1.0.0-dev-abc123" }), async () => {
      expect((await findGoToolchain(cwd)).status).toBe("found");
    });
    await withPath(fakeGoToolchain({ omit: ["go"] }), async () => {
      expect(await findGoToolchain(cwd)).toMatchObject({ status: "missing", name: "go" });
    });
  });

  test("tinygo not installed", async () => {
    const proj = goProject();
    const err = await withPath(fakeGoToolchain({ omit: ["tinygo"] }), () => failure(build(proj)));
    expect(err.code).toBe("TOOLCHAIN_MISSING");
    expect(err.message).toBe("The Go wasm target needs tinygo, which is not installed.");
    expect(err.hint).toContain("install TinyGo >= 0.39");
    expect(err.hint).toContain("https://tinygo.org/getting-started/install/");
    expect(leftovers(proj)).toEqual([]);
    // The build created dist/ for its work directory and removed it again.
    expect(existsSync(join(proj, "dist"))).toBe(false);
  });

  test("tinygo too old", async () => {
    const err = await withPath(fakeGoToolchain({ version: "0.37.0" }), () => failure(build(goProject())));
    expect(err.code).toBe("TOOLCHAIN_VERSION");
    expect(err.message).toBe("The Go wasm target needs tinygo >= 0.39, but found 0.37.0.");
    expect(err.hint).toContain("install TinyGo >= 0.39");
  });

  test("wit-bindgen-go not installed", async () => {
    const err = await withPath(fakeGoToolchain({ omit: ["wit-bindgen-go"] }), () => failure(build(goProject())));
    expect(err.code).toBe("TOOLCHAIN_MISSING");
    expect(err.message).toContain("needs wit-bindgen-go");
    expect(err.hint).toContain("go install go.bytecodealliance.org/cmd/wit-bindgen-go@latest");
  });

  test("a Go project without a go.mod module path", async () => {
    const proj = goProject();
    writeFileSync(join(proj, "go.mod"), "go 1.25.0\n");
    const err = await withPath(fakeGoToolchain(), () => failure(build(proj)));
    expect(err.code).toBe("GO_MODULE_INVALID");
    expect(err.file).toBe(join(proj, "go.mod"));
    expect(err.hint).toContain(`add a "module <path>" line`);
  });

  test("the compiler exits non-zero: command, exit code and stderr are on the error", async () => {
    const proj = goProject();
    const bin = fakeGoToolchain({ output: "fail" });
    const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    let err: BuildError;
    try {
      err = await withPath(bin, () => failure(build(proj)));
    } finally {
      errSpy.mockRestore();
    }
    expect(err.code).toBe("TOOL_FAILED");
    expect(err.message).toBe("tinygo build exited with code 2");
    expect(err.module).toBe("Counter");
    expect(err.tool?.exitCode).toBe(2);
    expect(err.tool?.cwd).toBe(proj);
    expect(err.tool?.command.slice(0, 3)).toEqual(["tinygo", "build", "-target=wasip2"]);
    expect(err.tool?.command.at(-1)).toBe(join(proj, "src", "components", "Counter"));
    expect(err.tool?.stderrTail).toBe("counter.go:12:3: undefined: nope\ncompilation failed");
    expect(err.tool?.streamed).toBe(true);
    expect(leftovers(proj)).toEqual([]);
    expect(existsSync(join(proj, "dist", "wasm"))).toBe(false);
  });

  test.each([
    ["nothing", "TOOL_NO_OUTPUT", "tinygo build reported success but did not write"],
    ["empty", "ARTIFACT_INVALID", "tinygo build produced an empty file for Counter"],
    ["garbage", "ARTIFACT_INVALID", "tinygo build produced not a WebAssembly binary for Counter"],
    ["core-module", "ARTIFACT_INVALID", "tinygo build produced a core WebAssembly module, not a Component for Counter"],
  ] as Array<[FakeOutput, BuildErrorCode, string]>)(
    "the compiler exits 0 but writes %s → %s",
    async (output, code, message) => {
      const proj = goProject();
      const err = await withPath(fakeGoToolchain({ output }), () => failure(build(proj)));
      expect(err.code).toBe(code);
      expect(err.message).toContain(message);
      expect(err.module).toBe("Counter");
      expect(err.hint).toContain("TinyGo >= 0.39");
      // Nothing half-built is published.
      expect(existsSync(join(proj, "dist", "wasm"))).toBe(false);
      expect(leftovers(proj)).toEqual([]);
    }
  );
});

describe("wasm build errors: TypeScript toolchain", () => {
  test("jco exits non-zero", async () => {
    const proj = tsProject("fail");
    const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    let err: BuildError;
    try {
      err = await failure(build(proj));
    } finally {
      errSpy.mockRestore();
    }
    expect(err.code).toBe("TOOL_FAILED");
    expect(err.message).toBe("jco componentize exited with code 2");
    expect(err.module).toBe("Counter");
    expect(err.tool?.command[0]).toBe(join(proj, "node_modules", ".bin", "jco"));
    expect(err.tool?.command).toContain("--world-name");
    expect(err.hint).toContain("--keep-temp");
  });

  test("jco exits 0 without writing the component", async () => {
    const err = await failure(build(tsProject("nothing")));
    expect(err.code).toBe("TOOL_NO_OUTPUT");
    expect(err.message).toContain("jco componentize reported success but did not write");
    expect(err.hint).toContain("bun add -d @bytecodealliance/jco@");
  });

  test("a module esbuild cannot bundle", async () => {
    // Loads under Bun (so discovery succeeds) but has no meaning in a wasm guest.
    const proj = tsProject("component", {
      "src/components/Counter/component.ts":
        `import { app } from "@hypen-space/core";\nimport "bun:sqlite";\n` +
        `export default app.defineState({ count: 0 }).onAction("inc", ({ state }) => { state.count++; }).build();\n`,
    });
    const errSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    let err: BuildError;
    try {
      err = await failure(build(proj));
    } finally {
      errSpy.mockRestore();
    }
    expect(err.code).toBe("BUNDLE_FAILED");
    expect(err.module).toBe("Counter");
    expect(err.message).toContain("esbuild could not bundle Counter (1 error(s))");
    expect(err.detail.join("\n")).toContain(`Could not resolve "bun:sqlite"`);
    expect(leftovers(proj)).toEqual([]);
  });

  test("a module that cannot be loaded", async () => {
    const proj = tsProject("component", {
      "src/components/Counter/component.ts": `import "./does-not-exist";\nexport default {};\n`,
    });
    const err = await failure(build(proj));
    expect(err.code).toBe("MODULE_LOAD_FAILED");
    expect(err.message).toContain("Could not load the project's modules");
    expect(err.message).toContain("does-not-exist");
  });
});

describe("wasm build errors: Rust toolchain and crates", () => {
  /** A bin dir with fake `cargo` + `rustc` reporting the given rustc. */
  const fakeRust = (rustcVersion: string, sysroot: string) =>
    installScripts(scratch("rustbin"), {
      cargo: `#!/bin/sh\necho "cargo ${rustcVersion}"\n`,
      rustc: `#!/bin/sh\nif [ "$1" = "--print" ]; then echo "${sysroot}"; else echo "rustc ${rustcVersion} (abc 2024-01-01)"; fi\n`,
    });

  test("lookups: missing cargo, old rustc, missing wasm32-wasip2 target", async () => {
    const cwd = scratch("cwd");
    const sysroot = scratch("sysroot");
    await withPath(scratch("nobin"), async () => {
      expect(await findRustToolchain(cwd)).toMatchObject({ status: "missing", name: "cargo" });
    });
    await withPath(fakeRust("1.81.0", sysroot), async () => {
      expect(await findRustToolchain(cwd)).toMatchObject({ status: "outdated", found: "1.81.0", required: "1.82" });
    });
    await withPath(fakeRust("1.90.0", sysroot), async () => {
      expect(await findRustToolchain(cwd)).toMatchObject({
        status: "missing",
        name: "the wasm32-wasip2 Rust target",
        hint: "install it: rustup target add wasm32-wasip2",
      });
    });
    mkdirSync(join(sysroot, "lib", "rustlib", "wasm32-wasip2"), { recursive: true });
    await withPath(fakeRust("1.90.0", sysroot), async () => {
      expect(await findRustToolchain(cwd)).toEqual({ status: "found", tool: { rustcVersion: "1.90.0" } });
    });
  });

  test("a missing target fails the build before the crate's wit/ is touched", async () => {
    const proj = copyFixture("wasm-rust-app");
    const err = await withPath(fakeRust("1.90.0", scratch("sysroot")), () => failure(build(proj)));
    expect(err.code).toBe("TOOLCHAIN_MISSING");
    expect(err.message).toBe("The Rust wasm target needs the wasm32-wasip2 Rust target, which is not installed.");
    expect(err.hint).toBe("install it: rustup target add wasm32-wasip2");
    expect(existsSync(join(proj, "wit"))).toBe(false);
    expect(leftovers(proj)).toEqual([]);
  });

  test("rust forced on a project with no Cargo.toml", async () => {
    const proj = goProject();
    const sysroot = scratch("sysroot");
    mkdirSync(join(sysroot, "lib", "rustlib", "wasm32-wasip2"), { recursive: true });
    const err = await withPath(fakeRust("1.90.0", sysroot), () =>
      failure(build(proj, { wasm: { language: "rust" } }))
    );
    // Counter's main.go makes it a Go module in a Rust build.
    expect(err.code).toBe("RUST_CRATE_INVALID");
    expect(err.file).toBe(join(proj, "Cargo.toml"));
    expect(err.message).toContain("does not exist");
  });

  test.skipIf(!haveCargo)("a crate that is not a cdylib is rejected before compiling", async () => {
    const proj = copyFixture("wasm-rust-app");
    const cargoToml = join(proj, "Cargo.toml");
    writeFileSync(cargoToml, readFileSync(cargoToml, "utf8").replace(`crate-type = ["cdylib"]`, `crate-type = ["rlib"]`));
    const err = await failure(build(proj));
    expect(err.code).toBe("RUST_CRATE_INVALID");
    expect(err.message).toContain("The crate for Counter is not a cdylib (crate types: rlib)");
    expect(err.hint).toContain(`crate-type = ["cdylib"]`);
    expect(err.file).toBe(cargoToml);
    // Rejected up front: nothing compiled, nothing provisioned.
    expect(existsSync(join(proj, "target"))).toBe(false);
    expect(existsSync(join(proj, "wit"))).toBe(false);
  });

  test.skipIf(!haveCargo)("a manifest cargo cannot read carries cargo's own diagnosis", async () => {
    const proj = copyFixture("wasm-rust-app");
    writeFileSync(join(proj, "Cargo.toml"), "[package\nname = ");
    const err = await failure(build(proj));
    expect(err.code).toBe("TOOL_FAILED");
    expect(err.message).toBe("cargo metadata exited with code 101");
    expect(err.tool?.command.slice(0, 3)).toEqual(["cargo", "metadata", "--no-deps"]);
    // Not streamed, so the printer shows it.
    expect(err.tool?.streamed).toBe(false);
    expect(err.tool?.stderrTail).toContain("Cargo.toml");
    expect(formatBuildError(err)).toContain("stderr:");
  });

  test.skipIf(!haveCargo)("a vendored wit/ contradicting the crate's ABI", async () => {
    const proj = copyFixture("wasm-rust-app-async"); // abi = "0.2"
    write(proj, { "wit/hypen-module.wit": "package hypen:module@0.1.0;\n// vendored by the author\n" });
    const err = await failure(build(proj, { entry: "AsyncCounter" }));
    expect(err.code).toBe("WIT_MISMATCH");
    expect(err.message).toContain("declares hypen:module@0.1 but the crate targets ABI 0.2");
    expect(err.hint).toContain("delete");
    // The author's file is untouched.
    expect(readFileSync(join(proj, "wit", "hypen-module.wit"), "utf8")).toContain("vendored by the author");
  });

  test("a foreign wit/ (no hypen:module package) is recognised", () => {
    const crate = scratch("foreignwit");
    write(crate, { "wit/world.wit": "package other:thing@1.0.0;\nworld w {}\n" });
    expect(vendoredWitDeclaresModule(crate)).toBe(false);
    // Left alone (the author owns it) — the build warns about it.
    const cli = join(import.meta.dir, "..");
    expect(provisionRustWit(crate, "0.1", { "0.1": join(cli, "wit"), "0.2": join(cli, "wit-v0_2") })).toBe("vendored");
    write(crate, { "wit/hypen-module.wit": "package hypen:module@0.1.0;\n" });
    expect(vendoredWitDeclaresModule(crate)).toBe(true);
    expect(vendoredWitDeclaresModule(scratch("nowit"))).toBe(false);
  });

  test("an interrupted provisioning never leaves an unmarked, half-copied wit/", () => {
    const crate = scratch("provision");
    const cli = join(import.meta.dir, "..");
    const bundled = { "0.1": join(cli, "wit"), "0.2": join(cli, "wit-v0_2") };
    // A source that cannot be copied stands in for a copy that dies midway.
    expect(() => provisionRustWit(crate, "0.1", { ...bundled, "0.1": join(crate, "missing") })).toThrow();
    expect(existsSync(join(crate, "wit"))).toBe(false);
    expect(readdirSync(crate)).toEqual([]);
  });
});

// ── The whole pipeline, with a fake toolchain ────────────────────────────────

describe("wasm build: staging, publishing and cleanup", () => {
  const EXPECTED_MANIFEST =
    JSON.stringify(
      {
        entry: "Counter",
        modules: [
          { name: "Counter", wasm: "Counter.wasm", ui: "Counter.hypen", reads: [], dispatches: [], storage: [], http: false },
          { name: "Banner", ui: "Banner.hypen" },
        ],
      },
      null,
      2
    ) + "\n";

  test("a successful build publishes exactly the artifacts and leaves no work directory", async () => {
    const proj = goProject();
    const manifest = await withPath(fakeGoToolchain(), () => build(proj));
    expect(readdirSync(join(proj, "dist")).sort()).toEqual(["wasm"]);
    expect(readdirSync(join(proj, "dist", "wasm")).sort()).toEqual([
      "Banner.hypen",
      "Counter.hypen",
      "Counter.wasm",
      "app.json",
    ]);
    // Byte-for-byte the manifest format hypen-runtime parses.
    expect(readFileSync(join(proj, "dist", "wasm", "app.json"), "utf8")).toBe(EXPECTED_MANIFEST);
    expect(JSON.stringify(manifest, null, 2) + "\n").toBe(EXPECTED_MANIFEST);
    expect(readFileSync(join(proj, "dist", "wasm", "Counter.hypen"), "utf8")).toBe(`Text("@{state.count}")`);
    expect(classifyWasm(readFileSync(join(proj, "dist", "wasm", "Counter.wasm")))).toEqual({ kind: "component" });
  });

  test("capability grants land in the manifest as lowercased scopes", async () => {
    const proj = goProject();
    write(proj, {
      "src/components/Cart/component.hypen": "Text(\"cart\")\n",
      "src/components/Cart/main.go": "package main\n",
    });
    const manifest = await withPath(fakeGoToolchain(), () =>
      build(proj, {
        wasm: { modules: { Cart: { reads: ["Counter", "counter"], dispatches: ["COUNTER"], storage: ["cloud"], http: true } } },
      })
    );
    // Modules are emitted in name order (not directory-entry order).
    expect(manifest.modules.map((m) => m.name as string)).toEqual(["Cart", "Counter", "Banner"]);
    expect(manifest.modules[0]).toEqual({
      name: "Cart",
      wasm: "Cart.wasm",
      ui: "Cart.hypen",
      reads: ["counter"],
      dispatches: ["counter"],
      storage: ["cloud"],
      http: true,
    });
  });

  test("--keep-temp leaves the intermediates at <outDir>/.wasm-temp (Go app-mode shim)", async () => {
    const proj = copyFixture("wasm-go-app-api");
    await withPath(fakeGoToolchain(), () => build(proj, { keepTemp: true }));
    expect(readdirSync(join(proj, "dist")).sort()).toEqual([".wasm-temp", "wasm"]);
    const shim = readFileSync(join(proj, "dist", ".wasm-temp", "Counter", "main.go"), "utf8");
    expect(shim).toContain('usermod "hypen.space/wasm-go-app-api/src/components/Counter"');
    expect(shim).toContain('module "hypen.space/wasm-go-app-api/internal/bindings/hypen/module/module"');
    // A second --keep-temp build replaces the kept directory rather than piling up.
    await withPath(fakeGoToolchain(), () => build(proj, { keepTemp: true }));
    expect(readdirSync(join(proj, "dist")).sort()).toEqual([".wasm-temp", "wasm"]);
  });

  test("the TS pipeline end to end with a stand-in jco: entry, bundle and narrowed world", async () => {
    const proj = tsProject("component");
    const manifest = await build(proj, {
      keepTemp: true,
      wasm: { modules: { Counter: { storage: ["app"] } } },
    });
    expect(manifest.modules).toEqual([
      { name: "Counter", wasm: "Counter.wasm", ui: "Counter.hypen", reads: [], dispatches: [], storage: ["app"], http: false },
      { name: "Header", ui: "Header.hypen" },
    ]);
    const temp = join(proj, "dist", ".wasm-temp");
    const entry = readFileSync(join(temp, "shim-Counter.mjs"), "utf8");
    expect(entry).toContain(`import def from ${JSON.stringify(join(proj, "src", "components", "Counter", "component.ts"))};`);
    // The bundle carries the shim and the user's handlers, and leaves only
    // the host import unresolved.
    const bundle = readFileSync(join(temp, "bundle-Counter.mjs"), "utf8");
    expect(bundle).toContain("createModuleExports");
    expect(bundle).toMatch(/\.count\+\+/);
    expect(bundle.match(/^import .* from "(.*)";$/gm)).toEqual([
      `import { read, subscribe } from "hypen:engine/state@0.1.0";`,
    ]);
    // jco was pointed at a world with only the granted storage import.
    const world = readFileSync(join(temp, "wit-Counter", "hypen-module.wit"), "utf8");
    expect(world).toContain("world hypen-cli-build {");
    expect(world.slice(world.indexOf("world hypen-cli-build"))).toContain("import hypen:storage/app@");
    expect(world.slice(world.indexOf("world hypen-cli-build"))).not.toContain("import hypen:storage/cloud@");
  });

  test("a failed build leaves the previous output exactly as it was", async () => {
    const proj = goProject();
    await withPath(fakeGoToolchain(), () => build(proj));
    const before = readFileSync(join(proj, "dist", "wasm", "app.json"), "utf8");
    writeFileSync(join(proj, "src", "components", "Counter", "component.hypen"), "Text(\"changed\")\n");
    const err = await withPath(fakeGoToolchain({ output: "empty" }), () => failure(build(proj)));
    expect(err.code).toBe("ARTIFACT_INVALID");
    expect(readdirSync(join(proj, "dist")).sort()).toEqual(["wasm"]);
    expect(readFileSync(join(proj, "dist", "wasm", "app.json"), "utf8")).toBe(before);
    expect(readFileSync(join(proj, "dist", "wasm", "Counter.hypen"), "utf8")).toBe(`Text("@{state.count}")`);
  });

  test("a successful build replaces the previous output wholesale (no stale modules)", async () => {
    const proj = goProject();
    write(proj, {
      "src/components/Old/component.hypen": "Text(\"old\")\n",
      "src/components/Old/main.go": "package main\n",
    });
    await withPath(fakeGoToolchain(), () => build(proj));
    expect(existsSync(join(proj, "dist", "wasm", "Old.wasm"))).toBe(true);
    rmSync(join(proj, "src", "components", "Old"), { recursive: true });
    await withPath(fakeGoToolchain(), () => build(proj));
    expect(readdirSync(join(proj, "dist", "wasm")).sort()).toEqual([
      "Banner.hypen",
      "Counter.hypen",
      "Counter.wasm",
      "app.json",
    ]);
  });

  test("work directories abandoned by a dead build are swept; a live build's are not", async () => {
    const proj = goProject();
    // pid 2^31-1 cannot be a live process; this test's own pid is.
    const dead = join(proj, "dist", ".wasm-temp-2147483647-abc");
    const deadOld = join(proj, "dist", ".wasm-old-2147483647-abc");
    const live = join(proj, "dist", `.wasm-temp-${process.pid}-other`);
    for (const dir of [dead, deadOld, live]) write(dir, { "leftover.txt": "x" });
    await withPath(fakeGoToolchain(), () => build(proj));
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(deadOld)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test("concurrent builds into one outDir each publish a complete tree", async () => {
    const proj = goProject();
    const bin = fakeGoToolchain();
    const results = await withPath(bin, () =>
      Promise.all(Array.from({ length: 4 }, () => build(proj)))
    );
    for (const manifest of results) expect(manifest.modules).toHaveLength(2);
    expect(readdirSync(join(proj, "dist")).sort()).toEqual(["wasm"]);
    expect(readdirSync(join(proj, "dist", "wasm")).sort()).toEqual([
      "Banner.hypen",
      "Counter.hypen",
      "Counter.wasm",
      "app.json",
    ]);
    expect(readFileSync(join(proj, "dist", "wasm", "app.json"), "utf8")).toBe(EXPECTED_MANIFEST);
  });
});

// ── Subprocess plumbing and error rendering ──────────────────────────────────

describe("wasm build: running tools", () => {
  test("a tool that is not on PATH is `not-started`, and TOOLCHAIN_MISSING when required", async () => {
    const cwd = scratch("cwd");
    const run = await runTool("hypen-no-such-tool", ["--flag"], { cwd, output: "quiet" });
    expect(run.status).toBe("not-started");
    let err: unknown;
    try {
      expectSuccess(run, "the tool");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BuildError);
    expect((err as BuildError).code).toBe("TOOLCHAIN_MISSING");
    expect((err as BuildError).tool?.command).toEqual(["hypen-no-such-tool", "--flag"]);
    expect((err as BuildError).hint).toContain(`"hypen-no-such-tool" was not found`);
  });

  test("quiet runs collect stdout and stderr; failures keep only the stderr tail, ANSI stripped", async () => {
    const cwd = scratch("cwd");
    const ok = await runTool("/bin/sh", ["-c", "echo out; echo err >&2"], { cwd, output: "quiet" });
    expect(ok).toEqual({ status: "ok", stdout: "out\n", stderr: "err\n" });
    const noisy = await runTool(
      "/bin/sh",
      ["-c", `i=0; while [ $i -lt 100 ]; do echo "line $i" >&2; i=$((i+1)); done; printf '\\033[31merror\\033[0m: last\\n' >&2; exit 3`],
      { cwd, output: "quiet" }
    );
    expect(noisy.status).toBe("failed");
    if (noisy.status !== "failed") return;
    const lines = noisy.failure.stderrTail.split("\n");
    expect(lines).toHaveLength(40);
    expect(lines.at(-1)).toBe("error: last");
    expect(noisy.failure.exitCode).toBe(3);
    expect(noisy.failure.streamed).toBe(false);
  });
});

describe("wasm build: formatBuildError", () => {
  test("message, then indented context, then the hint", () => {
    const err = new BuildError(`hypen.json: unknown key "wasm.lang" (expected "language" or "modules")`, {
      code: "CONFIG_INVALID",
      file: "hypen.json",
      field: "wasm.lang",
      hint: `did you mean "wasm.language"?`,
    });
    expect(formatBuildError(err)).toBe(
      [
        `  Build failed: hypen.json: unknown key "wasm.lang" (expected "language" or "modules")`,
        ``,
        `    file:    hypen.json`,
        `    field:   wasm.lang`,
        `    code:    CONFIG_INVALID`,
        ``,
        `  Hint: did you mean "wasm.language"?`,
      ].join("\n")
    );
  });

  test("a failed tool shows its command (shell-quoted), exit code and — unless already streamed — stderr", () => {
    const tool = {
      command: ["cargo", "build", "--manifest-path", "/my project/Cargo.toml"],
      cwd: "/my project",
      exitCode: 101,
      signal: null,
      stderrTail: "error[E0432]: unresolved import\n  --> src/lib.rs:1:5",
      streamed: false,
    };
    const quiet = formatBuildError(new BuildError("cargo build exited with code 101", { code: "TOOL_FAILED", module: "Counter", tool }));
    expect(quiet).toContain(`    module:  Counter`);
    expect(quiet).toContain(`    command: cargo build --manifest-path '/my project/Cargo.toml'`);
    expect(quiet).toContain(`    exit:    101`);
    expect(quiet).toContain(`    stderr:\n      error[E0432]: unresolved import\n        --> src/lib.rs:1:5`);
    const streamed = formatBuildError(
      new BuildError("cargo build exited with code 101", { code: "TOOL_FAILED", tool: { ...tool, streamed: true } })
    );
    expect(streamed).toContain("stderr:  (shown above)");
    expect(streamed).not.toContain("E0432");
  });

  test("a plain BuildError (the SPA build's) prints as just its message", () => {
    expect(formatBuildError(new BuildError("Components directory not found: /x"))).toBe(
      "  Build failed: Components directory not found: /x"
    );
  });
});

describe("wasm build: classifyWasm", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  test("tells components from core modules by the preamble's layer field", () => {
    expect(classifyWasm(bytes(0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00))).toEqual({ kind: "component" });
    expect(classifyWasm(bytes(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00))).toEqual({ kind: "core-module" });
    expect(classifyWasm(bytes())).toEqual({ kind: "empty" });
    expect(classifyWasm(bytes(0x00, 0x61, 0x73, 0x6d))).toEqual({ kind: "not-wasm" });
    expect(classifyWasm(new TextEncoder().encode("#!/bin/sh\n"))).toEqual({ kind: "not-wasm" });
  });
});

// ── Through the bin ──────────────────────────────────────────────────────────

/** Run `hypen build --target wasm` in `cwd` with `bin` first on PATH. */
async function runBin(cwd: string, bin: string | null, args: string[] = []) {
  const proc = spawn({
    cmd: [process.execPath, cliPath, "build", "--target", "wasm", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: bin === null ? realPath : `${bin}${delimiter}${realPath}`, NO_COLOR: "1" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("wasm build errors: through `hypen build --target wasm`", () => {
  test("a config error prints message, context and hint, and exits 1", async () => {
    const proj = goProject();
    writeFileSync(
      join(proj, "hypen.json"),
      JSON.stringify({ components: "./src/components", entry: "Counter", wasm: { modules: { Counter: { stoarge: ["app"] } } } })
    );
    const { exitCode, stderr } = await runBin(proj, null);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      [
        ``,
        `  Build failed: hypen.json: unknown key "wasm.modules.Counter.stoarge" (expected "reads", "dispatches", "storage" or "http")`,
        ``,
        `    file:    hypen.json`,
        `    field:   wasm.modules.Counter.stoarge`,
        `    code:    CONFIG_INVALID`,
        ``,
        `  Hint: did you mean "wasm.modules.Counter.storage"?`,
        ``,
        ``,
      ].join("\n")
    );
  });

  test("a failing compiler: its output streams once, then the summary names command and exit code", async () => {
    const proj = goProject();
    const { exitCode, stderr } = await runBin(proj, fakeGoToolchain({ output: "fail" }));
    expect(exitCode).toBe(1);
    // Streamed live, and not repeated in the summary.
    expect(stderr.split("counter.go:12:3: undefined: nope")).toHaveLength(2);
    expect(stderr).toContain("  Build failed: tinygo build exited with code 2");
    expect(stderr).toContain("    module:  Counter");
    expect(stderr).toContain("    command: tinygo build -target=wasip2 -wit-package ");
    expect(stderr).toContain("    exit:    2");
    expect(stderr).toContain("    stderr:  (shown above)");
    expect(stderr).toContain("    code:    TOOL_FAILED");
    expect(stderr).toContain("  Hint: fix the compile errors above");
    expect(leftovers(proj)).toEqual([]);
  });

  test("a bug (non-BuildError) is reported as an error with its stack, not as a build failure", async () => {
    // hypen.json itself is fine; a components path of the wrong *type* is not
    // something buildWasm promises to diagnose.
    const proj = goProject();
    writeFileSync(join(proj, "hypen.json"), JSON.stringify({ components: 42, entry: "Counter" }));
    const { exitCode, stderr } = await runBin(proj, null);
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("Build failed:");
    expect(stderr).toContain("Error:");
  });

  test("an interrupted build removes its work directory", async () => {
    const proj = goProject();
    const proc = spawn({
      cmd: [process.execPath, cliPath, "build", "--target", "wasm"],
      cwd: proj,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${fakeGoToolchain({ output: "hang" })}${delimiter}${realPath}`, NO_COLOR: "1" },
    });
    // Wait until the (never-ending) compile is running: its work dir exists.
    const reader = proc.stderr.getReader();
    let seen = "";
    while (!seen.includes("started")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(leftovers(proj)).toHaveLength(1);
    proc.kill("SIGINT");
    await proc.exited;
    expect(proc.signalCode ?? proc.exitCode).not.toBe(0);
    expect(leftovers(proj)).toEqual([]);
    expect(existsSync(join(proj, "dist", "wasm"))).toBe(false);
  }, 20_000);
});
