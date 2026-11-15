/**
 * Bun test preload for @hypen-space/module-host.
 *
 * `src/js-module-host.ts` imports `@bytecodealliance/preview2-shim/*` at
 * module load. Under Bun those specifiers resolve through the package's
 * `node` export condition to `lib/nodejs/*`, which eagerly spawns an I/O
 * worker thread that calls `process.binding("tcp_wrap")` — unimplemented in
 * Bun. The worker dies asynchronously and `bun test` reports it as an
 * "Unhandled error between tests" (non-zero exit, timing-dependent), even
 * though no test here touches WASI I/O.
 *
 * The host's primary target is the browser, so alias the shim subpaths to the
 * package's own browser build (`lib/browser/*`, worker-free) for the test run.
 * Same export shapes, no worker.
 *
 * Wired from both `hypen-web/bunfig.toml` (repo-level `bun test`) and this
 * package's `bunfig.toml` (`bun test` from packages/module-host).
 */
import { mock } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolving (not importing) the entry point does not load the Node shim.
const nodeEntry = fileURLToPath(import.meta.resolve("@bytecodealliance/preview2-shim"));
const browserDir = join(dirname(nodeEntry), "..", "browser");

for (const sub of ["cli", "io", "clocks", "random", "http"]) {
  const browserModule = await import(join(browserDir, `${sub}.js`));
  mock.module(`@bytecodealliance/preview2-shim/${sub}`, () => browserModule);
}
