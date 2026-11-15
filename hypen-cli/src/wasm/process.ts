/**
 * Running build tools. Every subprocess goes through `runTool`, which reports
 * what happened as a value (`ToolRun`) instead of throwing, so callers decide
 * what a failure means; `expectSuccess` turns a failed run into the
 * `BuildError` that carries the command, exit code and stderr tail.
 */

import { spawn, type ChildProcess } from "child_process";
import { BuildError, type BuildErrorInfo, type ToolFailure } from "../build-error.js";

export interface RunOptions {
  cwd: string;
  /**
   * `"stream"` forwards the tool's stdout/stderr to this process as it runs
   * (compiler diagnostics, progress); `"quiet"` only collects them (version
   * probes, metadata queries).
   */
  output: "stream" | "quiet";
  /**
   * Collect stdout instead of forwarding it — for tools whose stdout is data
   * (cargo's JSON messages). stderr still follows `output`.
   */
  captureStdout?: boolean;
  /** Extra environment, merged over `process.env`. */
  env?: Record<string, string>;
}

/** How a subprocess ended. */
export type ToolRun =
  | { status: "ok"; stdout: string; stderr: string }
  /** It ran and exited non-zero, or was killed by a signal. */
  | { status: "failed"; failure: ToolFailure }
  /** It could not be started at all (`ENOENT`: not installed / not on PATH). */
  | { status: "not-started"; failure: ToolFailure; errno: string | undefined };

/** Enough for a compiler's last error and its context, without flooding a terminal. */
const STDERR_TAIL_LINES = 40;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function tail(text: string): string {
  const lines = text.replace(ANSI, "").trimEnd().split("\n");
  return lines.slice(-STDERR_TAIL_LINES).join("\n");
}

/** Tools currently running, so an interrupted build can take them down with it. */
const running = new Set<ChildProcess>();

/**
 * Signal every tool still running. A terminal's Ctrl-C reaches the whole
 * process group on its own; a signal sent to the CLI alone (a supervisor's
 * SIGTERM) would otherwise orphan a compiler mid-build.
 */
export function killRunningTools(signal: NodeJS.Signals): void {
  for (const child of running) child.kill(signal);
}

export function runTool(cmd: string, args: string[], options: RunOptions): Promise<ToolRun> {
  const command = [cmd, ...args];
  const streamed = options.output === "stream";
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (options.captureStdout || !streamed) stdout += chunk;
      else process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (streamed) process.stderr.write(chunk);
    });
    const failure = (exitCode: number | null, signal: string | null): ToolFailure => ({
      command,
      cwd: options.cwd,
      exitCode,
      signal,
      stderrTail: tail(stderr),
      streamed,
    });
    let settled = false;
    const settle = (run: ToolRun) => {
      running.delete(child);
      if (settled) return;
      settled = true;
      resolvePromise(run);
    };
    child.on("error", (e: NodeJS.ErrnoException) => {
      stderr += e.message;
      settle({ status: "not-started", failure: { ...failure(null, null), streamed: false }, errno: e.code });
    });
    // `close` (not `exit`): stdio must be fully drained before the captured
    // output is read.
    child.on("close", (code, signal) => {
      settle(
        code === 0
          ? { status: "ok", stdout, stderr }
          : { status: "failed", failure: failure(code, signal) }
      );
    });
  });
}

/**
 * Unwrap a successful run, or throw `TOOL_FAILED` describing the subprocess.
 * `what` names the step for the message ("cargo build", "jco componentize").
 */
export function expectSuccess(
  run: ToolRun,
  what: string,
  info: Pick<BuildErrorInfo, "module" | "file" | "hint"> = {}
): { stdout: string; stderr: string } {
  if (run.status === "ok") return run;
  const { failure } = run;
  if (run.status === "not-started") {
    throw new BuildError(`could not start ${what}: ${failure.stderrTail || "spawn failed"}`, {
      ...info,
      code: run.errno === "ENOENT" ? "TOOLCHAIN_MISSING" : "TOOL_FAILED",
      tool: failure,
      hint:
        run.errno === "ENOENT"
          ? `"${failure.command[0]}" was not found: install it or put it on PATH`
          : info.hint,
    });
  }
  const how =
    failure.exitCode !== null
      ? `exited with code ${failure.exitCode}`
      : `was killed by ${failure.signal ?? "a signal"}`;
  throw new BuildError(`${what} ${how}`, { ...info, code: "TOOL_FAILED", tool: failure });
}
