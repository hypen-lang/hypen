/**
 * Tests for tailwind.ts — `.tw("...")` positioning diagnostics.
 *
 * Run with: npx tsx src/test/tailwind.test.ts
 */

import { strict as assert } from "node:assert";
import { forbiddenTailwindClassReason, tailwindDiagnostics, TW_POSITIONING_CODE } from "../tailwind";

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

console.log("forbiddenTailwindClassReason");

test("flags position and inset utilities in every spelling", () => {
  for (const cls of [
    "absolute", "relative", "fixed", "sticky", "static",
    "top-0", "right-2", "bottom-1/2", "left-[10px]", "-top-1", "inset-0", "inset-x-4",
    "md:absolute", "hover:relative", "!absolute", "md:hover:-left-2", "sr-only",
  ]) {
    assert.ok(forbiddenTailwindClassReason(cls), `${cls} should be forbidden`);
  }
});

test("leaves ordinary classes alone", () => {
  for (const cls of ["p-4", "z-10", "-mt-1", "md:flex", "rounded-t-lg", "bg-[url(a:b)]", "text-left", "items-end"]) {
    assert.equal(forbiddenTailwindClassReason(cls), null, `${cls} should be allowed`);
  }
});

console.log("tailwindDiagnostics");

test("squiggles exactly the offending token with the right range", () => {
  const text = `Column {\n    Text("x")\n}\n.tw("p-4 absolute top-0")`;
  const diags = tailwindDiagnostics(text);
  assert.equal(diags.length, 2);
  assert.equal(diags[0].code, TW_POSITIONING_CODE);
  assert.deepEqual(diags[0].range, { start: { line: 3, character: 9 }, end: { line: 3, character: 17 } });
  assert.deepEqual(diags[1].range, { start: { line: 3, character: 18 }, end: { line: 3, character: 23 } });
  assert.match(diags[0].message, /Stack/);
});

test("handles single quotes and multiple .tw calls", () => {
  const text = `Row {}.tw('flex relative')\nBox {}.tw("p-2")\nBox {}.tw(  "inset-0" )`;
  const diags = tailwindDiagnostics(text);
  assert.equal(diags.length, 2);
  assert.equal(diags[0].range.start.line, 0);
  assert.equal(diags[1].range.start.line, 2);
});

test("is silent on clean input", () => {
  assert.equal(tailwindDiagnostics(`Row {}.tw("flex items-center gap-2 z-10")`).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
