// The CLI vendors the `hypen:module` WIT (wit/, wit-v0_2/, wit-tinygo/) for
// the published package; the source of truth is the repo-root wit/ and
// wit-v0_2/. This guard runs `scripts/sync-wit.sh --check` so drift fails
// locally too, not just in CI. Skipped outside the monorepo (no repo root).
import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "bun";

const repoRoot = resolve(import.meta.dir, "..", "..");
const script = join(repoRoot, "scripts", "sync-wit.sh");
const inMonorepo =
  existsSync(script) &&
  existsSync(join(repoRoot, "wit", "hypen-module.wit")) &&
  existsSync(join(repoRoot, "wit-v0_2", "hypen-module.wit"));

describe("vendored hypen:module WIT", () => {
  test.skipIf(!inMonorepo)("matches the canonical /wit and /wit-v0_2 (scripts/sync-wit.sh --check)", () => {
    const r = spawnSync(["bash", script, "--check"], { stdout: "pipe", stderr: "pipe" });
    const output = `${r.stdout.toString()}${r.stderr.toString()}`;
    if (r.exitCode !== 0) {
      throw new Error(`scripts/sync-wit.sh --check failed — run scripts/sync-wit.sh:\n${output}`);
    }
    expect(r.exitCode).toBe(0);
  });
});
