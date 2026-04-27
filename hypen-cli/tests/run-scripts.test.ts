import { describe, expect, test } from "bun:test";
import {
  validateScript,
  executeScript,
  type RunScript,
  type RunEvent,
} from "../src/studio/run-scripts";

// ─── Helpers ───────────────────────────────────────────────────────────

/** Drain an async generator into a plain array — lets us assert on event
 *  sequences with ordinary expect().toEqual(). */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

/** A minimal script with one shell step. */
function scriptWithShell(cmd: string): RunScript {
  return {
    id: "t",
    name: "t",
    steps: [{ type: "shell", cmd }],
  };
}

// ─── validateScript ────────────────────────────────────────────────────

describe("validateScript", () => {
  test("accepts well-formed script with all step types", () => {
    const raw = {
      id: "gallery",
      name: "Gallery test",
      steps: [
        { type: "install-gallery", platform: "android" },
        { type: "shell", cmd: "echo hi", cwd: "." },
        { type: "open-in-gallery", url: "localhost:3000", platform: "android" },
        { type: "hypen-run", platform: "ios", url: "localhost:5173/ws/engine" },
      ],
    };
    const v = validateScript(raw);
    expect(v).not.toBeNull();
    expect(v!.id).toBe("gallery");
    expect(v!.steps).toHaveLength(4);
  });

  test("rejects when id or name missing", () => {
    expect(validateScript({ name: "x", steps: [] })).toBeNull();
    expect(validateScript({ id: "x", steps: [] })).toBeNull();
  });

  test("rejects non-object input", () => {
    expect(validateScript(null)).toBeNull();
    expect(validateScript(42)).toBeNull();
    expect(validateScript("a string")).toBeNull();
  });

  test("rejects when steps is not an array", () => {
    expect(validateScript({ id: "x", name: "y", steps: {} })).toBeNull();
  });

  test("filters out invalid step entries without rejecting the script", () => {
    const v = validateScript({
      id: "x",
      name: "y",
      steps: [
        { type: "shell", cmd: "echo 1" },
        { type: "shell" },                // missing cmd — dropped
        { type: "bogus" },                // unknown type — dropped
        { type: "install-gallery", platform: "windows" }, // bad platform
        { type: "install-gallery", platform: "ios" },
      ],
    });
    expect(v).not.toBeNull();
    expect(v!.steps).toHaveLength(2);
    expect(v!.steps[0]).toEqual({ type: "shell", cmd: "echo 1", cwd: undefined });
    expect(v!.steps[1]).toEqual({ type: "install-gallery", platform: "ios" });
  });

  test("rejects shell step with empty/whitespace cmd", () => {
    const v = validateScript({
      id: "x", name: "y",
      steps: [{ type: "shell", cmd: "   " }],
    });
    expect(v!.steps).toHaveLength(0);
  });

  test("rejects open-in-gallery without url or with bad platform", () => {
    const v = validateScript({
      id: "x", name: "y",
      steps: [
        { type: "open-in-gallery", platform: "android" },                      // no url
        { type: "open-in-gallery", url: "localhost:3000", platform: "linux" }, // bad platform
        { type: "open-in-gallery", url: "localhost:3000", platform: "android" },
      ],
    });
    expect(v!.steps).toHaveLength(1);
  });
});

// ─── executeScript ─────────────────────────────────────────────────────

describe("executeScript — shell", () => {
  test("happy path: script-start → step-start → log → step-done → script-done", async () => {
    const events = await collect(
      executeScript(scriptWithShell("echo hi"), { projectDir: "/tmp" }),
    );
    // We expect exactly these types in order (payloads checked separately).
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "script-start",
      "step-start",
      "log",            // the `$ echo hi` heading from runShell
      "log",            // "hi" from stdout
      "step-done",
      "script-done",
    ]);

    const scriptStart = events[0] as Extract<RunEvent, { type: "script-start" }>;
    expect(scriptStart.scriptId).toBe("t");
    expect(scriptStart.totalSteps).toBe(1);

    const logs = events.filter((e) => e.type === "log") as Array<Extract<RunEvent, { type: "log" }>>;
    expect(logs[0].msg).toContain("echo hi");
    expect(logs[1].msg).toBe("hi");
    expect(logs.every((l) => l.index === 0)).toBe(true);
  });

  test("non-zero exit produces step-error then script-error, halts further steps", async () => {
    const script: RunScript = {
      id: "t2",
      name: "t2",
      steps: [
        { type: "shell", cmd: "sh -c 'exit 3'" },
        // Second step should never run because step 0 fails.
        { type: "shell", cmd: "echo should-not-run" },
      ],
    };
    const events = await collect(executeScript(script, { projectDir: "/tmp" }));

    // step-start for index 0, then step-error, then script-error. No events
    // referencing index 1.
    const hasIndex1 = events.some(
      (e) => (e as any).index === 1 || (e.type === "log" && (e as any).index === 1),
    );
    expect(hasIndex1).toBe(false);

    const stepErr = events.find((e) => e.type === "step-error") as Extract<RunEvent, { type: "step-error" }>;
    expect(stepErr).toBeDefined();
    expect(stepErr.index).toBe(0);
    expect(stepErr.msg).toContain("code 3");

    expect(events[events.length - 1].type).toBe("script-error");
  });

  test("captures stderr as warn-level logs", async () => {
    const events = await collect(
      executeScript(
        scriptWithShell("sh -c 'echo out; echo err 1>&2'"),
        { projectDir: "/tmp" },
      ),
    );
    const logs = events.filter((e) => e.type === "log") as Array<Extract<RunEvent, { type: "log" }>>;
    const warns = logs.filter((l) => l.level === "warn");
    const infos = logs.filter((l) => l.level === "info");
    expect(warns.some((l) => l.msg === "err")).toBe(true);
    expect(infos.some((l) => l.msg === "out")).toBe(true);
  });
});

describe("executeScript — abort", () => {
  test("pre-aborted signal short-circuits before any step runs", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const script: RunScript = {
      id: "t3",
      name: "t3",
      steps: [
        { type: "shell", cmd: "echo should-not-run" },
        { type: "shell", cmd: "echo also-not" },
      ],
    };
    const events = await collect(
      executeScript(script, { projectDir: "/tmp", signal: ctrl.signal }),
    );
    // We should see script-start then script-error cancelled — no step-start.
    expect(events.map((e) => e.type)).toEqual(["script-start", "script-error"]);
    const err = events[1] as Extract<RunEvent, { type: "script-error" }>;
    expect(err.msg).toBe("cancelled");
  });

  test("abort between steps halts remaining steps", async () => {
    // Trigger abort as soon as the first step completes. We do that by
    // arming the signal on `step-done` of index 0.
    const ctrl = new AbortController();
    const script: RunScript = {
      id: "t4",
      name: "t4",
      steps: [
        { type: "shell", cmd: "echo first" },
        { type: "shell", cmd: "echo second-should-not-run" },
      ],
    };
    const events: RunEvent[] = [];
    for await (const e of executeScript(script, { projectDir: "/tmp", signal: ctrl.signal })) {
      events.push(e);
      if (e.type === "step-done" && e.index === 0) ctrl.abort();
    }

    // Step 1 never emits a step-start.
    const step1Starts = events.filter(
      (e) => e.type === "step-start" && (e as any).index === 1,
    );
    expect(step1Starts).toHaveLength(0);
    expect(events[events.length - 1].type).toBe("script-error");
  });
});
