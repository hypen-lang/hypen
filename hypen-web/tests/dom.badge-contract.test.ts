import { describe, expect, test } from "bun:test";
import type { IEngine as Engine } from "../packages/core/src/app";
import type { Patch } from "../packages/core/src/types";
import { BADGE_DEFAULTS } from "../packages/web/src/dom/components/badge";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

function renderBadge(props: Record<string, unknown>): FakeElement {
  const renderer = new DOMRenderer(
    document.createElement("div"),
    new StubEngine() as unknown as Engine,
  );
  renderer.applyPatches([{
    type: "create",
    id: "badge",
    elementType: "Badge",
    props,
  } as Patch]);
  return renderer.getNode("badge") as unknown as FakeElement;
}

function renderBadgeWithChild(props: Record<string, unknown>): {
  badge: FakeElement;
  child: FakeElement;
} {
  const renderer = new DOMRenderer(
    document.createElement("div"),
    new StubEngine() as unknown as Engine,
  );
  renderer.applyPatches([
    {
      type: "create",
      id: "badge",
      elementType: "Badge",
      props,
    } as Patch,
    {
      type: "create",
      id: "count",
      elementType: "Text",
      props: { 0: "5" },
    } as Patch,
    { type: "insert", parentId: "badge", id: "count" } as Patch,
  ]);

  return {
    badge: renderer.getNode("badge") as unknown as FakeElement,
    child: renderer.getNode("count") as unknown as FakeElement,
  };
}

describe("DOM Badge contract", () => {
  test("raw Badge uses the canonical defaults", () => {
    const badge = renderBadge({ 0: "New" });

    expect(badge.style.backgroundColor).toBe(BADGE_DEFAULTS.backgroundColor);
    expect(badge.style.color).toBe(BADGE_DEFAULTS.color);
    expect(badge.style.borderRadius).toBe(BADGE_DEFAULTS.borderRadius);
    expect(badge.style.padding).toBe(BADGE_DEFAULTS.padding);
    expect(badge.style.fontSize).toBe(BADGE_DEFAULTS.fontSize);
    expect(badge.style.fontWeight).toBe(BADGE_DEFAULTS.fontWeight);
    expect(badge.style.boxSizing).toBe("border-box");
    expect(badge.style.display).toBe("inline-flex");
  });

  test("custom padding replaces the default instead of adding to it", () => {
    const badge = renderBadge({ 0: "New", "padding.0": 2 });

    expect(badge.style.padding).toBe("2px");
  });

  test("an explicit 20x20 count remains a 20x20 border box", () => {
    const badge = renderBadge({ 0: "5", "width.0": 20, "height.0": 20 });

    expect(badge.style.width).toBe("20px");
    expect(badge.style.height).toBe("20px");
    expect(badge.style.padding).toBe("0px");
    expect(badge.style.boxSizing).toBe("border-box");
  });

  test("an explicit 20x20 count centers its nested label", () => {
    const { badge, child } = renderBadgeWithChild({
      "width.0": 20,
      "height.0": 20,
      "horizontalAlignment.0": "center",
      "verticalAlignment.0": "center",
    });

    expect(badge.children).toEqual([child]);
    expect(badge.style.display).toBe("inline-flex");
    expect(badge.style.justifyContent).toBe("center");
    expect(badge.style.alignItems).toBe("center");
    expect(badge.style.width).toBe("20px");
    expect(badge.style.height).toBe("20px");
    expect(badge.style.padding).toBe("0px");
  });

  test("custom visuals win over component defaults", () => {
    const badge = renderBadge({
      0: "Pro",
      "backgroundColor.0": "#3b82f6",
      "color.0": "#ffffff",
      "cornerRadius.0": 10,
      "fontSize.0": 14,
      "fontWeight.0": "500",
    });

    expect(badge.style.backgroundColor).toBe("#3b82f6");
    expect(badge.style.color).toBe("#ffffff");
    expect(badge.style.borderRadius).toBe("10px");
    expect(badge.style.fontSize).toBe("14px");
    expect(badge.style.fontWeight).toBe("500");
  });
});
