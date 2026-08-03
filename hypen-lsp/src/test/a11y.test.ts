/**
 * Tests for a11y.ts — accessibility conformance diagnostics.
 *
 * Covers byteOffsetToPosition (UTF-8 byte → 0-based line / UTF-16 column)
 * and a11yDiagnostics mapping (range, severity, source, code), using a fake
 * engine so no WASM build is required. A final section exercises the real
 * engine WASM when the `wasm-engine/` symlink resolves.
 *
 * Run with: npx tsx src/test/a11y.test.ts
 */

import { strict as assert } from "node:assert";
import {
  a11yDiagnostics,
  byteOffsetToPosition,
  initWasmEngine,
  isWasmEngineAvailable,
  setEngineForTesting,
} from "../a11y";
import type { EngineA11yDiagnostic } from "../a11y";

// ---- Test runner (mirrors parser.test.ts) ----

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(
        () => {
          passed++;
          console.log(`  ✓ ${name}`);
        },
        (e: any) => {
          failed++;
          console.log(`  ✗ ${name}`);
          console.log(`    ${e.message}`);
        },
      );
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ---- byteOffsetToPosition ----

console.log("byteOffsetToPosition tests:");

test("origin", () => {
  assert.deepEqual(byteOffsetToPosition("Button", 0), { line: 0, character: 0 });
});

test("ascii offsets map 1:1", () => {
  const text = "Column {\n    Button\n}";
  // Byte 13 is the 'B' of Button: line 1 (0-based), character 4.
  assert.deepEqual(byteOffsetToPosition(text, 13), { line: 1, character: 4 });
});

test("multi-byte char before token: UTF-8 bytes != UTF-16 units", () => {
  // "é" = 2 UTF-8 bytes, 1 UTF-16 unit. "X" starts at byte 2, character 1.
  assert.deepEqual(byteOffsetToPosition("éX", 2), { line: 0, character: 1 });
});

test("non-BMP char counts 2 UTF-16 units", () => {
  // "𝄞" (U+1D11E) = 4 UTF-8 bytes, 2 UTF-16 units (surrogate pair).
  assert.deepEqual(byteOffsetToPosition("𝄞X", 4), { line: 0, character: 2 });
});

test("newlines reset the character counter", () => {
  const text = 'Text("héllo")\nButton';
  // `Text("héllo")` = 14 UTF-8 bytes (é is 2), newline at 14 → "Button"
  // starts at byte 15: line 1, character 0.
  const buttonByte = 15;
  assert.deepEqual(byteOffsetToPosition(text, buttonByte), { line: 1, character: 0 });
});

test("past-the-end clamps to final position", () => {
  assert.deepEqual(byteOffsetToPosition("ab", 99), { line: 0, character: 2 });
});

// ---- a11yDiagnostics with a fake engine ----

console.log("a11yDiagnostics tests:");

test("no engine → no diagnostics", () => {
  setEngineForTesting(null);
  assert.deepEqual(a11yDiagnostics("Button {}"), []);
});

test("maps findings to ranges, severity, source, and code", () => {
  const text = "Column {\n    Button {}\n}";
  const findings: EngineA11yDiagnostic[] = [
    {
      rule: "missing-accessible-name",
      elementType: "Button",
      message: "interactive Button has no accessible name",
      span: { start: 13, end: 19 }, // the Button token
    },
    {
      rule: "nested-interactive",
      elementType: "Link",
      message: "nested",
      span: { start: 0, end: 6 },
    },
    {
      rule: "heading-missing-level",
      elementType: "Heading",
      message: "no level",
      span: { start: 0, end: 6 },
    },
  ];
  setEngineForTesting({ checkAccessibility: () => findings });

  const diags = a11yDiagnostics(text);
  assert.equal(diags.length, 3);

  // Underlines the Button token: line 1, chars 4..10 (0-based, UTF-16).
  assert.deepEqual(diags[0].range, {
    start: { line: 1, character: 4 },
    end: { line: 1, character: 10 },
  });
  assert.equal(diags[0].source, "hypen-a11y");
  assert.equal(diags[0].code, "missing-accessible-name");
  assert.equal(diags[0].severity, 2); // Warning
  assert.equal(diags[1].severity, 1); // Error (nested-interactive)
  assert.equal(diags[2].severity, 3); // Information (heading-missing-level)
});

test("engine throw (syntax error) → no diagnostics, no crash", () => {
  setEngineForTesting({
    checkAccessibility: () => {
      throw new Error("parseError");
    },
  });
  assert.deepEqual(a11yDiagnostics("Button((("), []);
});

test("finding without a span anchors at the document origin", () => {
  setEngineForTesting({
    checkAccessibility: () => [
      { rule: "image-missing-alt", elementType: "Image", message: "m" },
    ],
  });
  const [d] = a11yDiagnostics("Image {}");
  assert.deepEqual(d.range.start, { line: 0, character: 0 });
});

// ---- Real engine WASM (when built) ----

(async () => {
  console.log("real engine WASM tests:");
  setEngineForTesting(null as any);
  // Reset the load-attempt latch by re-importing is not possible here, so
  // call initWasmEngine on a fresh process state: this file is the only
  // consumer, and setEngineForTesting latched the attempt flag. Work around
  // by requiring the module fresh via the public init path first.
  // (initWasmEngine returns false because the latch is set — so instead
  // exercise the real engine directly.)
  try {
    const wasmModule = await import("../../wasm-engine/hypen_engine.js");
    const real = new (wasmModule as any).WasmEngine();
    setEngineForTesting(real);
    await test("real engine flags an unlabeled image with a correct range", () => {
      const text = 'Column {\n    Image(src: "/a.png")\n}';
      const diags = a11yDiagnostics(text);
      assert.equal(diags.length, 1);
      assert.equal(diags[0].code, "image-missing-alt");
      assert.deepEqual(diags[0].range, {
        start: { line: 1, character: 4 },
        end: { line: 1, character: 9 },
      });
    });
  } catch {
    console.log("  (skipped — wasm-engine/ not built)");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
