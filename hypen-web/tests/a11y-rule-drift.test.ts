import { describe, expect, test } from "bun:test";
import {
  checkRuleDrift,
  EXPECTED_A11Y_RULES,
} from "../packages/core/src/a11y";

describe("EXPECTED_A11Y_RULES", () => {
  test("mirrors the engine's A11yRule kebab-case ids, including the newest rule", () => {
    // Pinned in Rust by conformance.rs's
    // all_rule_ids_serialize_to_the_published_kebab_case_ids test.
    expect(EXPECTED_A11Y_RULES).toEqual([
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
    ]);
  });
});

describe("checkRuleDrift", () => {
  test("binding without a11yRules() reports every expected rule missing", () => {
    const drift = checkRuleDrift({});
    expect(drift.hasRuleList).toBe(false);
    expect(drift.missing).toEqual([...EXPECTED_A11Y_RULES]);
  });

  test("null/undefined engine is treated as absent, not clean", () => {
    expect(checkRuleDrift(null).missing).toEqual([...EXPECTED_A11Y_RULES]);
    expect(checkRuleDrift(undefined).missing).toEqual([
      ...EXPECTED_A11Y_RULES,
    ]);
  });

  test("binding advertising the full rule set is in sync", () => {
    const drift = checkRuleDrift({
      a11yRules: () => [...EXPECTED_A11Y_RULES],
    });
    expect(drift.hasRuleList).toBe(true);
    expect(drift.missing).toEqual([]);
  });

  test("binding missing a newer rule reports exactly that rule", () => {
    const drift = checkRuleDrift({
      a11yRules: () =>
        EXPECTED_A11Y_RULES.filter((r) => r !== "dangling-reference"),
    });
    expect(drift.hasRuleList).toBe(true);
    expect(drift.missing).toEqual(["dangling-reference"]);
  });

  test("extra (future) rules from a newer binding are not drift", () => {
    const drift = checkRuleDrift({
      a11yRules: () => [...EXPECTED_A11Y_RULES, "some-future-rule"],
    });
    expect(drift.missing).toEqual([]);
  });

  test("a throwing a11yRules() is treated as absent, not clean", () => {
    const drift = checkRuleDrift({
      a11yRules: () => {
        throw new Error("boom");
      },
    });
    expect(drift.hasRuleList).toBe(false);
    expect(drift.missing).toEqual([...EXPECTED_A11Y_RULES]);
  });
});
