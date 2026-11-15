/**
 * `@theme.*` diagnostics for the LSP.
 *
 * A project's design tokens live in its theme file — the JSON form of
 * `createTheme`'s options (`{ "tokens": {…}, "schemes": { "dark": {…} } }`),
 * found at hypen.json's `"theme"` path or `theme.json` beside it. This module
 * squiggles `@theme.color.primry` while typing, mirroring `hypen check`'s
 * `unknown-theme-token` rule (`hypen-cli/src/check-template.ts`).
 *
 * Tokens are resolved the way `createTheme` does it — scheme overrides
 * merged over the base set, then `"{color.brand}"` aliases followed — so a
 * path through an alias to a group is judged against the group it points at.
 * An alias that cannot be resolved (missing target, cycle) is left as
 * written and anything at or below it is accepted: `hypen check` reports the
 * broken alias itself.
 */

import * as fs from "fs";
import * as path from "path";
import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver/node";
import { offsetToPosition } from "./parser-utils";

export const UNKNOWN_THEME_TOKEN_CODE = "unknown-theme-token";
const CHECK_IGNORE = "hypen-check-ignore";

type Tokens = { [key: string]: unknown };

export interface LspTheme {
  /** Resolved tokens for every scheme an app can be in. */
  schemes: Array<{ scheme: string; tokens: Tokens }>;
}

function isPlainObject(v: unknown): v is Tokens {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge(base: Tokens, over: Tokens | undefined): Tokens {
  if (!over) return base;
  const out: Tokens = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) ? merge(isPlainObject(out[k]) ? (out[k] as Tokens) : {}, v) : v;
  }
  return out;
}

/** Build the per-scheme token sets from parsed theme-file JSON, or `null` if it is not one. */
export function themeFromJson(json: unknown): LspTheme | null {
  if (!isPlainObject(json)) return null;
  const tokens = json.tokens ?? {};
  const schemes = json.schemes ?? {};
  if (!isPlainObject(tokens) || !isPlainObject(schemes)) return null;
  const names = Array.from(new Set(["light", "dark", ...Object.keys(schemes)]));
  return {
    schemes: names.map((scheme) => ({
      scheme,
      tokens: resolveAliases(
        merge(tokens, isPlainObject(schemes[scheme]) ? (schemes[scheme] as Tokens) : undefined),
      ),
    })),
  };
}

const ALIAS = /^\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}$/;
const MAX_ALIAS_DEPTH = 32;

function lookup(tokens: Tokens, segments: string[]): unknown {
  let cur: unknown = tokens;
  for (const seg of segments) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur ?? undefined;
}

/**
 * Copy of `tokens` with every resolvable alias replaced by its target (same
 * rules as `resolveTokenAliases` in `@hypen-space/core`); unresolvable ones
 * stay as written.
 */
function resolveAliases(tokens: Tokens): Tokens {
  const follow = (value: unknown, at: string): unknown => {
    const seen = [at];
    let cur = value;
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
      const match = typeof cur === "string" ? ALIAS.exec(cur) : null;
      if (!match) return cur;
      const target = match[1];
      if (seen.includes(target) || at.startsWith(`${target}.`)) return value;
      const next = lookup(tokens, target.split("."));
      if (next === undefined) return value;
      seen.push(target);
      cur = next;
    }
    return value;
  };
  const walk = (group: Tokens, prefix: string, depth: number): Tokens => {
    const out: Tokens = {};
    for (const [k, v] of Object.entries(group)) {
      const at = prefix ? `${prefix}.${k}` : k;
      const resolved = isPlainObject(v) ? v : follow(v, at);
      out[k] = isPlainObject(resolved) && depth < MAX_ALIAS_DEPTH ? walk(resolved, at, depth + 1) : resolved;
    }
    return out;
  };
  return walk(tokens, "", 0);
}

/** Whether `segments` resolves in `tokens`; anything at or below an unresolved alias counts as defined. */
function defined(tokens: Tokens, segments: string[]): boolean {
  let cur: unknown = tokens;
  for (const seg of segments) {
    if (typeof cur === "string" && ALIAS.test(cur)) return true;
    if (!isPlainObject(cur)) return false;
    cur = cur[seg];
  }
  return cur !== undefined && cur !== null;
}

// ---------------------------------------------------------------------------
// Theme file discovery (cached by mtime)
// ---------------------------------------------------------------------------

const cache = new Map<string, { mtimeMs: number; theme: LspTheme | null }>();

function readTheme(file: string): LspTheme | null {
  try {
    const { mtimeMs } = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.theme;
    let theme: LspTheme | null = null;
    try {
      theme = themeFromJson(JSON.parse(fs.readFileSync(file, "utf-8")));
    } catch {
      // Mid-edit or invalid JSON: no verdicts until it parses again.
    }
    cache.set(file, { mtimeMs, theme });
    return theme;
  } catch {
    return null;
  }
}

/**
 * The theme governing a `.hypen` file: walk up from its directory to the
 * first one holding `hypen.json` (its `"theme"` path, else `theme.json`
 * beside it) or a bare `theme.json`. `null` when there is none.
 */
export function findTheme(documentPath: string): LspTheme | null {
  let dir = path.dirname(documentPath);
  for (let i = 0; i < 32; i++) {
    const config = path.join(dir, "hypen.json");
    if (fs.existsSync(config)) {
      let configured: unknown;
      try {
        configured = JSON.parse(fs.readFileSync(config, "utf-8"))?.theme;
      } catch {
        // Unreadable config: fall back to the default name.
      }
      const file = path.resolve(dir, typeof configured === "string" && configured ? configured : "theme.json");
      return fs.existsSync(file) ? readTheme(file) : null;
    }
    const bare = path.join(dir, "theme.json");
    if (fs.existsSync(bare)) return readTheme(bare);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function ignored(lines: string[], line: number): boolean {
  const directive = (text: string): boolean => {
    const at = text.indexOf(`// ${CHECK_IGNORE}`);
    if (at < 0) return false;
    const rules = text.slice(at + CHECK_IGNORE.length + 3).trim();
    return rules === "" || rules.split(/[\s,]+/).includes(UNKNOWN_THEME_TOKEN_CODE);
  };
  if (directive(lines[line] ?? "")) return true;
  const prev = line > 0 ? lines[line - 1] : "";
  return prev.trimStart().startsWith("//") && directive(prev);
}

/**
 * Squiggle every `@theme.a.b` reference (and `theme.a.b` inside an `@{…}`
 * expression) that the theme file does not define, or defines only for some
 * schemes. Comments are skipped; `// hypen-check-ignore` is honoured.
 */
export function themeDiagnostics(text: string, theme: LspTheme | null): Diagnostic[] {
  if (!theme) return [];
  const diagnostics: Diagnostic[] = [];
  const lines = text.split("\n");
  let offset = 0;
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line];
    const comment = raw.indexOf("//");
    const code = comment >= 0 ? raw.slice(0, comment) : raw;

    const refs: Array<{ start: number; end: number; path: string }> = [];
    // Direct references: `@theme.color.primary`.
    for (const m of code.matchAll(/@theme\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g)) {
      refs.push({ start: m.index!, end: m.index! + m[0].length, path: m[1] });
    }
    // Inside expressions: `@{ … theme.color.primary … }`.
    for (const expr of code.matchAll(/@\{([^}]*)\}/g)) {
      const base = expr.index! + 2;
      for (const m of expr[1].matchAll(/(?<![A-Za-z0-9_.'"])theme\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g)) {
        refs.push({ start: base + m.index!, end: base + m.index! + m[0].length, path: m[1] });
      }
    }

    for (const ref of refs) {
      const segments = ref.path.split(".");
      const missingIn = theme.schemes.filter((s) => !defined(s.tokens, segments)).map((s) => s.scheme);
      if (missingIn.length === 0 || ignored(lines, line)) continue;
      const everywhere = missingIn.length === theme.schemes.length;
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: {
          start: offsetToPosition(text, offset + ref.start),
          end: offsetToPosition(text, offset + ref.end),
        },
        message: everywhere
          ? `theme.${ref.path} is not defined in the theme file — it renders as empty`
          : `theme.${ref.path} is not defined for ${missingIn.join(", ")} — give it a base value in "tokens"`,
        source: "hypen-check",
        code: UNKNOWN_THEME_TOKEN_CODE,
      });
    }
    offset += raw.length + 1;
  }
  return diagnostics;
}
