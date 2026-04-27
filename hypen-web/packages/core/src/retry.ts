/**
 * Retry Utility for Network Operations
 *
 * Provides configurable retry logic with exponential/linear backoff
 * for handling transient failures in network operations.
 */

import { type Result, Ok, Err } from "./result.js";

/**
 * Options for retry behavior
 */
export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds (default: 1000) */
  delayMs?: number;
  /** Backoff strategy (default: 'exponential') */
  backoff?: "linear" | "exponential" | "none";
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 to randomize delays (default: 0.1) */
  jitter?: number;
  /** Callback on each retry attempt */
  onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void;
  /** Optional predicate to determine if error is retryable */
  shouldRetry?: (error: Error) => boolean;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

/**
 * Default retry options
 */
const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "onRetry" | "shouldRetry" | "signal">> = {
  maxAttempts: 3,
  delayMs: 1000,
  backoff: "exponential",
  maxDelayMs: 30000,
  jitter: 0.1,
};

/**
 * Calculate delay for a given attempt
 */
function calculateDelay(
  attempt: number,
  options: Required<Omit<RetryOptions, "onRetry" | "shouldRetry" | "signal">>
): number {
  let delay: number;

  switch (options.backoff) {
    case "exponential":
      // 2^(attempt-1) * delayMs: 1x, 2x, 4x, 8x...
      delay = options.delayMs * Math.pow(2, attempt - 1);
      break;
    case "linear":
      // attempt * delayMs: 1x, 2x, 3x, 4x...
      delay = options.delayMs * attempt;
      break;
    case "none":
      delay = options.delayMs;
      break;
  }

  // Apply jitter (randomize ±jitter%)
  if (options.jitter > 0) {
    const jitterRange = delay * options.jitter;
    delay += (Math.random() * 2 - 1) * jitterRange;
  }

  // Cap at maxDelayMs
  return Math.min(delay, options.maxDelayMs);
}

/**
 * Sleep for a given duration, respecting abort signal
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Retry aborted"));
      return;
    }

    const timeoutId = setTimeout(resolve, ms);

    signal?.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      reject(new Error("Retry aborted"));
    });
  });
}

/**
 * Retry a function with configurable backoff
 *
 * @example
 * ```typescript
 * // Basic usage
 * const result = await retry(() => fetch('/api/data'));
 *
 * // With options
 * const result = await retry(
 *   () => fetch('/api/data'),
 *   {
 *     maxAttempts: 5,
 *     delayMs: 2000,
 *     backoff: 'exponential',
 *     onRetry: (n, err) => console.log(`Attempt ${n} failed: ${err.message}`)
 *   }
 * );
 * ```
 */
export async function retry<T>(
  fn: () => T | Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error = new Error("No attempts made");

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      // Check for abort before each attempt
      if (opts.signal?.aborted) {
        throw new Error("Retry aborted");
      }

      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

      // Check if we should retry this error
      if (opts.shouldRetry && !opts.shouldRetry(lastError)) {
        throw lastError;
      }

      // If this was the last attempt, don't wait
      if (attempt === opts.maxAttempts) {
        break;
      }

      // Calculate delay and notify
      const delayMs = calculateDelay(attempt, opts);
      opts.onRetry?.(attempt, lastError, delayMs);

      // Wait before next attempt
      await sleep(delayMs, opts.signal);
    }
  }

  throw lastError;
}

/**
 * Retry a function, returning a Result instead of throwing
 *
 * @example
 * ```typescript
 * const result = await retryResult(() => fetch('/api/data'));
 * if (result.ok) {
 *   console.log('Success:', result.value);
 * } else {
 *   console.error('All retries failed:', result.error);
 * }
 * ```
 */
export async function retryResult<T>(
  fn: () => T | Promise<T>,
  options: RetryOptions = {}
): Promise<Result<T, Error>> {
  try {
    const value = await retry(fn, options);
    return Ok(value);
  } catch (e) {
    return Err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Create a retryable version of a function
 *
 * @example
 * ```typescript
 * const fetchWithRetry = withRetry(
 *   (url: string) => fetch(url),
 *   { maxAttempts: 3 }
 * );
 *
 * const response = await fetchWithRetry('/api/data');
 * ```
 */
export function withRetry<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn | Promise<TReturn>,
  options: RetryOptions = {}
): (...args: TArgs) => Promise<TReturn> {
  return (...args: TArgs) => retry(() => fn(...args), options);
}

/**
 * Predefined retry conditions
 */
export const RetryConditions = {
  /**
   * Retry on network errors (fetch failures, timeouts)
   */
  networkErrors: (error: Error): boolean => {
    const message = error.message.toLowerCase();
    return (
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("timeout") ||
      message.includes("econnrefused") ||
      message.includes("econnreset") ||
      message.includes("socket")
    );
  },

  /**
   * Retry on specific HTTP status codes (from fetch Response)
   */
  httpRetryable: (error: Error & { status?: number }): boolean => {
    const status = error.status;
    if (!status) return false;
    // Retry on 408, 429, 500, 502, 503, 504
    return [408, 429, 500, 502, 503, 504].includes(status);
  },

  /**
   * Retry on transient WebSocket errors
   */
  websocketErrors: (error: Error): boolean => {
    const message = error.message.toLowerCase();
    return (
      message.includes("websocket") ||
      message.includes("connection") ||
      message.includes("close")
    );
  },

  /**
   * Combine multiple conditions (retry if any match)
   */
  any:
    (...conditions: Array<(error: Error) => boolean>) =>
    (error: Error): boolean =>
      conditions.some((c) => c(error)),

  /**
   * Combine multiple conditions (retry if all match)
   */
  all:
    (...conditions: Array<(error: Error) => boolean>) =>
    (error: Error): boolean =>
      conditions.every((c) => c(error)),
};

/**
 * Preset configurations for common use cases
 */
export const RetryPresets = {
  /**
   * Aggressive retry for critical operations
   */
  aggressive: {
    maxAttempts: 10,
    delayMs: 500,
    backoff: "exponential" as const,
    maxDelayMs: 60000,
    jitter: 0.2,
  },

  /**
   * Conservative retry for non-critical operations
   */
  conservative: {
    maxAttempts: 3,
    delayMs: 2000,
    backoff: "linear" as const,
    maxDelayMs: 10000,
    jitter: 0.1,
  },

  /**
   * Fast retry for local operations (short delays)
   */
  fast: {
    maxAttempts: 5,
    delayMs: 100,
    backoff: "exponential" as const,
    maxDelayMs: 2000,
    jitter: 0,
  },

  /**
   * WebSocket reconnection preset
   */
  websocket: {
    maxAttempts: 10,
    delayMs: 1000,
    backoff: "exponential" as const,
    maxDelayMs: 30000,
    jitter: 0.1,
    shouldRetry: RetryConditions.websocketErrors,
  },
};
