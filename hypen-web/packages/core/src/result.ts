/**
 * Result Type for Error Handling
 *
 * A lightweight Result type for explicit error handling without exceptions.
 * Provides type-safe error propagation and composition.
 */

/**
 * Represents either a successful value or an error
 */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Create a successful Result
 */
export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Create a failed Result
 */
export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Check if a Result is Ok
 */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/**
 * Check if a Result is Err
 */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/**
 * Wrap a Promise in a Result, catching any thrown errors
 */
export async function fromPromise<T, E = Error>(
  promise: Promise<T>,
  mapError?: (e: unknown) => E
): Promise<Result<T, E>> {
  try {
    const value = await promise;
    return Ok(value);
  } catch (e) {
    if (mapError) {
      return Err(mapError(e));
    }
    return Err(e as E);
  }
}

/**
 * Wrap a synchronous function in a Result, catching any thrown errors
 */
export function fromTry<T, E = Error>(
  fn: () => T,
  mapError?: (e: unknown) => E
): Result<T, E> {
  try {
    return Ok(fn());
  } catch (e) {
    if (mapError) {
      return Err(mapError(e));
    }
    return Err(e as E);
  }
}

/**
 * Map over a successful Result value
 */
export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  if (result.ok) {
    return Ok(fn(result.value));
  }
  return result;
}

/**
 * Map over a failed Result error
 */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F
): Result<T, F> {
  if (!result.ok) {
    return Err(fn(result.error));
  }
  return result;
}

/**
 * Chain Results together (flatMap)
 */
export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  if (result.ok) {
    return fn(result.value);
  }
  return result;
}

/**
 * Unwrap a Result, throwing if it's an error
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

/**
 * Unwrap a Result with a default value
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  if (result.ok) {
    return result.value;
  }
  return defaultValue;
}

/**
 * Unwrap a Result with a lazy default value
 */
export function unwrapOrElse<T, E>(result: Result<T, E>, fn: (error: E) => T): T {
  if (result.ok) {
    return result.value;
  }
  return fn(result.error);
}

/**
 * Match on a Result, providing handlers for both cases
 */
export function match<T, E, U>(
  result: Result<T, E>,
  handlers: {
    ok: (value: T) => U;
    err: (error: E) => U;
  }
): U {
  if (result.ok) {
    return handlers.ok(result.value);
  }
  return handlers.err(result.error);
}

/**
 * Combine multiple Results into a single Result containing an array
 * Returns the first error encountered, or Ok with all values
 */
export function all<T, E>(results: Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) {
      return result;
    }
    values.push(result.value);
  }
  return Ok(values);
}

/**
 * Base class for typed errors with context
 */
export class HypenError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;
  override readonly cause?: Error;

  constructor(
    code: string,
    message: string,
    options?: { context?: Record<string, unknown>; cause?: Error }
  ) {
    super(message);
    this.name = 'HypenError';
    this.code = code;
    this.context = options?.context;
    this.cause = options?.cause;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when an action handler fails
 */
export class ActionError extends HypenError {
  readonly actionName: string;

  constructor(actionName: string, cause?: unknown) {
    super(
      'ACTION_ERROR',
      `Action handler "${actionName}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        context: { actionName },
        cause: cause instanceof Error ? cause : undefined,
      }
    );
    this.name = 'ActionError';
    this.actionName = actionName;
  }
}

/**
 * Error thrown when a connection fails
 */
export class ConnectionError extends HypenError {
  readonly url: string;
  readonly attempt?: number;

  constructor(url: string, cause?: unknown, attempt?: number) {
    super(
      'CONNECTION_ERROR',
      `Connection to "${url}" failed${attempt ? ` (attempt ${attempt})` : ''}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      {
        context: { url, attempt },
        cause: cause instanceof Error ? cause : undefined,
      }
    );
    this.name = 'ConnectionError';
    this.url = url;
    this.attempt = attempt;
  }
}

/**
 * Error thrown when state operations fail
 */
export class StateError extends HypenError {
  readonly path?: string;

  constructor(message: string, path?: string, cause?: unknown) {
    super('STATE_ERROR', message, {
      context: { path },
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = 'StateError';
    this.path = path;
  }
}

/**
 * Error thrown when parsing Hypen DSL source fails
 */
export class ParseError extends HypenError {
  readonly source?: string;

  constructor(message: string, source?: string, cause?: unknown) {
    super('PARSE_ERROR', message, {
      context: { source },
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = 'ParseError';
    this.source = source;
  }
}

/**
 * Error thrown when rendering fails
 */
export class RenderError extends HypenError {
  constructor(message: string, cause?: unknown) {
    super('RENDER_ERROR', message, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = 'RenderError';
  }
}

/**
 * Classify a WASM engine error string into the appropriate HypenError subclass.
 * The engine returns JsValue error strings with known prefixes.
 */
export function classifyEngineError(err: unknown): HypenError {
  // Handle structured WASM errors: { type: string, message: string }
  if (err && typeof err === 'object' && 'message' in err && 'type' in err) {
    const structured = err as { type: string; message: string };
    switch (structured.type) {
      case 'parseError': return new ParseError(structured.message);
      case 'stateError': return new StateError(structured.message);
      case 'renderError': return new RenderError(structured.message);
      case 'actionError': return new HypenError('ACTION_ERROR', structured.message);
      default: return new HypenError('UNKNOWN_ERROR', structured.message);
    }
  }
  const message = err instanceof Error ? err.message : String(err);

  if (message.startsWith('Parse error:')) {
    return new ParseError(message);
  }
  if (message.startsWith('Invalid state:') || message.startsWith('Invalid state patch:')) {
    return new StateError(message);
  }
  if (message.startsWith('Parent node not found:')) {
    return new RenderError(message);
  }

  return new RenderError(message);
}
