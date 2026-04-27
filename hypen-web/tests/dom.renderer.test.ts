import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

describe("DOMRenderer root handling", () => {
  const makeRenderer = () => {
    const container = document.createElement("div");
    const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
    return { container, renderer };
  };

  test("first created node is appended to container", () => {
    const { container, renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
    ]);

    const rootNode = renderer.getNode("root-1");
    expect(rootNode).toBeInstanceOf(HTMLElement);
    expect(container.children.length).toBe(1);
    expect(container.firstElementChild).toBe(rootNode);
  });

  test("child nodes require insert before appearing", () => {
    const { container, renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "child-1", elementType: "Text", props: {} } as Patch,
    ]);

    const child = renderer.getNode("child-1");
    expect(child).toBeInstanceOf(HTMLElement);
    expect(container.contains(child!)).toBe(false);

    renderer.applyPatches([
      { type: "insert", parentId: "root-1", id: "child-1" } as Patch,
    ]);

    expect(container.contains(child!)).toBe(true);
  });

  test("removing root clears container and allows new root", () => {
    const { container, renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
    ]);

    renderer.applyPatches([
      { type: "remove", id: "root-1" } as Patch,
    ]);

    expect(container.children.length).toBe(0);

    renderer.applyPatches([
      { type: "create", id: "root-2", elementType: "Column", props: {} } as Patch,
    ]);

    const newRoot = renderer.getNode("root-2");
    expect(newRoot).toBeInstanceOf(HTMLElement);
    expect(container.firstElementChild).toBe(newRoot);
  });
});

describe("DOMRenderer patch handling", () => {
  const makeRenderer = () => {
    const container = document.createElement("div");
    const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
    return { container, renderer };
  };

  test("create patch accepts Map props and interpolates on update", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      {
        type: "create",
        id: "text",
        elementType: "Text",
        props: new Map<string, any>([["0", "Count: @{state.count}"]]),
      } as Patch,
      { type: "insert", parentId: "root-1", id: "text" } as Patch,
    ]);

    const textNode = renderer.getNode("text") as FakeElement;
    expect(textNode.dataset.textTemplate).toBe("Count: @{state.count}");
    expect(textNode.textContent).toBe("Count: @{state.count}");

    renderer.updateState({ count: 7 });
    expect(textNode.textContent).toBe("Count: 7");
  });

  test("setProp '0' updates input value without interpolation", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "input", elementType: "Input", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "input" } as Patch,
    ]);

    renderer.applyPatches([
      { type: "setProp", id: "input", name: "0", value: "typed" } as Patch,
    ]);

    const inputEl = renderer.getNode("input") as FakeElement;
    expect(inputEl.value).toBe("typed");
  });

  test("insert respects before_id ordering", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "a", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "a" } as Patch,
      { type: "create", id: "b", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "b" } as Patch,
      { type: "create", id: "c", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "c", beforeId: "b" } as Patch,
    ]);

    const rootNode = renderer.getNode("root-1") as FakeElement;
    const order = rootNode.children.map((child) => child.dataset.hypenId);
    expect(order).toEqual(["a", "c", "b"]);
  });

  test("unknown components fall back to transparent container div", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "mystery", elementType: "FancyWidget", props: {} } as Patch,
    ]);

    const node = renderer.getNode("mystery") as FakeElement;
    expect(node).toBeDefined();
    expect(node.tagName).toBe("DIV");
    // Element types are normalized to lowercase in dataset
    expect(node.dataset.hypenType).toBe("fancywidget");
    // Unknown components are transparent containers (display: contents)
    expect(node.style.display).toBe("contents");
  });

  test("setProp falls back to style property with px units", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "child", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "child" } as Patch,
    ]);

    renderer.applyPatches([
      { type: "setProp", id: "child", name: "customSpacing", value: 12 } as Patch,
    ]);

    const child = renderer.getNode("child") as FakeElement;
    expect(child.style.getProperty("custom-spacing")).toBe("12px");
  });

  test("onClick applicator dispatches custom payload", () => {
    class EventStubEngine {
      public dispatchCalls: Array<{ name: string; payload: any }> = [];

      dispatchAction(name: string, payload: any): void {
        this.dispatchCalls.push({ name, payload });
      }
    }

    const engine = new EventStubEngine();
    const container = document.createElement("div");
    const renderer = new DOMRenderer(container, engine as unknown as Engine);

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      {
        type: "create",
        id: "button",
        elementType: "Button",
        props: { "onClick.0": "@increment", "onClick.id": "abc" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "button" } as Patch,
    ]);

    const button = renderer.getNode("button") as FakeElement;
    button.dispatchEvent("click", { type: "click", target: button });

    expect(engine.dispatchCalls).toEqual([
      { name: "increment", payload: { id: "abc" } },
    ]);
  });
});

describe("DOMRenderer utilities", () => {
  const makeRenderer = () => {
    const container = document.createElement("div");
    const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
    return { container: container as FakeElement, renderer };
  };

  test("clear removes all children and tracked nodes", () => {
    const { container, renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "child-1", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "child-1" } as Patch,
    ]);

    expect(container.children.length).toBeGreaterThan(0);
    expect(renderer.getNode("child-1")).toBeDefined();

    renderer.clear();

    expect(container.children.length).toBe(0);
    expect(renderer.getNode("child-1")).toBeUndefined();
  });

  test("custom component and applicator registrations are respected", () => {
    const { renderer } = makeRenderer();

    renderer.getComponentRegistry().register("FancyBox", {
      create() {
        const el = document.createElement("section");
        el.dataset.customType = "fancybox";
        return el;
      },
      applyProps(element, props) {
        element.dataset.customTitle = props.title;
      },
    });

    renderer.getApplicatorRegistry().register("shadow", (element, value) => {
      (element as FakeElement).dataset.shadow = String(value);
    });

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      {
        type: "create",
        id: "fancy",
        elementType: "FancyBox",
        props: { title: "Featured", shadow: "soft" },
      } as Patch,
      { type: "insert", parentId: "root-1", id: "fancy" } as Patch,
    ]);

    const fancy = renderer.getNode("fancy") as FakeElement;
    expect(fancy).toBeInstanceOf(HTMLElement);
    expect(fancy.tagName).toBe("SECTION");
    expect(fancy.dataset.customType).toBe("fancybox");
    expect(fancy.dataset.customTitle).toBe("Featured");
    expect(fancy.dataset.shadow).toBe("soft");
  });

  test("debug tracking increments counts and resets correctly", () => {
    const { renderer } = makeRenderer();

    renderer.setDebugConfig({ enabled: true, fadeOutDuration: 0 });

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
    ]);

    let stats = renderer.getDebugStats();
    expect(stats.totalRerenders).toBe(1);
    expect(stats.elementCount).toBe(1);
    expect(stats.avgRerenders).toBe(1);

    renderer.applyPatches([
      { type: "setProp", id: "root-1", name: "width", value: 300 } as Patch,
    ]);

    stats = renderer.getDebugStats();
    expect(stats.totalRerenders).toBe(2);
    expect(stats.elementCount).toBe(1);
    expect(stats.avgRerenders).toBe(2);

    renderer.resetDebugTracking();
    stats = renderer.getDebugStats();
    expect(stats.totalRerenders).toBe(0);
    expect(stats.elementCount).toBe(0);
    expect(stats.avgRerenders).toBe(0);
  });
});

describe("DOMRenderer patch field name robustness", () => {
  const makeRenderer = () => {
    const container = document.createElement("div");
    const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
    return { container, renderer };
  };

  test("camelCase create patch (elementType) works correctly", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "n1", elementType: "Column", props: {} } as Patch,
    ]);

    const node = renderer.getNode("n1");
    expect(node).toBeDefined();
    expect(node!.dataset.hypenType).toBe("column");
  });

  test("camelCase insert patch (parentId, beforeId) works correctly", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "parent", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "child", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "parent", id: "child" } as Patch,
    ]);

    const parent = renderer.getNode("parent") as FakeElement;
    const child = renderer.getNode("child");
    expect(parent.children.length).toBe(1);
    expect(parent.children[0]).toBe(child);
  });

  test("move patch reorders children", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "parent", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "a", elementType: "Text", props: {} } as Patch,
      { type: "create", id: "b", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "parent", id: "a" } as Patch,
      { type: "insert", parentId: "parent", id: "b" } as Patch,
    ]);

    renderer.applyPatches([
      { type: "move", parentId: "parent", id: "b", beforeId: "a" } as Patch,
    ]);

    const parent = renderer.getNode("parent") as FakeElement;
    const order = parent.children.map((c) => c.dataset.hypenId);
    expect(order).toEqual(["b", "a"]);
  });

  test("insert into 'root' container appends to the renderer container", () => {
    const { container, renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-el", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root", id: "root-el" } as Patch,
    ]);

    expect(container.children.length).toBe(1);
  });
});
