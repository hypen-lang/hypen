/**
 * Inline templates for `hypen check`: single-file components declare their
 * UI in the module itself — `.ui(\`…\`)` or `.ui(hypen\`…\`)` — so the
 * checker extracts those template literals from `.ts` files, runs them
 * through the same engine passes as a `.hypen` file, and maps every
 * reported position back to the `.ts` file.
 *
 * Extraction is textual (the checker never executes a module just to read
 * its template) and conservative about `${…}` interpolations, whose values
 * are only known at runtime:
 *
 * - inside a Hypen string literal (`.color("${ACCENT}")`) the interpolation
 *   becomes a dynamic binding, `@{state.__ts_interpolation}` (or the bare
 *   identifier `__ts_interpolation` when it already sits inside an `@{…}`
 *   expression). Dynamic text is never flagged as a missing name or an
 *   unknown token, and a state path is only judged up to the segment the
 *   placeholder lands in (`@{state.user.${F}}` checks `user` alone), so an
 *   interpolated key is never flagged as an unknown state path;
 * - anywhere else (`Today()${SCREEN}`, a whole `${PAGE}` element) it is
 *   dropped and recorded as a *hole*. Elements whose expression contains a
 *   hole may have lost a label, child or applicator to it, so accessibility
 *   findings on them are skipped (and counted) rather than reported.
 *
 * Templates are cooked like JavaScript would (`\\"` → `"`, `\\n` → newline,
 * …) because the cooked string is what the engine receives at runtime.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/** Placeholder for an interpolation inside a Hypen string literal. */
export const INTERPOLATION_BINDING = "@{state.__ts_interpolation}";
/** Placeholder for an interpolation inside an `@{…}` expression. */
export const INTERPOLATION_IDENT = "__ts_interpolation";

/** One template literal extracted from a `.ts` file. */
export interface InlineTemplate {
  /** The cooked Hypen source handed to the engine. */
  source: string;
  /**
   * `map[k]` is the UTF-16 offset in the `.ts` file of the source's UTF-16
   * code unit `k`; `map[source.length]` is the closing backtick.
   */
  map: number[];
  /** UTF-8 byte offsets in `source` where an interpolation was dropped. */
  holes: number[];
}

/** Whether a file is a candidate for inline-template extraction. */
export function isInlineTemplateCandidate(file: string): boolean {
  return /\.(?:ts|tsx|mts)$/.test(file) && !file.endsWith(".d.ts") && !/\.test\./.test(file);
}

/**
 * Index just past the template literal whose opening backtick precedes
 * `i`, skipping nested `${…}` expressions. `-1` when unterminated.
 */
function skipTemplate(ts: string, i: number): number {
  while (i < ts.length) {
    const c = ts[i];
    if (c === "\\") {
      i += 2;
    } else if (c === "`") {
      return i + 1;
    } else if (c === "$" && ts[i + 1] === "{") {
      const end = skipInterpolation(ts, i + 2);
      if (end < 0) return -1;
      i = end;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Index just past the `}` closing an interpolation whose body starts at `i`
 * (just after `${`). Skips JS strings, nested templates and comments.
 * `-1` when unterminated.
 */
function skipInterpolation(ts: string, i: number): number {
  let depth = 1;
  while (i < ts.length) {
    const c = ts[i];
    if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      depth--;
      i++;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < ts.length && ts[i] !== c && ts[i] !== "\n") i += ts[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "`") {
      const end = skipTemplate(ts, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === "/" && ts[i + 1] === "/") {
      while (i < ts.length && ts[i] !== "\n") i++;
    } else if (c === "/" && ts[i + 1] === "*") {
      const end = ts.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 2;
    } else {
      i++;
    }
  }
  return -1;
}

/** UTF-8 length of the UTF-16 code unit at `i` (surrogate pairs: 2 + 2). */
function utf8Len(s: string, i: number): number {
  const code = s.charCodeAt(i);
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 2;
  return 3;
}

/**
 * Cook the template body starting at `start` (just after the opening
 * backtick). Returns `null` when the literal is unterminated.
 */
function cookTemplate(ts: string, start: number): { template: InlineTemplate; end: number } | null {
  let source = "";
  const map: number[] = [];
  const holes: number[] = [];
  let bytes = 0;
  // Hypen lexical state, tracked over the cooked text.
  let quote: string | null = null;
  let escaped = false;
  let exprDepth = 0; // brace depth inside an `@{…}` within a string
  let lineComment = false;
  let blockComment = false;

  const emit = (text: string, at: number) => {
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      const prev = source[source.length - 1];
      source += ch;
      map.push(at);
      bytes += utf8Len(text, k);
      if (lineComment) {
        if (ch === "\n") lineComment = false;
      } else if (blockComment) {
        if (prev === "*" && ch === "/") blockComment = false;
      } else if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (exprDepth > 0) {
          if (ch === "{") exprDepth++;
          else if (ch === "}") exprDepth--;
        } else if (prev === "@" && ch === "{") exprDepth = 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (prev === "/" && ch === "/") {
        lineComment = true;
      } else if (prev === "/" && ch === "*") {
        blockComment = true;
      }
    }
  };

  let i = start;
  while (i < ts.length) {
    const c = ts[i];
    if (c === "`") {
      map.push(i);
      return { template: { source, map, holes }, end: i + 1 };
    }
    if (c === "\\") {
      const next = ts[i + 1];
      if (next === undefined) return null;
      const simple: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        b: "\b",
        f: "\f",
        v: "\v",
        "0": "\0",
      };
      if (next === "\n") {
        i += 2; // line continuation
      } else if (next === "\r") {
        i += ts[i + 2] === "\n" ? 3 : 2;
      } else if (next in simple) {
        emit(simple[next]!, i);
        i += 2;
      } else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(ts.slice(i + 2, i + 4))) {
        emit(String.fromCharCode(parseInt(ts.slice(i + 2, i + 4), 16)), i);
        i += 4;
      } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(ts.slice(i + 2, i + 6))) {
        emit(String.fromCharCode(parseInt(ts.slice(i + 2, i + 6), 16)), i);
        i += 6;
      } else if (next === "u" && ts[i + 2] === "{") {
        const close = ts.indexOf("}", i + 3);
        const cp = close > 0 ? parseInt(ts.slice(i + 3, close), 16) : NaN;
        if (Number.isNaN(cp)) return null;
        emit(String.fromCodePoint(cp), i);
        i = close + 1;
      } else {
        emit(next, i);
        i += 2;
      }
      continue;
    }
    if (c === "$" && ts[i + 1] === "{") {
      const end = skipInterpolation(ts, i + 2);
      if (end < 0) return null;
      if (quote && !lineComment && !blockComment) {
        emit(exprDepth > 0 ? INTERPOLATION_IDENT : INTERPOLATION_BINDING, i);
      } else if (lineComment || blockComment) {
        emit(" ", i);
      } else {
        holes.push(bytes);
        emit(" ", i); // keep neighbouring tokens apart
      }
      i = end;
      continue;
    }
    emit(c!, i);
    i++;
  }
  return null;
}

/**
 * Extract every `.ui(\`…\`)` / `.ui(hypen\`…\`)` template literal from a
 * TypeScript source. A literal that is not the whole argument (e.g.
 * concatenated: `.ui(\`…\` + x)`), sits on a commented-out line, or is
 * unterminated is skipped.
 */
export function extractInlineTemplates(ts: string): InlineTemplate[] {
  const out: InlineTemplate[] = [];
  const re = /\.ui\(\s*(?:hypen\s*)?`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ts)) !== null) {
    const lineStart = ts.lastIndexOf("\n", m.index) + 1;
    const prefix = ts.slice(lineStart, m.index).trimStart();
    if (prefix.startsWith("//") || prefix.startsWith("*") || prefix.startsWith("/*")) continue;
    const cooked = cookTemplate(ts, re.lastIndex);
    if (!cooked) continue;
    re.lastIndex = cooked.end;
    const after = ts.slice(cooked.end).match(/^\s*(.)/s)?.[1];
    if (after !== ")" && after !== ",") continue;
    out.push(cooked.template);
  }
  return out;
}

/** Read a file's inline templates (empty when unreadable or none). */
export function readInlineTemplates(file: string): InlineTemplate[] {
  try {
    return extractInlineTemplates(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

/**
 * Recursively collect `.ts` files under `root` that declare at least one
 * inline `.ui(\`…\`)` template. Same skip list and ordering as
 * `findHypenFiles`.
 */
export function findInlineTemplateFiles(root: string): string[] {
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
      } else if (entry.isFile() && isInlineTemplateCandidate(entry.name)) {
        if (readInlineTemplates(full).length > 0) out.push(full);
      }
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root);
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// Position mapping
// ---------------------------------------------------------------------------

/** UTF-16 index in `s` of a UTF-8 byte offset (clamped). */
export function byteToIndex(s: string, byte: number): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    if (bytes >= byte) return i;
    const len = utf8Len(s, i);
    bytes += len;
  }
  return s.length;
}

/** UTF-16 index in `s` of a 1-based line / codepoint column. */
export function lineColToIndex(s: string, line: number, col: number): number {
  let i = 0;
  for (let l = 1; l < line; l++) {
    const nl = s.indexOf("\n", i);
    if (nl < 0) return s.length;
    i = nl + 1;
  }
  for (let c = 1; c < col && i < s.length && s[i] !== "\n"; c++) {
    const code = s.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
  }
  return i;
}

/** 1-based line / codepoint column of a UTF-16 index in `s`. */
export function indexToLineCol(s: string, index: number): { line: number; col: number } {
  const before = s.slice(0, Math.max(0, Math.min(index, s.length)));
  const lines = before.split("\n");
  return { line: lines.length, col: [...lines[lines.length - 1]!].length + 1 };
}

/**
 * Map a location reported against `template.source` (a byte span start,
 * else `line`/`col`) to a 1-based line/column in the `.ts` file `ts`.
 * `undefined` when the finding carries no location.
 */
export function mapToTs(
  ts: string,
  template: InlineTemplate,
  loc: { span?: { start: number } | null; line?: number; col?: number },
): { line: number; col: number } | undefined {
  let index: number;
  if (loc.span && typeof loc.span.start === "number") {
    index = byteToIndex(template.source, loc.span.start);
  } else if (loc.line !== undefined && loc.col !== undefined) {
    index = lineColToIndex(template.source, loc.line, loc.col);
  } else {
    return undefined;
  }
  return indexToLineCol(ts, template.map[Math.min(index, template.map.length - 1)]!);
}

/**
 * Whether a dropped interpolation lies within a byte span of the template
 * (the element's full expression): its content is unknown there.
 */
export function spanHasHole(
  template: InlineTemplate,
  span: { start: number; end: number } | null | undefined,
): boolean {
  if (!span) return false;
  return template.holes.some((h) => h >= span.start && h <= span.end);
}

/**
 * Format an engine parse error for an inline template as
 * `file:line:col: parse error: …` plus a code frame from the `.ts` file.
 * `null` when the error carries no position the caller can map.
 */
export function formatInlineParseError(
  display: string,
  ts: string,
  template: InlineTemplate,
  errors: { message: string; byteOffset: number }[],
): string[] {
  const lines = ts.split("\n");
  const out: string[] = [];
  for (const e of errors) {
    const index = byteToIndex(template.source, e.byteOffset);
    const { line, col } = indexToLineCol(ts, template.map[Math.min(index, template.map.length - 1)]!);
    const width = String(Math.min(line + 1, lines.length)).length;
    out.push(`${display}:${line}:${col}: parse error (inline template): ${e.message}`);
    for (let n = Math.max(1, line - 1); n <= Math.min(lines.length, line + 1); n++) {
      const marker = n === line ? ">" : " ";
      out.push(`  ${marker} ${String(n).padStart(width)} | ${lines[n - 1]}`);
      if (n === line) {
        const pad = [...(lines[n - 1] ?? "")]
          .slice(0, col - 1)
          .map((ch) => (ch === "\t" ? "\t" : " "))
          .join("");
        out.push(`    ${" ".repeat(width)} | ${pad}^`);
      }
    }
  }
  return out;
}
