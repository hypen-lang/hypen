/**
 * Node identity in the DOM renderer.
 *
 * The engine's node id lives on the element as a property (`getNodeId`), not
 * as a `data-hypen-id` attribute: the attribute is one DOM write per element
 * that template cloning cannot supply, and it is only written when the
 * renderer is asked to (`stampNodeIds`, or debug mode).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { getNodeId } from "../packages/web/src/dom/element-data";
import { getLogLevel, setDebugMode, setLogLevel } from "../packages/core/src/logger";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

const p = (patch: Record<string, unknown>) => patch as unknown as Patch;

const TEMPLATE = {
  elementType: "Row",
  props: {},
  children: [{ elementType: "Text", props: { "0": "label" }, children: [] }],
};

function render(options?: { stampNodeIds?: boolean }) {
  const container = document.createElement("div");
  const calls: Array<{ name: string; payload: any }> = [];
  const engine = { dispatchAction: (name: string, payload: any) => calls.push({ name, payload }) };
  const renderer = new DOMRenderer(container, engine as unknown as Engine, undefined, options);
  renderer.applyPatches([
    p({ type: "create", id: "col", elementType: "Column", props: {} }),
    p({ type: "insert", parentId: "root", id: "col" }),
    p({ type: "create", id: "btn", elementType: "Button", props: { "onClick.0": "@tap", "onClick.id": "x" } }),
    p({ type: "insert", parentId: "col", id: "btn" }),
    p({ type: "registerTemplate", templateId: "t", root: TEMPLATE }),
    p({ type: "instantiate", templateId: "t", parentId: "col", nodes: ["r1", "r1t"], subs: [] }),
    p({ type: "instantiate", templateId: "t", parentId: "col", nodes: ["r2", "r2t"], subs: [] }),
  ]);
  const el = (id: string) => renderer.getNode(id) as unknown as FakeElement;
  return { renderer, el, calls };
}

// Debug mode is a process-wide log level: put back exactly what was there.
const initialLevel = getLogLevel();
afterEach(() => setLogLevel(initialLevel));

describe("DOM renderer: node ids", () => {
  test("every created and instantiated element knows its id without an attribute", () => {
    const { el } = render();
    for (const id of ["col", "btn", "r1", "r1t", "r2", "r2t"]) {
      expect(getNodeId(el(id))).toBe(id);
      expect(el(id).getAttribute("data-hypen-id")).toBeNull();
      // The stylesheet scope and type lookups rely on this one instead.
      expect(el(id).dataset.hypenType).toBeDefined();
    }
  });

  test("stampNodeIds also writes the attribute, for devtools and selectors", () => {
    const { el } = render({ stampNodeIds: true });
    for (const id of ["col", "btn", "r1", "r1t", "r2", "r2t"]) {
      expect(getNodeId(el(id))).toBe(id);
      expect(el(id).dataset.hypenId).toBe(id);
    }
  });

  test("debug mode stamps by default; an explicit option still wins", () => {
    setDebugMode(true);
    expect(render().el("r1").dataset.hypenId).toBe("r1");
    expect(render({ stampNodeIds: false }).el("r1").dataset.hypenId).toBeUndefined();
  });

  test("elements the renderer did not create have no id", () => {
    expect(getNodeId(document.createElement("div"))).toBeUndefined();
    expect(getNodeId(null)).toBeUndefined();
  });

  test("events still resolve their node without the attribute", () => {
    const { el, calls } = render();
    el("btn").dispatchEvent("click", { type: "click", target: el("btn") });
    // Dispatched WITH its node: an element that lost its id would fall
    // back to the bare legacy dispatch (`tap`), silently.
    expect(calls).toEqual([
      { name: "__hypen_dispatch", payload: { node: "btn", action: "tap", payload: { id: "x" } } },
    ]);
  });
});
