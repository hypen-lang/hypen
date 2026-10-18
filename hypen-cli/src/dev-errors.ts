/**
 * Error thrown by `dev()` (Bun and Node dev servers) for expected failure
 * modes, so programmatic callers can catch and handle them. The CLI catches
 * it, prints the message, and exits — `dev()` itself never kills the host
 * process.
 */
export class DevServerError extends Error {
  constructor(
    message: string,
    readonly code: "ENTRY_NOT_FOUND" | "PORT_IN_USE" | "UNSUPPORTED_RUNTIME"
  ) {
    super(message);
    this.name = "DevServerError";
  }
}
