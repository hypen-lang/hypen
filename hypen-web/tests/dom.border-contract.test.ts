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
});
