/**
 * Configurable Debug Logger
 *
 * Provides environment-aware logging that can be disabled in production.
 * Supports log levels, tagged output, and performance timing.
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

/**
 * Detect if running in production environment
 */
function isProduction(): boolean {
  if (typeof process !== "undefined" && process.env) {
    return process.env.NODE_ENV === "production";
  }
  return false;
}

/**
 * Default configuration
 */
let config: LoggerConfig = {
  level: isProduction() ? "error" : "info",
  colors: true,
  timestamps: false,
};

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
 * Check if debug mode is enabled
 */
export function isDebugMode(): boolean {
  return config.level === "debug";
}

// ============================================================================
// Utility Functions
// ============================================================================

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[config.level];
}

function formatTag(tag: string, level: LogLevel): string {
  const timestamp = config.timestamps ? `${new Date().toISOString()} ` : "";

  if (config.colors && level !== "none") {
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
    if (!shouldLog("debug")) return;

    if (config.handler) {
      config.handler.debug(this.tag, ...args);
    } else {
      console.log(formatTag(this.tag, "debug"), ...args);
    }
  }

  info(...args: unknown[]): void {
    if (!shouldLog("info")) return;

    if (config.handler) {
      config.handler.info(this.tag, ...args);
    } else {
      console.info(formatTag(this.tag, "info"), ...args);
    }
  }

  warn(...args: unknown[]): void {
    if (!shouldLog("warn")) return;

    if (config.handler) {
      config.handler.warn(this.tag, ...args);
    } else {
      console.warn(formatTag(this.tag, "warn"), ...args);
    }
  }

  error(...args: unknown[]): void {
    if (!shouldLog("error")) return;

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
    if (!shouldLog("debug")) {
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
    if (!shouldLog("debug")) {
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
    if (!shouldLog("debug")) return;
    console.log(formatTag(tag, "debug"), ...args);
  },

  info: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("info")) return;
    console.info(formatTag(tag, "info"), ...args);
  },

  warn: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("warn")) return;
    console.warn(formatTag(tag, "warn"), ...args);
  },

  error: (tag: string, ...args: unknown[]): void => {
    if (!shouldLog("error")) return;
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
