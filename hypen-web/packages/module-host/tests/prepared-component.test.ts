// prepareComponent() + instantiatePrepared(): one transpile/compile, an
// independent component instance per host; and dead-instance tracking after
// a guest trap.
import { describe, expect, test } from "bun:test";
import { JsModuleHost, MemoryStorageBackend, prepareComponent } from "../src/index.ts";
import { hasFixture, readFixture } from "./_fixtures.ts";

const skip = !hasFixture("counter_module.wasm") || !hasFixture("limits_module.wasm");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (bytes: Uint8Array) => JSON.parse(decoder.decode(bytes));
const action = (name: string) => ({ name, payload: encoder.encode("{}") });

describe.skipIf(skip)("prepared components", () => {
  test("one prepared component, two hosts: separate instances and separate storage", async () => {
    const prepared = await prepareComponent("counter", readFixture("counter_module.wasm"));
    expect(prepared.requiredImports).toContain("hypen:storage/cloud");
    expect(prepared.componentBytes).toBeGreaterThan(0);

    const manifest = { name: "counter", storage: ["cloud"] };
    const [a, b] = [new MemoryStorageBackend(), new MemoryStorageBackend()];
    const hostA = new JsModuleHost({ storage: a });
    const hostB = new JsModuleHost({ storage: b });
    const bindingsA = await hostA.instantiatePrepared("counter", prepared, manifest);
    const bindingsB = await hostB.instantiatePrepared("counter", prepared, manifest);
    expect(bindingsA).not.toBe(bindingsB);

    const idA = hostA.instantiate("counter");
    const idB = hostB.instantiate("counter");
    let state = hostA.init(idA, encoder.encode("{}"));
    for (let i = 0; i < 3; i++) state = hostA.dispatch(idA, state, action("increment")).state!;
    expect(json(state)).toEqual({ count: 3 });

    // The module persists its count in `local` storage and warm-starts from it.
    expect(json(hostB.init(idB, encoder.encode("{}")))).toEqual({ count: 0 });
    expect(Array.from(a.keys()).length).toBeGreaterThan(0);
    expect(Array.from(b.keys())).toEqual([]);
    // A second host over host A's backend sees host A's data.
    const hostA2 = new JsModuleHost({ storage: a });
    await hostA2.instantiatePrepared("counter", prepared, manifest);
    expect(json(hostA2.init(hostA2.instantiate("counter"), encoder.encode("{}")))).toEqual({ count: 3 });
  });

  test("the link-time gate applies per instantiation and replaces nothing when it refuses", async () => {
    const prepared = await prepareComponent("counter", readFixture("counter_module.wasm"));
    const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
    await expect(host.instantiatePrepared("counter", prepared, { name: "counter" })).rejects.toThrow(
      /storage scope denied for module 'counter'.*'cloud'/,
    );
    expect(() => host.instantiate("counter")).toThrow(/module not registered/);

    const bindings = await host.instantiatePrepared("counter", prepared, { name: "counter", storage: ["cloud"] });
    await expect(host.instantiatePrepared("counter", prepared, {})).rejects.toThrow(/storage scope denied/);
    // Still the granted one.
    const id = host.instantiate("counter");
    expect(json(host.init(id, encoder.encode("{}")))).toEqual({ count: 0 });
    // Bindings can be put back by hand.
    host.registerPrepared("counter", bindings as never, { name: "counter", storage: ["cloud"] });
  });

  test("prepareComponent rejects empty bytes", async () => {
    await expect(prepareComponent("x", new Uint8Array())).rejects.toThrow(/no component bytes/);
  });

  test("a trapped instance is dead until its bindings are replaced; an Err result kills nothing", async () => {
    const prepared = await prepareComponent("limits", readFixture("limits_module.wasm"));
    const manifest = { name: "limits", storage: ["app"] };
    const host = new JsModuleHost({ storage: new MemoryStorageBackend() });
    await host.instantiatePrepared("limits", prepared, manifest);
    const id = host.instantiate("limits");
    const sibling = host.instantiate("limits");
    const state = host.init(id, encoder.encode("{}"));
    expect(host.deathReason(id)).toBeNull();

    // An export returning Err(...) is an ordinary failure.
    expect(() => host.dispatch(id, state, action("no-such-action"))).toThrow();
    expect(host.deathReason(id)).toBeNull();
    host.dispatch(id, state, action("noop"));

    expect(() => host.dispatch(id, state, action("trap"))).toThrow();
    expect(host.deathReason(id)).toMatch(/^trapped: /);
    // Every id sharing the component instance is dead, and says why.
    expect(host.deathReason(sibling)).toMatch(/^trapped: /);
    expect(() => host.dispatch(id, state, action("noop"))).toThrow(/dead instance \d+: module 'limits' trapped/);
    expect(() => host.actions(sibling)).toThrow(/dead instance/);
    expect(host.deathReason(9999)).toBeNull();

    // Fresh bindings: new instances work; the old ids stay dead.
    await host.instantiatePrepared("limits", prepared, manifest);
    const fresh = host.instantiate("limits");
    expect(host.deathReason(fresh)).toBeNull();
    host.dispatch(fresh, host.init(fresh, encoder.encode("{}")), action("noop"));
    expect(host.deathReason(id)).toMatch(/^trapped: /);
  });
});
