// The CLI validates `wasm.modules.<Name>.httpHosts` with a vendored copy of
// the deferred-HTTP grammar (src/wasm/http-grammar.ts); the source of truth
// is hypen-web/packages/module-host/src/http.ts, itself pinned to the Rust
// grammar by that package's http-parity test. This guard runs the sync
// script's check so drift fails locally. Skipped outside the monorepo.
import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "bun";

const repoRoot = resolve(import.meta.dir, "..", "..");
const script = join(repoRoot, "hypen-web", "scripts", "sync-http-grammar.ts");

describe("vendored deferred-HTTP grammar", () => {
  test.skipIf(!existsSync(script))("matches hypen-web/packages/module-host/src/http.ts (sync-http-grammar.ts --check)", () => {
    const r = spawnSync(["bun", script, "--check"], { stdout: "pipe", stderr: "pipe" });
    const output = `${r.stdout.toString()}${r.stderr.toString()}`;
    if (r.exitCode !== 0) {
      throw new Error(`sync-http-grammar.ts --check failed — run bun hypen-web/scripts/sync-http-grammar.ts:\n${output}`);
    }
    expect(r.exitCode).toBe(0);
  });
});
