/**
 * Readable diagnostics for the dev loop (`hypen dev`, `hypen test`,
 * `hypen run`) and `hypen check`.
 *
 * - `.hypen` parse errors come out of the engine as
 *   `{ type: "parseError", message: "unexpected '{' at position 12" }`,
 *   where the position is a UTF-8 byte offset. These helpers turn that into
 *   `file:line:col` plus a code frame.
 * - A component `.ts` that fails to compile surfaces as Bun's
 *   `AggregateError("3 errors building …")`, whose message hides the actual
 *   errors; {@link formatReloadError} lists them with their locations.
 * - {@link createHypenSourceValidator} parses every `.hypen` file in the
 *   components directory so the dev servers can refuse to hot-reload a
 *   broken template: connected clients keep the last good version instead
 *   of reconnecting into a blank page.
 */

import { readFileSync } from "fs";
import { relative, resolve } from "path";
import { findHypenFiles } from "./check.js";

export interface SourceLocation {
  line: number;
  col: number;
}

/** 1-based line/column (column in characters) of a UTF-8 byte offset. */
export function byteOffsetToLineCol(source: string, byteOffset: number): SourceLocation {
  const bytes = Buffer.from(source, "utf-8");
  const clamped = Math.max(0, Math.min(byteOffset, bytes.length));
  const before = bytes.subarray(0, clamped).toString("utf-8");
  const lines = before.split("\n");
  return { line: lines.length, col: [...lines[lines.length - 1]!].length + 1 };
}

/** The message of an engine error (plain object, Error, or string). */
export function engineErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Format an engine parse error for `display` (the file's path as shown to
 * the user): `file:line:col: message` followed by a short code frame. Falls
 * back to `file: message` when the error carries no position.
 */
export function formatHypenParseError(display: string, source: string, err: unknown): string[] {
  const message = engineErrorMessage(err);
  const m = /^(.*) at position (\d+)$/s.exec(message);
  if (!m) return [`${display}: ${message}`];
  const { line, col } = byteOffsetToLineCol(source, Number(m[2]));
  const lines = source.split("\n");
  const width = String(Math.min(line + 1, lines.length)).length;
  const frame: string[] = [];
  for (let n = Math.max(1, line - 1); n <= Math.min(lines.length, line + 1); n++) {
    const marker = n === line ? ">" : " ";
    frame.push(`  ${marker} ${String(n).padStart(width)} | ${lines[n - 1]}`);
    if (n === line) frame.push(`    ${" ".repeat(width)} | ${" ".repeat(col - 1)}^`);
  }
  return [`${display}:${line}:${col}: parse error: ${m[1]}`, ...frame];
}

/**
 * Lines describing a failed hot reload. Bun reports a component `.ts` that
 * doesn't compile as an AggregateError whose message is only a count; list
 * each build message with its location instead.
 */
export function formatReloadError(err: unknown, projectRoot = process.cwd()): string[] {
  const e = err as { message?: string; errors?: unknown[] } | null;
  const items = Array.isArray(e?.errors) ? e!.errors : [];
  if (items.length === 0) return [String(e?.message ?? err)];
  const out = [String(e?.message ?? "Build failed")];
  for (const item of items.slice(0, 10)) {
    const it = item as {
      message?: string;
      position?: { file?: string; line?: number; column?: number; lineText?: string } | null;
    };
    const pos = it.position;
    const text = it.message ?? String(item);
    if (pos?.file) {
      const rel = relative(projectRoot, pos.file);
      const file = !rel || rel.startsWith("..") ? pos.file : rel;
      out.push(`  ${file}:${pos.line ?? 0}:${pos.column ?? 0}: ${text}`);
      if (pos.lineText) out.push(`      ${pos.lineText.trim()}`);
    } else {
      out.push(`  ${text}`);
    }
  }
  if (items.length > 10) out.push(`  ... and ${items.length - 10} more`);
  return out;
}

type ParseFn = (source: string) => void;

/**
 * Build a validator for the `.hypen` sources under `componentsDir`. It
 * returns the formatted parse errors (empty when every file parses). The
 * engine boots lazily on first use; when no parser is available the
 * validator reports nothing rather than blocking reloads.
 */
export function createHypenSourceValidator(opts: {
  componentsDir: string;
  projectRoot?: string;
  /** Override the parser (tests). Throws on a parse error. */
  parse?: ParseFn;
  /** Load the engine package (defaults to the project's @hypen-space/server). */
  loadServer?: () => Promise<any>;
}): () => Promise<string[]> {
  const componentsDir = resolve(opts.componentsDir);
  const projectRoot = resolve(opts.projectRoot ?? ".");
  let parse: ParseFn | null | undefined = opts.parse;

  const ensureParser = async (): Promise<ParseFn | null> => {
    if (parse !== undefined) return parse;
    try {
      const server = await (opts.loadServer ?? (() => import("@hypen-space/server")))();
      const engine = new server.Engine();
      await engine.init();
      const wasm = (engine as any).wasmEngine;
      if (typeof wasm?.checkAccessibility === "function") {
        parse = (src) => void wasm.checkAccessibility(src);
      } else if (typeof wasm?.debugParseComponent === "function") {
        parse = (src) => void wasm.debugParseComponent(src);
      } else {
        parse = null;
      }
    } catch {
      parse = null;
    }
    return parse;
  };

  return async () => {
    const p = await ensureParser();
    if (!p) return [];
    const problems: string[] = [];
    for (const file of findHypenFiles(componentsDir)) {
      let source: string;
      try {
        source = readFileSync(file, "utf-8");
      } catch {
        continue; // deleted mid-scan
      }
      try {
        p(source);
      } catch (err) {
        // Only parse errors block a reload; anything else the checker
        // throws is not this validator's business.
        const isParseError =
          (err as { type?: string } | null)?.type === "parseError" ||
          /at position \d+$/.test(engineErrorMessage(err));
        if (isParseError) {
          const rel = relative(projectRoot, file);
          problems.push(...formatHypenParseError(!rel || rel.startsWith("..") ? file : rel, source, err));
        }
      }
    }
    return problems;
  };
}
