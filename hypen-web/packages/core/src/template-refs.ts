/**
 * Template reference facts — host-side types for the engine's
 * `templateRefs(source)` binding (`hypen-engine-rs/src/ir/refs.rs`).
 *
 * The engine parses a DSL source and reports every reference it makes
 * (state paths, actions, row/item references, data-source references,
 * component names), each located at `line:col`. It reports facts only:
 * whether a state path or action exists depends on the module, which the
 * host loads (`hypen check` does this in `hypen-cli/src/check-template.ts`).
 */

import type { A11ySourceSpan } from "./a11y.js";

/** What a {@link TemplateRef} refers to. */
export type TemplateRefKind = "state" | "action" | "item" | "dataSource" | "component";

/** One located reference made by a template. Mirrors Rust `TemplateRef`. */
export interface TemplateRef {
  kind: TemplateRefKind;
  /**
   * `state`: the state path (`user.name`); `action`: the action name;
   * `item`: the reference as written (`item.title`, `todo.done`);
   * `dataSource`: `provider.path`; `component`: the element type.
   */
  name: string;
  /** Path segments under the root (state/item/dataSource). */
  path: string[];
  /** `item`: the row name; `dataSource`: the provider. */
  root?: string;
  /** Whether any ForEach/List/Grid encloses the reference in this source. */
  inLoop: boolean;
  /** `item` only: whether an enclosing loop supplies this row name. */
  inScope?: boolean;
  /** `component` only: handled natively by the engine/renderers. */
  builtin?: boolean;
  /** `action` only: a framework namespace (`router.*`, `__*`, `hypen.*`). */
  reserved?: boolean;
  /** Extracted from an `@{…}` expression rather than a direct reference. */
  fromExpression: boolean;
  /** Module scope of the carrying node (`module X { … }` in this source). */
  moduleScope?: string;
  /** The element the reference hangs off. */
  elementType: string;
  span?: A11ySourceSpan;
  /** 1-based line, when located. */
  line?: number;
  /** 1-based column in Unicode codepoints, when located. */
  col?: number;
  /** A bare `// hypen-check-ignore` applies: every rule is suppressed. */
  ignoreAll?: boolean;
  /** Rule ids a rule-scoped `// hypen-check-ignore` suppresses. */
  ignoreRules?: string[];
}

/** A finding the engine decides on its own (e.g. `unknown-ignore-rule`). */
export interface TemplateCheckDiagnostic {
  rule: string;
  elementType: string;
  message: string;
  span?: A11ySourceSpan;
  line?: number;
  col?: number;
  suppressed?: boolean;
}

/** Result of `templateRefs(source)`. */
export interface TemplateRefsReport {
  refs: TemplateRef[];
  diagnostics: TemplateCheckDiagnostic[];
  /** Names declared with `module X { … }` / `component X { … }`. */
  declaredComponents: string[];
  /** Names brought in by `import` statements. */
  importedComponents: string[];
}

/**
 * Kebab-case ids of every template check rule this SDK version expects the
 * engine to know (Rust `ir::refs::ALL_CHECK_RULES`, pinned by a unit test).
 * Compare against the binding's `templateCheckRules()` for drift detection.
 */
export const EXPECTED_TEMPLATE_CHECK_RULES: readonly string[] = [
  "unknown-state-path",
  "unknown-action",
  "unknown-component",
  "item-outside-loop",
  "unknown-ignore-rule",
];
