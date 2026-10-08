import { semanticAction } from "./helpers";
import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";
import { remoteAssetBaseUrl } from "../packages/web/src/dom/components/hypenapp";

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

  test("embedded renderers resolve relative images against the child app", () => {
    const container = document.createElement("div");
    const renderer = new DOMRenderer(
      container,
      new StubEngine() as unknown as Engine,
      undefined,
      { assetBaseUrl: "https://child.example/" },
    );

    renderer.applyPatches([
      {
        type: "create",
        id: "poster",
        elementType: "Image",
        props: { src: "/poster/bunny" },
      } as Patch,
    ]);
    const image = renderer.getNode("poster") as FakeElement;
    expect(image.src).toBe("https://child.example/poster/bunny");

    renderer.applyPatches([
      { type: "setProp", id: "poster", name: "src", value: "thumb.jpg" } as Patch,
    ]);
    expect(image.src).toBe("https://child.example/thumb.jpg");
  });

  test("HypenApp converts its WebSocket endpoint to a child asset origin", () => {
    expect(remoteAssetBaseUrl("wss://movies.example/ws?session=1")).toBe(
      "https://movies.example/",
    );
    expect(remoteAssetBaseUrl("ws://localhost:3177/ws")).toBe("http://localhost:3177/");
  });

  test("HypenApp asks the renderer's hypenAppDevice factory for a host per embedded URL", () => {
    const urls: string[] = [];
    const container = document.createElement("div");
    const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine, undefined, {
      hypenAppDevice: (url) => {
        urls.push(url);
        return undefined; // UI-only: the embed still connects
      },
    });
    renderer.applyPatches([
      { type: "create", id: "app", elementType: "HypenApp", props: { "0": "ws://social.example/ws" } } as Patch,
    ]);
    expect(urls).toEqual(["ws://social.example/ws"]);

    // A throwing factory never breaks the embed; without one nothing is asked.
    const quiet = new DOMRenderer(document.createElement("div"), new StubEngine() as unknown as Engine, undefined, {
      hypenAppDevice: () => {
        throw new Error("boom");
      },
    });
    expect(() =>
      quiet.applyPatches([
        { type: "create", id: "app", elementType: "HypenApp", props: { "0": "ws://x.example/ws" } } as Patch,
      ]),
    ).not.toThrow();
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
        this.dispatchCalls.push(semanticAction(name, payload));
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

  test("move patch without beforeId moves an existing child to the end", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "parent", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "a", elementType: "Text", props: {} } as Patch,
      { type: "create", id: "b", elementType: "Text", props: {} } as Patch,
      { type: "create", id: "c", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "parent", id: "a" } as Patch,
      { type: "insert", parentId: "parent", id: "b" } as Patch,
      { type: "insert", parentId: "parent", id: "c" } as Patch,
    ]);

    // The keyed reconciler's "lands last" move carries no anchor.
    renderer.applyPatches([
      { type: "move", parentId: "parent", id: "a", beforeId: null } as unknown as Patch,
    ]);

    const parent = renderer.getNode("parent") as FakeElement;
    expect(parent.children.map((c) => c.dataset.hypenId)).toEqual(["b", "c", "a"]);
  });

  test("insert into 'root' container appends to the renderer container", () => {
    const { container, renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-el", elementType: "Column", props: {} } as Patch,
      { type: "insert", parentId: "root", id: "root-el" } as Patch,
    ]);

    expect(container.children.length).toBe(1);
  });

  test("slot.0 prop is exposed as data-hypen-slot for slot-owning components", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "loader",
        elementType: "Column",
        props: { "slot.0": "loading" },
      } as Patch,
    ]);

    const node = renderer.getNode("loader") as FakeElement;
    expect(node.dataset.hypenSlot).toBe("loading");
  });

  test("elements without a slot applicator have no data-hypen-slot", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "plain", elementType: "Column", props: {} } as Patch,
    ]);

    const node = renderer.getNode("plain") as FakeElement;
    expect(node.dataset.hypenSlot).toBeUndefined();
  });

  test("HypenApp applies loading/error slots when MutationObserver is unavailable", () => {
    const previousMutationObserver = (globalThis as any).MutationObserver;
    delete (globalThis as any).MutationObserver;

    try {
      const { renderer } = makeRenderer();

      renderer.applyPatches([
        { type: "create", id: "app", elementType: "HypenApp", props: {} } as Patch,
        { type: "insert", parentId: "root", id: "app" } as Patch,
        {
          type: "create",
          id: "error",
          elementType: "Column",
          props: { "slot.0": "error" },
        } as Patch,
        { type: "insert", parentId: "app", id: "error" } as Patch,
        {
          type: "create",
          id: "loading",
          elementType: "Column",
          props: { "slot.0": "loading" },
        } as Patch,
        { type: "insert", parentId: "app", id: "loading" } as Patch,
      ]);

      const app = renderer.getNode("app") as FakeElement;
      const error = renderer.getNode("error") as FakeElement;
      const loading = renderer.getNode("loading") as FakeElement;

      expect(app.dataset.hypenAppStatus).toBe("error");
      expect(error.style.display).toBe("flex");
      expect(loading.style.display).toBe("none");
      expect(
        app.children.some((child) => (child as any).className === "hypen-app-error"),
      ).toBe(false);
    } finally {
      (globalThis as any).MutationObserver = previousMutationObserver;
    }
  });

  test("HypenApp reacts when a child's slot prop is changed or removed", () => {
    const previousMutationObserver = (globalThis as any).MutationObserver;
    delete (globalThis as any).MutationObserver;

    try {
      const { renderer } = makeRenderer();

      renderer.applyPatches([
        { type: "create", id: "app", elementType: "HypenApp", props: {} } as Patch,
        { type: "insert", parentId: "root", id: "app" } as Patch,
        {
          type: "create",
          id: "status",
          elementType: "Column",
          props: { "slot.0": "loading" },
        } as Patch,
        { type: "insert", parentId: "app", id: "status" } as Patch,
      ]);

      const app = renderer.getNode("app") as FakeElement;
      const status = renderer.getNode("status") as FakeElement;

      expect(status.dataset.hypenSlot).toBe("loading");
      expect(status.style.display).toBe("none");

      renderer.applyPatches([
        { type: "setProp", id: "status", name: "slot.0", value: "error" } as Patch,
      ]);

      expect(status.dataset.hypenSlot).toBe("error");
      expect(status.style.display).toBe("flex");
      expect(
        app.children.some((child) => (child as any).className === "hypen-app-error"),
      ).toBe(false);

      renderer.applyPatches([
        { type: "removeProp", id: "status", name: "slot.0" } as Patch,
      ]);

      expect(status.dataset.hypenSlot).toBeUndefined();
      expect(
        app.children.some((child) => (child as any).className === "hypen-app-error"),
      ).toBe(true);
    } finally {
      (globalThis as any).MutationObserver = previousMutationObserver;
    }
  });

  test("HypenApp swaps its loading slot for remote content after the first tree", async () => {
    class StubWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static instances: StubWebSocket[] = [];

      readyState = StubWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      private listeners = new Map<string, Set<(event: any) => void>>();

      constructor(public url: string) {
        StubWebSocket.instances.push(this);
      }

      addEventListener(type: string, listener: (event: any) => void): void {
        let listeners = this.listeners.get(type);
        if (!listeners) {
          listeners = new Set();
          this.listeners.set(type, listeners);
        }
        listeners.add(listener);
      }

      removeEventListener(type: string, listener: (event: any) => void): void {
        this.listeners.get(type)?.delete(listener);
      }

      send(): void {}

      close(): void {
        this.readyState = StubWebSocket.CLOSED;
      }

      open(): void {
        this.readyState = StubWebSocket.OPEN;
        this.onopen?.();
      }

      message(data: unknown): void {
        for (const listener of this.listeners.get("message") ?? []) {
          listener({ data: JSON.stringify(data) });
        }
      }
    }

    const previousMutationObserver = (globalThis as any).MutationObserver;
    const previousWebSocket = (globalThis as any).WebSocket;
    delete (globalThis as any).MutationObserver;
    (globalThis as any).WebSocket = StubWebSocket;

    try {
      const { renderer } = makeRenderer();
      renderer.applyPatches([
        {
          type: "create",
          id: "app",
          elementType: "HypenApp",
          props: { "0": "ws://example.test", autoReconnect: false },
        } as Patch,
        { type: "insert", parentId: "root", id: "app" } as Patch,
        {
          type: "create",
          id: "loading",
          elementType: "Column",
          props: { "slot.0": "loading" },
        } as Patch,
        { type: "insert", parentId: "app", id: "loading" } as Patch,
        {
          type: "create",
          id: "error",
          elementType: "Column",
          props: { "slot.0": "error" },
        } as Patch,
        { type: "insert", parentId: "app", id: "error" } as Patch,
      ]);

      const app = renderer.getNode("app") as FakeElement;
      const loading = renderer.getNode("loading") as FakeElement;
      const error = renderer.getNode("error") as FakeElement;
      const content = app.children.find(
        (child) => (child as any).className === "hypen-app-content",
      )!;

      expect(app.dataset.hypenAppStatus).toBe("loading");
      expect(loading.style.display).toBe("flex");
      expect(error.style.display).toBe("none");
      expect(content.style.display).toBe("none");

      const socket = StubWebSocket.instances[0]!;
      socket.open();
      socket.message({
        type: "initialTree",
        module: "Remote",
        state: {},
        revision: 1,
        patches: [
          { type: "create", id: "remote-root", elementType: "Text", props: { "0": "Ready" } },
          { type: "insert", parentId: "root", id: "remote-root" },
        ],
      });
      await Promise.resolve();

      expect(app.dataset.hypenAppStatus).toBe("connected");
      expect(loading.style.display).toBe("none");
      expect(error.style.display).toBe("none");
      expect(content.style.display).toBe("contents");

      renderer.clear();
      expect(socket.readyState).toBe(StubWebSocket.CLOSED);
    } finally {
      (globalThis as any).MutationObserver = previousMutationObserver;
      (globalThis as any).WebSocket = previousWebSocket;
    }
  });
});

describe("DOMRenderer falsy text values", () => {
  const makeRenderer = () => {
    const container = document.createElement("div");
    const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
    return { container, renderer };
  };

  // Regression: `props["0"] || props.text` dropped falsy-but-valid values,
  // so `Text("@{state.count}")` rendered nothing at count 0.
  test("Text renders the number 0", () => {
    const { renderer } = makeRenderer();

    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "text", elementType: "Text", props: { "0": 0 } } as Patch,
      { type: "insert", parentId: "root-1", id: "text" } as Patch,
    ]);

    const textNode = renderer.getNode("text") as FakeElement;
    expect(textNode.textContent).toBe("0");
  });
});

describe("DOMRenderer batch-scoped child-change notifications", () => {
  const makeRenderer = () => {
    const container = document.createElement("div");
    const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
    return { container, renderer };
  };

  const mountBoard = (renderer: DOMRenderer) => {
    const calls: number[] = [];
    renderer.getComponentRegistry().register("Board", {
      create() {
        return document.createElement("section");
      },
      onChildrenChanged(element) {
        calls.push(element.children.length);
      },
    });
    return calls;
  };

  test("a host inserted with many children in one batch is notified once, after all of them landed", () => {
    const { renderer } = makeRenderer();
    const calls = mountBoard(renderer);

    const patches: Patch[] = [
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "board", elementType: "Board", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "board" } as Patch,
    ];
    for (let i = 0; i < 5; i++) {
      patches.push({ type: "create", id: `c${i}`, elementType: "Text", props: {} } as Patch);
      patches.push({ type: "insert", parentId: "board", id: `c${i}` } as Patch);
    }
    renderer.applyPatches(patches);

    // One notification for the board, delivered when all five children exist.
    expect(calls).toEqual([5]);

    // A later structural batch notifies once more, with the final child list.
    renderer.applyPatches([
      { type: "remove", id: "c0" } as Patch,
      { type: "remove", id: "c1" } as Patch,
      { type: "move", parentId: "board", id: "c4", beforeId: "c2" } as Patch,
    ]);
    expect(calls).toEqual([5, 3]);

    // A batch that never touches the board's children is silent.
    renderer.applyPatches([
      { type: "setProp", id: "c2", name: "0", value: "hello" } as Patch,
    ]);
    expect(calls).toEqual([5, 3]);
  });

  test("a slot reassignment still reaches the host, coalesced with the batch", () => {
    const { renderer } = makeRenderer();
    const calls = mountBoard(renderer);
    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "board", elementType: "Board", props: {} } as Patch,
      { type: "insert", parentId: "root-1", id: "board" } as Patch,
      { type: "create", id: "c0", elementType: "Text", props: {} } as Patch,
      { type: "insert", parentId: "board", id: "c0" } as Patch,
    ]);
    expect(calls).toEqual([1]);

    renderer.applyPatches([
      { type: "setProp", id: "c0", name: "slot.0", value: "header" } as Patch,
      { type: "removeProp", id: "c0", name: "slot.0" } as Patch,
    ]);
    expect(calls).toEqual([1, 1]);
  });
});

describe("DOMRenderer path-narrowed text interpolation", () => {
  const makeRenderer = () => {
    const container = document.createElement("div");
    const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
    return { container, renderer };
  };

  const mount = (renderer: DOMRenderer) => {
    renderer.applyPatches([
      { type: "create", id: "root-1", elementType: "Column", props: {} } as Patch,
      { type: "create", id: "name", elementType: "Text", props: { "0": "Hi @{state.user.name}" } } as Patch,
      { type: "create", id: "first", elementType: "Text", props: { "0": "@{state.items.0.title}" } } as Patch,
      { type: "create", id: "count", elementType: "Text", props: { "0": "@{state.items.length} items" } } as Patch,
      { type: "insert", parentId: "root-1", id: "name" } as Patch,
      { type: "insert", parentId: "root-1", id: "first" } as Patch,
      { type: "insert", parentId: "root-1", id: "count" } as Patch,
    ]);
    renderer.updateState({ user: { name: "Ada" }, items: [{ title: "one" }] });
    return {
      name: renderer.getNode("name") as FakeElement,
      first: renderer.getNode("first") as FakeElement,
      count: renderer.getNode("count") as FakeElement,
    };
  };

  test("only bindings under a changed path are re-interpolated", () => {
    const { renderer } = makeRenderer();
    const { name, first, count } = mount(renderer);
    expect(name.textContent).toBe("Hi Ada");
    expect(first.textContent).toBe("one");
    expect(count.textContent).toBe("1 items");

    // Both fields moved in the state object, but only `items.0.title` is
    // reported: the name binding is not visited (it keeps the stale text,
    // which is how we observe that it was skipped).
    renderer.updateState(
      { user: { name: "Grace" }, items: [{ title: "uno" }] },
      ["items.0.title"],
    );
    expect(first.textContent).toBe("uno");
    expect(name.textContent).toBe("Hi Ada");
    // `items.length` reads the array, so an edit inside a slot visits it
    // (and finds nothing to change here).
    expect(count.textContent).toBe("1 items");
  });

  test("an array push, reported as its new index, reaches a `.length` binding", () => {
    const { renderer } = makeRenderer();
    const { count, name } = mount(renderer);
    renderer.updateState(
      { user: { name: "Ada" }, items: [{ title: "one" }, { title: "two" }] },
      ["items.1"],
    );
    expect(count.textContent).toBe("2 items");
    expect(name.textContent).toBe("Hi Ada");
  });

  test("a parent path change reaches every binding beneath it, and vice versa", () => {
    const { renderer } = makeRenderer();
    const { name, first, count } = mount(renderer);

    renderer.updateState(
      { user: { name: "Ada" }, items: [{ title: "a" }, { title: "b" }] },
      ["items"],
    );
    expect(first.textContent).toBe("a");
    expect(count.textContent).toBe("2 items");
    expect(name.textContent).toBe("Hi Ada");

    // A leaf below what the binding reads: `user.name` binding sees `user`.
    renderer.updateState({ user: { name: "Linus" }, items: [{ title: "a" }] }, ["user"]);
    expect(name.textContent).toBe("Hi Linus");
  });

  test("a sibling path with a shared prefix string does not match", () => {
    const { renderer } = makeRenderer();
    renderer.applyPatches([
      { type: "create", id: "u", elementType: "Text", props: { "0": "@{state.user.name}" } } as Patch,
      { type: "insert", parentId: "root-1", id: "u" } as Patch,
    ]);
    const u = renderer.getNode("u") as FakeElement;
    renderer.updateState({ user: { name: "Ada" }, userx: 1 });
    expect(u.textContent).toBe("Ada");
    renderer.updateState({ user: { name: "Bob" }, userx: 2 }, ["userx", "user.named"]);
    expect(u.textContent).toBe("Ada");
    renderer.updateState({ user: { name: "Bob" }, userx: 2 }, ["user.name"]);
    expect(u.textContent).toBe("Bob");
  });

  test("omitting changed paths re-interpolates everything, and removed nodes leave the index", () => {
    const { renderer } = makeRenderer();
    const { name, first } = mount(renderer);
    renderer.updateState({ user: { name: "Grace" }, items: [{ title: "uno" }] });
    expect(name.textContent).toBe("Hi Grace");
    expect(first.textContent).toBe("uno");

    renderer.applyPatches([{ type: "remove", id: "first" } as Patch]);
    // The removed node is no longer visited (no throw, no stale write).
    renderer.updateState({ user: { name: "Grace" }, items: [{ title: "dos" }] }, ["items.0.title"]);
    expect(first.textContent).toBe("uno");
  });
});
