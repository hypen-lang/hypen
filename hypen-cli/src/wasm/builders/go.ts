/**
 * Go pipeline:
 *
 *   1. **Bindings** — `wit-bindgen-go generate` emits the `hypen:module`
 *      bindings into the project's `internal/bindings/` (once per build).
 *   2. **Shim** (app-mode only) — render `shims/module_shim.go` into a
 *      `package main` that adapts the user package's `Module()` definition
 *      to the reducer ABI.
 *   3. **Componentize** — `tinygo build -target=wasip2 -wit-world
 *      tinygo-module` compiles the package straight to a Component. The
 *      `tinygo-module` world adds the wasi:* imports TinyGo's runtime brings
 *      in; the component still satisfies the plain `hypen:module` contract.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, join, relative, sep } from "path";
import { BuildError } from "../../build-error.js";
import { bundledWitDir, goShimTemplatePath } from "../assets.js";
import { assertComponent } from "../artifact.js";
import { assertNoForeignModule, scanComponentDirs } from "../discover.js";
import { wasmFileName } from "../manifest.js";
import { expectSuccess, runTool } from "../process.js";
import { TINYGO_MIN_VERSION, findGoToolchain, requireTool } from "../toolchain.js";
import { parseModuleName, type Discovery, type StatefulModule } from "../types.js";
import type { BuildContext, ModuleBuilder } from "./builder.js";

/**
 * How a Go component is authored:
 *  - `"app"` — the package exports `func Module() *core.ModuleDefinition`
 *    (the high-level `core.NewApp().OnAction()` API); the CLI generates a
 *    shim that adapts it — parity with the TS path.
 *  - `"wit"` — `package main` implements the `hypen:module` exports directly
 *    (the author owns the WIT exports); built as-is.
 */
export type GoMode = "app" | "wit";

/** What a Go module is built from. */
export interface GoSource {
  /** Absolute path of the component's Go package directory. */
  dir: string;
  mode: GoMode;
}

interface GoPrepared {
  /** The bundled TinyGo WIT package. */
  witDir: string;
}

/** The `package <name>` of a Go file: its first non-comment line. */
function readGoPackage(file: string): string | undefined {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
    return t.match(/^package\s+(\w+)/)?.[1];
  }
  return undefined;
}

/**
 * Discover Go components. A component directory with `.go` source is a
 * stateful module — `package main` means wit-mode, any other package
 * app-mode; a `.hypen`-only directory is stateless.
 */
export function collectGoComponents(
  componentsDir: string,
  prebuilt?: ReadonlySet<string>
): Discovery<GoSource> {
  const found: Discovery<GoSource> = { stateful: [], stateless: [] };
  for (const c of scanComponentDirs(componentsDir)) {
    const name = parseModuleName(c.name);
    const goFiles = c.files.filter((f) => f.endsWith(".go"));
    if (goFiles.length === 0) {
      assertNoForeignModule(c, "go", prebuilt);
      found.stateless.push({ kind: "stateless", name, template: c.template });
      continue;
    }
    const mode: GoMode = goFiles.some((f) => readGoPackage(join(c.dir, f)) === "main") ? "wit" : "app";
    found.stateful.push({ kind: "stateful", name, template: c.template, source: { dir: c.dir, mode } });
  }
  return found;
}

/** The `module <path>` of the project's go.mod. */
function goModulePath(projectDir: string): string {
  const modFile = join(projectDir, "go.mod");
  const declared = existsSync(modFile)
    ? readFileSync(modFile, "utf8").match(/^\s*module\s+(\S+)/m)?.[1]
    : undefined;
  if (declared === undefined) {
    throw new BuildError(
      existsSync(modFile)
        ? `${modFile} declares no module path.`
        : `A Go wasm build needs a go.mod at the project root (${projectDir}).`,
      {
        code: "GO_MODULE_INVALID",
        file: modFile,
        hint: existsSync(modFile)
          ? `add a "module <path>" line to go.mod`
          : `run "go mod init <module-path>" in ${projectDir}, or set "wasm": { "language": "ts" | "rust" } in hypen.json if this is not a Go project`,
      }
    );
  }
  return declared;
}

/** Import paths the shim template uses as placeholders (see `module_shim.go`). */
const GO_SHIM_PLACEHOLDERS = {
  userImport: "hypen.invalid/usermod",
  moduleBindings: "hypen.invalid/bindings/module",
  typesBindings: "hypen.invalid/bindings/types",
} as const;

/**
 * Fill in the Go shim template: the user's package import path and the
 * project's generated bindings (`<bindingsBase>/module`, `<bindingsBase>/types`).
 */
export function renderGoShim(
  userImport: string,
  bindingsBase: string,
  template: string = readFileSync(goShimTemplatePath(), "utf8")
): string {
  const replacements: Array<[placeholder: string, importPath: string]> = [
    [GO_SHIM_PLACEHOLDERS.userImport, userImport],
    [GO_SHIM_PLACEHOLDERS.moduleBindings, `${bindingsBase}/module`],
    [GO_SHIM_PLACEHOLDERS.typesBindings, `${bindingsBase}/types`],
  ];
  let source = template;
  for (const [placeholder, importPath] of replacements) {
    const quoted = `"${placeholder}"`;
    // Exactly one import line per placeholder: anything else means the
    // template and this renderer have drifted apart.
    if (source.split(quoted).length !== 2) {
      throw new BuildError(`The Go shim template does not import ${quoted} exactly once.`, {
        code: "CLI_ASSET_MISSING",
        file: "module_shim.go",
        hint: "the CLI install is inconsistent: reinstall @hypen-space/cli",
      });
    }
    // JSON string syntax is valid Go string-literal syntax for import paths.
    source = source.replace(quoted, () => JSON.stringify(importPath));
  }
  return source;
}

/** Where an app-mode module's generated `package main` lives. */
const shimDir = (ctx: BuildContext, module: StatefulModule<GoSource>): string =>
  join(ctx.workDir, module.name);

/** Slash-separated path of `dir` relative to the Go module root. */
function goImportSegment(projectDir: string, dir: string): string {
  return relative(projectDir, dir).split(sep).join("/");
}

export const goBuilder: ModuleBuilder<GoSource, GoPrepared> = {
  language: "go",
  label: "Go (tinygo)",

  async discover(project) {
    return collectGoComponents(project.componentsDir, project.prebuilt);
  },

  entryHint: (entry) =>
    `a Go wasm build needs ${entry}/ to contain Go source implementing the module`,

  describe: (module) => (module.source.mode === "wit" ? { building: "(wit)" } : {}),

  async prepare(ctx, modules) {
    const { projectDir } = ctx.project;
    requireTool(await findGoToolchain(projectDir));
    const goModule = goModulePath(projectDir);
    const witDir = bundledWitDir("tinygo");

    const appModules = modules.filter((m) => m.source.mode === "app");
    // A generated shim imports `<go-module>/...`, which only resolves from a
    // directory inside the Go module.
    const fromProject = relative(projectDir, ctx.workDir);
    if (appModules.length > 0 && (fromProject.startsWith("..") || isAbsolute(fromProject))) {
      throw new BuildError(
        `The output directory is outside the Go module (${projectDir}), so the generated shims ` +
          `for ${appModules.map((m) => m.name).join(", ")} could not import the project's packages.`,
        {
          code: "OUTDIR_UNSAFE",
          field: "outDir",
          hint: `use an output directory inside the project (e.g. "outDir": "dist")`,
        }
      );
    }

    ctx.log("generating Go bindings…");
    const bindings = await runTool(
      "wit-bindgen-go",
      ["generate", "--world", "module", "--out", join(projectDir, "internal", "bindings"), witDir],
      { cwd: projectDir, output: "stream" }
    );
    expectSuccess(bindings, "wit-bindgen-go generate", {
      hint: "update it: go install go.bytecodealliance.org/cmd/wit-bindgen-go@latest",
    });

    // Write every shim before resolving the module graph once: the shims
    // (and the bindings) import `cm`, so `go mod tidy` must see them before
    // it prunes/locks dependencies.
    const bindingsBase = `${goModule}/internal/bindings/hypen/module`;
    for (const module of appModules) {
      const dir = shimDir(ctx, module);
      mkdirSync(dir, { recursive: true });
      const userImport = `${goModule}/${goImportSegment(projectDir, module.source.dir)}`;
      writeFileSync(join(dir, "main.go"), renderGoShim(userImport, bindingsBase));
    }
    if (appModules.length > 0) {
      ctx.log("resolving Go modules…");
      const tidy = await runTool("go", ["mod", "tidy"], { cwd: projectDir, output: "stream" });
      expectSuccess(tidy, "go mod tidy", {
        file: join(projectDir, "go.mod"),
        hint: "the project must be able to resolve github.com/hypen-lang/hypen/hypen-golang and go.bytecodealliance.org/cm (check go.mod and network access)",
      });
    }
    return { witDir };
  },

  async build(ctx, prepared, module) {
    const wasmPath = join(ctx.stageDir, wasmFileName(module.name));
    // app-mode compiles the generated shim package; wit-mode the author's own.
    const target = module.source.mode === "wit" ? module.source.dir : shimDir(ctx, module);
    const run = await runTool(
      "tinygo",
      [
        "build",
        "-target=wasip2",
        "-wit-package",
        prepared.witDir,
        "-wit-world",
        "tinygo-module",
        "-o",
        wasmPath,
        target,
      ],
      { cwd: ctx.project.projectDir, output: "stream" }
    );
    expectSuccess(run, "tinygo build", {
      module: module.name,
      file: module.source.dir,
      hint:
        module.source.mode === "app"
          ? `fix the compile errors above; the package must export func Module() *core.ModuleDefinition`
          : `fix the compile errors above; a "package main" component must implement the hypen:module exports itself`,
    });
    const upgrade = `use TinyGo >= ${TINYGO_MIN_VERSION}, whose wasip2 target emits a Component`;
    assertComponent(wasmPath, module.name, "tinygo build", { noOutput: upgrade, notComponent: upgrade });
    return { name: module.name, wasmPath };
  },
};
