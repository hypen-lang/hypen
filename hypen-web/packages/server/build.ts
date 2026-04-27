/**
 * Build script for @hypen-space/server
 *
 * Compiles TypeScript to JavaScript for npm distribution.
 */

import { $ } from "bun";

console.log("Building @hypen-space/server...");

// Clean dist directory
await $`rm -rf dist`;

// Copy WASM files for Node.js target
console.log("Copying WASM files...");
await $`rm -rf wasm-node`;
await $`mkdir -p wasm-node`;

// Copy Node.js WASM (uses readFileSync for loading - CJS format)
await $`cp -r ../../../hypen-engine-rs/pkg/nodejs/* wasm-node/`;

// wasm-pack nodejs target doesn't set "type" in package.json, but since parent package
// is "type": "module", we explicitly mark this as CJS to avoid module format confusion
const wasmNodePkg = await Bun.file("wasm-node/package.json").json();
wasmNodePkg.type = "commonjs";
wasmNodePkg.sideEffects = false;
await Bun.write("wasm-node/package.json", JSON.stringify(wasmNodePkg, null, 2) + "\n");

console.log("✓ WASM files copied");

// Build Node.js entrypoints
await Bun.build({
  entrypoints: [
    "./src/index.ts",
    "./src/engine.ts",
    "./src/loader.ts",
    "./src/discovery.ts",
    "./src/plugin.ts",
    "./src/remote/server.ts",
  ],
  root: "./src",
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: [
    "../wasm-node/*",
    "@hypen-space/core",
    "@hypen-space/core/*",
  ],
});

// Generate type declarations using tsc
console.log("Generating type declarations...");
await $`bunx tsc -p tsconfig.build.json`;

console.log("✓ @hypen-space/server built successfully");
