/**
 * Theming and design tokens for Hypen apps.
 *
 * One `Theme` instance per app (per session for Remote UI) owns the design
 * tokens and the active color scheme, and publishes them to the engine as two
 * data-source contexts:
 *
 * - `theme`      — the resolved tokens: the base set with the active scheme's
 *                  overrides merged on top. Templates read
 *                  `.color(@theme.color.primary)` / `.padding(@theme.space.md)`
 *                  / `Text("@{theme.font.body}")`.
 * - `appearance` — `{ scheme, preference, system, schemes }`, read as
 *                  `@appearance.scheme` (e.g. to pick an icon).
 *
 * Switching scheme (`setScheme`) pushes a new `theme` context in the next
 * microtask; the engine diffs it against the previous one and re-renders only
 * the nodes bound to tokens whose value actually changed.
 *
 * A token value may be an alias of another token, written `"{color.blue.500}"`
 * (the whole string). Aliases are resolved after the scheme merge, so a
 * semantic token defined once in the base set (`primary: "{color.brand}"`)
 * follows a scheme that overrides `color.brand`.
 *
 * @module
 */

import type { IDataSourceEngine } from "./datasource.js";
import { createLogger } from "./logger.js";

const log = createLogger("theme");

/** Reserved data-source provider carrying the resolved tokens. */
export const THEME_TOKENS_PROVIDER = "theme";
/** Reserved data-source provider carrying `{ scheme, preference, … }`. */
export const THEME_META_PROVIDER = "appearance";
/** The preference that follows the platform's color scheme. */
export const SYSTEM_SCHEME = "system";

/** A color scheme the platform itself can report. */
export type SystemColorScheme = "light" | "dark";

export type TokenValue = string | number | boolean;

/** A (possibly nested) set of design tokens. */
export interface Tokens {
  [key: string]: TokenValue | Tokens;
}

export interface ThemeOptions {
  /** Tokens shared by every scheme. */
  tokens?: Tokens;
  /**
   * Per-scheme overrides, merged over `tokens` while that scheme is active.
   * `light` and `dark` are what `"system"` resolves to; any other name is a
   * scheme selected explicitly with `setScheme(name)`.
   */
  schemes?: Record<string, Tokens>;
  /**
   * Which scheme to use: a scheme name, or `"system"` to follow the
   * platform. Defaults to `"system"`.
   */
  scheme?: string;
  /**
   * What `"system"` resolves to until the platform reports otherwise
   * (`setSystemScheme` / `watchSystem`). Defaults to `"light"`.
   */
  systemScheme?: SystemColorScheme;
  /** Called the first time each missing token is looked up via `token()`. */
  onMissingToken?: (path: string, scheme: string) => void;
}

/** Snapshot published as the `appearance` data source. */
export interface ThemeMeta {
  /** The scheme in effect (never `"system"`). */
  scheme: string;
  /** What was asked for: a scheme name or `"system"`. */
  preference: string;
  /** The platform's scheme as last reported. */
  system: SystemColorScheme;
  /** Scheme names that have overrides defined. */
  schemes: string[];
}

export type ThemeChangeListener = (meta: ThemeMeta) => void;

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/** Segments a template reference (`@theme.a.b`) can address. */
const REFERENCEABLE_KEY = /^[A-Za-z0-9_]+$/;
const ALIAS = /^\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}$/;
/** Longest alias chain followed before giving up (a cycle is reported earlier). */
const MAX_ALIAS_DEPTH = 32;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `primary` over `fallback` into a new object. */
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

function lookup(tokens: Tokens, path: string): TokenValue | Tokens | undefined {
  let cur: unknown = tokens;
  for (const seg of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return (cur ?? undefined) as TokenValue | Tokens | undefined;
}

/**
 * Copy of `tokens` with every `"{path}"` alias replaced by the value it
 * points at (a leaf or a whole group). An alias that is missing or part of a
 * cycle is reported through `report` and left as written.
 */
export function resolveTokenAliases(
  tokens: Tokens,
  report: (problem: string) => void = () => {}
): Tokens {
  const follow = (value: TokenValue | Tokens, at: string): TokenValue | Tokens => {
    const seen = [at];
    let cur = value;
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
      const match = typeof cur === "string" ? ALIAS.exec(cur) : null;
      if (!match) return cur;
      const target = match[1]!;
      if (seen.includes(target) || at.startsWith(`${target}.`)) {
        report(`Token alias cycle: ${[...seen, target].join(" -> ")}`);
        return value;
      }
      const next = lookup(tokens, target);
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
      // A group reached through an alias can itself hold aliases (and could
      // alias back into its own parent), hence the depth bound.
      out[k] =
        isPlainObject(resolved) && depth < MAX_ALIAS_DEPTH
          ? walk(resolved as Tokens, at, depth + 1)
          : resolved;
    }
    return out;
  };
  return walk(tokens, "", 0);
}

function warnUnreferenceableKeys(tokens: Tokens, prefix: string, warned: Set<string>): void {
  for (const [k, v] of Object.entries(tokens)) {
    const at = prefix ? `${prefix}.${k}` : k;
    if (!REFERENCEABLE_KEY.test(k) && !warned.has(at)) {
      warned.add(at);
      log.warn(
        `Token key "${at}" cannot be referenced from a template; use letters, digits and "_" only`
      );
    }
    if (isPlainObject(v)) warnUnreferenceableKeys(v as Tokens, at, warned);
  }
}

/** Flatten tokens to leaves: `{ "color.primary": "#06f", … }`. */
function flatten(tokens: Tokens, prefix: string, out: Record<string, TokenValue>): void {
  for (const [k, v] of Object.entries(tokens)) {
    const at = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flatten(v as Tokens, at, out);
    else out[at] = v as TokenValue;
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

interface SharedStore {
  base: Tokens;
  schemes: Map<string, Tokens>;
}

interface MediaQueryListLike {
  matches: boolean;
  addEventListener?: (type: "change", listener: (e: { matches: boolean }) => void) => void;
  removeEventListener?: (type: "change", listener: (e: { matches: boolean }) => void) => void;
}

export class Theme {
  private store: SharedStore;
  private _preference: string;
  private _system: SystemColorScheme;
  private resolved: Tokens = {};
  private aliasProblems: string[] = [];
  private engines = new Set<IDataSourceEngine>();
  private listeners = new Set<ThemeChangeListener>();
  private warned = new Set<string>();
  private onMissingToken?: ThemeOptions["onMissingToken"];
  private publishQueued = false;

  constructor(options: ThemeOptions = {}, store?: SharedStore) {
    this.store = store ?? {
      base: options.tokens ?? {},
      schemes: new Map(Object.entries(options.schemes ?? {})),
    };
    this._system = options.systemScheme ?? "light";
    this._preference = SYSTEM_SCHEME;
    this.onMissingToken = options.onMissingToken;
    if (options.scheme !== undefined) {
      if (this.isSelectable(options.scheme)) this._preference = options.scheme;
      else log.warn(`Unknown color scheme "${options.scheme}"; following the system scheme`);
    }
    if (!store) {
      warnUnreferenceableKeys(this.store.base, "", this.warned);
      for (const tokens of this.store.schemes.values()) {
        warnUnreferenceableKeys(tokens, "", this.warned);
      }
    }
    this.rebuild();
  }

  /** The scheme in effect: the preference, or the system scheme when it is `"system"`. */
  get scheme(): string {
    return this._preference === SYSTEM_SCHEME ? this._system : this._preference;
  }

  /** What was asked for: a scheme name or `"system"`. */
  get preference(): string {
    return this._preference;
  }

  /** The platform's scheme as last reported. */
  get systemScheme(): SystemColorScheme {
    return this._system;
  }

  /** Scheme names that have overrides defined. */
  get schemes(): string[] {
    return Array.from(this.store.schemes.keys());
  }

  /** The `appearance` data-source payload. */
  get meta(): ThemeMeta {
    return {
      scheme: this.scheme,
      preference: this._preference,
      system: this._system,
      schemes: this.schemes,
    };
  }

  /** The resolved tokens currently published as `theme`. */
  get tokens(): Tokens {
    return this.resolved;
  }

  /** Alias problems (missing target, cycle) in the active scheme's tokens. */
  get problems(): string[] {
    return this.aliasProblems;
  }

  /**
   * Select a scheme by name, or `"system"` to follow the platform, then
   * republish to every attached engine. Throws for a name that is neither
   * `light` / `dark` / `"system"` nor defined in `schemes`.
   */
  setScheme(preference: string): void {
    if (!this.isSelectable(preference)) {
      throw new Error(
        `Unknown color scheme "${preference}". Known: ${[SYSTEM_SCHEME, ...this.selectable()].join(", ")}`
      );
    }
    if (preference === this._preference) return;
    const before = this.scheme;
    this._preference = preference;
    this.changed(before);
  }

  /** Flip between `light` and `dark`, starting from whichever is in effect. */
  toggle(): void {
    this.setScheme(this.scheme === "dark" ? "light" : "dark");
  }

  /**
   * Report the platform's scheme. Takes effect immediately when the
   * preference is `"system"`; otherwise it is remembered for when it is.
   */
  setSystemScheme(scheme: SystemColorScheme): void {
    if (scheme === this._system) return;
    const before = this.scheme;
    this._system = scheme;
    this.changed(before);
  }

  /**
   * Follow `prefers-color-scheme` where the runtime has `matchMedia`
   * (browsers). Returns a function that stops following; a no-op elsewhere.
   */
  watchSystem(): () => void {
    const matchMedia = (globalThis as { matchMedia?: (q: string) => MediaQueryListLike }).matchMedia;
    if (typeof matchMedia !== "function") return () => {};
    let query: MediaQueryListLike;
    try {
      query = matchMedia.call(globalThis, "(prefers-color-scheme: dark)");
    } catch {
      return () => {};
    }
    const apply = (e: { matches: boolean }) => this.setSystemScheme(e.matches ? "dark" : "light");
    apply(query);
    query.addEventListener?.("change", apply);
    return () => query.removeEventListener?.("change", apply);
  }

  /**
   * Merge more tokens in — into the base set, or into `scheme`'s overrides —
   * and republish. This is how a component package contributes defaults.
   */
  extend(tokens: Tokens, scheme?: string): void {
    warnUnreferenceableKeys(tokens, "", this.warned);
    if (scheme === undefined) {
      this.store.base = mergeTokens(this.store.base, tokens);
    } else {
      this.store.schemes.set(scheme, mergeTokens(this.store.schemes.get(scheme), tokens));
    }
    if (scheme === undefined || scheme === this.scheme) {
      this.rebuild();
      this.publish();
    }
  }

  /** Whether `path` resolves in the active scheme. */
  has(path: string): boolean {
    return lookup(this.resolved, path) !== undefined;
  }

  /**
   * A token's value in the active scheme, for use in handlers. A missing
   * token returns `undefined` and warns once.
   */
  token(path: string): TokenValue | Tokens | undefined {
    const value = lookup(this.resolved, path);
    if (value === undefined && !this.warned.has(`missing:${path}`)) {
      this.warned.add(`missing:${path}`);
      log.warn(`Missing theme token "${path}" for scheme "${this.scheme}"`);
      this.onMissingToken?.(path, this.scheme);
    }
    return value;
  }

  /**
   * The active tokens as CSS custom properties, e.g.
   * `{ "--color-primary": "#06f", "--space-md": "16" }` — for styling the
   * host page around the Hypen root from the same source of truth.
   */
  cssVariables(prefix = "--"): Record<string, string> {
    const flat: Record<string, TokenValue> = {};
    flatten(this.resolved, "", flat);
    const out: Record<string, string> = {};
    for (const [path, value] of Object.entries(flat)) {
      out[prefix + path.replace(/\./g, "-")] = String(value);
    }
    return out;
  }

  /**
   * Publish `theme` and `appearance` to an engine now and on every change.
   * Returns a function that stops publishing (it does not remove the contexts).
   */
  attach(engine: IDataSourceEngine): () => void {
    this.engines.add(engine);
    this.publishTo(engine);
    return () => {
      this.engines.delete(engine);
    };
  }

  /** Listen for scheme / token changes. Returns an unsubscribe function. */
  onChange(listener: ThemeChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * A new instance with its own scheme preference that shares this one's
   * tokens — one per Remote UI session.
   */
  fork(preference: string = this._preference): Theme {
    return new Theme(
      { scheme: preference, systemScheme: this._system, onMissingToken: this.onMissingToken },
      this.store
    );
  }

  // ── internals ─────────────────────────────────────────────────────────

  private selectable(): string[] {
    return Array.from(new Set(["light", "dark", ...this.store.schemes.keys()]));
  }

  private isSelectable(preference: string): boolean {
    return preference === SYSTEM_SCHEME || this.selectable().includes(preference);
  }

  private changed(schemeBefore: string): void {
    if (this.scheme !== schemeBefore) this.rebuild();
    this.publish();
  }

  private rebuild(): void {
    const overrides = this.store.schemes.get(this.scheme);
    const merged = overrides ? mergeTokens(this.store.base, overrides) : this.store.base;
    this.aliasProblems = [];
    this.resolved = resolveTokenAliases(merged, (problem) => {
      this.aliasProblems.push(problem);
      if (this.warned.has(problem)) return;
      this.warned.add(problem);
      log.warn(problem);
    });
  }

  private publishTo(engine: IDataSourceEngine): void {
    engine.setContext(THEME_META_PROVIDER, this.meta as unknown as Record<string, unknown>);
    engine.setContext(THEME_TOKENS_PROVIDER, this.resolved as Record<string, unknown>);
  }

  /**
   * Listeners hear about a change at once; engines are updated in a
   * microtask. A handler that calls `setScheme` runs inside the engine's own
   * action dispatch, where pushing a context would re-enter it — the same
   * reason state mutations flush in a microtask. Several changes in one turn
   * publish once.
   */
  private publish(): void {
    if (!this.publishQueued && this.engines.size > 0) {
      this.publishQueued = true;
      queueMicrotask(() => {
        this.publishQueued = false;
        for (const engine of this.engines) {
          try {
            this.publishTo(engine);
          } catch (err) {
            log.error("Failed to publish theme context:", err);
          }
        }
      });
    }
    const meta = this.meta;
    for (const listener of this.listeners) {
      try {
        listener(meta);
      } catch (err) {
        log.error("Theme change listener threw:", err);
      }
    }
  }
}

/** Create the app's theme. Register it once (e.g. `new Hypen({ theme })`). */
export function createTheme(options: ThemeOptions = {}): Theme {
  return new Theme(options);
}
