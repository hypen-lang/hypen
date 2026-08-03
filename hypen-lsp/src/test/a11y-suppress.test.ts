/**
 * Tests for inline `// hypen-a11y-ignore` suppression in a11y.ts.
 *
 * Covers isInlineSuppressed (same-line vs previous-line placement, bare vs
 * rule-scoped form, the comment-only-previous-line constraint) and the
 * a11yDiagnostics filter (engine-marked `suppressed` and the text-side
 * fallback for stale bindings), using a fake engine so no WASM build is
 * required.
 *
 * Run with: npx tsx src/test/a11y-suppress.test.ts
 */

import { strict as assert } from "node:assert";
import {
  a11yDiagnostics,
  isInlineSuppressed,
  setEngineForTesting,
} from "../a11y";
import type { EngineA11yDiagnostic } from "../a11y";

// ---- Test runner (mirrors a11y.test.ts) ----

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

/** A finding whose name-token span starts at `start` in the text. */
function finding(
  rule: string,
  start: number,
  extra: Partial<EngineA11yDiagnostic> = {},
): EngineA11yDiagnostic {
  return {
    rule,
    elementType: "Button",
    message: "m",
    span: { start, end: start + 6 },
    ...extra,
  };
}

// ---- isInlineSuppressed ----

console.log("isInlineSuppressed tests:");

test("trailing directive on the same line suppresses", () => {
  const text = 'Column {\n    Button {} // hypen-a11y-ignore\n}';
  assert.equal(isInlineSuppressed(text, finding("missing-accessible-name", 13)), true);
});

test("directive on a comment-only previous line suppresses", () => {
  const text = 'Column {\n    // hypen-a11y-ignore\n    Button {}\n}';
  const buttonStart = text.indexOf("Button");
  assert.equal(isInlineSuppressed(text, finding("missing-accessible-name", buttonStart)), true);
});

test("rule-scoped directive suppresses only the matching rule", () => {
  const text = 'Column {\n    Button {} // hypen-a11y-ignore missing-accessible-name\n}';
  assert.equal(isInlineSuppressed(text, finding("missing-accessible-name", 13)), true);
  assert.equal(isInlineSuppressed(text, finding("nested-interactive", 13)), false);
});

test("comma-separated rule list matches every listed rule", () => {
  const text =
    'Column {\n    Button {} // hypen-a11y-ignore nested-interactive, missing-accessible-name\n}';
  assert.equal(isInlineSuppressed(text, finding("missing-accessible-name", 13)), true);
  assert.equal(isInlineSuppressed(text, finding("nested-interactive", 13)), true);
  assert.equal(isInlineSuppressed(text, finding("image-missing-alt", 13)), false);
});

test("trailing directive does not bleed into the next line", () => {
  const text = 'Column {\n    Button {} // hypen-a11y-ignore\n    Image {}\n}';
  const imageStart = text.indexOf("Image");
  assert.equal(isInlineSuppressed(text, finding("image-missing-alt", imageStart)), false);
});

test("directive token must stand alone as a word", () => {
  const text = 'Column {\n    Button {} // hypen-a11y-ignored\n}';
  assert.equal(isInlineSuppressed(text, finding("missing-accessible-name", 13)), false);
});

test("unrelated comments never suppress", () => {
  const text = 'Column {\n    // TODO: label this\n    Button {}\n}';
  const buttonStart = text.indexOf("Button");
  assert.equal(isInlineSuppressed(text, finding("missing-accessible-name", buttonStart)), false);
});

test("a finding without a span is never suppressible", () => {
  const text = "// hypen-a11y-ignore\nButton {}";
  assert.equal(
    isInlineSuppressed(text, { rule: "r", elementType: "Button", message: "m" }),
    false,
  );
});

// ---- a11yDiagnostics filtering ----

console.log("a11yDiagnostics suppression tests:");

test("engine-marked suppressed findings do not squiggle", () => {
  const text = "Column {\n    Button {}\n}";
  setEngineForTesting({
    checkAccessibility: () => [
      finding("missing-accessible-name", 13, { suppressed: true }),
      finding("nested-interactive", 0),
    ],
  });
  const diags = a11yDiagnostics(text);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, "nested-interactive");
});

test("text-side fallback suppresses when a stale binding omits the field", () => {
  const text = "Column {\n    Button {} // hypen-a11y-ignore\n}";
  setEngineForTesting({
    // Stale binding: directive present in text, no `suppressed` field.
    checkAccessibility: () => [finding("missing-accessible-name", 13)],
  });
  assert.deepEqual(a11yDiagnostics(text), []);
});

test("non-matching rule-scoped directive still squiggles", () => {
  const text = "Column {\n    Button {} // hypen-a11y-ignore image-missing-alt\n}";
  setEngineForTesting({
    checkAccessibility: () => [finding("missing-accessible-name", 13)],
  });
  const diags = a11yDiagnostics(text);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, "missing-accessible-name");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
