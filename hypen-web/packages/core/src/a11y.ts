/**
 * Accessibility conformance diagnostics — host-side surfacing.
 *
 * The engine's dev-mode conformance pass (`checkAccessibility(source)` on the
 * WASM engine, wired through the package `Engine` wrappers) returns findings
 * as `A11yDiagnostic[]`. This module provides a small, pure helper for
 * surfacing those findings in a dev console.
 */

/**
 * Byte range `[start, end)` of an element's name token in its source string.
 * Mirrors the Rust `SourceSpan` serialization.
 */
export interface A11ySourceSpan {
  start: number;
  end: number;
}

/**
 * A single accessibility conformance finding produced by the engine.
 *
 * Shape mirrors the Rust located-diagnostic serialization
 * (`{ rule, elementType, message, span?, line?, col? }`). The location
 * fields are present when the engine binding ships span support and the
 * finding maps to a source element; older bindings omit them.
 */
export interface A11yDiagnostic {
  /** Kebab-case rule identifier (e.g. `"icon-only-control"`). */
  rule: string;
  /** The element type the finding applies to (e.g. `"Button"`). */
  elementType: string;
  /** Human-readable description of the gap. */
  message: string;
  /** Byte span of the offending element's name token in the source. */
  span?: A11ySourceSpan;
  /** 1-based source line of the finding. */
  line?: number;
  /** 1-based column in Unicode codepoints (human/CLI convention). */
  col?: number;
}

/**
 * `console.warn` each accessibility finding as
 * `a11y[<rule>] <elementType>: <message>`.
 *
 * Pure with respect to its input (it mutates nothing and returns the
 * formatted lines), so it is unit-testable: the returned array is exactly
 * what was warned, in order. A `console`-less environment is tolerated — the
 * lines are still returned.
 */
export function logA11yDiagnostics(diags: A11yDiagnostic[]): string[] {
  const lines = diags.map(
    (d) => `a11y[${d.rule}] ${d.elementType}: ${d.message}`,
  );
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    for (const line of lines) {
      console.warn(line);
    }
  }
  return lines;
}

/**
 * Kebab-case ids of every accessibility rule this SDK version expects the
 * engine's conformance pass to implement. Mirrors the engine's `A11yRule`
 * enum via `ALL_RULES` in `hypen-engine-rs/src/ir/conformance.rs` (the Rust
 * side pins these exact strings in a unit test).
 *
 * Used for rule-set drift detection: a prebuilt WASM that predates a rule
 * still exposes `checkAccessibility` and looks current while silently never
 * firing the newer rule.
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

/** Result of {@link checkRuleDrift}. */
export interface A11yRuleDrift {
  /**
   * Whether the binding exposes `a11yRules()` at all. `false` means the
   * build predates rule-list stamping entirely (every expected rule is
   * reported missing).
   */
  hasRuleList: boolean;
  /** Expected rule ids the binding does not implement; empty means no drift. */
  missing: string[];
}

/**
 * Compare an engine binding's advertised accessibility rules against
 * {@link EXPECTED_A11Y_RULES}. `engine` is anything exposing the WASM
 * binding surface (a raw `WasmEngine` or a wrapper forwarding `a11yRules`).
 *
 * Drift is a warning, not a failure: findings from the rules the binding
 * does implement remain valid, so callers should surface the missing rules
 * and continue rather than abort the check.
 */
export function checkRuleDrift(
  engine: { a11yRules?: () => string[] } | null | undefined,
): A11yRuleDrift {
  if (typeof engine?.a11yRules !== "function") {
    return { hasRuleList: false, missing: [...EXPECTED_A11Y_RULES] };
  }
  let advertised: string[];
  try {
    advertised = engine.a11yRules();
  } catch {
    return { hasRuleList: false, missing: [...EXPECTED_A11Y_RULES] };
  }
  const have = new Set(advertised);
  return {
    hasRuleList: true,
    missing: EXPECTED_A11Y_RULES.filter((rule) => !have.has(rule)),
  };
}
