/**
 * `.padding(horizontal: 16, vertical: 8)` and the RTL logical keys.
 *
 * The axis form is documented (hypen-docs/content/docs/hypen/applicators.mdx)
 * and both native renderers resolve it, but the web renderers tested only
 * top/right/bottom/left. An object carrying just the axis keys fell through
 * to the positional branch, which finds no "0" key — so nothing was applied
 * at all, rather than something partial.
 *
 * Precedence matches Swift's `SpacingApplicators.edgesFromNamedKeys`:
 * an explicit edge beats its axis, and a logical key beats the physical one.
 */

import { describe, expect, test } from "bun:test";
import { ApplicatorRegistry } from "../packages/web/src/dom/applicators/index";
import { parseSpacing } from "../packages/web/src/canvas/utils";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

const applyDom = (name: string, value: any) => {
  const el = document.createElement("div");
  new ApplicatorRegistry().apply(el as any, name, value);
  return el.style as any;
};

describe("DOM padding named keys", () => {
  test("horizontal and vertical are applied", () => {
    const s = applyDom("padding", { horizontal: 16, vertical: 8 });
    expect(s.paddingLeft).toBe("16px");
    expect(s.paddingRight).toBe("16px");
    expect(s.paddingTop).toBe("8px");
    expect(s.paddingBottom).toBe("8px");
  });

  test("horizontal alone does not zero the other axis", () => {
    const s = applyDom("padding", { horizontal: 12 });
    expect(s.paddingLeft).toBe("12px");
    expect(s.paddingRight).toBe("12px");
    expect(s.paddingTop).toBeFalsy();
  });

  test("an explicit edge beats its axis", () => {
    const s = applyDom("padding", { vertical: 8, top: 20 });
    expect(s.paddingTop).toBe("20px");
    expect(s.paddingBottom).toBe("8px");
  });

  test("physical edges still work", () => {
    const s = applyDom("padding", { top: 1, right: 2, bottom: 3, left: 4 });
    expect(s.paddingTop).toBe("1px");
    expect(s.paddingRight).toBe("2px");
    expect(s.paddingBottom).toBe("3px");
    expect(s.paddingLeft).toBe("4px");
  });

  test("positional shorthand is untouched", () => {
    expect(applyDom("padding", { "0": 10, "1": 16 }).padding).toBe("10px 16px");
  });

  test("scalar is untouched", () => {
    expect(applyDom("padding", 12).padding).toBe("12px");
  });

  test("logical keys become direction-aware inline properties", () => {
    const s = applyDom("padding", { start: 16, end: 4 });
    expect(s.getPropertyValue("padding-inline-start")).toBe("16px");
    expect(s.getPropertyValue("padding-inline-end")).toBe("4px");
  });

  test("leading and trailing are accepted spellings", () => {
    const s = applyDom("padding", { leading: 6, trailing: 2 });
    expect(s.getPropertyValue("padding-inline-start")).toBe("6px");
    expect(s.getPropertyValue("padding-inline-end")).toBe("2px");
  });
});

describe("DOM margin named keys", () => {
  test("horizontal and vertical are applied", () => {
    const s = applyDom("margin", { horizontal: 16, vertical: 8 });
    expect(s.marginLeft).toBe("16px");
    expect(s.marginRight).toBe("16px");
    expect(s.marginTop).toBe("8px");
    expect(s.marginBottom).toBe("8px");
  });

  test("logical keys become inline properties", () => {
    const s = applyDom("margin", { start: 10 });
    expect(s.getPropertyValue("margin-inline-start")).toBe("10px");
  });
});

describe("Canvas parseSpacing named keys", () => {
  test("horizontal and vertical are applied", () => {
    expect(parseSpacing({ horizontal: 16, vertical: 8 })).toEqual({
      top: 8, right: 16, bottom: 8, left: 16,
    });
  });

  test("an explicit edge beats its axis", () => {
    expect(parseSpacing({ vertical: 8, top: 20 })).toEqual({
      top: 20, right: 0, bottom: 8, left: 0,
    });
  });

  test("a logical key beats the physical one, matching Swift", () => {
    expect(parseSpacing({ left: 4, leading: 12 }).left).toBe(12);
    expect(parseSpacing({ right: 4, trailing: 12 }).right).toBe(12);
  });

  test("start and end are accepted spellings", () => {
    expect(parseSpacing({ start: 5, end: 7 })).toEqual({
      top: 0, right: 7, bottom: 0, left: 5,
    });
  });

  test("physical, positional and scalar forms are untouched", () => {
    expect(parseSpacing({ top: 1, right: 2, bottom: 3, left: 4 })).toEqual({
      top: 1, right: 2, bottom: 3, left: 4,
    });
    expect(parseSpacing({ "0": 10, "1": 20 })).toEqual({
      top: 10, right: 20, bottom: 10, left: 20,
    });
    expect(parseSpacing(6)).toEqual({ top: 6, right: 6, bottom: 6, left: 6 });
    expect(parseSpacing("10 20")).toEqual({ top: 10, right: 20, bottom: 10, left: 20 });
  });
});
