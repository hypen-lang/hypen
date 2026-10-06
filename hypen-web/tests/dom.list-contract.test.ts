import { describe, expect, test } from "bun:test";
import type { IEngine as Engine } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

function renderList(props: Record<string, unknown> = {}): {
  list: FakeElement;
  row: FakeElement;
} {
  const renderer = new DOMRenderer(
    document.createElement("div"),
    new StubEngine() as unknown as Engine,
  );
  renderer.applyPatches([
    { type: "create", id: "page", elementType: "Column", props: { fillMaxSize: true } } as Patch,
    { type: "create", id: "list", elementType: "List", props } as Patch,
    { type: "create", id: "row", elementType: "Row", props: { backgroundColor: "#fff" } } as Patch,
    { type: "insert", parentId: "page", id: "list" } as Patch,
    { type: "insert", parentId: "list", id: "row" } as Patch,
  ]);
  return {
    list: renderer.getNode("list") as unknown as FakeElement,
    row: renderer.getNode("row") as unknown as FakeElement,
  };
}

describe("DOM List contract", () => {
  test("raw List fills finite width but keeps content height", () => {
    const { list } = renderList();

    expect(list.style.alignSelf).toBe("stretch");
    expect(list.style.width).toBeUndefined();
    expect(list.style.height).toBeUndefined();
    expect(list.style.overflow).toBe("auto");
  });

  test("ordinary rows stretch across the List track", () => {
    const { list, row } = renderList();

    expect(list.style.alignItems).toBe("stretch");
    expect(row.style.width).toBeUndefined();
  });

  test("a finite height preserves scrolling", () => {
    const { list } = renderList({ "height.0": 120 });

    expect(list.style.height).toBe("120px");
    expect(list.style.overflow).toBe("auto");
  });
});
