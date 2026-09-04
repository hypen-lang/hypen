/**
 * Integration tests: WASM engine patch field names must be camelCase.
 *
 * Regression test for: patches arrived with snake_case field names
 * (element_type, parent_id, before_id) because the Rust `Patch` enum had
 * `#[serde(rename_all = "camelCase")]` only on the enum (which renames the
 * tag value), not on individual struct variants (which renames field names).
 *
 * These tests require a built WASM engine. They are automatically skipped
 * when the WASM build is not available. To run:
 *   cd ../hypen-engine-rs && ./build-wasm.sh
 *   bun test tests/wasm-camelcase.test.ts
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

describeFn("WASM Patch camelCase field names (integration)", () => {
  let engine: any;
  let patches: any[];

  beforeEach(() => {
    engine = new WasmEngine();
    patches = [];
    // Raw boundary contract: the engine hands the batch over as one JSON
    // string (the SDK's engine-base parses it before consumers see it).
    engine.setRenderCallback((p: any[] | string) => {
      patches.push(...(typeof p === "string" ? JSON.parse(p) : p));
    });
  });

  test("create patches use 'elementType' not 'element_type'", () => {
    engine.renderSource('Column { Text("Hello") }');

    const creates = patches.filter((p) => p.type === "create");
    expect(creates.length).toBeGreaterThan(0);

    for (const patch of creates) {
      expect(patch.elementType).toBeDefined();
      expect(patch.element_type).toBeUndefined();
    }

    const col = creates.find((p) => p.elementType === "Column");
    expect(col).toBeDefined();

    const txt = creates.find((p) => p.elementType === "Text");
    expect(txt).toBeDefined();
    expect(txt.props["0"]).toBe("Hello");
  });

  test("insert patches use 'parentId' and 'beforeId' not snake_case", () => {
    engine.renderSource('Column { Text("A") Text("B") }');

    const inserts = patches.filter((p) => p.type === "insert");
    expect(inserts.length).toBeGreaterThan(0);

    for (const patch of inserts) {
      // Must have camelCase fields
      expect("parentId" in patch).toBe(true);
      expect("beforeId" in patch).toBe(true);

      // Must NOT have snake_case fields
      expect("parent_id" in patch).toBe(false);
      expect("before_id" in patch).toBe(false);
    }
  });

  test("move patches use camelCase field names", () => {
    // Render a list, then modify it to trigger move patches
    engine.setModule("Test", [], ["items"], { items: ["a", "b", "c"] });
    engine.renderSource(`
      Column {
        Text("${"\u0024"}{state.items}")
      }
    `);

    // Clear and re-render with reordered items to potentially trigger moves
    const beforePatches = [...patches];
    patches.length = 0;

    engine.updateState("", { items: ["c", "b", "a"] });

    // Check any move patches that may have been emitted
    const moves = patches.filter((p) => p.type === "move");
    for (const patch of moves) {
      expect("parentId" in patch).toBe(true);
      expect("beforeId" in patch).toBe(true);
      expect("parent_id" in patch).toBe(false);
      expect("before_id" in patch).toBe(false);
    }
  });

  test("all patch types have the correct 'type' tag values (camelCase)", () => {
    engine.renderSource('Column { Text("Hello") }');

    // The tag values should be camelCase (e.g. "setProp", "setText")
    const types = new Set(patches.map((p) => p.type));

    // create and insert are the same in camelCase and lowercase
    expect(types.has("create")).toBe(true);
    expect(types.has("insert")).toBe(true);

    // Verify no snake_case tag values leaked through
    for (const t of types) {
      expect(t).not.toContain("_");
    }
  });

  test("setProp patches use camelCase field names", () => {
    engine.setModule("Test", [], ["count"], { count: 0 });
    engine.renderSource('Text("Count: @{state.count}")');

    patches.length = 0;
    engine.updateState("", { count: 42 });

    const setProps = patches.filter((p) => p.type === "setProp");
    for (const patch of setProps) {
      expect(patch.id).toBeDefined();
      expect(typeof patch.id).toBe("string");
    }
  });

  test("no patch object contains snake_case keys", () => {
    engine.renderSource(`
      Column {
        Text("Hello")
        Row {
          Text("World")
        }
      }
    `);

    const snakeCaseFields = ["element_type", "parent_id", "before_id", "event_name"];

    for (const patch of patches) {
      const keys = Object.keys(patch);
      for (const field of snakeCaseFields) {
        expect(keys).not.toContain(field);
      }
    }
  });
});
