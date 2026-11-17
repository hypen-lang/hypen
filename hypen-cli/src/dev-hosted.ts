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

import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import type { HostedModuleDefinition, HostedModuleFailure } from "@hypen-space/core";
import { BuildError, formatBuildError } from "./build-error.js";
import { boldYellow, dim, pink, yellow } from "./colors.js";
import { buildSourcePackage, type BuiltSource } from "./wasm/build.js";
import { parseWasmConfig, type PackageDeclaration, type WasmConfig } from "./wasm/config.js";
import { resolveHosted, type PackageComponentUse, type ResolvedHosted } from "./wasm/packages.js";
import { readProjectConfig } from "./project-config.js";
import type { PrebuiltModule } from "./wasm/types.js";

/** The slice of the project's `@hypen-space/server` this file uses. */
export interface HostedServerPackage {
  wasmModule?: (options: {
    name: string;
    component: string;
    template?: string;
    ui?: string;
    grants: {
      reads: string[];
      dispatches: string[];
      storage: string[];
      http: boolean;
      httpHosts?: string[];
      aliases?: Record<string, string>;
    };
    declaredAt: string;
    grantsAt: string;
    label?: string;
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
  /** Template-only components that come from packages (newer @hypen-space/server). */
  components?(components: Record<string, string>): unknown;
  reload?(): Promise<void>;
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
  /** The app's components directory: enables the name-collision and export checks. */
  componentsDir?: string;
  /** `source` packages already built (see {@link DevPrebuiltModules.create}). */
  built?: Map<string, BuiltSource>;
}

/** Directories of a module project whose changes are never source changes. */
const IGNORED_SOURCE_DIRS = new Set(["node_modules", "target", "dist", ".git", ".wasm-temp"]);

/** A cheap fingerprint of a module project's sources: paths, sizes, mtimes. */
function sourceStamp(dir: string, outDir: string): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry);
      if (IGNORED_SOURCE_DIRS.has(entry) || path === outDir || entry.startsWith(".wasm-")) continue;
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path);
      else parts.push(`${path}:${stat.size}:${stat.mtimeMs}`);
    }
  };
  walk(dir);
  return parts.join("\n");
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
  http: "HTTP request did not complete",
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
                : f.origin.kind === "httpRequest"
                  ? `http request ${f.origin.method} ${f.origin.url}`
                  : f.origin.kind === "httpRefusal"
                    ? "completion of a refused http request"
                    : f.origin.kind;
      const cause =
        f.cause.code === "host" ? `${f.cause.host.code}: ${f.cause.host.message}` : f.cause.code;
      lines.push(`    - ${f.scope} ${f.action} [${f.outcome}; ${origin}] ${cause}`);
    }
  }
  if (failure.http) {
    const by = failure.http.refusedBy ? `; refused by ${failure.http.refusedBy}` : "";
    lines.push(`  request: ${failure.http.method} ${failure.http.url} → ${failure.http.errorKind}${by}`);
  }
  if (failure.missingGrant) {
    const { field, value } = failure.missingGrant;
    lines.push(
      field === "http"
        ? `  missing grant: http ← true`
        : `  missing grant: ${field} ← "${value}"`
    );
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
  private hosted: ResolvedHosted;
  private components: PackageComponentUse[];
  private readonly built: Map<string, BuiltSource>;
  /** Per source package: the fingerprint of its sources when it was last built. */
  private readonly sourceStamps = new Map<string, string>();
  private sourceTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.built = options.built ?? new Map();
    this.hosted = this.resolve(this.config);
    this.modules = this.hosted.modules;
    this.components = this.hosted.components;
    if (this.modules.length > 0 && typeof options.serverPackage.wasmModule !== "function") {
      throw new BuildError(
        `hypen.json declares prebuilt modules (${this.names.join(", ")}), but the ` +
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

  /**
   * Like the constructor, but first builds the `source` packages of
   * hypen.json (module projects in this repository) with the wasm build
   * pipeline. A package that fails to build is reported and left out — the
   * rest of the app still starts — and is retried when its sources change.
   *
   * @throws {BuildError} for everything the constructor throws.
   */
  static async create(options: DevPrebuiltOptions): Promise<DevPrebuiltModules> {
    const print = options.print ?? { error: (line: string) => console.error(line), info: (line: string) => console.log(line) };
    const config = parseWasmConfig(options.wasm);
    const built = options.built ?? new Map<string, BuiltSource>();
    const stamps = new Map<string, string>();
    for (const decl of config.packages.values()) {
      if (!decl.source) continue;
      stamps.set(decl.from, DevPrebuiltModules.stampOf(decl, options.projectRoot));
      print.info(`  ${pink("Building")} ${decl.from} ${dim("(source package)")}`);
      try {
        const source = await buildSourcePackage(decl, options.projectRoot, { log: (line) => print.info(`  ${dim("│")}${line}`) });
        if (source.notice) print.error(`\n  ${boldYellow("Notice:")} ${source.notice}\n`);
        built.set(decl.from, source);
      } catch (err) {
        print.error(`\n  ${yellow(`${decl.from} was not built — its modules are missing from this session until it builds:`)}`);
        if (err instanceof BuildError) for (const line of formatBuildError(err).split("\n")) print.error(line);
        else print.error(`  ${err instanceof Error ? err.message : String(err)}`);
        print.error("");
      }
    }
    const instance = new DevPrebuiltModules({ ...options, built });
    for (const [from, stamp] of stamps) instance.sourceStamps.set(from, stamp);
    for (const note of instance.hosted.notes) print.info(`  ${yellow("Note:")} ${note}`);
    return instance;
  }

  private static stampOf(decl: PackageDeclaration, projectRoot: string): string {
    const dir = resolve(projectRoot, decl.from);
    let outDir = join(dir, "dist");
    try {
      outDir = resolve(dir, readProjectConfig(dir).outDir);
    } catch {
      // A broken hypen.json there is reported by the build.
    }
    return sourceStamp(dir, outDir);
  }

  private resolve(config: WasmConfig): ResolvedHosted {
    return resolveHosted(config, this.options.projectRoot, {
      built: this.built,
      componentsDir: this.options.componentsDir,
    });
  }

  /** One line per package in use, for the startup banner. */
  get packageLines(): string[] {
    return this.hosted.packages.map((use) => {
      const how = use.origin === "source" ? "built from source" : use.origin === "fallback" ? "prebuilt fallback" : `v${use.pkg.manifest.version}`;
      // The names people know: the package's own, not the namespaced ones.
      const names = [...use.modules.map((m) => m.package?.name ?? m.name), ...use.components.map((c) => c.packageName)];
      const usable = use.exports.length > 0 ? ` — use ${use.exports.map((e) => `${e} {}`).join(", ")}` : "";
      return `${use.declaration.from} (${how}): ${names.join(", ")}${usable}`;
    });
  }

  /** The hosted modules, by the names people know (a package module by its name in the package). */
  get names(): string[] {
    return this.modules.map((m) => m.package?.name ?? m.name);
  }

  get size(): number {
    return this.modules.length;
  }

  private stamp(module: PrebuiltModule, config: WasmConfig): string {
    const grants = module.grants ?? config.modules.get(module.name);
    return JSON.stringify([
      module.componentPath,
      fileStamp(module.componentPath),
      module.templatePath ?? "",
      fileStamp(module.templatePath),
      grants?.reads,
      grants?.dispatches,
      grants?.storage,
      grants?.http,
      grants?.httpHosts,
      module.grants?.aliases,
      // A package template is rewritten to its installed names: the text
      // is what is loaded, so the text is what is compared.
      module.package !== undefined ? module.template : undefined,
    ]);
  }

  private define(module: PrebuiltModule, config: WasmConfig): HostedModuleDefinition {
    const grants = module.grants ?? config.modules.get(module.name);
    // A package module's template is rewritten to the names the package is
    // installed under (its `module <Name>` declaration and the tags of its
    // siblings), so it is passed as source.
    const renamed = module.package !== undefined;
    const aliases = module.grants?.aliases ?? {};
    const at = `hypen.json ${module.field}`;
    // Checked in the constructor.
    const wasmModule = this.options.serverPackage.wasmModule!;
    return wasmModule({
      name: module.name,
      component: module.componentPath,
      ...(renamed && module.template !== undefined
        ? { ui: module.template }
        : module.templatePath !== undefined
          ? { template: module.templatePath }
          : {}),
      grants: {
        reads: grants?.reads ?? [],
        dispatches: grants?.dispatches ?? [],
        storage: grants?.storage ?? [],
        http: grants?.http ?? false,
        // Only when narrowed: a project on an older @hypen-space/server
        // rejects a grant key it does not know.
        ...(grants?.httpHosts?.length ? { httpHosts: grants.httpHosts } : {}),
        // Likewise only when there is one: the names this module uses for
        // other modules, where they are installed under another scope.
        ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
      },
      declaredAt: at,
      grantsAt: module.grants?.editAt ?? at,
      // What the module is called in its package, when it is installed
      // under another name (diagnostics say `Cart`, not the namespaced name).
      ...(module.package !== undefined && module.package.name !== module.name ? { label: module.package.name } : {}),
    });
  }

  /** Register the modules and the diagnostics printer on `server` (before `prepare()` / `listen()`). */
  attach(server: HostedRemoteServer): void {
    this.attachComponents(server);
    if (this.modules.length === 0) return;
    server.wasmModules(...this.modules.map((m) => this.define(m, this.config)));
    server.hostedModules({ onError: (failure) => this.printFailure(failure) });
    for (const module of this.modules) this.loaded.set(module.name, this.stamp(module, this.config));
  }

  /** Register the packages' template-only components on `server`. */
  private attachComponents(server: HostedRemoteServer): void {
    if (this.components.length === 0 && this.componentsStamp === "[]") return;
    if (typeof server.components !== "function") {
      throw new BuildError(
        `Packages bring template-only components (${this.components.map((c) => c.name).join(", ")}), but the ` +
          "project's @hypen-space/server cannot register them.",
        {
          code: "PREBUILT_UNSUPPORTED_TARGET",
          file: "hypen.json",
          field: "wasm.packages",
          hint: "update @hypen-space/server to a version with `RemoteServer.components()`",
        }
      );
    }
    server.components(Object.fromEntries(this.components.map((c) => [c.name, c.template])));
    this.componentsStamp = JSON.stringify(this.components.map((c) => [c.name, c.template]));
  }
  private componentsStamp = "[]";

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

  private sameSet(modules: readonly PrebuiltModule[]): boolean {
    return this.modules.map((m) => m.name).sort().join(",") === modules.map((m) => m.name).sort().join(",");
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
      const hosted = this.resolve(config);
      modules = hosted.modules;
      const components = JSON.stringify(hosted.components.map((c) => [c.name, c.template]));
      if (components !== this.componentsStamp && this.sameSet(modules)) {
        this.components = hosted.components;
        this.attachComponents(server);
        await server.reload?.();
        this.print.info(`  ${yellow("Reloaded")} ${dim("(package components changed)")}`);
      }
      this.hosted = hosted;
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
        this.print.info(`  ${yellow("Reloaded")} ${module.package?.name ?? module.name} ${dim(`(${detail})`)}`);
      } catch (err) {
        // Remember the stamp anyway: the same broken file is not retried
        // (and re-reported) on unrelated events; the next write changes it.
        this.loaded.set(module.name, stamp);
        this.printError(`Not reloaded: ${module.package?.name ?? module.name} keeps running its previous build.`, err);
      }
    }
  }

  /**
   * Watch the modules' files and hypen.json; reload on change. Watches the
   * files' *directories*: a rebuilt `.wasm` is usually written to a temp
   * name and renamed over the old one, which a watch on the file would miss.
   */
  watch(server: HostedRemoteServer): { stop: () => void } {
    if (this.modules.length === 0 && this.config.packages.size === 0) return { stop: () => {} };
    const files = new Set<string>();
    for (const module of this.modules) {
      files.add(module.componentPath);
      if (module.templatePath !== undefined) files.add(module.templatePath);
    }
    for (const component of this.components) files.add(component.templatePath);
    if (this.options.configFile !== undefined) files.add(resolve(this.options.configFile));
    this.watchSources(server);
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

  /**
   * Watch the module projects of `source` packages; on a change to their
   * sources rebuild (debounced) and hot-reload. A failed rebuild prints the
   * build error and leaves the running instances alone.
   */
  private watchSources(server: HostedRemoteServer): void {
    for (const decl of this.config.packages.values()) {
      if (!decl.source || this.built.get(decl.from)?.origin === "fallback") continue;
      const dir = resolve(this.options.projectRoot, decl.from);
      try {
        const watcher = watch(dir, { recursive: true }, (_event, filename) => {
          const first = String(filename ?? "").split(/[\\/]/)[0] ?? "";
          if (IGNORED_SOURCE_DIRS.has(first) || first.startsWith(".wasm-")) return;
          if (this.sourceTimer) clearTimeout(this.sourceTimer);
          this.sourceTimer = setTimeout(() => {
            this.sourceTimer = null;
            void this.rebuildSources(server);
          }, 300);
        });
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch {
        this.print.error(`  ${yellow("Warning:")} cannot watch ${decl.from}; it will not rebuild on change.`);
      }
    }
  }

  /** Rebuild every source package whose sources changed since its last build. Never rejects. */
  rebuildSources(server: HostedRemoteServer): Promise<void> {
    const run = this.running.then(async () => {
      let rebuilt = false;
      for (const decl of this.config.packages.values()) {
        if (!decl.source || this.built.get(decl.from)?.origin === "fallback") continue;
        const stamp = DevPrebuiltModules.stampOf(decl, this.options.projectRoot);
        if (this.sourceStamps.get(decl.from) === stamp) continue;
        this.sourceStamps.set(decl.from, stamp);
        this.print.info(`  ${pink("Rebuilding")} ${decl.from} ${dim("…")}`);
        try {
          const source = await buildSourcePackage(decl, this.options.projectRoot, {
            log: (line) => this.print.info(`  ${dim("│")}${line}`),
          });
          this.built.set(decl.from, source);
          rebuilt = true;
        } catch (err) {
          this.printError(`${decl.from} did not build — the running modules keep their previous build:`, err);
        }
      }
      if (rebuilt) await this.reloadNow(server);
    });
    this.running = run.catch((err) => this.printError("Rebuild failed:", err));
    return this.running;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.sourceTimer) clearTimeout(this.sourceTimer);
    this.sourceTimer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
