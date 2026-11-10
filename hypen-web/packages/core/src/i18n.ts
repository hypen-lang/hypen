/**
 * Internationalisation for Hypen apps.
 *
 * One `I18n` instance per app (per session for Remote UI) owns the message
 * catalogs and the active locale, and publishes them to the engine as two
 * data-source contexts:
 *
 * - `t`    — the active catalog, merged over the fallback locale's. Templates
 *            read `Text(@t.cart.title)` / `Text("@{t.cart.title}")`, and the
 *            engine builtins `fmt(t.greeting, state.name)` /
 *            `plural(state.count, t.items)` take catalog entries as arguments.
 * - `i18n` — `{ locale, dir, fallbackLocale, locales }`, read as
 *            `@i18n.locale` / `@i18n.dir`.
 *
 * Switching locale (`setLocale`) loads the catalog if needed and pushes a new
 * `t` context, which re-renders every node bound to `t.*`.
 *
 * Plural messages are objects of CLDR categories (`zero/one/two/few/many/other`,
 * plus optional exact `"=N"` forms). Before publishing, each one is annotated
 * with a `__plural` rule table computed from `Intl.PluralRules` for the active
 * locale, which keeps the engine's `plural()` builtin a pure function while
 * selecting categories with the platform's own CLDR data.
 *
 * @module
 */

import type { IDataSourceEngine } from "./datasource.js";
import { createLogger } from "./logger.js";

const log = createLogger("i18n");

/** Reserved data-source provider carrying the active message catalog. */
export const I18N_MESSAGES_PROVIDER = "t";
/** Reserved data-source provider carrying `{ locale, dir, … }`. */
export const I18N_META_PROVIDER = "i18n";
/** Key added to plural message objects; must match the engine's `PLURAL_RULE_KEY`. */
export const PLURAL_RULE_KEY = "__plural";

export type TextDirection = "ltr" | "rtl";

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/** A plural message: CLDR categories (and optional exact `"=N"` forms). `other` is required. */
export type PluralMessage = { other: string } & Partial<Record<PluralCategory, string>> & {
  [exact: `=${number}`]: string;
};

/** A (possibly nested) message catalog. */
export interface Messages {
  [key: string]: string | PluralMessage | Messages;
}

export interface I18nOptions {
  /** Initial locale (BCP 47, e.g. `"en"`, `"hr"`, `"ar-EG"`). */
  locale: string;
  /** Locale whose messages fill keys missing from the active locale. Defaults to `locale`. */
  fallbackLocale?: string;
  /** Catalogs available up front, keyed by locale. */
  messages?: Record<string, Messages>;
  /**
   * Load a locale's catalog on demand (first `setLocale` to it, or the
   * initial/fallback locale if not in `messages`). Results are cached.
   */
  loadLocale?: (locale: string) => Promise<Messages> | Messages;
  /** Called the first time each missing key is looked up via `t()` / `plural()`. */
  onMissingKey?: (key: string, locale: string) => void;
}

/** Snapshot published as the `i18n` data source. */
export interface I18nMeta {
  locale: string;
  fallbackLocale: string;
  dir: TextDirection;
  /** Locales with a catalog available now (provided or already loaded). */
  locales: string[];
}

export type I18nChangeListener = (meta: I18nMeta) => void;

// ---------------------------------------------------------------------------
// Locale helpers
// ---------------------------------------------------------------------------

const RTL_LANGUAGES = new Set([
  "ar", "arc", "ckb", "dv", "fa", "ha-Arab", "he", "iw", "khw", "ks", "ku-Arab",
  "lrc", "mzn", "nqo", "pnb", "ps", "sd", "syr", "ug", "ur", "yi",
]);
const RTL_SCRIPTS = new Set(["Arab", "Hebr", "Thaa", "Syrc", "Nkoo", "Adlm", "Rohg", "Mand", "Samr"]);

/**
 * Writing direction of a locale. Uses `Intl.Locale#getTextInfo` /
 * `textInfo` where the runtime has it, otherwise the script subtag (after
 * likely-subtag expansion when available) and a list of RTL languages.
 */
export function textDirection(locale: string): TextDirection {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    };
    // An explicit script subtag decides (`az-Arab` is RTL even where the
    // runtime's textInfo only looks at the language).
    if (loc.script) return RTL_SCRIPTS.has(loc.script) ? "rtl" : "ltr";
    const info = typeof loc.getTextInfo === "function" ? loc.getTextInfo() : loc.textInfo;
    if (info?.direction === "rtl" || info?.direction === "ltr") return info.direction;
    const script = loc.maximize().script;
    if (script) return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
    return RTL_LANGUAGES.has(loc.language) ? "rtl" : "ltr";
  } catch {
    const lang = locale.split(/[-_]/)[0]?.toLowerCase() ?? "";
    return RTL_LANGUAGES.has(lang) ? "rtl" : "ltr";
  }
}

const CATEGORY_CODES: Record<PluralCategory, string> = {
  zero: "z", one: "o", two: "t", few: "f", many: "m", other: "x",
};
const ruleTableCache = new Map<string, string>();

/**
 * The plural rule table the engine's `plural()` builtin reads: one category
 * code per integer 0..199, then the category of 1,000,000 (see
 * `plural_category` in `hypen-engine-rs/src/reactive/i18n.rs`).
 */
export function pluralRuleTable(locale: string): string {
  const cached = ruleTableCache.get(locale);
  if (cached) return cached;
  let rules: Intl.PluralRules;
  try {
    rules = new Intl.PluralRules(locale);
  } catch {
    log.warn(`Invalid locale "${locale}" for plural rules; plural() will use "other"`);
    return "x".repeat(201);
  }
  let table = "";
  for (let n = 0; n < 200; n++) table += CATEGORY_CODES[rules.select(n) as PluralCategory] ?? "x";
  table += CATEGORY_CODES[rules.select(1_000_000) as PluralCategory] ?? "x";
  ruleTableCache.set(locale, table);
  return table;
}

/** Category the engine would pick from `pluralRuleTable(locale)` for integer `n`. */
export function pluralCategoryFromTable(n: number, table: string): PluralCategory | undefined {
  const abs = Math.abs(n);
  const idx = abs < 200 ? abs : abs % 1_000_000 === 0 ? 200 : 100 + (abs % 100);
  const code = table[idx];
  return (Object.keys(CATEGORY_CODES) as PluralCategory[]).find((c) => CATEGORY_CODES[c] === code);
}

const PLURAL_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for an object shaped like a plural message (CLDR keys / `=N`, string values, has `other`). */
export function isPluralMessage(v: unknown): v is PluralMessage {
  if (!isPlainObject(v) || typeof v.other !== "string") return false;
  for (const [k, val] of Object.entries(v)) {
    if (k === PLURAL_RULE_KEY) continue;
    if (!(PLURAL_KEYS.has(k) || /^=\d+$/.test(k)) || typeof val !== "string") return false;
  }
  return true;
}

/**
 * Deep-merge `primary` over `fallback`. Plural messages are replaced whole
 * (mixing one language's `one` with another's `other` would be wrong).
 */
function mergeCatalogs(fallback: Messages | undefined, primary: Messages | undefined): Messages {
  const out: Messages = {};
  for (const src of [fallback, primary]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      const existing = out[k];
      if (isPlainObject(v) && !isPluralMessage(v) && isPlainObject(existing) && !isPluralMessage(existing)) {
        out[k] = mergeCatalogs(existing as Messages, v as Messages);
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Copy of `catalog` with every plural message annotated with `table`. */
function annotatePlurals(catalog: Messages, table: string): Messages {
  const out: Messages = {};
  for (const [k, v] of Object.entries(catalog)) {
    if (isPluralMessage(v)) {
      out[k] = { ...v, [PLURAL_RULE_KEY]: table } as PluralMessage;
    } else if (isPlainObject(v)) {
      out[k] = annotatePlurals(v as Messages, table);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function lookup(catalog: Messages, key: string): unknown {
  let cur: unknown = catalog;
  for (const seg of key.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur ?? undefined;
}

function display(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Same placeholder rules as the engine's `fmt()`: `{0}`, `{name}`; unknown ones stay. */
export function formatMessage(message: string, args: unknown[], named: Record<string, unknown> = {}): string {
  return message.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    if (/^\d+$/.test(name)) {
      const i = Number(name);
      return i < args.length ? display(args[i]) : whole;
    }
    if (name in named) return display(named[name]);
    for (const a of args) {
      if (isPlainObject(a) && name in a) return display(a[name]);
    }
    return whole;
  });
}

// ---------------------------------------------------------------------------
// I18n
// ---------------------------------------------------------------------------

interface SharedStore {
  catalogs: Map<string, Messages>;
  pending: Map<string, Promise<Messages>>;
  loadLocale?: I18nOptions["loadLocale"];
}

export class I18n {
  private store: SharedStore;
  private _locale: string;
  private _fallbackLocale: string;
  private merged: Messages = {};
  private published: Messages = {};
  private engines = new Set<IDataSourceEngine>();
  private listeners = new Set<I18nChangeListener>();
  private warned = new Set<string>();
  private onMissingKey?: I18nOptions["onMissingKey"];
  private switchSeq = 0;
  /** Resolves once the initial (and fallback) locale catalogs are loaded. */
  readonly ready: Promise<void>;

  constructor(options: I18nOptions, store?: SharedStore) {
    this.store = store ?? {
      catalogs: new Map(Object.entries(options.messages ?? {})),
      pending: new Map(),
      loadLocale: options.loadLocale,
    };
    this._locale = options.locale;
    this._fallbackLocale = options.fallbackLocale ?? options.locale;
    this.onMissingKey = options.onMissingKey;
    this.rebuild();
    this.ready = this.ensureLoaded([this._fallbackLocale, this._locale]).then(
      () => {
        this.rebuild();
        this.publish();
      },
      (err) => {
        log.error(`Failed to load initial locale "${this._locale}":`, err);
      }
    );
  }

  /** Active locale. */
  get locale(): string {
    return this._locale;
  }

  get fallbackLocale(): string {
    return this._fallbackLocale;
  }

  /** Writing direction of the active locale. */
  get dir(): TextDirection {
    return textDirection(this._locale);
  }

  /** Locales with a catalog available now. */
  get locales(): string[] {
    return Array.from(this.store.catalogs.keys());
  }

  /** The `i18n` data-source payload. */
  get meta(): I18nMeta {
    return {
      locale: this._locale,
      fallbackLocale: this._fallbackLocale,
      dir: this.dir,
      locales: this.locales,
    };
  }

  /** The merged, plural-annotated catalog currently published as `t`. */
  get messages(): Messages {
    return this.published;
  }

  /**
   * Switch locale. Loads the catalog if needed, then republishes `t` and
   * `i18n` to every attached engine. Concurrent calls resolve in call order;
   * only the latest one takes effect.
   */
  async setLocale(locale: string): Promise<void> {
    const seq = ++this.switchSeq;
    await this.ensureLoaded([locale]);
    if (seq !== this.switchSeq) return;
    this._locale = locale;
    this.rebuild();
    this.publish();
  }

  /** Register additional messages for a locale (merged over what is there). */
  addMessages(locale: string, messages: Messages): void {
    this.store.catalogs.set(locale, mergeCatalogs(this.store.catalogs.get(locale), messages));
    if (locale === this._locale || locale === this._fallbackLocale) {
      this.rebuild();
      this.publish();
    }
  }

  /** Whether `key` resolves in the active (merged) catalog. */
  has(key: string): boolean {
    return lookup(this.merged, key) !== undefined;
  }

  /**
   * Translate `key` for use in handlers (same rules as the template
   * builtins). A missing key returns the key itself and warns once.
   */
  t(key: string, ...args: unknown[]): string {
    const value = lookup(this.merged, key);
    if (value === undefined) return this.missing(key);
    if (isPluralMessage(value)) return formatMessage(value.other, args);
    return formatMessage(display(value), args);
  }

  /** Plural form of `key` for `count`, with `{count}` and `{0}`… filled. */
  plural(count: number, key: string, ...args: unknown[]): string {
    const value = lookup(this.merged, key);
    if (value === undefined) return this.missing(key);
    if (!isPluralMessage(value)) return formatMessage(display(value), args, { count });
    const exact = (value as Record<string, string>)[`=${count}`];
    let message = exact;
    if (message === undefined) {
      const cat = Number.isInteger(count)
        ? pluralCategoryFromTable(count, pluralRuleTable(this._locale))
        : undefined;
      message = (cat && value[cat]) || value.other;
    }
    return formatMessage(message, args, { count });
  }

  /**
   * Publish `t` and `i18n` to an engine now and on every change. Returns a
   * function that stops publishing (it does not remove the contexts).
   */
  attach(engine: IDataSourceEngine): () => void {
    this.engines.add(engine);
    this.publishTo(engine);
    return () => {
      this.engines.delete(engine);
    };
  }

  /** Listen for locale / catalog changes. Returns an unsubscribe function. */
  onChange(listener: I18nChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * A new instance with its own active locale that shares this one's
   * catalogs and loader cache — one per Remote UI session.
   */
  fork(locale: string = this._locale): I18n {
    return new I18n(
      { locale, fallbackLocale: this._fallbackLocale, onMissingKey: this.onMissingKey },
      this.store
    );
  }

  // ── internals ─────────────────────────────────────────────────────────

  private missing(key: string): string {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      log.warn(`Missing message key "${key}" for locale "${this._locale}"`);
      this.onMissingKey?.(key, this._locale);
    }
    return key;
  }

  private async ensureLoaded(locales: string[]): Promise<void> {
    await Promise.all(
      Array.from(new Set(locales)).map(async (locale) => {
        if (this.store.catalogs.has(locale)) return;
        const loader = this.store.loadLocale;
        if (!loader) {
          throw new Error(`No messages for locale "${locale}" and no loadLocale() configured`);
        }
        let pending = this.store.pending.get(locale);
        if (!pending) {
          pending = Promise.resolve(loader(locale)).finally(() => this.store.pending.delete(locale));
          this.store.pending.set(locale, pending);
        }
        const catalog = await pending;
        if (!this.store.catalogs.has(locale)) this.store.catalogs.set(locale, catalog);
      })
    );
  }

  private rebuild(): void {
    const { catalogs } = this.store;
    this.merged =
      this._fallbackLocale === this._locale
        ? catalogs.get(this._locale) ?? {}
        : mergeCatalogs(catalogs.get(this._fallbackLocale), catalogs.get(this._locale));
    this.published = annotatePlurals(this.merged, pluralRuleTable(this._locale));
  }

  private publishTo(engine: IDataSourceEngine): void {
    engine.setContext(I18N_META_PROVIDER, this.meta as unknown as Record<string, unknown>);
    engine.setContext(I18N_MESSAGES_PROVIDER, this.published as Record<string, unknown>);
  }

  private publish(): void {
    for (const engine of this.engines) {
      try {
        this.publishTo(engine);
      } catch (err) {
        log.error("Failed to publish i18n context:", err);
      }
    }
    const meta = this.meta;
    for (const listener of this.listeners) {
      try {
        listener(meta);
      } catch (err) {
        log.error("i18n change listener threw:", err);
      }
    }
  }
}

/** Create the app's i18n instance. Register it once (e.g. `new Hypen({ i18n })`). */
export function createI18n(options: I18nOptions): I18n {
  return new I18n(options);
}
