import { describe, expect, test } from "bun:test";
import { transformHandlers } from "../packages/web/src/dom/applicators/transform";
import { effectsHandlers } from "../packages/web/src/dom/applicators/effects";
import { ensureFakeDomGlobals } from "./fake-dom";

ensureFakeDomGlobals();

function el(): HTMLElement {
  return document.createElement("div") as unknown as HTMLElement;
}

describe("transform applicators compose by replacing their own function", () => {
  // Regression: a reactive `.scale("@{hovered ? 1.07 : 1}")` used to append
  // every value — `scale(1) scale(1.07) scale(1)` — so the icon never scaled
  // back down after the pointer left (home-screen launcher).
  test("re-applying scale replaces the previous scale", () => {
    const e = el();
    transformHandlers.scale(e, 1);
    transformHandlers.scale(e, 1.07);
    transformHandlers.scale(e, 1);
    expect(e.style.transform).toBe("scale(1)");
  });

  test("different functions still compose, in first-seen order", () => {
    const e = el();
    transformHandlers.translateX(e, 10);
    transformHandlers.rotate(e, "45deg");
    transformHandlers.scale(e, 2);
    transformHandlers.translateX(e, 20);
    expect(e.style.transform).toBe("translateX(20px) rotate(45deg) scale(2)");
  });

  test("legacy accumulated duplicates collapse to one", () => {
    const e = el();
    e.style.transform = "scale(1) scale(1.07) rotate(3deg)";
    transformHandlers.scale(e, 1);
    expect(e.style.transform).toBe("scale(1) rotate(3deg)");
  });

  test("the raw transform applicator still overwrites everything", () => {
    const e = el();
    transformHandlers.scale(e, 2);
    transformHandlers.transform(e, "none");
    expect(e.style.transform).toBe("none");
  });
});

describe("transform edge cases", () => {
  test("arguments with nested parens survive a later composition", () => {
    const e = el();
    transformHandlers.translateX(e, "calc(100% - 10px)");
    transformHandlers.scale(e, 2);
    expect(e.style.transform).toBe("translateX(calc(100% - 10px)) scale(2)");
  });

  test("removing a function (undefined) drops it rather than writing fn(undefined)", () => {
    const e = el();
    transformHandlers.translateX(e, 10);
    transformHandlers.scale(e, 2);
    transformHandlers.scale(e, undefined);
    expect(e.style.transform).toBe("translateX(10px)");
    transformHandlers.translateX(e, undefined);
    expect(e.style.transform).toBe("");
  });
});

describe("filter applicators compose the same way", () => {
  test("re-applying blur replaces the previous blur", () => {
    const e = el();
    effectsHandlers.blur(e, 0);
    effectsHandlers.blur(e, 4);
    effectsHandlers.blur(e, 0);
    expect(e.style.filter).toBe("blur(0px)");
  });

  test("different filters compose; hue-rotate keeps its hyphenated name", () => {
    const e = el();
    effectsHandlers.saturate(e, 1.2);
    effectsHandlers.hueRotate(e, "90deg");
    effectsHandlers.saturate(e, 0.5);
    expect(e.style.filter).toBe("saturate(0.5) hue-rotate(90deg)");
  });
});

describe("RemoveProp (applicator re-run with undefined) removes only that function", () => {
  test("removing scale keeps the sibling transforms", () => {
    const e = el();
    transformHandlers.translateX(e, 4);
    transformHandlers.scale(e, 1.5);
    transformHandlers.scale(e, undefined);
    expect(e.style.transform).toBe("translateX(4px)");
  });

  test("removing the last filter empties the property", () => {
    const e = el();
    effectsHandlers.blur(e, 2);
    effectsHandlers.blur(e, undefined);
    expect(e.style.filter).toBe("");
  });
});

describe("filter applicators share the same list helper", () => {
  test("drop-shadow with a nested colour function survives a later blur", async () => {
    const { effectsHandlers } = await import("../packages/web/src/dom/applicators/effects");
    const e = el();
    effectsHandlers.dropShadow(e, "0 0 2px rgb(0 0 0 / 50%)");
    effectsHandlers.blur(e, 4);
    expect(e.style.filter).toBe("drop-shadow(0 0 2px rgb(0 0 0 / 50%)) blur(4px)");
    effectsHandlers.dropShadow(e, undefined);
    expect(e.style.filter).toBe("blur(4px)");
  });
});
