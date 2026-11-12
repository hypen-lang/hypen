/**
 * The browser engine wrapper asks the engine to park removed nodes and frees
 * them when the browser is idle (`Engine.enableDeferredRelease`). The WASM
 * side is covered by the engine's own tests; this pins the wrapper's
 * scheduling against a stand-in engine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Engine } from "../packages/web-engine/src/engine";

type Idle = (cb: () => void, opts?: { timeout: number }) => number;
const realIdle = (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback;
afterEach(() => {
  (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback = realIdle;
});

function setup(options: { idle: boolean; hooks: boolean }) {
  const queued: Array<() => void> = [];
  (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback = options.idle
    ? (cb) => queued.push(cb)
    : undefined;
  const calls: string[] = [];
  let pending = 0;
  const wasm: Record<string, unknown> = {
    updateStateSparseJson: () => {
      calls.push("update");
      pending += 17;
    },
  };
  if (options.hooks) {
    wasm.setDeferredRelease = (on: boolean) => calls.push(`defer:${on}`);
    wasm.pendingRelease = () => pending;
    wasm.releaseRemoved = () => {
      calls.push("release");
      pending = 0;
    };
  }
  const engine = new Engine() as unknown as {
    wasmEngine: unknown;
    initialized: boolean;
    enableDeferredRelease(): void;
    updateStateSparse(scope: string | null, paths: string[], values: Record<string, unknown>): void;
  };
  engine.wasmEngine = wasm;
  engine.initialized = true;
  engine.enableDeferredRelease();
  return { engine, calls, queued };
}

describe("browser engine: deferred release of removed nodes", () => {
  test("releases once, at idle time, however many updates ran", () => {
    const { engine, calls, queued } = setup({ idle: true, hooks: true });
    expect(calls).toEqual(["defer:true"]);

    engine.updateStateSparse(null, ["a"], { a: 1 });
    engine.updateStateSparse(null, ["a"], { a: 2 });
    expect(calls).toEqual(["defer:true", "update", "update"]);
    expect(queued.length).toBe(1);

    queued.shift()!();
    expect(calls.at(-1)).toBe("release");

    // A later update queues a fresh release.
    engine.updateStateSparse(null, ["a"], { a: 3 });
    expect(queued.length).toBe(1);
  });

  test("an update that removed nothing queues nothing", () => {
    const { engine, queued } = setup({ idle: true, hooks: true });
    engine.updateStateSparse(null, [], {});
    expect(queued.length).toBe(0);
  });

  test("stays off without requestIdleCallback or without the engine hooks", () => {
    const noIdle = setup({ idle: false, hooks: true });
    noIdle.engine.updateStateSparse(null, ["a"], { a: 1 });
    expect(noIdle.calls).toEqual(["update"]);

    const oldEngine = setup({ idle: true, hooks: false });
    oldEngine.engine.updateStateSparse(null, ["a"], { a: 1 });
    expect(oldEngine.calls).toEqual(["update"]);
    expect(oldEngine.queued.length).toBe(0);
  });

  test("a release queued for an engine that has since been freed does not throw", () => {
    const { engine, queued } = setup({ idle: true, hooks: true });
    engine.updateStateSparse(null, ["a"], { a: 1 });
    (engine.wasmEngine as { releaseRemoved: () => void }).releaseRemoved = () => {
      throw new Error("null pointer passed to rust");
    };
    expect(() => queued.shift()!()).not.toThrow();
  });
});
