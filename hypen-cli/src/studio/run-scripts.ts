/**
 * Custom run scripts — user-defined sequences of steps that the Run menu
 * exposes alongside the built-in "Run on Android/iOS" actions.
 *
 * Scripts live in hypen.json under `runScripts[]`. Each step is a tagged
 * union so we can add step types without breaking old configs. The
 * executor is an async generator so the HTTP/WS layer can stream log
 * events into the Studio console in real time.
 *
 * Step vocabulary (V1):
 *   install-gallery  — download & stage the Hypen Runner app for android/ios
 *   shell            — run an arbitrary command; stdout/stderr streamed
 *   open-in-gallery  — deep-link the runner app to a ws URL, rewriting
 *                      localhost → 10.0.2.2 for Android emulators
 *   hypen-run        — end-to-end "install + launch" shortcut
 */

import { resolve } from "path";
import {
  RUNNER_PATHS,
  exec,
  ensureAndroidRunner,
  ensureIOSRunner,
} from "../run.js";
import { normaliseRunUrl } from "./run-device.js";

// ─── Types ─────────────────────────────────────────────────────────────

export type Platform = "android" | "ios";

export type InstallGalleryStep = { type: "install-gallery"; platform: Platform };
export type ShellStep = { type: "shell"; cmd: string; cwd?: string };
export type OpenInGalleryStep = {
  type: "open-in-gallery";
  url: string;
  platform: Platform;
  /** Optional explicit device/simulator id. When unset, dispatches to the
   *  first matching booted device. */
  deviceId?: string;
};
export type HypenRunStep = { type: "hypen-run"; platform: Platform; url?: string };

export type Step = InstallGalleryStep | ShellStep | OpenInGalleryStep | HypenRunStep;

export interface RunScript {
  id: string;
  name: string;
  description?: string;
  steps: Step[];
}

// ─── Events streamed to the caller ─────────────────────────────────────

export type RunEvent =
  | { type: "script-start"; scriptId: string; totalSteps: number }
  | { type: "step-start"; index: number; step: Step }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string; index: number }
  | { type: "step-done"; index: number }
  | { type: "step-error"; index: number; msg: string }
  | { type: "script-done"; scriptId: string }
  | { type: "script-error"; scriptId: string; msg: string };

export interface RunContext {
  /** Working directory for `shell` steps if they don't specify one. */
  projectDir: string;
  /** AbortSignal for cancelling mid-run. */
  signal?: AbortSignal;
}

// ─── Step handlers ─────────────────────────────────────────────────────
//
// Each handler is an async generator of { level, msg } logs. The top-level
// executor wraps them with step-start / step-done events.

async function* runInstallGallery(
  step: InstallGalleryStep,
): AsyncGenerator<{ level: "info" | "warn" | "error"; msg: string }> {
  yield { level: "info", msg: `Installing Hypen Gallery for ${step.platform}…` };
  const ok = step.platform === "android"
    ? await ensureAndroidRunner()
    : await ensureIOSRunner();
  if (!ok) {
    throw new Error(`Failed to download ${step.platform} runner app.`);
  }
  const path = step.platform === "android" ? RUNNER_PATHS.android : RUNNER_PATHS.ios;
  yield { level: "info", msg: `Runner ready at ${path}` };
}

async function* runShell(
  step: ShellStep,
  ctx: RunContext,
): AsyncGenerator<{ level: "info" | "warn" | "error"; msg: string }> {
  yield { level: "info", msg: `$ ${step.cmd}` };
  const cwd = step.cwd ? resolve(ctx.projectDir, step.cwd) : ctx.projectDir;
  // Spawn via /bin/sh so users can write shell-y things: pipes, &&, quotes.
  const proc = Bun.spawn(["/bin/sh", "-c", step.cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Pump stdout + stderr line-by-line. Hoist into arrays so we can yield
  // interleaved without racing.
  const decoder = new TextDecoder();
  const pump = async function* (
    stream: ReadableStream<Uint8Array>,
    level: "info" | "warn" | "error",
  ): AsyncGenerator<{ level: "info" | "warn" | "error"; msg: string }> {
    const reader = stream.getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) yield { level, msg: line };
        }
      }
      if (buffer.length > 0) yield { level, msg: buffer };
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  };

  // Merge both streams. We race their `next()` calls and pick whichever
  // comes first, which keeps ordering close to what the user would see
  // in a terminal while avoiding the buffering headaches of joining them
  // via a Promise.all.
  const stdoutGen = pump(proc.stdout as ReadableStream<Uint8Array>, "info");
  const stderrGen = pump(proc.stderr as ReadableStream<Uint8Array>, "warn");

  type Labelled = { g: AsyncGenerator<any>; next: Promise<IteratorResult<any>> };
  const pending: Labelled[] = [
    { g: stdoutGen, next: stdoutGen.next() },
    { g: stderrGen, next: stderrGen.next() },
  ];
  while (pending.length > 0) {
    const winner = await Promise.race(pending.map((p, i) =>
      p.next.then((r) => ({ i, r }))
    ));
    const entry = pending[winner.i];
    if (winner.r.done) {
      pending.splice(winner.i, 1);
    } else {
      yield winner.r.value;
      entry.next = entry.g.next();
    }
  }

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Shell command exited with code ${code}: ${step.cmd}`);
  }
}

async function* runOpenInGallery(
  step: OpenInGalleryStep,
): AsyncGenerator<{ level: "info" | "warn" | "error"; msg: string }> {
  // Heuristic: "emulator" / "simulator" when the id format hints at it,
  // otherwise "physical". normaliseRunUrl rewrites localhost → 10.0.2.2
  // only for android emulators — matters because emulator/localhost
  // loops back to the emulator itself, not the host.
  const deviceType: "emulator" | "physical" | "simulator" =
    step.platform === "ios"
      ? "simulator"
      : /^emulator-/i.test(step.deviceId ?? "") ? "emulator" : "physical";
  const wsUrl = normaliseRunUrl(step.url, step.platform, deviceType);
  const deepLink = `hypenpreview://connect?url=${encodeURIComponent(wsUrl)}`;
  yield { level: "info", msg: `Opening gallery at ${wsUrl}` };

  if (step.platform === "android") {
    const args = ["adb"];
    if (step.deviceId) args.push("-s", step.deviceId);
    args.push("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", deepLink);
    const { exitCode, stderr } = await exec(args);
    if (exitCode !== 0) throw new Error(`adb launch failed: ${stderr.trim()}`);
  } else {
    const udid = step.deviceId ?? "booted";
    const { exitCode, stderr } = await exec(["xcrun", "simctl", "openurl", udid, deepLink]);
    if (exitCode !== 0) throw new Error(`simctl openurl failed: ${stderr.trim()}`);
  }
  yield { level: "info", msg: "Gallery launched." };
}

async function* runHypenRun(
  step: HypenRunStep,
  ctx: RunContext,
): AsyncGenerator<{ level: "info" | "warn" | "error"; msg: string }> {
  // Compose out of install + open-in-gallery. Keeps the step vocabulary
  // expressive without duplicating install logic here.
  yield* runInstallGallery({ type: "install-gallery", platform: step.platform });
  const url = step.url ?? "localhost:5173/ws/engine";
  yield* runOpenInGallery({
    type: "open-in-gallery",
    url,
    platform: step.platform,
  });
}

// ─── Script executor ───────────────────────────────────────────────────

export async function* executeScript(
  script: RunScript,
  ctx: RunContext,
): AsyncGenerator<RunEvent> {
  yield { type: "script-start", scriptId: script.id, totalSteps: script.steps.length };

  for (let i = 0; i < script.steps.length; i++) {
    if (ctx.signal?.aborted) {
      yield { type: "script-error", scriptId: script.id, msg: "cancelled" };
      return;
    }
    const step = script.steps[i];
    yield { type: "step-start", index: i, step };
    try {
      const gen = dispatchStep(step, ctx);
      for await (const log of gen) {
        yield { type: "log", level: log.level, msg: log.msg, index: i };
      }
      yield { type: "step-done", index: i };
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      yield { type: "step-error", index: i, msg };
      yield { type: "script-error", scriptId: script.id, msg };
      return;
    }
  }

  yield { type: "script-done", scriptId: script.id };
}

function dispatchStep(step: Step, ctx: RunContext): AsyncGenerator<{ level: "info" | "warn" | "error"; msg: string }> {
  switch (step.type) {
    case "install-gallery":
      return runInstallGallery(step);
    case "shell":
      return runShell(step, ctx);
    case "open-in-gallery":
      return runOpenInGallery(step);
    case "hypen-run":
      return runHypenRun(step, ctx);
    default: {
      // Exhaustiveness check — TS will yell if a case is missed above.
      const _exhaustive: never = step;
      void _exhaustive;
      throw new Error(`Unknown step type: ${(step as any)?.type}`);
    }
  }
}

// ─── Script registry helpers ───────────────────────────────────────────

/**
 * Sanity-check a persisted script. Shapes that don't parse get filtered
 * out with a console warning — better than crashing studio on a typo.
 */
export function validateScript(raw: unknown): RunScript | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  if (!Array.isArray(r.steps)) return null;
  const steps: Step[] = [];
  for (const s of r.steps) {
    const validated = validateStep(s);
    if (validated) steps.push(validated);
  }
  return { id: r.id, name: r.name, description: r.description, steps };
}

function validateStep(raw: unknown): Step | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;
  switch (r.type) {
    case "install-gallery":
      if (r.platform !== "android" && r.platform !== "ios") return null;
      return { type: "install-gallery", platform: r.platform };
    case "shell":
      if (typeof r.cmd !== "string" || !r.cmd.trim()) return null;
      return { type: "shell", cmd: r.cmd, cwd: typeof r.cwd === "string" ? r.cwd : undefined };
    case "open-in-gallery":
      if (typeof r.url !== "string" || !r.url.trim()) return null;
      if (r.platform !== "android" && r.platform !== "ios") return null;
      return {
        type: "open-in-gallery",
        url: r.url,
        platform: r.platform,
        deviceId: typeof r.deviceId === "string" ? r.deviceId : undefined,
      };
    case "hypen-run":
      if (r.platform !== "android" && r.platform !== "ios") return null;
      return {
        type: "hypen-run",
        platform: r.platform,
        url: typeof r.url === "string" ? r.url : undefined,
      };
    default:
      return null;
  }
}
