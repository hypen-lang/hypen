/**
 * Pure pieces of the opt-in dev-loop accessibility pass (`hypen dev --a11y`):
 * the flag/config gating decision and the silent-when-clean report
 * formatting. No live server, no engine.
 */

import { describe, expect, test } from "bun:test";
import { isDevA11yEnabled, formatDevA11yLines } from "../src/dev.js";
import { formatA11yReport, type FileA11yFinding } from "../src/check.js";
import type { A11yDiagnostic } from "@hypen-space/core";

function finding(overrides: Partial<A11yDiagnostic> = {}): FileA11yFinding {
  return {
    file: "src/components/App.hypen",
    diagnostic: {
      rule: "missing-accessible-name",
      elementType: "Button",
      message: "interactive Button has no accessible name",
      line: 3,
      col: 5,
      ...overrides,
    },
  };
}

describe("isDevA11yEnabled", () => {
  test("fully silent by default (no flag, no config)", () => {
    expect(isDevA11yEnabled(undefined, undefined)).toBe(false);
  });

  test("--a11y flag alone enables", () => {
    expect(isDevA11yEnabled(true, undefined)).toBe(true);
  });

  test('hypen.json "a11y": { "dev": true } alone enables', () => {
    expect(isDevA11yEnabled(undefined, { dev: true })).toBe(true);
  });

  test("flag OR config: config wins even when the flag is absent/false", () => {
    expect(isDevA11yEnabled(false, { dev: true })).toBe(true);
  });

  test("config dev: false does not enable", () => {
    expect(isDevA11yEnabled(undefined, { dev: false })).toBe(false);
    expect(isDevA11yEnabled(false, { dev: false })).toBe(false);
  });

  test("an a11y config block without dev (e.g. ignoreRules only) stays off", () => {
    expect(isDevA11yEnabled(undefined, {})).toBe(false);
  });
});

describe("formatDevA11yLines", () => {
  test("clean pass prints nothing — no '0 findings' spam", () => {
    expect(formatDevA11yLines([], 0)).toEqual([]);
  });

  test("suppressed-only pass is also silent in the dev loop", () => {
    expect(formatDevA11yLines([], 3)).toEqual([]);
  });

  test("findings render in exactly the `hypen check` format", () => {
    const lines = formatDevA11yLines([finding()], 0);
    expect(lines[0]).toBe(
      "src/components/App.hypen:3:5: a11y[missing-accessible-name] Button — interactive Button has no accessible name",
    );
  });

  test("reuses formatA11yReport verbatim when findings exist", () => {
    const findings = [
      finding(),
      finding({ rule: "image-missing-alt", elementType: "Image", line: 9, col: 1 }),
    ];
    expect(formatDevA11yLines(findings, 2)).toEqual(
      formatA11yReport(findings, 2).lines,
    );
  });

  test("omits :line:col when the diagnostic has no resolved location", () => {
    const lines = formatDevA11yLines(
      [finding({ line: undefined, col: undefined })],
      0,
    );
    expect(lines[0]).toBe(
      "src/components/App.hypen: a11y[missing-accessible-name] Button — interactive Button has no accessible name",
    );
  });

  test("includes summary and suppressed-count lines alongside findings", () => {
    const lines = formatDevA11yLines([finding()], 1);
    expect(lines).toContain("Found 1 accessibility issue across 1 file.");
    expect(lines).toContain("1 finding suppressed.");
  });
});
