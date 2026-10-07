import { describe, expect, test } from "bun:test";
import { Engine } from "../packages/server/src/engine";
import { app, HypenModuleInstance } from "../packages/core/src/app";
import { dispatchUIAction } from "../packages/core/src/ui-action";
import { flushMicrotasks } from "./helpers";

// Real WASM + tracked host state: identical paths and action names must never
// make module construction order select the recipient.
describe("DnD ownership through the engine", () => {
  test("bind, reorder, pins and callbacks use live node ownership", async () => {
    const engine = new Engine(); await engine.init();
    const calls: string[] = [];
    const make = (name: string) => new HypenModuleInstance(engine, app
      .defineState({ title: name, items: [{ id: "a" }, { id: "b" }] }, { name })
      .onAction("sorted", ({ state, action }) => { calls.push(`${state.title}:${action.name}`); })
      .build());
    const alpha = make("Alpha"), beta = make("Beta");
    await Promise.all([alpha.waitForReady(), beta.waitForReady()]);
    const sources = new Map<string, string>();
    sources.set("Alpha", `module Alpha { Column { Input().bind(@state.title) Stack { ForEach(items: @state.items, key: "id") { Text("@{item.id}").draggable() } }.pinboard(group: "notes", x: "left", y: "top", units: fraction) Column { ForEach(items: @state.items, key: "id") { Text("@{item.id}").draggable() } }.sortable().bind(@state.items).onSort(@actions.sorted) } }`);
    sources.set("Beta", `module Beta { Column { Input().bind(@state.title) Column { ForEach(items: @state.items, key: "id") { Text("@{item.id}").draggable() } }.sortable().bind(@state.items).onSort(@actions.sorted) } }`);
    engine.setComponentResolver(name => sources.has(name) ? { source: sources.get(name)!, path: name } : null);
    const patches: any[] = [];
    engine.setRenderCallback(batch => patches.push(...batch));
    engine.renderSource("Column { Alpha() Beta() }");
    const creates = patches.filter(p => p.type === "create");
    const inputs = creates.filter(p => p.props?.bind === "title");
    const lists = creates.filter(p => p.props?.["__dnd.sort"]);
    const note = creates.find(p => p.props?.["__dnd.pinGroup"] === "notes")!;
    expect(inputs).toHaveLength(2); expect(lists).toHaveLength(2);
    dispatchUIAction(engine, inputs[0]!.id, "__hypen_bind", { path: "title", value: "edited" });
    dispatchUIAction(engine, lists[0]!.id, "__hypen_reorder", { path: "items", from: 0, to: 1 });
    dispatchUIAction(engine, lists[0]!.id, "sorted", {});
    dispatchUIAction(engine, note.id, "__hypen_pin", { path: "__dnd.notes.a", x: .5, y: .25, xKey: "left", yKey: "top" });
    await flushMicrotasks(3);
    expect(alpha.getState().title).toBe("edited");
    expect(alpha.getState().items.map(i => i.id)).toEqual(["b", "a"]);
    expect((alpha.getState() as any).__dnd.notes.a).toEqual({ left: .5, top: .25 });
    expect(beta.getState()).toEqual({ title: "Beta", items: [{ id: "a" }, { id: "b" }] });
    expect(calls).toEqual(["edited:sorted"]);
    expect(() => engine.dispatchAction("__hypen_reorder", { path: "items", from: 0, to: 1 })).toThrow();
    expect(() => dispatchUIAction(engine, lists[1]!.id, "__hypen_reorder", { path: "items", from: 0, to: 1 }, lists[0]!.id)).toThrow();
    expect(() => dispatchUIAction(engine, inputs[0]!.id, "__hypen_bind", { path: "items", value: [] })).toThrow();
    engine.unregisterModule("Alpha");
    expect(() => dispatchUIAction(engine, inputs[0]!.id, "__hypen_bind", { path: "title", value: "stale" })).toThrow();
    await Promise.all([alpha.destroy(), beta.destroy()]);

  });
});
