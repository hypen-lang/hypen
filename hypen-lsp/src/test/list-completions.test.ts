/**
 * Tests for list argument completions and hovers in server.ts.
 *
 * Like dnd-completions.test.ts, server.ts opens an LSP connection at import
 * time, so the source text is scanned for the tables the providers read and
 * asserted against the author-facing contract
 * (hypen-web/docs/virtualization.md).
 *
 * Run with: npx tsx src/test/list-completions.test.ts
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

const source = readFileSync(join(__dirname, "..", "server.ts"), "utf8");

function block(name: string): string {
  const start = source.indexOf(`const ${name}`);
  assert.notEqual(start, -1, `const ${name} not found in server.ts`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(const|function|let|export|connection\.)\s/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function argsOf(component: string): string[] {
  const table = block("componentArguments");
  const match = table.match(new RegExp(`^\\s*${component}:\\s*\\[([^\\]]*)\\]`, "m"));
  assert.ok(match, `${component} missing from componentArguments`);
  return [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const LAZY_ARGS = ["lazy", "initialCount", "estimatedItemSize"];

console.log("list completion tests:");

test("List, Grid and ForEach offer the virtualization arguments", () => {
  for (const component of ["List", "Grid", "ForEach"]) {
    const args = argsOf(component);
    for (const arg of ["items", "key", "as", ...LAZY_ARGS]) {
      assert.ok(args.includes(arg), `${component} is missing ${arg}`);
    }
  }
});

test("Grid offers columns", () => {
  assert.ok(argsOf("Grid").includes("columns"));
});

test("List and ForEach are offered as components", () => {
  const list = block("commonComponents");
  for (const name of ["List", "ForEach", "Grid"]) {
    assert.ok(new RegExp(`"${name}"`).test(list), `${name} missing from commonComponents`);
  }
});

test("hovers document the defaults and the opt-out", () => {
  assert.ok(/word === "List"[\s\S]*virtualized out of the box[\s\S]*lazy: false/.test(source));
  assert.ok(/word === "ForEach"[\s\S]*lazy: true/.test(source));
  assert.ok(!/word === "forEach"/.test(source), "the stale lowercase forEach hover is gone");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
