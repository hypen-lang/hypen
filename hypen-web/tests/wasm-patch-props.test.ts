/**
 * Integration tests for WASM engine patch output
 *
 * These tests verify that the WASM engine (nodejs target) correctly includes
 * props in patches. This is a regression test for an issue where patches
 * from the nodejs target had empty props.
 *
 * Note: The WASM engine outputs camelCase field names (e.g., "elementType" not "element_type")
 * Note: Positional arguments use numeric keys ("0", "1", etc.)
 * Note: Applicators use "applicatorName.0" format for their arguments
 *
 * These tests require a built WASM engine. They are automatically skipped
 * when the WASM build is not available. To run:
 *   cd ../hypen-engine-rs && ./build-wasm.sh
 *   bun test tests/wasm-patch-props.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";

let WasmEngine: any;
let wasmAvailable = false;
try {
  const mod = require("../../hypen-engine-rs/pkg/nodejs/hypen_engine.js");
  WasmEngine = mod.WasmEngine;
  wasmAvailable = typeof WasmEngine === "function";
} catch {
  // WASM build not available
}

const describeFn = wasmAvailable ? describe : describe.skip;

describeFn("WASM Engine Patch Props (integration)", () => {
  let engine: any;
  let patches: any[];

  beforeEach(() => {
    engine = new WasmEngine();
    patches = [];
    engine.setRenderCallback((p: any[]) => {
      patches.push(...p);
    });
  });

  test("create patches include props for Text component with positional arguments", () => {
    engine.renderSource('Text("Hello World")');

    const createPatches = patches.filter((p) => p.type === "create");
    expect(createPatches.length).toBeGreaterThan(0);

    // Note: WASM uses snake_case "element_type" not camelCase "elementType"
    const textPatch = createPatches.find((p) => p.elementType === "Text");
    expect(textPatch).toBeDefined();
    expect(textPatch.props).toBeDefined();
    expect(typeof textPatch.props).toBe("object");
    // Positional arguments use "0", "1", etc. as keys
    // This is the key assertion - props should NOT be empty
    expect(Object.keys(textPatch.props).length).toBeGreaterThan(0);
    expect(textPatch.props["0"]).toBe("Hello World");
  });

  test("create patches include props for component with named arguments", () => {
    engine.renderSource('Text(text: "Greeting", color: red)');

    const createPatches = patches.filter((p) => p.type === "create");
    const textPatch = createPatches.find((p) => p.elementType === "Text");

    expect(textPatch).toBeDefined();
    expect(textPatch.props).toBeDefined();
    expect(Object.keys(textPatch.props).length).toBeGreaterThan(0);
    expect(textPatch.props.text).toBe("Greeting");
    expect(textPatch.props.color).toBe("red");
  });

  test("create patches include props for component with numeric arguments", () => {
    engine.renderSource("Box(width: 100, height: 50.5)");

    const createPatches = patches.filter((p) => p.type === "create");
    const boxPatch = createPatches.find((p) => p.elementType === "Box");

    expect(boxPatch).toBeDefined();
    expect(boxPatch.props).toBeDefined();
    expect(Object.keys(boxPatch.props).length).toBeGreaterThan(0);
    expect(boxPatch.props.width).toBe(100);
    expect(boxPatch.props.height).toBe(50.5);
  });

  test("create patches include props for component with boolean arguments", () => {
    engine.renderSource("Button(enabled: true, visible: false)");

    const createPatches = patches.filter((p) => p.type === "create");
    const buttonPatch = createPatches.find((p) => p.elementType === "Button");

    expect(buttonPatch).toBeDefined();
    expect(buttonPatch.props).toBeDefined();
    expect(Object.keys(buttonPatch.props).length).toBeGreaterThan(0);
    expect(buttonPatch.props.enabled).toBe(true);
    expect(buttonPatch.props.visible).toBe(false);
  });

  test("create patches include props for component with list arguments", () => {
    engine.renderSource('Row(items: ["a", "b", "c"])');

    const createPatches = patches.filter((p) => p.type === "create");
    const rowPatch = createPatches.find((p) => p.elementType === "Row");

    expect(rowPatch).toBeDefined();
    expect(rowPatch.props).toBeDefined();
    expect(Object.keys(rowPatch.props).length).toBeGreaterThan(0);
    expect(rowPatch.props.items).toEqual(["a", "b", "c"]);
  });

  test("create patches include props for component with map arguments", () => {
    engine.renderSource("Card(config: {width: 100, height: 200})");

    const createPatches = patches.filter((p) => p.type === "create");
    const cardPatch = createPatches.find((p) => p.elementType === "Card");

    expect(cardPatch).toBeDefined();
    expect(cardPatch.props).toBeDefined();
    expect(Object.keys(cardPatch.props).length).toBeGreaterThan(0);
    expect(cardPatch.props.config).toEqual({ width: 100, height: 200 });
  });

  test("create patches include props from applicators", () => {
    engine.renderSource('Text("Hello").padding(16).backgroundColor(blue)');

    const createPatches = patches.filter((p) => p.type === "create");
    const textPatch = createPatches.find((p) => p.elementType === "Text");

    expect(textPatch).toBeDefined();
    expect(textPatch.props).toBeDefined();
    expect(Object.keys(textPatch.props).length).toBeGreaterThan(0);
    // Positional arg is "0"
    expect(textPatch.props["0"]).toBe("Hello");
    // Applicators use "applicatorName.0" format
    expect(textPatch.props["padding.0"]).toBe(16);
    expect(textPatch.props["backgroundColor.0"]).toBe("blue");
  });

  test("nested components all have props in their create patches", () => {
    engine.renderSource(`
      Column {
        Text("First")
        Text("Second")
      }
    `);

    const createPatches = patches.filter((p) => p.type === "create");

    const columnPatch = createPatches.find((p) => p.elementType === "Column");
    expect(columnPatch).toBeDefined();
    expect(columnPatch.props).toBeDefined();

    const textPatches = createPatches.filter((p) => p.elementType === "Text");
    expect(textPatches.length).toBe(2);

    for (const textPatch of textPatches) {
      expect(textPatch.props).toBeDefined();
      expect(typeof textPatch.props).toBe("object");
      // Text patches should have props (positional arg "0")
      expect(Object.keys(textPatch.props).length).toBeGreaterThan(0);
    }

    // Verify the text props are correct (using "0" key for positional args)
    const texts = textPatches.map((p) => p.props["0"]);
    expect(texts).toContain("First");
    expect(texts).toContain("Second");
  });

  test("props object is not null or undefined for component without args", () => {
    engine.renderSource("Column {}");

    const createPatches = patches.filter((p) => p.type === "create");
    const columnPatch = createPatches.find((p) => p.elementType === "Column");

    expect(columnPatch).toBeDefined();
    expect(columnPatch.props).not.toBeNull();
    expect(columnPatch.props).not.toBeUndefined();
    expect(typeof columnPatch.props).toBe("object");
  });

  test("props from state bindings are resolved", () => {
    // Set up module with initial state
    engine.setModule("Test", [], ["message"], { message: "Hello from state" });

    engine.renderSource('Text("@{state.message}")');

    const createPatches = patches.filter((p) => p.type === "create");
    const textPatch = createPatches.find((p) => p.elementType === "Text");

    expect(textPatch).toBeDefined();
    expect(textPatch.props).toBeDefined();
    expect(Object.keys(textPatch.props).length).toBeGreaterThan(0);
    // State binding is resolved and stored in "0" (positional arg)
    expect(textPatch.props["0"]).toBe("Hello from state");
  });

  test("complex nested structure with multiple prop types", () => {
    engine.renderSource(`
      Column {
        Row(gap: 8) {
          Text("Label").color(gray)
          Button(text: "Click", enabled: true, count: 42)
        }
        Image(src: "image.png", width: 200, height: 150)
      }
    `);

    const createPatches = patches.filter((p) => p.type === "create");

    // Verify all components have props
    for (const patch of createPatches) {
      expect(patch.props).toBeDefined();
      expect(typeof patch.props).toBe("object");
    }

    // Verify specific props
    const rowPatch = createPatches.find((p) => p.elementType === "Row");
    expect(rowPatch?.props.gap).toBe(8);

    const buttonPatch = createPatches.find((p) => p.elementType === "Button");
    expect(buttonPatch?.props.text).toBe("Click");
    expect(buttonPatch?.props.enabled).toBe(true);
    expect(buttonPatch?.props.count).toBe(42);

    const imagePatch = createPatches.find((p) => p.elementType === "Image");
    expect(imagePatch?.props.src).toBe("image.png");
    expect(imagePatch?.props.width).toBe(200);
    expect(imagePatch?.props.height).toBe(150);
  });
});
