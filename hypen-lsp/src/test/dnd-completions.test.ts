/**
 * Tests for the drag-and-drop applicator completions in server.ts.
 *
 * server.ts opens an LSP connection at import time, so it is not imported
 * here; instead the source text is scanned for the two tables the completion
 * provider reads (`commonApplicators` and `applicatorSignatures`) and the
 * DnD entries are asserted against the author-facing contract
 * (hypen-web/docs/dnd.md; plan §6.11 clarifications).
 *
 * Run with: npx tsx src/test/dnd-completions.test.ts
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const source = readFileSync(join(__dirname, "..", "server.ts"), "utf8");

/** Slice a top-level `const NAME = [...]` / `{...}` literal out of the source. */
function block(name: string): string {
  const start = source.indexOf(`const ${name}`);
  assert.notEqual(start, -1, `const ${name} not found in server.ts`);
  // The next top-level declaration ends the block.
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(const|function|let|export|connection\.)\s/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

const DND_APPLICATORS = [
  "draggable", "dropZone", "sortable", "pinboard",
  "onDragStart", "onDragOver", "onDrop", "onSort", "onPin", "onDragEnd",
];

console.log("drag-and-drop completion tests:");

test("every DnD applicator is offered as a completion", () => {
  const list = block("commonApplicators");
  for (const name of DND_APPLICATORS) {
    assert.ok(new RegExp(`["']${name}["']`).test(list), `${name} missing from commonApplicators`);
  }
});

test("every DnD applicator has a signature with docs", () => {
  const sigs = block("applicatorSignatures");
  for (const name of DND_APPLICATORS) {
    const entry = new RegExp(`^\\s*${name}:\\s*\\{\\s*label:\\s*"\\.${name}\\(`, "m");
    assert.ok(entry.test(sigs), `${name} missing from applicatorSignatures (or label does not start with .${name}()`);
  }
});

test("role applicators document named-only args and the ForEach-key identity", () => {
  const sigs = block("applicatorSignatures");
  assert.ok(/draggable:.*Named args only/.test(sigs), "draggable docs must say named args only");
  assert.ok(/draggable:.*Identity is the ForEach key/.test(sigs), "draggable docs must name the ForEach key as identity");
});

test("enabled: documents the §6.11 silent mid-drag cancel", () => {
  const sigs = block("applicatorSignatures");
  const draggable = sigs.slice(sigs.indexOf("  draggable:"), sigs.indexOf("  dropZone:"));
  assert.ok(
    /label: "enabled"[^}]*mid-drag cancels silently \(no onDragEnd\)/.test(draggable),
    "draggable enabled param must document the silent mid-drag cancel",
  );
});

test("onDragStart documents from.zone for a loose draggable", () => {
  const sigs = block("applicatorSignatures");
  const entry = sigs.slice(sigs.indexOf("  onDragStart:"), sigs.indexOf("  onDragOver:"));
  assert.ok(/nearest enclosing `\.dropZone` id \(else the parent node id\)/.test(entry));
  assert.ok(/`from\.index` is null/.test(entry));
});

test("band: documents the 0..1 range and 0.5 default", () => {
  const sigs = block("applicatorSignatures");
  const entry = sigs.slice(sigs.indexOf("  dropZone:"), sigs.indexOf("  sortable:"));
  assert.ok(/label: "band"[^}]*0\.\.1 \(default 0\.5\)/.test(entry));
});

test("draggable activation summary names the touch cross-axis rule, not just 'touch press'", () => {
  const sigs = block("applicatorSignatures");
  const draggable = sigs.slice(sigs.indexOf("  draggable:"), sigs.indexOf("  dropZone:"));
  assert.ok(
    /`activation` defaults to `auto` \([^)]*cross-axis slop[^)]*300ms press[^)]*\)/.test(draggable),
    "draggable docs must spell out auto = mouse slop / touch cross-axis slop in a sortable / 300ms press elsewhere",
  );
  assert.ok(!/\(mouse slop \/ touch press\)/.test(draggable), "the old two-way 'mouse slop / touch press' summary must be gone");
  assert.ok(
    /label: "activation"[^}]*cross-axis slop[^}]*300ms press/.test(draggable),
    "the activation parameter doc must carry the same three-way rule",
  );
});

test("handle: is documented as informational (no renderer reads it)", () => {
  const sigs = block("applicatorSignatures");
  const draggable = sigs.slice(sigs.indexOf("  draggable:"), sigs.indexOf("  dropZone:"));
  assert.ok(/label: "handle"[^}]*informational[^}]*no renderer reads it/.test(draggable), "handle param doc must say it is informational");
  assert.ok(!/makes this subtree the only grip/.test(draggable), "handle must no longer claim to restrict the lift surface");
  assert.ok(!/label: "handle"[^}]*this subtree is the only lift surface/.test(draggable));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
