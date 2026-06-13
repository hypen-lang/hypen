import { describe, it, expect } from "bun:test";
import { BaseEngine } from "@hypen-space/core/engine-base";
import type { Action, ActionHandler } from "@hypen-space/core/types";

/**
 * BaseEngine.normalizeAction is the default fix for the wasm-bindgen web
 * target's landmine: it returns structured action payloads as JS `Map`
 * instances, so a handler reading `payload.to` would get `undefined` and
 * `@router.push, to: "/x"` would silently no-op. The conversion now lives in
 * the base class so every web-target consumer (browser engine, CFEngine, any
 * future runtime) inherits it. These tests pin that behaviour and the node
 * subclass's identity opt-out.
 */

/**
 * A BaseEngine subclass over a fake wasm engine. The fake's `onAction` just
 * stores the registered callback; `emit()` invokes it the way the real WASM
 * runtime would when an action fires, exercising the full
 * onAction -> normalizeAction -> handler path.
 */
class FakeEngine extends BaseEngine {
  private cb: ((action: Action) => void) | null = null;

  async init(): Promise<void> {
    this.wasmEngine = {
      onAction: (_name: string, cb: (action: Action) => void) => {
        this.cb = cb;
      },
    };
    this.initialized = true;
  }

  protected unwrapForWasm<T>(value: T): T {
    return value;
  }

  /** Simulate the WASM runtime firing the registered action. */
  emit(action: Action): void {
    this.cb?.(action);
  }
}

/** A node-style subclass that opts out of the Map walk (identity). */
class IdentityEngine extends FakeEngine {
  protected override normalizeAction(action: Action): Action {
    return action;
  }
}

function capture(engine: FakeEngine): { last: () => Action | null } {
  let last: Action | null = null;
  const handler: ActionHandler = (action) => {
    last = action;
  };
  engine.onAction("act", handler);
  return { last: () => last };
}

describe("BaseEngine.normalizeAction (default Map → object)", () => {
  it("converts a top-level Map payload into a plain object", async () => {
    const engine = new FakeEngine();
    await engine.init();
    const got = capture(engine);

    engine.emit({
      name: "act",
      payload: new Map<string, unknown>([["to", "/diary"]]),
    } as unknown as Action);

    const payload = got.last()?.payload as any;
    expect(payload instanceof Map).toBe(false);
    expect(payload.to).toBe("/diary");
  });

  it("converts nested Maps and Maps inside arrays", async () => {
    const engine = new FakeEngine();
    await engine.init();
    const got = capture(engine);

    engine.emit({
      name: "act",
      payload: new Map<string, unknown>([
        ["nested", new Map([["k", 1]])],
        ["list", [new Map([["x", 2]])]],
      ]),
    } as unknown as Action);

    const payload = got.last()?.payload as any;
    expect(payload.nested.k).toBe(1);
    expect(payload.list[0].x).toBe(2);
    expect(payload.nested instanceof Map).toBe(false);
  });

  it("leaves plain-object payloads structurally intact", async () => {
    const engine = new FakeEngine();
    await engine.init();
    const got = capture(engine);

    engine.emit({ name: "act", payload: { to: "/x", n: 3 } } as Action);

    expect(got.last()?.payload).toEqual({ to: "/x", n: 3 });
  });

  it("passes through a null / absent payload unchanged", async () => {
    const engine = new FakeEngine();
    await engine.init();
    const got = capture(engine);

    engine.emit({ name: "act", payload: null } as unknown as Action);
    expect(got.last()?.payload).toBeNull();
  });

  it("does not descend into class instances (e.g. Date)", async () => {
    const engine = new FakeEngine();
    await engine.init();
    const got = capture(engine);
    const d = new Date(0);

    engine.emit({
      name: "act",
      payload: new Map<string, unknown>([["when", d]]),
    } as unknown as Action);

    expect((got.last()?.payload as any).when).toBe(d);
  });

  it("a subclass can opt out with an identity override (node target)", async () => {
    const engine = new IdentityEngine();
    await engine.init();
    const got = capture(engine);
    const payload = new Map<string, unknown>([["to", "/x"]]);

    engine.emit({ name: "act", payload } as unknown as Action);

    // Identity: the Map is handed through untouched.
    expect(got.last()?.payload).toBe(payload);
  });
});
