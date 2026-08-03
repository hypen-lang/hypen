import { describe, expect, test, beforeEach } from "bun:test";
import { ApplicatorRegistry } from "../packages/web/src/dom/applicators";
import { ensureFakeDomGlobals, FakeElement } from "./fake-dom";

// Set up fake DOM globals before tests
ensureFakeDomGlobals();

describe("Variant handling - responsive variants", () => {
  let registry: ApplicatorRegistry;
  let element: HTMLElement;

  beforeEach(() => {
    registry = new ApplicatorRegistry();
    element = document.createElement("div") as unknown as HTMLElement;
  });

  test("responsive variant adds class containing breakpoint", () => {
    // Apply responsive variant property
    registry.apply(element, "padding@md", "2rem");

    const fakeElement = element as unknown as FakeElement;

    // Element should have a class containing the breakpoint
    expect(fakeElement.classList.toString()).toContain("hypen-padding-md");
  });

  test("all breakpoints create appropriate classes", () => {
    const breakpoints = ["sm", "md", "lg", "xl", "2xl"];

    for (const bp of breakpoints) {
      const el = document.createElement("div") as unknown as HTMLElement;
      registry.apply(el, `width@${bp}`, "100%");

      const fakeEl = el as unknown as FakeElement;
      expect(fakeEl.classList.toString()).toContain(`hypen-width-${bp}`);
    }
  });

  test("numeric values are handled in responsive variants", () => {
    registry.apply(element, "padding@md", 32);

    const fakeElement = element as unknown as FakeElement;
    expect(fakeElement.classList.toString()).toContain("hypen-padding-md");
  });

  test("unitless properties work in responsive variants", () => {
    registry.apply(element, "opacity@md", 0.5);

    const fakeElement = element as unknown as FakeElement;
    expect(fakeElement.classList.toString()).toContain("hypen-opacity-md");
  });

  test("multiple responsive variants on same element", () => {
    registry.apply(element, "width@sm", "100%");
    registry.apply(element, "width@md", "50%");
    registry.apply(element, "width@lg", "33%");

    const fakeElement = element as unknown as FakeElement;
    const classList = fakeElement.classList.toString();

    expect(classList).toContain("hypen-width-sm");
    expect(classList).toContain("hypen-width-md");
    expect(classList).toContain("hypen-width-lg");
  });
});

describe("Variant handling - state variants", () => {
  let registry: ApplicatorRegistry;
  let element: HTMLElement;

  beforeEach(() => {
    registry = new ApplicatorRegistry();
    element = document.createElement("div") as unknown as HTMLElement;
  });

  test("hover state variant adds class with pseudo-selector", () => {
    registry.apply(element, "background-color:hover", "#ffffff");

    const fakeElement = element as unknown as FakeElement;
    expect(fakeElement.classList.toString()).toContain("hypen-background-color-hover");
  });

  test("focus state variant adds appropriate class", () => {
    registry.apply(element, "border-color:focus", "blue");

    const fakeElement = element as unknown as FakeElement;
    expect(fakeElement.classList.toString()).toContain("hypen-border-color-focus");
  });

  test("active state variant adds appropriate class", () => {
    registry.apply(element, "transform:active", "scale(0.95)");

    const fakeElement = element as unknown as FakeElement;
    expect(fakeElement.classList.toString()).toContain("hypen-transform-active");
  });

  test("disabled state variant adds appropriate class", () => {
    registry.apply(element, "opacity:disabled", "0.5");

    const fakeElement = element as unknown as FakeElement;
    expect(fakeElement.classList.toString()).toContain("hypen-opacity-disabled");
  });

  test("focus-visible state variant adds appropriate class", () => {
    registry.apply(element, "outline:focus-visible", "2px solid blue");

    const fakeElement = element as unknown as FakeElement;
    expect(fakeElement.classList.toString()).toContain("hypen-outline-focus-visible");
  });

  test("focus-within state variant adds appropriate class", () => {
    registry.apply(element, "border-color:focus-within", "blue");

    const fakeElement = element as unknown as FakeElement;
    expect(fakeElement.classList.toString()).toContain("hypen-border-color-focus-within");
  });
});

describe("Variant handling - combined and edge cases", () => {
  let registry: ApplicatorRegistry;
  let element: HTMLElement;

  beforeEach(() => {
    registry = new ApplicatorRegistry();
    element = document.createElement("div") as unknown as HTMLElement;
  });

  test("element can have both base styles and variant classes", () => {
    // Apply base style
    registry.apply(element, "padding", 16);
    // Use standard DOM API - getPropertyValue or direct property access
    expect(element.style.padding).toBe("16px");

    // Apply responsive variant
    registry.apply(element, "padding@md", 24);
    expect(element.classList.toString()).toContain("hypen-padding-md");

    // Apply state variant
    registry.apply(element, "background-color:hover", "#f0f0f0");
    expect(element.classList.toString()).toContain("hypen-background-color-hover");
  });

  test("camelCase properties are converted to kebab-case in class names", () => {
    registry.apply(element, "backgroundColor@md", "#ffffff");

    const fakeElement = element as unknown as FakeElement;
    // Class should use kebab-case
    expect(fakeElement.classList.toString()).toContain("hypen-background-color-md");
  });

  test("invalid breakpoint is ignored", () => {
    registry.apply(element, "padding@invalid", "16px");

    // Should not add any class
    expect(element.classList.toString()).toBe("");
    // Should not add inline style either (empty string in jsdom, undefined in fake-dom)
    expect(element.style.padding).toBeFalsy();
  });

  test("invalid state is ignored", () => {
    const fakeElement = element as unknown as FakeElement;

    registry.apply(element, "padding:invalid", "16px");

    // Should not add any class
    expect(fakeElement.classList.toString()).toBe("");
  });

  test("same class is not duplicated on element", () => {
    // Apply the same variant twice
    registry.apply(element, "padding@md", "2rem");
    registry.apply(element, "padding@md", "2rem");

    const fakeElement = element as unknown as FakeElement;
    const classList = fakeElement.classList.toString();

    // Should only have one instance of the class
    const matches = classList.match(/hypen-padding-md/g) || [];
    expect(matches.length).toBe(1);
  });

  test("same property with different values creates separate classes", () => {
    registry.apply(element, "padding@md", "1rem");

    const el2 = document.createElement("div") as unknown as HTMLElement;
    registry.apply(el2, "padding@md", "2rem");

    const fakeElement1 = element as unknown as FakeElement;
    const fakeElement2 = el2 as unknown as FakeElement;

    // Each should have a unique class based on value
    const class1 = fakeElement1.classList.toString();
    const class2 = fakeElement2.classList.toString();

    // Both should contain hypen-padding-md but with different hash suffixes
    expect(class1).toContain("hypen-padding-md");
    expect(class2).toContain("hypen-padding-md");

    // The full class names should be different due to different value hashes
    // (assuming hash includes the value)
    expect(class1).not.toBe(class2);
  });

  test("registered handlers take precedence over variant detection", () => {
    // Test that a property with a registered handler (like padding) still works
    // for base styles while variant syntax triggers the variant logic

    // Base padding should use the handler
    registry.apply(element, "padding", 16);
    expect(element.style.padding).toBe("16px");

    // Variant padding should create a class
    registry.apply(element, "padding@lg", 32);
    expect(element.classList.toString()).toContain("hypen-padding-lg");
  });
});

describe("Variant handling - combined @bp:state variants", () => {
  let registry: ApplicatorRegistry;
  let element: HTMLElement;

  beforeEach(() => {
    registry = new ApplicatorRegistry();
    element = document.createElement("div") as unknown as HTMLElement;
  });

  test("combined variant adds a class (previously dropped)", () => {
    // Before the fix the '@' branch sliced breakpoint="md:hover", failed the
    // BREAKPOINTS lookup, and added no class at all.
    registry.apply(element, "backgroundColor@md:hover", "#fff");
    const fakeElement = element as unknown as FakeElement;
    expect(fakeElement.classList.toString()).toContain("hypen-background-color-md-hover");
  });

  test("combined variant with invalid breakpoint or state adds nothing", () => {
    registry.apply(element, "backgroundColor@bogus:hover", "#fff");
    registry.apply(element, "backgroundColor@md:bogus", "#fff");
    const fakeElement = element as unknown as FakeElement;
    expect(fakeElement.classList.toString()).not.toContain("bogus");
  });
});
