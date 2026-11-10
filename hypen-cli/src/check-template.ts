/**
 * `hypen check` — static template checks: cross-checks each `.hypen`
 * template's references against its module and the project.
 *
 * The engine binding (`templateRefs(source)`, `ir/refs.rs`) reports *facts*:
 * every state path, action, row (`@item`) reference and component name the
 * template uses, located at `line:col`. This file decides validity, because
 * that needs the module (initial state, `onAction` handlers) and the whole
 * project (which components exist, which callers sit inside a loop):
 *
 *   unknown-state-path  root key absent from the module's initial state, or a
 *                       key absent under a plain, non-empty object in it
 *   unknown-action      `@actions.x` with no `onAction("x")` on the module
 *   unknown-component   not built in, and no component of that name exists
 *   item-outside-loop   `@item…` where no ForEach/List/Grid can supply a row
 *   unknown-ignore-rule a `// hypen-check-ignore` id that is not a rule
 *                       (decided by the engine)
 *
 * Findings print as `<file>:<line>:<col>: check[<rule>] <elementType> — <message>`.
 *
 * Conservative by design — a check that fires on correct code gets turned
 * off. State paths are never flagged through `null`, arrays, primitives, or
 * empty objects (all plausibly populated later); actions are only judged
 * for the template's own module (actions route to the module whose template
 * uses them); `item` is only flagged with positive evidence that no caller
 * renders the component inside a loop.
 *
 * "Couldn't check must never read as no issues": a template whose module is
 * missing, fails to load, or is not TypeScript gets only the
 * module-independent rules, and the report says so explicitly.
 *
 * Suppression mirrors the a11y pass: inline `// hypen-check-ignore [rule, …]`
 * (resolved by the engine against the source) and hypen.json
 * `"check": { "ignoreRules": [...] }`, both counted as `N finding(s)
 * suppressed.`, neither affecting the exit code.
 *
 * Out of scope: applicator names. Unknown applicators are not a reliable
 * signal — the DOM renderer forwards any applicator it doesn't handle as a
 * CSS property, so there is no canonical list to check against.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, relative } from "path";
import type {
  TemplateCheckDiagnostic,
  TemplateRef,
  TemplateRefsReport,
} from "@hypen-space/core";
import { COULD_NOT_CHECK, findHypenFiles } from "./check.js";
import { formatHypenParseError } from "./dev-diagnostics.js";

/**
 * Rule ids this checker expects the engine binding to know (Rust
 * `ir::refs::ALL_CHECK_RULES`, mirrored as `EXPECTED_TEMPLATE_CHECK_RULES`
 * in `@hypen-space/core`). Carried locally for the same reason as the a11y
 * list: the installed core can itself predate the list.
 */
export const EXPECTED_CHECK_RULES: readonly string[] = [
  "unknown-state-path",
  "unknown-action",
  "unknown-component",
  "item-outside-loop",
  "unknown-ignore-rule",
];

/** Binding surface this file needs. */
export interface TemplateRefsBinding {
  templateRefs?: (source: string) => TemplateRefsReport;
  templateCheckRules?: () => string[];
}

/** Expected rule ids the binding does not advertise (all when it can't say). */
export function detectTemplateRuleDrift(
  binding: TemplateRefsBinding | null | undefined,
): string[] {
  if (typeof binding?.templateCheckRules !== "function") {
    return [...EXPECTED_CHECK_RULES];
  }
  let have: Set<string>;
  try {
    have = new Set(binding.templateCheckRules());
  } catch {
    return [...EXPECTED_CHECK_RULES];
  }
  return EXPECTED_CHECK_RULES.filter((rule) => !have.has(rule));
}

// ---------------------------------------------------------------------------
// Project layout (mirrors `@hypen-space/server` discovery conventions)
// ---------------------------------------------------------------------------

/**
 * Component name a `.hypen` file registers under, per the discovery
 * conventions: `Name/component.hypen` and `Name/index.hypen` → `Name`;
 * `Name.hypen` → `Name`.
 */
export function componentNameForFile(file: string): string {
  const base = basename(file, ".hypen");
  if (base === "component" || base === "index") {
    return basename(dirname(file));
  }
  return base;
}

/**
 * The module file paired with a template, per the discovery conventions
 * (`component.hypen` ↔ `component.ts`, `index.hypen` ↔ `index.ts`,
 * `Name.hypen` ↔ `Name.ts`), or `null` when there is none.
 */
export function moduleFileFor(file: string): string | null {
  const candidate = join(dirname(file), `${basename(file, ".hypen")}.ts`);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Non-TypeScript module ecosystems a project root can declare. Returns the
 * language name, or `null` for a TypeScript (or undetermined) project.
 */
export function detectModuleLanguage(projectRoot: string): string | null {
  if (existsSync(join(projectRoot, "go.mod"))) return "Go";
  for (const f of ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"]) {
    if (existsSync(join(projectRoot, f))) return "Kotlin";
  }
  if (existsSync(join(projectRoot, "Package.swift"))) return "Swift";
  if (existsSync(join(projectRoot, "Cargo.toml"))) return "Rust";
  return null;
}

/**
 * Names of single-file components (`Name.ts` containing `.ui(`) under
 * `root` — found textually so the check never imports arbitrary `.ts`
 * files just to learn a name.
 */
export function findSingleFileComponentNames(root: string): string[] {
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".hypen"]);
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts") &&
        !entry.name.includes(".test.")
      ) {
        try {
          if (readFileSync(full, "utf-8").includes(".ui(")) {
            out.push(basename(entry.name, ".ts"));
          }
        } catch {
          // unreadable: not a known component
        }
      }
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Module facts
// ---------------------------------------------------------------------------

/** What the rules need from a loaded module definition. */
export interface ModuleFacts {
  initialState: unknown;
  actions: Set<string>;
}

/** Why a template got no module cross-checks. */
export type ModuleStatus =
  | { kind: "loaded"; facts: ModuleFacts }
  | { kind: "none" }
  | { kind: "failed"; reason: string }
  | { kind: "non-ts"; language: string };

/**
 * Extract {@link ModuleFacts} from a module's default export — a built
 * `app.defineState(...)…build()` definition (`HypenModuleDefinition`), or a
 * builder hosts accept unbuilt (built here the same way
 * `resolveModuleDefinition` in `@hypen-space/core` does, duck-typed).
 * Returns `null` for anything else, so an unrecognized export is reported
 * as "couldn't check" rather than as a module with no state or actions.
 */
export function moduleFactsFromDefinition(def: unknown): ModuleFacts | null {
  if (!def || typeof def !== "object") return null;
  const maybeBuilder = def as { actions?: unknown; build?: unknown };
  if (!Array.isArray(maybeBuilder.actions) && typeof maybeBuilder.build === "function") {
    try {
      def = (maybeBuilder.build as () => unknown)();
    } catch {
      return null;
    }
    if (!def || typeof def !== "object") return null;
  }
  const d = def as { initialState?: unknown; handlers?: { onAction?: unknown }; actions?: unknown };
  const onAction = d.handlers?.onAction;
  if (!(onAction instanceof Map) || !("initialState" in d)) return null;
  const actions = new Set<string>([...onAction.keys()].map(String));
  if (Array.isArray(d.actions)) {
    for (const a of d.actions) actions.add(String(a));
  }
  return { initialState: d.initialState, actions };
}

/** Import a module file and extract its facts. */
export async function loadModuleFacts(modulePath: string): Promise<ModuleStatus> {
  let exported: any;
  try {
    exported = await import(modulePath);
  } catch (e: any) {
    return { kind: "failed", reason: `module failed to load (${firstLine(e?.message ?? e)})` };
  }
  const facts = moduleFactsFromDefinition(exported?.default);
  if (!facts) {
    return {
      kind: "failed",
      reason: "module's default export is not a built module definition (app…build())",
    };
  }
  return { kind: "loaded", facts };
}

function firstLine(s: unknown): string {
  return String(s).split("\n")[0];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hasRoot(initialState: unknown, root: string): boolean {
  return isPlainObject(initialState) && Object.prototype.hasOwnProperty.call(initialState, root);
}

/**
 * Classify a state path against a module's initial state, conservatively:
 *
 * - `"unknown-root"` — the root key is absent from the initial state;
 * - `{ unknownAt: i }` — segment `i` is absent under a plain, non-empty
 *   object in the initial state;
 * - `"ok"` — every segment resolved;
 * - `"unknowable"` — the walk reached `null`/`undefined`, an array, a
 *   primitive (`.length`, method calls), an empty object (a map populated
 *   later), or a non-plain object. Never flagged.
 */
export function classifyStatePath(
  initialState: unknown,
  path: readonly string[],
): "ok" | "unknown-root" | "unknowable" | { unknownAt: number } {
  if (!isPlainObject(initialState) || path.length === 0) return "unknowable";
  if (!Object.prototype.hasOwnProperty.call(initialState, path[0])) return "unknown-root";
  let cur: unknown = initialState[path[0]];
  for (let i = 1; i < path.length; i++) {
    if (!isPlainObject(cur) || Object.keys(cur).length === 0) return "unknowable";
    if (!Object.prototype.hasOwnProperty.call(cur, path[i])) return { unknownAt: i };
    cur = cur[path[i]];
  }
  return "ok";
}

// ---------------------------------------------------------------------------
// Cross-file loop context
// ---------------------------------------------------------------------------

/** One instantiation of a component inside another component's template. */
export interface ComponentUsage {
  /** Component whose template contains the usage. */
  owner: string;
  /** The component instantiated. */
  name: string;
  /** Whether a loop in the owner's template encloses the usage. */
  inLoop: boolean;
}

/**
 * Components rendered inside a loop somewhere: instantiated within a
 * ForEach/List/Grid, or within a component that itself is (transitively) —
 * row context flows into an instantiated component's template.
 */
export function componentsInLoopContext(usages: readonly ComponentUsage[]): Set<string> {
  const inLoop = new Set<string>();
  for (const u of usages) if (u.inLoop) inLoop.add(u.name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const u of usages) {
      if (!inLoop.has(u.name) && inLoop.has(u.owner)) {
        inLoop.add(u.name);
        changed = true;
      }
    }
  }
  return inLoop;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** A finding from either the engine or the rules below. */
export interface TemplateFinding {
  rule: string;
  elementType: string;
  message: string;
  line?: number;
  col?: number;
}

/** Everything the rules know about one template file. */
export interface TemplateCheckInput {
  /** Component name the file registers under. */
  component: string;
  report: TemplateRefsReport;
  module: ModuleStatus;
  /** Every component name the project defines (any case). */
  knownComponents: ReadonlySet<string>;
  /** Components (transitively) rendered inside a loop somewhere. */
  inLoopContext: ReadonlySet<string>;
  /** Components instantiated anywhere in the project. */
  usedComponents: ReadonlySet<string>;
  /** The project's entry component name, if known. */
  entry?: string;
  /** Lowercased names of every module in the project (merged-tree guard). */
  moduleNames?: ReadonlySet<string>;
  /**
   * Facts of every *other* module in the project. A root key or action that
   * another module provides is never flagged: hosts differ in how far state
   * and dispatch reach (the browser orchestrator shallow-merges every
   * module's state into one tree; unscoped dispatch finds any anonymous
   * module's handler), so only "no module anywhere has it" is certain.
   */
  otherModules?: readonly ModuleFacts[];
  /**
   * False when some other project module failed to load — its state and
   * actions are unknown, so root-key and action verdicts are skipped.
   */
  otherModulesComplete?: boolean;
  /** hypen.json `check.ignoreRules`. */
  ignoreRules?: readonly string[];
}

function suppressedFor(ref: TemplateRef, rule: string, ignore: ReadonlySet<string>): boolean {
  return ref.ignoreAll === true || (ref.ignoreRules ?? []).includes(rule) || ignore.has(rule);
}

/**
 * Whether a reference belongs to the file's own module: unscoped, or scoped
 * by `module X { … }` to the component itself. A reference scoped to some
 * other inline module can't be judged against this file's module.
 */
function ownedBy(ref: TemplateRef, component: string): boolean {
  return !ref.moduleScope || ref.moduleScope === component.toLowerCase();
}

/**
 * Apply every rule to one template. Pure: returns active findings and the
 * count of suppressed ones (inline directives + config `ignoreRules`).
 */
export function evaluateTemplate(input: TemplateCheckInput): {
  findings: TemplateFinding[];
  suppressedCount: number;
} {
  const { component, report } = input;
  const ignore = new Set(input.ignoreRules ?? []);
  const findings: TemplateFinding[] = [];
  let suppressedCount = 0;

  const emit = (ref: TemplateRef, rule: string, message: string) => {
    if (suppressedFor(ref, rule, ignore)) {
      suppressedCount++;
      return;
    }
    findings.push({ rule, elementType: ref.elementType, message, line: ref.line, col: ref.col });
  };

  // Engine-decided findings (unknown-ignore-rule).
  for (const d of report.diagnostics) {
    if (d.suppressed === true || ignore.has(d.rule)) {
      suppressedCount++;
    } else {
      findings.push(diagnosticToFinding(d));
    }
  }

  const known = new Set<string>();
  for (const n of input.knownComponents) known.add(n.toLowerCase());
  for (const n of report.declaredComponents) known.add(n.toLowerCase());
  for (const n of report.importedComponents) known.add(n.toLowerCase());

  const facts = input.module.kind === "loaded" ? input.module.facts : null;
  const others = input.otherModules ?? [];
  const othersComplete = input.otherModulesComplete !== false;
  // Positive evidence that no caller supplies a row: the component is the
  // entry, or is instantiated somewhere and never (transitively) in a loop.
  const rowless =
    !input.inLoopContext.has(component) &&
    (input.usedComponents.has(component) || component === input.entry);

  for (const ref of report.refs) {
    switch (ref.kind) {
      case "component": {
        if (ref.builtin || known.has(ref.name.toLowerCase())) break;
        emit(
          ref,
          "unknown-component",
          `"${ref.name}" is not a built-in element and no component of that name exists in ` +
            `the project — check the spelling, or add ${ref.name}.hypen (or register it)`,
        );
        break;
      }
      case "item": {
        if (ref.root !== "item" || ref.inScope !== false || !rowless) break;
        emit(
          ref,
          "item-outside-loop",
          component === input.entry && !input.usedComponents.has(component)
            ? `@${ref.name} is used outside any ForEach/List/Grid in the entry component, so ` +
                `there is no row to read — it renders as empty`
            : `@${ref.name} is used outside any ForEach/List/Grid, and no template renders ` +
                `${component} inside a loop, so there is no row to read`,
        );
        break;
      }
      case "state": {
        if (!facts || !ownedBy(ref, component)) break;
        const root = ref.path[0];
        if (!root || root.startsWith("__") || input.moduleNames?.has(root.toLowerCase())) break;
        // A non-object initial state says nothing about which keys exist.
        if (!isPlainObject(facts.initialState)) break;
        // Candidate owners of the root: this module first, then any other
        // module in the project (see `otherModules`).
        const candidates = [facts, ...others].filter((m) => hasRoot(m.initialState, root));
        if (candidates.length === 0) {
          if (!othersComplete) break;
          emit(
            ref,
            "unknown-state-path",
            `@state.${ref.name}: "${root}" is not in ${component}'s initial state (nor any ` +
              `other module's) — check the spelling, or add it to defineState(...)`,
          );
          break;
        }
        const verdicts = candidates.map((m) => classifyStatePath(m.initialState, ref.path));
        const first = verdicts[0];
        if (typeof first === "object" && verdicts.every((v) => typeof v === "object")) {
          const parent = ref.path.slice(0, first.unknownAt).join(".");
          emit(
            ref,
            "unknown-state-path",
            `@state.${ref.name}: "${ref.path[first.unknownAt]}" is not a key of ` +
              `state.${parent} in the initial state — check the spelling`,
          );
        }
        break;
      }
      case "action": {
        if (!facts || ref.reserved || !ownedBy(ref, component)) break;
        // `provider.method` dispatches to a data-source plugin, not a handler.
        if (ref.name.includes(".")) break;
        if (facts.actions.has(ref.name)) break;
        if (!othersComplete || others.some((m) => m.actions.has(ref.name))) break;
        emit(
          ref,
          "unknown-action",
          `@actions.${ref.name} has no handler — add .onAction("${ref.name}", …) to ` +
            `${component}'s module (actions route to the module whose template dispatches them)`,
        );
        break;
      }
      case "dataSource":
        // Providers are registered at runtime (plugins, host setContext);
        // not statically knowable, so never flagged.
        break;
    }
  }

  findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0));
  return { findings, suppressedCount };
}

function diagnosticToFinding(d: TemplateCheckDiagnostic): TemplateFinding {
  return { rule: d.rule, elementType: d.elementType, message: d.message, line: d.line, col: d.col };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** A finding paired with its (display) file. */
export interface FileTemplateFinding {
  file: string;
  finding: TemplateFinding;
}

/**
 * Notes on templates that got only the module-independent rules, grouped by
 * reason — printed so skipped cross-checks never read as a clean pass.
 */
export function formatSkipNotes(
  skipped: ReadonlyArray<{ file: string; status: ModuleStatus }>,
): string[] {
  const lines: string[] = [];
  const none = skipped.filter((s) => s.status.kind === "none").map((s) => s.file);
  const nonTs = skipped.filter((s) => s.status.kind === "non-ts");
  const failed = skipped.filter((s) => s.status.kind === "failed");
  if (nonTs.length > 0) {
    const lang = (nonTs[0].status as { language: string }).language;
    lines.push(
      `Note: modules in this project are not TypeScript (${lang}); state/action cross-checks ` +
        `were skipped for ${nonTs.length} template${nonTs.length === 1 ? "" : "s"} — only ` +
        `module-independent rules ran.`,
    );
  }
  if (none.length > 0) {
    lines.push(
      `Note: ${none.length} template${none.length === 1 ? " has" : "s have"} no module file of ` +
        `${none.length === 1 ? "its" : "their"} own; state/action cross-checks were skipped for ` +
        `${none.length === 1 ? "it" : "them"}: ${none.join(", ")}`,
    );
  }
  for (const s of failed) {
    lines.push(
      `Note: ${s.file}: ${(s.status as { reason: string }).reason}; state/action ` +
        `cross-checks were skipped for it.`,
    );
  }
  return lines;
}

/**
 * Format template findings, mirroring `formatA11yReport`:
 * `<file>:<line>:<col>: check[<rule>] <elementType> — <message>`, a summary
 * line, and `N finding(s) suppressed.` when nonzero.
 */
export function formatTemplateReport(
  findings: FileTemplateFinding[],
  suppressedCount = 0,
): { lines: string[]; count: number } {
  const lines = findings.map(({ file, finding: f }) => {
    const location = f.line !== undefined && f.col !== undefined ? `:${f.line}:${f.col}` : "";
    return `${file}${location}: check[${f.rule}] ${f.elementType} — ${f.message}`;
  });
  const count = findings.length;
  if (count === 0) {
    lines.push("No template issues found.");
  } else {
    const fileCount = new Set(findings.map((f) => f.file)).size;
    lines.push(
      `Found ${count} template issue${count === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
    );
  }
  if (suppressedCount > 0) {
    lines.push(`${suppressedCount} finding${suppressedCount === 1 ? "" : "s"} suppressed.`);
  }
  return { lines, count };
}

/**
 * Fold the a11y and template outcomes (each a finding count or
 * {@link COULD_NOT_CHECK}) into one: findings win; otherwise either side
 * failing to check means the run couldn't check.
 */
export function combineOutcomes(a: number, b: number): number {
  const findings = Math.max(a, 0) + Math.max(b, 0);
  if (findings > 0) return findings;
  return a === COULD_NOT_CHECK || b === COULD_NOT_CHECK ? COULD_NOT_CHECK : 0;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the template checks over `files` (or every `.hypen` file under the
 * components directory). The whole project — `componentsDir` when it exists,
 * else the project root, plus the directories of explicit targets — is
 * scanned to learn which components exist and which are rendered in loops,
 * even when only some files are checked. Returns the finding count, or
 * {@link COULD_NOT_CHECK} when the binding is missing or a target couldn't
 * be read/parsed and nothing was found elsewhere.
 */
export async function runTemplateCheck(opts: {
  projectRoot: string;
  componentsDir?: string;
  files?: string[];
  entry?: string;
  ignoreRules?: string[];
}): Promise<number> {
  const { projectRoot } = opts;
  const componentsDir = opts.componentsDir ?? projectRoot;
  const scanRoot = existsSync(componentsDir) ? componentsDir : projectRoot;
  const targets = opts.files ?? findHypenFiles(scanRoot);
  if (targets.length === 0) return 0;

  const { Engine } = await import("@hypen-space/server");
  const engine = new Engine();
  await engine.init();
  const binding = (engine as any)?.wasmEngine as TemplateRefsBinding | undefined;
  if (typeof binding?.templateRefs !== "function") {
    console.log("  Template check could not run: the engine binding lacks templateRefs.");
    console.log("  Rebuild the engine (`bun run build:wasm`) and re-run `hypen check`.");
    return COULD_NOT_CHECK;
  }
  const missingRules = detectTemplateRuleDrift(binding);
  if (missingRules.length > 0) {
    console.warn(
      "  WARNING: the engine binding is older than this checker — rebuild with " +
        `\`bun run build:wasm\`; missing template rules: ${missingRules.join(", ")}`,
    );
  }

  // Project universe: every template the app could instantiate.
  const roots = new Set<string>([scanRoot]);
  for (const f of targets) {
    const dir = dirname(f);
    if (relative(scanRoot, dir).startsWith("..")) roots.add(dir);
  }
  const projectFiles = new Set<string>(targets);
  for (const root of roots) for (const f of findHypenFiles(root)) projectFiles.add(f);

  const knownComponents = new Set<string>();
  for (const root of roots) for (const n of findSingleFileComponentNames(root)) knownComponents.add(n);
  const reports = new Map<string, TemplateRefsReport>();
  const usages: ComponentUsage[] = [];
  const failedTargets: string[] = [];
  const targetSet = new Set(targets);
  const display = (file: string) => {
    const rel = relative(projectRoot, file);
    return !rel || rel.startsWith("..") ? file : rel;
  };

  for (const file of [...projectFiles].sort()) {
    const component = componentNameForFile(file);
    knownComponents.add(component);
    let report: TemplateRefsReport;
    let source = "";
    try {
      source = readFileSync(file, "utf-8");
      report = binding.templateRefs!(source);
    } catch (e: any) {
      // Only checked targets count as "couldn't check"; another project
      // file failing to parse only narrows the usage graph. (The a11y pass
      // already printed the parse error with a code frame, so one line.)
      if (targetSet.has(file)) {
        const [head] = formatHypenParseError(display(file), source, e);
        console.error(`  template check skipped — ${head}`);
        failedTargets.push(display(file));
      }
      continue;
    }
    reports.set(file, report);
    for (const n of report.declaredComponents) knownComponents.add(n);
    for (const ref of report.refs) {
      if (ref.kind === "component" && !ref.builtin) {
        usages.push({ owner: component, name: ref.name, inLoop: ref.inLoop });
      }
    }
  }

  const inLoopContext = componentsInLoopContext(usages);
  const usedComponents = new Set(usages.map((u) => u.name));
  const language = detectModuleLanguage(projectRoot);

  // Load every module in the project, not just the targets': a root key or
  // action another module provides is not flagged (see `otherModules`).
  const modules = new Map<string, ModuleStatus>();
  for (const file of [...projectFiles].sort()) {
    const modulePath = moduleFileFor(file);
    if (modulePath) {
      modules.set(file, await loadModuleFacts(modulePath));
    } else {
      modules.set(file, language ? { kind: "non-ts", language } : { kind: "none" });
    }
  }
  const moduleNames = new Set<string>();
  for (const file of projectFiles) {
    if (moduleFileFor(file)) moduleNames.add(componentNameForFile(file).toLowerCase());
  }
  const unloadedOthers = [...modules.entries()]
    .filter(([file, s]) => s.kind === "failed" && !targetSet.has(file))
    .map(([file]) => display(file));

  const findings: FileTemplateFinding[] = [];
  const skipped: Array<{ file: string; status: ModuleStatus }> = [];
  let suppressedCount = 0;

  for (const file of targets) {
    const report = reports.get(file);
    if (!report) continue;
    const component = componentNameForFile(file);
    const status = modules.get(file) ?? { kind: "none" };
    if (status.kind !== "loaded") skipped.push({ file: display(file), status });
    const otherModules: ModuleFacts[] = [];
    let otherModulesComplete = true;
    for (const [other, s] of modules) {
      if (other === file) continue;
      if (s.kind === "loaded") otherModules.push(s.facts);
      if (s.kind === "failed") otherModulesComplete = false;
    }

    const result = evaluateTemplate({
      component,
      report,
      module: status,
      knownComponents,
      inLoopContext,
      usedComponents,
      entry: opts.entry,
      moduleNames: new Set([...moduleNames].filter((n) => n !== component.toLowerCase())),
      otherModules,
      otherModulesComplete,
      ignoreRules: opts.ignoreRules,
    });
    suppressedCount += result.suppressedCount;
    for (const finding of result.findings) findings.push({ file: display(file), finding });
  }

  const { lines, count } = formatTemplateReport(findings, suppressedCount);
  const printable =
    count === 0 && failedTargets.length > 0
      ? lines.filter((line) => line !== "No template issues found.")
      : lines;
  for (const line of printable) console.log(`  ${line}`);
  for (const line of formatSkipNotes(skipped)) console.log(`  ${line}`);
  if (unloadedOthers.length > 0) {
    console.log(
      `  Note: ${unloadedOthers.length} other module${unloadedOthers.length === 1 ? "" : "s"} ` +
        `failed to load (${unloadedOthers.join(", ")}); unknown state roots and actions were ` +
        `not flagged, since ${unloadedOthers.length === 1 ? "it" : "they"} might provide them.`,
    );
  }
  if (failedTargets.length > 0) {
    console.error(
      `  Could not check templates in ${failedTargets.length} file${failedTargets.length === 1 ? "" : "s"}: ${failedTargets.join(", ")}`,
    );
  }

  if (count > 0) return count;
  return failedTargets.length > 0 ? COULD_NOT_CHECK : 0;
}
