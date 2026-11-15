/**
 * Unit tests for the per-call ACL context (the `hypen:engine/state`
 * capability import): read allowed/denied, cross-dispatch queueing,
 * subscribe gating, and context install/drain/restore around reducer calls.
 *
 * Uses FAKE bindings injected via `registerPrepared` — no wasm involved.
 * The wasm-driven end-to-end tests live in tests/e2e-*.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { JsModuleHost, type EngineStateImport } from "../src/index.ts";
import type {
  ActionMessage,
  ModuleBindings,
  ModuleManifest,
  SiblingState,
} from "../src/types.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const emptyOut = { state: undefined, effects: [], emit: [] };

/** Host with fake bindings whose dispatch/onActivated run `reducer`. */
type Reducer = (state: Uint8Array, action: ActionMessage, es: EngineStateImport) => unknown;

function makeHost(manifest: ModuleManifest, reducer: Reducer = () => emptyOut) {
  const host = new JsModuleHost();
  const es = host.engineState;
  const bindings: ModuleBindings = {
    init: (config) => config,
    actions: () => ["probe"],
    dispatch: (state, action) => reducer(state, action, es),
    onActivated: (state) => reducer(state, { name: "@activated", payload: new Uint8Array() }, es),
    onDeactivated: () => emptyOut,
    onDestroyed: () => {},
  };
  host.registerPrepared("fake", bindings, manifest);
  const id = host.instantiate("fake");
  return { host, id, es };
}

const probe = (): ActionMessage => ({ name: "probe", payload: enc.encode("{}") });
const sibling = (module: string, json: string): SiblingState => ({
  module,
  state: enc.encode(json),
});

function catchThrown(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe("engine-state read ACL", () => {
  test("read of a granted sibling returns its snapshot", () => {
    const { host, id } = makeHost({ reads: ["profile"], dispatches: [] }, (_s, _a, es) => ({
      ...emptyOut,
      state: es.read("profile"),
    }));
    const out = host.dispatch(id, new Uint8Array(), probe(), [
      sibling("profile", '{"name":"ada"}'),
    ]);
    expect(dec.decode(out.state!)).toBe('{"name":"ada"}');
  });

  test("read without the grant throws permission-denied(reads)", () => {
    const { host, id } = makeHost({ reads: [], dispatches: [] }, (_s, _a, es) =>
      es.read("profile"),
    );
    const err = catchThrown(() =>
      host.dispatch(id, new Uint8Array(), probe(), [sibling("profile", "{}")]),
    );
    expect(err).toEqual({ tag: "permission-denied", val: "reads" });
  });

  test("read of a granted-but-absent sibling throws not-found", () => {
    const { host, id } = makeHost({ reads: ["profile"], dispatches: [] }, (_s, _a, es) =>
      es.read("profile"),
    );
    const err = catchThrown(() => host.dispatch(id, new Uint8Array(), probe(), []));
    expect(err).toEqual({ tag: "not-found" });
  });

  test("read outside any reducer call throws (no active context)", () => {
    const es = new JsModuleHost().engineState;
    const err = catchThrown(() => es.read("anything"));
    expect(err).toEqual({ tag: "permission-denied", val: "reads" });
  });
});

describe("engine-state cross-dispatch queue", () => {
  test("granted dispatch is queued (not reentrant) and drained into the output", () => {
    let reentered = 0;
    const { host, id } = makeHost({ reads: [], dispatches: ["cart"] }, (_s, action, es) => {
      if (action.name === "ping") reentered++;
      es.dispatch("cart", { name: "ping", payload: enc.encode("{}") });
      return emptyOut;
    });

    const out = host.dispatch(id, new Uint8Array(), probe(), []);
    expect(out.crossDispatch).toHaveLength(1);
    expect(out.crossDispatch[0]!.module).toBe("cart");
    expect(out.crossDispatch[0]!.action.name).toBe("ping");
    // Queued for the engine to route — never re-entered this host's reducer.
    expect(reentered).toBe(0);
  });

  test("queue is per call — a second dispatch starts empty", () => {
    const { host, id } = makeHost({ reads: [], dispatches: ["cart"] }, (_s, _a, es) => {
      es.dispatch("cart", { name: "ping", payload: new Uint8Array() });
      return emptyOut;
    });
    host.dispatch(id, new Uint8Array(), probe(), []);
    const out2 = host.dispatch(id, new Uint8Array(), probe(), []);
    expect(out2.crossDispatch).toHaveLength(1);
  });

  test("dispatch without the grant throws permission-denied(dispatches)", () => {
    const { host, id } = makeHost({ reads: [], dispatches: [] }, (_s, _a, es) =>
      es.dispatch("cart", { name: "ping", payload: new Uint8Array() }),
    );
    const err = catchThrown(() => host.dispatch(id, new Uint8Array(), probe(), []));
    expect(err).toEqual({ tag: "permission-denied", val: "dispatches" });
  });
});

describe("engine-state subscribe gating", () => {
  test("subscribe rides the reads grant and lands in subscribeRequests", () => {
    const { host, id } = makeHost({ reads: ["profile"], dispatches: [] }, (_s, _a, es) => {
      es.subscribe("profile", "name", "onProfileName");
      return emptyOut;
    });
    const out = host.dispatch(id, new Uint8Array(), probe(), []);
    expect(out.subscribeRequests).toEqual([
      { module: "profile", path: "name", onChange: "onProfileName" },
    ]);
  });

  test("subscribe without the reads grant throws permission-denied(reads)", () => {
    const { host, id } = makeHost({ reads: [], dispatches: [] }, (_s, _a, es) =>
      es.subscribe("profile", "name", "onProfileName"),
    );
    const err = catchThrown(() => host.dispatch(id, new Uint8Array(), probe(), []));
    expect(err).toEqual({ tag: "permission-denied", val: "reads" });
  });
});

describe("context lifecycle around reducer calls", () => {
  test("context is torn down after dispatch returns", () => {
    const { host, id, es } = makeHost({ reads: ["profile"], dispatches: [] }, () => emptyOut);
    host.dispatch(id, new Uint8Array(), probe(), [sibling("profile", "{}")]);
    // Back outside a call: even a previously granted read must fail.
    const err = catchThrown(() => es.read("profile"));
    expect(err).toEqual({ tag: "permission-denied", val: "reads" });
  });

  test("context is torn down even when the reducer throws", () => {
    const { host, id, es } = makeHost({ reads: ["profile"], dispatches: [] }, () => {
      throw new Error("reducer exploded");
    });
    expect(() => host.dispatch(id, new Uint8Array(), probe(), [])).toThrow("reducer exploded");
    const err = catchThrown(() => es.read("profile"));
    expect(err).toEqual({ tag: "permission-denied", val: "reads" });
  });

  test("onActivated installs the same ACL context as dispatch", () => {
    const { host, id } = makeHost({ reads: ["profile"], dispatches: [] }, (_s, action, es) => {
      if (action.name === "@activated") {
        es.subscribe("profile", "avatar", "onAvatar");
      }
      return emptyOut;
    });
    const out = host.onActivated(id, new Uint8Array(), []);
    expect(out.subscribeRequests).toEqual([
      { module: "profile", path: "avatar", onChange: "onAvatar" },
    ]);
  });
});

describe("per-host isolation", () => {
  test("a call context on one host is invisible to another host's engineState", () => {
    const other = new JsModuleHost();
    let leaked: unknown = null;
    const { host, id } = makeHost({ reads: ["profile"], dispatches: [] }, () => {
      leaked = catchThrown(() => other.engineState.read("profile"));
      return emptyOut;
    });
    host.dispatch(id, new Uint8Array(), probe(), [sibling("profile", "{}")]);
    expect(leaked).toEqual({ tag: "permission-denied", val: "reads" });
  });

  test("omitted reads/dispatches deny everything", () => {
    const { host, id } = makeHost({}, (_s, _a, es) => es.read("profile"));
    const err = catchThrown(() => host.dispatch(id, new Uint8Array(), probe(), [sibling("profile", "{}")]));
    expect(err).toEqual({ tag: "permission-denied", val: "reads" });
  });
});

describe("host surface basics (fake bindings)", () => {
  test("register alone does not make a module instantiable", () => {
    const host = new JsModuleHost();
    host.register("raw", new Uint8Array([0x00, 0x61, 0x73, 0x6d]), { name: "raw" });
    expect(() => host.instantiate("raw")).toThrow(/not prepared/);
  });

  test("instantiate of an unknown module throws", () => {
    const host = new JsModuleHost();
    expect(() => host.instantiate("ghost")).toThrow(/not registered/);
  });

  test("re-register with empty bytes keeps prepared bindings, refreshes manifest", () => {
    const { host, id } = makeHost({ reads: [], dispatches: [] }, (_s, _a, es) =>
      es.read("profile"),
    );
    // Engine-style re-register (empty bytes) with a widened manifest.
    host.register("fake", new Uint8Array(0), { reads: ["profile"], dispatches: [] });
    const out = host.dispatch(id, new Uint8Array(), probe(), [sibling("profile", '{"x":1}')]);
    expect(dec.decode(out.state ?? new Uint8Array())).toBe("");
    // Still instantiable — prepared bindings survived.
    const id2 = host.instantiate("fake");
    expect(id2).not.toBe(id);
  });

  test("destroy invalidates the instance id", () => {
    const { host, id } = makeHost({ reads: [], dispatches: [] });
    host.destroy(id);
    expect(() => host.dispatch(id, new Uint8Array(), probe(), [])).toThrow(/dead instance/);
    expect(() => host.actions(id)).toThrow(/dead instance/);
  });

  test("actions() surfaces the bindings' self-described actions", () => {
    const { host, id } = makeHost({ reads: [], dispatches: [] });
    expect(host.actions(id)).toEqual(["probe"]);
  });
});
