/**
 * Drift guard: every engine primitive (`DEFAULT_PRIMITIVES` in
 * hypen-engine-rs/src/ir/component.rs) must be offered as a component
 * completion by the LSP. server.ts keeps its own `commonComponents` list,
 * which silently fell behind when primitives were added (Icon; Link was
 * added to the engine in c8a47b8).
 *
 * server.ts opens an LSP connection at import time, so its source text is
 * scanned instead of imported (same approach as list-completions.test.ts).
 *
 * Run with: bun src/test/primitives-drift.test.ts
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const server = readFileSync(join(__dirname, "..", "server.ts"), "utf8");
const engine = readFileSync(
  join(__dirname, "..", "..", "..", "hypen-engine-rs", "src", "ir", "component.rs"),
  "utf8",
);

function quoted(body: string): string[] {
  // Strip `//` comments so prose mentioning a name does not count.
  const code = body.replace(/\/\/[^\n]*/g, "");
  return [...code.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
}

function listBody(src: string, re: RegExp, what: string): string {
  const m = src.match(re);
  assert.ok(m, `${what} not found`);
  return m![1];
}

const primitives = quoted(
  listBody(engine, /pub const DEFAULT_PRIMITIVES: &\[&str\] = &\[([\s\S]*?)\];/, "DEFAULT_PRIMITIVES"),
);
const completions = quoted(
  listBody(server, /const commonComponents = \[([\s\S]*?)\];/, "commonComponents"),
);

console.log("\nLSP primitive list vs engine DEFAULT_PRIMITIVES");

test("engine list parsed", () => {
  assert.ok(primitives.length >= 30, `only ${primitives.length} primitives parsed`);
  assert.ok(primitives.includes("Link"));
});

test("every engine primitive is a component completion", () => {
  const missing = primitives.filter((p) => !completions.includes(p));
  assert.deepEqual(missing, [], `missing from commonComponents: ${missing.join(", ")}`);
});

test("Link, Icon and HypenApp are offered", () => {
  for (const name of ["Link", "Icon", "HypenApp"]) {
    assert.ok(completions.includes(name), `${name} missing`);
  }
});

test("Icon and HypenApp have signatures", () => {
  assert.match(server, /\n  Icon: \{\n    label: "Icon\(/);
  assert.match(server, /\n  HypenApp: \{\n    label: "HypenApp\(/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
