/**
 * Tests for quickfix.ts — a11y quick-fix edit computation.
 *
 * Pure text-in / edit-out, no LSP connection or WASM required. Each case
 * anchors the diagnostic at the element name token (as the engine does) and
 * asserts both the raw edit and the text produced by applying it.
 *
 * Run with: npx tsx src/test/quickfix.test.ts
 */

import { strict as assert } from "node:assert";
import {
  computeQuickFix,
  findExpressionEnd,
  positionToOffset,
} from "../quickfix";
import type { QuickFixEdit } from "../quickfix";

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

/** Anchor a diagnostic at the first occurrence of `token` in `text`. */
function fixAt(text: string, token: string, code: string): QuickFixEdit | null {
  const start = text.indexOf(token);
  assert.notEqual(start, -1, `token ${token} not found in fixture`);
  return computeQuickFix(text, {
    code,
    startOffset: start,
    endOffset: start + token.length,
  });
}

function apply(text: string, edit: QuickFixEdit): string {
  return (
    text.slice(0, edit.insertOffset) +
    edit.newText +
    text.slice(edit.insertOffset)
  );
}

// ---- .label("") insertion ----

console.log("label quick-fix tests:");

test("after an argument list", () => {
  const text = 'Column {\n    Button(onClick: @actions.go)\n}';
  const fix = fixAt(text, "Button", "missing-accessible-name")!;
  assert.equal(fix.newText, '.label("")');
  assert.equal(
    apply(text, fix),
    'Column {\n    Button(onClick: @actions.go).label("")\n}',
  );
});

test("after a children block", () => {
  const text = 'Button {\n    Icon(name: "gear")\n}\nText("after")';
  const fix = fixAt(text, "Button", "missing-accessible-name")!;
  assert.equal(
    apply(text, fix),
    'Button {\n    Icon(name: "gear")\n}.label("")\nText("after")',
  );
});

test("after args AND children block", () => {
  const text = 'Button(kind: "ghost") { Icon(name: "x") }\n';
  const fix = fixAt(text, "Button", "missing-accessible-name")!;
  assert.equal(
    apply(text, fix),
    'Button(kind: "ghost") { Icon(name: "x") }.label("")\n',
  );
});

test("after an existing applicator chain", () => {
  const text =
    'Button {}\n    .padding(12)\n    .onClick(@actions.go)\nText("next")';
  const fix = fixAt(text, "Button", "missing-accessible-name")!;
  assert.equal(
    apply(text, fix),
    'Button {}\n    .padding(12)\n    .onClick(@actions.go).label("")\nText("next")',
  );
});

test("form-control-missing-label uses the same insertion", () => {
  const text = 'Input(placeholder: "Search")\n    .bind(@state.query)';
  const fix = fixAt(text, "Input", "form-control-missing-label")!;
  assert.equal(
    apply(text, fix),
    'Input(placeholder: "Search")\n    .bind(@state.query).label("")',
  );
});

test("bare element with no args, children, or applicators", () => {
  const text = "Row {\n    Slider\n}";
  const fix = fixAt(text, "Slider", "form-control-missing-label")!;
  assert.equal(apply(text, fix), 'Row {\n    Slider.label("")\n}');
});

test("braces and parens inside strings do not derail the scan", () => {
  const text = 'Button { Text(")}") }\nText("after")';
  const fix = fixAt(text, "Button", "missing-accessible-name")!;
  assert.equal(
    apply(text, fix),
    'Button { Text(")}") }.label("")\nText("after")',
  );
});

test("line comments between applicators stay inside the expression", () => {
  const text = "Button {}\n    // primary action\n    .padding(4)\nSpacer";
  const fix = fixAt(text, "Button", "missing-accessible-name")!;
  assert.equal(
    apply(text, fix),
    'Button {}\n    // primary action\n    .padding(4).label("")\nSpacer',
  );
});

test("a following element is not swallowed as chain", () => {
  const text = "Button {}\nText(\"sibling\")";
  const fix = fixAt(text, "Button", "missing-accessible-name")!;
  assert.equal(apply(text, fix), 'Button {}.label("")\nText("sibling")');
});

// ---- alt: "" insertion ----

console.log("alt quick-fix tests:");

test("with existing args: prepends alt", () => {
  const text = 'Image(src: "/a.png")';
  const fix = fixAt(text, "Image", "image-missing-alt")!;
  assert.equal(apply(text, fix), 'Image(alt: "", src: "/a.png")');
});

test("without parens: creates the argument list", () => {
  const text = "Column {\n    Image\n}";
  const fix = fixAt(text, "Image", "image-missing-alt")!;
  assert.equal(apply(text, fix), 'Column {\n    Image(alt: "")\n}');
});

test("without parens but with children: list goes before the block", () => {
  const text = "Image {}";
  const fix = fixAt(text, "Image", "image-missing-alt")!;
  assert.equal(apply(text, fix), 'Image(alt: "") {}');
});

test("empty parens: fills them without a trailing comma", () => {
  const text = "Image()";
  const fix = fixAt(text, "Image", "image-missing-alt")!;
  assert.equal(apply(text, fix), 'Image(alt: "")');
});

// ---- level: 1 insertion ----

console.log("level quick-fix tests:");

test("with existing args", () => {
  const text = 'Heading("Dashboard")';
  const fix = fixAt(text, "Heading", "heading-missing-level")!;
  assert.equal(apply(text, fix), 'Heading(level: 1, "Dashboard")');
});

test("without parens", () => {
  const text = "Heading";
  const fix = fixAt(text, "Heading", "heading-missing-level")!;
  assert.equal(apply(text, fix), "Heading(level: 1)");
});

// ---- inputs, anchoring, and negatives ----

console.log("input handling tests:");

test("unknown code → no action", () => {
  assert.equal(fixAt("Button {}", "Button", "nested-interactive"), null);
  assert.equal(fixAt("Button {}", "Button", "some-future-rule"), null);
});

test("range input resolves through positionToOffset", () => {
  const text = 'Column {\n    Image(src: "/a.png")\n}';
  const fix = computeQuickFix(text, {
    code: "image-missing-alt",
    range: {
      start: { line: 1, character: 4 },
      end: { line: 1, character: 9 },
    },
  })!;
  assert.equal(apply(text, fix), 'Column {\n    Image(alt: "", src: "/a.png")\n}');
});

test("offset out of bounds → no action, no crash", () => {
  assert.equal(
    computeQuickFix("Button", {
      code: "missing-accessible-name",
      endOffset: 999,
    }),
    null,
  );
});

test("unbalanced source clamps instead of throwing", () => {
  const text = "Button {\n    Text(";
  const fix = fixAt(text, "Button", "missing-accessible-name")!;
  assert.equal(fix.insertOffset, text.length);
});

// ---- findExpressionEnd / positionToOffset primitives ----

console.log("primitive tests:");

test("findExpressionEnd on a bare name", () => {
  assert.equal(findExpressionEnd("Spacer\n", 6), 6);
});

test("findExpressionEnd stops at a dot without a call", () => {
  // A trailing `.foo` with no parens is not consumed (conservative stop).
  const text = "Button {}\n.5";
  assert.equal(findExpressionEnd(text, 6), 9);
});

test("positionToOffset clamps past-the-end lines and columns", () => {
  assert.equal(positionToOffset("ab\ncd", { line: 9, character: 0 }), 5);
  assert.equal(positionToOffset("ab\ncd", { line: 1, character: 99 }), 5);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
