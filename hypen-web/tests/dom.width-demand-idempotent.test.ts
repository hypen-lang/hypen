/**
 * The horizontal width-demand pass (`cross-axis-width.ts`) reconciles
 * from every insert/move/remove up through all ancestors. Its dataset
 * writes must be write-if-changed: re-setting an attribute to the value
 * it already holds still fires a MutationObserver record and a style
 * invalidation, so a 1,000-row create used to re-stamp the same ancestor
 * chain a thousand times (4,000 observable attribute mutations, 7,000 on
 * replace, 3,000 on clear — where React produced zero).
 *
 * The fake DOM has no MutationObserver, so the ancestors' `dataset`
 * objects are wrapped in counting proxies: any write to an already-held
 * value is the regression.
 */

import { describe, expect, test } from "bun:test";
import type { IEngine as Engine } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

/** Wrap `el.dataset` so every set/delete is recorded, flagging writes
 * that don't change the stored value. */
function countDatasetWrites(el: FakeElement) {
  const stats = { writes: 0, redundant: 0 };
  el.dataset = new Proxy(el.dataset, {
    set(target, key, value) {
      stats.writes++;
      if (target[key as string] === value) stats.redundant++;
      target[key as string] = value;
      return true;
    },
    deleteProperty(target, key) {
      stats.writes++;
      if (!(key in target)) stats.redundant++;
      delete target[key as string];
      return true;
    },
  });
  return stats;
}

function rowPatches(i: number): Patch[] {
  return [
    { type: "create", id: `row${i}`, elementType: "Row", props: { width: "100%" } } as Patch,
    { type: "create", id: `txt${i}`, elementType: "Text", props: { text: `r${i}` } } as Patch,
    { type: "insert", parentId: `row${i}`, id: `txt${i}` } as Patch,
    { type: "insert", parentId: "list", id: `row${i}` } as Patch,
  ];
}

function setup(rows: number) {
  const container = document.createElement("div");
  const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
  renderer.applyPatches([
    { type: "create", id: "col", elementType: "Column", props: {} } as Patch,
    { type: "create", id: "list", elementType: "Column", props: {} } as Patch,
    { type: "insert", parentId: "col", id: "list" } as Patch,
    ...Array.from({ length: rows }, (_, i) => rowPatches(i)).flat(),
  ]);
  const col = container.children[0] as unknown as FakeElement;
  const list = col.children[0] as unknown as FakeElement;
  return { renderer, col, list };
}

describe("width-demand reconcile writes only on change", () => {
  test("the demand chain is established once by the first demanding row", () => {
    const { col, list } = setup(3);
    expect(list.dataset.hypenHorizontalWidthDemand).toBe("true");
    expect(col.dataset.hypenHorizontalWidthDemand).toBe("true");
  });

  test("inserting 200 more rows re-stamps no ancestor", () => {
    const { renderer, col, list } = setup(3);
    const colStats = countDatasetWrites(col);
    const listStats = countDatasetWrites(list);

    renderer.applyPatches(
      Array.from({ length: 200 }, (_, i) => rowPatches(100 + i)).flat(),
    );

    expect(list.dataset.hypenHorizontalWidthDemand).toBe("true");
    expect(colStats.writes).toBe(0);
    expect(listStats.writes).toBe(0);
  });

  test("removing rows re-stamps nothing while demand remains", () => {
    const { renderer, col, list } = setup(50);
    const colStats = countDatasetWrites(col);
    const listStats = countDatasetWrites(list);

    renderer.applyPatches(
      Array.from({ length: 49 }, (_, i) => ({ type: "remove", id: `row${i}` }) as Patch),
    );

    expect(list.children.length).toBe(1);
    expect(list.dataset.hypenHorizontalWidthDemand).toBe("true");
    expect(colStats.writes).toBe(0);
    expect(listStats.writes).toBe(0);
  });

  test("the marker is still cleared when the last demanding child leaves", () => {
    const { renderer, col, list } = setup(2);
    const colStats = countDatasetWrites(col);
    const listStats = countDatasetWrites(list);

    renderer.applyPatches([
      { type: "remove", id: "row0" } as Patch,
      { type: "remove", id: "row1" } as Patch,
    ]);

    expect(list.dataset.hypenHorizontalWidthDemand).toBeUndefined();
    expect(col.dataset.hypenHorizontalWidthDemand).toBeUndefined();
    // Exactly one clearing delete per ancestor — and never a redundant one.
    expect(listStats.redundant).toBe(0);
    expect(colStats.redundant).toBe(0);
  });
});
