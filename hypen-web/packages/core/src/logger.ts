/**
 * Configurable Debug Logger
 *
 * Provides environment-aware logging that can be disabled in production.
 * Supports log levels, tagged output, and performance timing.
 *
 * Default level: "info", "warn" under a test runner (NODE_ENV=test), "error"
 * when NODE_ENV=production. `DEBUG=hypen:*` (all loggers) or
 * `DEBUG=hypen:<tag>` (e.g. `hypen:remote`, `hypen:engine,hypen:router`)
 * turns on every level for the matching loggers; in browsers the same spec
 * is read from `localStorage.debug`. See setDebugNamespaces().
 */

// ============================================================================
// Types
// ============================================================================

export type LogLevel = "debug" | "info" | "warn" | "error" | "none";

export interface LoggerConfig {
  /** Minimum log level (default: "debug" in dev, "error" in prod) */
  level: LogLevel;
  /** Enable colored output (default: true) */
  colors: boolean;
  /** Include timestamps (default: false) */
  timestamps: boolean;
  /** Custom log handler (default: console) */
  handler?: LogHandler;
}

export interface LogHandler {
  debug(tag: string, ...args: unknown[]): void;
  info(tag: string, ...args: unknown[]): void;
  warn(tag: string, ...args: unknown[]): void;
  error(tag: string, ...args: unknown[]): void;
}

// ============================================================================
// Constants
// ============================================================================

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

const LOG_LEVEL_COLORS: Record<Exclude<LogLevel, "none">, string> = {
  debug: "\x1b[36m", // Cyan
  info: "\x1b[32m",  // Green
  warn: "\x1b[33m",  // Yellow
  error: "\x1b[31m", // Red
};

const RESET_COLOR = "\x1b[0m";

// ============================================================================
// Global Configuration
// ============================================================================

function readEnv(name: string): string | undefined {
  try {
    if (typeof process !== "undefined" && process.env) {
      return process.env[name];
    }
  } catch {
    // process.env can throw in some sandboxed runtimes
  }
  return undefined;
}

/**
 * Detect if running in production environment
 */
function isProduction(): boolean {
  return readEnv("NODE_ENV") === "production";
}

/**
 * Detect a test runner (`bun test` sets NODE_ENV=test, as do jest/vitest).
 * Info-level chatter is suppressed there so test output stays readable;
 * `DEBUG=hypen:*` or `setLogLevel()` brings it back.
 */
function isTest(): boolean {
  return readEnv("NODE_ENV") === "test";
}

/**
 * The NO_COLOR convention (https://no-color.org): a non-empty `NO_COLOR`
 * disables ANSI colors whatever `colors` is configured to. Read per log
 * line so a value set after import still applies.
 */
function colorsAllowed(): boolean {
  const noColor = readEnv("NO_COLOR");
  return noColor === undefined || noColor === "";
}

function defaultLevel(): LogLevel {
  if (isProduction()) return "error";
  if (isTest()) return "warn";
  return "info";
}

/**
 * Default configuration
 */
let config: LoggerConfig = {
  level: defaultLevel(),
  colors: true,
  timestamps: false,
};

// ============================================================================
// DEBUG namespaces (debug-module style)
// ============================================================================

/**
 * Compiled `DEBUG` patterns. A logger tagged "Remote" (or a child
 * "Remote:Session") has namespace "hypen:remote" ("hypen:remote:session").
 * Matching namespaces log at every level regardless of the global level
 * (except when logging is disabled with level "none").
 */
let debugInclude: RegExp[] = [];
let debugExclude: RegExp[] = [];
const namespaceCache = new Map<string, boolean>();

function compileNamespacePattern(pattern: string): RegExp {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*?");
  return new RegExp(`^${escaped}$`);
}

/**
 * Enable debug output for namespaces, using the same syntax as the `DEBUG`
 * environment variable: comma/space-separated patterns, `*` wildcards and
 * `-` prefixed exclusions. Hypen namespaces are `hypen:<tag>` in lower case,
 * e.g. `hypen:*`, `hypen:remote`, `hypen:engine,hypen:router`,
 * `hypen:*,-hypen:state`. Patterns outside `hypen:` (e.g. `express:*`) are
 * ignored unless they also match (a bare `*` enables everything).
 * Pass an empty string or null to clear.
 */
export function setDebugNamespaces(spec: string | null | undefined): void {
  debugInclude = [];
  debugExclude = [];
  namespaceCache.clear();
  if (!spec) return;
  for (const raw of spec.split(/[\s,]+/)) {
    if (!raw) continue;
    if (raw.startsWith("-")) {
      debugExclude.push(compileNamespacePattern(raw.slice(1)));
    } else {
      debugInclude.push(compileNamespacePattern(raw));
    }
  }
}

/**
 * Whether a logger tag is enabled by the `DEBUG` namespaces.
 */
export function isNamespaceEnabled(tag: string): boolean {
  if (debugInclude.length === 0) return false;
  const cached = namespaceCache.get(tag);
  if (cached !== undefined) return cached;
  const ns = `hypen:${tag.toLowerCase()}`;
  let enabled = false;
  if (!debugExclude.some((re) => re.test(ns))) {
    // `hypen:remote` also enables children such as `hypen:remote:session`.
    enabled = debugInclude.some((re) => re.test(ns) || re.test(ns.split(":").slice(0, 2).join(":")));
  }
  namespaceCache.set(tag, enabled);
  return enabled;
}

function readDebugSpec(): string | undefined {
  const fromEnv = readEnv("DEBUG");
  if (fromEnv) return fromEnv;
  // Browsers: honour localStorage.debug, as the `debug` package does.
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage?.getItem("debug") ?? undefined;
  } catch {
    return undefined;
  }
}

setDebugNamespaces(readDebugSpec());

// ============================================================================
// Configuration API
// ============================================================================

/**
 * Set the global log level
 */
export function setLogLevel(level: LogLevel): void {
  config.level = level;
}

/**
 * Get the current log level
 */
export function getLogLevel(): LogLevel {
  return config.level;
}

/**
 * Configure the logger
 */
export function configureLogger(options: Partial<LoggerConfig>): void {
  config = { ...config, ...options };
}

/**
 * Enable all logging (sets level to "debug")
 */
export function enableLogging(): void {
  config.level = "debug";
}

/**
 * Disable all logging (sets level to "none")
 */
export function disableLogging(): void {
  config.level = "none";
}

/**
 * Enable debug mode - alias for enableLogging()
 * Call this at app startup to see all debug logs
 *
 * @example
 * ```typescript
 * import { setDebugMode } from "@hypen-space/core";
 * setDebugMode(true);
 * ```
 */
export function setDebugMode(enabled: boolean): void {
  config.level = enabled ? "debug" : "error";
}

/**
 * Check if debug mode is enabled. With a logger tag, also true when that
 * tag's namespace is enabled via `DEBUG` / `setDebugNamespaces()`.
 */
export function isDebugMode(tag?: string): boolean {
  if (config.level === "debug") return true;
  return tag !== undefined && config.level !== "none" && isNamespaceEnabled(tag);
}

// ============================================================================
// Utility Functions
// ============================================================================

function shouldLog(level: LogLevel, tag?: string): boolean {
  if (LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[config.level]) return true;
  return config.level !== "none" && tag !== undefined && isNamespaceEnabled(tag);
}

function formatTag(tag: string, level: LogLevel): string {
  const timestamp = config.timestamps ? `${new Date().toISOString()} ` : "";

  if (config.colors && colorsAllowed() && level !== "none") {
    const color = LOG_LEVEL_COLORS[level as Exclude<LogLevel, "none">];
    return `${timestamp}${color}[${tag}]${RESET_COLOR}`;
  }

  return `${timestamp}[${tag}]`;
}

// ============================================================================
// Logger Class
// ============================================================================

/**
 * Tagged logger instance
 *
 * @example
 * ```typescript
 * const log = createLogger("MyComponent");
 * log.debug("initialized with", { props });
 * log.error("failed to load", error);
 * ```
 */
export class Logger {
  private readonly tag: string;

  constructor(tag: string) {
    this.tag = tag;
  }

  debug(...args: unknown[]): void {
    if (!shouldLog("debug", this.tag)) return;

    if (config.handler) {
      config.handler.debug(this.tag, ...args);
    } else {
      console.log(formatTag(this.tag, "debug"), ...args);
    }
  }

  info(...args: unknown[]): void {
    if (!shouldLog("info", this.tag)) return;

    if (config.handler) {
      config.handler.info(this.tag, ...args);
    } else {
      console.info(formatTag(this.tag, "info"), ...args);
    }
  }

  warn(...args: unknown[]): void {
    if (!shouldLog("warn", this.tag)) return;

    if (config.handler) {
      config.handler.warn(this.tag, ...args);
    } else {
      console.warn(formatTag(this.tag, "warn"), ...args);
    }
  }

  error(...args: unknown[]): void {
    if (!shouldLog("error", this.tag)) return;

    if (config.handler) {
      config.handler.error(this.tag, ...args);
    } else {
      console.error(formatTag(this.tag, "error"), ...args);
    }
  }

  /**
   * Time a function execution
   */
  time<T>(label: string, fn: () => T): T {
    if (!shouldLog("debug", this.tag)) {
      return fn();
    }

    const start = performance.now();
    try {
      return fn();
    } finally {
      const duration = performance.now() - start;
      this.debug(`${label}: ${duration.toFixed(2)}ms`);
    }
  }

  /**
   * Time an async function execution
   */
  async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!shouldLog("debug", this.tag)) {
      return fn();
    }

    const start = performance.now();
    try {
      return await fn();
    } finally {
      const duration = performance.now() - start;
      this.debug(`${label}: ${duration.toFixed(2)}ms`);
    }
  }

  /**
   * Create a child logger with additional context
   */
  child(subTag: string): Logger {
    return new Logger(`${this.tag}:${subTag}`);
  }

  /**
   * Conditionally log based on a condition
   */
  debugIf(condition: boolean, ...args: unknown[]): void {
    if (condition) this.debug(...args);
  }

  warnIf(condition: boolean, ...args: unknown[]): void {
    if (condition) this.warn(...args);
  }

  errorIf(condition: boolean, ...args: unknown[]): void {
    if (condition) this.error(...args);
  }

  /**
   * Log once (useful for deprecation warnings)
   */
  private loggedOnce = new Set<string>();

  warnOnce(key: string, ...args: unknown[]): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    this.warn(...args);
  }

  debugOnce(key: string, ...args: unknown[]): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    this.debug(...args);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a tagged logger
 *
 * @example
 * ```typescript
 * const log = createLogger("Router");
 * log.info("navigating to", path);
 * ```
 */
export function createLogger(tag: string): Logger {
  return new Logger(tag);
}

// ============================================================================
// Default Logger Instance
// ============================================================================

/**
 * Default logger for general use
 */
export const logger = createLogger("Hypen");

// ============================================================================
// Shorthand Functions (untagged)
// ============================================================================

/**
 * Shorthand logging functions for quick use
 * Prefer createLogger() for component-specific logging
 */
export const log = {
  debug: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("debug", tag)) return;
    console.log(formatTag(tag, "debug"), ...args);
  },

  info: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("info", tag)) return;
    console.info(formatTag(tag, "info"), ...args);
  },

  warn: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("warn", tag)) return;
    console.warn(formatTag(tag, "warn"), ...args);
  },

  error: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("error", tag)) return;
    console.error(formatTag(tag, "error"), ...args);
  },
};

// ============================================================================
// Predefined Loggers for Framework Components
// ============================================================================

export const frameworkLoggers = {
  hypen: createLogger("Hypen"),
  engine: createLogger("Engine"),
  router: createLogger("Router"),
  state: createLogger("State"),
  events: createLogger("Events"),
  remote: createLogger("Remote"),
  renderer: createLogger("Renderer"),
  module: createLogger("Module"),
  lifecycle: createLogger("Lifecycle"),
  loader: createLogger("Loader"),
  context: createLogger("Context"),
  discovery: createLogger("Discovery"),
  plugin: createLogger("Plugin"),
  canvas: createLogger("Canvas"),
  debug: createLogger("Debug"),
};
