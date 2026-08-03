/**
 * Accessibility conformance diagnostics for the LSP.
 *
 * Loads the Hypen engine WASM (symlinked at `wasm-engine/`, built from
 * `../hypen-engine-rs` with `--features js`) and runs its dev-mode
 * accessibility conformance pass (`WasmEngine.checkAccessibility`) over the
 * open document, publishing findings as inline squiggles.
 *
 * The engine reports each finding with the offending element name token's
 * **UTF-8 byte span** in the source. LSP ranges want 0-based lines and
 * **UTF-16 code-unit** columns (the default `positionEncoding`), so
 * {@link byteOffsetToPosition} converts byte offsets directly to LSP
 * positions — using the engine's pre-resolved `line`/`col` (1-based,
 * codepoint columns, the CLI convention) would misplace squiggles on any
 * line containing a non-BMP character.
 */

import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
} from "vscode-languageserver/node";

/** Shape of one finding from `WasmEngine.checkAccessibility`. */
export interface EngineA11yDiagnostic {
  /** Kebab-case rule id (e.g. `"missing-accessible-name"`). */
  rule: string;
  elementType: string;
  message: string;
  /** UTF-8 byte range of the element's name token in the source. */
  span?: { start: number; end: number };
  /** 1-based line / codepoint column (CLI convention; unused here). */
  line?: number;
  col?: number;
  /**
   * The engine matched an inline `// hypen-a11y-ignore` directive against
   * this finding (newer bindings only) — it must not squiggle.
   */
  suppressed?: boolean;
}

interface CheckingEngine {
  checkAccessibility(source: string): EngineA11yDiagnostic[];
  /** Kebab-case ids of the rules this build implements (newer bindings). */
  a11yRules?(): string[];
}

/**
 * Kebab-case rule ids this LSP build expects the engine to implement.
 * Canonical source: the engine's `A11yRule` enum (`ir/conformance.rs`, which
 * pins these exact strings in a unit test), mirrored as
 * `EXPECTED_A11Y_RULES` in `@hypen-space/core`. Duplicated here because the
 * LSP does not depend on the core SDK (same as {@link EngineA11yDiagnostic}).
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
];

/**
 * Expected rule ids the engine binding does not implement — non-empty means
 * the symlinked WASM predates this checker, so some squiggles silently never
 * appear. A binding without `a11yRules()` predates rule-list stamping
 * entirely: every expected rule is reported missing.
 */
export function missingA11yRules(
  instance: { a11yRules?: () => string[] } | null | undefined,
): string[] {
  if (typeof instance?.a11yRules !== "function") {
    return [...EXPECTED_A11Y_RULES];
  }
  try {
    const have = new Set(instance.a11yRules());
    return EXPECTED_A11Y_RULES.filter((rule) => !have.has(rule));
  } catch {
    return [...EXPECTED_A11Y_RULES];
  }
}

// Singleton engine instance (constructing WasmEngine is cheap; keep one).
let engine: CheckingEngine | null = null;
let engineLoadAttempted = false;

/**
 * Try to load the engine WASM and construct the checking engine.
 * Returns whether accessibility checking is available. Safe to call more
 * than once; only the first call attempts the load.
 */
export async function initWasmEngine(): Promise<boolean> {
  if (engineLoadAttempted) {
    return engine !== null;
  }
  engineLoadAttempted = true;

  try {
    // wasm-engine/ is symlinked (or copied) from ../hypen-engine-rs/pkg/nodejs
    const wasmModule = await import("../wasm-engine/hypen_engine.js");
    const instance = new (wasmModule as any).WasmEngine();
    if (typeof instance.checkAccessibility !== "function") {
      return false;
    }
    engine = instance as CheckingEngine;
    // Rule-set drift: a stale symlinked WASM still exposes
    // checkAccessibility, so it looks current while newer rules silently
    // never fire. The engine loads once per process (stays stale until
    // restart), so warn once here at init. Not fatal — squiggles from the
    // rules it does implement remain valid.
    const missing = missingA11yRules(engine);
    if (missing.length > 0) {
      console.log(
        "Hypen a11y: the engine binding is older than this checker — rebuild with " +
          `\`bun run build:wasm\`; missing rules: ${missing.join(", ")}`,
      );
    }
    return true;
  } catch (e) {
    console.log("Hypen engine WASM not available, a11y diagnostics disabled:", e);
    return false;
  }
}

/** Whether the engine WASM loaded and a11y checking is active. */
export function isWasmEngineAvailable(): boolean {
  return engine !== null;
}

/** Test hook: inject a fake engine (or null to simulate absence). */
export function setEngineForTesting(fake: CheckingEngine | null): void {
  engine = fake;
  engineLoadAttempted = true;
}

/**
 * Convert a UTF-8 **byte** offset (the engine's span encoding) into an LSP
 * `Position` — 0-based line, 0-based **UTF-16 code-unit** column. Offsets
 * past the end of the text clamp to the final position.
 */
export function byteOffsetToPosition(text: string, byteOffset: number): Position {
  let bytes = 0;
  let line = 0;
  let character = 0;
  for (const ch of text) {
    if (bytes >= byteOffset) break;
    const cp = ch.codePointAt(0)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (ch === "\n") {
      line++;
      character = 0;
    } else {
      character += ch.length; // UTF-16 code units (2 for surrogate pairs)
    }
  }
  return { line, character };
}

/**
 * Parse a `// hypen-a11y-ignore [rule-id[, rule-id…]]` directive out of one
 * source line, if present. Mirrors the engine's parser
 * (`ir/conformance.rs::ignore_directive`): the token must open a line
 * comment's text and stand alone as a word (`// hypen-a11y-ignored` is not a
 * directive); the remainder is a comma/whitespace-separated rule-id list, so
 * the bare form (`"all"`) suppresses every rule.
 */
function ignoreDirective(line: string): "all" | Set<string> | null {
  const m = line.match(/\/\/\s*hypen-a11y-ignore(\s.*)?$/);
  if (!m) return null;
  const ids = (m[1] ?? "").split(/[\s,]+/).filter(Boolean);
  return ids.length === 0 ? "all" : new Set(ids);
}

/**
 * Whether an inline `// hypen-a11y-ignore` directive suppresses `finding`:
 * a trailing directive on the finding's line, or a directive on a
 * **comment-only** previous line (comment-only so a trailing directive
 * stays scoped to its own line and never bleeds onto the element below).
 * Newer engine bindings resolve this themselves (`suppressed: true`); this
 * text-side mirror keeps directives honoured under a stale symlinked WASM
 * that predates the field. Findings without a span are never suppressible.
 */
export function isInlineSuppressed(
  text: string,
  finding: EngineA11yDiagnostic,
): boolean {
  if (!finding.span) return false;
  const matches = (d: "all" | Set<string>) => d === "all" || d.has(finding.rule);
  const { line } = byteOffsetToPosition(text, finding.span.start);
  const lines = text.split("\n");
  const same = ignoreDirective(lines[line] ?? "");
  if (same && matches(same)) return true;
  if (line > 0 && lines[line - 1].trimStart().startsWith("//")) {
    const prev = ignoreDirective(lines[line - 1]);
    if (prev) return matches(prev);
  }
  return false;
}

/**
 * Rule → severity. Conservative on purpose: a noisy squiggle pool gets the
 * whole source disabled. Nested interactives are structurally broken
 * (ambiguous activation) → Error; most gaps are fixable-but-real → Warning;
 * a missing heading level only degrades the outline → Information.
 */
const RULE_SEVERITY: Record<string, DiagnosticSeverity> = {
  "nested-interactive": DiagnosticSeverity.Error,
  "missing-accessible-name": DiagnosticSeverity.Warning,
  "image-missing-alt": DiagnosticSeverity.Warning,
  "form-control-missing-label": DiagnosticSeverity.Warning,
  "unknown-role-token": DiagnosticSeverity.Warning,
  "unknown-live-token": DiagnosticSeverity.Warning,
  "unknown-ignore-rule": DiagnosticSeverity.Warning,
  "heading-missing-level": DiagnosticSeverity.Information,
  // Skipped Tabs auto-wiring degrades to unwired-but-functional tabs, and
  // `.aria()` is a sanctioned escape hatch — informational nudges, not gaps.
  "tablist-wiring-skipped": DiagnosticSeverity.Information,
  "non-portable-aria": DiagnosticSeverity.Information,
};

/**
 * Run the accessibility conformance pass over `text` and return LSP
 * diagnostics. Returns `[]` when the engine WASM is unavailable or the
 * source doesn't parse (syntax errors are already reported by the parser
 * diagnostics — duplicating a parse failure here would double-report).
 */
export function a11yDiagnostics(text: string): Diagnostic[] {
  if (!engine) {
    return [];
  }

  let findings: EngineA11yDiagnostic[];
  try {
    findings = engine.checkAccessibility(text);
  } catch {
    return [];
  }

  // Inline `// hypen-a11y-ignore` directives never squiggle — engine-marked
  // on newer bindings, text-side fallback for stale ones. Config-level
  // suppression (hypen.json `a11y.ignoreRules`) is CLI-only for now:
  // honouring it here needs workspace-config plumbing the server doesn't
  // have yet.
  const visible = findings.filter(
    (f) => !f.suppressed && !isInlineSuppressed(text, f),
  );

  return visible.map((f) => {
    const range = f.span
      ? {
          start: byteOffsetToPosition(text, f.span.start),
          end: byteOffsetToPosition(text, f.span.end),
        }
      : {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        };
    return {
      severity: RULE_SEVERITY[f.rule] ?? DiagnosticSeverity.Warning,
      range,
      message: f.message,
      source: "hypen-a11y",
      code: f.rule,
    };
  });
}
