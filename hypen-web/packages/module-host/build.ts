/**
 * Build script for @hypen-space/module-host
 *
 * Compiles TypeScript to JavaScript (ESM + .d.ts) for npm distribution and
 * for plain-Node consumers. Only src/ is built: tests and fixtures never
 * reach dist/.
 *
 * Dependencies (@bytecodealliance/jco-transpile, @bytecodealliance/
 * preview2-shim) stay external — they are runtime deps resolved by the
 * consumer's module graph (and loaded lazily, on the first prepare()).
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
  // Shared chunks so classes (HostStorage, backends) keep one identity when
  // consumers import several entrypoints (dist/storage.js + dist/index.js).
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
