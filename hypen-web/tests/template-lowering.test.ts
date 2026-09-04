/**
 * Template lowering at the renderer boundaries.
 *
 * The engine always emits `registerTemplate`/`instantiate` for plannable
 * list rows. The DOM renderer exploits them natively (prototype cloning),
 * but canvas subtrees cannot — these tests pin the two lowering seams:
 *
 *  1. A standalone `CanvasRenderer` expands template patches through its
 *     own `TemplateExpander` at the head of `applyPatches`.
 *  2. `DOMRenderer` lowers canvas-targeted `instantiate`s to plain
 *     patches BEFORE routing (an `instantiate` has no `id`, so the
 *     pre-existing id-based routing would misroute it to the DOM side),
 *     and registers the instance's nodes as canvas-subtree members so
 *     later id-addressed patches route to the canvas too.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { CanvasRenderer } from "../packages/web/src/canvas/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
  onAction(): void {}
  setRenderCallback(): void {}
}

/** Minimal 2D-context/canvas mocks (same shape canvas-integration uses). */
class MockCanvasContext {
  canvas = { width: 800, height: 600 };
  fillStyle = "";
  strokeStyle = "";
  font = "";
  save() {}
  restore() {}
  scale() {}
  translate() {}
  clearRect() {}
  fillRect() {}
  strokeRect() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arc() {}
  arcTo() {}
  fill() {}
  stroke() {}
  fillText() {}
  measureText(text: string) {
    return { width: text.length * 8 };
  }
  setLineDash() {}
  clip() {}
  drawImage() {}
  rect() {}
  roundRect() {}
}

class MockCanvas {
  width = 800;
  height = 600;
  style: any = { width: "800px", height: "600px", cursor: "default" };
  private context = new MockCanvasContext();

  getContext(type: string) {
    return type === "2d" ? this.context : null;
  }
  getBoundingClientRect() {
    return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0 };
  }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
  setAttribute() {}
  focus() {}
}

const registerT1: Patch = {
  type: "registerTemplate",
  templateId: "t1",
  root: {
    elementType: "Row",
    props: { gap: 8 },
    children: [
      { elementType: "Text", props: { fontSize: 14 }, children: [] },
      { elementType: "Text", props: {}, children: [] },
    ],
  },
};

function instantiateT1(parentId: string, nodes: string[]): Patch {
  return {
    type: "instantiate",
    templateId: "t1",
    parentId,
    nodes,
    subs: [[1, "0", "Hello"]],
    nodeSemantics: [],
  };
}

describe("CanvasRenderer template lowering", () => {
  const makeRenderer = () =>
    new CanvasRenderer(new MockCanvas() as any, new StubEngine() as any, {
      devicePixelRatio: 1,
      enableAccessibility: false,
      enableHitTesting: true,
    });

  test("expands registerTemplate/instantiate into virtual nodes", () => {
    const renderer = makeRenderer();
    renderer.applyPatches([registerT1, instantiateT1("root", ["10", "11", "12"])]);

    const row = renderer.getNode("10");
    const text1 = renderer.getNode("11");
    const text2 = renderer.getNode("12");
    expect(row).toBeDefined();
    expect(row!.type).toBe("Row");
    expect(row!.props.gap).toBe(8);
    expect(row!.children.map((c: any) => c.id)).toEqual(["11", "12"]);
    expect(text1!.props.fontSize).toBe(14);
    expect(text1!.props["0"]).toBe("Hello"); // sub merged in
    expect(text2!.parent).toBe(row!);
  });

  test("skeletons persist across batches", () => {
    const renderer = makeRenderer();
    renderer.applyPatches([registerT1, instantiateT1("root", ["1", "2", "3"])]);
    renderer.applyPatches([instantiateT1("1", ["4", "5", "6"])]);

    const nested = renderer.getNode("4");
    expect(nested).toBeDefined();
    expect(nested!.parent?.id).toBe("1");
  });
});

describe("DOMRenderer canvas-subtree template routing", () => {
  const makeRenderer = () => {
    const container = document.createElement("div");
    const renderer = new DOMRenderer(
      container,
      new StubEngine() as unknown as Engine,
    );
    // Inject a recording stand-in for a CanvasRenderer rooted at "cv" —
    // constructing the real one needs a live 2D context the fake DOM
    // doesn't provide, and only the routed batches are under test here.
    const batches: Patch[][] = [];
    (renderer as any).canvasRenderers.set("cv", {
      applyPatches: (b: Patch[]) => batches.push(b),
    });
    return { renderer, batches };
  };

  test("canvas-targeted instantiate is lowered before routing", () => {
    const { renderer, batches } = makeRenderer();
    renderer.applyPatches([registerT1, instantiateT1("cv", ["10", "11", "12"])]);

    expect(batches.length).toBe(1);
    const batch = batches[0]!;
    // The canvas side receives the plain expanded run, never the raw
    // instantiate (which its applyPatch has no case for).
    expect(batch.map((p) => p.type)).toEqual([
      "create", "insert", "create", "insert", "create", "insert",
    ]);
    expect(batch[0]!.id).toBe("10");
    expect(batch[1]!.parentId).toBe("cv");
    expect(batch[3]!.parentId).toBe("10");
    // The DOM side built no elements for the canvas-owned ids.
    expect(renderer.getNode("10")).toBeUndefined();
    expect(renderer.getNode("11")).toBeUndefined();
  });

  test("instantiated nodes are registered as subtree members", () => {
    const { renderer, batches } = makeRenderer();
    renderer.applyPatches([registerT1, instantiateT1("cv", ["10", "11", "12"])]);

    // Later id-addressed patches on instance nodes must route to the
    // canvas, not the DOM.
    renderer.applyPatches([
      { type: "setProp", id: "11", name: "0", value: "Updated" },
    ]);
    expect(batches.length).toBe(2);
    expect(batches[1]).toEqual([
      { type: "setProp", id: "11", name: "0", value: "Updated" },
    ]);
  });

  test("registerTemplate stays DOM-side and DOM instantiates keep working alongside a canvas", () => {
    const { renderer, batches } = makeRenderer();
    // Template registered in an earlier, canvas-free batch still lowers a
    // later canvas-targeted instantiate (session-lifetime expander state).
    renderer.applyPatches([registerT1]);
    renderer.applyPatches([instantiateT1("cv", ["20", "21", "22"])]);

    expect(batches.length).toBe(1);
    expect(batches[0]!.map((p) => p.type)).toContain("create");
    expect(batches[0]!.some((p) => p.type === "instantiate")).toBe(false);
  });
});
