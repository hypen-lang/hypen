/**
 * WASM-parser diagnostics: error ranges come from the parser's byte spans
 * and must land on the offending token, also after non-ASCII text.
 *
 * Needs the parser WASM (`npm run build:wasm && npm run setup:wasm`, or
 * `cd ../parser && ./build-wasm.sh`); skipped when it is not built.
 *
 * Run with: npx tsx src/test/wasm-diagnostics.test.ts
 */

import { strict as assert } from "node:assert";
import { byteOffsetToPosition } from "../parser-utils";
import { initWasmParser, isWasmParserAvailable, parseHypenDocument } from "../parser";

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

console.log("byteOffsetToPosition tests:");

test("ASCII offsets are unchanged", () => {
  assert.deepEqual(byteOffsetToPosition("ab\ncd", 4), { line: 1, character: 1 });
});

test("multi-byte characters count once (UTF-16 units), not per byte", () => {
  // 'é' is 2 bytes, '→' 3 bytes; ';' is at byte 9.
  assert.deepEqual(byteOffsetToPosition("é → ;", 7), { line: 0, character: 4 });
  // '🎉' is 4 bytes and 2 UTF-16 units.
  assert.deepEqual(byteOffsetToPosition('Text("🎉" ;)', 12), { line: 0, character: 10 });
});

async function main() {
  await initWasmParser();
  if (!isWasmParserAvailable()) {
    console.log("\nWASM parser not built: skipping WASM diagnostics tests");
  } else {
    console.log("\nWASM diagnostics tests:");

    const firstError = (src: string) => {
      const result = parseHypenDocument(src);
      assert.ok(result.errors.length > 0, "expected a parse error");
      return result.errors[0]!;
    };

    test("stray brace is reported at the brace, not the enclosing block", () => {
      const e = firstError("module Home {\n  Column {{{\n}");
      assert.deepEqual(e.range.start, { line: 1, character: 10 });
      assert.deepEqual(e.range.end, { line: 1, character: 11 });
      assert.equal(e.message, "expected component or '}', found '{'");
    });

    test("error after non-ASCII text on the same line", () => {
      const e = firstError('module Home {\n  Text("é → ü") ;\n}');
      assert.deepEqual(e.range.start, { line: 1, character: 16 });
      assert.match(e.message, /found ';'$/);
    });

    test("unclosed string points at its opening quote", () => {
      const e = firstError('module Home {\n  Text("日本 →)\n}');
      assert.deepEqual(e.range.start, { line: 1, character: 7 });
      assert.match(e.message, /^unclosed string literal/);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
