import { describe, expect, test } from "bun:test";
import type { IEngine as Engine } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

function renderColumn(
  columnProps: Record<string, unknown> = {},
  childType = "Container",
  childProps: Record<string, unknown> = {},
): { column: FakeElement; child: FakeElement } {
  const container = document.createElement("div");
  const renderer = new DOMRenderer(
    container,
    new StubEngine() as unknown as Engine,
  );

  renderer.applyPatches([
    {
      type: "create",
      id: "column",
      elementType: "Column",
      props: columnProps,
    } as Patch,
    {
      type: "create",
      id: "child",
      elementType: childType,
      props: childProps,
    } as Patch,
    { type: "insert", parentId: "column", id: "child" } as Patch,
  ]);

  return {
    column: renderer.getNode("column") as unknown as FakeElement,
    child: renderer.getNode("child") as unknown as FakeElement,
  };
}

function renderTree(
  definitions: Array<[id: string, type: string, props?: Record<string, unknown>]>,
  inserts: Array<[parentId: string, id: string]>,
): { renderer: DOMRenderer; node: (id: string) => FakeElement } {
  const container = document.createElement("div");
  const renderer = new DOMRenderer(
    container,
    new StubEngine() as unknown as Engine,
  );

  renderer.applyPatches([
    ...definitions.map(([id, elementType, props = {}]) => ({
      type: "create",
      id,
      elementType,
      props,
    }) as Patch),
    ...inserts.map(([parentId, id]) => ({
      type: "insert",
      parentId,
      id,
    }) as Patch),
  ]);

  return {
    renderer,
    node: (id: string) => renderer.getNode(id) as unknown as FakeElement,
  };
}

describe("DOM Column cross-axis sizing contract", () => {
  test("a raw child wraps instead of stretching to the Column width", () => {
    const { column, child } = renderColumn({}, "Badge", { 0: "New" });

    expect(column.style.alignItems).toBe("flex-start");
    expect(child.style.width).toBeUndefined();
    expect(child.style.alignSelf).toBeUndefined();
  });

  test("minWidth establishes a floor without making the child fill", () => {
    const { child } = renderColumn(
      { width: 320 },
      "Container",
      { minWidth: 200 },
    );

    expect(child.style.minWidth).toBe("200px");
    expect(child.style.width).toBeUndefined();
    expect(child.style.alignSelf).toBeUndefined();
  });

  test("fillMaxWidth explicitly fills the Column cross-axis", () => {
    const { child } = renderColumn(
      { width: 320 },
      "Container",
      { fillMaxWidth: true },
    );

    expect(child.style.width).toBe("100%");
    expect(child.style.alignSelf).toBe("stretch");
    expect(child.style.minWidth).toBe("0");
  });

  test("horizontalAlignment stretch explicitly stretches raw children", () => {
    const { column, child } = renderColumn(
      { width: 320, horizontalAlignment: "stretch" },
      "Badge",
      { 0: "New" },
    );

    expect(column.style.alignItems).toBe("stretch");
    expect(child.style.width).toBeUndefined();
    expect(child.style.alignSelf).toBeUndefined();
  });

  test("border full-width rows expand their otherwise unsized section Column", () => {
    const { node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["styles", "Column", { gap: 8 }],
        ["solid", "Stack", { fillMaxWidth: true, border: { width: 2 } }],
        ["dashed", "Stack", { fillMaxWidth: true, border: { width: 2 } }],
      ],
      [
        ["page", "styles"],
        ["styles", "solid"],
        ["styles", "dashed"],
      ],
    );

    expect(node("styles").style.alignSelf).toBe("stretch");
    // Auto propagation uses stretch + width:auto, avoiding 100% plus
    // padding/border overflow on the intermediate Column.
    expect(node("styles").style.width).toBeUndefined();
    expect(node("solid").style.width).toBe("100%");
  });

  test("percentage-width panel receives the finite root width proposal", () => {
    const { node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["panel", "Column", { padding: 16 }],
        ["quarter", "Stack", { width: "25%" }],
        ["half", "Stack", { width: "50%" }],
        ["full", "Stack", { width: "100%" }],
      ],
      [
        ["page", "panel"],
        ["panel", "quarter"],
        ["panel", "half"],
        ["panel", "full"],
      ],
    );

    expect(node("panel").style.alignSelf).toBe("stretch");
    expect(node("quarter").style.width).toBe("25%");
    expect(node("half").style.width).toBe("50%");
    expect(node("full").style.width).toBe("100%");
  });

  test("blur skeleton card expands for fill and percentage bars", () => {
    const { node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["skeleton", "Column", { padding: 16, cornerRadius: 8 }],
        ["fullBar", "Stack", { height: 12, fillMaxWidth: true, blur: 1 }],
        ["shortBar", "Stack", { height: 12, width: "80%", blur: 1 }],
      ],
      [
        ["page", "skeleton"],
        ["skeleton", "fullBar"],
        ["skeleton", "shortBar"],
      ],
    );

    expect(node("skeleton").style.alignSelf).toBe("stretch");
    expect(node("fullBar").style.alignSelf).toBe("stretch");
    expect(node("shortBar").style.width).toBe("80%");
  });

  test("corner-radius card demand propagates through nested Columns", () => {
    const { node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["section", "Column", {}],
        ["cards", "Column", { gap: 12 }],
        ["card", "Stack", { fillMaxWidth: true, cornerRadius: 24 }],
      ],
      [
        ["page", "section"],
        ["section", "cards"],
        ["cards", "card"],
      ],
    );

    expect(node("cards").style.alignSelf).toBe("stretch");
    expect(node("section").style.alignSelf).toBe("stretch");
    expect(node("card").style.width).toBe("100%");
  });

  test("a fixed-width Column terminates descendant width demand", () => {
    const { node } = renderTree(
      [
        ["page", "Column", {}],
        ["fixed", "Column", { width: 300 }],
        ["bar", "Stack", { width: "75%" }],
      ],
      [
        ["page", "fixed"],
        ["fixed", "bar"],
      ],
    );

    expect(node("fixed").style.width).toBe("300px");
    expect(node("fixed").style.alignSelf).toBeUndefined();
    expect(node("page").style.alignSelf).toBeUndefined();
  });

  test("width demand never turns into vertical stretching inside a Row", () => {
    const { node } = renderTree(
      [
        ["page", "Column", { width: 320 }],
        ["row", "Row", {}],
        ["nested", "Column", {}],
        ["bar", "Stack", { width: "50%" }],
      ],
      [
        ["page", "row"],
        ["row", "nested"],
        ["nested", "bar"],
      ],
    );

    expect(node("nested").style.alignSelf).toBeUndefined();
  });

  test("styled Checkbox rows expand only because center arrangement requests width", () => {
    const { node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["group", "Column", { padding: 16 }],
        ["row", "Row", { horizontalAlignment: "center" }],
        // The native Checkbox host is intrinsic; a simple Container has the
        // same width-demand contract without depending on input DOM APIs in
        // this lightweight renderer test.
        ["checkbox", "Container", {}],
        ["label", "Text", { 0: "Accept terms", marginLeft: 8 }],
      ],
      [
        ["page", "group"],
        ["group", "row"],
        ["row", "checkbox"],
        ["row", "label"],
      ],
    );

    expect(node("row").style.justifyContent).toBe("center");
    expect(node("row").style.width).toBeUndefined();
    expect(node("row").style.alignSelf).toBe("stretch");
    expect(node("group").style.alignSelf).toBe("stretch");
    expect(node("checkbox").style.alignSelf).toBeUndefined();
  });

  test("a Profile Card carries its Row demand while a raw Card stays intrinsic", () => {
    const { node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["raw", "Card", {}],
        ["profile", "Card", { padding: 16 }],
        ["profileRow", "Row", { horizontalAlignment: "center" }],
      ],
      [
        ["page", "raw"],
        ["page", "profile"],
        ["profile", "profileRow"],
      ],
    );

    expect(node("raw").style.alignSelf).toBeUndefined();
    expect(node("profile").style.alignSelf).toBe("stretch");
    // Card is a normal block containing block: its Row fills with width:auto.
    expect(node("profileRow").style.width).toBeUndefined();
    expect(node("profileRow").style.alignSelf).toBeUndefined();
  });

  test("horizontal Dividers fill raw and list sections without margin overflow", () => {
    const { node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["section", "Column", {}],
        ["rawDivider", "Divider", {}],
        ["list", "List", {}],
        ["listDivider", "Divider", { marginLeft: 12 }],
      ],
      [
        ["page", "section"],
        ["section", "rawDivider"],
        ["page", "list"],
        ["list", "listDivider"],
      ],
    );

    expect(node("rawDivider").style.alignSelf).toBe("stretch");
    expect(node("section").style.alignSelf).toBe("stretch");
    expect(node("listDivider").style.alignSelf).toBe("stretch");
    expect(node("listDivider").style.marginLeft).toBe("12px");
    expect(node("listDivider").style.width).toBeUndefined();
    expect(node("list").style.alignSelf).toBe("stretch");
  });

  test("positive weight, flex and flexGrow children expand actual Rows", () => {
    for (const [prop, value] of [["weight", 1], ["flex", 2], ["flexGrow", 1]] as const) {
      const { node } = renderTree(
        [
          ["page", "Column", { fillMaxSize: true }],
          ["section", "Column", {}],
          ["row", "Row", {}],
          ["item", "Stack", { [prop]: value }],
        ],
        [
          ["page", "section"],
          ["section", "row"],
          ["row", "item"],
        ],
      );

      expect(node("row").style.alignSelf).toBe("stretch");
      expect(node("section").style.alignSelf).toBe("stretch");
      expect(node("row").style.width).toBeUndefined();
    }
  });

  test("fractional fill children give their Row a finite percentage basis", () => {
    const { node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["row", "Row", { gap: 8, padding: 8 }],
        ["halfA", "Stack", { fillMaxWidth: 0.5 }],
        ["halfB", "Stack", { fillMaxWidth: 0.5 }],
      ],
      [
        ["page", "row"],
        ["row", "halfA"],
        ["row", "halfB"],
      ],
    );

    expect(node("row").style.alignSelf).toBe("stretch");
    expect(node("row").style.width).toBeUndefined();
    expect(node("halfA").style.width).toBe("50%");
    expect(node("halfB").style.width).toBe("50%");
  });

  test("direct justifyContent requests width only for an actual Row", () => {
    const { node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["row", "Row", { justifyContent: "spaceBetween" }],
        ["badge", "Badge", { justifyContent: "center" }],
      ],
      [
        ["page", "row"],
        ["page", "badge"],
      ],
    );

    expect(node("row").style.justifyContent).toBe("space-between");
    expect(node("row").style.alignSelf).toBe("stretch");
    expect(node("badge").style.alignSelf).toBeUndefined();
  });

  test("demand markers reconcile after prop removal, remove and move", () => {
    const { renderer, node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["left", "Column", {}],
        ["right", "Column", {}],
        ["row", "Row", { horizontalAlignment: "center" }],
      ],
      [
        ["page", "left"],
        ["page", "right"],
        ["left", "row"],
      ],
    );

    expect(node("left").style.alignSelf).toBe("stretch");
    renderer.applyPatches([{ type: "move", parentId: "right", id: "row" } as Patch]);
    expect(node("left").style.alignSelf).toBeUndefined();
    expect(node("right").style.alignSelf).toBe("stretch");

    renderer.applyPatches([{ type: "removeProp", id: "row", name: "horizontalAlignment" } as Patch]);
    expect(node("row").style.alignSelf).toBeUndefined();
    expect(node("right").style.alignSelf).toBeUndefined();

    renderer.applyPatches([{ type: "setProp", id: "row", name: "horizontalAlignment", value: "end" } as Patch]);
    expect(node("right").style.alignSelf).toBe("stretch");
    renderer.applyPatches([{ type: "remove", id: "row" } as Patch]);
    expect(node("right").style.alignSelf).toBeUndefined();
  });

  test("flex and Divider demand update without leaving stale ancestor stretch", () => {
    const { renderer, node } = renderTree(
      [
        ["page", "Column", { fillMaxSize: true }],
        ["section", "Column", {}],
        ["row", "Row", {}],
        ["item", "Stack", { flexGrow: 1 }],
        ["divider", "Divider", {}],
      ],
      [
        ["page", "section"],
        ["section", "row"],
        ["row", "item"],
        ["section", "divider"],
      ],
    );

    expect(node("row").style.alignSelf).toBe("stretch");
    expect(node("divider").style.alignSelf).toBe("stretch");

    renderer.applyPatches([
      { type: "setProp", id: "item", name: "flexGrow", value: 0 } as Patch,
      { type: "setProp", id: "divider", name: "orientation", value: "vertical" } as Patch,
    ]);
    expect(node("row").style.alignSelf).toBeUndefined();
    expect(node("divider").style.alignSelf).toBeUndefined();
    expect(node("section").style.alignSelf).toBeUndefined();

    renderer.applyPatches([
      { type: "removeProp", id: "divider", name: "orientation" } as Patch,
    ]);
    expect(node("divider").style.alignSelf).toBe("stretch");
    expect(node("section").style.alignSelf).toBe("stretch");
  });

  test("Stack alignment is resolved as grid alignment before insertion", () => {
    const { node } = renderTree(
      [
        ["stack", "Stack", { alignment: "center", width: 300, height: 200 }],
        ["overlay", "Column", {}],
      ],
      [["stack", "overlay"]],
    );

    expect(node("stack").style.justifyItems).toBe("center");
    expect(node("stack").style.alignItems).toBe("center");
    expect(node("stack").style.justifyContent).toBeUndefined();
  });
});
