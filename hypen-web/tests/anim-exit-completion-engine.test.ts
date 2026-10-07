/**
 * `.onAnimationComplete` for `.exit` end to end: real WASM engine + DOM
 * renderer (fake-dom).
 *
 * The exit plays AFTER the engine emitted `Remove { transition: true }`, so
 * the completion the renderer dispatches (a `__hypen_dispatch` envelope
 * addressed to the exiting root's own node id) names a node the engine has
 * already removed. The engine's exit tombstone routes it to the module that
 * owned the node — here a nested module whose sibling handles the same action
 * name, so a wrong scope would be visible.
 */
import { describe, expect, test } from "bun:test";
import { Engine } from "../packages/server/src/engine";
import { app, HypenModuleInstance } from "../packages/core/src/app";
import { dispatchUIAction } from "../packages/core/src/ui-action";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";
import { flushMicrotasks } from "./helpers";

ensureFakeDomGlobals();

describe("exit completion through the engine", () => {
  test("a settled .exit reaches the owning nested module, once", async () => {
    const engine = new Engine();
    await engine.init();
    const calls: Array<{ module: string; payload: unknown }> = [];
    const make = (name: string) =>
      new HypenModuleInstance(
        engine,
        app
          .defineState({ show: true }, { name })
          .onAction("hide", ({ state }) => {
            state.show = false;
          })
          .onAction("done", ({ action }) => {
            calls.push({ module: name, payload: action.payload });
          })
          .build()
      );
    const alpha = make("Alpha");
    const beta = make("Beta");
    await Promise.all([alpha.waitForReady(), beta.waitForReady()]);

    const card = (name: string) =>
      `module ${name} { Column { If(@state.show) { Row { Text("${name}") }.exit(fade, duration: 30).onAnimationComplete(@actions.done) } } }`;
    const sources = new Map([
      ["Alpha", card("Alpha")],
      ["Beta", card("Beta")],
    ]);
    engine.setComponentResolver((name) =>
      sources.has(name) ? { source: sources.get(name)!, path: name } : null
    );

    const container = document.createElement("div");
    const renderer = new DOMRenderer(container, engine as any);
    const patches: Patch[] = [];
    engine.setRenderCallback((batch) => {
      patches.push(...batch);
      renderer.applyPatches(batch);
    });
    engine.renderSource("Column { Alpha() Beta() }");

    const rows = patches.filter((p) => p.type === "create" && p.elementType === "Row");
    expect(rows).toHaveLength(2);
    const alphaRow = rows[0]!.id;
    const rowEl = renderer.getNode(alphaRow) as unknown as FakeElement;
    expect(rowEl).toBeDefined();

    // Hide Alpha's row: the engine removes it with an animated exit.
    patches.length = 0;
    dispatchUIAction(engine, alphaRow, "hide", {});
    await flushMicrotasks(3);
    expect(patches).toContainEqual(
      expect.objectContaining({ type: "remove", id: alphaRow, transition: true })
    );
    expect(calls).toEqual([]); // mid-exit: nothing yet

    // The exit settles naturally — the renderer dispatches the completion
    // for a node the engine has already removed.
    rowEl.dispatchEvent("transitionend", { target: rowEl });
    await flushMicrotasks(3);
    expect(calls).toEqual([{ module: "Alpha", payload: { animation: "exit" } }]);
    expect(renderer.getNode(alphaRow)).toBeUndefined();

    // The removed node stays inert for anything else.
    expect(() => dispatchUIAction(engine, alphaRow, "hide", {})).toThrow();

    await Promise.all([alpha.destroy(), beta.destroy()]);
  });
});
