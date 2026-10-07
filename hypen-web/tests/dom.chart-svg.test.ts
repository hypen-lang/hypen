import { semanticAction } from "./helpers";
/**
 * Chart family on a real (jsdom) DOM.
 *
 * The fake DOM makes every element an HTMLElement, which hides the one thing
 * that differs for charts in a browser: the host is an SVGElement, so the
 * renderer's child-change notifications (which used to gate on
 * `instanceof HTMLElement`) must still reach it, and events raised on a
 * `<rect>` must bubble to the mark's `<g>` listener with the datum resolved
 * from the rect's `data-index`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { IEngine as Engine } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";
import { DOMRenderer } from "../packages/web/src/dom/renderer";

class StubEngine {
  dispatched: Array<{ name: string; payload: any }> = [];
  dispatchAction(name: string, payload?: any): void {
    this.dispatched.push(semanticAction(name, payload));
  }
}

describe("Chart on jsdom", () => {
  let dom: JSDOM;
  let document: Document;

  // Globals the renderer and event applicators read; restored afterwards so
  // later test files (which build on the lightweight fake DOM or a bare
  // EventTarget) do not inherit jsdom's constructors.
  const NAMES = [
    "window", "document", "HTMLElement", "SVGElement", "Element",
    "MouseEvent", "KeyboardEvent",
    "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
  ] as const;
  const saved: Partial<Record<(typeof NAMES)[number], unknown>> = {};

  beforeAll(() => {
    dom = new JSDOM(`<!DOCTYPE html><html><body><div id="app"></div></body></html>`);
    const window = dom.window as any;
    document = window.document;
    for (const name of NAMES) {
      saved[name] = (global as any)[name];
      (global as any)[name] = name === "window" ? window : window[name];
    }
  });

  afterAll(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete (global as any)[name];
      else (global as any)[name] = saved[name];
    }
  });

  function mount() {
    const engine = new StubEngine();
    const renderer = new DOMRenderer(document.getElementById("app")!, engine as unknown as Engine);
    const rows = [
      { month: "Jan", count: 10 },
      { month: "Feb", count: 30 },
      { month: "Mar", count: 20 },
    ];
    renderer.applyPatches([
      { type: "create", id: "c", elementType: "Chart", props: { width: 300, height: 150 } },
      { type: "create", id: "ax", elementType: "Axis", props: { "0": "x" } },
      { type: "create", id: "b", elementType: "Bars", props: { data: rows, x: "month", y: "count", "onClick.0": "@actions.pick" } },
      { type: "create", id: "m", elementType: "Marker", props: { x: "Feb", y: 30 } },
      { type: "create", id: "t", elementType: "Text", props: { text: "peak" } },
      { type: "insert", parentId: "root", id: "c" },
      { type: "insert", parentId: "c", id: "ax" },
      { type: "insert", parentId: "c", id: "b" },
      { type: "insert", parentId: "c", id: "m" },
      { type: "insert", parentId: "m", id: "t" },
    ] as Patch[]);
    return { engine, renderer, rows };
  }

  test("the host is a real SVGElement and marks are laid out after insertion", () => {
    const { renderer } = mount();
    const svg = renderer.getNode("c") as unknown as SVGSVGElement;
    const win = dom.window as any;
    expect(svg instanceof win.SVGElement).toBe(true);
    expect(svg instanceof win.HTMLElement).toBe(false);
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");

    // Insert → onChildrenChanged → layout: bars exist without any later SetProp.
    const bars = renderer.getNode("b") as unknown as SVGGElement;
    expect(bars.querySelectorAll("rect").length).toBe(3);
    const axis = renderer.getNode("ax") as unknown as SVGGElement;
    expect([...axis.querySelectorAll("text")].map((t) => t.textContent)).toEqual(["Jan", "Feb", "Mar"]);
  });

  test("Marker hosts an HTML child inside a foreignObject", () => {
    const { renderer } = mount();
    const marker = renderer.getNode("m") as unknown as SVGForeignObjectElement;
    expect(marker.tagName.toLowerCase()).toBe("foreignobject");
    expect(marker.getAttribute("x")).not.toBeNull();
    const text = renderer.getNode("t") as HTMLElement;
    expect(text.parentNode).toBe(marker);
    expect(text instanceof (dom.window as any).HTMLElement).toBe(true);
  });

  test("a click on a <rect> bubbles to the mark and carries its datum", () => {
    const { engine, renderer, rows } = mount();
    const bars = renderer.getNode("b") as unknown as SVGGElement;
    const rect = bars.querySelectorAll("rect")[2]!;
    rect.dispatchEvent(new (dom.window as any).MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(engine.dispatched.length).toBe(1);
    const { name, payload } = engine.dispatched[0]!;
    expect(name).toBe("pick");
    expect(payload.index).toBe(2);
    expect(payload.x).toBe("Mar");
    expect(payload.y).toBe(20);
    expect(payload.datum).toEqual(rows[2]);
    // Pixel coordinates from the generic extractor are still there for
    // callers that want them, but the datum is the contract.
    expect(payload.clientX).toBe(5);
  });

  test("removing a mark from the SVG host re-lays the chart out", () => {
    const { renderer } = mount();
    renderer.applyPatches([
      { type: "create", id: "l", elementType: "Line", props: { points: [[0, 500]] } },
      { type: "insert", parentId: "c", id: "l" },
    ] as Patch[]);
    const bars = renderer.getNode("b") as unknown as SVGGElement;
    const squashed = Number(bars.querySelector("rect")!.getAttribute("height"));
    renderer.applyPatches([{ type: "remove", id: "l" } as Patch]);
    const restored = Number(bars.querySelector("rect")!.getAttribute("height"));
    expect(restored).toBeGreaterThan(squashed);
  });
});
