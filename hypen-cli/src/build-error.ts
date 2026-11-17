/**
 * Expected build failure (bad config, missing entry/toolchain, failed
 * compile). Library code throws it instead of exiting; `bin/hypen.ts` prints
 * it (`formatBuildError`) and exits non-zero. Lives in its own module so the
 * wasm build (`src/wasm/`) can throw it without pulling in the SPA build.
 */

/**
 * Stable identifiers for build failures. Scripts and tests match on these
 * rather than on message wording.
 */
export type BuildErrorCode =
  /** A failure with no more specific code (the SPA build's errors). */
  | "BUILD_FAILED"
  /** `wasm` in hypen.json has an unknown key or a wrongly-typed value. */
  | "CONFIG_INVALID"
  /** A capability grant names a module that does not exist or is stateless. */
  | "CONFIG_UNKNOWN_MODULE"
  /** The components directory does not exist or is not a directory. */
  | "COMPONENTS_DIR_MISSING"
  /** The components directory holds no components at all. */
  | "NO_COMPONENTS"
  /** Components exist, but none has a module to compile. */
  | "NO_STATEFUL_MODULES"
  /** The entry names no stateful module. */
  | "ENTRY_NOT_FOUND"
  /** A component name cannot be an engine state scope. */
  | "MODULE_NAME_INVALID"
  /** Two component names lowercase to the same scope / output file. */
  | "MODULE_NAME_COLLISION"
  /** Cargo.toml and go.mod both present and `wasm.language` unset. */
  | "LANGUAGE_AMBIGUOUS"
  /** A component carries module sources in a language other than the build's. */
  | "LANGUAGE_MIXED"
  /** The output directory would overwrite sources or non-build files. */
  | "OUTDIR_UNSAFE"
  /** The output directory cannot be created or written. */
  | "OUTDIR_NOT_WRITABLE"
  /** A required tool (jco, tinygo, cargo, …) is not installed. */
  | "TOOLCHAIN_MISSING"
  /** A required tool is installed but too old. */
  | "TOOLCHAIN_VERSION"
  /** A tool ran and exited non-zero (see `tool`). */
  | "TOOL_FAILED"
  /** A tool exited 0 but produced no artifact. */
  | "TOOL_NO_OUTPUT"
  /** A TypeScript module threw (or failed to resolve) while being loaded for discovery. */
  | "MODULE_LOAD_FAILED"
  /** esbuild could not bundle a TypeScript module. */
  | "BUNDLE_FAILED"
  /** A produced `.wasm` is empty, not wasm, or a core module (not a component). */
  | "ARTIFACT_INVALID"
  /** A Rust crate cannot produce a component (no Cargo.toml / no cdylib). */
  | "RUST_CRATE_INVALID"
  /** A Go project's go.mod is missing or declares no module path. */
  | "GO_MODULE_INVALID"
  /** `[package.metadata.hypen] abi` names no known hypen:module ABI. */
  | "ABI_UNKNOWN"
  /** An author-vendored `wit/` contradicts the crate's ABI. */
  | "WIT_MISMATCH"
  /** A prebuilt module's `component` file does not exist. */
  | "PREBUILT_COMPONENT_MISSING"
  /** A prebuilt module's `component` is empty, not wasm, or a core module. */
  | "PREBUILT_COMPONENT_INVALID"
  /** A prebuilt module's `template` file does not exist (or it has none where one is needed). */
  | "PREBUILT_TEMPLATE_MISSING"
  /** The build target cannot run prebuilt (hosted) modules. */
  | "PREBUILT_UNSUPPORTED_TARGET"
  /** A file shipped with the CLI (WIT, shim) is missing: broken install. */
  | "CLI_ASSET_MISSING"
  // ── module packages (hypen-modules.json, `hypen add`) ──
  /** No `hypen-modules.json` where one was expected. */
  | "MANIFEST_NOT_FOUND"
  /** A package manifest is not JSON or has a wrongly-shaped field. */
  | "MANIFEST_INVALID"
  /** A package manifest of a newer format than this CLI reads. */
  | "MANIFEST_VERSION_UNSUPPORTED"
  /** A manifest path points outside the package directory. */
  | "MANIFEST_PATH_ESCAPES"
  /** A file a package manifest lists does not exist. */
  | "MODULE_FILE_MISSING"
  /** A package's component is empty, not wasm, or a core module. */
  | "COMPONENT_INVALID"
  /** A component's bytes do not match the manifest / the reviewed record. */
  | "INTEGRITY_MISMATCH"
  /** An npm package named in `wasm.packages` is not installed. */
  | "PACKAGE_NOT_FOUND"
  /** A package or directory without a Hypen module manifest. */
  | "PACKAGE_NOT_HYPEN"
  /** `hypen.lock.json` is malformed. */
  | "LOCK_INVALID"
  /** A package requests more than was reviewed when it was added. */
  | "REQUESTS_CHANGED"
  /** A package is used but was never reviewed with `hypen add`. */
  | "NOT_RECORDED"
  /** A name the package does not have. */
  | "UNKNOWN_PACKAGE_MODULE"
  /** A built component imports an interface its declaration does not cover. */
  | "UNDECLARED_IMPORT"
  /** An installed component imports an interface it has not been granted. */
  | "UNGRANTED_IMPORT"
  /** An app template uses a package name the package does not export. */
  | "NOT_EXPORTED"
  /** A rename (`--as`) that cannot be made sound. */
  | "RENAME_UNSOUND"
  /** `--only` leaves out something a selected template needs. */
  | "ONLY_INCOMPLETE"
  /** `hypen add <spec>`: the spec names nothing that exists. */
  | "SPEC_NOT_FOUND"
  /** A tarball that is not a readable .tgz. */
  | "TARBALL_INVALID"
  /** A tarball entry that would escape the extraction directory (or a link). */
  | "TARBALL_UNSAFE"
  /** Non-interactive `hypen add` without a decision for every request. */
  | "CONSENT_REQUIRED"
  /** The user declined. */
  | "CANCELLED"
  /** A `--grant` / `--deny` / `--as` / `--only` value that names nothing. */
  | "FLAG_INVALID"
  /** hypen.json (or hypen.lock.json) cannot be written. */
  | "CONFIG_NOT_WRITABLE"
  /** `hypen remove` / `hypen add` named something that is not installed. */
  | "NOT_INSTALLED"
  /** `hypen pack` has no npm name for the package. */
  | "PACK_NAME_MISSING";

/** What a failed subprocess looked like. */
export interface ToolFailure {
  /** The exact argv that ran (`command[0]` is the executable). */
  command: string[];
  cwd: string;
  /** `null` when the process was killed by a signal or never started. */
  exitCode: number | null;
  signal: string | null;
  /** The last lines the tool wrote to stderr (ANSI stripped). */
  stderrTail: string;
  /**
   * Whether the tool's output was already forwarded live to this process's
   * stdio. Printers skip `stderrTail` when it was, to avoid repeating it.
   */
  streamed: boolean;
}

export interface BuildErrorInfo {
  code?: BuildErrorCode;
  /** The module (component) the failure concerns. */
  module?: string;
  /** The file the failure concerns. */
  file?: string;
  /** The config field the failure concerns, e.g. `wasm.modules.Cart.reads`. */
  field?: string;
  /** The subprocess that failed, when one did. */
  tool?: ToolFailure;
  /** Extra context lines (not needed to understand the message). */
  detail?: string[];
  /** One concrete next step. */
  hint?: string;
  cause?: unknown;
}

export class BuildError extends Error {
  readonly code: BuildErrorCode;
  readonly module?: string;
  readonly file?: string;
  readonly field?: string;
  readonly tool?: ToolFailure;
  readonly detail: readonly string[];
  readonly hint?: string;

  constructor(message: string, info: BuildErrorInfo = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = "BuildError";
    this.code = info.code ?? "BUILD_FAILED";
    this.module = info.module;
    this.file = info.file;
    this.field = info.field;
    this.tool = info.tool;
    this.detail = info.detail ?? [];
    this.hint = info.hint;
  }
}

/** POSIX-ish quoting, so a printed command can be pasted into a shell. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The command line of a `ToolFailure`, quoted for a shell. */
export function formatCommand(command: readonly string[]): string {
  return command.map(shellQuote).join(" ");
}

/**
 * Render a `BuildError` for a terminal: the message, then indented context
 * (module / file / field / failed command), then the hint. Plain text — the
 * caller adds the surrounding blank lines and any color.
 */
export function formatBuildError(err: BuildError): string {
  const lines = [`  Build failed: ${err.message}`];
  const context: string[] = [];
  if (err.module) context.push(`module:  ${err.module}`);
  if (err.file) context.push(`file:    ${err.file}`);
  if (err.field) context.push(`field:   ${err.field}`);
  if (err.tool) {
    const { tool } = err;
    context.push(`command: ${formatCommand(tool.command)}`);
    context.push(`cwd:     ${tool.cwd}`);
    context.push(
      tool.exitCode !== null
        ? `exit:    ${tool.exitCode}`
        : `exit:    ${tool.signal ? `killed by ${tool.signal}` : "did not start"}`
    );
    const tail = tool.stderrTail.trim();
    if (tail && !tool.streamed) {
      context.push("stderr:");
      for (const line of tail.split("\n")) context.push(`  ${line}`);
    } else if (tail) {
      context.push("stderr:  (shown above)");
    }
  }
  context.push(...err.detail);
  if (err.code !== "BUILD_FAILED") context.push(`code:    ${err.code}`);
  if (context.length > 0) {
    lines.push("");
    for (const line of context) lines.push(`    ${line}`);
  }
  if (err.hint) {
    lines.push("");
    lines.push(`  Hint: ${err.hint}`);
  }
  return lines.join("\n");
}
