/**
 * Build script for @hypen-space/web-engine
 *
 * Compiles TypeScript to JavaScript + declarations for npm distribution.
 */

import { $ } from "bun";

console.log("Building @hypen-space/web-engine...");

// Clean dist directory
await $`rm -rf dist`;

// Copy WASM files for browser target (served via CDN from this package).
// pkg/browser is built with `--features js` only: browsers never broker
// device requests, so the device broker (RFC 001) stays out of this bundle.
// (pkg/web carries it for Cloudflare hosts.)
console.log("Copying WASM files...");
await $`rm -rf wasm-browser`;
await $`mkdir -p wasm-browser`;
await $`cp -r ../../../hypen-engine-rs/pkg/browser/* wasm-browser/`;
console.log("✓ WASM files copied");

// Build with browser target
const result = await Bun.build({
  entrypoints: [
    "./src/index.ts",
    "./src/engine.ts",
    "./src/hypen.ts",
  ],
  root: "./src",
  outdir: "./dist",
  target: "browser",
  format: "esm",
  sourcemap: "external",
  external: [
    "@hypen-space/core",
    "@hypen-space/core/*",
    "@hypen-space/web",
    "@hypen-space/web/*",
  ],
});

if (!result.success) {
  console.error("Build failed:", result.logs);
  process.exit(1);
}

// Generate type declarations
console.log("Generating type declarations...");
await $`bunx tsc -p tsconfig.build.json`;

console.log("✓ @hypen-space/web-engine built successfully");
