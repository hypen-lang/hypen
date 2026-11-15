/**
 * `hypen build --target wasm`: the orchestrator.
 *
 * Builds a Hypen app into portable WebAssembly **components** — one
 * `<Module>.wasm` per stateful module — plus the declarative `<Module>.hypen`
 * UI assets and an `app.json` manifest. The output runs offline on any host
 * that speaks the `hypen:module` contract (e.g. `hypen-runtime --app
 * dist/wasm/app.json`). This is the *portable target* of
 * `wit/AUTHORING_MODEL.md`: the same authoring API targets either the
 * in-process browser SPA (`hypen build`) or a sandboxed `.wasm`.
 *
 * Everything here is language-agnostic; the per-language work is behind
 * `ModuleBuilder` (`builders/`). The steps, in order — each one failing
 * before the next spends any time:
 *
 *   config → language → output safety → discovery → capabilities
 *     → toolchain + setup → compile each module → manifest → publish
 *
 * Library code never exits the process: expected failures throw
 * `BuildError`, which `bin/hypen.ts` prints before exiting.
 */

import { existsSync, statSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";
import { BuildError } from "../build-error.js";
import { boldPink, dim, pink, yellow } from "../colors.js";
import type { BuildContext, ModuleBuilder } from "./builders/builder.js";
import { goBuilder } from "./builders/go.js";
import { rustBuilder } from "./builders/rust.js";
import { tsBuilder } from "./builders/ts.js";
import { parseWasmConfig, resolveModuleCapabilities, type WasmConfig } from "./config.js";
import { assertBuildable, detectProjectLanguage } from "./discover.js";
import {
  MANIFEST_FILE,
  serializeManifest,
  statefulEntry,
  statelessEntry,
  uiFileName,
  wasmFileName,
  type AppManifest,
  type AppManifestModule,
} from "./manifest.js";
import { assertSafeOutput, createStaging, type Staging } from "./output.js";
import { killRunningTools } from "./process.js";
import type { Language, Project } from "./types.js";

export interface BuildWasmOptions {
  /** Path to components directory (e.g. `./src/components`), relative to `root`. */
  components: string;
  /** Entry component name (e.g. `App`). */
  entry: string;
  /** Output directory, relative to `root`. Artifacts land in `<outDir>/wasm/`. Default: `dist`. */
  outDir?: string;
  /** Keep the intermediate build directory at `<outDir>/.wasm-temp`. Default: false. */
  keepTemp?: boolean;
  /** Project root (where hypen.json / Cargo.toml / go.mod live). Default: `process.cwd()`. */
  root?: string;
  /**
   * The raw `wasm` section of hypen.json — the language override and the
   * capability grants. Parsed (and rejected if malformed) by `parseWasmConfig`.
   */
  wasm?: unknown;
}

/** Everything the language-agnostic part of a build needs, resolved up front. */
interface BuildPlan {
  project: Project;
  outDir: string;
  outWasmDir: string;
  keepTemp: boolean;
  config: WasmConfig;
}

function assertComponentsDir(componentsDir: string): void {
  if (existsSync(componentsDir) && statSync(componentsDir).isDirectory()) return;
  throw new BuildError(
    existsSync(componentsDir)
      ? `The components path ${componentsDir} is not a directory.`
      : `Components directory not found: ${componentsDir}`,
    {
      code: "COMPONENTS_DIR_MISSING",
      file: componentsDir,
      field: "components",
      hint: `set "components" in hypen.json to the directory holding the project's components (default: ./src/components)`,
    }
  );
}

/**
 * Run `cleanup` if the process is interrupted while `body` runs, then let
 * the signal take its default course. `finally` does not run on SIGINT, and
 * a half-built temp directory would otherwise outlive the build.
 */
async function withInterruptCleanup<T>(cleanup: () => void, body: () => Promise<T>): Promise<T> {
  const signals = ["SIGINT", "SIGTERM"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => {
      killRunningTools(signal);
      cleanup();
      for (const [s, h] of handlers) process.off(s, h);
      // Re-raise with the default disposition restored, so the exit status
      // still says "killed by signal".
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  try {
    return await body();
  } finally {
    for (const [s, h] of handlers) process.off(s, h);
  }
}

/** Discover, validate, compile and publish one project with one builder. */
async function runBuild<S, P>(builder: ModuleBuilder<S, P>, plan: BuildPlan): Promise<AppManifest> {
  const { project, outWasmDir } = plan;

  // Stateful modules become `.wasm` (logic) + `.hypen` (UI); stateless ones
  // are template-only building blocks (Header(), Card()) the entry references
  // by name: no wasm, no state scope.
  const discovery = await builder.discover(project);
  assertBuildable(discovery, project, builder.entryHint(project.entry));
  const { stateful, stateless } = discovery;

  // Grants are checked against what was discovered *before* spending minutes
  // compiling.
  const capabilities = resolveModuleCapabilities(
    plan.config,
    stateful.map((m) => m.name),
    stateless.map((c) => c.name)
  );

  const staging: Staging = createStaging(plan.outDir, outWasmDir, plan.keepTemp);
  const ctx: BuildContext = {
    project,
    workDir: staging.workDir,
    stageDir: staging.stageDir,
    log: (line) => console.log(`  ${dim(line)}`),
  };

  return withInterruptCleanup(staging.dispose, async () => {
    try {
      const prepared = await builder.prepare(ctx, stateful);
      const entries: AppManifestModule[] = [];

      for (const module of stateful) {
        const grants = capabilities.get(module.name);
        if (grants === undefined) {
          // resolveModuleCapabilities returns an entry per stateful module.
          throw new Error(`no capabilities resolved for ${module.name}`);
        }
        const notes = builder.describe?.(module) ?? {};
        const building = notes.building ? ` ${dim(notes.building)}` : "";
        console.log(`  ${pink("building")} ${module.name}${building} ${dim("…")}`);

        await builder.build(ctx, prepared, module, grants);
        writeFileSync(join(staging.stageDir, uiFileName(module.name)), module.template);
        entries.push(statefulEntry(module.name, grants));

        const built = notes.built ? ` ${dim(notes.built)}` : "";
        console.log(
          `    ${dim("→")} ${wasmFileName(module.name)} ${dim("+")} ${uiFileName(module.name)}${built}`
        );
      }

      for (const component of stateless) {
        writeFileSync(join(staging.stageDir, uiFileName(component.name)), component.template);
        entries.push(statelessEntry(component));
        console.log(`    ${dim("→")} ${uiFileName(component.name)} ${dim("(stateless)")}`);
      }

      const manifest: AppManifest = { entry: project.entry, modules: entries };
      writeFileSync(join(staging.stageDir, MANIFEST_FILE), serializeManifest(manifest));
      staging.publish();

      const statelessNote = stateless.length > 0 ? ` + ${stateless.length} stateless` : "";
      console.log(
        `\n  ${boldPink("Done.")} ${stateful.length} module(s)${statelessNote} → ${dim(outWasmDir)}`
      );
      const manifestRel = relative(project.projectDir, join(outWasmDir, MANIFEST_FILE)) || MANIFEST_FILE;
      console.log(`  ${dim("Run it:")} ${yellow(`hypen-runtime --app ${manifestRel}`)}\n`);
      return manifest;
    } finally {
      staging.dispose();
    }
  });
}

/** Label shown in the build header for each language. */
const LANGUAGE_LABELS: Record<Language, string> = {
  ts: tsBuilder.label,
  go: goBuilder.label,
  rust: rustBuilder.label,
};

/**
 * Build a Hypen app to portable WASM components.
 *
 * @throws {BuildError} on anything a user can fix: invalid `wasm` config, an
 *   unusable project layout or output directory, a missing or failing
 *   toolchain, an artifact that is not a component. Never exits the process.
 * @returns the manifest written to `<outDir>/wasm/app.json`.
 */
export async function buildWasm(options: BuildWasmOptions): Promise<AppManifest> {
  const config = parseWasmConfig(options.wasm);
  const projectDir = resolve(options.root ?? process.cwd());
  const project: Project = {
    projectDir,
    componentsDir: resolve(projectDir, options.components),
    entry: options.entry,
  };
  const outDir = resolve(projectDir, options.outDir ?? "dist");
  const outWasmDir = join(outDir, "wasm");
  const detected = detectProjectLanguage(projectDir, config.language);

  console.log(`\n  ${boldPink("Hypen Build")} ${dim("→")} ${yellow("wasm")}\n`);
  console.log(`  ${dim("Entry:")}      ${project.entry}`);
  const languageSource = detected.from === "config" ? ` ${dim("(hypen.json wasm.language)")}` : "";
  console.log(`  ${dim("Language:")}   ${LANGUAGE_LABELS[detected.language]}${languageSource}`);
  console.log(`  ${dim("Components:")} ${project.componentsDir}`);
  console.log(`  ${dim("Output:")}     ${outWasmDir}\n`);

  assertComponentsDir(project.componentsDir);
  assertSafeOutput(outWasmDir, project);

  const plan: BuildPlan = {
    project,
    outDir,
    outWasmDir,
    keepTemp: options.keepTemp ?? false,
    config,
  };
  // One arm per language keeps each builder's source/prepared types intact
  // (a `Record<Language, ModuleBuilder<…>>` lookup would have to erase them).
  switch (detected.language) {
    case "ts":
      return runBuild(tsBuilder, plan);
    case "go":
      return runBuild(goBuilder, plan);
    case "rust":
      return runBuild(rustBuilder, plan);
  }
}
