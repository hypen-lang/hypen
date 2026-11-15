/**
 * `packages/core/src/http.ts` (and `hypen-cli/src/wasm/http-grammar.ts`) are
 * vendored copies of `packages/module-host/src/http.ts` (see
 * scripts/sync-http-grammar.ts for why). The grammar is pinned to the Rust
 * original by `packages/module-host/tests/http-parity.test.ts`; this test
 * makes that pin hold for the copies the server and the CLI use.
 */

import { expect, test } from "bun:test";
import { driftedHttpGrammarCopies } from "../scripts/sync-http-grammar";
import * as copy from "../packages/core/src/http";
import * as source from "../packages/module-host/src/http";

test("every vendored copy is the module-host grammar, byte for byte", () => {
  // On failure: edit packages/module-host/src/http.ts, then run
  // `bun scripts/sync-http-grammar.ts`.
  expect(driftedHttpGrammarCopies()).toEqual([]);
});

test("the core copy exports the same surface", () => {
  expect(Object.keys(copy).sort()).toEqual(Object.keys(source).sort());
  expect(copy.MAX_HTTP_RESPONSE_BODY_BYTES).toBe(source.MAX_HTTP_RESPONSE_BODY_BYTES);
});
