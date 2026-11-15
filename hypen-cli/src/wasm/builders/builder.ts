/**
 * The contract between the orchestrator (`../build.ts`) and a language
 * pipeline. The orchestrator owns everything language-agnostic — config,
 * output directories, artifact checks, the manifest — and drives each
 * builder through the same three steps: `discover` → `prepare` → `build`.
 */

import type {
  BuiltModule,
  Capabilities,
  Discovery,
  Language,
  Project,
  StatefulModule,
} from "../types.js";

/** What a builder may touch while a build is running. */
export interface BuildContext {
  project: Project;
  /** Scratch directory unique to this build; removed afterwards unless `--keep-temp`. */
  workDir: string;
  /** Where builders write each `<Name>.wasm`; published as a whole on success. */
  stageDir: string;
  /** Print one progress line. */
  log(line: string): void;
}

/**
 * One language's pipeline. `S` is what a stateful module of this language is
 * built from (a `.ts` file, a Go package, a crate); `P` is whatever `prepare`
 * resolved once for the whole build (toolchains, shared inputs).
 */
export interface ModuleBuilder<S, P> {
  readonly language: Language;
  /** Shown in the build header, e.g. `Rust (cargo)`. */
  readonly label: string;

  /** Find the project's components. Must not write anything. */
  discover(project: Project): Promise<Discovery<S>>;

  /** What the entry must look like to be a module of this language (for errors). */
  entryHint(entry: string): string;

  /** Extra words for a module's progress lines; both optional. */
  describe?(module: StatefulModule<S>): { building?: string; built?: string };

  /**
   * Resolve the toolchain and do the once-per-build setup. Runs after the
   * project has been validated, so its failures are about tools, not config.
   */
  prepare(ctx: BuildContext, modules: readonly StatefulModule<S>[]): Promise<P>;

  /** Compile one module to `<stageDir>/<Name>.wasm`. */
  build(
    ctx: BuildContext,
    prepared: P,
    module: StatefulModule<S>,
    capabilities: Capabilities
  ): Promise<BuiltModule>;
}
