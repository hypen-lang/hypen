/**
 * End-to-end: hosted (WASM-component) modules and ordinary in-process
 * modules side by side in ONE engine — the server build of the engine
 * (`packages/server/wasm-node`), whose `WasmEngine` drives this package's
 * `JsModuleHost` through the Rust `BridgedHost`:
 *
 *   test -> WasmEngine (engine.wasm) -> hosted subsystem (Rust)
 *        -> BridgedHost -> JsModuleHost (this package) -> component (wasm)
 *
 * Fixtures (hypen-engine-rs/tests/fixtures):
 *   counter_module.wasm  `increment` bumps state.count (needs storage `cloud`)
 *   mirror_module.wasm   cross-module against a sibling named "counter":
 *                        `pull` reads it, `bump` dispatches `increment` to
 *                        it, `watch` / on_activated subscribe to its `count`
 *
 * Here "counter" is an IN-PROCESS module (JS handlers + `updateState`), the
 * counter component is hosted under the scope "tally", and the mirror
 * component is hosted three times with different grants.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JsModuleHost, MemoryStorageBackend, type ModuleManifest } from "../src/index.ts";
import { REPO_ROOT, hasFixture, readFixture } from "./_fixtures.ts";

const SERVER_WASM = resolve(REPO_ROOT, "hypen-web/packages/server/wasm-node/hypen_engine.js");
const BROWSER_WASM_DIR = resolve(REPO_ROOT, "hypen-web/packages/web-engine/wasm-browser");
const skip =
  !existsSync(SERVER_WASM) || !hasFixture("counter_module.wasm") || !hasFixture("mirror_module.wasm");

type Patch = Record<string, any>;
type Delivered = { name: string; payload: any; sender: string | null };

const TALLY: ModuleManifest = { name: "tally", version: "1.0.0", storage: ["local", "cloud"] };
const GRANTED: ModuleManifest = { name: "mirror", reads: ["counter"], dispatches: ["counter"] };
const NO_GRANTS: ModuleManifest = { name: "mirror" };

const UI = `
Column {
    Tally()
    Counter()
    Mirror()
}`;
const COMPONENTS: Record<string, string> = {
  Tally: `module tally {
    Column {
        Text("Tally: @{state.count}")
        Button("@actions.increment") { Text("+1") }
    }
}`,
  Counter: `module counter {
    Column {
        Text("Counter: @{state.count}")
        Button("@actions.increment") { Text("+1") }
    }
}`,
  Mirror: `module mirror {
    Text("Seen: @{state.seen}")
}`,
};

/** A host with every fixture component prepared (the async half). */
async function prepareHost(): Promise<JsModuleHost> {
  const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
  const counter = readFixture("counter_module.wasm");
  const mirror = readFixture("mirror_module.wasm");
  await host.prepare("tally", counter, TALLY);
  // One component per manifest: the host keys its grants by component name.
  await host.prepare("mirror", mirror, GRANTED);
  await host.prepare("mirror_no_grants", mirror, NO_GRANTS);
  await host.prepare("mirror_lax", mirror, NO_GRANTS);
  return host;
}

/**
 * One engine with: the in-process module `counter`, the hosted module
 * `tally`, and the UI of both rendered.
 */
function setup(host: JsModuleHost, WasmEngine: any) {
  const engine = new WasmEngine();
  engine.registerDefaultPrimitives();
  const batches: Patch[][] = [];
  engine.setRenderCallback((json: string) => batches.push(JSON.parse(json)));
  engine.setComponentResolver((name: string) =>
    COMPONENTS[name] ? { source: COMPONENTS[name], path: `/${name}.hypen` } : null,
  );

  // In-process module, registered the way `@hypen-space/core` does it:
  // state under the lowercase name, handlers under the scoped wire name.
  const delivered: Delivered[] = [];
  let onIncrement: (action: Delivered) => void = () => {
    // Deferred: the handler runs inside an engine call (see re-entrancy).
    queueMicrotask(() => {
      const count = engine.getModuleState("counter").count as number;
      engine.updateState("counter", { count: count + 1 });
    });
  };
  engine.registerModule("counter", ["increment"], ["count"], { count: 10 });
  engine.onAction("__hypen_scoped:counter:increment", (action: Delivered) => {
    delivered.push(action);
    onIncrement(action);
  });

  engine.setModuleHost(host);
  const tally = engine.registerHostedModule("Tally", "tally", TALLY, {});

  const patches = (): Patch[] => batches.flat();
  const take = (): Patch[] => batches.splice(0).flat();
  /** The id of the `nth` Button created so far. */
  const button = (all: Patch[], nth: number): string =>
    all.filter((p) => p.type === "create" && p.elementType === "Button")[nth]!.id;
  const texts = (all: Patch[]): string[] =>
    all
      .filter((p) => p.type === "setProp" || p.type === "create")
      .flatMap((p) => (p.type === "create" ? Object.values(p.props ?? {}) : [p.value]))
      .filter((v): v is string => typeof v === "string");

  return {
    engine,
    tally,
    delivered,
    patches,
    take,
    button,
    texts,
    setOnIncrement: (fn: (action: Delivered) => void) => (onIncrement = fn),
  };
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

function thrown(run: () => unknown): any {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe.skipIf(skip)("hosted + in-process modules in one engine (wasm-node)", () => {
  let WasmEngine: any;
  let host: JsModuleHost;

  beforeAll(async () => {
    ({ WasmEngine } = await import(SERVER_WASM));
  });
  // A fresh host per test: the counter component persists its count in the
  // host's `local` storage.
  beforeEach(async () => {
    host = await prepareHost();
  }, 120_000);

  test("(a) a hosted module renders and handles a UI action end to end", () => {
    const { engine, tally, take, button, texts } = setup(host, WasmEngine);
    expect(tally).toEqual({
      scope: "tally",
      component: "tally",
      instanceId: expect.any(Number),
      actions: ["increment", "sync"],
      wildcard: false,
    });
    expect(engine.getModuleState("tally")).toEqual({ count: 0 });

    engine.renderSource(UI);
    const initial = take();
    expect(texts(initial)).toContain("Tally: 0");

    // The envelope a renderer sends: the node the user touched + the action.
    const tallyButton = button(initial, 0);
    engine.dispatchAction("__hypen_dispatch", { node: tallyButton, action: "increment", payload: {} });
    engine.dispatchAction("__hypen_dispatch", { node: tallyButton, action: "increment" });

    expect(engine.getModuleState("tally").count).toBe(2);
    const updates = take();
    expect(updates.filter((p) => p.type === "setProp").map((p) => p.value)).toEqual([
      "Tally: 1",
      "Tally: 2",
    ]);
    expect(engine.lastModuleCascadeReport()).toBeNull();

    // A scoped wire name routes the same way; an unknown one is refused
    // with the same error shape `dispatchAction` always had.
    engine.dispatchAction("__hypen_scoped:tally:increment", null);
    expect(engine.getModuleState("tally").count).toBe(3);
    expect(thrown(() => engine.dispatchAction("__hypen_scoped:tally:nope", null))).toEqual({
      type: "actionError",
      message: expect.stringContaining("unregistered scoped action"),
    });
  });

  test("(b) an in-process module and a hosted module coexist", async () => {
    const { engine, delivered, take, button, texts } = setup(host, WasmEngine);
    engine.renderSource(UI);
    const initial = take();
    expect(texts(initial)).toEqual(expect.arrayContaining(["Tally: 0", "Counter: 10"]));

    // Same action name in both scopes: node ownership decides.
    const [tallyButton, counterButton] = [button(initial, 0), button(initial, 1)];
    engine.dispatchAction("__hypen_dispatch", { node: counterButton, action: "increment", payload: { by: 1 } });
    expect(delivered).toEqual([
      { name: "__hypen_scoped:counter:increment", payload: { by: 1 }, sender: null },
    ]);
    await flush();
    engine.dispatchAction("__hypen_dispatch", { node: tallyButton, action: "increment", payload: {} });

    expect(engine.getModuleState("counter").count).toBe(11);
    expect(engine.getModuleState("tally").count).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(take().filter((p) => p.type === "setProp").map((p) => p.value)).toEqual([
      "Counter: 11",
      "Tally: 1",
    ]);

    // A bare name two scopes handle is never guessed.
    expect(thrown(() => engine.dispatchAction("increment", null)).type).toBe("actionError");

    expect(engine.hostedModules()).toEqual([
      { scope: "tally", component: "tally", instanceId: expect.any(Number), actions: ["increment", "sync"], wildcard: false },
    ]);
    expect(engine.isHostedModule("TALLY")).toBe(true);
    expect(engine.isHostedModule("counter")).toBe(false);
  });

  test("(c) a hosted module reads in-process state under a grant, and is refused without it", () => {
    const { engine, take, texts } = setup(host, WasmEngine);
    engine.renderSource(UI);
    take();

    engine.registerHostedModule("mirror", "mirror", GRANTED);
    expect(engine.getModuleState("mirror")).toEqual({ seen: 0 });
    engine.dispatchModuleAction("mirror", "pull", null);
    expect(engine.getModuleState("mirror").seen).toBe(10);
    expect(texts(take())).toContain("Seen: 10");

    // The snapshot follows the in-process module's writes.
    engine.updateState("counter", { count: 42 });
    engine.dispatchModuleAction("mirror", "pull");
    expect(engine.getModuleState("mirror").seen).toBe(42);

    // No grant: the module host itself refuses the read...
    engine.registerHostedModule("blind", "mirror_no_grants", NO_GRANTS);
    const denied = thrown(() => engine.dispatchModuleAction("blind", "pull", null));
    expect(denied).toBeInstanceOf(Error);
    expect(denied).toMatchObject({ type: "moduleError", code: "moduleCallFailed", scope: "blind" });
    expect(denied.report.failures[0].cause.host.message).toMatch(/permission-denied|PermissionDenied/i);
    expect(engine.getModuleState("blind").seen).toBe(0);

    // ...and with a host that would let it through, the engine still hands
    // the module no snapshot: `reads` is enforced engine-side.
    const register = host.register.bind(host);
    host.register = (name, bytes, manifest) =>
      register(name, bytes, name === "mirror_lax" ? { ...manifest, ...GRANTED } : manifest);
    try {
      engine.registerHostedModule("lax", "mirror_lax", NO_GRANTS);
    } finally {
      host.register = register;
    }
    const unread = thrown(() => engine.dispatchModuleAction("lax", "pull", null));
    expect(unread.code).toBe("moduleCallFailed");
    expect(unread.report.failures[0].cause.host.message).toMatch(/not-found|NotFound/i);
    expect(engine.getModuleState("lax").seen).toBe(0);
  });

  test("(d) a hosted module cross-dispatches to an in-process handler under a grant", async () => {
    const { engine, delivered } = setup(host, WasmEngine);
    engine.registerHostedModule("mirror", "mirror", GRANTED);

    engine.dispatchModuleAction("mirror", "bump", null);
    expect(delivered).toEqual([
      // The scoped wire name, the module's payload, the sending module.
      { name: "__hypen_scoped:counter:increment", payload: {}, sender: "mirror" },
    ]);
    expect(engine.lastModuleCascadeReport()).toBeNull();
    await flush();
    expect(engine.getModuleState("counter").count).toBe(11);
  });

  test("(e) a hosted subscription fires on a JS updateState", () => {
    const { engine, take, texts } = setup(host, WasmEngine);
    engine.renderSource(UI);
    engine.registerHostedModule("mirror", "mirror", GRANTED);
    // on_activated subscribes to counter.count -> `pull`.
    expect(engine.activateHostedModule("mirror")).toBe(true);
    expect(engine.activateHostedModule("counter")).toBe(false);
    take();

    engine.updateState("counter", { count: 11 });
    expect(engine.getModuleState("mirror").seen).toBe(11);
    expect(texts(take())).toEqual(expect.arrayContaining(["Counter: 11", "Seen: 11"]));

    // The sparse entry points notify too; an unrelated path does not.
    engine.updateStateSparse("counter", ["count"], { count: 12 });
    expect(engine.getModuleState("mirror").seen).toBe(12);
    engine.updateStateSparseJson("counter", '["count"]', '{"count":13}');
    expect(engine.getModuleState("mirror").seen).toBe(13);
    engine.updateState("counter", { label: "x" });
    expect(take().some((p) => p.value === "Seen: 13")).toBe(true);
    expect(engine.lastModuleCascadeReport()).toBeNull();

    // A subscriber that cannot cope does not fail the write; the report says so.
    const dispatch = host.dispatch.bind(host);
    host.dispatch = () => {
      throw new Error("host is down");
    };
    try {
      engine.updateState("counter", { count: 14 });
    } finally {
      host.dispatch = dispatch;
    }
    expect(engine.getModuleState("counter").count).toBe(14);
    expect(engine.lastModuleCascadeReport()).toMatchObject({
      root: { kind: "hostWrite", scope: "counter", action: "<host state update>" },
      rootFailed: false,
      failureCount: 1,
      failures: [
        {
          scope: "mirror",
          action: "pull",
          outcome: "failed",
          origin: { kind: "subscriptionChange", target: "counter", path: "count" },
          cause: { code: "host", host: { code: "runtime", message: "runtime error: host is down" } },
        },
      ],
    });
  });

  test("(f) dispatchModuleAction drives a hosted module; a denied cross-dispatch is reported as data", async () => {
    const { engine, delivered } = setup(host, WasmEngine);
    engine.dispatchModuleAction("tally", "increment", { any: "json" });
    engine.dispatchModuleAction("Tally", "increment");
    expect(engine.getModuleState("tally").count).toBe(2);

    expect(thrown(() => engine.dispatchModuleAction("ghost", "x", null))).toMatchObject({
      code: "unknownModule",
      scope: "ghost",
    });
    expect(thrown(() => engine.dispatchModuleAction("counter", "increment", null)).code).toBe(
      "unknownModule",
    );
    expect(thrown(() => engine.dispatchModuleAction("tally", "nope", null))).toMatchObject({
      code: "actionNotAccepted",
      scope: "tally",
    });
    expect(thrown(() => engine.dispatchModuleAction("tally", "increment", () => 1)).code).toBe(
      "invalidArgument",
    );

    // The module's own failure: its reducer returns Err for an unknown name.
    engine.registerHostedModule("wild", "mirror", GRANTED, null, ["*"]);
    const failed = thrown(() => engine.dispatchModuleAction("wild", "nope", null));
    expect(failed).toMatchObject({ code: "moduleCallFailed", scope: "wild" });
    expect(failed.report).toMatchObject({
      root: { kind: "dispatch", scope: "wild", action: "nope" },
      rootFailed: true,
      failures: [{ isRoot: true, origin: { kind: "root" }, cause: { code: "host" } }],
    });

    // A module host that lets an ungranted dispatch through: the engine's own
    // ACL refuses it, and says which grant is missing.
    const register = host.register.bind(host);
    host.register = (name, bytes, manifest) =>
      register(name, bytes, name === "mirror_lax" ? { ...manifest, ...GRANTED } : manifest);
    try {
      engine.registerHostedModule("lax", "mirror_lax", { reads: ["counter"] });
    } finally {
      host.register = register;
    }
    const denied = thrown(() => engine.dispatchModuleAction("lax", "bump", null));
    expect(denied).toBeInstanceOf(Error);
    expect(denied).toMatchObject({ type: "moduleError", code: "cascadeIncomplete", scope: "lax" });
    const report = engine.lastModuleCascadeReport();
    expect(denied.report).toEqual(report);
    expect(report).toEqual({
      root: { kind: "dispatch", scope: "lax", action: "bump" },
      rootFailed: false,
      failureCount: 1,
      failures: [
        {
          scope: "counter",
          action: "increment",
          outcome: "refused",
          isRoot: false,
          origin: { kind: "crossDispatch", from: "lax" },
          cause: { code: "dispatchDenied", grant: "dispatches", missingGrant: "counter" },
          message: expect.stringContaining("'lax' has no `dispatches` grant on 'counter'"),
        },
      ],
      message: expect.stringContaining("finished with 1 failure(s)"),
    });
    expect(delivered).toHaveLength(0);

    // The next clean cascade clears the report.
    engine.dispatchModuleAction("tally", "increment", null);
    expect(engine.lastModuleCascadeReport()).toBeNull();
  });

  test("(g) re-entrancy: a callback that calls the engine is refused, and nothing breaks", async () => {
    const { engine, delivered, setOnIncrement } = setup(host, WasmEngine);
    engine.registerHostedModule("mirror", "mirror", GRANTED);
    engine.activateHostedModule("mirror");

    // 1. An in-process handler, reached by cross-dispatch, calls the engine
    //    synchronously. The call is refused at the caller...
    let refusal: any = null;
    setOnIncrement(() => {
      try {
        engine.updateState("counter", { count: 99 });
      } catch (err) {
        refusal = err;
        throw err;
      }
    });
    const incomplete = thrown(() => engine.dispatchModuleAction("mirror", "bump", null));
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.message).toContain("recursive use of an object");
    // ...and, when the handler lets it escape, reported as that handler's
    // failure with a message that says what happened.
    expect(incomplete).toMatchObject({ code: "cascadeIncomplete", scope: "mirror" });
    expect(incomplete.report.failures).toEqual([
      expect.objectContaining({
        scope: "counter",
        action: "increment",
        outcome: "failed",
        origin: { kind: "crossDispatch", from: "mirror" },
        cause: { code: "handler", detail: expect.stringContaining("called re-entrantly") },
      }),
    ]);
    expect(engine.getModuleState("counter").count).toBe(10);
    expect(delivered).toHaveLength(1);

    // 2. The module host calls the engine from inside a reducer call.
    const dispatch = host.dispatch.bind(host);
    host.dispatch = (id, state, action, siblings) => {
      engine.dispatchModuleAction("tally", "increment", null);
      return dispatch(id, state, action, siblings);
    };
    let reentered: any;
    try {
      reentered = thrown(() => engine.dispatchModuleAction("mirror", "pull", null));
    } finally {
      host.dispatch = dispatch;
    }
    expect(reentered).toMatchObject({ code: "moduleCallFailed", scope: "mirror" });
    expect(reentered.report.failures[0].cause).toEqual({
      code: "host",
      host: { code: "runtime", message: expect.stringContaining("called re-entrantly") },
    });
    expect(engine.getModuleState("tally").count).toBe(0);

    // 3. A handler that simply throws is reported the same way.
    setOnIncrement(() => {
      throw new TypeError("boom");
    });
    expect(thrown(() => engine.dispatchModuleAction("mirror", "bump", null)).report.failures[0].cause).toEqual({
      code: "handler",
      detail: "boom",
    });

    // The engine is intact, and the deferred form works: the handler's write
    // lands after the cascade and notifies the hosted subscriber.
    setOnIncrement(() => queueMicrotask(() => engine.updateState("counter", { count: 11 })));
    engine.dispatchModuleAction("mirror", "bump", null);
    await flush();
    expect(engine.getModuleState("counter").count).toBe(11);
    expect(engine.getModuleState("mirror").seen).toBe(11);
    expect(engine.lastModuleCascadeReport()).toBeNull();
    expect(engine.validate()).toBeNull();
  });

  test("bad paths at each lifecycle point leave nothing wired and name the stage", () => {
    const engine = new WasmEngine();

    // No host.
    expect(thrown(() => engine.registerHostedModule("tally", "tally", TALLY)).code).toBe("noModuleHost");
    expect(engine.hasModuleHost()).toBe(false);
    for (const bad of [null, undefined, 3, {}, { register() {} }]) {
      const err = thrown(() => engine.setModuleHost(bad));
      expect(err).toMatchObject({ type: "moduleError", code: "invalidArgument" });
    }
    expect(thrown(() => engine.setModuleHost({})).message).toContain("missing JsModuleHost method(s): register,");
    engine.setModuleHost(host);
    expect(engine.hasModuleHost()).toBe(true);

    // Names, arguments, collisions.
    expect(thrown(() => engine.registerHostedModule("", "tally", TALLY)).code).toBe("invalidName");
    expect(thrown(() => engine.registerHostedModule("a:b", "tally", TALLY)).code).toBe("invalidName");
    expect(thrown(() => engine.registerHostedModule("__hypen_x", "tally", TALLY)).code).toBe("invalidName");
    expect(thrown(() => engine.registerHostedModule("t", "tally", "nope")).code).toBe("invalidArgument");
    expect(thrown(() => engine.registerHostedModule("t", "tally", { storage: ["moon"] })).code).toBe("invalidArgument");
    expect(thrown(() => engine.registerHostedModule("t", "tally", TALLY, null, "increment")).code).toBe("invalidArgument");
    expect(thrown(() => engine.registerHostedModule("t", "tally", TALLY, null, ["a:b"]))).toMatchObject({
      code: "invalidName",
      scope: "t",
    });
    engine.registerModule("plain", [], [], {});
    expect(thrown(() => engine.registerHostedModule("Plain", "tally", TALLY)).code).toBe("scopeInUse");

    // The host failing at each step. Nothing stays wired, no instance leaks.
    expect(thrown(() => engine.registerHostedModule("t", "never_prepared", TALLY))).toMatchObject({
      code: "hostError",
      stage: "instantiate",
      scope: "t",
      hostCode: "runtime",
    });
    for (const stage of ["register", "instantiate", "init", "actions"] as const) {
      const original = (host as any)[stage].bind(host);
      (host as any)[stage] = () => {
        throw new Error(`${stage} exploded`);
      };
      let err: any;
      try {
        err = thrown(() => engine.registerHostedModule("t", "tally", TALLY));
      } finally {
        (host as any)[stage] = original;
      }
      expect(err).toMatchObject({ code: "hostError", stage, scope: "t" });
      expect(err.message).toBe(`[t] the module host failed at '${stage}': runtime error: ${stage} exploded`);
      expect(engine.hostedModules()).toEqual([]);
      expect(engine.getModuleState("t")).toBeNull();
    }
    for (const [state, code] of [
      [new TextEncoder().encode("not json"), "invalidState"],
      [new TextEncoder().encode("[1]"), "invalidState"],
    ] as const) {
      const init = host.init.bind(host);
      host.init = () => state;
      try {
        expect(thrown(() => engine.registerHostedModule("t", "tally", TALLY)).code).toBe(code);
      } finally {
        host.init = init;
      }
    }
    const instantiate = host.instantiate.bind(host);
    host.instantiate = () => -1;
    try {
      expect(thrown(() => engine.registerHostedModule("t", "tally", TALLY)).message).toContain("not an instance id");
    } finally {
      host.instantiate = instantiate;
    }

    // Double registration, replacing the host, teardown.
    const first = engine.registerHostedModule("t", "tally", TALLY, new TextEncoder().encode("{}"));
    expect(thrown(() => engine.registerHostedModule("T", "tally", TALLY)).code).toBe("alreadyRegistered");
    expect(thrown(() => engine.setModuleHost(host)).code).toBe("modulesRegistered");

    engine.dispatchModuleAction("t", "increment", null);
    const reloaded = engine.reloadHostedModule("t");
    expect(reloaded.instanceId).not.toBe(first.instanceId);
    expect(engine.getModuleState("t").count).toBe(1); // state survives a reload
    expect(() => host.actions(first.instanceId)).toThrow(/dead instance/);
    expect(thrown(() => engine.reloadHostedModule("ghost")).code).toBe("unknownModule");

    const onDestroyed = host.onDestroyed.bind(host);
    host.onDestroyed = () => {
      throw new Error("teardown exploded");
    };
    let teardown: any;
    try {
      teardown = thrown(() => engine.destroyHostedModule("t"));
    } finally {
      host.onDestroyed = onDestroyed;
    }
    expect(teardown).toMatchObject({ code: "hostError", stage: "onDestroyed", scope: "t" });
    // ...but the teardown completed.
    expect(engine.hostedModules()).toEqual([]);
    expect(engine.getModuleState("t")).toBeNull();
    expect(() => host.actions(reloaded.instanceId)).toThrow(/dead instance/);
    expect(engine.destroyHostedModule("t")).toBe(false);
    expect(engine.deactivateHostedModule("t")).toBe(false);

    // unregisterModule and reset release hosted instances too.
    const a = engine.registerHostedModule("a", "tally", TALLY);
    const b = engine.registerHostedModule("b", "tally", TALLY);
    engine.unregisterModule("a");
    expect(engine.isHostedModule("a")).toBe(false);
    expect(() => host.actions(a.instanceId)).toThrow(/dead instance/);
    engine.reset();
    expect(engine.hostedModules()).toEqual([]);
    expect(() => host.actions(b.instanceId)).toThrow(/dead instance/);
    expect(engine.hasModuleHost()).toBe(true);
    engine.registerHostedModule("b", "tally", TALLY);
    expect(engine.deactivateHostedModule("b")).toBe(true);
  });

  test("effects reach the effect handler; the budget is configurable", () => {
    const engine = new WasmEngine();
    engine.setModuleHost(host);
    engine.registerHostedModule("tally", "tally", TALLY);
    const effects: unknown[] = [];
    engine.setModuleEffectHandler((scope: string, effect: unknown) => effects.push([scope, effect]));
    expect(thrown(() => engine.setModuleEffectHandler(3)).code).toBe("invalidArgument");

    const dispatch = host.dispatch.bind(host);
    host.dispatch = (id, state, action, siblings) => {
      const out = dispatch(id, state, action, siblings);
      out.effects.push({ tag: "navigate", path: "/done" }, { tag: "delay", ms: 250, then: "sync" });
      out.emit.push({ name: "increment", payload: new Uint8Array() });
      return out;
    };
    try {
      expect(engine.moduleDispatchBudget()).toBe(1024);
      engine.setModuleDispatchBudget(3);
      const exhausted = thrown(() => engine.dispatchModuleAction("tally", "increment", null));
      expect(exhausted.code).toBe("cascadeIncomplete");
      expect(exhausted.report.failures[0].cause).toEqual({ code: "budgetExhausted", budget: 3, dropped: 1 });
      expect(engine.getModuleState("tally").count).toBe(3);
      expect(effects.slice(0, 2)).toEqual([
        ["tally", { type: "navigate", path: "/done" }],
        ["tally", { type: "delay", ms: 250, then: "sync" }],
      ]);
      expect(effects).toHaveLength(6); // log effects never reach the handler

      // A throwing handler fails nothing; removing it stops delivery.
      engine.setModuleEffectHandler(() => {
        throw new Error("no router");
      });
      engine.setModuleDispatchBudget(1);
      expect(thrown(() => engine.dispatchModuleAction("tally", "increment", null)).code).toBe("cascadeIncomplete");
      engine.setModuleEffectHandler(null);
    } finally {
      host.dispatch = dispatch;
    }
  });

  test("(h) the browser build has no hosted-module surface", async () => {
    const serverTypes = readFileSync(SERVER_WASM.replace(/\.js$/, ".d.ts"), "utf8");
    const browserTypes = readFileSync(resolve(BROWSER_WASM_DIR, "hypen_engine.d.ts"), "utf8");
    const browserGlue = readFileSync(resolve(BROWSER_WASM_DIR, "hypen_engine.js"), "utf8");
    const methods = [
      "setModuleHost",
      "hasModuleHost",
      "registerHostedModule",
      "reloadHostedModule",
      "activateHostedModule",
      "deactivateHostedModule",
      "destroyHostedModule",
      "dispatchModuleAction",
      "hostedModules",
      "isHostedModule",
      "getModuleState",
      "lastModuleCascadeReport",
      "setModuleEffectHandler",
      "moduleDispatchBudget",
      "setModuleDispatchBudget",
    ];
    for (const method of methods) {
      expect(typeof WasmEngine.prototype[method]).toBe("function");
      expect(serverTypes).toContain(`${method}(`);
      expect(browserTypes).not.toContain(method);
      expect(browserGlue).not.toContain(method);
    }
    expect(serverTypes).not.toContain("WasmHostedEngine");

    // The typed wrappers: capability check on, and off on a browser-shaped engine.
    const { Engine } = await import("../../server/src/engine.ts");
    const { BaseEngine } = await import("../../core/src/engine-base.ts");
    const { isHostedModuleError } = await import("../../core/src/types.ts");
    const server = new Engine();
    expect(server.supportsHostedModules).toBe(false); // before init()
    await server.init();
    expect(server.supportsHostedModules).toBe(true);
    server.setModuleHost(host);
    expect(server.registerHostedModule("Tally", { component: "tally", manifest: TALLY }).scope).toBe("tally");
    server.dispatchModuleAction("tally", "increment", { n: 1 });
    expect(server.getModuleState("tally").count).toBe(1);
    expect(server.hostedModules()).toHaveLength(1);
    expect(server.isHostedModule("tally")).toBe(true);
    expect(server.lastModuleCascadeReport()).toBeNull();
    const unknown = thrown(() => server.dispatchModuleAction("ghost", "x"));
    expect(isHostedModuleError(unknown) && unknown.code).toBe("unknownModule");
    // A re-entrant call through the wrapper gets a code of its own.
    let reentrant: any = null;
    server.setModuleEffectHandler(() => {});
    const dispatch = host.dispatch.bind(host);
    host.dispatch = (id, state, action, siblings) => {
      try {
        server.dispatchModuleAction("tally", "increment");
      } catch (err) {
        reentrant = err;
      }
      return dispatch(id, state, action, siblings);
    };
    try {
      server.dispatchModuleAction("tally", "increment");
    } finally {
      host.dispatch = dispatch;
    }
    expect(reentrant).toMatchObject({ type: "moduleError", code: "engineReentrancy" });
    expect(server.getModuleState("tally").count).toBe(2);
    expect(server.destroyHostedModule("tally")).toBe(true);

    class BrowserShaped extends BaseEngine {
      async init(): Promise<void> {
        // The browser build's WasmEngine: everything but the hosted methods.
        const browserLike = Object.create(WasmEngine.prototype, {
          ...Object.fromEntries(methods.map((m) => [m, { value: undefined }])),
        });
        this.wasmEngine = browserLike;
        this.initialized = true;
      }
      protected unwrapForWasm<T>(value: T): T {
        return value;
      }
    }
    const browser = new BrowserShaped();
    await browser.init();
    expect(browser.supportsHostedModules).toBe(false);
    expect(thrown(() => browser.registerHostedModule("tally"))).toMatchObject({
      type: "moduleError",
      code: "hostedModulesUnsupported",
    });
    expect(browser.hostedModules()).toEqual([]);
    expect(browser.isHostedModule("tally")).toBe(false);
    expect(browser.lastModuleCascadeReport()).toBeNull();
  });
});
