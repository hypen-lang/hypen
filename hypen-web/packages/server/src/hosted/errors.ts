/**
 * Setup-time failures of hosted (WASM-component) modules: everything that
 * can be wrong with how a module is declared or loaded, before it runs.
 * Runtime failures (a failing action, a crashed instance) are
 * `HostedModuleFailure`s delivered to the `onError` hook instead.
 */

/** Stable identifiers; scripts and tests match on these, not on wording. */
export type HostedModuleSetupCode =
  /** `@hypen-space/module-host` is not installed. */
  | "MODULE_HOST_MISSING"
  /** The engine build has no hosted-module support. */
  | "ENGINE_UNSUPPORTED"
  /** A module name cannot be an engine scope. */
  | "INVALID_NAME"
  /** An option has the wrong shape. */
  | "INVALID_OPTIONS"
  /** The component file does not exist / cannot be read. */
  | "COMPONENT_MISSING"
  /** The component could not be downloaded. */
  | "COMPONENT_FETCH_FAILED"
  /** The file is empty, not wasm, or a core module rather than a Component. */
  | "COMPONENT_INVALID"
  /** The `.hypen` template file does not exist. */
  | "TEMPLATE_MISSING"
  /** A package's template could not be rewritten to its installed names. */
  | "TEMPLATE_INVALID"
  /** A package `namespace` / `as` / `map` entry, or an alias table, that cannot be applied. */
  | "NAMING_INVALID"
  /** `app.json` is missing, unreadable or malformed. */
  | "MANIFEST_INVALID"
  /** jco could not transpile / the runtime could not compile the component. */
  | "PREPARE_FAILED"
  /** The component imports an interface its grants do not cover. */
  | "UNGRANTED_IMPORT"
  /** A `reads` / `dispatches` grant names no module of the app. */
  | "UNKNOWN_GRANT_TARGET"
  /** Two modules (hosted and/or TypeScript) share a name / scope. */
  | "DUPLICATE_MODULE"
  /** The app's entry module is hosted; it must be a TypeScript module. */
  | "ENTRY_HOSTED"
  /** No hosted module with that name. */
  | "UNKNOWN_MODULE"
  /** A package named in `from` is not installed. */
  | "PACKAGE_NOT_FOUND"
  /** A package component's bytes do not match its manifest / the reviewed record. */
  | "INTEGRITY_MISMATCH"
  /** A package requests more than was reviewed with `hypen add`. */
  | "REQUESTS_CHANGED";

export interface HostedModuleSetupInfo {
  code: HostedModuleSetupCode;
  /** The module the failure concerns. */
  module?: string;
  /** The file the failure concerns. */
  file?: string;
  /** Where to change it: `hypen.json wasm.modules.Pricing.storage`, `wasmModule({ name: "Pricing" }).grants.reads`, … */
  field?: string;
  /** One concrete next step. */
  hint?: string;
  cause?: unknown;
}

export class HostedModuleSetupError extends Error {
  readonly code: HostedModuleSetupCode;
  readonly module?: string;
  readonly file?: string;
  readonly field?: string;
  readonly hint?: string;

  constructor(message: string, info: HostedModuleSetupInfo) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = "HostedModuleSetupError";
    this.code = info.code;
    this.module = info.module;
    this.file = info.file;
    this.field = info.field;
    this.hint = info.hint;
  }
}

export function isHostedModuleSetupError(err: unknown): err is HostedModuleSetupError {
  return (
    err instanceof Error &&
    err.name === "HostedModuleSetupError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/**
 * Render a setup error for a terminal: message, indented context, hint.
 * Plain text; the caller adds color and surrounding blank lines.
 */
export function formatHostedModuleSetupError(err: HostedModuleSetupError): string {
  const lines = [`  ${err.message}`];
  const context: string[] = [];
  if (err.module) context.push(`module:  ${err.module}`);
  if (err.file) context.push(`file:    ${err.file}`);
  if (err.field) context.push(`field:   ${err.field}`);
  context.push(`code:    ${err.code}`);
  lines.push("");
  for (const line of context) lines.push(`    ${line}`);
  if (err.hint) {
    lines.push("");
    lines.push(`  Hint: ${err.hint}`);
  }
  return lines.join("\n");
}
