import { describe, expect, test } from "bun:test";
import { ApplicatorRegistry } from "../packages/web/src/dom/applicators";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

describe("DOM border contract", () => {
  test("directional border widths default their side to solid", () => {
    const registry = new ApplicatorRegistry();
    const element = document.createElement("div");

    registry.applyAll(element, {
      "borderTopWidth.0": "1px",
      "borderRightWidth.0": "2px",
      "borderBottomWidth.0": "3px",
      "borderLeftWidth.0": "4px",
      "borderColor.0": "#e5e7eb",
    });

    expect(element.style.borderTopWidth).toBe("1px");
    expect(element.style.borderRightWidth).toBe("2px");
    expect(element.style.borderBottomWidth).toBe("3px");
    expect(element.style.borderLeftWidth).toBe("4px");
    expect(element.style.borderTopStyle).toBe("solid");
    expect(element.style.borderRightStyle).toBe("solid");
    expect(element.style.borderBottomStyle).toBe("solid");
    expect(element.style.borderLeftStyle).toBe("solid");
    expect(element.style.borderColor).toBe("#e5e7eb");
  });

  test("a directional width replaces an inherited none style", () => {
    const registry = new ApplicatorRegistry();
    const element = document.createElement("div");
    element.style.borderBottomStyle = "none";

    registry.apply(element, "borderBottomWidth", "1px");

    expect(element.style.borderBottomWidth).toBe("1px");
    expect(element.style.borderBottomStyle).toBe("solid");
  });

  test("a dashed top rule stays a top rule: unset sides get no medium-width dashes", () => {
    // `.tw("w-full border-t-2 border-dashed")` (Calories goal line), in both
    // prop orders. Plain CSS would give the other three dashed sides the
    // `medium` (3px) default width.
    for (const props of [
      { "borderTopWidth.0": "2px", "borderStyle.0": "dashed" },
      { "borderStyle.0": "dashed", "borderTopWidth.0": "2px" },
    ]) {
      const registry = new ApplicatorRegistry();
      const element = document.createElement("div");
      registry.applyAll(element, props);
      expect(element.style.borderTopWidth).toBe("2px");
      expect(element.style.borderRightWidth).toBe("0px");
      expect(element.style.borderBottomWidth).toBe("0px");
      expect(element.style.borderLeftWidth).toBe("0px");
    }
  });

  test("a style with a uniform width, or with no width at all, is left alone", () => {
    const registry = new ApplicatorRegistry();
    const uniform = document.createElement("div");
    registry.applyAll(uniform, { "borderWidth.0": "1px", "borderStyle.0": "dashed" });
    expect(uniform.style.borderWidth).toBe("1px");
    expect(uniform.style.borderTopWidth || "").not.toBe("0px");
    const bare = document.createElement("div");
    registry.applyAll(bare, { "borderStyle.0": "dotted" });
    expect(bare.style.borderTopWidth || "").toBe("");
    expect(bare.style.borderLeftWidth || "").toBe("");
  });
});
