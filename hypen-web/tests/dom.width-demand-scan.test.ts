/**
 * The width-demand reconcile walk runs from every insert/remove up through
 * every ancestor, and a list container's children ARE the rows being
 * inserted or removed. Its child scan must therefore stop at the first
 * demanding child instead of materializing the whole collection: with
 * `Array.from(children).some(...)` a 1,000-row create or clear copied all
 * ~1,000 children once per row — O(rows²), 41% of replace-1k in a browser
 * CPU profile.
 *
 * Tested on the module function directly with hand-built fake elements
 * (the fake DOM's own `contains`/`removeChild` are O(children), which
 * would drown a renderer-level count). `children` is swapped for a proxy
 * that counts indexed reads.
 */

import { describe, expect, test } from "bun:test";
import { reconcileColumnWidthDemandFrom } from "../packages/web/src/dom/cross-axis-width";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

function el(type: string, parent?: FakeElement): FakeElement {
  const e = document.createElement("div") as unknown as FakeElement;
  e.dataset.hypenType = type;
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * Count the rows a scan probes: every probe reads the child's dataset
 * (width sources, then the demand marker), so wrap each row's dataset.
 */
function countChildReads(node: FakeElement): { reads: number; rows: Set<FakeElement> } {
  const stats = { reads: 0, rows: new Set<FakeElement>() };
  for (const row of node.children) {
    row.dataset = new Proxy(row.dataset, {
      get(target, key, receiver) {
        stats.reads++;
        stats.rows.add(row);
        return Reflect.get(target, key, receiver);
      },
    });
  }
  return stats;
}

function listWithRows(rows: number, demandingIndex: number | null) {
  const col = el("column");
  const list = el("column", col);
  for (let i = 0; i < rows; i++) {
    const row = el("row", list);
    if (i === demandingIndex) row.dataset.hypenHorizontalWidthDemand = "true";
  }
  return { col, list };
}

describe("width-demand child scan", () => {
  test("stops at the first demanding child (O(1) per reconcile on a big list)", () => {
    const { col, list } = listWithRows(1000, 0);
    const stats = countChildReads(list);
    for (let i = 0; i < 100; i++) reconcileColumnWidthDemandFrom(list);
    expect(list.dataset.hypenHorizontalWidthDemand).toBe("true");
    expect(col.dataset.hypenHorizontalWidthDemand).toBe("true");
    // One probe per reconcile: the first child already carries demand
    // (a probe is at most the four width-source keys plus the marker).
    expect(stats.rows.size).toBe(1);
    expect(stats.reads).toBeLessThanOrEqual(100 * 5);
  });

  test("still finds demand carried only by the last child", () => {
    const { col, list } = listWithRows(1000, 999);
    const stats = countChildReads(list);
    reconcileColumnWidthDemandFrom(list);
    expect(list.dataset.hypenHorizontalWidthDemand).toBe("true");
    expect(col.dataset.hypenHorizontalWidthDemand).toBe("true");
    // Had to look at every child, each once.
    expect(stats.rows.size).toBe(1000);
    expect(stats.reads).toBeLessThanOrEqual(1000 * 5);
  });

  test("stops walking up at the first ancestor whose marker did not change", () => {
    // root > wrap > list > rows. Once the list already carries demand, one
    // more row cannot change wrap's or root's inputs — the walk must not
    // touch them at all (each insert/remove of a 1,000-row list used to
    // re-walk this whole chain).
    const root = el("column");
    const wrap = el("column", root);
    const list = el("column", wrap);
    for (let i = 0; i < 3; i++) {
      const row = el("row", list);
      row.dataset.hypenHorizontalWidthDemand = "true";
    }
    reconcileColumnWidthDemandFrom(list.children[0] as FakeElement);
    expect(list.dataset.hypenHorizontalWidthDemand).toBe("true");
    expect(wrap.dataset.hypenHorizontalWidthDemand).toBe("true");
    expect(root.dataset.hypenHorizontalWidthDemand).toBe("true");

    const touched: Record<"wrap" | "root", string[]> = { wrap: [], root: [] };
    const spy = (node: FakeElement, key: keyof typeof touched) => {
      node.dataset = new Proxy(node.dataset, {
        get(target, prop, receiver) {
          touched[key].push(String(prop));
          return Reflect.get(target, prop, receiver);
        },
      });
    };
    spy(wrap, "wrap");
    spy(root, "root");

    const row = el("row", list);
    row.dataset.hypenWidthSourceWidth = "relative";
    reconcileColumnWidthDemandFrom(row);
    // The mutation site (row) and its parent (list) recompute; list's marker
    // is unchanged, so the walk ends there. The list's own recompute may
    // read its parent's TYPE (auto-stretch needs a vertical parent) — but
    // never wrap's markers, and nothing at all on root.
    expect(touched.wrap.filter((p) => p !== "hypenType")).toEqual([]);
    expect(touched.root).toEqual([]);
  });

  test("a change that flips an ancestor keeps propagating to the top", () => {
    const root = el("column");
    const wrap = el("column", root);
    const list = el("column", wrap);
    const only = el("row", list);
    only.dataset.hypenWidthSourceWidth = "relative";
    reconcileColumnWidthDemandFrom(only);
    expect(root.dataset.hypenHorizontalWidthDemand).toBe("true");

    // The only demanding descendant leaves: list flips, wrap flips, root
    // flips — no early stop anywhere on the chain.
    list.removeChild(only);
    reconcileColumnWidthDemandFrom(list);
    expect(list.dataset.hypenHorizontalWidthDemand).toBeUndefined();
    expect(wrap.dataset.hypenHorizontalWidthDemand).toBeUndefined();
    expect(root.dataset.hypenHorizontalWidthDemand).toBeUndefined();

    // And it comes back the same way.
    list.appendChild(only);
    reconcileColumnWidthDemandFrom(only);
    expect(root.dataset.hypenHorizontalWidthDemand).toBe("true");
  });

  test("clears the marker when no child carries demand", () => {
    const { col, list } = listWithRows(50, 0);
    reconcileColumnWidthDemandFrom(list);
    expect(list.dataset.hypenHorizontalWidthDemand).toBe("true");
    delete (list.children[0] as FakeElement).dataset.hypenHorizontalWidthDemand;
    reconcileColumnWidthDemandFrom(list);
    expect(list.dataset.hypenHorizontalWidthDemand).toBeUndefined();
    expect(col.dataset.hypenHorizontalWidthDemand).toBeUndefined();
  });
});
