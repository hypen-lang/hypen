/**
 * The project's theme file: loading, token resolution, and export.
 *
 * A theme file is the JSON form of `createTheme(...)`'s options:
 *
 *   { "tokens": { … }, "schemes": { "dark": { … } }, "scheme": "system" }
 *
 * It is found at hypen.json's `"theme"` path, or `theme.json` in the project
 * root. The app passes the same file to `createTheme`, so it is the one
 * source of truth for three consumers:
 *
 *   - the runtime (`createTheme(themeJson)`),
 *   - `hypen check` (`unknown-theme-token`: `@theme.*` references and alias
 *     targets are validated against it, per scheme),
 *   - `hypen theme export` (CSS custom properties, Android resources, an
 *     Xcode asset catalog).
 *
 * Resolution here (scheme merge, then `"{path}"` aliases) is the same
 * algorithm as `Theme` in `@hypen-space/core`, pinned by the shared fixture
 * `engine-compatibility-tests/fixtures/theme/resolve.json`. It is carried
 * locally, like the check rule lists, because the core a project has
 * installed can predate the theme API.
 */

import { existsSync, readFileSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";

export type TokenValue = string | number | boolean;
export interface Tokens {
  [key: string]: TokenValue | Tokens;
}

export interface ThemeFile {
  tokens: Tokens;
  schemes: Record<string, Tokens>;
  scheme?: string;
}

export type ThemeFileStatus =
  | { kind: "none" }
  | { kind: "failed"; file: string; reason: string }
  | { kind: "loaded"; file: string; theme: ThemeFile };

/** Default theme file name, looked up in the project root. */
export const DEFAULT_THEME_FILE = "theme.json";

const REFERENCEABLE_KEY = /^[A-Za-z0-9_]+$/;
const ALIAS = /^\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}$/;
const MAX_ALIAS_DEPTH = 32;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function tokenShapeProblem(value: unknown, at: string): string | null {
  if (!isPlainObject(value)) return `${at} must be an object of tokens`;
  for (const [k, v] of Object.entries(value)) {
    const here = `${at}.${k}`;
    if (isPlainObject(v)) {
      const nested = tokenShapeProblem(v, here);
      if (nested) return nested;
    } else if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      return `${here} must be a string, number, boolean or a group of tokens`;
    }
  }
  return null;
}

/** Validate parsed JSON as a theme file; a string result is the problem. */
export function parseThemeFile(json: unknown): ThemeFile | string {
  if (!isPlainObject(json)) return "the theme file must be a JSON object";
  const tokens = json.tokens ?? {};
  const schemes = json.schemes ?? {};
  const problem = tokenShapeProblem(tokens, "tokens");
  if (problem) return problem;
  if (!isPlainObject(schemes)) return "schemes must be an object of scheme name → tokens";
  for (const [name, overrides] of Object.entries(schemes)) {
    if (name === "system") return `schemes.system: "system" is reserved for the preference`;
    const p = tokenShapeProblem(overrides, `schemes.${name}`);
    if (p) return p;
  }
  if (json.scheme !== undefined && typeof json.scheme !== "string") {
    return "scheme must be a string";
  }
  return {
    tokens: tokens as Tokens,
    schemes: schemes as Record<string, Tokens>,
    ...(typeof json.scheme === "string" ? { scheme: json.scheme } : {}),
  };
}

/**
 * Load the project's theme file. `configured` is hypen.json's `"theme"`;
 * without it, `theme.json` in the project root is used when present. A
 * configured file that is missing is a failure, not "no theme".
 */
export function loadThemeFile(projectRoot: string, configured?: string): ThemeFileStatus {
  const path = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(projectRoot, configured)
    : join(projectRoot, DEFAULT_THEME_FILE);
  const rel = relative(projectRoot, path);
  const file = !rel || rel.startsWith("..") ? path : rel;
  if (!existsSync(path)) {
    return configured
      ? { kind: "failed", file, reason: `hypen.json "theme" points at a file that does not exist` }
      : { kind: "none" };
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return { kind: "failed", file, reason: `not valid JSON (${(e as Error).message})` };
  }
  const parsed = parseThemeFile(json);
  return typeof parsed === "string"
    ? { kind: "failed", file, reason: parsed }
    : { kind: "loaded", file, theme: parsed };
}

// ---------------------------------------------------------------------------
// Resolution (mirrors `Theme` in @hypen-space/core)
// ---------------------------------------------------------------------------

function mergeTokens(fallback: Tokens | undefined, primary: Tokens | undefined): Tokens {
  const out: Tokens = {};
  for (const src of [fallback, primary]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      const existing = out[k];
      out[k] = isPlainObject(v)
        ? mergeTokens(isPlainObject(existing) ? (existing as Tokens) : undefined, v as Tokens)
        : v;
    }
  }
  return out;
}

export function lookupToken(tokens: Tokens, path: readonly string[]): TokenValue | Tokens | undefined {
  let cur: unknown = tokens;
  for (const seg of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return (cur ?? undefined) as TokenValue | Tokens | undefined;
}

function resolveAliases(tokens: Tokens, report: (problem: string) => void): Tokens {
  const follow = (value: TokenValue, at: string): TokenValue | Tokens => {
    const seen = [at];
    let cur: TokenValue | Tokens = value;
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
      const match = typeof cur === "string" ? ALIAS.exec(cur) : null;
      if (!match) return cur;
      const target = match[1]!;
      if (seen.includes(target) || at.startsWith(`${target}.`)) {
        report(`Token alias cycle: ${[...seen, target].join(" -> ")}`);
        return value;
      }
      const next = lookupToken(tokens, target.split("."));
      if (next === undefined) {
        report(`Token "${at}" aliases "${target}", which is not defined`);
        return value;
      }
      seen.push(target);
      cur = next;
    }
    report(`Token "${at}" has an alias chain longer than ${MAX_ALIAS_DEPTH}`);
    return value;
  };
  const walk = (group: Tokens, prefix: string, depth: number): Tokens => {
    const out: Tokens = {};
    for (const [k, v] of Object.entries(group)) {
      const at = prefix ? `${prefix}.${k}` : k;
      const resolved = isPlainObject(v) ? (v as Tokens) : follow(v as TokenValue, at);
      out[k] =
        isPlainObject(resolved) && depth < MAX_ALIAS_DEPTH
          ? walk(resolved as Tokens, at, depth + 1)
          : resolved;
    }
    return out;
  };
  return walk(tokens, "", 0);
}

/** One scheme's fully resolved tokens. */
export interface ResolvedScheme {
  scheme: string;
  tokens: Tokens;
  /** Alias problems (missing target, cycle) in this scheme. */
  problems: string[];
}

/** Tokens as `createTheme` would publish them while `scheme` is in effect. */
export function resolveScheme(theme: ThemeFile, scheme: string): ResolvedScheme {
  const overrides = theme.schemes[scheme];
  const merged = overrides ? mergeTokens(theme.tokens, overrides) : theme.tokens;
  const problems: string[] = [];
  return { scheme, tokens: resolveAliases(merged, (p) => problems.push(p)), problems };
}

/**
 * Every scheme an app can end up in: `light` and `dark` (what `"system"`
 * resolves to) plus each scheme the file defines.
 */
export function resolveAllSchemes(theme: ThemeFile): ResolvedScheme[] {
  const names = Array.from(new Set(["light", "dark", ...Object.keys(theme.schemes)]));
  return names.map((name) => resolveScheme(theme, name));
}

/** Token keys that no template reference can address. */
export function unreferenceableKeys(theme: ThemeFile): string[] {
  const out = new Set<string>();
  const walk = (tokens: Tokens, prefix: string) => {
    for (const [k, v] of Object.entries(tokens)) {
      const at = prefix ? `${prefix}.${k}` : k;
      if (!REFERENCEABLE_KEY.test(k)) out.add(at);
      if (isPlainObject(v)) walk(v as Tokens, at);
    }
  };
  walk(theme.tokens, "");
  for (const overrides of Object.values(theme.schemes)) walk(overrides, "");
  return [...out];
}

/**
 * Verdict on a `@theme.<path>` reference: `"ok"` when it resolves in every
 * scheme, otherwise the schemes where it does and does not.
 */
export function classifyThemeToken(
  schemes: readonly ResolvedScheme[],
  path: readonly string[],
): "ok" | { missingIn: string[]; definedIn: string[] } {
  const missingIn: string[] = [];
  const definedIn: string[] = [];
  for (const s of schemes) {
    (lookupToken(s.tokens, path) === undefined ? missingIn : definedIn).push(s.scheme);
  }
  return missingIn.length === 0 ? "ok" : { missingIn, definedIn };
}

/** The defined token path closest to `path` (for "did you mean"), if any is close. */
export function nearestToken(schemes: readonly ResolvedScheme[], path: readonly string[]): string | null {
  const wanted = path.join(".");
  const known = new Set<string>();
  for (const s of schemes) for (const p of Object.keys(flattenTokens(s.tokens))) known.add(p);
  let best: string | null = null;
  let bestDistance = Math.max(2, Math.floor(wanted.length / 4)) + 1;
  for (const candidate of known) {
    const d = editDistance(wanted, candidate, bestDistance);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) >= cap) return cap;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** Leaves only: `{ "color.primary": "#06f", … }`. */
export function flattenTokens(tokens: Tokens, prefix = "", out: Record<string, TokenValue> = {}): Record<string, TokenValue> {
  for (const [k, v] of Object.entries(tokens)) {
    const at = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flattenTokens(v as Tokens, at, out);
    else out[at] = v as TokenValue;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportFormat = "css" | "android" | "ios";
export const EXPORT_FORMATS: readonly ExportFormat[] = ["css", "android", "ios"];

export interface ExportResult {
  /** Path relative to the output directory → file contents. */
  files: Record<string, string>;
  /** Things the format could not carry, for the command to print. */
  notes: string[];
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; anything else is not a color here. */
export function parseHexColor(value: unknown): Rgba | null {
  if (typeof value !== "string") return null;
  const m = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value.trim());
  if (!m) return null;
  let hex = m[1]!;
  if (hex.length <= 4) hex = hex.replace(/./g, (c) => c + c);
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 255 };
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "\\'");

/** Leaves of `scheme` that differ from `base` (or are absent from it). */
function changedLeaves(base: Record<string, TokenValue>, scheme: Record<string, TokenValue>) {
  const out: Record<string, TokenValue> = {};
  for (const [k, v] of Object.entries(scheme)) if (base[k] !== v) out[k] = v;
  return out;
}

/**
 * CSS custom properties: `:root` holds the light scheme; each other scheme
 * overrides what differs under `[data-hypen-scheme="<name>"]` (the attribute
 * the DOM renderer sets on the render root), and `dark` also applies through
 * `prefers-color-scheme` when no scheme attribute is present.
 */
export function exportCss(theme: ThemeFile): ExportResult {
  const schemes = resolveAllSchemes(theme);
  const light = flattenTokens(schemes.find((s) => s.scheme === "light")!.tokens);
  const name = (path: string) => `--${path.replace(/\./g, "-")}`;
  const block = (selector: string, leaves: Record<string, TokenValue>, indent = "") =>
    `${indent}${selector} {\n` +
    Object.entries(leaves)
      .map(([k, v]) => `${indent}  ${name(k)}: ${String(v)};\n`)
      .join("") +
    `${indent}}\n`;

  let css = "/* Generated by `hypen theme export` from the project's theme file. Do not edit. */\n";
  css += block(":root", light);
  for (const s of schemes) {
    if (s.scheme === "light") continue;
    const changed = changedLeaves(light, flattenTokens(s.tokens));
    if (Object.keys(changed).length === 0) continue;
    css += `\n${block(`[data-hypen-scheme="${s.scheme}"]`, changed)}`;
    if (s.scheme === "dark") {
      css += `\n@media (prefers-color-scheme: dark) {\n${block(":root:not([data-hypen-scheme])", changed, "  ")}}\n`;
    }
  }
  return { files: { "theme.css": css }, notes: [] };
}

function nativeNotes(theme: ThemeFile, skippedColors: string[]): string[] {
  const notes: string[] = [];
  const custom = Object.keys(theme.schemes).filter((s) => s !== "light" && s !== "dark");
  if (custom.length > 0) {
    notes.push(
      `Only light and dark have a native slot; not exported: ${custom.join(", ")}.`,
    );
  }
  if (skippedColors.length > 0) {
    notes.push(
      `Exported as plain strings (not hex colors, so no light/dark color resource): ${skippedColors.join(", ")}.`,
    );
  }
  return notes;
}

/** A leaf under a `color` group that is not hex is worth a note; other strings are just strings. */
const looksLikeColorToken = (path: string) => /(^|\.)colou?rs?(\.|$)/i.test(path);

/**
 * Android resources: `values/hypen_theme.xml` (light) and
 * `values-night/hypen_theme.xml` (what dark changes). Hex colors become
 * `<color>` (`#AARRGGBB`), numbers `<dimen>` in dp, booleans `<bool>`, other
 * strings `<string>`. Resource names are the token path with `_`.
 */
export function exportAndroid(theme: ThemeFile): ExportResult {
  const light = flattenTokens(resolveScheme(theme, "light").tokens);
  const dark = changedLeaves(light, flattenTokens(resolveScheme(theme, "dark").tokens));
  const skipped = new Set<string>();
  const resource = (path: string, value: TokenValue): string => {
    const name = path.replace(/\./g, "_").toLowerCase();
    const color = parseHexColor(value);
    if (color) {
      return `    <color name="${name}">#${hex2(color.a)}${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}</color>\n`;
    }
    if (typeof value === "number") return `    <dimen name="${name}">${value}dp</dimen>\n`;
    if (typeof value === "boolean") return `    <bool name="${name}">${value}</bool>\n`;
    if (looksLikeColorToken(path)) skipped.add(path);
    return `    <string name="${name}">${xml(value)}</string>\n`;
  };
  const file = (leaves: Record<string, TokenValue>) =>
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    "<!-- Generated by `hypen theme export` from the project's theme file. Do not edit. -->\n" +
    `<resources>\n${Object.entries(leaves).map(([k, v]) => resource(k, v)).join("")}</resources>\n`;

  const files: Record<string, string> = { "values/hypen_theme.xml": file(light) };
  if (Object.keys(dark).length > 0) files["values-night/hypen_theme.xml"] = file(dark);
  return { files, notes: nativeNotes(theme, [...skipped]) };
}

/**
 * An Xcode asset catalog, `HypenTheme.xcassets`: one color set per hex color
 * token (with a dark appearance where dark differs), named by the token path
 * (`color.primary`), plus `HypenTheme.swift` with the non-color tokens as
 * constants.
 */
export function exportIos(theme: ThemeFile): ExportResult {
  const light = flattenTokens(resolveScheme(theme, "light").tokens);
  const dark = flattenTokens(resolveScheme(theme, "dark").tokens);
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const info = { author: "xcode", version: 1 };
  const component = (c: Rgba) => ({
    "color-space": "srgb",
    components: {
      red: `0x${hex2(c.r)}`,
      green: `0x${hex2(c.g)}`,
      blue: `0x${hex2(c.b)}`,
      alpha: (c.a / 255).toFixed(3),
    },
  });
  const camel = (path: string) =>
    path
      .split(/[._]/)
      .filter(Boolean)
      .map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
      .join("")
      .replace(/^(\d)/, "_$1");

  const constants: string[] = [];
  files["HypenTheme.xcassets/Contents.json"] = json({ info });
  for (const [path, value] of Object.entries(light)) {
    const color = parseHexColor(value);
    if (color) {
      const colors: unknown[] = [{ idiom: "universal", color: component(color) }];
      const darkColor = parseHexColor(dark[path]);
      if (darkColor && dark[path] !== value) {
        colors.push({
          idiom: "universal",
          appearances: [{ appearance: "luminosity", value: "dark" }],
          color: component(darkColor),
        });
      }
      files[`HypenTheme.xcassets/${path}.colorset/Contents.json`] = json({ colors, info });
      constants.push(`    static let ${camel(path)} = Color("${path}", bundle: .main)`);
    } else if (typeof value === "number") {
      constants.push(`    static let ${camel(path)}: CGFloat = ${value}`);
    } else if (typeof value === "boolean") {
      constants.push(`    static let ${camel(path)} = ${value}`);
    } else {
      if (looksLikeColorToken(path)) skipped.push(path);
      constants.push(`    static let ${camel(path)} = ${JSON.stringify(value)}`);
    }
  }
  files["HypenTheme.swift"] =
    "// Generated by `hypen theme export` from the project's theme file. Do not edit.\n" +
    `import SwiftUI\n\nenum HypenTheme {\n${constants.join("\n")}\n}\n`;
  return { files, notes: nativeNotes(theme, skipped) };
}

export function exportTheme(theme: ThemeFile, format: ExportFormat): ExportResult {
  switch (format) {
    case "css":
      return exportCss(theme);
    case "android":
      return exportAndroid(theme);
    case "ios":
      return exportIos(theme);
  }
}
