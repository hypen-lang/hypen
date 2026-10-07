/**
 * Runs every cross-SDK `diff_paths` fixture through the TS port
 * (`diffJsonPaths`). The fixtures' `expected` arrays were generated
 * from the canonical Rust implementation, so this suite is what pins
 * the port to `diff.rs` — a fixture added for any SDK automatically
 * constrains this implementation too.
 *
 * Comparison matches the cross-SDK runner: order-insensitive by path
 * (each SDK may emit in its map's iteration order), values deep-equal.
 * On top of that, the ENTRY SET must be exact — no tolerance.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diffJsonPaths, compareCodePoints } from "@hypen-space/core/diff";

const fixturesDir = join(
  import.meta.dir,
  "../../engine-compatibility-tests/fixtures/portable/diff",
);

interface Fixture {
  name: string;
  function: string;
  input: { old: unknown; new: unknown };
  expected: Array<{ path: string; value: unknown }>;
}

const fixtures: Fixture[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), "utf-8")))
  .sort((a, b) => a.name.localeCompare(b.name));

function sortedByPath<T extends { path: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => compareCodePoints(a.path, b.path));
}

describe("diffJsonPaths — cross-SDK fixtures", () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(22);

  for (const fx of fixtures) {
    test(fx.name, () => {
      expect(fx.function).toBe("diff_paths");
      const got = diffJsonPaths(fx.input.old, fx.input.new);
      expect(sortedByPath(got)).toEqual(sortedByPath(fx.expected));
    });
  }
});
