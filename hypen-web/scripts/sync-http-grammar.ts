#!/usr/bin/env bun
/**
 * Regenerate (or verify) the vendored copies of the deferred-HTTP grammar
 * from its single source of truth, `packages/module-host/src/http.ts` — the
 * TypeScript port of `hypen-engine-rs/src/module_host/http.rs`.
 *
 *   bun scripts/sync-http-grammar.ts           regenerate the copies
 *   bun scripts/sync-http-grammar.ts --check   exit 1 if a copy has drifted
 *
 * Canonical (edit this):  hypen-web/packages/module-host/src/http.ts
 * Generated (never edit): hypen-web/packages/core/src/http.ts
 *                         hypen-cli/src/wasm/http-grammar.ts
 *
 * Why copies: `@hypen-space/module-host` has no `@hypen-space/*` dependency
 * (it is published and usable on its own, in a browser), `@hypen-space/server`
 * needs the same URL / host-pattern grammar and depends on `@hypen-space/core`
 * (not on the optional module host), and `@hypen-space/cli` validates
 * `hypen.json` with it but runs against whatever `@hypen-space/core` the
 * project has installed — which may predate the `./http` export. One
 * implementation, vendored byte for byte: the same arrangement as the WIT
 * under `hypen-cli/wit*` (`scripts/sync-wit.sh`).
 *
 * `hypen-web/tests/http-grammar-sync.test.ts` and
 * `hypen-cli/tests/http-grammar-sync.test.ts` run the check on every
 * `bun test`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HTTP_GRAMMAR_SOURCE = join(ROOT, "packages/module-host/src/http.ts");
/** Every generated copy, as a path relative to the repository root. */
export const HTTP_GRAMMAR_COPIES = ["hypen-web/packages/core/src/http.ts", "hypen-cli/src/wasm/http-grammar.ts"] as const;

const HEADER =
  "// GENERATED — do not edit. This file is hypen-web/packages/module-host/src/http.ts,\n" +
  "// copied byte for byte below this header by `bun hypen-web/scripts/sync-http-grammar.ts`\n" +
  "// (edit that file, then run the script; `--check` and the http-grammar-sync\n" +
  "// tests fail on drift).\n\n";

const pathOf = (copy: string): string => resolve(ROOT, "..", copy);

/** What every copy must contain for the current source. */
export function expectedHttpGrammarCopy(): string {
  return HEADER + readFileSync(HTTP_GRAMMAR_SOURCE, "utf8");
}

/** The copies that are missing or differ from the source. */
export function driftedHttpGrammarCopies(): string[] {
  const expected = expectedHttpGrammarCopy();
  return HTTP_GRAMMAR_COPIES.filter((copy) => {
    try {
      return readFileSync(pathOf(copy), "utf8") !== expected;
    } catch {
      return true;
    }
  });
}

if (import.meta.main) {
  const drifted = driftedHttpGrammarCopies();
  if (process.argv.includes("--check")) {
    if (drifted.length > 0) {
      console.error(
        `sync-http-grammar: out of sync with hypen-web/packages/module-host/src/http.ts:\n` +
          drifted.map((copy) => `  ${copy}\n`).join("") +
          "Edit only the module-host file, then run: bun hypen-web/scripts/sync-http-grammar.ts",
      );
      process.exit(1);
    }
    console.log(`sync-http-grammar: in sync (${HTTP_GRAMMAR_COPIES.join(", ")}).`);
  } else if (drifted.length === 0) {
    console.log("sync-http-grammar: already in sync.");
  } else {
    for (const copy of drifted) {
      writeFileSync(pathOf(copy), expectedHttpGrammarCopy());
      console.log(`sync-http-grammar: regenerated ${copy}`);
    }
  }
}
