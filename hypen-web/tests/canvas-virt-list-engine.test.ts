/**
 * End to end: the shipped wasm-node engine windows a 1,000-item `List`, the
 * canvas renderer lays the window out with stand-in padding, and scrolling
 * the canvas reports the viewport back through `setListViewport`, which
 * materializes the newly visible rows (docs/virtualization.md §1–§3).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Engine } from "../packages/server/src/engine";
import { CanvasRenderer } from "../packages/web/src/canvas/index.js";
import { setLayoutBackend } from "../packages/web/src/canvas/layout.js";
import type { VirtualNode } from "../packages/web/src/canvas/types.js";
import type { Patch } from "../packages/core/src/types";

class MockContext {
  fillStyle: any = "#000";
  strokeStyle: any = "#000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "left";
  textBaseline = "top";
  globalAlpha = 1;
  save() {}
  restore() {}
  scale() {}
  translate() {}
  rotate() {}
  transform() {}
  setTransform() {}
  fillRect() {}
  strokeRect() {}
  clearRect() {}
  fillText() {}
  measureText(text: string) {
    return { width: text.length * 8 };
  }
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arcTo() {}
  arc() {}
  fill() {}
  stroke() {}
  clip() {}
  rect() {}
  setLineDash() {}
  drawImage() {}
}

class MockCanvas {
  width = 800;
  height = 600;
  style: any = {};
  private context = new MockContext();
  private listeners = new Map<string, Function[]>();
  getContext(type: string) {
    return type === "2d" ? this.context : null;
  }
  getBoundingClientRect() {
    return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0 };
  }
  addEventListener(event: string, handler: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }
  removeEventListener() {}
  dispatchEvent(event: any) {
    for (const h of this.listeners.get(event.type) ?? []) h(event);
    return true;
  }
  get parentElement() {
    return { appendChild: () => {} };
  }
}

const SOURCE = `
Column {
  List(@state.items, key: "id") {
    Text("@{item.name}").height(40)
  }
    .height(400)
    .scrollable("vertical")
}
  .width(800)
  .height(600)
`;

/** Text rows currently materialized under `list`, by label. */
function rowLabels(list: VirtualNode): string[] {
  return list.children.map((c) => String(c.props[0] ?? ""));
}

describe("windowed List: wasm engine → canvas renderer", () => {
  beforeAll(() => setLayoutBackend("fallback"));
  afterAll(() => setLayoutBackend("auto"));

  test("scrolling a 1,000-item List creates the newly visible rows", async () => {
    const engine = new Engine();
    await engine.init();
    const canvas = new MockCanvas();

    // Spy on the viewport reports while forwarding them to the real engine.
    const reports: Array<[string, number, number]> = [];
    const forward = engine.setListViewport.bind(engine);
    (engine as any).setListViewport = (id: string, start: number, end: number) => {
      reports.push([id, start, end]);
      forward(id, start, end);
    };

    const renderer = new CanvasRenderer(canvas as any, engine as any, {
      devicePixelRatio: 1,
      enableAccessibility: false,
    });
    const created: string[] = [];
    engine.setRenderCallback((patches: Patch[]) => {
      for (const p of patches as any[]) {
        if (p.type === "create" || p.type === "instantiate") created.push(p.id);
      }
      renderer.applyPatches(patches);
    });

    const items = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `row ${i}` }));
    engine.setModule("Test", [], ["items"], { items });
    engine.renderSource(SOURCE);

    const nodes: Map<string, VirtualNode> = (renderer as any).nodes;
    const list = [...nodes.values()].find((n) => n.type === "List")!;
    expect(list).toBeDefined();
    expect(list.virt).toBeDefined();
    expect(list.virt!.window.total).toBe(1000);
    expect(list.props["__virt.window"]).toBeUndefined();

    // Only a window exists, and the list's scroll extent covers every item.
    const initial = list.children.length;
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThan(100);
    expect(list.scrollState!.scrollHeight).toBe(1000 * 40);
    expect(rowLabels(list)[0]).toBe("row 0");

    // Scroll 20,000px into the list (item 500).
    const createdBefore = created.length;
    canvas.dispatchEvent({
      type: "wheel",
      clientX: 100,
      clientY: 100,
      deltaX: 0,
      deltaY: 20000,
      deltaMode: 0,
      preventDefault() {},
    });

    expect(reports.length).toBeGreaterThanOrEqual(1);
    const [id, start, end] = reports[0]!;
    expect(id).toBe(list.id);
    expect(start).toBeLessThanOrEqual(500);
    expect(end).toBeGreaterThan(510);

    // The engine answered with new rows: they exist, sit after the leading
    // padding, and cover what is on screen.
    expect(created.length).toBeGreaterThan(createdBefore);
    expect(list.virt!.window.start).toBe(start);
    expect(list.virt!.window.end).toBe(end);
    expect(rowLabels(list)).toContain("row 500");
    expect(rowLabels(list)).not.toContain("row 0");
    const row500 = list.children.find((c) => c.props[0] === "row 500")!;
    expect(row500.layout!.y - list.layout!.y - list.layout!.contentY).toBe(500 * 40);
    expect(list.scrollState!.scrollY).toBe(20000);
    expect(list.scrollState!.scrollHeight).toBe(1000 * 40);

    // Hit-testing the top of the list lands on the row painted there.
    const hit = (renderer as any).eventManager.hitTest({ x: 10, y: 5 }) as VirtualNode;
    expect(hit.props[0]).toBe("row 500");

    // A settled frame does not report again.
    const n = reports.length;
    (renderer as any).render();
    expect(reports.length).toBe(n);

    renderer.destroy();
  });
});
