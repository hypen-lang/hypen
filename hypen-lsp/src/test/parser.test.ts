/**
 * Tests for parser-utils.ts
 *
 * These tests cover convertWasmValue branches and the
 * scanDiagnostics function (unclosed strings, bracket balance).
 *
 * Run with: npx tsx src/test/parser.test.ts
 */

import { strict as assert } from "node:assert";
import {
  convertWasmValue,
  scanDiagnostics,
  isInString,
  offsetToPosition,
} from "../parser-utils";
import type { ValueNode } from "../parser-utils";

// ---- Test runner ----

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

// ---- convertWasmValue tests ----

console.log("convertWasmValue tests:");

test("undefined input returns empty string", () => {
  const r = convertWasmValue(undefined);
  assert.equal(r.type, "string");
  assert.equal(r.value, "");
});

test("String value", () => {
  const r = convertWasmValue({ String: "hello" });
  assert.equal(r.type, "string");
  assert.equal(r.value, "hello");
});

test("Number value", () => {
  const r = convertWasmValue({ Number: 42 });
  assert.equal(r.type, "number");
  assert.equal(r.value, 42);
});

test("Boolean value", () => {
  const r = convertWasmValue({ Boolean: true });
  assert.equal(r.type, "boolean");
  assert.equal(r.value, true);
});

test("Reference value", () => {
  const r = convertWasmValue({ Reference: "@state.count" });
  assert.equal(r.type, "reference");
  assert.equal(r.value, "@state.count");
});

test("List value with nested types", () => {
  const r = convertWasmValue({ List: [{ String: "a" }, { Number: 1 }, undefined as any] });
  assert.equal(r.type, "list");
  const list = (r as any).value as ValueNode[];
  assert.equal(list.length, 3);
  assert.equal(list[0].type, "string");
  assert.equal(list[1].type, "number");
  assert.equal(list[2].type, "string"); // undefined → fallback
  assert.equal(list[2].value, "");
});

test("Map value with entries", () => {
  const r = convertWasmValue({ Map: { key1: { String: "val" }, key2: { Number: 99 } } });
  assert.equal(r.type, "map");
  const map = (r as any).value as Map<string, ValueNode>;
  assert.equal(map.size, 2);
  const k1 = map.get("key1")!;
  assert.equal(k1.type, "string");
  assert.equal(k1.value, "val");
  const k2 = map.get("key2")!;
  assert.equal(k2.type, "number");
  assert.equal(k2.value, 99);
});

test("empty object falls back to empty string", () => {
  const r = convertWasmValue({});
  assert.equal(r.type, "string");
  assert.equal(r.value, "");
});

// ---- scanDiagnostics tests ----

console.log("\nscanDiagnostics tests:");

test("unclosed double quote points to opening quote", () => {
  const { errors } = scanDiagnostics('Text("hello)');
  const strErr = errors.find(e => e.message === "Unclosed string literal");
  assert.ok(strErr, "should detect unclosed string");
  assert.equal(strErr!.range.start.character, 5); // position of opening "
});

test("unclosed single quote points to opening quote", () => {
  const { errors } = scanDiagnostics("Text('hello)");
  const strErr = errors.find(e => e.message === "Unclosed string literal");
  assert.ok(strErr, "should detect unclosed single-quoted string");
  assert.equal(strErr!.range.start.character, 5); // position of opening '
});

test("mixed quotes: single inside double is fine", () => {
  const { errors } = scanDiagnostics('Text("it\'s fine")');
  const strErr = errors.find(e => e.message === "Unclosed string literal");
  assert.equal(strErr, undefined, "should not report error for nested quotes");
});

test("unclosed bracket detected", () => {
  const { errors } = scanDiagnostics('List([1, 2, 3)');
  const bracketErr = errors.find(e => e.message.includes("bracket"));
  assert.ok(bracketErr, "should detect unclosed bracket");
});

test("unexpected closing bracket detected", () => {
  const { errors } = scanDiagnostics('Text(])');
  const bracketErr = errors.find(e => e.message === "Unexpected closing bracket ']'");
  assert.ok(bracketErr, "should detect unexpected ]");
});

test("balanced brackets produce no errors", () => {
  const { errors } = scanDiagnostics('List([1, 2, 3])');
  const bracketErr = errors.find(e => e.message.includes("bracket"));
  assert.equal(bracketErr, undefined, "no bracket errors expected");
});

test("delimiters inside strings are ignored", () => {
  // The { inside the string should not count as an unmatched brace
  const { errors } = scanDiagnostics('Text("hello { world")');
  const braceErr = errors.find(e => e.message.includes("brace"));
  assert.equal(braceErr, undefined, "brace inside string should not produce error");
});

test("delimiters after inline comment are ignored", () => {
  // The { after // should not count
  const { errors } = scanDiagnostics('Text("ok") // {');
  const braceErr = errors.find(e => e.message.includes("brace"));
  assert.equal(braceErr, undefined, "brace after comment should not produce error");
});

test("unclosed bracket diagnostic points to opening bracket", () => {
  const { errors } = scanDiagnostics('List([1, 2');
  const bracketErr = errors.find(e => e.message.includes("bracket"));
  assert.ok(bracketErr, "should detect unclosed bracket");
  // Should point to the '[' at character 5, not EOF
  assert.equal(bracketErr!.range.start.character, 5);
});

test("unclosed paren diagnostic points to opening paren", () => {
  const { errors } = scanDiagnostics('Text(hello');
  const parenErr = errors.find(e => e.message.includes("parenthes"));
  assert.ok(parenErr, "should detect unclosed paren");
  // Should point to the '(' at character 4
  assert.equal(parenErr!.range.start.character, 4);
});

// ---- isInString tests ----

console.log("\nisInString tests:");

test("inside double-quoted string", () => {
  assert.equal(isInString('Text("hello")', 0, 7), true);
});

test("outside string", () => {
  assert.equal(isInString('Text("hello")', 0, 2), false);
});

test("inside single-quoted string", () => {
  assert.equal(isInString("Text('hello')", 0, 7), true);
});

// ---- offsetToPosition tests ----

console.log("\noffsetToPosition tests:");

test("offset 0 is line 0, char 0", () => {
  const pos = offsetToPosition("hello\nworld", 0);
  assert.equal(pos.line, 0);
  assert.equal(pos.character, 0);
});

test("offset after newline", () => {
  const pos = offsetToPosition("hello\nworld", 7);
  assert.equal(pos.line, 1);
  assert.equal(pos.character, 1);
});

// ---- Summary ----

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
