import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { escapeNonAscii, findNonAscii } from "../build-ascii";

describe("escapeNonAscii", () => {
  test("output is pure ASCII and evaluates to the same strings", () => {
    const src = 'module.exports = ["a → b", `x · ${1}`, /[─-╿]/.test("═"), "\u{1F600}", "\\→"];';
    const out = escapeNonAscii(src);
    expect(/[^\x00-\x7f]/.test(out)).toBe(false);
    const run = (code: string) => {
      const m = { exports: undefined as unknown };
      new Function("module", code)(m);
      return m.exports;
    };
    expect(run(out)).toEqual(run(src));
    expect(run(out)).toEqual(["a → b", "x · 1", true, "\u{1F600}", "→"]);
  });

  test("ASCII input is returned unchanged", () => {
    const src = 'console.log("plain")';
    expect(escapeNonAscii(src)).toBe(src);
  });

  test("refuses String.raw with non-ASCII", () => {
    expect(() => escapeNonAscii("String.raw`→`")).toThrow();
  });

  test("findNonAscii reports the first high byte", () => {
    expect(findNonAscii(new TextEncoder().encode("abc"))).toBe(-1);
    expect(findNonAscii(new TextEncoder().encode("ab→"))).toBe(2);
  });
});

// When a build is present, the shipped bin must be safe to read as Latin-1.
const distBin = resolve(import.meta.dir, "../dist/bin/hypen.js");
test.skipIf(!existsSync(distBin))("dist/bin/hypen.js is ASCII-only", () => {
  expect(findNonAscii(readFileSync(distBin))).toBe(-1);
});
