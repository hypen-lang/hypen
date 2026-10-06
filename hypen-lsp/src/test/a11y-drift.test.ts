/**
 * Tests for the rule-set drift detection in a11y.ts.
 *
 * A stale symlinked WASM still exposes `checkAccessibility`, so it looks
 * current while newer rules silently never fire; `missingA11yRules` is what
 * the init path warns from. No WASM build required — fake engines only.
 *
 * Run with: npx tsx src/test/a11y-drift.test.ts
 */

import { strict as assert } from "node:assert";
import { missingA11yRules, EXPECTED_A11Y_RULES } from "../a11y";

// ---- Test runner (mirrors parser.test.ts) ----

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

console.log("missingA11yRules tests:");

test("expected rules mirror the engine's kebab-case ids, including the newest rule", () => {
  // Pinned in Rust by conformance.rs's kebab-case id test.
  assert.deepEqual(
    [...EXPECTED_A11Y_RULES],
    [
      "missing-accessible-name",
      "image-missing-alt",
      "heading-missing-level",
      "nested-interactive",
      "form-control-missing-label",
      "unknown-role-token",
      "unknown-dir-token",
      "dangling-reference",
      "duplicate-id",
      "tablist-wiring-skipped",
      "non-portable-aria",
      "unknown-live-token",
      "unknown-ignore-rule",
      "video-missing-label",
    ],
  );
});

test("binding without a11yRules() reports every expected rule missing", () => {
  assert.deepEqual(missingA11yRules({}), [...EXPECTED_A11Y_RULES]);
});

test("null/undefined engine is treated as absent, not clean", () => {
  assert.deepEqual(missingA11yRules(null), [...EXPECTED_A11Y_RULES]);
  assert.deepEqual(missingA11yRules(undefined), [...EXPECTED_A11Y_RULES]);
});

test("binding advertising the full rule set has no drift", () => {
  assert.deepEqual(
    missingA11yRules({ a11yRules: () => [...EXPECTED_A11Y_RULES] }),
    [],
  );
});

test("binding missing a newer rule reports exactly that rule", () => {
  const advertised = EXPECTED_A11Y_RULES.filter(
    (r) => r !== "dangling-reference",
  );
  assert.deepEqual(missingA11yRules({ a11yRules: () => advertised }), [
    "dangling-reference",
  ]);
});

test("extra (future) rules from a newer binding are not drift", () => {
  assert.deepEqual(
    missingA11yRules({
      a11yRules: () => [...EXPECTED_A11Y_RULES, "some-future-rule"],
    }),
    [],
  );
});

test("a throwing a11yRules() is treated as absent, not clean", () => {
  assert.deepEqual(
    missingA11yRules({
      a11yRules: () => {
        throw new Error("boom");
      },
    }),
    [...EXPECTED_A11Y_RULES],
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
