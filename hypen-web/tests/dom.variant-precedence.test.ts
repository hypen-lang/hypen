/**
 * State/breakpoint variants must WIN over the prop's default.
 *
 * Regression suite for the silent-shadowing bug: a prop with a registered
 * applicator handler (`opacity`, `color`, `backgroundColor`, …) had its
 * default written INLINE by the handler while its variants were emitted as
 * CSS class rules. Inline styles beat class rules unconditionally, so every
 * `:hover` / `:active` / `@md` override on such a prop silently did nothing —
 * while the very same variants worked on props that had no handler.
 *
 * The contract now: as soon as an element carries a variant-qualified sibling
 * for a base prop, the DEFAULT is emitted as a rule too, so both live at the
 * same specificity tier and the CSS cascade decides.
 */

import { describe, expect, test } from "bun:test";
import { ApplicatorRegistry } from "../packages/web/src/dom/applicators";
import { DOMRenderer } from "../packages/web/src/dom/renderer";
import type { Patch } from "../packages/core/src/types";
import type { IEngine as Engine } from "../packages/core/src/app";
import { configureLogger, getLogLevel, setLogLevel } from "../packages/core/src/logger";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

ensureFakeDomGlobals();

class StubEngine {
  dispatchAction(): void {}
}

const makeElement = () => document.createElement("div") as unknown as HTMLElement;

const classesOf = (element: HTMLElement) =>
  (element as unknown as FakeElement).classList.toString().split(" ").filter(Boolean).sort();

/** Every rule currently in the singleton variant stylesheet, in source order. */
const rules = (): string[] => {
  const styleEl = (document as unknown as {
    getElementById(id: string): { sheet: { cssRules: { cssText: string }[] } } | null;
  }).getElementById("hypen-variants");
  return styleEl ? styleEl.sheet.cssRules.map((rule) => rule.cssText) : [];
};

const ruleIndex = (match: string): number => rules().findIndex((rule) => rule.includes(match));

/** Capture logger WARN output at the default ("info") level. */
const captureWarns = (run: (warns: string[]) => void) => {
  const warns: string[] = [];
  const previousLevel = getLogLevel();
  setLogLevel("info");
  configureLogger({
    handler: {
      debug: () => {},
      info: () => {},
      warn: (_tag: string, ...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      },
      error: () => {},
    },
  });
  try {
    run(warns);
  } finally {
    configureLogger({ handler: undefined });
    setLogLevel(previousLevel);
  }
};

describe("handler-backed props: variants are not shadowed by the inline default", () => {
  // The exact key shape the engine lowers
  // `.opacity({ default: 1, hover: 0.85, active: 0.6 })` into.
  test("opacity default+hover+active leaves nothing inline and carries every class", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.applyAll(element, {
      "opacity.0": 1,
      "opacity:hover.0": 0.85,
      "opacity:active.0": 0.6,
    });

    // The default must NOT sit inline — that is what used to shadow everything.
    expect(element.style.opacity).toBeFalsy();

    const classes = classesOf(element);
    expect(classes).toHaveLength(3);
    expect(classes.some((c) => c.startsWith("hypen-opacity-base-"))).toBe(true);
    expect(classes.some((c) => c.startsWith("hypen-opacity-hover-"))).toBe(true);
    expect(classes.some((c) => c.startsWith("hypen-opacity-active-"))).toBe(true);

    // …and the rules carry the values the handler would have written inline.
    expect(rules()).toContain(`.${classes.find((c) => c.includes("-base-"))} { opacity: 1; }`);
    expect(rules()).toContain(
      `.${classes.find((c) => c.includes("-hover-"))}:hover { opacity: 0.85; }`,
    );
    expect(rules()).toContain(
      `.${classes.find((c) => c.includes("-active-"))}:active { opacity: 0.6; }`,
    );
  });

  test("color default+hover+active leaves nothing inline and carries every class", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.applyAll(element, {
      "color.0": "#111111",
      "color:hover.0": "#222222",
      "color:active.0": "#333333",
    });

    expect(element.style.color).toBeFalsy();

    const classes = classesOf(element);
    expect(classes).toHaveLength(3);
    expect(rules()).toContain(
      `.${classes.find((c) => c.includes("-base-"))} { color: #111111; }`,
    );
    expect(rules()).toContain(
      `.${classes.find((c) => c.includes("-hover-"))}:hover { color: #222222; }`,
    );
    expect(rules()).toContain(
      `.${classes.find((c) => c.includes("-active-"))}:active { color: #333333; }`,
    );
  });

  test("backgroundColor default+hover+active leaves nothing inline and carries every class", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.applyAll(element, {
      "backgroundColor.0": "#aaaaaa",
      "backgroundColor:hover.0": "#bbbbbb",
      "backgroundColor:active.0": "#cccccc",
    });

    expect(element.style.backgroundColor).toBeFalsy();

    const classes = classesOf(element);
    expect(classes).toHaveLength(3);
    expect(rules()).toContain(
      `.${classes.find((c) => c.includes("-base-"))} { background-color: #aaaaaa; }`,
    );
    expect(rules()).toContain(
      `.${classes.find((c) => c.includes("-hover-"))}:hover { background-color: #bbbbbb; }`,
    );
  });

  test("the default value reaches CSS through its handler, not a naive stringify", () => {
    // `.padding(10, 16)` arrives as positional args; only the handler knows it
    // is a CSS shorthand. A default routed through the class mechanism must
    // still be lowered by that handler.
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.applyAll(element, {
      "padding.0": 10,
      "padding.1": 16,
      "padding@md.0": 24,
    });

    expect(element.style.padding).toBeFalsy();
    const base = classesOf(element).find((c) => c.includes("-base-"))!;
    expect(rules()).toContain(`.${base} { padding: 10px 16px; }`);
  });
});

describe("arrival order does not matter", () => {
  const applyInOrder = (keys: string[]) => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();
    const values: Record<string, unknown> = {
      "opacity.0": 1,
      "opacity:hover.0": 0.85,
      "opacity@md.0": 0.5,
    };
    for (const key of keys) registry.apply(element, key, values[key]);
    return element;
  };

  test("default-then-variants and variants-then-default reach the same state", () => {
    const defaultFirst = applyInOrder(["opacity.0", "opacity:hover.0", "opacity@md.0"]);
    const variantsFirst = applyInOrder(["opacity@md.0", "opacity:hover.0", "opacity.0"]);

    expect(defaultFirst.style.opacity).toBeFalsy();
    expect(variantsFirst.style.opacity).toBeFalsy();
    expect(classesOf(defaultFirst)).toEqual(classesOf(variantsFirst));
    expect(classesOf(defaultFirst)).toHaveLength(3);
  });

  test("a variant retroactively converts a default already written inline", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    // Nothing knows about variants yet: the handler writes inline, as always.
    registry.apply(element, "opacity.0", 1);
    expect(element.style.opacity).toBe("1");

    // The variant arrives in a later batch and must undo that inline write.
    registry.apply(element, "opacity:hover.0", 0.85);
    expect(element.style.opacity).toBeFalsy();
    expect(classesOf(element).some((c) => c.startsWith("hypen-opacity-base-"))).toBe(true);
  });

  test("the default rule precedes the @media rule so the breakpoint wins on order", () => {
    // Same specificity (one class each) — only source order separates them.
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.apply(element, "letterSpacing@lg.0", "0.1em");
    registry.apply(element, "letterSpacing.0", "0.4em");

    const base = ruleIndex("letter-spacing: 0.4em");
    const md = ruleIndex("letter-spacing: 0.1em");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(md).toBeGreaterThanOrEqual(0);
    expect(base).toBeLessThan(md);
  });

  test("higher breakpoints win regardless of the order their patches arrive", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.applyAll(element, {
      "gridColumns@md.0": 2,
      "gridColumns@xl.0": 3,
      "gridColumns.0": 1,
    });

    const base = ruleIndex("repeat(1, 1fr)");
    const md = ruleIndex("min-width: 768px");
    const xl = ruleIndex("min-width: 1280px");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(md).toBeGreaterThanOrEqual(0);
    expect(xl).toBeGreaterThanOrEqual(0);
    expect(base).toBeLessThan(md);
    expect(md).toBeLessThan(xl);
  });

  test("overlapping interaction states follow the shared precedence order", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.applyAll(element, {
      "opacity:active.0": 0.4,
      "opacity:hover.0": 0.8,
      "opacity:focus.0": 0.6,
      "opacity.0": 1,
    });

    const base = ruleIndex("opacity: 1");
    const hover = ruleIndex(":hover");
    const focus = ruleIndex(":focus");
    const active = ruleIndex(":active");
    expect(base).toBeLessThan(hover);
    expect(hover).toBeLessThan(focus);
    expect(focus).toBeLessThan(active);
  });
});

describe("no variants: the handler path is untouched", () => {
  test("handler-backed props with no variants still style inline", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.applyAll(element, {
      "opacity.0": 0.5,
      "color.0": "red",
      "backgroundColor.0": "blue",
      "padding.0": 16,
    });

    expect(element.style.opacity).toBe("0.5");
    expect(element.style.color).toBe("red");
    expect(element.style.backgroundColor).toBe("blue");
    expect(element.style.padding).toBe("16px");
    expect(classesOf(element)).toEqual([]);
  });

  test("a handler's non-CSS side effects survive the class conversion", () => {
    // `.weight()` writes the durable `data-hypen-flex` marker consumed by
    // Row width-demand reconciliation. It must survive variant lowering.
    const registry = new ApplicatorRegistry();
    const plain = makeElement();
    const varied = makeElement();

    registry.applyAll(plain, { "weight.0": 1 });
    registry.applyAll(varied, { "weight.0": 1, "weight@md.0": 2 });

    expect(plain.dataset.hypenFlex).toBe("true");
    expect(varied.dataset.hypenFlex).toBe("true");
    expect(varied.style.flex).toBeFalsy();
  });

  test("a prop with no handler still variants exactly as before", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.apply(element, "outline.0", "1px solid gray");
    registry.apply(element, "outline:focus-visible.0", "2px solid blue");

    expect(element.style.outline).toBeFalsy();
    const classes = classesOf(element);
    expect(classes.some((c) => c.startsWith("hypen-outline-base-"))).toBe(true);
    expect(classes.some((c) => c.startsWith("hypen-outline-focus-visible-"))).toBe(true);
    expect(rules()).toContain(
      `.${classes.find((c) => c.includes("-focus-visible-"))}:focus-visible { outline: 2px solid blue; }`,
    );
  });

  test("a handler-less prop with no variants still writes inline", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.apply(element, "mixBlendMode.0", "multiply");
    expect(element.style.getPropertyValue("mix-blend-mode")).toBe("multiply");
    expect(classesOf(element)).toEqual([]);
  });
});

describe("props that cannot be expressed as a rule degrade loudly", () => {
  test("transform-composing props warn by name and keep their inline default", () => {
    captureWarns((warns) => {
      const registry = new ApplicatorRegistry();
      const element = makeElement();

      registry.applyAll(element, { "scale.0": 1, "scale:hover.0": 1.1 });

      // Documented limitation: translateX/scale/rotate/skew all compose into
      // ONE `style.transform`, so a per-variant rule cannot express them.
      expect(element.style.transform).toBe("scale(1)");
      expect(classesOf(element)).toEqual([]);
      expect(warns.some((w) => w.includes("scale") && w.includes("transform"))).toBe(true);
    });
  });

  test("the warning fires once per element+prop, not once per patch", () => {
    captureWarns((warns) => {
      const registry = new ApplicatorRegistry();
      const element = makeElement();

      registry.apply(element, "translateX:hover.0", 10);
      registry.apply(element, "translateX:active.0", 20);
      registry.apply(element, "translateX.0", 0);

      expect(warns.filter((w) => w.includes("translateX"))).toHaveLength(1);
    });
  });

  test("`transform` itself is expressible and does get variant rules", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.applyAll(element, {
      "transform.0": "scale(1)",
      "transform:active.0": "scale(0.95)",
    });

    expect(element.style.transform).toBeFalsy();
    expect(classesOf(element)).toHaveLength(2);
  });

  test("animator-owned transition props warn and stay inline", () => {
    captureWarns((warns) => {
      const registry = new ApplicatorRegistry();
      const element = makeElement();

      registry.applyAll(element, {
        "transition.0": "opacity 200ms",
        "transition:hover.0": "opacity 50ms",
      });

      expect(element.style.transition).toBe("opacity 200ms");
      expect(classesOf(element)).toEqual([]);
      expect(warns.some((w) => w.includes("transition"))).toBe(true);
    });
  });

  test("attribute-only applicators warn instead of emitting an empty rule", () => {
    captureWarns((warns) => {
      const registry = new ApplicatorRegistry();
      const element = makeElement();

      registry.apply(element, "aria:hover", { "0": "busy", "1": "true" });

      expect(classesOf(element)).toEqual([]);
      expect(warns.some((w) => w.includes("aria"))).toBe(true);
    });
  });
});

describe("rule bookkeeping", () => {
  test("a changed value swaps the class instead of stacking rules on the element", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.applyAll(element, { "opacity.0": 1, "opacity:hover.0": 0.85 });
    const first = classesOf(element).find((c) => c.includes("-base-"))!;

    registry.apply(element, "opacity.0", 0.4);
    const classes = classesOf(element);

    expect(classes).toHaveLength(2);
    expect(classes).not.toContain(first);
    expect(classes.some((c) => c.startsWith("hypen-opacity-base-"))).toBe(true);
    expect(element.style.opacity).toBeFalsy();
  });

  test("removing a prop drops its managed class", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.applyAll(element, { "opacity.0": 1, "opacity:hover.0": 0.85 });
    expect(classesOf(element)).toHaveLength(2);

    // RemoveProp is delivered as `apply(el, name, undefined)`.
    registry.apply(element, "opacity:hover.0", undefined);
    expect(classesOf(element)).toHaveLength(1);

    registry.apply(element, "opacity.0", undefined);
    expect(classesOf(element)).toHaveLength(0);
  });

  test("values that share a readable prefix do not share a class", () => {
    // The readable part of the class name is the first 8 alphanumerics, and
    // the CSSOM hands values back normalized — `rgb(51, 51, 51)` and
    // `rgb(51, 51, 52)` are identical that far in.
    const registry = new ApplicatorRegistry();
    const a = makeElement();
    const b = makeElement();

    registry.applyAll(a, { "color.0": "rgb(51, 51, 51)", "color:hover.0": "#fff" });
    registry.applyAll(b, { "color.0": "rgb(51, 51, 52)", "color:hover.0": "#fff" });

    const baseA = classesOf(a).find((c) => c.includes("-base-"));
    const baseB = classesOf(b).find((c) => c.includes("-base-"));
    expect(baseA).not.toBe(baseB);
  });

  test("malformed variants still apply nothing at all", () => {
    const registry = new ApplicatorRegistry();
    const element = makeElement();

    registry.apply(element, "backgroundColor@bogus:hover.0", "#fff");
    registry.apply(element, "backgroundColor@md:bogus.0", "#fff");
    registry.apply(element, "opacity@nope.0", 0.5);

    expect(classesOf(element)).toEqual([]);
    expect(element.style.backgroundColor).toBeFalsy();
    expect(element.style.opacity).toBeFalsy();
  });
});

describe("through the DOM renderer", () => {
  const makeRenderer = () => {
    const container = document.createElement("div");
    return new DOMRenderer(container, new StubEngine() as unknown as Engine);
  };

  test("a create patch carrying variant props leaves no inline shadow", () => {
    const renderer = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "btn",
        elementType: "Button",
        props: {
          "opacity.0": 1,
          "opacity:hover.0": 0.85,
          "opacity:active.0": 0.6,
        },
      } as Patch,
    ]);

    const button = renderer.getNode("btn")! as unknown as HTMLElement;
    expect(button.style.opacity).toBeFalsy();
    expect(classesOf(button)).toHaveLength(3);
  });

  test("a variant delivered by a later setProp converts the created default", () => {
    const renderer = makeRenderer();

    renderer.applyPatches([
      {
        type: "create",
        id: "btn2",
        elementType: "Button",
        props: { "backgroundColor.0": "#123456" },
      } as Patch,
    ]);

    const button = renderer.getNode("btn2")! as unknown as HTMLElement;
    expect(button.style.backgroundColor).toBe("#123456");

    renderer.applyPatches([
      { type: "setProp", id: "btn2", name: "backgroundColor:hover.0", value: "#654321" } as Patch,
    ]);

    expect(button.style.backgroundColor).toBeFalsy();
    expect(classesOf(button)).toHaveLength(2);
  });
});
