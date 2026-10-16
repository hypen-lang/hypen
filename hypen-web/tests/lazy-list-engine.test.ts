/**
 * List virtualization through the shipped wasm-node engine: a `List`
 * materializes only a window of its rows, describes it in `__virt.window`,
 * and BaseEngine's `setListViewport` moves the window. `lazy: false` opts out.
 */
import { describe, expect, test } from "bun:test";
import { Engine } from "../packages/server/src/engine";
import type { Patch } from "../packages/core/src/types";

const LIST = `List(@state.items, key: "id", initialCount: 10) { Text("@{item.name}") }`;

async function setup(source = LIST) {
  const engine = new Engine();
  await engine.init();
  const batches: Patch[][] = [];
  engine.setRenderCallback((patches) => batches.push(patches));
  const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `row ${i}` }));
  engine.setModule("Test", [], ["items"], { items });
  engine.renderSource(source);
  const patches = batches.flat();
  const list = patches.find(
    (p) => p.type === "create" && (p as { elementType?: string }).elementType === "List"
  ) as { id: string };
  return { engine, batches, patches, listId: list.id };
}

// Rows arrive as one `instantiate` each (template rows), or as a plain
// `create` where a boundary lowered them.
const texts = (patches: Patch[]) =>
  patches.filter(
    (p) =>
      (p.type as string) === "instantiate" ||
      (p.type === "create" && (p as { elementType?: string }).elementType === "Text")
  ).length;

const windowProp = (patches: Patch[], listId: string) =>
  (
    patches.find(
      (p) =>
        p.type === "setProp" &&
        (p as { id: string }).id === listId &&
        (p as { name: string }).name === "__virt.window"
    ) as { value?: unknown } | undefined
  )?.value;

describe("lazy List through the WASM engine", () => {
  test("lazy: false creates every row", async () => {
    const { patches, listId } = await setup(
      `List(@state.items, key: "id", lazy: false) { Text("@{item.name}") }`
    );
    expect(texts(patches)).toBe(100);
    expect(windowProp(patches, listId)).toBeUndefined();
  });

  test("only the window is created, and the viewport moves it", async () => {
    const { engine, batches, patches, listId } = await setup();
    expect(texts(patches)).toBe(10);
    expect(windowProp(patches, listId)).toEqual({ total: 100, start: 0, end: 10 });

    batches.length = 0;
    engine.setListViewport(listId, 40, 55);
    const moved = batches.flat();
    expect(texts(moved)).toBe(15);
    expect(moved.filter((p) => p.type === "remove").length).toBe(10);
    expect(windowProp(moved, listId)).toEqual({ total: 100, start: 40, end: 55 });

    batches.length = 0;
    engine.setListViewport("not-a-node", 0, 5);
    expect(batches.flat()).toEqual([]);
  });
});
