import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, symlinkSync } from "fs";
import { join, resolve } from "path";
import { spawn } from "bun";
import {
  shimSource,
  goShimSource,
  detectLanguage,
  collectGoComponents,
  collectRustComponents,
  rustCrateAbi,
  resolveJco,
} from "../src/build-wasm.js";

describe("build --target wasm: shim codegen", () => {
  test("adapts a module definition to the hypen:module reducer ABI", () => {
    const src = shimSource("/abs/path/to/Counter/component.ts");

    // Imports the user module by the exact path it was given.
    expect(src).toContain('import def from "/abs/path/to/Counter/component.ts"');

    // Exports the five reducer/lifecycle functions + self-describing actions.
    for (const sym of [
      "export function init",
      "export function dispatch",
      "export const onActivated",
      "export const onDeactivated",
      "export function onDestroyed",
      "export function actions",
    ]) {
      expect(src).toContain(sym);
    }

    // Routes by the definition's action handler map and self-describes actions.
    expect(src).toContain("def.handlers.onAction.get(action.name)");
    expect(src).toContain("return def.actions");

    // Unsupported surfaces fail loudly rather than misbehaving silently.
    expect(src).toContain("async action handler");
    expect(src).toContain("data sources are not supported");
  });

  test("safely escapes the import path", () => {
    const src = shimSource('/weird/"quoted"/path.ts');
    // JSON.stringify keeps the generated import syntactically valid.
    expect(src).toContain(JSON.stringify('/weird/"quoted"/path.ts'));
  });

  test("wires context cross-module read / emit / subscribe to hypen:engine/state", () => {
    const src = shimSource("/abs/Counter/component.ts");
    // Imports the sync cross-module capability (world: module-x).
    // Versioned specifier, matching the vendored WIT package: componentize-js
    // only binds world imports under their fully versioned name.
    const stateWit = readFileSync(
      join(import.meta.dir, "..", "wit", "deps", "hypen-engine", "state.wit"),
      "utf8"
    );
    const pkg = stateWit.match(/^package\s+(hypen:engine)@([\d.]+);/m)!;
    expect(src).toContain(`from "${pkg[1]}/state@${pkg[2]}"`);
    // getModule/getGlobalState read a sibling's state via the engine.
    expect(src).toContain("stateRead(");
    // context.emit accumulates onto the reducer's ReducerOutput.emit.
    expect(src).toContain("emitSink.push");
    // context.on maps to a cross-module subscribe (onChange is an action name).
    expect(src).toContain("stateSubscribe(");
    // Cross-module *writes* still fail loudly.
    expect(src).toContain("setState is not supported");
  });

  test("TS init shallow-merges declaration-site config over initialState", () => {
    const src = shimSource("/abs/Counter/component.ts");
    // init decodes the config bytes and, when it's a non-empty object, spreads
    // it over initialState — so `module X(start: 5)` seeds state.start.
    expect(src).toContain("const seed = decJson(config);");
    expect(src).toContain("{ ...(def.initialState ?? {}), ...seed }");

    // Behavioral check: reconstruct init's merge with a stub def and confirm
    // config overrides initialState while absent config leaves it untouched.
    const merge = (initialState: any, seed: any) => {
      if (!seed || typeof seed !== "object" || Array.isArray(seed) || Object.keys(seed).length === 0) {
        return initialState;
      }
      return { ...(initialState ?? {}), ...seed };
    };
    expect(merge({ count: 0 }, { count: 7 })).toEqual({ count: 7 });
    expect(merge({ count: 0, label: "hi" }, { count: 7 })).toEqual({ count: 7, label: "hi" });
    expect(merge({ count: 0 }, {})).toEqual({ count: 0 });
    expect(merge({ count: 0 }, null)).toEqual({ count: 0 });
  });

  test("Go init shallow-merges declaration-site config over InitialState", () => {
    const src = goShimSource("example.com/app/counter", "internal/bindings");
    // Merge at the JSON layer (type-agnostic over InitialState's Go type).
    expect(src).toContain("seed := decodeMap(config)");
    expect(src).toContain("if len(seed) == 0 {");
    expect(src).toContain("json.Marshal(def.InitialState)");
    expect(src).toContain("for k, v := range seed {");
    // The template's `\\t` escapes must render to real tabs in the emitted Go.
    expect(src).toContain("\n\t\tseed := decodeMap(config)");
    expect(src).not.toContain("\\t\\tseed := decodeMap");
  });

  test("Go shim imports the SDK by its real module path", () => {
    const src = goShimSource("example.com/app/counter", "internal/bindings");
    // Must match the `module` line of hypen-golang/go.mod, or `go mod tidy`
    // in the user's project cannot resolve the shim's import.
    const sdkGoMod = readFileSync(
      join(import.meta.dir, "..", "..", "hypen-golang", "go.mod"),
      "utf8"
    );
    const sdkModule = sdkGoMod.match(/^module\s+(\S+)/m)![1];
    expect(src).toContain(`core ${JSON.stringify(sdkModule)}`);
  });

  test("jco fallback fetches the scoped @bytecodealliance/jco package", () => {
    // No node_modules/.bin/jco here, so this exercises the bunx/npx fallback.
    // The unscoped `jco` npm package is an unrelated placeholder.
    const { cmd, pre } = resolveJco("/nonexistent-hypen-project");
    expect(cmd).toBe("bunx");
    expect(pre).toEqual(["@bytecodealliance/jco"]);
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
    const { modules, stateless } = collectRustComponents(
      join(rustFixture, "src", "components"),
      "Counter",
      rustFixture
    );
    expect(modules.map((m) => m.name)).toEqual(["Counter"]);
    expect(modules[0].template).toContain("@{state.count}");
    // The root Cargo.toml is the entry crate.
    expect(modules[0].dir).toBe(rustFixture);
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
    const tmp = `/tmp/hypen-abi-sniff-${Date.now()}`;
    mkdirSync(join(tmp, "wit"), { recursive: true });
    require("fs").writeFileSync(
      join(tmp, "wit", "hypen-module.wit"),
      "package hypen:module@0.2.0;\n"
    );
    expect(rustCrateAbi(tmp)).toBe("0.2");
    rmSync(tmp, { recursive: true, force: true });
  });

  test("collectRustComponents (multi-module): each Cargo.toml dir is its own crate", () => {
    const multiFixture = join(import.meta.dir, "fixtures", "wasm-rust-multi");
    const { modules, stateless } = collectRustComponents(
      join(multiFixture, "src", "components"),
      "Counter",
      multiFixture
    );
    // Two crate-backed stateful modules, each built from its own component dir.
    expect(modules.map((m) => m.name).sort()).toEqual(["Counter", "Timer"]);
    const counter = modules.find((m) => m.name === "Counter")!;
    expect(counter.dir).toBe(join(multiFixture, "src", "components", "Counter"));
    expect(counter.template).toContain("@{state.count}");
    // Banner has a `.hypen` but no `Cargo.toml` → stateless building block.
    expect(stateless.map((s) => s.name)).toEqual(["Banner"]);
  });

  test("collectGoComponents finds Go packages with their templates", () => {
    const { modules, stateless } = collectGoComponents(
      join(goFixture, "src", "components")
    );
    expect(stateless).toHaveLength(0);
    const counter = modules.find((m) => m.name === "Counter");
    expect(counter).toBeDefined();
    // Stateful Go component: has a package dir + its .hypen template.
    expect(counter!.dir).toBe(join(goFixture, "src", "components", "Counter"));
    expect(counter!.template).toContain("@{state.count}");
  });

  test("classifies Go components: wit-mode (package main) vs app-mode", () => {
    // wit-mode fixture: main.go is `package main`.
    const wit = collectGoComponents(join(goFixture, "src", "components"));
    expect(wit.modules.find((m) => m.name === "Counter")!.goMode).toBe("wit");

    // app-mode fixture: counter.go is `package counter` (core.NewApp authoring).
    const apiFixture = join(import.meta.dir, "fixtures", "wasm-go-app-api");
    const app = collectGoComponents(join(apiFixture, "src", "components"));
    const counter = app.modules.find((m) => m.name === "Counter")!;
    expect(counter.goMode).toBe("app");
    expect(counter.goPkg).toBe("counter");
  });
});

// Full pipeline (esbuild bundle → jco componentize) is heavy (~30s, ~14 MB
// output) and needs the JS SDK + jco resolvable. Gate it behind an env var so
// the default suite stays fast; it documents/verifies the real build when run
// with `HYPEN_WASM_E2E=1 bun test`.
const E2E = process.env.HYPEN_WASM_E2E === "1";

describe.if(E2E)("build --target wasm: end-to-end", () => {
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const corePkg = join(repoRoot, "hypen-web", "packages", "core");
  const serverPkg = join(repoRoot, "hypen-web", "packages", "server");
  const jcoBin = join(
    repoRoot,
    "wit-spikes",
    "ts-module",
    "node_modules",
    ".bin",
    "jco"
  );
  const esbuildPkg = join(
    repoRoot,
    "wit-spikes",
    "ts-module",
    "node_modules",
    "esbuild"
  );

  const haveToolchain =
    existsSync(corePkg) &&
    existsSync(serverPkg) &&
    existsSync(jcoBin) &&
    existsSync(esbuildPkg);

  test.if(haveToolchain)(
    "builds a module to a runnable .wasm component + manifest",
    async () => {
      const proj = `/tmp/hypen-wasm-e2e-${Date.now()}`;
      const compDir = join(proj, "src", "components", "Counter");
      const bannerDir = join(proj, "src", "components", "Banner");
      mkdirSync(compDir, { recursive: true });
      mkdirSync(bannerDir, { recursive: true });
      await Bun.write(
        join(proj, "hypen.json"),
        JSON.stringify({ components: "./src/components", entry: "Counter" })
      );
      await Bun.write(
        join(compDir, "component.ts"),
        `import { app } from "@hypen-space/core";\n` +
          `export default app.defineState({ count: 0 })\n` +
          `  .onAction("increment", ({ state }) => { state.count++; })\n` +
          `  .build();\n`
      );
      // Entry references a stateless component by name.
      await Bun.write(
        join(compDir, "component.hypen"),
        `module Counter {\n  Banner()\n  Text("Count: @{state.count}")\n}\n`
      );
      // Stateless component: a `.hypen` with no companion module (no .ts).
      await Bun.write(
        join(bannerDir, "component.hypen"),
        `Text("Static Banner")\n`
      );

      // Resolve deps the way a real install would (symlinks into node_modules):
      // core/server (workspace src packages), esbuild, and the jco bin.
      const nm = join(proj, "node_modules");
      mkdirSync(join(nm, "@hypen-space"), { recursive: true });
      mkdirSync(join(nm, ".bin"), { recursive: true });
      symlinkSync(corePkg, join(nm, "@hypen-space", "core"));
      symlinkSync(serverPkg, join(nm, "@hypen-space", "server"));
      symlinkSync(esbuildPkg, join(nm, "esbuild"));
      symlinkSync(jcoBin, join(nm, ".bin", "jco"));

      const cliPath = join(import.meta.dir, "..", "bin", "hypen.ts");
      const proc = spawn({
        cmd: ["bun", cliPath, "build", "--target", "wasm"],
        cwd: proj,
        stdout: "pipe",
        stderr: "pipe",
        // The CLI resolves @hypen-space/server + esbuild via NODE_PATH; the
        // project node_modules holds the symlinks above.
        env: { ...process.env, NODE_PATH: nm },
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(exitCode, `build failed:\n${stderr}`).toBe(0);

      const wasmDir = join(proj, "dist", "wasm");
      expect(existsSync(join(wasmDir, "Counter.wasm"))).toBe(true);
      expect(existsSync(join(wasmDir, "Counter.hypen"))).toBe(true);
      // Stateless component: UI emitted, but no wasm.
      expect(existsSync(join(wasmDir, "Banner.hypen"))).toBe(true);
      expect(existsSync(join(wasmDir, "Banner.wasm"))).toBe(false);

      const manifest = JSON.parse(readFileSync(join(wasmDir, "app.json"), "utf8"));
      expect(manifest.entry).toBe("Counter");
      expect(manifest.modules).toHaveLength(2);
      const counter = manifest.modules.find((m: any) => m.name === "Counter");
      const banner = manifest.modules.find((m: any) => m.name === "Banner");
      expect(counter).toMatchObject({
        name: "Counter",
        wasm: "Counter.wasm",
        ui: "Counter.hypen",
      });
      // Stateless entry has a UI but no `wasm` key.
      expect(banner).toMatchObject({ name: "Banner", ui: "Banner.hypen" });
      expect(banner.wasm).toBeUndefined();

      rmSync(proj, { recursive: true, force: true });
    },
    180_000
  );
});

// Go pipeline: wit-bindgen-go + tinygo. Gated behind the same env var; needs
// the Go toolchain on PATH. Builds the committed Go fixture in place (its
// `internal/bindings/` is generated by the build and cleaned up after).
describe.if(E2E)("build --target wasm: Go end-to-end", () => {
  const goFixture = join(import.meta.dir, "fixtures", "wasm-go-app");

  async function onPath(cmd: string, args: string[]): Promise<boolean> {
    try {
      const p = spawn({ cmd: [cmd, ...args], stdout: "ignore", stderr: "ignore" });
      await p.exited;
      return true;
    } catch {
      return false;
    }
  }

  test(
    "builds a Go module to a runnable .wasm component + manifest",
    async () => {
      const haveGo =
        (await onPath("tinygo", ["version"])) &&
        (await onPath("wit-bindgen-go", ["--help"])) &&
        (await onPath("go", ["version"]));
      if (!haveGo) {
        console.warn("  [skip] Go toolchain (tinygo/wit-bindgen-go/go) not on PATH");
        return;
      }

      const cliPath = join(import.meta.dir, "..", "bin", "hypen.ts");
      const proc = spawn({
        cmd: ["bun", cliPath, "build", "--target", "wasm"],
        cwd: goFixture,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      const stdout = await new Response(proc.stdout).text();
      expect(exitCode, `build failed:\n${stderr}`).toBe(0);
      expect(stdout).toContain("Go (tinygo)");

      const wasmDir = join(goFixture, "dist", "wasm");
      expect(existsSync(join(wasmDir, "Counter.wasm"))).toBe(true);
      expect(existsSync(join(wasmDir, "Counter.hypen"))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(wasmDir, "app.json"), "utf8"));
      expect(manifest.modules[0]).toMatchObject({
        name: "Counter",
        wasm: "Counter.wasm",
        ui: "Counter.hypen",
      });

      // Clean build artifacts (generated bindings + output) from the fixture.
      rmSync(join(goFixture, "dist"), { recursive: true, force: true });
      rmSync(join(goFixture, "internal"), { recursive: true, force: true });
    },
    300_000
  );

  // App-mode parity: a Go module written with the high-level core.NewApp()
  // authoring API builds to wasm via the generated shim — same as the TS path.
  test(
    "builds a core.NewApp() Go module via the generated shim (app-mode)",
    async () => {
      const haveGo =
        (await onPath("tinygo", ["version"])) &&
        (await onPath("wit-bindgen-go", ["--help"])) &&
        (await onPath("go", ["version"]));
      if (!haveGo) {
        console.warn("  [skip] Go toolchain not on PATH");
        return;
      }

      const repoRoot = resolve(import.meta.dir, "..", "..");
      const src = join(import.meta.dir, "fixtures", "wasm-go-app-api");
      // Copy to a temp dir and point the SDK replace at the in-repo Go SDK by
      // absolute path (the committed fixture uses a relative placeholder).
      const proj = `/tmp/hypen-go-api-e2e-${Date.now()}`;
      mkdirSync(proj, { recursive: true });
      await spawn({ cmd: ["cp", "-r", src + "/.", proj] }).exited;
      const goMod = readFileSync(join(proj, "go.mod"), "utf8").replace(
        /replace github.com\/hypen-lang\/hypen\/hypen-golang => .*/,
        `replace github.com/hypen-lang/hypen/hypen-golang => ${join(repoRoot, "hypen-golang")}`
      );
      await Bun.write(join(proj, "go.mod"), goMod);

      const cliPath = join(import.meta.dir, "..", "bin", "hypen.ts");
      const proc = spawn({
        cmd: ["bun", cliPath, "build", "--target", "wasm"],
        cwd: proj,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(exitCode, `app-mode build failed:\n${stderr}`).toBe(0);

      const wasmDir = join(proj, "dist", "wasm");
      expect(existsSync(join(wasmDir, "Counter.wasm"))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(wasmDir, "app.json"), "utf8"));
      expect(manifest.modules[0]).toMatchObject({ name: "Counter", wasm: "Counter.wasm" });

      rmSync(proj, { recursive: true, force: true });
    },
    300_000
  );
});

// Rust pipeline: cargo + wit-bindgen. Gated behind the same env var; needs the
// Rust toolchain + the wasm32-wasip2 target. Builds a /tmp copy of the fixture
// (the CLI provisions wit/ and cargo writes target/).
describe.if(E2E)("build --target wasm: Rust end-to-end", () => {
  const rustFixture = join(import.meta.dir, "fixtures", "wasm-rust-app");

  async function run(cmd: string, args: string[]): Promise<number | null> {
    try {
      const p = spawn({ cmd: [cmd, ...args], stdout: "ignore", stderr: "ignore" });
      return await p.exited;
    } catch {
      return null;
    }
  }

  test(
    "builds a wit-authored Rust crate to a runnable component + manifest",
    async () => {
      const haveCargo = (await run("cargo", ["--version"])) === 0;
      const haveTarget =
        (await run("rustc", ["--print", "target-list"])) === 0; // rustc present
      if (!haveCargo || !haveTarget) {
        console.warn("  [skip] Rust toolchain not on PATH");
        return;
      }

      const proj = `/tmp/hypen-rust-e2e-${Date.now()}`;
      mkdirSync(proj, { recursive: true });
      await spawn({ cmd: ["cp", "-r", rustFixture + "/.", proj] }).exited;

      const cliPath = join(import.meta.dir, "..", "bin", "hypen.ts");
      const proc = spawn({
        cmd: ["bun", cliPath, "build", "--target", "wasm"],
        cwd: proj,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      const stdout = await new Response(proc.stdout).text();
      if (exitCode !== 0 && /target may not be installed|wasm32-wasip2/.test(stderr)) {
        console.warn("  [skip] wasm32-wasip2 target not installed");
        rmSync(proj, { recursive: true, force: true });
        return;
      }
      expect(exitCode, `build failed:\n${stderr}`).toBe(0);
      expect(stdout).toContain("Rust (cargo)");

      const wasmDir = join(proj, "dist", "wasm");
      expect(existsSync(join(wasmDir, "Counter.wasm"))).toBe(true);
      expect(existsSync(join(wasmDir, "Counter.hypen"))).toBe(true);
      // Stateless Banner: UI only, no wasm.
      expect(existsSync(join(wasmDir, "Banner.hypen"))).toBe(true);
      expect(existsSync(join(wasmDir, "Banner.wasm"))).toBe(false);

      const manifest = JSON.parse(readFileSync(join(wasmDir, "app.json"), "utf8"));
      const counter = manifest.modules.find((m: any) => m.name === "Counter");
      const banner = manifest.modules.find((m: any) => m.name === "Banner");
      expect(counter).toMatchObject({ name: "Counter", wasm: "Counter.wasm" });
      expect(banner.wasm).toBeUndefined();

      rmSync(proj, { recursive: true, force: true });
    },
    600_000
  );

  test(
    "builds a CM-async (abi = 0.2) Rust crate against the vendored wit-v0_2",
    async () => {
      const haveCargo = (await run("cargo", ["--version"])) === 0;
      if (!haveCargo) {
        console.warn("  [skip] Rust toolchain not on PATH");
        return;
      }

      const asyncFixture = join(import.meta.dir, "fixtures", "wasm-rust-app-async");
      const proj = `/tmp/hypen-rust-async-e2e-${Date.now()}`;
      mkdirSync(proj, { recursive: true });
      await spawn({ cmd: ["cp", "-r", asyncFixture + "/.", proj] }).exited;

      const cliPath = join(import.meta.dir, "..", "bin", "hypen.ts");
      const proc = spawn({
        cmd: ["bun", cliPath, "build", "--target", "wasm"],
        cwd: proj,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      const stdout = await new Response(proc.stdout).text();
      if (exitCode !== 0 && /target may not be installed|wasm32-wasip2/.test(stderr)) {
        console.warn("  [skip] wasm32-wasip2 target not installed");
        rmSync(proj, { recursive: true, force: true });
        return;
      }
      expect(exitCode, `build failed:\n${stderr}\n${stdout}`).toBe(0);
      // The CLI announced the ABI selection and provisioned the async WIT.
      expect(stdout).toContain("hypen:module@0.2.0 (CM-async)");
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

      rmSync(proj, { recursive: true, force: true });
    },
    600_000
  );
});
