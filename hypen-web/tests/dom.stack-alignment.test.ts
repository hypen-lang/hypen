import { describe, expect, test } from "bun:test";
import type { IEngine as Engine } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

function renderStack(props: Record<string, unknown>): FakeElement {
  const container = document.createElement("div");
  const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
  renderer.applyPatches([
    { type: "create", id: "stack", elementType: "Stack", props } as Patch,
    { type: "create", id: "img", elementType: "Image", props: { src: "a.png" } } as Patch,
    { type: "create", id: "badge", elementType: "Container", props: {} } as Patch,
    { type: "insert", parentId: "stack", id: "img" } as Patch,
    { type: "insert", parentId: "stack", id: "badge" } as Patch,
  ]);
  return renderer.getNode("stack") as unknown as FakeElement;
}

describe("Stack alignment (grid host)", () => {
  // Regression: `justify-items: flex-end` is not a valid grid keyword, so a
  // `.horizontalAlignment("end")` Stack kept its stylesheet `start` and a
  // corner badge landed bottom-LEFT on the web while Android/iOS put it
  // bottom-right. Grid hosts must receive `start`/`end`.
  test("end/end places children in the bottom-right corner", () => {
    const stack = renderStack({ "horizontalAlignment.0": "end", "verticalAlignment.0": "end" });
    expect(stack.style.justifyItems).toBe("end");
    expect(stack.style.alignItems).toBe("end");
  });

  test("start/center map to grid keywords too", () => {
    const stack = renderStack({ "horizontalAlignment.0": "start", "verticalAlignment.0": "center" });
    expect(stack.style.justifyItems).toBe("start");
    expect(stack.style.alignItems).toBe("center");
  });

  test(".alignment sets both axes", () => {
    const stack = renderStack({ "alignment.0": "end" });
    expect(stack.style.justifyItems).toBe("end");
    expect(stack.style.alignItems).toBe("end");
  });
});
