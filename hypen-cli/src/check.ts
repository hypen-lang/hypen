/**
 * `hypen check` — accessibility conformance over a project's `.hypen` files.
 *
 * Globs the project's `.hypen` sources, runs the engine's dev-mode
 * accessibility conformance pass over each, and prints findings as:
 *
 *   <file>:<line>:<col>: a11y[<rule>] <elementType> — <message>
 *
 * (line/col resolved by the engine binding from the element's source span;
 * findings from an older binding without span support fall back to the
 * per-file form without `:<line>:<col>`), followed by a summary count.
 * Exits non-zero when any findings exist.
 *
 * "Couldn't check must never read as no issues": a missing engine binding,
 * an unreadable/unparseable file, or a nonexistent target path all resolve
 * to the {@link COULD_NOT_CHECK} sentinel (exit 2) when there are no
 * findings — never to a clean pass. A stale binding that lacks newer rules
 * is surfaced as a drift warning ({@link detectRuleDrift}) without failing
 * the run, since findings from the rules it does implement remain valid.
 *
 * Suppression is two-layered: inline `// hypen-a11y-ignore [rule-id, …]`
 * directives (resolved by the engine binding against the source) and
 * hypen.json's `"a11y": { "ignoreRules": [...] }` (filtered here). Both are
 * counted and reported as `N finding(s) suppressed.` — suppression must
 * never be invisible — and neither affects the exit code.
 *
 * The non-trivial pieces — file discovery, target resolution, report
 * formatting, drift detection, and outcome folding — are factored into pure
 * functions so they can be unit-tested without a WASM rebuild or a live
 * engine.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import type { A11yDiagnostic } from "@hypen-space/core";

/**
 * A finding paired with the file it came from. `file` is a display path
 * (caller decides absolute vs. relative).
 */
export interface FileA11yFinding {
  file: string;
  diagnostic: A11yDiagnostic;
}

/**
 * Engine finding plus the binding's inline-suppression verdict. Newer
 * bindings mark findings matched by a `// hypen-a11y-ignore` directive
 * (resolved engine-side, where the source and spans live) with
 * `suppressed: true`; older bindings omit the field, so nothing is ever
 * suppressed by accident. Local extension until the installed core's
 * `A11yDiagnostic` carries it.
 */
interface SuppressableDiagnostic extends A11yDiagnostic {
  suppressed?: boolean;
}

/**
 * Split engine findings into active vs suppressed. A finding is suppressed
 * when the engine binding marked it (inline `// hypen-a11y-ignore`
 * directive) or its rule id is listed in hypen.json's `a11y.ignoreRules`.
 * Suppressed findings are counted, never dropped silently — the caller
 * reports the count ({@link formatA11yReport}) so suppression stays visible,
 * but they never contribute to the exit code.
 */
export function partitionFindings(
  diagnostics: A11yDiagnostic[],
  ignoreRules: readonly string[] = [],
): { active: A11yDiagnostic[]; suppressedCount: number } {
  const ignore = new Set(ignoreRules);
  const active: A11yDiagnostic[] = [];
  let suppressedCount = 0;
  for (const d of diagnostics) {
    if ((d as SuppressableDiagnostic).suppressed === true || ignore.has(d.rule)) {
      suppressedCount++;
    } else {
      active.push(d);
    }
  }
  return { active, suppressedCount };
}

/**
 * One-line note for a WASM binding without `checkAccessibility` — shared with
 * the dev-loop checker (`dev.ts`) so "binding missing" reads identically in
 * `hypen check` and `hypen dev --a11y`.
 */
export const A11Y_BINDING_UNAVAILABLE =
  "Accessibility check could not run: the engine binding is unavailable.";

/**
 * Sentinel return from {@link runCheck} when the check could not run at all
 * (e.g. the engine binding is missing) or could not cover every file (a
 * read/parse failure with no findings elsewhere). Distinct from `0` (ran,
 * clean) and `> 0` (ran, found issues) so the caller can exit with a
 * "couldn't check" code rather than a false success.
 */
export const COULD_NOT_CHECK = -1;

/**
 * Kebab-case rule ids this checker expects the engine binding to implement.
 * Canonical source: the engine's `A11yRule` enum (`ir/conformance.rs`, which
 * pins these exact strings in a unit test), mirrored as
 * `EXPECTED_A11Y_RULES` in `@hypen-space/core`. The CLI carries its own copy
 * because the *installed* core can itself predate the list — a stale
 * drift-checker cannot flag drift.
 */
export const EXPECTED_A11Y_RULES: readonly string[] = [
  "missing-accessible-name",
  "image-missing-alt",
  "heading-missing-level",
  "nested-interactive",
  "form-control-missing-label",
  "unknown-role-token",
  "unknown-dir-token",
  "dangling-reference",
  "duplicate-id",
  "tablist-wiring-skipped",
  "non-portable-aria",
  "unknown-live-token",
  "unknown-ignore-rule",
  "video-missing-label",
];

/** Result of {@link detectRuleDrift}. */
export interface RuleDrift {
  /** Whether the binding exposes `a11yRules()` at all (older builds don't). */
  hasRuleList: boolean;
  /** Expected rule ids the binding does not implement; empty means no drift. */
  missing: string[];
}

/**
 * Compare the WASM binding's advertised rule set against
 * {@link EXPECTED_A11Y_RULES}. A binding without `a11yRules()` predates
 * rule-list stamping entirely, so every expected rule is reported missing.
 */
export function detectRuleDrift(
  wasmEngine: { a11yRules?: () => string[] } | null | undefined,
): RuleDrift {
  if (typeof wasmEngine?.a11yRules !== "function") {
    return { hasRuleList: false, missing: [...EXPECTED_A11Y_RULES] };
  }
  let advertised: string[];
  try {
    advertised = wasmEngine.a11yRules();
  } catch {
    return { hasRuleList: false, missing: [...EXPECTED_A11Y_RULES] };
  }
  const have = new Set(advertised);
  return {
    hasRuleList: true,
    missing: EXPECTED_A11Y_RULES.filter((rule) => !have.has(rule)),
  };
}

/**
 * Format a drift result into report lines; empty when the binding is in
 * sync. Drift is a warning, not a failure — findings from the rules the
 * binding does implement are still valid, so the check proceeds.
 */
export function formatDriftWarning(drift: RuleDrift): string[] {
  if (drift.missing.length === 0) return [];
  return [
    "WARNING: the engine binding is older than this checker — rebuild with `bun run build:wasm`;" +
      ` missing rules: ${drift.missing.join(", ")}`,
    "         (findings from the rules it does implement are still reported below)",
  ];
}

/**
 * Resolve `hypen check [path...]` positional arguments into concrete files.
 * Relative paths resolve against `cwd`. A file argument is checked as-is
 * (the user named it explicitly, so no extension filter); a directory is
 * scanned with {@link findHypenFiles}. Nonexistent paths are returned in
 * `missing` so the caller can refuse to report a clean pass for them.
 */
export function resolveCheckTargets(
  paths: string[],
  cwd: string,
): { files: string[]; missing: string[] } {
  const files: string[] = [];
  const missing: string[] = [];
  for (const path of paths) {
    const full = resolve(cwd, path);
    if (!existsSync(full)) {
      missing.push(path);
    } else if (statSync(full).isDirectory()) {
      files.push(...findHypenFiles(full));
    } else {
      files.push(full);
    }
  }
  return { files: [...new Set(files)].sort(), missing };
}

/**
 * Fold the finding count and failed-to-check count into {@link runCheck}'s
 * return value. Findings win (exit 1 covers both "issues" and "couldn't
 * check everything"); otherwise any file that failed to read/parse means
 * the result is unknown, not clean — {@link COULD_NOT_CHECK}, never 0.
 */
export function checkOutcome(
  findingCount: number,
  failedFileCount: number,
): number {
  if (findingCount > 0) return findingCount;
  return failedFileCount > 0 ? COULD_NOT_CHECK : 0;
}

/**
 * Recursively collect every `.hypen` file under `root`.
 *
 * Pure with respect to the filesystem it reads: deterministic for a given
 * tree (results are sorted), skips `node_modules`, `.git`, `dist`, and the
 * `.hypen` build cache directory so a project scan doesn't wander into
 * dependencies or generated output. Returns absolute paths.
 */
export function findHypenFiles(root: string): string[] {
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".hypen"]);
  const out: string[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".hypen")) {
        out.push(full);
      }
    }
  }

  if (existsSync(root) && statSync(root).isDirectory()) {
    walk(root);
  }
  out.sort();
  return out;
}

/**
 * Format accessibility findings into a printable, line-oriented report.
 *
 * Pure: takes the findings (already file-tagged) and returns
 * `{ lines, count }`. Each finding renders as:
 *
 *   <file>:<line>:<col>: a11y[<rule>] <elementType> — <message>
 *
 * with the `:<line>:<col>` segment omitted when the diagnostic carries no
 * resolved location (older engine binding, or a finding with no source
 * element). A trailing summary line is appended: either a clean-pass message
 * (when `count` is 0) or `Found N accessibility issue(s) across M file(s).`.
 * A nonzero `suppressedCount` appends one more line — `N finding(s)
 * suppressed.` — so suppression (inline directives, config ignoreRules)
 * never becomes invisible.
 *
 * The caller is responsible for printing the lines and choosing an exit code
 * from `count` (which never includes suppressed findings).
 */
export function formatA11yReport(
  findings: FileA11yFinding[],
  suppressedCount = 0,
): {
  lines: string[];
  count: number;
} {
  const lines = findings.map(({ file, diagnostic: d }) => {
    const location =
      d.line !== undefined && d.col !== undefined ? `:${d.line}:${d.col}` : "";
    return `${file}${location}: a11y[${d.rule}] ${d.elementType} — ${d.message}`;
  });

  const count = findings.length;
  if (count === 0) {
    lines.push("No accessibility issues found.");
  } else {
    const fileCount = new Set(findings.map((f) => f.file)).size;
    lines.push(
      `Found ${count} accessibility issue${count === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
    );
  }
  if (suppressedCount > 0) {
    lines.push(
      `${suppressedCount} finding${suppressedCount === 1 ? "" : "s"} suppressed.`,
    );
  }

  return { lines, count };
}

/**
 * Prefer the canonical `checkRuleDrift` from `@hypen-space/core` when the
 * installed core ships it (its expected-rule list may be newer than this
 * CLI's); an older installed core — the same drift class this detects —
 * falls back to the local {@link detectRuleDrift}.
 */
export async function resolveRuleDrift(wasmEngine: unknown): Promise<RuleDrift> {
  try {
    const core: any = await import("@hypen-space/core");
    if (typeof core.checkRuleDrift === "function") {
      return core.checkRuleDrift(wasmEngine);
    }
  } catch {
    // fall through to the local copy
  }
  return detectRuleDrift(wasmEngine as { a11yRules?: () => string[] });
}

/**
 * Run the accessibility check over a project or an explicit file list.
 *
 * With `files` set (from `hypen check [path...]`), exactly those files are
 * checked. Otherwise `.hypen` files are discovered under `componentsDir`
 * (falling back to the project root when that directory is absent). Each
 * file runs through the engine's `checkAccessibility`; the formatted report
 * is printed and the total finding count returned so the caller can pick an
 * exit code.
 *
 * The engine binding (`checkAccessibility`) only returns findings after a
 * WASM rebuild ships the Rust binding; until then it returns `[]`. We detect
 * the missing binding and print a one-line note rather than silently
 * reporting "all clear" — a clean pass and an absent engine look identical in
 * the finding count otherwise. The same principle covers per-file failures:
 * a file that fails to read or parse is tracked, and when nothing else
 * produced findings the result is {@link COULD_NOT_CHECK}, not clean. A
 * binding missing newer rules is reported as a drift warning without
 * aborting (see {@link formatDriftWarning}).
 *
 * Suppression ({@link partitionFindings}): findings matched by an inline
 * `// hypen-a11y-ignore` directive or a rule in `ignoreRules` are excluded
 * from the report and the returned count (so they never fail CI), but are
 * surfaced as a `N finding(s) suppressed.` summary line.
 */
export async function runCheck(opts: {
  projectRoot: string;
  componentsDir?: string;
  /** Explicit targets (from positional args); skips discovery when set. */
  files?: string[];
  /** Rule ids to suppress project-wide (hypen.json `a11y.ignoreRules`). */
  ignoreRules?: string[];
}): Promise<number> {
  const { projectRoot } = opts;

  let files: string[];
  if (opts.files) {
    files = opts.files;
  } else {
    const componentsDir = opts.componentsDir ?? projectRoot;
    const scanRoot = existsSync(componentsDir) ? componentsDir : projectRoot;
    files = findHypenFiles(scanRoot);
  }

  if (files.length === 0) {
    console.log(
      opts.files
        ? "  No .hypen files found in the given path(s)."
        : "  No .hypen files found under the components directory or project root.",
    );
    return 0;
  }

  const { Engine } = await import("@hypen-space/server");
  const engine = new Engine();
  await engine.init();

  // Detect whether the underlying WASM binding is present. When it is not
  // (no WASM rebuild yet), checkAccessibility degrades to returning [], which
  // is indistinguishable from a clean pass. Rather than mislead, bail out with
  // the COULD_NOT_CHECK sentinel so the caller exits with a distinct code —
  // "couldn't check" must never read as "no issues".
  const wasmEngine = (engine as any)?.wasmEngine;
  const bindingPresent = typeof wasmEngine?.checkAccessibility === "function";
  if (!bindingPresent) {
    console.log(`  ${A11Y_BINDING_UNAVAILABLE}`);
    console.log(
      "  Rebuild the engine (`bun run build:wasm`) and re-run `hypen check`.",
    );
    return COULD_NOT_CHECK;
  }

  // Rule-set drift: a binding can predate newer rules while still exposing
  // checkAccessibility. Warn prominently (in the report, not just stderr)
  // but keep going — findings from the present rules are still valid.
  const driftLines = formatDriftWarning(await resolveRuleDrift(wasmEngine));
  for (const line of driftLines) {
    console.warn(`  ${line}`);
  }

  const findings: FileA11yFinding[] = [];
  const failedFiles: string[] = [];
  let suppressedCount = 0;
  for (const file of files) {
    // Display relative to the project root, except for explicit targets
    // outside it — a `../../..` chain is noisier than the absolute path.
    const rel = relative(projectRoot, file);
    const display = !rel || rel.startsWith("..") ? file : rel;
    let source: string;
    try {
      source = readFileSync(file, "utf-8");
    } catch (e: any) {
      console.error(`  ${display}: failed to read — ${e?.message ?? e}`);
      failedFiles.push(display);
      continue;
    }
    let diags: A11yDiagnostic[] = [];
    try {
      diags = engine.checkAccessibility(source);
    } catch (e: any) {
      console.error(`  ${display}: failed to check — ${e?.message ?? e}`);
      failedFiles.push(display);
      continue;
    }
    const { active, suppressedCount: fileSuppressed } = partitionFindings(
      diags,
      opts.ignoreRules,
    );
    suppressedCount += fileSuppressed;
    for (const d of active) {
      findings.push({ file: display, diagnostic: d });
    }
  }

  const { lines, count } = formatA11yReport(findings, suppressedCount);
  // "No accessibility issues found." would be a lie when files went
  // unchecked — drop the clean line (but keep the suppressed-count line)
  // and report the failures instead.
  const printable =
    count === 0 && failedFiles.length > 0
      ? lines.filter((line) => line !== "No accessibility issues found.")
      : lines;
  for (const line of printable) {
    console.log(`  ${line}`);
  }
  if (failedFiles.length > 0) {
    console.error(
      `  Could not check ${failedFiles.length} file${failedFiles.length === 1 ? "" : "s"}: ${failedFiles.join(", ")}`,
    );
  }

  return checkOutcome(count, failedFiles.length);
}
