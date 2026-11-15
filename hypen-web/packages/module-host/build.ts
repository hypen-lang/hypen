/**
 * Build script for @hypen-space/module-host
 *
 * Compiles TypeScript to JavaScript for npm distribution and for plain-node
 * consumers (e.g. the wit-spikes/web-host harness re-exports the built
 * dist/*.js via relative imports).
 *
 * Dependencies (@bytecodealliance/jco, @bytecodealliance/preview2-shim) stay
 * external — they are runtime deps resolved by the consumer's module graph.
 */

import { $ } from "bun";

console.log("Building @hypen-space/module-host...");

await $`rm -rf dist`;

const result = await Bun.build({
  entrypoints: [
    "./src/index.ts",
    "./src/js-module-host.ts",
    "./src/storage.ts",
    "./src/types.ts",
  ],
  root: "./src",
  outdir: "./dist",
  target: "browser",
  format: "esm",
  sourcemap: "external",
  // Shared chunks so the module-level singletons (the storage backends, the
  // per-call ACL context) live in ONE module instance even when consumers
  // import different entrypoints (dist/storage.js + dist/js-module-host.js).
  splitting: true,
  // Keep npm deps as import statements instead of bundling them.
  packages: "external",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Bun.build failed for @hypen-space/module-host");
}

console.log("Generating type declarations...");
await $`bunx tsc -p tsconfig.build.json`;

console.log("✓ @hypen-space/module-host built successfully");
