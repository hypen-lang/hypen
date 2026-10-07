/**
 * `instantiate` applies a row's item-dependent props (`subs`) through
 * per-template resolved appliers instead of the generic `onSetProp`
 * dispatch. The observable result must not differ: plain text lands as
 * text content, style props go through their applicator and still
 * update width demand, component attributes still route through the
 * handler, and a value that is itself a `@{…}` template still gets
 * recorded for client-side re-interpolation.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

const makeRenderer = () => {
  const container = document.createElement("div");
  const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
  return { container, renderer };
};

const template = {
  elementType: "Row",
  props: {},
  children: [
    { elementType: "Text", props: {}, children: [] },
    { elementType: "Column", props: { "height.0": 10 }, children: [] },
    { elementType: "Image", props: {}, children: [] },
  ],
};

const register = (renderer: DOMRenderer) =>
  renderer.applyPatches([
    { type: "create", id: "list", elementType: "Column", props: {} } as any,
    { type: "registerTemplate", templateId: "t", root: template } as any,
  ]);

const instantiate = (
  renderer: DOMRenderer,
  ids: string[],
  subs: Array<[number, string, unknown]>,
) =>
  renderer.applyPatches([
    {
      type: "instantiate",
      templateId: "t",
      parentId: "list",
      nodes: ids,
      subs,
      nodeSemantics: [],
    } as any,
  ]);

const node = (renderer: DOMRenderer, id: string) => (renderer as any).nodes.get(id);

describe("instantiate subs", () => {
  test("text, applicator and handler subs land where the generic path put them", () => {
    const { renderer } = makeRenderer();
    register(renderer);
    instantiate(renderer, ["r1", "t1", "c1", "i1"], [
      [1, "0", "hello"],
      [2, "color.0", "red"],
      [2, "width.0", "100%"],
      [3, "src", "a.png"],
    ]);

    expect(node(renderer, "t1").textContent).toBe("hello");
    const column = node(renderer, "c1");
    expect(column.style.color).toBe("red");
    expect(column.style.width).toBe("100%");
    // A relative width is horizontal demand: the applicator sub must still
    // update the marker chain, once, after all subs.
    expect(column.dataset.hypenHorizontalWidthDemand).toBe("true");
    expect(node(renderer, "r1").dataset.hypenHorizontalWidthDemand).toBe("true");
    const image = node(renderer, "i1");
    expect(image.querySelector("img")?.src ?? image.src).toBe("a.png");
  });

  test("a second instantiation reuses the resolved appliers and gets its own values", () => {
    const { renderer } = makeRenderer();
    register(renderer);
    instantiate(renderer, ["r1", "t1", "c1", "i1"], [[1, "0", "one"], [2, "color.0", "red"]]);
    instantiate(renderer, ["r2", "t2", "c2", "i2"], [[1, "0", "two"], [2, "color.0", "blue"]]);

    expect(node(renderer, "t1").textContent).toBe("one");
    expect(node(renderer, "t2").textContent).toBe("two");
    expect(node(renderer, "c1").style.color).toBe("red");
    expect(node(renderer, "c2").style.color).toBe("blue");
  });

  test("a text sub that is itself a template is recorded for re-interpolation", () => {
    const { renderer } = makeRenderer();
    register(renderer);
    instantiate(renderer, ["r1", "t1", "c1", "i1"], [[1, "0", "Hi @{state.name}"]]);

    const text = node(renderer, "t1");
    expect(text.dataset.textTemplate).toBe("Hi @{state.name}");
    expect((renderer as any).textBindings.get("t1")?.template).toBe("Hi @{state.name}");
  });

  test("a plain text sub leaves no template marker behind", () => {
    const { renderer } = makeRenderer();
    register(renderer);
    instantiate(renderer, ["r1", "t1", "c1", "i1"], [[1, "0", "plain"]]);

    expect(node(renderer, "t1").dataset.textTemplate).toBeUndefined();
    expect((renderer as any).textBindings.has("t1")).toBe(false);
  });
});
