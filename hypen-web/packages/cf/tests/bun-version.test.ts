/**
 * The generic client build refuses Bun < 1.4.4: Bun 1.4.3's bundler emits a
 * client that throws "'k' is undefined" when evaluated (client-bundle.test.ts).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_BUN_VERSION, assertBunVersion, bunVersionProblem } from "../client/build-client.js";

describe("bun version guard", () => {
  test("accepts the minimum and anything newer", () => {
    for (const v of ["1.4.4", "1.4.10", "1.5.0", "2.0.0", "1.4.4-canary.20261101", "v1.4.4"]) {
      expect(bunVersionProblem(v)).toBeNull();
    }
  });

  test("rejects older versions with an actionable message", () => {
    for (const v of ["1.4.3", "1.3.99", "1.0.0", "0.9.9"]) {
      const problem = bunVersionProblem(v);
      expect(problem).toContain(`needs Bun >= ${MIN_BUN_VERSION}`);
      expect(problem).toContain(`this is Bun ${v}`);
      expect(problem).toContain("bun upgrade");
    }
    expect(() => assertBunVersion("1.4.3")).toThrow("needs Bun >= 1.4.4");
    expect(() => assertBunVersion("1.4.4")).not.toThrow();
  });

  test("rejects a version it cannot parse", () => {
    expect(bunVersionProblem("unknown")).not.toBeNull();
  });

  test("this Bun can build the client", () => {
    expect(bunVersionProblem(Bun.version)).toBeNull();
  });

  test("hypen-web declares the same minimum in engines.bun", () => {
    const root = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8"));
    expect(root.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
  });
});
