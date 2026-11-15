/**
 * Prebuilt (hosted) modules in the dev server.
 *
 * hypen.json can declare modules that are *installed*, not compiled:
 * `wasm.modules.<Name>.component` (+ `template`) — a `.wasm` Component built
 * elsewhere, e.g. from Rust. `hypen dev` loads them into the same
 * `RemoteServer` as the project's TypeScript modules, watches their files
 * (and hypen.json, for their grants) and hot-reloads them in place.
 *
 * Shared by the Bun and Node dev servers. Never exits the process and never
 * throws from a watcher callback: a broken rebuild is printed and the
 * previous instance keeps running.
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "fs";
import { basename, dirname, relative, resolve } from "path";
import type { HostedModuleDefinition, HostedModuleFailure } from "@hypen-space/core";
import { BuildError, formatBuildError } from "./build-error.js";
import { boldYellow, dim, pink, yellow } from "./colors.js";
import { parseWasmConfig, type WasmConfig } from "./wasm/config.js";
import { resolvePrebuiltModules } from "./wasm/prebuilt.js";
import type { PrebuiltModule } from "./wasm/types.js";

/** The slice of the project's `@hypen-space/server` this file uses. */
export interface HostedServerPackage {
  wasmModule?: (options: {
    name: string;
    component: string;
    template?: string;
    grants: { reads: string[]; dispatches: string[]; storage: string[]; http: boolean };
    declaredAt: string;
    grantsAt: string;
  }) => HostedModuleDefinition;
}

/** The slice of a `RemoteServer` this file drives. */
export interface HostedRemoteServer {
  wasmModules(...modules: HostedModuleDefinition[]): unknown;
  hostedModules(options: { onError: (failure: HostedModuleFailure) => void }): unknown;
  reloadWasmModule(
    definition: HostedModuleDefinition,
    options?: { reconnect?: boolean }
  ): Promise<{ module: string; sessions: number; reloaded: number; stateReset: number; kept: number; failed: number }>;
}

export interface DevPrebuiltOptions {
  /** The raw `wasm` section of hypen.json. */
  wasm: unknown;
  /** Path of hypen.json, re-read on change (grants). Omit to use `wasm` as given forever. */
  configFile?: string;
  projectRoot: string;
  /** The project's `@hypen-space/server` (the one the RemoteServer comes from). */
  serverPackage: HostedServerPackage;
  /** Where diagnostics go. Default: `console.error` / `console.log`. */
  print?: { error(line: string): void; info(line: string): void };
}

/** A setup error of `@hypen-space/server`'s hosted modules, recognised structurally. */
interface SetupErrorLike {
  name: string;
  message: string;
  code: string;
  module?: string;
  file?: string;
  field?: string;
  hint?: string;
}

/**
 * Whether `err` is a `HostedModuleSetupError`. Structural on purpose: the
 * dev server runs the *project's* copy of `@hypen-space/server`, so an
 * `instanceof` against the CLI's copy would miss it.
 */
export function isHostedSetupError(err: unknown): err is SetupErrorLike {
  return (
    err instanceof Error &&
    err.name === "HostedModuleSetupError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/** Render a hosted-module setup error: message, context, hint. Plain lines. */
export function formatHostedSetupError(err: SetupErrorLike): string[] {
  const lines = [err.message, ""];
  if (err.module) lines.push(`  module:  ${err.module}`);
  if (err.file) lines.push(`  file:    ${err.file}`);
  if (err.field) lines.push(`  field:   ${err.field}`);
  lines.push(`  code:    ${err.code}`);
  if (err.hint) lines.push("", `Hint: ${err.hint}`);
  return lines;
}

const FAILURE_TITLES: Record<HostedModuleFailure["kind"], string> = {
  setup: "could not start",
  lifecycle: "lifecycle hook failed",
  action: "action failed",
  cascade: "action ran, but its follow-ups failed",
  crash: "crashed",
  recovered: "restarted after a crash",
  effect: "effect not performed",
  reload: "hot reload problem",
};

/**
 * Render one run-time failure of a hosted module for the dev console: what
 * failed, the engine's cascade report (which module, which action, why),
 * the missing grant as the hypen.json field to edit, and the hint.
 */
export function formatHostedFailure(failure: HostedModuleFailure): string[] {
  const what = failure.action ? ` "${failure.action}"` : "";
  const report = failure.report;
  const title =
    failure.kind === "cascade" && report?.root.kind === "hostWrite"
      ? `could not react to a state change of "${report.root.scope}"`
      : FAILURE_TITLES[failure.kind];
  const lines = [`${failure.module}${what}: ${title}`, `  ${failure.message}`];
  if (report) {
    const root =
      report.root.kind === "hostWrite"
        ? `a state write to "${report.root.scope}"`
        : `${report.root.scope} ${report.root.action}`;
    lines.push(
      `  cascade: ${root} — ${report.failureCount} failure${report.failureCount === 1 ? "" : "s"}` +
        (report.rootFailed ? " (the action itself failed: nothing was applied)" : " (applied state stands)")
    );
    for (const f of report.failures) {
      const origin =
        f.origin.kind === "crossDispatch"
          ? `dispatched by "${f.origin.from}"`
          : f.origin.kind === "subscriptionChange"
            ? `notified of ${f.origin.target}.${f.origin.path}`
            : f.origin.kind === "subscribeRequest"
              ? `subscribing to ${f.origin.target}.${f.origin.path}`
              : f.origin.kind === "lifecycle"
                ? `lifecycle ${f.origin.hook}`
                : f.origin.kind;
      const cause =
        f.cause.code === "host" ? `${f.cause.host.code}: ${f.cause.host.message}` : f.cause.code;
      lines.push(`    - ${f.scope} ${f.action} [${f.outcome}; ${origin}] ${cause}`);
    }
  }
  if (failure.missingGrant) {
    lines.push(`  missing grant: ${failure.missingGrant.field} ← "${failure.missingGrant.value}"`);
  }
  if (failure.hint) lines.push(`  Hint: ${failure.hint}`);
  return lines;
}

function fileStamp(path: string | undefined): string {
  if (path === undefined) return "";
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

/**
 * The prebuilt modules of a dev session: resolved from hypen.json, turned
 * into hosted module definitions, attached to the server, and hot-reloaded.
 */
export class DevPrebuiltModules {
  private readonly options: DevPrebuiltOptions;
  private readonly print: { error(line: string): void; info(line: string): void };
  private config: WasmConfig;
  private modules: PrebuiltModule[];
  /** Per module: the stamps of its files and its grants when it was last (re)loaded. */
  private loaded = new Map<string, string>();
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  /** The set of prebuilt modules changed: a restart is needed (said once). */
  private warnedSetChanged = false;

  /**
   * @throws {BuildError} when hypen.json's `wasm` section is malformed or a
   *   prebuilt module's files are missing / not a component — or the
   *   project's `@hypen-space/server` predates hosted modules.
   */
  constructor(options: DevPrebuiltOptions) {
    this.options = options;
    this.print = options.print ?? {
      error: (line) => console.error(line),
      info: (line) => console.log(line),
    };
    this.config = parseWasmConfig(options.wasm);
    this.modules = resolvePrebuiltModules(this.config, options.projectRoot);
    if (this.modules.length > 0 && typeof options.serverPackage.wasmModule !== "function") {
      throw new BuildError(
        `hypen.json declares prebuilt modules (${this.modules.map((m) => m.name).join(", ")}), but the ` +
          "project's @hypen-space/server cannot run them.",
        {
          code: "PREBUILT_UNSUPPORTED_TARGET",
          file: "hypen.json",
          field: this.modules[0]?.field,
          hint: "update @hypen-space/server (and install @hypen-space/module-host) to a version with hosted-module support",
        }
      );
    }
  }

  get names(): string[] {
    return this.modules.map((m) => m.name);
  }

  get size(): number {
    return this.modules.length;
  }

  private stamp(module: PrebuiltModule, config: WasmConfig): string {
    const grants = config.modules.get(module.name);
    return JSON.stringify([
      module.componentPath,
      fileStamp(module.componentPath),
      module.templatePath ?? "",
      fileStamp(module.templatePath),
      grants?.reads,
      grants?.dispatches,
      grants?.storage,
      grants?.http,
    ]);
  }

  private define(module: PrebuiltModule, config: WasmConfig): HostedModuleDefinition {
    const grants = config.modules.get(module.name);
    const at = `hypen.json ${module.field}`;
    // Checked in the constructor.
    const wasmModule = this.options.serverPackage.wasmModule!;
    return wasmModule({
      name: module.name,
      component: module.componentPath,
      ...(module.templatePath !== undefined ? { template: module.templatePath } : {}),
      grants: {
        reads: grants?.reads ?? [],
        dispatches: grants?.dispatches ?? [],
        storage: grants?.storage ?? [],
        http: grants?.http ?? false,
      },
      declaredAt: at,
      grantsAt: at,
    });
  }

  /** Register the modules and the diagnostics printer on `server` (before `prepare()` / `listen()`). */
  attach(server: HostedRemoteServer): void {
    if (this.modules.length === 0) return;
    server.wasmModules(...this.modules.map((m) => this.define(m, this.config)));
    server.hostedModules({ onError: (failure) => this.printFailure(failure) });
    for (const module of this.modules) this.loaded.set(module.name, this.stamp(module, this.config));
  }

  private printFailure(failure: HostedModuleFailure): void {
    const [title, ...rest] = formatHostedFailure(failure);
    const mark = failure.kind === "recovered" ? yellow("↻") : boldYellow("✖");
    this.print.error(`\n  ${mark} ${title}`);
    for (const line of rest) this.print.error(`  ${line}`);
    this.print.error("");
  }

  private printError(title: string, err: unknown): void {
    this.print.error(`\n  ${yellow(title)}`);
    if (err instanceof BuildError) {
      for (const line of formatBuildError(err).split("\n")) this.print.error(line);
    } else if (isHostedSetupError(err)) {
      for (const line of formatHostedSetupError(err)) this.print.error(`  ${line}`);
    } else {
      this.print.error(`  ${err instanceof Error ? err.message : String(err)}`);
    }
    this.print.error("");
  }

  /** Re-read hypen.json's `wasm` section (when a config file was given). */
  private readConfig(): WasmConfig {
    const file = this.options.configFile;
    if (file === undefined || !existsSync(file)) return this.config;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (cause) {
      throw new BuildError(`hypen.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {
        code: "CONFIG_INVALID",
        file: "hypen.json",
        hint: "fix the syntax error; prebuilt modules keep running with their previous grants",
        cause,
      });
    }
    return parseWasmConfig((raw as { wasm?: unknown } | null)?.wasm);
  }

  /**
   * Reload every prebuilt module whose files or grants changed. Resolves
   * once done; never rejects (problems are printed).
   */
  reloadChanged(server: HostedRemoteServer): Promise<void> {
    const run = this.running.then(() => this.reloadNow(server)).catch((err) => this.printError("Hot reload failed:", err));
    this.running = run;
    return run;
  }

  private async reloadNow(server: HostedRemoteServer): Promise<void> {
    let config: WasmConfig;
    let modules: PrebuiltModule[];
    try {
      config = this.readConfig();
      modules = resolvePrebuiltModules(config, this.options.projectRoot);
    } catch (err) {
      this.printError("Not reloaded — the running modules keep the last good version:", err);
      return;
    }

    const before = this.modules.map((m) => m.name).sort().join(",");
    const after = modules.map((m) => m.name).sort().join(",");
    if (before !== after) {
      if (!this.warnedSetChanged) {
        this.warnedSetChanged = true;
        this.print.error(
          `\n  ${yellow("hypen.json:")} the set of prebuilt modules changed (${before || "none"} → ${after || "none"}). ` +
            `Restart ${pink("hypen dev")} to apply it.\n`
        );
      }
    } else {
      this.warnedSetChanged = false;
    }

    for (const module of modules) {
      if (!this.loaded.has(module.name)) continue; // added: needs a restart
      const stamp = this.stamp(module, config);
      if (this.loaded.get(module.name) === stamp) continue;
      try {
        const definition = this.define(module, config);
        const result = await server.reloadWasmModule(definition, { reconnect: true });
        this.loaded.set(module.name, stamp);
        this.config = config;
        this.modules = modules;
        const detail =
          result.sessions === 0
            ? "no open session uses it yet"
            : [
                result.reloaded > 0 ? `${result.reloaded} session(s) kept their state` : "",
                result.stateReset > 0 ? `${result.stateReset} re-initialised (the new build did not accept the old state)` : "",
                result.kept > 0 ? `${result.kept} kept the previous instance` : "",
                result.failed > 0 ? `${result.failed} could not restart it` : "",
              ]
                .filter(Boolean)
                .join(", ");
        this.print.info(`  ${yellow("Reloaded")} ${module.name} ${dim(`(${detail})`)}`);
      } catch (err) {
        // Remember the stamp anyway: the same broken file is not retried
        // (and re-reported) on unrelated events; the next write changes it.
        this.loaded.set(module.name, stamp);
        this.printError(`Not reloaded: ${module.name} keeps running its previous build.`, err);
      }
    }
  }

  /**
   * Watch the modules' files and hypen.json; reload on change. Watches the
   * files' *directories*: a rebuilt `.wasm` is usually written to a temp
   * name and renamed over the old one, which a watch on the file would miss.
   */
  watch(server: HostedRemoteServer): { stop: () => void } {
    if (this.modules.length === 0) return { stop: () => {} };
    const files = new Set<string>();
    for (const module of this.modules) {
      files.add(module.componentPath);
      if (module.templatePath !== undefined) files.add(module.templatePath);
    }
    if (this.options.configFile !== undefined) files.add(resolve(this.options.configFile));
    const byDir = new Map<string, Set<string>>();
    for (const file of files) {
      const names = byDir.get(dirname(file)) ?? new Set<string>();
      names.add(basename(file));
      byDir.set(dirname(file), names);
    }
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer);
      // Long enough for a toolchain to finish writing the file.
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.reloadChanged(server);
      }, 200);
    };
    for (const [dir, names] of byDir) {
      try {
        const watcher = watch(dir, (_event, filename) => {
          if (filename === null || names.has(String(filename))) schedule();
        });
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch {
        this.print.error(
          `  ${yellow("Warning:")} cannot watch ${relative(this.options.projectRoot, dir) || dir}; ` +
            "prebuilt modules there will not hot-reload."
        );
      }
    }
    return { stop: () => this.stop() };
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
