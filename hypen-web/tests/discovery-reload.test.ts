/**
 * Regression: `loadDiscoveredComponents` must re-import a component's `.ts`
 * module when the file changes on disk. A plain `import(path)` pins the ESM
 * module cache, so the dev server's hot reload silently kept serving stale
 * action handlers / initial state until restart.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  discoverComponents,
  loadDiscoveredComponents,
} from "../packages/server/src/discovery";

const testDir = `/tmp/hypen-discovery-reload-${process.pid}`;

function writeCounter(initialCount: number): void {
  const dir = join(testDir, "Counter");
  mkdirSync(dir, { recursive: true });
  // A plain module-definition literal: the fixture lives in /tmp where
  // package imports don't resolve, and the loader only reads `default`.
  writeFileSync(
    join(dir, "component.ts"),
    `export default {
  initialState: { count: ${initialCount} },
  actions: [],
  stateKeys: ["count"],
  handlers: {},
};
`
  );
  writeFileSync(join(dir, "component.hypen"), `Text("@{state.count}")`);
}

describe("discovery reload picks up .ts edits", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("re-importing after an edit returns the new module", async () => {
    writeCounter(1);
    let loaded = await loadDiscoveredComponents(await discoverComponents(testDir));
    expect((loaded.get("Counter")?.module.initialState as any).count).toBe(1);

    // Ensure a distinct mtime, then edit the module.
    await new Promise((r) => setTimeout(r, 10));
    writeCounter(42);

    loaded = await loadDiscoveredComponents(await discoverComponents(testDir));
    expect((loaded.get("Counter")?.module.initialState as any).count).toBe(42);
  });
});
