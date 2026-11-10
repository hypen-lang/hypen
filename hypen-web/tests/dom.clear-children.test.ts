/**
 * `clearChildren` in the DOM renderer (contract: docs/clear-children.md).
 *
 * The patch must leave the renderer in exactly the state a plain `remove`
 * per child would: children unlinked, every descendant forgotten, the parent
 * intact and reusable in the same batch.
 */
import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

const p = (patch: Record<string, unknown>) => patch as unknown as Patch;

function makeList(rows: number) {
  const container = document.createElement("div");
  const engine = { dispatchAction() {} };
  const renderer = new DOMRenderer(container, engine as unknown as Engine);
  const patches: Patch[] = [
    p({ type: "create", id: "col", elementType: "Column", props: {} }),
    p({ type: "insert", parentId: "root", id: "col" }),
    p({ type: "create", id: "header", elementType: "Text", props: { "0": "header" } }),
    p({ type: "insert", parentId: "col", id: "header" }),
    p({ type: "create", id: "list", elementType: "List", props: {} }),
    p({ type: "insert", parentId: "col", id: "list" }),
  ];
  for (let i = 0; i < rows; i++) patches.push(...rowPatches(i));
  renderer.applyPatches(patches);
  return { renderer, container: container as unknown as FakeElement };
}

/** A row with a nested child, so descendant teardown is observable. */
function rowPatches(i: number, parentId = "list"): Patch[] {
  return [
    p({ type: "create", id: `row-${i}`, elementType: "Row", props: {} }),
    p({ type: "create", id: `label-${i}`, elementType: "Text", props: { "0": `row ${i}` } }),
    p({ type: "insert", parentId: `row-${i}`, id: `label-${i}` }),
    p({ type: "insert", parentId, id: `row-${i}` }),
  ];
}

const childrenOf = (renderer: DOMRenderer, id: string) =>
  (renderer.getNode(id) as unknown as FakeElement).children;

describe("DOM renderer: clearChildren", () => {
  test("removes every child and forgets every descendant, keeping the parent", () => {
    const { renderer } = makeList(5);
    const list = renderer.getNode("list");
    expect(childrenOf(renderer, "list").length).toBe(5);

    renderer.applyPatches([p({ type: "clearChildren", id: "list" })]);

    expect(renderer.getNode("list")).toBe(list);
    expect(childrenOf(renderer, "list").length).toBe(0);
    for (let i = 0; i < 5; i++) {
      expect(renderer.getNode(`row-${i}`)).toBeUndefined();
      expect(renderer.getNode(`label-${i}`)).toBeUndefined();
    }
    // Siblings of the cleared element are untouched.
    expect(renderer.getNode("header")).toBeDefined();
    expect(childrenOf(renderer, "col").length).toBe(2);
  });

  test("matches a plain remove per child", () => {
    const cleared = makeList(4);
    const removed = makeList(4);

    cleared.renderer.applyPatches([p({ type: "clearChildren", id: "list" })]);
    removed.renderer.applyPatches(
      [0, 1, 2, 3].map((i) => p({ type: "remove", id: `row-${i}` })),
    );

    for (const id of ["col", "header", "list", "row-0", "label-0", "row-3", "label-3"]) {
      expect(cleared.renderer.getNode(id) === undefined).toBe(
        removed.renderer.getNode(id) === undefined,
      );
    }
    expect(childrenOf(cleared.renderer, "list").length).toBe(
      childrenOf(removed.renderer, "list").length,
    );
  });

  test("the parent takes new children in the same batch", () => {
    const { renderer } = makeList(3);

    renderer.applyPatches([
      p({ type: "clearChildren", id: "list" }),
      ...rowPatches(10),
      ...rowPatches(11),
    ]);

    const rows = childrenOf(renderer, "list");
    expect(rows.length).toBe(2);
    expect(rows[0]).toBe(renderer.getNode("row-10") as unknown as FakeElement);
    expect(rows[1]).toBe(renderer.getNode("row-11") as unknown as FakeElement);
    expect(renderer.getNode("row-0")).toBeUndefined();
  });

  test("an unknown id, or an already-empty element, is a no-op", () => {
    const { renderer } = makeList(0);
    renderer.applyPatches([
      p({ type: "clearChildren", id: "nope" }),
      p({ type: "clearChildren", id: "list" }),
    ]);
    expect(renderer.getNode("list")).toBeDefined();
    expect(childrenOf(renderer, "col").length).toBe(2);
  });

  test("a row still playing an earlier exit is left to finish", () => {
    const { renderer } = makeList(0);
    renderer.applyPatches([
      p({
        type: "create",
        id: "toast",
        elementType: "Text",
        props: { "0": "bye", "__anim.exit": { presets: ["fade"], duration: 30, curve: "easeIn" } },
      }),
      p({ type: "insert", parentId: "list", id: "toast" }),
      ...rowPatches(0),
      ...rowPatches(1),
    ]);
    const toast = renderer.getNode("toast") as unknown as FakeElement;
    renderer.applyPatches([p({ type: "remove", id: "toast", transition: true })]);
    // Deferred: still in the DOM, playing its exit.
    expect(childrenOf(renderer, "list")).toContain(toast);

    renderer.applyPatches([p({ type: "clearChildren", id: "list" })]);

    // The live rows are gone; the exiting one is the animator's to finish.
    expect(renderer.getNode("row-0")).toBeUndefined();
    expect(renderer.getNode("row-1")).toBeUndefined();
    expect(childrenOf(renderer, "list")).toEqual([toast]);

    toast.dispatchEvent("transitionend", { target: toast });
    expect(childrenOf(renderer, "list").length).toBe(0);
    expect(renderer.getNode("toast")).toBeUndefined();
  });
});
