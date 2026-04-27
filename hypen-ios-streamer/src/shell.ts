import type { Shell, BinaryShell } from "./types.ts";

/**
 * Default Shell implementation using Bun.spawn.
 * Returns decoded stdout/stderr text.
 */
export const bunShell: Shell = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts?.input ? "pipe" : "ignore",
  });

  if (opts?.input) {
    proc.stdin?.write(opts.input);
    proc.stdin?.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
};

/**
 * Binary Shell implementation — keeps stdout as raw bytes (e.g. JPEG screenshot).
 */
export const bunBinaryShell: BinaryShell = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });

  const [stdoutBuf, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: new Uint8Array(stdoutBuf), stderr, exitCode };
};

export async function commandExists(cmd: string, shell: Shell = bunShell): Promise<boolean> {
  const { exitCode } = await shell(["which", cmd]);
  return exitCode === 0;
}
