import { describe, expect, test } from "bun:test";
import type { IEngine as Engine } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";
import { DIVIDER_DEFAULTS } from "../packages/web/src/dom/components/divider";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

function render(
  definitions: Array<[id: string, type: string, props?: Record<string, unknown>]>,
  inserts: Array<[parentId: string, id: string]> = [],
): (id: string) => FakeElement {
  const renderer = new DOMRenderer(
    document.createElement("div"),
    new StubEngine() as unknown as Engine,
  );
  renderer.applyPatches([
    ...definitions.map(([id, elementType, props = {}]) => ({
      type: "create", id, elementType, props,
    }) as Patch),
    ...inserts.map(([parentId, id]) => ({
      type: "insert", parentId, id,
    }) as Patch),
  ]);
  return (id: string) => renderer.getNode(id) as unknown as FakeElement;
}

describe("DOM Divider contract", () => {
  test("raw horizontal Divider uses the canonical stroke", () => {
    const node = render([["divider", "Divider"]])("divider");

    expect(node.tagName.toLowerCase()).toBe("div");
    expect(node.style.height).toBe(DIVIDER_DEFAULTS.thickness);
    expect(node.style.backgroundColor).toBe(DIVIDER_DEFAULTS.color);
    expect(node.style.margin).toBe("0");
  });

  test("backgroundColor and height control the stroke", () => {
    const node = render([[
      "divider", "Divider", { "backgroundColor.0": "#3b82f6", "height.0": 3 },
    ]])("divider");

    expect(node.style.backgroundColor).toBe("#3b82f6");
    expect(node.style.height).toBe("3px");
  });

  test("an inset Divider stretches only across the remaining Column width", () => {
    const node = render(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["list", "List"],
        ["divider", "Divider", { "marginLeft.0": 16 }],
      ],
      [["page", "list"], ["list", "divider"]],
    );

    expect(node("divider").style.alignSelf).toBe("stretch");
    expect(node("divider").style.width).toBeUndefined();
    expect(node("divider").style.marginLeft).toBe("16px");
    expect(node("list").style.alignSelf).toBe("stretch");
  });
});

describe("DOM Grid contract", () => {
  test("raw Grid has zero gap and consumes a finite Column width", () => {
    const node = render(
      [["page", "Column", { fillMaxSize: true }], ["grid", "Grid"]],
      [["page", "grid"]],
    );

    expect(node("grid").style.display).toBe("grid");
    expect(node("grid").style.gap).toBe("0px");
    expect(node("grid").style.alignSelf).toBe("stretch");
    expect(node("grid").style.width).toBeUndefined();
  });

  test("explicit columns and gap are preserved", () => {
    const node = render([[
      "grid", "Grid", { "gridColumns.0": 3, "gap.0": 12 },
    ]])("grid");

    expect(node.style.gridTemplateColumns).toBe("repeat(3, 1fr)");
    expect(node.style.gap).toBe("12px");
  });
});
