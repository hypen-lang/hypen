import { testActionHandler } from "./helpers";
import { semanticAction } from "./helpers";
/**
 * Transaction-scoped animation (Option D cheap subset, issue #153) — the SDK
 * and dispatch-boundary half:
 *
 * 1. Pending-transaction plumbing in `HypenModuleInstance`: an action's
 *    `animate` stamp is consumed by the FIRST observable-state flush the
 *    handler produces (passed as `updateStateSparse`'s 4th argument), every
 *    later flush is unstamped, mutations after an `await` are unstamped, and
 *    a handler that never mutates leaves nothing pending.
 *
 * 2. `animate:` extraction at the renderers: the event applicator's
 *    `animate` argument never reaches the dispatched payload's user keys —
 *    it crosses the engine boundary under the reserved ACTION_ANIMATE_KEY
 *    (DOM `extractActionDetails` / canvas `resolveEventAction`), and
 *    `BaseEngine.onAction` lifts it back out into the distinct
 *    `Action.animate` field, stripping the reserved key from the payload.
 *
 * Patterns: app.test.ts (FakeEngine + HypenModuleInstance),
 * dom.renderer.test.ts (fake-dom + StubEngine click dispatch),
 * engine-normalize-action.test.ts (BaseEngine over a fake wasm engine).
 */

import { describe, test, expect } from "bun:test";
import { app, HypenModuleInstance } from "../packages/core/src/app";
import type { IEngine as Engine } from "../packages/core/src/app";
import { BaseEngine } from "../packages/core/src/engine-base";
import { ACTION_ANIMATE_KEY } from "../packages/core/src/types";
import type { Action, ActionHandler, Patch } from "../packages/core/src/types";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { resolveEventAction } from "../packages/web/src/canvas/props";
import { dispatchNodeEvent } from "../packages/web/src/canvas/dispatch";
import { flushMicrotasks } from "./helpers";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

// ---------------------------------------------------------------------------
// 1. SDK pending-transaction plumbing (HypenModuleInstance)
// ---------------------------------------------------------------------------

type NotifyCall = {
  scope: string | null;
  paths: string[];
  values: Record<string, unknown>;
  animation: unknown;
};

class FakeEngine {
  public notifyCalls: NotifyCall[] = [];
  public actionHandlers = new Map<string, (action: Action) => void | Promise<void>>();

  setModule(): void {}
  registerModule(): void {}

  updateStateSparse(
    scope: string | null,
    paths: string[],
    values: Record<string, unknown>,
    animation?: unknown
  ): void {
    this.notifyCalls.push({
      scope,
      paths,
      values: JSON.parse(JSON.stringify(values)),
      animation,
    });
  }

  onAction(name: string, handler: (action: Action) => void | Promise<void>): void {
    this.actionHandlers.set(name, handler);
  }

  /** Fire a registered action the way the engine boundary would. */
  dispatch(name: string, animate?: unknown, payload?: unknown): Promise<void> | void {
    const handler = testActionHandler(this.actionHandlers, name);
    if (!handler) throw new Error(`no handler for ${name}`);
    const action: Action = { name, payload };
    if (animate !== undefined) action.animate = animate;
    return handler(action);
  }
}

function makeInstance(definitionBuilderResult: any): { engine: FakeEngine; instance: HypenModuleInstance } {
  const engine = new FakeEngine();
  const instance = new HypenModuleInstance(
    engine as unknown as Engine,
    definitionBuilderResult
  );
  return { engine, instance };
}

describe("transaction animation: pending-stamp consumption (SDK)", () => {
  test("the first flush after a stamped action is stamped; a later flush is not", async () => {
    const { engine, instance } = makeInstance(
      app
        .defineState({ count: 0 })
        .onAction("bump", ({ state }) => {
          state.count += 1;
        })
        .build()
    );
    await instance.waitForReady();

    await engine.dispatch("bump", "spring");
    await flushMicrotasks(3);

    expect(engine.notifyCalls.length).toBe(1);
    expect(engine.notifyCalls[0].paths).toEqual(["count"]);
    expect(engine.notifyCalls[0].animation).toBe("spring");

    // A subsequent, unrelated mutation flushes UNSTAMPED — the stamp was
    // consumed by (and cleared after) the first flush.
    (instance.getLiveState() as any).count = 42;
    await flushMicrotasks(2);

    expect(engine.notifyCalls.length).toBe(2);
    expect(engine.notifyCalls[1].animation).toBeUndefined();
  });

  test("two flushes from one handler: sync mutation stamped, post-await mutation unstamped", async () => {
    const { engine, instance } = makeInstance(
      app
        .defineState({ count: 0 })
        .onAction("twoPhase", async ({ state }) => {
          state.count = 1; // flush 1 — stamped
          await Promise.resolve();
          state.count = 2; // flush 2 — after an await: unstamped
        })
        .build()
    );
    await instance.waitForReady();

    await engine.dispatch("twoPhase", "easeOut");
    await flushMicrotasks(4);

    expect(engine.notifyCalls.length).toBe(2);
    expect(engine.notifyCalls[0].values.count).toBe(1);
    expect(engine.notifyCalls[0].animation).toBe("easeOut");
    expect(engine.notifyCalls[1].values.count).toBe(2);
    expect(engine.notifyCalls[1].animation).toBeUndefined();
  });

  test("a handler whose ONLY mutation is after an await flushes unstamped", async () => {
    const { engine, instance } = makeInstance(
      app
        .defineState({ count: 0 })
        .onAction("later", async ({ state }) => {
          await Promise.resolve();
          state.count = 7;
        })
        .build()
    );
    await instance.waitForReady();

    await engine.dispatch("later", "spring");
    await flushMicrotasks(4);

    expect(engine.notifyCalls.length).toBe(1);
    expect(engine.notifyCalls[0].values.count).toBe(7);
    expect(engine.notifyCalls[0].animation).toBeUndefined();
  });

  test("a stamped handler that never mutates leaves nothing pending", async () => {
    const { engine, instance } = makeInstance(
      app
        .defineState({ count: 0 })
        .onAction("noop", async () => {
          // no state mutation
        })
        .build()
    );
    await instance.waitForReady();

    await engine.dispatch("noop", "spring");
    await flushMicrotasks(3);
    expect(engine.notifyCalls.length).toBe(0);

    // The next flush — from ANY source — must be unstamped.
    (instance.getLiveState() as any).count = 5;
    await flushMicrotasks(2);

    expect(engine.notifyCalls.length).toBe(1);
    expect(engine.notifyCalls[0].animation).toBeUndefined();
  });

  test("a PRE-QUEUED mutation (e.g. .bind) in the same task flushes UNSTAMPED before the stamped handler flush", async () => {
    const { engine, instance } = makeInstance(
      app
        .defineState({ count: 0 })
        .onAction("bump", ({ state }) => {
          state.count += 1;
        })
        .build()
    );
    await instance.waitForReady();

    // Same task: a direct mutation (the .bind path) queues a flush, THEN a
    // stamped dispatch arrives before that flush's microtask runs.
    (instance.getLiveState() as any).count = 5;
    const dispatched = engine.dispatch("bump", "spring");
    await dispatched;
    await flushMicrotasks(4);

    expect(engine.notifyCalls.length).toBe(2);
    // The pre-queued mutation was drained synchronously at dispatch entry —
    // unstamped, and NOT coalesced into the handler's stamped flush.
    expect(engine.notifyCalls[0].values.count).toBe(5);
    expect(engine.notifyCalls[0].animation).toBeUndefined();
    // The handler's own flush carries the stamp.
    expect(engine.notifyCalls[1].values.count).toBe(6);
    expect(engine.notifyCalls[1].animation).toBe("spring");
  });

  test("two stamped dispatches in one task: each handler's mutations flush with its OWN stamp", async () => {
    const { engine, instance } = makeInstance(
      app
        .defineState({ count: 0 })
        .onAction("bump", ({ state }) => {
          state.count += 1;
        })
        .build()
    );
    await instance.waitForReady();

    // Both dispatches fire in the same task (no await between them).
    const p1 = engine.dispatch("bump", "spring");
    const p2 = engine.dispatch("bump", "easeOut");
    await Promise.all([p1, p2]);
    await flushMicrotasks(4);

    // The second dispatch's entry drain flushes the first handler's queued
    // mutations while the FIRST stamp is still pending — so each dispatch's
    // mutations glide with its own spec instead of coalescing under one.
    expect(engine.notifyCalls.length).toBe(2);
    expect(engine.notifyCalls[0].values.count).toBe(1);
    expect(engine.notifyCalls[0].animation).toBe("spring");
    expect(engine.notifyCalls[1].values.count).toBe(2);
    expect(engine.notifyCalls[1].animation).toBe("easeOut");
  });

  test("two stamped dispatches, first handler never mutates: LAST stamp wins the single flush", async () => {
    const { engine, instance } = makeInstance(
      app
        .defineState({ count: 0 })
        .onAction("noop", () => {})
        .onAction("bump", ({ state }) => {
          state.count += 1;
        })
        .build()
    );
    await instance.waitForReady();

    const p1 = engine.dispatch("noop", "spring");
    const p2 = engine.dispatch("bump", "easeOut");
    await Promise.all([p1, p2]);
    await flushMicrotasks(4);

    // noop's unconsumed pending stamp is overwritten at bump's dispatch
    // entry (last-stamp-wins), and its identity-compared clear cannot
    // cancel bump's stamp.
    expect(engine.notifyCalls.length).toBe(1);
    expect(engine.notifyCalls[0].animation).toBe("easeOut");
  });

  test("token identity: two dispatches with the SAME spec value cannot clear each other's stamp", async () => {
    const { engine, instance } = makeInstance(
      app
        .defineState({ count: 0 })
        .onAction("noop", () => {})
        .onAction("bump", ({ state }) => {
          state.count += 1;
        })
        .build()
    );
    await instance.waitForReady();

    // Both stamps are the value-identical string "spring". Pre-fix, noop's
    // deferred clear compared BY VALUE and cancelled bump's pending stamp,
    // so bump's flush went out unstamped.
    const p1 = engine.dispatch("noop", "spring");
    const p2 = engine.dispatch("bump", "spring");
    await Promise.all([p1, p2]);
    await flushMicrotasks(4);

    expect(engine.notifyCalls.length).toBe(1);
    expect(engine.notifyCalls[0].animation).toBe("spring");
  });

  test("spec-object stamps flow through verbatim; unstamped actions stamp nothing", async () => {
    const { engine, instance } = makeInstance(
      app
        .defineState({ count: 0 })
        .onAction("bump", ({ state }) => {
          state.count += 1;
        })
        .build()
    );
    await instance.waitForReady();

    await engine.dispatch("bump", { curve: "spring", duration: 300 });
    await flushMicrotasks(3);
    expect(engine.notifyCalls[0].animation).toEqual({ curve: "spring", duration: 300 });

    await engine.dispatch("bump");
    await flushMicrotasks(3);
    expect(engine.notifyCalls.length).toBe(2);
    expect(engine.notifyCalls[1].animation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2a. BaseEngine: reserved-key payload → distinct Action.animate field
// ---------------------------------------------------------------------------

/** BaseEngine over a fake wasm engine (engine-normalize-action pattern). */
class FakeBaseEngine extends BaseEngine {
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

  emit(action: Action): void {
    this.cb?.(action);
  }
}

describe("transaction animation: BaseEngine animate extraction", () => {
  const capture = (engine: FakeBaseEngine) => {
    let last: Action | null = null;
    const handler: ActionHandler = (action) => {
      last = action;
    };
    engine.onAction("act", handler);
    return { last: () => last as Action | null };
  };

  test("lifts the reserved key into Action.animate and strips it from the payload (token form)", async () => {
    const engine = new FakeBaseEngine();
    await engine.init();
    const got = capture(engine);

    engine.emit({
      name: "act",
      payload: { postId: "p1", [ACTION_ANIMATE_KEY]: "spring" },
    } as Action);

    const action = got.last()!;
    expect(action.animate).toBe("spring");
    expect(action.payload).toEqual({ postId: "p1" });
    expect(ACTION_ANIMATE_KEY in action.payload).toBe(false);
    expect("animate" in action.payload).toBe(false);
  });

  test("object-form specs survive the lift (and Map payloads normalize first)", async () => {
    const engine = new FakeBaseEngine();
    await engine.init();
    const got = capture(engine);

    engine.emit({
      name: "act",
      payload: new Map<string, unknown>([
        ["id", "x"],
        [ACTION_ANIMATE_KEY, new Map<string, unknown>([["curve", "spring"], ["duration", 300]])],
      ]),
    } as unknown as Action);

    const action = got.last()!;
    expect(action.animate).toEqual({ curve: "spring", duration: 300 });
    expect(action.payload).toEqual({ id: "x" });
  });

  test("payloads without the reserved key pass through with no animate field", async () => {
    const engine = new FakeBaseEngine();
    await engine.init();
    const got = capture(engine);

    engine.emit({ name: "act", payload: { id: "y" } } as Action);

    const action = got.last()!;
    expect(action.animate).toBeUndefined();
    expect(action.payload).toEqual({ id: "y" });
  });
});

// ---------------------------------------------------------------------------
// 2b. DOM event applicator: `animate:` never reaches the payload's user keys
// ---------------------------------------------------------------------------

class StubEngine {
  public dispatchCalls: Array<{ name: string; payload: any }> = [];

  dispatchAction(name: string, payload: any): void {
    this.dispatchCalls.push(semanticAction(name, payload));
  }
}

const makeDomRenderer = () => {
  const container = document.createElement("div");
  const engine = new StubEngine();
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  return { engine, renderer };
};

describe("transaction animation: DOM event `animate:` extraction", () => {
  test("token form: animate rides the reserved key, never the payload's own keys", () => {
    const { engine, renderer } = makeDomRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      {
        type: "create",
        id: "btn",
        elementType: "Button",
        props: {
          "onClick.0": "@actions.toggle",
          "onClick.animate": "spring",
          "onClick.postId": "p1",
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "btn" } as Patch,
    ]);

    const btn = renderer.getNode("btn") as FakeElement;
    btn.dispatchEvent("click", { type: "click", target: btn });

    expect(engine.dispatchCalls.length).toBe(1);
    const { name, payload } = engine.dispatchCalls[0];
    expect(name).toBe("toggle");
    expect(payload.postId).toBe("p1");
    expect(payload[ACTION_ANIMATE_KEY]).toBe("spring");
    expect("animate" in payload).toBe(false);
  });

  test("object form: a {curve, duration} spec rides the reserved key intact", () => {
    const { engine, renderer } = makeDomRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      {
        type: "create",
        id: "btn",
        elementType: "Button",
        props: {
          "onClick.0": "@actions.toggle",
          // WASM patches deliver nested values as Maps — exercise that shape.
          "onClick.animate": new Map<string, unknown>([
            ["curve", "spring"],
            ["duration", 300],
          ]),
          "onClick.postId": "p2",
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "btn" } as Patch,
    ]);

    const btn = renderer.getNode("btn") as FakeElement;
    btn.dispatchEvent("click", { type: "click", target: btn });

    const { payload } = engine.dispatchCalls[0];
    expect(payload[ACTION_ANIMATE_KEY]).toEqual({ curve: "spring", duration: 300 });
    expect(payload.postId).toBe("p2");
    expect("animate" in payload).toBe(false);
  });

  test("`animate` inside a POSITIONAL payload object is user data — merged through, never extracted", () => {
    const { engine, renderer } = makeDomRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      {
        type: "create",
        id: "btn",
        elementType: "Button",
        props: {
          "onClick.0": "@actions.toggle",
          // Positional payload object: .onClick("@actions.toggle", {animate: false, id: "x"})
          "onClick.1": { animate: false, id: "x" },
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "btn" } as Patch,
    ]);

    const btn = renderer.getNode("btn") as FakeElement;
    btn.dispatchEvent("click", { type: "click", target: btn });

    expect(engine.dispatchCalls.length).toBe(1);
    const { payload } = engine.dispatchCalls[0];
    // The user's `animate: false` reaches the handler payload untouched…
    expect(payload.animate).toBe(false);
    expect(payload.id).toBe("x");
    // …and no reserved stamp was fabricated from it.
    expect(ACTION_ANIMATE_KEY in payload).toBe(false);
  });

  test("named `animate:` still extracts when a positional payload also carries an `animate` key", () => {
    const { engine, renderer } = makeDomRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      {
        type: "create",
        id: "btn",
        elementType: "Button",
        props: {
          "onClick.0": "@actions.toggle",
          "onClick.animate": "spring", // the NAMED argument — reserved
          "onClick.1": { animate: false }, // user data — not reserved
        },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "btn" } as Patch,
    ]);

    const btn = renderer.getNode("btn") as FakeElement;
    btn.dispatchEvent("click", { type: "click", target: btn });

    const { payload } = engine.dispatchCalls[0];
    expect(payload[ACTION_ANIMATE_KEY]).toBe("spring");
    expect(payload.animate).toBe(false);
  });

  test("events without animate dispatch exactly as before (no reserved key)", () => {
    const { engine, renderer } = makeDomRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      {
        type: "create",
        id: "btn",
        elementType: "Button",
        props: { "onClick.0": "@increment", "onClick.id": "abc" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "btn" } as Patch,
    ]);

    const btn = renderer.getNode("btn") as FakeElement;
    btn.dispatchEvent("click", { type: "click", target: btn });

    expect(engine.dispatchCalls).toEqual([
      { name: "increment", payload: { id: "abc" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2c. Canvas action resolution: same extraction on the canvas dispatch path
// ---------------------------------------------------------------------------

describe("transaction animation: canvas `animate:` extraction", () => {
  test("resolveEventAction pulls animate out of the payload (token form)", () => {
    const resolved = resolveEventAction({
      "0": "@actions.toggle",
      animate: "spring",
      postId: "p1",
    })!;

    expect(resolved.actionName).toBe("toggle");
    expect(resolved.animate).toBe("spring");
    expect(resolved.payload).toEqual({ postId: "p1" });
    expect("animate" in resolved.payload).toBe(false);
  });

  test("resolveEventAction pulls animate out of the payload (object form)", () => {
    const resolved = resolveEventAction({
      "0": "@actions.toggle",
      animate: { curve: "spring", duration: 300 },
    })!;

    expect(resolved.animate).toEqual({ curve: "spring", duration: 300 });
    expect(resolved.payload).toEqual({});
  });

  test("resolveEventAction leaves `animate` inside a positional payload object untouched", () => {
    // Canvas aggregates keep positional args nested (`"1"`), so only the
    // aggregate's own top-level `animate` key — the NAMED argument — is
    // reserved. User data named `animate` inside a positional payload
    // object must survive to the handler.
    const resolved = resolveEventAction({
      "0": "@actions.toggle",
      "1": { animate: false, id: "x" },
    })!;

    expect(resolved.animate).toBeUndefined();
    expect(resolved.payload).toEqual({ "1": { animate: false, id: "x" } });
  });

  test("dispatchNodeEvent carries animate under the reserved key only", () => {
    const engine = new StubEngine();
    const node = {
      id: "n1",
      props: {
        onClick: { "0": "@actions.toggle", animate: "spring", postId: "p1" },
      },
    } as any;

    dispatchNodeEvent(engine as any, node, "click", { clientX: 1, clientY: 2 });

    expect(engine.dispatchCalls.length).toBe(1);
    const { name, payload } = engine.dispatchCalls[0];
    expect(name).toBe("toggle");
    expect(payload.postId).toBe("p1");
    expect(payload[ACTION_ANIMATE_KEY]).toBe("spring");
    expect("animate" in payload).toBe(false);
  });

  test("dispatchNodeEvent without animate emits no reserved key", () => {
    const engine = new StubEngine();
    const node = {
      id: "n1",
      props: { onClick: { "0": "@actions.toggle", postId: "p1" } },
    } as any;

    dispatchNodeEvent(engine as any, node, "click", {});

    const { payload } = engine.dispatchCalls[0];
    expect(ACTION_ANIMATE_KEY in payload).toBe(false);
  });
});
