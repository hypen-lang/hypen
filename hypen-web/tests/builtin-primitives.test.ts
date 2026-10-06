/**
 * The web engine's built-in element list must track the engine's
 * DEFAULT_PRIMITIVES.
 *
 * `Hypen.setComponentResolver` refuses to resolve any name in that list, so a
 * name present there but absent from every renderer registry is a dead end:
 * unresolvable as a user component *and* unrenderable as a primitive. That is
 * what `ScrollView` was. In the other direction the two lists had already
 * drifted by `SafeArea` and `Scrubber`, which only went unnoticed because the
 * engine pre-registers its own primitives.
 *
 * The list is read out of the source rather than exported, so this stays a
 * pure guard with no production surface.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

const namesIn = (source: string): Set<string> =>
  new Set((source.match(/"[A-Za-z]+"/g) ?? []).map((s) => s.slice(1, -1)));

/** The `builtInElements` set literal in hypen.ts. */
const webBuiltIns = (): Set<string> => {
  const src = readFileSync(
    join(REPO, "hypen-web/packages/web-engine/src/hypen.ts"),
    "utf8"
  );
  const start = src.indexOf("const builtInElements = new Set([");
  expect(start).toBeGreaterThan(-1);
  return namesIn(src.slice(start, src.indexOf("]);", start)));
};

/** The `DEFAULT_PRIMITIVES` array in the engine. */
const enginePrimitives = (): Set<string> => {
  const src = readFileSync(join(REPO, "hypen-engine-rs/src/ir/component.rs"), "utf8");
  const start = src.indexOf("DEFAULT_PRIMITIVES");
  expect(start).toBeGreaterThan(-1);
  return namesIn(src.slice(start, src.indexOf("];", start)));
};

/** Names the web renderer owns that the engine does not know about. */
const WEB_ONLY = new Set(["Canvas"]);

describe("built-in primitive lists agree", () => {
  test("every engine primitive is in the web built-in list", () => {
    const missing = [...enginePrimitives()].filter((n) => !webBuiltIns().has(n));
    expect(missing).toEqual([]);
  });

  test("the web list adds nothing beyond the documented web-only hosts", () => {
    const engine = enginePrimitives();
    const extra = [...webBuiltIns()].filter(
      (n) => !engine.has(n) && !WEB_ONLY.has(n)
    );
    expect(extra).toEqual([]);
  });

  test("SafeArea and Scrubber are present (the drift this guards)", () => {
    const web = webBuiltIns();
    expect(web.has("SafeArea")).toBe(true);
    expect(web.has("Scrubber")).toBe(true);
  });

  test("ScrollView is gone from both lists", () => {
    expect(webBuiltIns().has("ScrollView")).toBe(false);
    expect(enginePrimitives().has("ScrollView")).toBe(false);
  });
});
