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
 * Also vendored here (same reason, see MODULE_PACKAGE_SOURCE below):
 * Canonical:  hypen-web/packages/server/src/hosted/module-package.ts
 * Generated:  hypen-cli/src/wasm/module-package.ts
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
/** Every generated copy of the HTTP grammar, as a path relative to the repository root. */
export const HTTP_GRAMMAR_COPIES = ["hypen-web/packages/core/src/http.ts", "hypen-cli/src/wasm/http-grammar.ts"] as const;

/**
 * The module-package manifest / lock model (`hypen-modules.json`,
 * `hypen.lock.json`) is vendored the same way: `@hypen-space/server` owns it
 * and `@hypen-space/cli` carries a copy, because the CLI validates manifests
 * with code that may be newer than the `@hypen-space/server` a project has
 * installed. The copy differs in ONE line: where the HTTP grammar it uses is
 * imported from (the CLI's own vendored copy).
 */
export const MODULE_PACKAGE_SOURCE = join(ROOT, "packages/server/src/hosted/module-package.ts");

interface Vendored {
  /** Path of the canonical file, relative to the repository root. */
  source: string;
  copies: ReadonlyArray<{ path: string; rewrite?: readonly [from: string, to: string] }>;
}

const VENDORED: readonly Vendored[] = [
  {
    source: "hypen-web/packages/module-host/src/http.ts",
    copies: HTTP_GRAMMAR_COPIES.map((path) => ({ path })),
  },
  {
    source: "hypen-web/packages/server/src/hosted/module-package.ts",
    copies: [
      {
        path: "hypen-cli/src/wasm/module-package.ts",
        rewrite: ['from "@hypen-space/core/http";', 'from "./http-grammar.js";'],
      },
    ],
  },
];

const headerFor = (source: string, rewritten: boolean): string =>
  `// GENERATED — do not edit. This file is ${source},\n` +
  `// copied ${rewritten ? "(with its HTTP-grammar import pointed at ./http-grammar.js)" : "byte for byte"} below this header by \`bun hypen-web/scripts/sync-http-grammar.ts\`\n` +
  "// (edit that file, then run the script; `--check` and the http-grammar-sync\n" +
  "// tests fail on drift).\n\n";

const pathOf = (copy: string): string => resolve(ROOT, "..", copy);

function expectedCopy(vendored: Vendored, copy: Vendored["copies"][number]): string {
  let body = readFileSync(pathOf(vendored.source), "utf8");
  if (copy.rewrite) {
    const [from, to] = copy.rewrite;
    if (body.split(from).length !== 2) {
      throw new Error(`sync-http-grammar: expected exactly one \`${from}\` in ${vendored.source}`);
    }
    body = body.replace(from, to);
  }
  return headerFor(vendored.source, copy.rewrite !== undefined) + body;
}

/** What every copy of the HTTP grammar must contain for the current source. */
export function expectedHttpGrammarCopy(): string {
  return expectedCopy(VENDORED[0]!, VENDORED[0]!.copies[0]!);
}

/** Every vendored copy (HTTP grammar and module-package model) that is missing or differs from its source. */
export function driftedCopies(): Array<{ path: string; expected: string; source: string }> {
  const drifted: Array<{ path: string; expected: string; source: string }> = [];
  for (const vendored of VENDORED) {
    for (const copy of vendored.copies) {
      const expected = expectedCopy(vendored, copy);
      let actual: string | null = null;
      try {
        actual = readFileSync(pathOf(copy.path), "utf8");
      } catch {
        // missing
      }
      if (actual !== expected) drifted.push({ path: copy.path, expected, source: vendored.source });
    }
  }
  return drifted;
}

/** The copies that are missing or differ from their source (paths). */
export function driftedHttpGrammarCopies(): string[] {
  return driftedCopies().map((d) => d.path);
}

if (import.meta.main) {
  const drifted = driftedCopies();
  const all = VENDORED.flatMap((v) => v.copies.map((c) => c.path));
  if (process.argv.includes("--check")) {
    if (drifted.length > 0) {
      console.error(
        `sync-http-grammar: out of sync with their sources:\n` +
          drifted.map((d) => `  ${d.path}  (source: ${d.source})\n`).join("") +
          "Edit only the source file, then run: bun hypen-web/scripts/sync-http-grammar.ts",
      );
      process.exit(1);
    }
    console.log(`sync-http-grammar: in sync (${all.join(", ")}).`);
  } else if (drifted.length === 0) {
    console.log("sync-http-grammar: already in sync.");
  } else {
    for (const d of drifted) {
      writeFileSync(pathOf(d.path), d.expected);
      console.log(`sync-http-grammar: regenerated ${d.path}`);
    }
  }
}
