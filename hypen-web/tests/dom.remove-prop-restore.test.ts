/**
 * DOM renderer fixes, checked against a real CSSOM (JSDOM): a browser drops
 * an invalid declaration such as `overflow-y: undefined`, which a lenient
 * fake style object would happily store.
 *
 * 1. RemoveProp of a style applicator clears its CSS. A When/If case switch
 *    that reuses the case's root node emits `RemoveProp("maxWidth.0")` /
 *    `RemoveProp("overflowY.0")`; most handlers wrote `String(undefined)`,
 *    which the browser rejected, so the previous screen's `max-width:
 *    420px` / `overflow-y: auto` stayed on the next screen. Removal now
 *    restores what the component created (Column's `display: flex`), keeps
 *    what other live applicators wrote, and works on template clones.
 * 2. `.textAlign(...)` no longer stretches across a Row's cross axis or
 *    takes the whole row: the fill applies outside horizontal parents only.
 * 3. Link hrefs refuse dangerous schemes.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import { sanitizeHref } from "../packages/web/src/dom/components/link";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";

const GLOBAL_KEYS = [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "Node",
  "Element",
  "Event",
  "CSSStyleSheet",
  "getComputedStyle",
];
const originalGlobals: Record<string, unknown> = {};
for (const key of GLOBAL_KEYS) originalGlobals[key] = (globalThis as any)[key];

const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
  url: "http://localhost/",
});
for (const key of GLOBAL_KEYS) {
  (globalThis as any)[key] =
    key === "getComputedStyle"
      ? dom.window.getComputedStyle.bind(dom.window)
      : key === "document"
        ? dom.window.document
        : (dom.window as any)[key];
}

afterAll(() => {
  for (const key of GLOBAL_KEYS) (globalThis as any)[key] = originalGlobals[key];
});
afterEach(() => {
  document.body.innerHTML = "";
});

class StubEngine {
  dispatchAction(): void {}
}

const mount = () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new DOMRenderer(container, new StubEngine() as unknown as Engine);
  return { container, renderer };
};

const create = (id: string, elementType: string, props: Record<string, unknown>, parentId = "root"): Patch[] => [
  { type: "create", id, elementType, props } as Patch,
  { type: "insert", parentId, id } as Patch,
];

const el = (renderer: DOMRenderer, id: string) => renderer.getNode(id) as HTMLElement;

describe("RemoveProp clears applicator CSS", () => {
  test("a reused When-case root drops the previous case's maxWidth / overflowY", () => {
    const { renderer } = mount();
    // Setup screen: the case root carries a card width and a scroller.
    renderer.applyPatches(create("case", "Column", { "maxWidth.0": 420, "overflowY.0": "auto", "padding.0": 16 }));
    const root = el(renderer, "case");
    expect(root.style.maxWidth).toBe("420px");
    expect(root.style.overflowY).toBe("auto");

    // The case switches; the engine reuses the node and removes what the
    // next case does not set.
    renderer.applyPatches([
      { type: "removeProp", id: "case", name: "maxWidth.0" } as Patch,
      { type: "removeProp", id: "case", name: "overflowY.0" } as Patch,
    ]);
    expect(root.style.maxWidth).toBe("");
    expect(root.style.overflowY).toBe("");
    expect(root.style.padding).toBe("16px");
  });

  test.each([
    ["overflowX", "scroll"],
    ["overflow", "hidden"],
    ["opacity", 0.5],
    ["backgroundColor", "red"],
    ["position", "absolute"],
    ["zIndex", 3],
    ["border", "1px solid red"],
    ["borderWidth", 2],
    ["shadow", 2],
    ["cursor", "pointer"],
    ["visibility", "hidden"],
    ["textAlign", "right"],
    ["fillMaxWidth", true],
    ["maxLines", 2],
    ["flex", 1],
    ["weight", 1],
    ["someUnknownCssProp", "x"],
  ])("removing %s leaves the element as it was before", (name, value) => {
    const { renderer } = mount();
    renderer.applyPatches(create("n", "Column", {}));
    const node = el(renderer, "n");
    const before = node.style.cssText;
    renderer.applyPatches([{ type: "setProp", id: "n", name: `${name}.0`, value } as Patch]);
    renderer.applyPatches([{ type: "removeProp", id: "n", name: `${name}.0` } as Patch]);
    expect(node.style.cssText).toBe(before);
    expect(node.dataset.hypenTextFill).toBeUndefined();
  });

  test("removal restores the component's own declaration, not a blank", () => {
    const { renderer } = mount();
    renderer.applyPatches(create("n", "Column", { "display.0": "grid", "alignItems.0": "center" }));
    const node = el(renderer, "n");
    expect(node.style.display).toBe("grid");
    renderer.applyPatches([
      { type: "removeProp", id: "n", name: "display.0" } as Patch,
      { type: "removeProp", id: "n", name: "alignItems.0" } as Patch,
    ]);
    expect(node.style.display).toBe("flex");
    expect(node.style.alignItems).toBe("flex-start");
  });

  test("a property shared with another live applicator keeps that applicator's value", () => {
    const { renderer } = mount();
    renderer.applyPatches(
      create("n", "Column", { "flex.0": 1, "minWidth.0": 50, "translateX.0": 10, "rotate.0": "5deg" }),
    );
    const node = el(renderer, "n");
    renderer.applyPatches([
      { type: "removeProp", id: "n", name: "flex.0" } as Patch,
      { type: "removeProp", id: "n", name: "translateX.0" } as Patch,
    ]);
    expect(node.style.flex).toBe("");
    expect(node.style.minWidth).toBe("50px");
    expect(node.style.minHeight).toBe("");
    // Composed transform: only the removed term goes.
    expect(node.style.transform).toBe("rotate(5deg)");
  });

  test("breakpoint value maps: removing the default and the variant drops both rules", () => {
    const { renderer } = mount();
    renderer.applyPatches(create("n", "Column", { "maxWidth.0": 420, "maxWidth@md.0": 600 }));
    const node = el(renderer, "n");
    expect([...node.classList].some((c) => c.startsWith("hypen-max-width-"))).toBe(true);
    renderer.applyPatches([
      { type: "removeProp", id: "n", name: "maxWidth.0" } as Patch,
      { type: "removeProp", id: "n", name: "maxWidth@md.0" } as Patch,
    ]);
    expect([...node.classList].some((c) => c.startsWith("hypen-max-width-"))).toBe(false);
    expect(node.style.maxWidth).toBe("");
  });

  test("a template clone clears what its prototype's applicators wrote", () => {
    const { renderer } = mount();
    renderer.applyPatches([
      ...create("list", "Column", {}),
      {
        type: "registerTemplate",
        templateId: "t",
        root: { elementType: "Column", props: { "overflowY.0": "auto", "display.0": "grid" }, children: [] },
      } as any,
      { type: "instantiate", templateId: "t", parentId: "list", nodes: ["r1"], subs: [], nodeSemantics: [] } as any,
    ]);
    const row = el(renderer, "r1");
    expect(row.style.overflowY).toBe("auto");
    renderer.applyPatches([
      { type: "removeProp", id: "r1", name: "overflowY.0" } as Patch,
      { type: "removeProp", id: "r1", name: "display.0" } as Patch,
    ]);
    expect(row.style.overflowY).toBe("");
    expect(row.style.display).toBe("flex");
  });
});

describe("textAlign fill respects a Row's cross axis", () => {
  const mountIn = (parentType: string, childType: string, childProps: Record<string, unknown>) => {
    const { renderer } = mount();
    renderer.applyPatches([
      ...create("p", parentType, {}),
      ...create("c", childType, childProps, "p"),
    ]);
    return el(renderer, "c");
  };

  test("inside a Row: no stretch, no full width (the Row's alignment holds)", () => {
    const text = mountIn("Row", "Text", { "0": "12:30", "textAlign.0": "right" });
    expect(text.style.textAlign).toBe("right");
    expect(text.style.alignSelf).toBe("");
    expect(text.style.width).toBe("");
    expect(getComputedStyle(text).alignSelf).not.toBe("stretch");

    const badge = mountIn("Row", "Badge", { "0": "3", "textAlign.0": "center" });
    expect(badge.style.width).toBe("");
    expect(getComputedStyle(badge).alignSelf).not.toBe("stretch");
  });

  test("inside a Column: still fills so the alignment is visible", () => {
    const text = mountIn("Column", "Text", { "0": "Edit Profile", "textAlign.0": "center" });
    expect(getComputedStyle(text).alignSelf).toBe("stretch");
    expect(text.style.display).toBe("block");
  });

  test("an explicit alignSelf wins over the fill", () => {
    const text = mountIn("Column", "Text", { "0": "x", "textAlign.0": "right", "alignSelf.0": "center" });
    expect(getComputedStyle(text).alignSelf).toBe("center");
  });

  test("left alignment and removal drop the fill", () => {
    const { renderer } = mount();
    renderer.applyPatches([...create("p", "Column", {}), ...create("c", "Text", { "0": "x", "textAlign.0": "center" }, "p")]);
    const text = el(renderer, "c");
    expect(text.dataset.hypenTextFill).toBe("");
    renderer.applyPatches([{ type: "setProp", id: "c", name: "textAlign.0", value: "left" } as Patch]);
    expect(text.dataset.hypenTextFill).toBeUndefined();
    renderer.applyPatches([{ type: "setProp", id: "c", name: "textAlign.0", value: "center" } as Patch]);
    renderer.applyPatches([{ type: "removeProp", id: "c", name: "textAlign.0" } as Patch]);
    expect(text.dataset.hypenTextFill).toBeUndefined();
    expect(text.style.textAlign).toBe("");
    expect(text.style.display).toBe("inline-block");
  });
});

describe("Link href scheme filtering", () => {
  test.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " \tjava\nscript:alert(1)",
    "\u0001javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/png;base64,AAAA",
    "file:///etc/passwd",
    "blob:http://localhost/abc",
  ])("refuses %p", (href) => {
    expect(sanitizeHref(href)).toBeNull();
    const { renderer } = mount();
    renderer.applyPatches(create("l", "Link", { href }));
    expect(el(renderer, "l").hasAttribute("href")).toBe(false);
  });

  test.each([
    "https://example.com/a?b#c",
    "http://example.com",
    "mailto:someone@example.com",
    "tel:+15551234",
    "/settings",
    "settings/profile",
    "../up",
    "#section",
    "?q=1",
    "//cdn.example.com/x",
  ])("allows %p", (href) => {
    expect(sanitizeHref(href)).toBe(href);
    const { renderer } = mount();
    renderer.applyPatches(create("l", "Link", { "0": href }));
    expect(el(renderer, "l").getAttribute("href")).toBe(href);
  });

  test("a SetProp to an unsafe href removes the previous one; RemoveProp clears it", () => {
    const { renderer } = mount();
    renderer.applyPatches(create("l", "Link", { href: "/ok" }));
    const link = el(renderer, "l");
    expect(link.getAttribute("href")).toBe("/ok");
    renderer.applyPatches([{ type: "setProp", id: "l", name: "href", value: "javascript:void(0)" } as Patch]);
    expect(link.hasAttribute("href")).toBe(false);
    renderer.applyPatches([{ type: "setProp", id: "l", name: "href", value: "/again" } as Patch]);
    expect(link.getAttribute("href")).toBe("/again");
    renderer.applyPatches([{ type: "removeProp", id: "l", name: "href" } as Patch]);
    expect(link.hasAttribute("href")).toBe(false);
  });
});
