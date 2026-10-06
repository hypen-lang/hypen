/**
 * Tailwind `.tw("...")` diagnostics for the LSP.
 *
 * Hypen has no CSS positioning model: `absolute` / `relative` / `fixed` /
 * `sticky`, the inset utilities (`top-*`, `inset-*`, …) and `sr-only` only
 * make sense on the web and are a hard error in the engine's Tailwind parser
 * (`tailwind-parse/src/parser.rs`, `forbidden_utility_reason`). This module
 * mirrors that check so the mistake is squiggled while typing, before the
 * engine ever sees the file.
 *
 * Keep the rule set in sync with `forbidden_utility_reason`.
 */

import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver/node";
import { offsetToPosition } from "./parser-utils";

export const TW_POSITIONING_CODE = "tw-positioning";

const POSITION_CLASSES = new Set(["static", "fixed", "absolute", "relative", "sticky"]);
const INSET_PREFIXES = [
  "inset-",
  "inset-x-",
  "inset-y-",
  "top-",
  "right-",
  "bottom-",
  "left-",
  "start-",
  "end-",
];

const STACK_HINT =
  "Overlay children with `Stack { ... }` and place them with " +
  ".horizontalAlignment(...)/.verticalAlignment(...) on the Stack, or margins on the child.";

/**
 * Why a single Tailwind class (variants included, e.g. `md:absolute`,
 * `-top-1`, `!relative`) is forbidden in Hypen — or `null` if it is fine.
 */
export function forbiddenTailwindClassReason(cls: string): string | null {
  // Strip variant prefixes (`md:hover:`), only splitting on ':' outside brackets.
  let depth = 0;
  let start = 0;
  for (let i = 0; i < cls.length; i++) {
    const ch = cls[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) start = i + 1;
  }
  let utility = cls.slice(start);
  if (utility.startsWith("!")) utility = utility.slice(1);
  if (utility.startsWith("-")) utility = utility.slice(1);

  if (POSITION_CLASSES.has(utility)) {
    return `\`${cls}\` is not supported: Hypen has no CSS positioning. ${STACK_HINT}`;
  }
  if (INSET_PREFIXES.some((p) => utility.startsWith(p))) {
    return (
      `\`${cls}\` is not supported: inset utilities require CSS positioning, ` +
      `which Hypen does not have. ${STACK_HINT}`
    );
  }
  if (utility === "sr-only" || utility === "not-sr-only") {
    return (
      `\`${cls}\` is not supported: it relies on absolute positioning. ` +
      "Use the `VisuallyHidden { ... }` component instead."
    );
  }
  return null;
}

// `.tw("...")` / `.tw('...')` — capture the quoted body. Escapes are kept
// verbatim; a class token never contains a quote so that is harmless.
const TW_CALL = /\.tw\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;

/** Error diagnostics for every forbidden class inside a `.tw(...)` string. */
export function tailwindDiagnostics(text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  TW_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TW_CALL.exec(text)) !== null) {
    const body = m[1] ?? m[2] ?? "";
    // Offset of the string body: after `.tw(`, whitespace, and the opening quote.
    const bodyStart = m.index + m[0].length - body.length - 1;

    const tokenRe = /\S+/g;
    let t: RegExpExecArray | null;
    while ((t = tokenRe.exec(body)) !== null) {
      const reason = forbiddenTailwindClassReason(t[0]);
      if (!reason) continue;
      const startOffset = bodyStart + t.index;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: offsetToPosition(text, startOffset),
          end: offsetToPosition(text, startOffset + t[0].length),
        },
        message: reason,
        source: "hypen",
        code: TW_POSITIONING_CODE,
      });
    }
  }
  return diagnostics;
}
