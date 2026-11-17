/**
 * A Text's leading / trailing spaces are content. The Text `<span>` is an
 * inline-block with `white-space: normal`, where edge spaces collapse away,
 * so `Row { Text("Results for ") Text("@{state.query}") }` rendered
 * "Results forPizza" (Food ordering search, cart "From Napoli") while the
 * desktop renderer kept the space. Edge spaces are written as no-break
 * spaces, on create and on every later text update.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { preserveEdgeSpaces } from "../packages/web/src/dom/components/text";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

const NBSP = " ";

const makeRenderer = () => {
  const container = document.createElement("div");
  const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
  return { container, renderer };
};

describe("Text edge spaces", () => {
  test("preserveEdgeSpaces turns only the edge runs into no-break spaces", () => {
    expect(preserveEdgeSpaces("Results for ")).toBe(`Results for${NBSP}`);
    expect(preserveEdgeSpaces("  a  b ")).toBe(`${NBSP}${NBSP}a  b${NBSP}`);
    expect(preserveEdgeSpaces("plain")).toBe("plain");
    expect(preserveEdgeSpaces("")).toBe("");
  });

  test("a Text keeps its trailing space on create and on update", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      { type: "create", id: "row", elementType: "Row", props: {} } as Patch,
      { type: "create", id: "a", elementType: "Text", props: { "0": "From " } } as Patch,
      { type: "create", id: "b", elementType: "Text", props: { "0": "Napoli" } } as Patch,
      { type: "insert", parentId: "root", id: "row", beforeId: null } as Patch,
      { type: "insert", parentId: "row", id: "a", beforeId: null } as Patch,
      { type: "insert", parentId: "row", id: "b", beforeId: null } as Patch,
    ]);
    const a = (renderer as any).nodes.get("a");
    const b = (renderer as any).nodes.get("b");
    expect(a.textContent).toBe(`From${NBSP}`);
    expect(b.textContent).toBe("Napoli");
    renderer.applyPatches([{ type: "setProp", id: "a", name: "0", value: " Results for " } as Patch]);
    expect(a.textContent).toBe(`${NBSP}Results for${NBSP}`);
    renderer.applyPatches([{ type: "setProp", id: "a", name: "0", value: "Plain" } as Patch]);
    expect(a.textContent).toBe("Plain");
  });
});
