/**
 * SafeArea — DOM renderer
 *
 * The component is a primitive in the engine's DEFAULT_PRIMITIVES, so the
 * renderer receives it as `elementType: "SafeArea"` and resolves it through
 * the (lowercased) registry key `"safearea"`.
 */

import { describe, expect, test } from "bun:test";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { ComponentRegistry } from "../packages/web/src/dom/components/index";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import type { SafeAreaInsetOverrides } from "../packages/web/src/safe-area";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

const makeRenderer = (safeAreaInsets?: SafeAreaInsetOverrides) => {
  const container = document.createElement("div");
  const renderer = new DOMRenderer(
    container,
    new StubEngine() as unknown as Engine,
    undefined,
    safeAreaInsets ? { safeAreaInsets } : undefined,
  );
  return { container, renderer };
};

const createSafeArea = (
  renderer: DOMRenderer,
  props: Record<string, any> = {},
  id = "sa",
): HTMLElement => {
  renderer.applyPatches([
    { type: "create", id, elementType: "SafeArea", props } as Patch,
  ]);
  return renderer.getNode(id)! as HTMLElement;
};

const padding = (el: HTMLElement) => ({
  top: el.style.getPropertyValue("padding-top"),
  right: el.style.getPropertyValue("padding-right"),
  bottom: el.style.getPropertyValue("padding-bottom"),
  left: el.style.getPropertyValue("padding-left"),
});

describe("SafeArea registration", () => {
  test("registry resolves the lowercased primitive name", () => {
    const registry = new ComponentRegistry();
    expect(registry.get("SafeArea")).toBeDefined();
    expect(registry.get("safearea")).toBeDefined();
  });

  test("create resolves the handler, not the unknown-component fallback", () => {
    const { renderer } = makeRenderer();
    const el = createSafeArea(renderer);

    expect(el).toBeDefined();
    expect(el.dataset.hypenType).toBe("safearea");
    // The unknown-component fallback is a `display: contents` transparent div.
    expect(el.style.display).toBe("flex");
    expect(el.style.flexDirection).toBe("column");
  });

  test("fills its parent like the other full-size containers", () => {
    const { renderer } = makeRenderer();
    const el = createSafeArea(renderer);

    expect(el.style.width).toBe("100%");
    expect(el.style.height).toBe("100%");
  });
});

describe("SafeArea default insets", () => {
  test("pads every edge with env(safe-area-inset-*) when `edges` is absent", () => {
    const { renderer } = makeRenderer();
    const el = createSafeArea(renderer);

    expect(padding(el)).toEqual({
      top: "env(safe-area-inset-top, 0px)",
      right: "env(safe-area-inset-right, 0px)",
      bottom: "env(safe-area-inset-bottom, 0px)",
      left: "env(safe-area-inset-left, 0px)",
    });
  });

  test("an empty `edges` list still means all four edges", () => {
    const { renderer } = makeRenderer();
    const el = createSafeArea(renderer, { edges: [] });

    expect(padding(el)).toEqual({
      top: "env(safe-area-inset-top, 0px)",
      right: "env(safe-area-inset-right, 0px)",
      bottom: "env(safe-area-inset-bottom, 0px)",
      left: "env(safe-area-inset-left, 0px)",
    });
  });
});

describe("SafeArea edge filtering", () => {
  test("only the listed edges are padded", () => {
    const { renderer } = makeRenderer();
    const el = createSafeArea(renderer, { edges: ["top", "bottom"] });

    expect(padding(el)).toEqual({
      top: "env(safe-area-inset-top, 0px)",
      right: "",
      bottom: "env(safe-area-inset-bottom, 0px)",
      left: "",
    });
  });

  test("unknown edge names are ignored", () => {
    const { renderer } = makeRenderer();
    const el = createSafeArea(renderer, { edges: ["left", "diagonal"] });

    expect(padding(el)).toEqual({
      top: "",
      right: "",
      bottom: "",
      left: "env(safe-area-inset-left, 0px)",
    });
  });

  test("a later `edges` update re-filters the padded edges", () => {
    const { renderer } = makeRenderer();
    const el = createSafeArea(renderer, { edges: ["top"] });

    renderer.applyPatches([
      { type: "setProp", id: "sa", name: "edges", value: ["bottom"] } as Patch,
    ]);

    expect(padding(el)).toEqual({
      top: "",
      right: "",
      bottom: "env(safe-area-inset-bottom, 0px)",
      left: "",
    });
  });

  test("a JSON-encoded list is accepted like a real array", () => {
    const { renderer } = makeRenderer();
    const el = createSafeArea(renderer, { edges: '["top"]' });

    expect(padding(el).top).toBe("env(safe-area-inset-top, 0px)");
    expect(padding(el).bottom).toBe("");
  });
});

describe("SafeArea embedder overrides", () => {
  test("a custom inset wins over the platform default and merges per edge", () => {
    const { renderer } = makeRenderer({ top: 44, bottom: 0 });
    const el = createSafeArea(renderer);

    expect(padding(el)).toEqual({
      top: "44px",
      // An explicit 0 zeroes ONLY the bottom edge …
      bottom: "0px",
      // … the un-overridden edges keep the browser's own values.
      right: "env(safe-area-inset-right, 0px)",
      left: "env(safe-area-inset-left, 0px)",
    });
  });

  test("overrides accept CSS length strings", () => {
    const { renderer } = makeRenderer({ left: "1rem" });
    const el = createSafeArea(renderer);

    expect(padding(el).left).toBe("1rem");
    expect(padding(el).right).toBe("env(safe-area-inset-right, 0px)");
  });

  test("overrides only apply to the edges `edges` selects", () => {
    const { renderer } = makeRenderer({ top: 44, bottom: 34 });
    const el = createSafeArea(renderer, { edges: ["bottom"] });

    expect(padding(el)).toEqual({
      top: "",
      right: "",
      bottom: "34px",
      left: "",
    });
  });

  test("renderers without the option are unaffected by another renderer's override", () => {
    const custom = makeRenderer({ top: 44 });
    const plain = makeRenderer();

    expect(padding(createSafeArea(custom.renderer)).top).toBe("44px");
    expect(padding(createSafeArea(plain.renderer)).top).toBe(
      "env(safe-area-inset-top, 0px)",
    );
  });
});

describe("SafeArea children", () => {
  test("children insert into the SafeArea itself (no wrapper in between)", () => {
    const { renderer } = makeRenderer();
    const el = createSafeArea(renderer);

    renderer.applyPatches([
      { type: "create", id: "child", elementType: "Text", props: { "0": "hi" } } as Patch,
      { type: "insert", parentId: "sa", id: "child" } as Patch,
    ]);

    const child = renderer.getNode("child")!;
    expect(el.children.length).toBe(1);
    expect(el.children[0]).toBe(child as any);
  });

  test("an empty SafeArea is still a valid, padded box", () => {
    const { renderer } = makeRenderer();
    const el = createSafeArea(renderer);

    expect(el.children.length).toBe(0);
    expect(padding(el).top).toBe("env(safe-area-inset-top, 0px)");
  });

  test("nested SafeAreas each apply their own insets", () => {
    const { renderer } = makeRenderer();
    const outer = createSafeArea(renderer, {}, "outer");
    const inner = createSafeArea(renderer, { edges: ["bottom"] }, "inner");

    renderer.applyPatches([
      { type: "insert", parentId: "outer", id: "inner" } as Patch,
    ]);

    expect(padding(outer).top).toBe("env(safe-area-inset-top, 0px)");
    expect(padding(inner).top).toBe("");
    expect(padding(inner).bottom).toBe("env(safe-area-inset-bottom, 0px)");
  });
});
